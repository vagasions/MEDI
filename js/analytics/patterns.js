/* MEDI 예지보전 — 5대 분석 패턴 (회귀·분류·군집·이상탐지·시계열)
 * 전부 룰베이스/통계 기반 — 외부 AI 불필요. 실습·업무데이터 분석 겸용.
 * 브라우저(window.MEDI.patterns)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'), require('./multivariate.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.patterns = factory(root.MEDI.stats, root.MEDI.mv);
  }
})(typeof self !== 'undefined' ? self : this, function (stats, mv) {
  'use strict';

  // ---------- ① 회귀 (regression) ----------
  // x태그로 y태그를 설명하는 1차 모델 + 잔차 감시.
  // 물리적으로 연결된 신호쌍(유량↔전류 등)의 관계가 무너지면 설비 이상.
  function regression(xs, ys, splitFrac) {
    const n = Math.min(xs.length, ys.length);
    const split = Math.max(10, Math.floor(n * (splitFrac || 0.6)));
    const fit = stats.linreg(xs.slice(0, split), ys.slice(0, split));
    const resid = new Array(n);
    for (let i = 0; i < n; i++) resid[i] = ys[i] - (fit.slope * xs[i] + fit.intercept);
    const baseResid = resid.slice(0, split);
    const rMu = stats.mean(baseResid);
    const rSd = Math.max(stats.std(baseResid), 1e-9);
    const recent = resid.slice(split);
    const drift = (stats.mean(recent) - rMu) / rSd; // σ 단위 잔차 이동
    return {
      slope: fit.slope, intercept: fit.intercept, r2: fit.r2,
      resid, residMu: rMu, residSd: rSd, split,
      residDriftSigma: drift,
      verdict: Math.abs(drift) > 2
        ? `잔차가 학습구간 대비 ${drift.toFixed(1)}σ 이동 — 두 신호의 물리적 관계가 변했습니다 (설비 상태 변화 의심)`
        : `관계 유지 중 (잔차 이동 ${drift.toFixed(1)}σ, R²=${fit.r2.toFixed(2)})`,
    };
  }

  // ---------- ② 분류 (classification) ----------
  // 룰 트리로 운전상태 분류: 정지/저부하/정상/고부하/이상.
  // 실습 포인트: 라벨 없는 데이터에 도메인 룰로 라벨을 만드는 것도 분류다.
  function classifyStates(t, matrix, names, ruleset) {
    // matrix: n×p, ruleset: {loadIdx, loadLow, loadHigh, stopBelow} 또는 null(자동)
    const n = matrix.length;
    if (!n) return { labels: [], counts: {}, rules: null };
    const p = matrix[0].length;
    let li = ruleset && ruleset.loadIdx !== undefined ? ruleset.loadIdx : 0;
    const loadCol = matrix.map(r => r[li]);
    const q = f => stats.quantile(loadCol, f);
    const rules = Object.assign({
      loadIdx: li,
      stopBelow: q(0.02) * 0.5,
      loadLow: q(0.15),
      loadHigh: q(0.9),
    }, ruleset || {});
    // 이상 판정: 부하 구간별 정상 분포에서 z>3인 다른 변수 존재
    const { mu, sd } = mv.meanStdCols(matrix);
    const labels = new Array(n);
    const counts = { '정지': 0, '저부하': 0, '정상': 0, '고부하': 0, '이상': 0 };
    for (let i = 0; i < n; i++) {
      const load = loadCol[i];
      let lab;
      if (load <= rules.stopBelow) lab = '정지';
      else {
        let abnormal = false;
        for (let j = 0; j < p; j++) {
          if (j === rules.loadIdx) continue;
          if (sd[j] > 0 && Math.abs(matrix[i][j] - mu[j]) / sd[j] > 3) { abnormal = true; break; }
        }
        if (abnormal) lab = '이상';
        else if (load < rules.loadLow) lab = '저부하';
        else if (load > rules.loadHigh) lab = '고부하';
        else lab = '정상';
      }
      labels[i] = lab;
      counts[lab]++;
    }
    return { labels, counts, rules, loadName: names[rules.loadIdx] };
  }

  // ---------- ③ 군집 (clustering) — k-means ----------
  function kmeans(matrix, k, maxIter) {
    const n = matrix.length;
    if (!n) return { assignments: [], centroids: [], inertia: 0 };
    const p = matrix[0].length;
    const K = Math.min(k || 3, n);
    // 표준화 후 군집 (스케일 차이 제거)
    const { mu, sd } = mv.meanStdCols(matrix);
    const Z = mv.standardize(matrix, mu, sd);
    // k-means++ 시드 (결정적: 첫 점 + 최원거리)
    const cents = [Z[0].slice()];
    while (cents.length < K) {
      let best = 0, bestD = -1;
      for (let i = 0; i < n; i++) {
        let dmin = Infinity;
        for (const c of cents) dmin = Math.min(dmin, dist2(Z[i], c));
        if (dmin > bestD) { bestD = dmin; best = i; }
      }
      cents.push(Z[best].slice());
    }
    let assign = new Array(n).fill(0);
    for (let iter = 0; iter < (maxIter || 50); iter++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < K; c++) {
          const d = dist2(Z[i], cents[c]);
          if (d < bd) { bd = d; bi = c; }
        }
        if (assign[i] !== bi) { assign[i] = bi; changed = true; }
      }
      const sums = cents.map(() => new Array(p).fill(0));
      const cnt = new Array(K).fill(0);
      for (let i = 0; i < n; i++) {
        cnt[assign[i]]++;
        for (let j = 0; j < p; j++) sums[assign[i]][j] += Z[i][j];
      }
      for (let c = 0; c < K; c++) {
        if (cnt[c]) for (let j = 0; j < p; j++) cents[c][j] = sums[c][j] / cnt[c];
      }
      if (!changed) break;
    }
    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += dist2(Z[i], cents[assign[i]]);
    // 원 단위 센트로이드로 환원
    const centroids = cents.map(c => c.map((v, j) => v * (sd[j] || 1) + mu[j]));
    const sizes = new Array(K).fill(0);
    assign.forEach(a => sizes[a]++);
    return { assignments: assign, centroids, inertia, sizes, k: K };
  }

  function dist2(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return s;
  }

  // ---------- ④ 이상탐지 (anomaly detection) ----------
  // 학습구간 Mahalanobis 거리 기반 스코어 + 상위 이상 시점 목록
  function anomaly(t, matrix, names, splitFrac) {
    const n = matrix.length;
    const split = Math.max(20, Math.floor(n * (splitFrac || 0.5)));
    const model = mv.mahalanobisFit(matrix.slice(0, split));
    const d = mv.mahalanobisApply(model, matrix);
    const anomalies = [];
    for (let i = split; i < n; i++) {
      if (d[i] > model.dAlarm) anomalies.push(i);
    }
    // 이상 시점의 기여 변수: |z|가 큰 변수
    const { mu, sd } = mv.meanStdCols(matrix.slice(0, split));
    function topVars(i) {
      return matrix[i]
        .map((v, j) => ({ name: names[j], z: sd[j] > 0 ? (v - mu[j]) / sd[j] : 0 }))
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
        .slice(0, 3);
    }
    const recent = d.slice(Math.max(split, n - 50));
    const recentFrac = recent.filter(x => x > model.dWarn).length / Math.max(1, recent.length);
    return {
      scores: d, split, dWarn: model.dWarn, dAlarm: model.dAlarm,
      anomalyIdx: anomalies, topVars,
      anomalyFrac: anomalies.length / Math.max(1, n - split),
      recentWarnFrac: recentFrac,
    };
  }

  // ---------- ⑤ 시계열 (time series) — Holt 이중지수평활 예측 + 임계 도달 시점 ----------
  function holtForecast(t, v, opts) {
    const o = Object.assign({ alpha: 0.3, beta: 0.05, horizon: 0.5 }, opts); // horizon: 데이터 길이 대비 비율
    const n = v.length;
    if (n < 10) return null;
    let level = v[0], trend = (v[Math.min(5, n - 1)] - v[0]) / Math.min(5, n - 1);
    const fitted = new Array(n);
    for (let i = 0; i < n; i++) {
      fitted[i] = level + trend;
      const prevLevel = level;
      level = o.alpha * v[i] + (1 - o.alpha) * (level + trend);
      trend = o.beta * (level - prevLevel) + (1 - o.beta) * trend;
    }
    // 잔차 표준편차로 예측 불확실 밴드
    const resid = v.map((x, i) => x - fitted[i]).slice(Math.floor(n * 0.2));
    const rSd = stats.std(resid);
    const dt = (t[n - 1] - t[0]) / (n - 1);
    const m = Math.max(5, Math.floor(n * o.horizon));
    const ft = new Array(m), fv = new Array(m), fLo = new Array(m), fHi = new Array(m);
    for (let h = 1; h <= m; h++) {
      ft[h - 1] = t[n - 1] + h * dt;
      fv[h - 1] = level + h * trend;
      const band = rSd * Math.sqrt(1 + h * 0.15) * 1.96;
      fLo[h - 1] = fv[h - 1] - band;
      fHi[h - 1] = fv[h - 1] + band;
    }
    return { fitted, forecastT: ft, forecastV: fv, lo: fLo, hi: fHi, level, trendPerStep: trend, residSd: rSd, dtMs: dt };
  }

  // 임계값 도달 예상 시점(잔여수명 근사): 예측선이 limit에 닿는 첫 시각
  function timeToLimit(fc, limit, aboveIsBad) {
    if (!fc) return null;
    for (let i = 0; i < fc.forecastT.length; i++) {
      const hit = aboveIsBad !== false ? fc.forecastV[i] >= limit : fc.forecastV[i] <= limit;
      if (hit) return { t: fc.forecastT[i], idx: i };
    }
    // 예측 구간 내 미도달 → 추세로 외삽
    if (Math.abs(fc.trendPerStep) < 1e-12) return null;
    const last = fc.forecastV[fc.forecastV.length - 1];
    const steps = (limit - last) / fc.trendPerStep;
    if (steps <= 0 || !isFinite(steps)) return null;
    return { t: fc.forecastT[fc.forecastT.length - 1] + steps * fc.dtMs, idx: null, extrapolated: true };
  }

  return { regression, classifyStates, kmeans, anomaly, holtForecast, timeToLimit };
});
