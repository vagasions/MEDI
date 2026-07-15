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
  // seSlope: 기울기 표준오차 (OLS) — 추세 기반 도달예상(RUL/TTA)의 불확실성 정량화에 사용
  function linreg(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0, seSlope: null, n };
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i];
      sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
    }
    const den = n * sxx - sx * sx;
    if (den === 0) return { slope: 0, intercept: sy / n, r2: 0, seSlope: null, n };
    const slope = (n * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / n;
    const ssTot = syy - sy * sy / n;
    let ssRes = 0;
    for (let i = 0; i < n; i++) { const e = ys[i] - (slope * xs[i] + intercept); ssRes += e * e; }
    const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
    const sxxC = sxx - sx * sx / n;
    const seSlope = n > 2 && sxxC > 0 ? Math.sqrt((ssRes / (n - 2)) / sxxC) : null;
    return { slope, intercept, r2, seSlope, n };
  }

  // 시계열 [{t(ms), v}] 구간 추세: 시간당 변화율(slope/hr) + 표준오차
  function trendPerHour(times, values) {
    if (times.length < 3) return { slopePerHour: 0, r2: 0, sePerHour: null };
    const t0 = times[0];
    const hx = times.map(t => (t - t0) / 3600000);
    const r = linreg(hx, values);
    return { slopePerHour: r.slope, r2: r.r2, sePerHour: r.seSlope };
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

  // ---------- F 분포 (Hotelling T² Phase II 관리한계용) ----------
  // 로그감마 — Lanczos 근사 (g=7, 상대오차 ~1e-13)
  function logGamma(x) {
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012,
      9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    x -= 1;
    let a = 0.99999999999980993;
    const t = x + 7.5;
    for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  // 연분수 (수치해석 표준 Lentz 전개) — betaInc 내부용
  function betacf(x, a, b) {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  // 정칙화 불완전 베타 I_x(a,b)
  function betaInc(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(x, a, b) / a : 1 - bt * betacf(1 - x, b, a) / b;
  }

  // F 누적분포: P(F ≤ f) = I_{d1·f/(d1·f+d2)}(d1/2, d2/2)
  function fCdf(f, d1, d2) {
    if (f <= 0) return 0;
    const x = (d1 * f) / (d1 * f + d2);
    return betaInc(x, d1 / 2, d2 / 2);
  }

  // F 분위수 — CDF 이분법 역산 (관리한계 계산 시 1회 호출이라 성능 문제 없음)
  function fInv(p, d1, d2) {
    if (p <= 0) return 0;
    if (p >= 1) return Infinity;
    let hi = 1;
    while (fCdf(hi, d1, d2) < p && hi < 1e12) hi *= 2;
    let lo = 0;
    for (let i = 0; i < 120; i++) {
      const mid = (lo + hi) / 2;
      if (fCdf(mid, d1, d2) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  return {
    mean, std, quantile, median, robustStd, histogram,
    rollingMeanStd, linreg, trendPerHour,
    ewmaChart, cusumChart, runRules,
    persistent, hysteresis,
    normInv, chi2Inv,
    logGamma, betaInc, fCdf, fInv,
  };
});
