/* MEDI 데이터 품질 검증 — "불러온 값이 제대로인가"를 자동 점검
 * 히스토리안 연동에서 흔한 문제를 태그별로 리포트:
 *  · 데이터 없음/부족 · 정체(stale: 마지막 값이 너무 오래됨) · 수집 공백(gap)
 *  · 비유한값(NaN/Inf) · 완전 고정(flatline) · 타임스탬프 역순/중복
 *  · 범위 의심(설정된 lo~hi를 크게 벗어남 — 단위/스케일링 오류 신호: 0-1 vs 0-100% 등)
 * 브라우저(window.MEDI.quality)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.quality = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // severity: 'error'(분석 불가/신뢰 불가) | 'warn'(주의 해석) | 'info'
  function checkSeries(s, opts) {
    const o = Object.assign({ nowMs: null, staleHours: 2, lo: null, hi: null, kind: 'analog' }, opts);
    const issues = [];
    if (!s || !s.t || s.t.length === 0) return [{ code: 'no_data', sev: 'error', msg: '데이터 없음 — 태그명/기간/커넥터 확인' }];
    const n = s.t.length;
    if (n < 30) issues.push({ code: 'too_few', sev: 'error', msg: `표본 ${n}점뿐 — 통계 진단에 부족 (기간 확대 또는 수집주기 확인)` });

    // 타임스탬프 순서/중복/공백
    let outOfOrder = 0, dup = 0;
    const dts = [];
    for (let i = 1; i < n; i++) {
      const d = s.t[i] - s.t[i - 1];
      if (d < 0) outOfOrder++;
      else if (d === 0) dup++;
      else dts.push(d);
    }
    if (outOfOrder) issues.push({ code: 'out_of_order', sev: 'error', msg: `타임스탬프 역순 ${outOfOrder}건 — 타임존 혼선(로컬/UTC) 또는 병합 오류 의심` });
    if (dup > n * 0.01) issues.push({ code: 'dup_ts', sev: 'warn', msg: `중복 타임스탬프 ${dup}건` });
    if (dts.length > 4) {
      const sorted = dts.slice().sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const gaps = dts.filter(d => d > med * 5);
      if (gaps.length) {
        const worst = Math.max(...gaps);
        issues.push({ code: 'gaps', sev: 'warn', msg: `수집 공백 ${gaps.length}회 (최대 ${(worst / 3600000).toFixed(1)}시간) — 수집기/네트워크 중단 이력` });
      }
    }

    // 정체(stale)
    const now = o.nowMs || Date.now();
    const ageH = (now - s.t[n - 1]) / 3600000;
    if (ageH > o.staleHours) {
      issues.push({ code: 'stale', sev: ageH > 24 ? 'error' : 'warn', msg: `마지막 값이 ${ageH < 48 ? ageH.toFixed(1) + '시간' : (ageH / 24).toFixed(1) + '일'} 전 — 수집 중단 또는 기간 설정 확인` });
    }

    // 값 품질
    let bad = 0, mn = Infinity, mx = -Infinity;
    let allSame = true;
    const first = s.v.find(x => isFinite(x));
    for (const x of s.v) {
      if (!isFinite(x)) { bad++; continue; }
      if (x !== first) allSame = false;
      if (x < mn) mn = x;
      if (x > mx) mx = x;
    }
    if (bad) issues.push({ code: 'nonfinite', sev: bad > n * 0.05 ? 'error' : 'warn', msg: `NaN/무한값 ${bad}건 (${(bad / n * 100).toFixed(1)}%) — 품질코드 불량 구간 가능성` });
    if (allSame && n >= 30 && o.kind !== 'digital') issues.push({ code: 'flatline', sev: 'error', msg: `전 구간 동일값(${first}) — 계기 고착 또는 수집기가 스냅샷만 반복` });

    // 범위/스케일 의심 (아날로그 + lo/hi 설정 시)
    if (o.kind !== 'digital' && o.lo !== null && o.hi !== null && isFinite(mn) && isFinite(mx) && o.hi > o.lo) {
      const span = o.hi - o.lo;
      let outside = 0;
      for (const x of s.v) if (isFinite(x) && (x < o.lo - 0.2 * span || x > o.hi + 0.2 * span)) outside++;
      const hintFor = (ratio) => ratio > 50 && ratio < 200 ? '×100 스케일(0-1 vs 0-100%) 의심'
        : ratio > 5 && ratio < 20 ? '×10 또는 단위 환산(bar vs kg/cm² 등) 의심' : '단위/스케일 불일치 의심';
      if (outside > n * 0.5) {
        issues.push({ code: 'range_suspect', sev: 'warn', msg: `값의 ${(outside / n * 100).toFixed(0)}%가 설정범위(${o.lo}~${o.hi}) 밖 (실측 ${mn.toFixed(1)}~${mx.toFixed(1)}) — ${hintFor(Math.abs(mx) > 1e-12 ? mx / o.hi : 0)}. 계산 태그로 보정 가능` });
      } else if (!allSame && (mx - mn) < span * 0.02 && Math.abs(mx) < span * 0.05) {
        // 값이 살아 있는데 설정범위에 비해 너무 작음 — 0-1 값을 0-100 범위로 설정한 유형
        const ratio = o.hi / Math.max(Math.abs(mx), 1e-12);
        const factor = ratio > 50 && ratio < 200 ? 100 : ratio > 5 && ratio < 20 ? 10 : null;
        issues.push({ code: 'range_suspect', sev: 'warn', fix: factor ? { factor } : undefined,
          msg: `실측(${mn.toFixed(3)}~${mx.toFixed(3)})이 설정범위(${o.lo}~${o.hi}) 대비 극히 작음 — ${hintFor(ratio)}` });
      }
    }
    return issues;
  }

  // seriesMap 전체 리포트. tagMeta: {tagId: {lo, hi, kind}} (온톨로지에서)
  function report(seriesMap, tagMeta, opts) {
    const o = Object.assign({ nowMs: null, staleHours: 2 }, opts);
    const perTag = {};
    let errors = 0, warns = 0;
    for (const [id, s] of Object.entries(seriesMap || {})) {
      const meta = (tagMeta && tagMeta[id]) || {};
      const issues = checkSeries(s, { nowMs: o.nowMs, staleHours: o.staleHours, lo: meta.lo ?? null, hi: meta.hi ?? null, kind: meta.kind || 'analog' });
      if (issues.length) {
        perTag[id] = issues;
        errors += issues.filter(i => i.sev === 'error').length;
        warns += issues.filter(i => i.sev === 'warn').length;
      }
    }
    return { perTag, errors, warns, tagCount: Object.keys(seriesMap || {}).length, issueTagCount: Object.keys(perTag).length };
  }

  return { checkSeries, report };
});
