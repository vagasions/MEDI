/*
 * MEDI 밸브 진단 엔진 — 제어밸브(CV) + 온오프/차단밸브(OV)
 *
 * 논문 기반 검증 기법 (출처는 docs/PLAN.md §3.11):
 *  · 진동 검출: ACF(자기상관) 영교차 규칙성 — Thornhill, Huang & Zhang (2003),
 *    "Detection of multiple oscillations in control loops", J. Process Control.
 *    ACF 영교차 간격의 규칙성 r 이 임계 이상이면 규칙적 진동으로 판정.
 *  · 스틱션 정량화: PV-OP 타원 적합의 OP축 폭 = "겉보기 스틱션(apparent stiction)" —
 *    Choudhury, Thornhill & Shah (2006), Control Engineering Practice.
 *  · 이동량/반전 카운트: 포지셔너 진단(ValveLink 등)과 동일한 누적 travel/reversal 지표.
 *  · 온오프 밸브: 스트로크 시간 추세 + 지령-리미트 정합 — SIS 부분행정시험(PST) 실무의
 *    히스토리안 근사 (IEC 61511 맥락).
 *
 * 브라우저(window.MEDI.valve)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.valve = factory(root.MEDI.stats);
  }
})(typeof self !== 'undefined' ? self : this, function (stats) {
  'use strict';

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  // ---------- ACF 기반 진동 검출 (Thornhill 2003) ----------
  // v: 신호(등간격), dtMin: 샘플 주기(분)
  // 반환: { oscillating, periodMin, r, nCross }
  function acfOscillation(v, dtMin, opts) {
    const o = Object.assign({ maxLagFrac: 0.4, rThreshold: 1, hpWin: null }, opts);
    const n = v.length;
    if (n < 40) return { oscillating: false, periodMin: null, r: 0, nCross: 0 };
    // 고역 통과(중심 이동평균 제거) — Thornhill 원문의 밴드패스 전처리에 해당.
    // 부하 변동 등 저주파가 ACF를 지배해 진동 영교차가 묻히는 것을 방지.
    const w = o.hpWin || Math.max(6, Math.round(n / 12));
    const x = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b2 = Math.min(n - 1, i + w);
      let s = 0;
      for (let j = a; j <= b2; j++) s += v[j];
      x[i] = v[i] - s / (b2 - a + 1);
    }
    const denom = x.reduce((a, b) => a + b * b, 0);
    if (denom < 1e-12) return { oscillating: false, periodMin: null, r: 0, nCross: 0 };
    const maxLag = Math.floor(n * o.maxLagFrac);
    const acf = new Array(maxLag + 1);
    for (let k = 0; k <= maxLag; k++) {
      let s = 0;
      for (let i = 0; i + k < n; i++) s += x[i] * x[i + k];
      acf[k] = s / denom;
    }
    // 영교차 위치 (선형 보간)
    const crossings = [];
    for (let k = 1; k <= maxLag; k++) {
      if ((acf[k - 1] > 0 && acf[k] <= 0) || (acf[k - 1] < 0 && acf[k] >= 0)) {
        const f = acf[k - 1] / (acf[k - 1] - acf[k]);
        crossings.push(k - 1 + f);
      }
    }
    if (crossings.length < 3) return { oscillating: false, periodMin: null, r: 0, nCross: crossings.length, acf };
    // 인접 영교차 간격 = 반주기. 규칙성 r = mean/(3·std) (Thornhill 2003)
    const gaps = [];
    for (let i = 1; i < crossings.length; i++) gaps.push(crossings[i] - crossings[i - 1]);
    const gMu = stats.mean(gaps);
    const gSd = stats.std(gaps);
    const r = gSd < 1e-9 ? 99 : gMu / (3 * gSd);
    const periodMin = 2 * gMu * dtMin;
    // 진동 판정: 규칙성 + ACF 1차 골이 충분히 깊음(잡음 아님)
    let minAcf = 1;
    for (let k = 1; k <= Math.min(maxLag, Math.ceil(gaps.length ? 2 * gMu : maxLag)); k++) minAcf = Math.min(minAcf, acf[k]);
    const oscillating = r > o.rThreshold && minAcf < -0.2;
    return { oscillating, periodMin, r, nCross: crossings.length, acfDepth: minAcf, acf };
  }

  // ---------- PV-OP 타원 적합 스틱션 정량화 (Choudhury 2006) ----------
  // 진동 구간의 (op, pv) 점들에 타원 ax²+bxy+cy²+dx+ey=1 을 최소제곱 적합,
  // OP축 방향 폭(겉보기 스틱션)을 반환. op 단위(%)라면 결과도 %.
  function stictionEllipse(op, pv) {
    const n = Math.min(op.length, pv.length);
    if (n < 30) return null;
    const mx = stats.mean(op), my = stats.mean(pv);
    const sy = Math.max(stats.std(pv), 1e-9);
    const sxRaw = Math.max(stats.std(op), 1e-9);
    // 조건수 개선을 위해 PV를 OP 스케일로 정규화 (겉보기 스틱션은 OP축 폭이라 영향 없음)
    const X = [], Y = [];
    for (let i = 0; i < n; i++) { X.push(op[i] - mx); Y.push((pv[i] - my) * (sxRaw / sy)); }
    // 정규방정식 5x5: [x², xy, y², x, y]·c = 1
    const A = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
    const b = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const row = [X[i] * X[i], X[i] * Y[i], Y[i] * Y[i], X[i], Y[i]];
      for (let p = 0; p < 5; p++) {
        b[p] += row[p];
        for (let q = 0; q < 5; q++) A[p][q] += row[p] * row[q];
      }
    }
    const c = solve5(A, b);
    if (!c) return null;
    const [a, bb, cc] = c;
    // 타원 조건: a>0, c>0, 4ac-b² > 0
    const disc = 4 * a * cc - bb * bb;
    if (a <= 0 || cc <= 0 || disc <= 0) return null;
    // 중심 이동을 무시한 근사(데이터가 이미 센터링됨): OP축 최대 폭 = 2/sqrt(a - b²/(4c))
    const k = a - (bb * bb) / (4 * cc);
    if (k <= 0) return null;
    const apparent = 2 / Math.sqrt(k);
    // 적합 품질: 점들의 잔차
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const f = a * X[i] * X[i] + bb * X[i] * Y[i] + cc * Y[i] * Y[i] + c[3] * X[i] + c[4] * Y[i];
      sse += (f - 1) * (f - 1); sst += 1;
    }
    const fit = clamp01(1 - sse / Math.max(sst, 1e-9));
    return { apparent, fit };
  }

  function solve5(A, b) {
    const n = 5;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let cc2 = col; cc2 <= n; cc2++) M[r][cc2] -= f * M[col][cc2];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // ---------- 누적 이동량 / 반전 카운트 (포지셔너 travel/reversal 지표) ----------
  // pos: 개도(%), tMs: 시각, baseIdx/recentIdx: [s,e)
  function travelStats(pos, tMs, baseIdx, recentIdx) {
    function calc(s, e) {
      let travel = 0, reversals = 0, lastDir = 0;
      for (let i = s + 1; i < e; i++) {
        const d = pos[i] - pos[i - 1];
        if (Math.abs(d) < 0.05) continue; // 데드밴드 미만 무시
        travel += Math.abs(d);
        const dir = d > 0 ? 1 : -1;
        if (lastDir !== 0 && dir !== lastDir) reversals++;
        lastDir = dir;
      }
      const hours = (tMs[e - 1] - tMs[s]) / 3600000;
      return { travelPerDay: travel * 24 / Math.max(hours, 0.5), reversalsPerDay: reversals * 24 / Math.max(hours, 0.5) };
    }
    const base = calc(baseIdx[0], baseIdx[1]);
    const rec = calc(recentIdx[0], recentIdx[1]);
    return {
      base, recent: rec,
      travelRatio: rec.travelPerDay / Math.max(base.travelPerDay, 1e-6),
      reversalRatio: rec.reversalsPerDay / Math.max(base.reversalsPerDay, 1e-6),
    };
  }

  // ---------- 온오프 밸브: 지령-리미트 정합 (fail-to-function 검출) ----------
  // cmd/openFb/closedFb: {t:[],v:[]} 원시 시리즈 (같은 그리드 가정 — 시뮬레이터/히스토리안 등간격)
  // 정상: cmd=1이면 open_fb=1·closed_fb=0 (전환 직후 1샘플 허용)
  function cmdFbConsistency(cmd, openFb, closedFb, recentMs) {
    const n = Math.min(cmd.v.length, openFb.v.length, closedFb ? closedFb.v.length : Infinity);
    if (!isFinite(n) || n < 10) return null;
    const bin = x => (x >= 0.5 ? 1 : 0);
    let ops = 0, recOps = 0;
    let mism = 0, mismN = 0, recMism = 0, recMismN = 0;
    const tEnd = cmd.t[n - 1];
    for (let i = 1; i < n; i++) {
      const c = bin(cmd.v[i]), cPrev = bin(cmd.v[i - 1]);
      if (c !== cPrev) { ops++; if (tEnd - cmd.t[i] <= recentMs) recOps++; continue; } // 전환 샘플은 판정 제외
      const of = bin(openFb.v[i]);
      const cf = closedFb ? bin(closedFb.v[i]) : 1 - of;
      const bad = (c === 1 && of !== 1) || (c === 0 && cf !== 1) ? 1 : 0;
      mism += bad; mismN++;
      if (tEnd - cmd.t[i] <= recentMs) { recMism += bad; recMismN++; }
    }
    return {
      ops, recentOps: recOps,
      mismatchFrac: mismN ? mism / mismN : 0,
      recentMismatchFrac: recMismN ? recMism / recMismN : 0,
    };
  }

  return { acfOscillation, stictionEllipse, travelStats, cmdFbConsistency };
});
