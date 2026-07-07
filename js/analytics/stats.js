/* MEDI 예지보전 — 단변량 통계/SPC 엔진
 * 의존성 없음. 브라우저(window.MEDI.stats)와 Node(require) 양쪽에서 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.stats = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 기초 통계 ----------
  function mean(xs) {
    if (!xs.length) return NaN;
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }

  // 표본 표준편차 (n-1)
  function std(xs, mu) {
    if (xs.length < 2) return 0;
    const m = mu === undefined ? mean(xs) : mu;
    let s = 0;
    for (let i = 0; i < xs.length; i++) { const d = xs[i] - m; s += d * d; }
    return Math.sqrt(s / (xs.length - 1));
  }

  function quantile(xs, q) {
    if (!xs.length) return NaN;
    const a = xs.slice().sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  function median(xs) { return quantile(xs, 0.5); }

  // MAD 기반 강건 표준편차 추정 (이상치에 둔감)
  function robustStd(xs) {
    const med = median(xs);
    const dev = xs.map(x => Math.abs(x - med));
    return 1.4826 * median(dev);
  }

  function histogram(xs, bins) {
    if (!xs.length) return { edges: [], counts: [] };
    const lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
    const n = bins || 30;
    const w = (hi - lo) / n || 1;
    const counts = new Array(n).fill(0);
    for (const x of xs) {
      let b = Math.floor((x - lo) / w);
      if (b >= n) b = n - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    const edges = [];
    for (let i = 0; i <= n; i++) edges.push(lo + i * w);
    return { edges, counts };
  }

  // ---------- 이동(롤링) 통계 ----------
  // Welford 누적 방식 대신 창 합/제곱합 방식 — 창 크기 고정, O(n)
  function rollingMeanStd(xs, win) {
    const n = xs.length;
    const rm = new Array(n).fill(NaN);
    const rs = new Array(n).fill(NaN);
    let sum = 0, sq = 0;
    for (let i = 0; i < n; i++) {
      sum += xs[i]; sq += xs[i] * xs[i];
      if (i >= win) { sum -= xs[i - win]; sq -= xs[i - win] * xs[i - win]; }
      const cnt = Math.min(i + 1, win);
      if (cnt >= 2) {
        const m = sum / cnt;
        // 부동소수 오차로 음수가 될 수 있어 0으로 절사
        const v = Math.max(0, (sq - cnt * m * m) / (cnt - 1));
        rm[i] = m; rs[i] = Math.sqrt(v);
      } else if (cnt === 1) { rm[i] = sum; rs[i] = 0; }
    }
    return { mean: rm, std: rs };
  }

  // ---------- 선형 회귀 / 추세 ----------
  function linreg(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i];
      sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
    }
    const den = n * sxx - sx * sx;
    if (den === 0) return { slope: 0, intercept: sy / n, r2: 0 };
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    const ssTot = syy - sy * sy / n;
    let ssRes = 0;
    for (let i = 0; i < n; i++) { const e = ys[i] - (slope * xs[i] + intercept); ssRes += e * e; }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    return { slope, intercept, r2 };
  }

  // 시계열 [{t(ms), v}] 구간 추세: 시간당 변화율(slope/hr)
  function trendPerHour(times, values) {
    if (times.length < 3) return { slopePerHour: 0, r2: 0 };
    const t0 = times[0];
    const hx = times.map(t => (t - t0) / 3600000);
    const r = linreg(hx, values);
    return { slopePerHour: r.slope, r2: r.r2 };
  }

  // ---------- EWMA 관리도 ----------
  // z_t = λ x_t + (1-λ) z_{t-1};  분산 σ² λ/(2-λ) (1-(1-λ)^{2t})
  // 일반 파라미터: λ=0.2, L=3 (작은 이동 검출에는 λ=0.05~0.1, L≈2.7)
  function ewmaChart(xs, opts) {
    const o = Object.assign({ lambda: 0.2, L: 3, mu: null, sigma: null }, opts);
    const mu = o.mu !== null ? o.mu : mean(xs);
    const sigma = o.sigma !== null ? o.sigma : std(xs);
    const n = xs.length;
    const z = new Array(n), ucl = new Array(n), lcl = new Array(n), viol = new Array(n);
    let prev = mu;
    for (let t = 0; t < n; t++) {
      prev = o.lambda * xs[t] + (1 - o.lambda) * prev;
      z[t] = prev;
      const f = Math.sqrt(o.lambda / (2 - o.lambda) * (1 - Math.pow(1 - o.lambda, 2 * (t + 1))));
      ucl[t] = mu + o.L * sigma * f;
      lcl[t] = mu - o.L * sigma * f;
      viol[t] = z[t] > ucl[t] ? 1 : (z[t] < lcl[t] ? -1 : 0);
    }
    return { z, ucl, lcl, violations: viol, mu, sigma };
  }

  // ---------- CUSUM (표 형식) ----------
  // C+ = max(0, x-(μ+K)+C+), C- = max(0, (μ-K)-x+C-);  K=kσ(k=0.5), H=hσ(h=4~5)
  function cusumChart(xs, opts) {
    const o = Object.assign({ k: 0.5, h: 5, mu: null, sigma: null }, opts);
    const mu = o.mu !== null ? o.mu : mean(xs);
    const sigma = (o.sigma !== null ? o.sigma : std(xs)) || 1e-12;
    const K = o.k * sigma, H = o.h * sigma;
    const n = xs.length;
    const cp = new Array(n), cm = new Array(n), viol = new Array(n);
    let p = 0, m = 0;
    for (let t = 0; t < n; t++) {
      p = Math.max(0, xs[t] - (mu + K) + p);
      m = Math.max(0, (mu - K) - xs[t] + m);
      cp[t] = p; cm[t] = m;
      viol[t] = p > H ? 1 : (m > H ? -1 : 0);
    }
    return { cplus: cp, cminus: cm, H, violations: viol, mu, sigma };
  }

  // ---------- Western Electric / Nelson 런 규칙 ----------
  // 반환: 각 규칙 위반이 "끝나는" 인덱스 목록
  // R1: 1점이 3σ 초과 | R2: 3점 중 2점이 같은쪽 2σ 초과 | R3: 5점 중 4점이 같은쪽 1σ 초과
  // R4: 연속 8점 같은쪽 | R5(Nelson3): 연속 6점 단조 증가/감소
  function runRules(xs, opts) {
    const o = Object.assign({ mu: null, sigma: null }, opts);
    const mu = o.mu !== null ? o.mu : mean(xs);
    const sigma = (o.sigma !== null ? o.sigma : std(xs)) || 1e-12;
    const zs = xs.map(x => (x - mu) / sigma);
    const out = { r1: [], r2: [], r3: [], r4: [], r5: [] };
    for (let i = 0; i < zs.length; i++) {
      if (Math.abs(zs[i]) > 3) out.r1.push({ i, side: zs[i] > 0 ? 1 : -1 });
      if (i >= 2) {
        for (const side of [1, -1]) {
          let c = 0;
          for (let j = i - 2; j <= i; j++) if (zs[j] * side > 2) c++;
          if (c >= 2 && zs[i] * side > 2) { out.r2.push({ i, side }); break; }
        }
      }
      if (i >= 4) {
        for (const side of [1, -1]) {
          let c = 0;
          for (let j = i - 4; j <= i; j++) if (zs[j] * side > 1) c++;
          if (c >= 4 && zs[i] * side > 1) { out.r3.push({ i, side }); break; }
        }
      }
      if (i >= 7) {
        let up = true, dn = true;
        for (let j = i - 7; j <= i; j++) { if (zs[j] <= 0) up = false; if (zs[j] >= 0) dn = false; }
        if (up) out.r4.push({ i, side: 1 });
        if (dn) out.r4.push({ i, side: -1 });
      }
      if (i >= 5) {
        let inc = true, dec = true;
        for (let j = i - 4; j <= i; j++) {
          if (xs[j] <= xs[j - 1]) inc = false;
          if (xs[j] >= xs[j - 1]) dec = false;
        }
        if (inc) out.r5.push({ i, side: 1 });
        if (dec) out.r5.push({ i, side: -1 });
      }
    }
    return out;
  }

  // ---------- 지속성(persistence) 필터 ----------
  // cond[]가 true로 minRun개 연속되면 확정 — 알람 채터링 억제용
  function persistent(cond, minRun) {
    const out = new Array(cond.length).fill(false);
    let run = 0;
    for (let i = 0; i < cond.length; i++) {
      run = cond[i] ? run + 1 : 0;
      if (run >= minRun) out[i] = true;
    }
    return out;
  }

  // 데드밴드 히스테리시스: raise 초과 시 on, clear 미만으로 내려와야 off
  function hysteresis(values, raise, clear, aboveIsBad) {
    const out = new Array(values.length).fill(false);
    let on = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (aboveIsBad !== false) {
        if (!on && v >= raise) on = true;
        else if (on && v < clear) on = false;
      } else {
        if (!on && v <= raise) on = true;
        else if (on && v > clear) on = false;
      }
      out[i] = on;
    }
    return out;
  }

  // ---------- 분포 근사 ----------
  // 표준정규 상위 분위수 (Acklam 근사 역함수)
  function normInv(p) {
    if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00];
    const pl = 0.02425, ph = 1 - pl;
    let q, r;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= ph) {
      q = p - 0.5; r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // 카이제곱 분위수 — Wilson-Hilferty 근사 (n>30 아니어도 관리한계 용도로 충분)
  function chi2Inv(p, k) {
    const z = normInv(p);
    const t = 1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k));
    return k * t * t * t;
  }

  return {
    mean, std, quantile, median, robustStd, histogram,
    rollingMeanStd, linreg, trendPerHour,
    ewmaChart, cusumChart, runRules,
    persistent, hysteresis,
    normInv, chi2Inv,
  };
});
