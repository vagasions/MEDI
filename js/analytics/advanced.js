/* MEDI 예지보전 — 최신 검증 기법 (논문 기반, 의존성 없음)
 *
 * 구현 근거 (모두 동료심사 논문 · 대규모 인용):
 *  - Matrix Profile(STOMP): Yeh et al., "Matrix Profile I", ICDM 2016 /
 *    Zhu et al., "Matrix Profile II (STOMP)", ICDM 2016 — 디스코드(가장 특이한 부분수열) 탐지
 *  - Isolation Forest: Liu, Ting, Zhou, ICDM 2008 — ψ=256, t=100, s=2^(-E[h]/c(ψ))
 *  - Spectral Residual: Ren et al., KDD 2019 (Microsoft) — 로그 진폭 스펙트럼의 잔차 → 돌출도 맵
 *  - PELT 변화점: Killick, Fearnhead, Eckley, JASA 2012 — 평균+분산 변화 비용 + 가지치기
 *  - ECOD: Li et al., IEEE TKDE 2022 — 차원별 경험적 CDF 꼬리확률, 무파라미터
 *  - 지수 열화 RUL: Gebraeel et al., IIE Trans. 2005 계열 — 지수 추세 적합 후 임계 도달 역산
 *  (선정 근거: Schmidl et al., PVLDB 2022 대규모 벤치마크에서 거리/디스코드 계열이
 *   딥러닝 포함 상위권 — 상세는 docs/PLAN.md 참고문헌)
 *
 * 브라우저(window.MEDI.adv)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.adv = factory(root.MEDI.stats);
  }
})(typeof self !== 'undefined' ? self : this, function (stats) {
  'use strict';

  // 재현 가능한 의사난수 (Isolation Forest 트리 구축용)
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ==========================================================
  // 1) Matrix Profile — STOMP (Zhu et al. 2016)
  //    z-정규화 유클리드 거리의 최근접 이웃 프로파일.
  //    QT(내적) 재귀로 O(n²) 이내 계산 — n≈수천 점이면 브라우저에서 충분.
  // ==========================================================
  // 반환: {mp[], mpIdx[], discords:[{idx, dist}], m}
  function matrixProfile(ts, m, opts) {
    const o = Object.assign({ topK: 3, exclusion: null }, opts);
    const n = ts.length;
    const l = n - m + 1;
    if (l < 4 || m < 4) return null;
    const excl = o.exclusion || Math.ceil(m / 2); // 자기 자신 주변 제외(trivial match)

    // 누적합으로 각 창의 평균/표준편차 (O(n))
    const cum = new Float64Array(n + 1), cum2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      cum[i + 1] = cum[i] + ts[i];
      cum2[i + 1] = cum2[i] + ts[i] * ts[i];
    }
    const mu = new Float64Array(l), sig = new Float64Array(l);
    for (let i = 0; i < l; i++) {
      const s = cum[i + m] - cum[i], s2 = cum2[i + m] - cum2[i];
      mu[i] = s / m;
      const v = Math.max(0, s2 / m - mu[i] * mu[i]);
      sig[i] = Math.sqrt(v);
    }
    // 정확한 상수(stuck) 창 판정 — 연속 동일값 런 길이 (stumpy의 isconstant와 동일 접근).
    // 누적합 기반 σ는 부동소수 상쇄오차로 상수 창에서도 ~1e-6이 나올 수 있어 σ 임계만으로는 놓친다.
    const runLen = new Int32Array(n);
    runLen[0] = 1;
    for (let i = 1; i < n; i++) runLen[i] = ts[i] === ts[i - 1] ? runLen[i - 1] + 1 : 1;
    const isConst = new Uint8Array(l);
    for (let i = 0; i < l; i++) isConst[i] = runLen[i + m - 1] >= m ? 1 : 0;

    const mp = new Float64Array(l).fill(Infinity);
    const mpIdx = new Int32Array(l).fill(-1);

    // 첫 행 QT: QT[j] = dot(ts[0..m-1], ts[j..j+m-1])
    let QT = new Float64Array(l);
    for (let j = 0; j < l; j++) {
      let s = 0;
      for (let k = 0; k < m; k++) s += ts[k] * ts[j + k];
      QT[j] = s;
    }
    const firstQT = Float64Array.from(QT);

    const CONST_EPS = 1e-10;
    function distFromQT(qt, i, j) {
      // z-정규화 거리: d² = 2m(1 - (qt - m·μi·μj)/(m·σi·σj))
      // 상수(stuck) 부분수열 처리: 둘 다 상수 → 0, 한쪽만 상수 → Infinity(이웃 후보 제외).
      // 고정 관례값(√m 등)을 반환하면 MP가 min이라 상수 창 하나가 "모든" 창의 MP를
      // 그 값으로 캡해 디스코드 순위가 동률 붕괴한다 — 제외가 비상수 창의 진짜 NN 거리를 보존.
      const ci = isConst[i] === 1, cj = isConst[j] === 1;
      if (ci || cj) return (ci && cj) ? 0 : Infinity;
      const denom = m * sig[i] * sig[j];
      if (denom < CONST_EPS) return Math.sqrt(2 * m); // 준상수(부동소수 수준 변동) — 상관 0 취급
      let corr = (qt - m * mu[i] * mu[j]) / denom;
      if (corr > 1) corr = 1;
      if (corr < -1) corr = -1;
      return Math.sqrt(Math.max(0, 2 * m * (1 - corr)));
    }

    for (let i = 0; i < l; i++) {
      if (i > 0) {
        // STOMP 재귀: QT[j] = QT_prev[j-1] − ts[i-1]·ts[j-1] + ts[i+m-1]·ts[j+m-1]
        for (let j = l - 1; j > 0; j--) {
          QT[j] = QT[j - 1] - ts[i - 1] * ts[j - 1] + ts[i + m - 1] * ts[j + m - 1];
        }
        QT[0] = firstQT[i];
      }
      for (let j = 0; j < l; j++) {
        if (Math.abs(i - j) < excl) continue;
        const d = distFromQT(QT[j], i, j);
        if (d < mp[i]) { mp[i] = d; mpIdx[i] = j; }
      }
    }

    // 디스코드: MP가 큰 순서 topK (서로 excl 이상 떨어진 것만)
    // isFinite 필터가 이웃 없는 상수 창(mp=Infinity)을 후보에서 배제한다 —
    // 상수 창 자체의 이상은 계기 진단(stuck)이 담당, 디스코드는 형태 이상 전용.
    const order = Array.from({ length: l }, (_, i) => i)
      .filter(i => isFinite(mp[i]))
      .sort((a, b) => mp[b] - mp[a]);
    const discords = [];
    for (const i of order) {
      if (discords.length >= o.topK) break;
      if (discords.every(d => Math.abs(d.idx - i) >= excl)) {
        discords.push({ idx: i, dist: mp[i] });
      }
    }
    return { mp: Array.from(mp), mpIdx: Array.from(mpIdx), discords, m };
  }

  // ==========================================================
  // 2) Isolation Forest (Liu et al. 2008)
  //    X: n×p. 반환: 각 점의 이상점수 s∈(0,1) — 0.5↑ 의심, ~0.7↑ 강한 이상
  // ==========================================================
  // opts.trainRange: [s,e) — 부분표본을 이 구간(정상 베이스라인)에서만 추출.
  // 예지보전에서는 정상 구간으로 숲을 만들고 전체를 채점해야 이상이 희석되지 않는다.
  function isolationForest(X, opts) {
    const o = Object.assign({ trees: 100, sampleSize: 256, seed: 20260707, trainRange: null }, opts);
    const n = X.length;
    if (!n) return { scores: [] };
    const p = X[0].length;
    const tr0 = o.trainRange ? Math.max(0, o.trainRange[0]) : 0;
    const tr1 = o.trainRange ? Math.min(n, o.trainRange[1]) : n;
    const trainN = Math.max(2, tr1 - tr0);
    const psi = Math.min(o.sampleSize, trainN);
    const maxDepth = Math.ceil(Math.log2(Math.max(2, psi)));
    const rand = rng(o.seed);

    // c(ψ): 평균 경로길이 정규화 상수 (논문 식 1)
    function cFactor(size) {
      if (size <= 1) return 0;
      if (size === 2) return 1;
      const H = Math.log(size - 1) + 0.5772156649;
      return 2 * H - (2 * (size - 1)) / size;
    }
    const cPsi = cFactor(psi);

    function buildTree(idxs, depth) {
      if (depth >= maxDepth || idxs.length <= 1) {
        return { leaf: true, size: idxs.length };
      }
      const attr = Math.floor(rand() * p);
      let lo = Infinity, hi = -Infinity;
      for (const i of idxs) {
        const v = X[i][attr];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!(hi > lo)) return { leaf: true, size: idxs.length };
      const split = lo + rand() * (hi - lo);
      const L = [], R = [];
      for (const i of idxs) (X[i][attr] < split ? L : R).push(i);
      if (!L.length || !R.length) return { leaf: true, size: idxs.length };
      return { leaf: false, attr, split, l: buildTree(L, depth + 1), r: buildTree(R, depth + 1) };
    }

    const forest = [];
    for (let t = 0; t < o.trees; t++) {
      // 부트스트랩 없이 무작위 부분표본 (논문 방식) — trainRange 내에서만 추출
      const idxs = [];
      const taken = new Set();
      while (idxs.length < psi) {
        const i = tr0 + Math.floor(rand() * trainN);
        if (!taken.has(i)) { taken.add(i); idxs.push(i); }
      }
      forest.push(buildTree(idxs, 0));
    }

    function pathLength(x, node, depth) {
      for (;;) {
        if (node.leaf) return depth + cFactor(node.size);
        node = x[node.attr] < node.split ? node.l : node.r;
        depth++;
      }
    }

    const scores = new Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const tree of forest) sum += pathLength(X[i], tree, 0);
      const Eh = sum / forest.length;
      scores[i] = Math.pow(2, -Eh / (cPsi || 1));
    }
    return { scores, threshold: 0.6 }; // 논문 가이드: s>0.6 잠재 이상, ~0.5 정상
  }

  // ==========================================================
  // 3) Spectral Residual (Ren et al., KDD 2019)
  //    돌출도(saliency) 맵 — 급격/특이 변화 시점 검출
  // ==========================================================
  function fft(re, im) {
    // 반복형 radix-2 Cooley-Tukey (in-place)
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = nwr;
        }
      }
    }
  }
  function ifft(re, im) {
    for (let i = 0; i < im.length; i++) im[i] = -im[i];
    fft(re, im);
    const n = re.length;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }

  // 반환: {saliency[], scores[](정규화 z), threshold}
  function spectralResidual(xs, opts) {
    const o = Object.assign({ avgWindow: 3, scoreWindow: 21 }, opts);
    const nRaw = xs.length;
    if (nRaw < 16) return null;
    let n = 1;
    while (n < nRaw) n <<= 1;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < nRaw; i++) re[i] = xs[i];
    for (let i = nRaw; i < n; i++) re[i] = xs[nRaw - 1]; // 마지막 값 패딩
    fft(re, im);

    const amp = new Float64Array(n), logAmp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      amp[i] = Math.hypot(re[i], im[i]);
      logAmp[i] = Math.log(amp[i] + 1e-8);
    }
    // 평균 필터로 로그 스펙트럼 평활 → 잔차
    const q = o.avgWindow;
    const avg = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = -q; j <= q; j++) {
        const k = i + j;
        if (k >= 0 && k < n) { s += logAmp[k]; c++; }
      }
      avg[i] = s / c;
    }
    for (let i = 0; i < n; i++) {
      const r = Math.exp(logAmp[i] - avg[i]); // 스펙트럼 잔차 → 진폭 치환
      const scale = amp[i] > 1e-8 ? r / amp[i] : 0;
      re[i] *= scale; im[i] *= scale;
    }
    ifft(re, im);
    const sal = new Array(nRaw);
    for (let i = 0; i < nRaw; i++) sal[i] = Math.hypot(re[i], im[i]);

    // 논문식 점수: (sal - 국소평균)/국소평균
    const w = o.scoreWindow;
    const scores = new Array(nRaw);
    for (let i = 0; i < nRaw; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - w); j < i; j++) { s += sal[j]; c++; }
      const local = c ? s / c : sal[i];
      scores[i] = local > 1e-9 ? (sal[i] - local) / local : 0;
    }
    return { saliency: sal, scores, threshold: 3 };
  }

  // ==========================================================
  // 4) PELT 변화점 검출 (Killick et al., JASA 2012)
  //    정규 평균+분산 변화 비용 C(s,t)=len·log(v̂) — 분산부터 변하는
  //    열화(베어링 조도 증가 등)도 잡는다. 페널티 β=2p·ln(n), p=2 (BIC).
  //    공정 데이터는 자기상관이 강하므로 평활/데시메이션 후 사용 권장.
  // ==========================================================
  function pelt(xs, opts) {
    const n = xs.length;
    if (n < 40) return { changepoints: [] };
    const o = Object.assign({ penalty: null, minSeg: 20, penaltyMult: 1.5 }, opts);
    const cum = new Float64Array(n + 1), cum2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      cum[i + 1] = cum[i] + xs[i];
      cum2[i + 1] = cum2[i] + xs[i] * xs[i];
    }
    // BIC: 2·p·ln(n), p=2(평균,분산) — 자기상관 보정으로 배율 적용
    const beta = o.penalty !== null ? o.penalty : o.penaltyMult * 4 * Math.log(n);

    function segCost(s, e) {
      const len = e - s;
      const mu = (cum[e] - cum[s]) / len;
      const v = Math.max(1e-12, (cum2[e] - cum2[s]) / len - mu * mu);
      return len * Math.log(v);
    }

    const F = new Float64Array(n + 1).fill(Infinity);
    F[0] = -beta;
    const last = new Int32Array(n + 1).fill(0);
    let R = [0];
    for (let t = o.minSeg; t <= n; t++) {
      let best = Infinity, bestTau = 0;
      const fc = new Map(); // tau → F[tau]+C(tau,t) (가지치기용)
      for (const tau of R) {
        if (t - tau < o.minSeg) continue;
        const base = F[tau] + segCost(tau, t);
        fc.set(tau, base);
        const c = base + beta;
        if (c < best) { best = c; bestTau = tau; }
      }
      if (!isFinite(best)) continue;
      F[t] = best; last[t] = bestTau;
      // 가지치기: F[tau]+C(tau,t) > F[t] 인 tau는 이후에도 최적일 수 없음
      R = R.filter(tau => {
        const base = fc.get(tau);
        return base === undefined || base <= best;
      });
      if (t + o.minSeg <= n) R.push(t);
    }
    const cps = [];
    let t = n;
    while (t > 0 && last[t] > 0) {
      cps.unshift(last[t]);
      t = last[t];
    }
    return { changepoints: cps, penalty: beta };
  }

  // ==========================================================
  // 4b) ECOD (Li et al., IEEE TKDE 2022) — 무파라미터 다변량 이상탐지
  //     논문 Algorithm 1 완전판: 차원별 좌/우 꼬리 −log ECDF를 세 방식으로 집계 후 최댓값.
  //       O_left  = Σ_j −log F̂_left(x_j)          (좌측 꼬리만)
  //       O_right = Σ_j −log F̂_right(x_j)         (우측 꼬리만)
  //       O_auto  = Σ_j (왜도 γ_j<0 ? 좌 : 우)     (왜도 방향 자동 선택)
  //       O(x)    = max{O_left, O_right, O_auto}
  //     세 집계의 max를 쓰므로 왜도 반대 방향의 꼬리 이상(예: 우왜 분포의 극저값)도 놓치지 않는다.
  //     ECDF는 좌: P(X≤v)=#{≤v}/n, 우: P(X≥v)=#{≥v}/n (동률 정확 처리). O(nd·logn).
  // ==========================================================
  function ecod(X) {
    const n = X.length;
    if (!n) return { scores: [] };
    const p = X[0].length;
    const sumL = new Float64Array(n), sumR = new Float64Array(n), sumA = new Float64Array(n);
    for (let j = 0; j < p; j++) {
      const col = X.map(r => r[j]);
      const sorted = col.slice().sort((a, b) => a - b);
      // 왜도 부호 (O_auto에서 어느 꼬리를 쓸지 결정)
      const mu = col.reduce((a, b) => a + b, 0) / n;
      let m2 = 0, m3 = 0;
      for (const v of col) { const d = v - mu; m2 += d * d; m3 += d * d * d; }
      const skew = m2 > 0 ? (m3 / n) / Math.pow(m2 / n, 1.5) : 0;
      for (let i = 0; i < n; i++) {
        const v = col[i];
        // upper_bound: #{≤ v}
        let lo = 0, hi = n;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
        // lower_bound: #{< v}
        let lo2 = 0, hi2 = n;
        while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (sorted[mid] < v) lo2 = mid + 1; else hi2 = mid; }
        const Fl = Math.max(lo / n, 1 / n);        // P(X≤v)
        const Fr = Math.max((n - lo2) / n, 1 / n); // P(X≥v) — 동률 포함 정확값
        const tailL = -Math.log(Fl), tailR = -Math.log(Fr);
        sumL[i] += tailL; sumR[i] += tailR;
        sumA[i] += skew < 0 ? tailL : tailR;
      }
    }
    const scores = new Array(n);
    for (let i = 0; i < n; i++) scores[i] = Math.max(sumL[i], sumR[i], sumA[i]) / p; // 차원수 정규화
    // channels: 집계 채널별 점수(각 /p). max 점수는 표시용으로는 좋지만, 경험 임계(베이스라인
    // 분위수) 감시에서는 베이스라인 양쪽 극단점 점수까지 끌어올려 임계를 부풀린다 —
    // 추세형 열화의 검출률 붕괴를 막으려면 채널별 임계(각자의 베이스라인 분위수)로 감시해야 한다.
    return {
      scores,
      channels: {
        left: Array.from(sumL, x => x / p),
        right: Array.from(sumR, x => x / p),
        auto: Array.from(sumA, x => x / p),
      },
    };
  }

  // ==========================================================
  // 5) 지수 열화 추세 RUL (Gebraeel 2005 계열의 간이형)
  //    y(t) = φ + θ·exp(β·t) 를 최소자승 적합(φ 그리드 탐색 + 로그 선형화)
  //    → 임계값 도달 시점 역산. Holt(patterns.js)보다 가속 열화에 강함.
  // ==========================================================
  function expDegradationFit(t, y, opts) {
    const n = y.length;
    if (n < 20) return null;
    const t0 = t[0];
    const tx = t.map(v => (v - t0) / 3600000); // 시간 단위
    const yMin = Math.min.apply(null, y), yMax = Math.max.apply(null, y);
    if (!(yMax > yMin)) return null;
    const span = yMax - yMin;

    let best = null;
    // φ(수렴 하한) 그리드 탐색 후 log(y-φ) 선형회귀
    for (let g = 0; g <= 10; g++) {
      const phi = yMin - span * (0.05 + 0.1 * g);
      const ly = [];
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = y[i] - phi;
        if (d <= 0) { ok = false; break; }
        ly.push(Math.log(d));
      }
      if (!ok) continue;
      const r = stats.linreg(tx, ly);
      // SSE 계산
      let sse = 0;
      for (let i = 0; i < n; i++) {
        const pred = phi + Math.exp(r.intercept + r.slope * tx[i]);
        sse += (y[i] - pred) * (y[i] - pred);
      }
      if (!best || sse < best.sse) {
        best = { phi, theta: Math.exp(r.intercept), beta: r.slope, betaSe: r.seSlope, sse, r2: r.r2 };
      }
    }
    if (!best) return null;
    best.predict = h => best.phi + best.theta * Math.exp(best.beta * ((h - t0) / 3600000));
    // 임계 도달 시각(ms): threshold = φ + θ·exp(β·h) → h = ln((thr-φ)/θ)/β
    best.timeToThreshold = thr => {
      const d = (thr - best.phi) / best.theta;
      if (d <= 0 || Math.abs(best.beta) < 1e-9) return null;
      const hHours = Math.log(d) / best.beta;
      const tMs = t0 + hHours * 3600000;
      return (tMs > t[n - 1] && isFinite(tMs)) ? tMs : null;
    };
    // 도달 시각 신뢰구간 — 로그선형 OLS의 β 표준오차 1차 근사(지배항).
    // "며칠 후 도달" 단일값이 주는 과신을 막기 위한 구간 표시용. conf 기본 0.90.
    best.timeToThresholdCI = (thr, conf) => {
      const d = (thr - best.phi) / best.theta;
      if (d <= 0 || best.beta < 1e-9) return null;
      const ln = Math.log(d);
      if (ln <= 0) return null;
      const toMs = b => t0 + (ln / b) * 3600000;
      const tC = toMs(best.beta);
      if (!isFinite(tC) || tC <= t[n - 1]) return null;
      if (best.betaSe === null || best.betaSe === undefined) return { t: tC, early: null, late: null };
      const z = stats.normInv(0.5 + (conf || 0.9) / 2);
      const bHi = best.beta + z * best.betaSe;
      const bLo = best.beta - z * best.betaSe;
      return {
        t: tC,
        early: bHi > 1e-9 ? Math.max(toMs(bHi), t[n - 1]) : null, // 빠른 열화 가정 → 이른 도달
        late: bLo > 1e-9 ? toMs(bLo) : null,                      // β 하한 ≤ 0 → 도달 상한 없음
      };
    };
    return best;
  }

  return { matrixProfile, isolationForest, spectralResidual, pelt, ecod, expDegradationFit, fft };
});
