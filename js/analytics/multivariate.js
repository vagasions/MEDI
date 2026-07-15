/* MEDI 예지보전 — 다변량 통계 엔진
 * 상관행렬, PCA(Jacobi 고유분해), Hotelling T², SPE(Q), Mahalanobis 거리.
 * 여러 신호를 "복합적으로" 봐서 단일 임계값으로는 안 잡히는 이상을 검출한다.
 * 의존성 없음. 브라우저(window.MEDI.mv)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.mv = factory(root.MEDI.stats);
  }
})(typeof self !== 'undefined' ? self : this, function (stats) {
  'use strict';

  // ---------- 행렬 유틸 (행 우선 2차원 배열) ----------
  function zeros(r, c) {
    const m = new Array(r);
    for (let i = 0; i < r; i++) m[i] = new Array(c).fill(0);
    return m;
  }

  function matMul(A, B) {
    const r = A.length, k = B.length, c = B[0].length;
    const out = zeros(r, c);
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < k; j++) {
        const a = A[i][j];
        if (a === 0) continue;
        for (let l = 0; l < c; l++) out[i][l] += a * B[j][l];
      }
    }
    return out;
  }

  function transpose(A) {
    const r = A.length, c = A[0].length;
    const out = zeros(c, r);
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j][i] = A[i][j];
    return out;
  }

  // 가우스-조던 역행렬 (부분 피벗팅). 특이행렬에는 ridge를 더해 재시도.
  function inverse(A, ridge) {
    const n = A.length;
    const M = A.map((row, i) => {
      const r = row.slice();
      if (ridge) r[i] += ridge;
      return r.concat(new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0)));
    });
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) {
        if (!ridge) return inverse(A, 1e-6 * traceMean(A));
        return null;
      }
      if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
      const d = M[col][col];
      for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
      }
    }
    return M.map(row => row.slice(n));
  }

  function traceMean(A) {
    let s = 0;
    for (let i = 0; i < A.length; i++) s += Math.abs(A[i][i]);
    return (s / A.length) || 1;
  }

  // ---------- 공분산 / 상관 ----------
  // X: n×p (행=샘플, 열=변수)
  function meanStdCols(X) {
    const n = X.length, p = X[0].length;
    const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j];
      mu[j] = s / n;
      let q = 0;
      for (let i = 0; i < n; i++) { const d = X[i][j] - mu[j]; q += d * d; }
      sd[j] = n > 1 ? Math.sqrt(q / (n - 1)) : 0;
    }
    return { mu, sd };
  }

  function standardize(X, mu, sd) {
    return X.map(row => row.map((v, j) => (v - mu[j]) / (sd[j] || 1)));
  }

  function covMatrix(X) {
    const n = X.length, p = X[0].length;
    const { mu } = meanStdCols(X);
    const C = zeros(p, p);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < p; a++) {
        const da = X[i][a] - mu[a];
        for (let b = a; b < p; b++) C[a][b] += da * (X[i][b] - mu[b]);
      }
    }
    const denom = Math.max(1, n - 1);
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) {
      C[a][b] /= denom; C[b][a] = C[a][b];
    }
    return C;
  }

  function corrMatrix(X) {
    const C = covMatrix(X);
    const p = C.length;
    const R = zeros(p, p);
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) {
      const d = Math.sqrt(C[a][a] * C[b][b]);
      R[a][b] = d > 0 ? C[a][b] / d : (a === b ? 1 : 0);
    }
    return R;
  }

  // ---------- 대칭행렬 고유분해 (Jacobi 회전) ----------
  // p ≤ ~40 규모(태그 수)에는 충분히 빠르고 수치적으로 안정적
  function jacobiEigen(Ain, maxSweeps) {
    const n = Ain.length;
    const A = Ain.map(r => r.slice());
    let V = zeros(n, n);
    for (let i = 0; i < n; i++) V[i][i] = 1;
    const sweeps = maxSweeps || 60;
    for (let s = 0; s < sweeps; s++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off < 1e-18) break;
      for (let pI = 0; pI < n - 1; pI++) {
        for (let q = pI + 1; q < n; q++) {
          if (Math.abs(A[pI][q]) < 1e-15) continue;
          const theta = (A[q][q] - A[pI][pI]) / (2 * A[pI][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
          for (let k = 0; k < n; k++) {
            const akp = A[k][pI], akq = A[k][q];
            A[k][pI] = c * akp - sn * akq;
            A[k][q] = sn * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[pI][k], aqk = A[q][k];
            A[pI][k] = c * apk - sn * aqk;
            A[q][k] = sn * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][pI], vkq = V[k][q];
            V[k][pI] = c * vkp - sn * vkq;
            V[k][q] = sn * vkp + c * vkq;
          }
        }
      }
    }
    // 고유값 내림차순 정렬
    const pairs = [];
    for (let i = 0; i < n; i++) pairs.push({ val: A[i][i], vec: V.map(r => r[i]) });
    pairs.sort((a, b) => b.val - a.val);
    return {
      values: pairs.map(p2 => Math.max(0, p2.val)),
      vectors: pairs.map(p2 => p2.vec), // vectors[i] = i번째 고유벡터 (길이 p)
    };
  }

  // ---------- PCA 모델 (정상 구간 학습) ----------
  // Xtrain: n×p 정상운전 데이터. varExplained만큼 주성분 유지(기본 0.9).
  function pcaFit(Xtrain, opts) {
    const o = Object.assign({ varExplained: 0.9, minK: 1, maxK: null, alpha: 0.99 }, opts);
    const n = Xtrain.length, p = Xtrain[0].length;
    const { mu, sd } = meanStdCols(Xtrain);
    const Z = standardize(Xtrain, mu, sd);
    const R = covMatrix(Z); // 표준화 데이터의 공분산 = 상관행렬
    const eig = jacobiEigen(R);
    const total = eig.values.reduce((a, b) => a + b, 0) || 1;
    let k = o.minK, cum = 0;
    for (let i = 0; i < eig.values.length; i++) {
      cum += eig.values[i];
      if (cum / total >= o.varExplained) { k = Math.max(o.minK, i + 1); break; }
      k = i + 1;
    }
    if (o.maxK) k = Math.min(k, o.maxK);
    k = Math.min(k, Math.max(1, p - 1)); // SPE가 정의되도록 최소 1개 성분은 버린다

    const P = eig.vectors.slice(0, k);        // k×p 로딩
    const lam = eig.values.slice(0, k);       // 유지 고유값
    const lamRes = eig.values.slice(k);       // 잔차 고유값 (SPE 한계용)

    // 학습 데이터의 T²/SPE 분포 → 경험적 관리한계 (비정규 데이터에 강건)
    const t2s = [], spes = [];
    for (let i = 0; i < n; i++) {
      const r = scoreRow(Z[i], P, lam);
      t2s.push(r.t2); spes.push(r.spe);
    }
    const t2LimEmp = stats.quantile(t2s, o.alpha);
    const speLimEmp = stats.quantile(spes, o.alpha);

    // 이론 한계 — T²: Phase II(새 관측) F-분포 한계 (Tracy·Young·Mason 1992 / Jackson 1991)
    //   T²_α = k(n−1)(n+1)/(n(n−k)) · F_α(k, n−k)
    //   χ² 근사는 n→∞ 극한이라 소표본(짧은 베이스라인)에서 한계를 과소평가해 오탐을 만든다.
    const t2LimChi = stats.chi2Inv(o.alpha, k);
    const t2LimF = n > k + 2
      ? (k * (n - 1) * (n + 1)) / (n * (n - k)) * stats.fInv(o.alpha, k, n - k)
      : null;
    let speLimJM = null;
    if (lamRes.length) {
      const th1 = lamRes.reduce((a, b) => a + b, 0);
      const th2 = lamRes.reduce((a, b) => a + b * b, 0);
      const th3 = lamRes.reduce((a, b) => a + b * b * b, 0);
      if (th1 > 0 && th2 > 0) {
        const h0 = 1 - (2 * th1 * th3) / (3 * th2 * th2);
        const ca = stats.normInv(o.alpha);
        const inner = (ca * Math.sqrt(2 * th2 * h0 * h0)) / th1 + 1 + (th2 * h0 * (h0 - 1)) / (th1 * th1);
        if (inner > 0) speLimJM = th1 * Math.pow(inner, 1 / h0);
      }
    }

    return {
      mu, sd, P, lam, k, p, n,
      eigenvalues: eig.values,
      varRatio: eig.values.map(v => v / total),
      t2Limit: Math.max(t2LimEmp, t2LimF !== null ? t2LimF : t2LimChi),
      t2LimitF: t2LimF, t2LimitChi2: t2LimChi,
      speLimit: speLimJM !== null ? Math.max(speLimEmp, speLimJM) : speLimEmp,
      alpha: o.alpha,
      trainT2: t2s, trainSPE: spes,
    };
  }

  function scoreRow(zrow, P, lam) {
    const k = P.length, p = zrow.length;
    const t = new Array(k).fill(0);
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < p; j++) t[i] += P[i][j] * zrow[j];
    }
    let t2 = 0;
    for (let i = 0; i < k; i++) t2 += (t[i] * t[i]) / (lam[i] || 1e-12);
    // 재구성 잔차
    const recon = new Array(p).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < p; j++) recon[j] += t[i] * P[i][j];
    let spe = 0;
    const resid = new Array(p);
    for (let j = 0; j < p; j++) { const e = zrow[j] - recon[j]; resid[j] = e; spe += e * e; }
    return { t2, spe, scores: t, resid };
  }

  // 새 데이터 X(n×p)에 PCA 모델 적용 → T², SPE, 변수별 기여도
  function pcaApply(model, X) {
    const Z = standardize(X, model.mu, model.sd);
    const n = Z.length;
    const t2 = new Array(n), spe = new Array(n);
    const contrib = new Array(n); // SPE 변수별 기여 (진단용)
    for (let i = 0; i < n; i++) {
      const r = scoreRow(Z[i], model.P, model.lam);
      t2[i] = r.t2; spe[i] = r.spe;
      contrib[i] = r.resid.map(e => e * e);
    }
    return { t2, spe, contrib, t2Limit: model.t2Limit, speLimit: model.speLimit };
  }

  // 특정 시점의 변수별 기여도 상위 항목 (원인 태그 지목)
  function topContributors(contribRow, names, topN) {
    const tot = contribRow.reduce((a, b) => a + b, 0) || 1;
    return contribRow
      .map((c, j) => ({ name: names[j], share: c / tot }))
      .sort((a, b) => b.share - a.share)
      .slice(0, topN || 3);
  }

  // ---------- Mahalanobis 거리 건강지수 ----------
  function mahalanobisFit(Xtrain) {
    const { mu } = meanStdCols(Xtrain);
    const C = covMatrix(Xtrain);
    // ridge 정칙화 — 태그 수 대비 샘플이 적거나 상관 높을 때 역행렬 안정화
    const Cinv = inverse(C, 1e-6 * traceMean(C));
    const p = mu.length;
    const n = Xtrain.length;
    // 학습 데이터 자체의 거리 분포로 기준선 잡기
    const ds = Xtrain.map(row => mahalanobisD(row, mu, Cinv));
    // 이론 알람한계: D² = T² → Phase II F-한계 (소표본 보정). n이 작으면 χ² 극한 사용.
    const t2Lim = n > p + 2
      ? (p * (n - 1) * (n + 1)) / (n * (n - p)) * stats.fInv(0.999, p, n - p)
      : stats.chi2Inv(0.999, p);
    return {
      mu, Cinv, p, n,
      d0: stats.median(ds),
      dWarn: stats.quantile(ds, 0.99),
      dAlarm: Math.max(stats.quantile(ds, 0.999), Math.sqrt(t2Lim)),
    };
  }

  function mahalanobisD(row, mu, Cinv) {
    if (!Cinv) return NaN;
    const p = mu.length;
    const d = new Array(p);
    for (let j = 0; j < p; j++) d[j] = row[j] - mu[j];
    let s = 0;
    for (let a = 0; a < p; a++) {
      let t = 0;
      for (let b = 0; b < p; b++) t += Cinv[a][b] * d[b];
      s += d[a] * t;
    }
    return Math.sqrt(Math.max(0, s));
  }

  function mahalanobisApply(model, X) {
    return X.map(row => mahalanobisD(row, model.mu, model.Cinv));
  }

  
  // 베이스라인 vs 최근 상관행렬 비교 — "항상 같이 움직이던 관계"가 깨진 쌍을 찾는다
  // 유의성: Fisher z-변환 (Fisher 1921) — z=atanh(ρ), Var(z)≈1/(n−3).
  //   짧은 최근창의 표본 요동을 "관계 붕괴"로 오인하지 않도록 |zStat|>1.96 만 sig 표시.
  // 반환: [{i, j, a: id1, b2: id2, base, recent, delta, zStat, sig}] |delta| 내림차순
  function corrShiftPairs(Xbase, Xrecent, ids, topK) {
    const Rb = corrMatrix(Xbase);
    const Rr = corrMatrix(Xrecent);
    const nb = Xbase.length, nr = Xrecent.length;
    const se = Math.sqrt(1 / Math.max(nb - 3, 1) + 1 / Math.max(nr - 3, 1));
    const zOf = r => Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const b = Rb[i][j], r = Rr[i][j];
        if (!isFinite(b) || !isFinite(r)) continue;
        const zStat = (zOf(r) - zOf(b)) / se;
        out.push({ i, j, a: ids[i], b2: ids[j], base: b, recent: r, delta: r - b, zStat, sig: Math.abs(zStat) > 1.96 });
      }
    }
    out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return out.slice(0, topK || 5);
  }

return {
    corrShiftPairs,
    matMul, transpose, inverse, zeros,
    meanStdCols, standardize, covMatrix, corrMatrix,
    jacobiEigen, pcaFit, pcaApply, topContributors,
    mahalanobisFit, mahalanobisApply, mahalanobisD,
  };
});
