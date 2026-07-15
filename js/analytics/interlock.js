/* MEDI 인터록 감시 — "트립까지 얼마나 남았나"를 정량화
 *
 * 인터록 = 실제 정지(트립) 경계. 사용자가 정의한 인터록 조건(태그·연산자·설정치)에 대해
 *  · 여유(margin%): 정상 운전점 기준으로 설정치까지 남은 비율 (100% = 정상점, 0% = 트립)
 *  · 도달 예상(tta): 최근 추세(선형)로 설정치 도달까지 남은 시간 — 접근 중일 때만
 *  · 상태: ok → approach(여유<35% 또는 72h 내 도달) → near(여유<15% 또는 24h 내) → violated
 * 목적: 비계획 정지를 "몇 시간 전"이 아니라 "여유 몇 %·도달 며칠 전"으로 미리 보이게.
 * 브라우저(window.MEDI.interlock)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.interlock = factory(root.MEDI.stats);
  }
})(typeof self !== 'undefined' ? self : this, function (stats) {
  'use strict';

  // 단일 조건 평가. series: {t,v}, cond: {tagId, op('>='|'<='), limit}
  function assessCondition(cond, series, opts) {
    const o = Object.assign({ recentHours: 24, baseFrac: 0.4 }, opts);
    if (!series || !series.t || series.t.length < 20) {
      return { tagId: cond.tagId, ok: false, reason: '데이터 없음/부족' };
    }
    // NaN/Inf(품질코드 불량·계산태그 0나눗셈) 표본 제거 — 트립 여유 감시가 불량 표본 1개로
    // marginPct=NaN → status 'ok' 강등되는 안전 오표시를 막는다 (last/추세/TTA 전부 오염됨)
    let ft = series.t, fv = series.v;
    for (let i = 0; i < series.t.length; i++) {
      if (!Number.isFinite(series.t[i]) || !Number.isFinite(series.v[i])) {
        ft = []; fv = [];
        for (let j = 0; j < series.t.length; j++) {
          if (Number.isFinite(series.t[j]) && Number.isFinite(series.v[j])) { ft.push(series.t[j]); fv.push(series.v[j]); }
        }
        break;
      }
    }
    if (ft.length < 20) {
      return { tagId: cond.tagId, ok: false, reason: '유효 데이터 부족 (품질 불량 과다)' };
    }
    const n = ft.length;
    const baseEnd = Math.max(10, Math.floor(n * o.baseFrac));
    const base = fv.slice(0, baseEnd);
    const recentStartMs = ft[n - 1] - o.recentHours * 3600000;
    let rs = n - 1;
    while (rs > 0 && ft[rs - 1] >= recentStartMs) rs--;
    const recT = ft.slice(rs), recV = fv.slice(rs);
    const last = recV[recV.length - 1];
    const baseMed = stats.median(base);
    const hi = cond.op !== '<='; // 기본 '>=' (상한 트립)
    const limit = cond.limit;

    // 여유%: 정상 운전점(베이스라인 중앙값) → 설정치 구간에서 현재 위치
    const span = hi ? (limit - baseMed) : (baseMed - limit);
    const remain = hi ? (limit - last) : (last - limit);
    const marginPct = span > 1e-9 ? Math.max(0, Math.min(150, (remain / span) * 100)) : (remain > 0 ? 100 : 0);
    const violated = remain <= 0;

    // 추세 기반 도달 예상 (접근 방향일 때만, R² 최소 요건)
    // 불확실성: 기울기 표준오차(OLS) 90% 구간 → 도달시간 범위 [ttaLoHours(빠른 접근), ttaHiHours(느린 접근)]
    const tr = stats.trendPerHour(recT, recV);
    let ttaHours = null, ttaLoHours = null, ttaHiHours = null;
    const approaching = hi ? tr.slopePerHour > 1e-9 : tr.slopePerHour < -1e-9;
    if (!violated && approaching && tr.r2 > 0.35) {
      ttaHours = Math.abs(remain / tr.slopePerHour);
      if (!isFinite(ttaHours) || ttaHours > 24 * 60) ttaHours = null; // 60일 초과는 무의미
      if (ttaHours !== null && tr.sePerHour !== null) {
        const z = 1.645; // 90%
        const sAbs = Math.abs(tr.slopePerHour);
        const sFast = sAbs + z * tr.sePerHour;
        const sSlow = sAbs - z * tr.sePerHour;
        ttaLoHours = sFast > 1e-12 ? Math.abs(remain) / sFast : null;
        ttaHiHours = sSlow > 1e-12 ? Math.abs(remain) / sSlow : null; // 기울기 하한 ≤ 0 → 상한 없음
        if (ttaHiHours !== null && ttaHiHours > 24 * 60) ttaHiHours = null;
      }
    }

    // 추세(tta) 기반 격상은 여유가 실제로 소모된 경우에만 — 정상 일교차/부하 추세 오탐 차단
    let status = 'ok';
    if (violated) status = 'violated';
    else if (marginPct < 15 || (ttaHours !== null && ttaHours < 24 && marginPct < 50)) status = 'near';
    else if (marginPct < 35 || (ttaHours !== null && ttaHours < 72 && marginPct < 60)) status = 'approach';

    return {
      tagId: cond.tagId, op: hi ? '>=' : '<=', limit, last, baseMed,
      marginPct, ttaHours, ttaLoHours, ttaHiHours, slopePerHour: tr.slopePerHour, trendR2: tr.r2,
      status, ok: true,
    };
  }

  const RANK = { ok: 0, approach: 1, near: 2, violated: 3 };

  // 인터록 전체 평가: logic 'any'(기본 — 한 조건이라도 걸리면 트립) / 'all'
  function assessInterlock(il, seriesMap, opts) {
    const conds = (il.conditions || []).map(c => assessCondition(c, seriesMap[c.tagId], opts));
    const valid = conds.filter(c => c.ok);
    let status = 'unknown';
    if (valid.length) {
      if ((il.logic || 'any') === 'any') {
        status = valid.reduce((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), 'ok');
      } else {
        status = valid.reduce((best, c) => (RANK[c.status] < RANK[best] ? c.status : best), 'violated');
      }
    }
    const worst = valid.slice().sort((a, b) => RANK[b.status] - RANK[a.status] || a.marginPct - b.marginPct)[0] || null;
    return { id: il.id, name: il.name, assetId: il.assetId, action: il.action || '', logic: il.logic || 'any', conditions: conds, status, worst };
  }

  function assessAll(interlocks, seriesMap, opts) {
    return (interlocks || []).map(il => assessInterlock(il, seriesMap, opts));
  }

  return { assessCondition, assessInterlock, assessAll, RANK };
});
