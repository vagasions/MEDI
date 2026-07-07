/* MEDI 예지보전 — 설비별 진단 로직
 * 태그 시계열 → 패턴 검출(추세/변동성/스파이크/이탈) → 파생지표(효율, U값, 서지마진)
 * → ISO 14224 고장모드 후보 매칭 → 다변량(PCA T²/SPE) 종합.
 * 브라우저(window.MEDI.equip)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'), require('./multivariate.js'), require('../ontology.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.equip = factory(root.MEDI.stats, root.MEDI.mv, root.MEDI.ontology);
  }
})(typeof self !== 'undefined' ? self : this, function (stats, mv, ontology) {
  'use strict';

  const clamp01 = x => Math.max(0, Math.min(1, x));

  // ---------- 시계열 정렬 ----------
  // 서로 다른 타임스탬프의 시리즈들을 공통 그리드로 선형보간 정렬
  function alignSeries(seriesMap, tagIds) {
    const ids = tagIds || Object.keys(seriesMap);
    const valid = ids.filter(id => seriesMap[id] && seriesMap[id].t.length > 1);
    if (!valid.length) return { t: [], cols: {}, ids: [] };
    let t0 = -Infinity, t1 = Infinity, dts = [];
    for (const id of valid) {
      const s = seriesMap[id];
      t0 = Math.max(t0, s.t[0]);
      t1 = Math.min(t1, s.t[s.t.length - 1]);
      dts.push((s.t[s.t.length - 1] - s.t[0]) / Math.max(1, s.t.length - 1));
    }
    if (t1 <= t0) return { t: [], cols: {}, ids: valid };
    const dt = stats.median(dts);
    const n = Math.min(50000, Math.floor((t1 - t0) / dt) + 1);
    const grid = new Array(n);
    for (let i = 0; i < n; i++) grid[i] = t0 + i * dt;
    const cols = {};
    for (const id of valid) cols[id] = interp(seriesMap[id].t, seriesMap[id].v, grid);
    return { t: grid, cols, ids: valid, dt };
  }

  function interp(ts, vs, grid) {
    const out = new Array(grid.length);
    let j = 0;
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i];
      while (j < ts.length - 2 && ts[j + 1] < g) j++;
      const t0 = ts[j], t1 = ts[j + 1], v0 = vs[j], v1 = vs[j + 1];
      out[i] = t1 > t0 ? v0 + (v1 - v0) * ((g - t0) / (t1 - t0)) : v0;
    }
    return out;
  }

  // ---------- 단일 시리즈 패턴 검출 ----------
  // baseline 구간 통계 대비 recent 구간의 up/down/variance/spike/high/low 강도(0~1)
  function detectPatterns(t, v, baseIdx, recentIdx, limits) {
    const base = v.slice(baseIdx[0], baseIdx[1]);
    const rec = v.slice(recentIdx[0], recentIdx[1]);
    const rt = t.slice(recentIdx[0], recentIdx[1]);
    if (base.length < 10 || rec.length < 5) return null;

    const bMu = stats.mean(base);
    const bSd = Math.max(stats.robustStd(base), stats.std(base) * 0.5, 1e-9);
    const rMu = stats.mean(rec);
    const rSd = stats.std(rec);

    // 평균 이동 (베이스라인 σ 단위) — 3σ 이동이면 강도 1
    const zShift = (rMu - bMu) / bSd;
    // 변동성 비율 — 2.5배면 강도 1
    const vr = rSd / Math.max(bSd, 1e-9);
    // 스파이크: 4σ 초과 표본 비율 — 5%면 강도 1
    let spikes = 0;
    for (const x of rec) if (Math.abs(x - bMu) > 4 * bSd) spikes++;
    const spikeFrac = spikes / rec.length;
    // 최근 구간 추세 (시간당, σ 단위)
    const tr = stats.trendPerHour(rt, rec);
    const slopeSig = tr.slopePerHour / bSd;

    // EWMA/CUSUM 위반율 (베이스라인 파라미터로 최근 구간 감시)
    const ew = stats.ewmaChart(rec, { mu: bMu, sigma: bSd, lambda: 0.2, L: 3 });
    const ewFrac = ew.violations.filter(x => x !== 0).length / rec.length;
    const cu = stats.cusumChart(rec, { mu: bMu, sigma: bSd, k: 0.5, h: 5 });
    const cuViol = cu.violations[cu.violations.length - 1] || 0;

    const out = {
      up: clamp01(Math.max(zShift / 3, slopeSig * 8)),
      down: clamp01(Math.max(-zShift / 3, -slopeSig * 8)),
      variance: clamp01((vr - 1.2) / 1.3),
      spike: clamp01(spikeFrac / 0.05),
      high: 0, low: 0,
      zShift, varRatio: vr, spikeFrac,
      slopePerHour: tr.slopePerHour, trendR2: tr.r2,
      ewmaViolFrac: ewFrac, cusumViol: cuViol,
      baseMean: bMu, baseStd: bSd, recentMean: rMu, recentStd: rSd,
      lastValue: rec[rec.length - 1],
    };
    if (limits) {
      if (limits.hi !== undefined && limits.hi !== null) {
        const span = Math.max(limits.hi - (limits.lo || 0), 1e-9);
        out.high = clamp01((rMu - limits.hi) / (0.1 * span) + (rMu > limits.hi ? 0.6 : 0));
      }
      if (limits.lo !== undefined && limits.lo !== null) {
        const span = Math.max((limits.hi || 0) - limits.lo, 1e-9);
        out.low = clamp01((limits.lo - rMu) / (0.1 * span) + (rMu < limits.lo ? 0.6 : 0));
      }
    }
    return out;
  }

  // ---------- 파생 지표 ----------
  // 설비 클래스별 물리 기반 파생 시리즈 (열교환기 U값, 펌프 효율, 서지마진 등)
  function derivedSeries(asset, aligned, roleCol) {
    const out = {}; // role → {v: [], desc, unit, aboveIsBad}
    const col = r => (roleCol[r] !== undefined ? aligned.cols[roleCol[r]] : null);
    const n = aligned.t.length;

    if (asset.class === 'HE') {
      const hi = col('hot_in'), ho = col('hot_out'), ci = col('cold_in'), co = col('cold_out'), hf = col('hot_flow');
      if (hi && ho && ci && co) {
        const u = new Array(n), ap = new Array(n);
        for (let i = 0; i < n; i++) {
          const dT1 = hi[i] - co[i], dT2 = ho[i] - ci[i];
          let lmtd;
          if (dT1 > 0 && dT2 > 0 && Math.abs(dT1 - dT2) > 1e-6) lmtd = (dT1 - dT2) / Math.log(dT1 / dT2);
          else lmtd = Math.max((dT1 + dT2) / 2, 0.1);
          const q = (hf ? hf[i] : 1) * Math.max(hi[i] - ho[i], 0); // 열부하 ∝ 유량×온도강하
          u[i] = q / Math.max(lmtd, 0.1); // U·A proxy
          ap[i] = ho[i] - ci[i];          // 접근온도차
        }
        out.u_proxy = { v: u, desc: '총괄전열계수 프록시 (Q/LMTD)', unit: '-', aboveIsBad: false };
        out.approach = { v: ap, desc: '접근온도차 (Hot out − Cold in)', unit: '°C', aboveIsBad: true };
      }
    }

    if (asset.class === 'CP') {
      const f = col('flow'), pd = col('discharge_pressure'), ps = col('suction_pressure'), cur = col('motor_current');
      if (f && pd && ps && cur) {
        const eff = new Array(n);
        for (let i = 0; i < n; i++) {
          // 수력동력 ∝ Q·ΔP, 전기입력 ∝ I → 효율 프록시
          eff[i] = (f[i] * Math.max(pd[i] - ps[i], 0.1)) / Math.max(cur[i], 1);
        }
        out.eff_proxy = { v: eff, desc: '펌프 효율 프록시 (Q·ΔP/I)', unit: '-', aboveIsBad: false };
      }
    }

    if (asset.class === 'CO') {
      const f = col('suction_flow'), pd = col('discharge_pressure'), ps = col('suction_pressure'), td = col('discharge_temp');
      if (f && asset.design && asset.design.surgeFlow) {
        const sm = new Array(n);
        for (let i = 0; i < n; i++) sm[i] = (f[i] - asset.design.surgeFlow) / asset.design.surgeFlow * 100;
        out.surge_margin = { v: sm, desc: '서지 마진 (유량 기준)', unit: '%', aboveIsBad: false };
      }
      if (pd && ps && td) {
        const tr = new Array(n);
        for (let i = 0; i < n; i++) {
          const ratio = Math.max(pd[i], 0.1) / Math.max(ps[i], 0.05);
          tr[i] = td[i] / Math.max(Math.log(ratio + 1), 0.2); // 압축비 보정 토출온도
        }
        out.temp_ratio = { v: tr, desc: '압축비 보정 토출온도 (효율 저하 지표)', unit: '-', aboveIsBad: true };
      }
    }
    return out;
  }

  // ---------- 자산 종합 분석 ----------
  // seriesMap: {tagId: {t:[ms], v:[]}}, opts: {baseFrac, recentHours}
  function analyzeAsset(asset, seriesMap, opts) {
    const o = Object.assign({ baseFrac: 0.4, recentHours: 24, pcaVar: 0.9, alpha: 0.99 }, opts);
    const tagIds = (asset.tags || []).map(t => t.id).filter(id => seriesMap[id]);
    const aligned = alignSeries(seriesMap, tagIds);
    if (aligned.t.length < 30) {
      return { assetId: asset.id, ok: false, reason: '데이터 부족 (정렬 후 30점 미만)' };
    }
    const n = aligned.t.length;
    const baseEnd = Math.max(20, Math.floor(n * o.baseFrac));
    const recentSpanMs = o.recentHours * 3600000;
    let recentStart = n - 1;
    while (recentStart > 0 && aligned.t[n - 1] - aligned.t[recentStart - 1] <= recentSpanMs) recentStart--;
    recentStart = Math.min(recentStart, n - 5);
    const baseIdx = [0, baseEnd], recentIdx = [Math.max(recentStart, baseEnd), n];
    if (recentIdx[1] - recentIdx[0] < 5) recentIdx[0] = Math.max(0, n - 5);

    // 태그 role 매핑 (role → 대표 tagId)
    const roleCol = {};
    for (const t of asset.tags || []) {
      if (aligned.cols[t.id] && roleCol[t.role] === undefined) roleCol[t.role] = t.id;
    }

    // 1) 태그별 패턴 검출
    const tagDiag = {};
    const observed = {}; // role → 패턴 강도
    for (const t of asset.tags || []) {
      const v = aligned.cols[t.id];
      if (!v) continue;
      const d = detectPatterns(aligned.t, v, baseIdx, recentIdx, { lo: t.lo, hi: t.hi });
      if (!d) continue;
      tagDiag[t.id] = Object.assign({ role: t.role, desc: t.desc, unit: t.unit }, d);
      // 같은 role 태그가 여럿이면(DE/NDE 등) 최대 강도 채택
      if (!observed[t.role]) observed[t.role] = { up: 0, down: 0, variance: 0, spike: 0, high: 0, low: 0 };
      for (const k of ['up', 'down', 'variance', 'spike', 'high', 'low']) {
        observed[t.role][k] = Math.max(observed[t.role][k], d[k]);
      }
    }

    // 2) 파생지표 패턴 검출
    const derived = derivedSeries(asset, aligned, roleCol);
    const derivedDiag = {};
    for (const role of Object.keys(derived)) {
      const d = detectPatterns(aligned.t, derived[role].v, baseIdx, recentIdx, null);
      if (!d) continue;
      derivedDiag[role] = Object.assign({ desc: derived[role].desc, aboveIsBad: derived[role].aboveIsBad }, d);
      if (!observed[role]) observed[role] = { up: 0, down: 0, variance: 0, spike: 0, high: 0, low: 0 };
      for (const k of ['up', 'down', 'variance', 'spike']) {
        observed[role][k] = Math.max(observed[role][k], d[k]);
      }
    }

    // 3) 고장모드 후보 매칭
    const candidates = ontology.matchFailureModes(asset.class, observed);

    // 4) 다변량 감시 (PCA T²/SPE + Mahalanobis)
    let mvResult = null;
    if (aligned.ids.length >= 3 && baseEnd >= aligned.ids.length * 5) {
      try {
        const X = aligned.t.map((_, i) => aligned.ids.map(id => aligned.cols[id][i]));
        const Xtrain = X.slice(0, baseEnd);
        const pca = mv.pcaFit(Xtrain, { varExplained: o.pcaVar, alpha: o.alpha });
        const applied = mv.pcaApply(pca, X);
        const mah = mv.mahalanobisFit(Xtrain);
        const dists = mv.mahalanobisApply(mah, X);
        // 최근 구간 위반율
        const recT2 = applied.t2.slice(recentIdx[0]);
        const recSPE = applied.spe.slice(recentIdx[0]);
        const t2Frac = recT2.filter(x => x > applied.t2Limit).length / Math.max(1, recT2.length);
        const speFrac = recSPE.filter(x => x > applied.speLimit).length / Math.max(1, recSPE.length);
        const lastContrib = applied.contrib[applied.contrib.length - 1];
        mvResult = {
          ids: aligned.ids, t: aligned.t,
          t2: applied.t2, spe: applied.spe,
          t2Limit: applied.t2Limit, speLimit: applied.speLimit,
          t2ViolFrac: t2Frac, speViolFrac: speFrac,
          mahalanobis: dists, mahWarn: mah.dWarn, mahAlarm: mah.dAlarm,
          topContributors: mv.topContributors(lastContrib, aligned.ids, 4),
          pcaK: pca.k, pcaVarRatio: pca.varRatio.slice(0, pca.k),
        };
      } catch (e) { mvResult = null; }
    }

    return {
      assetId: asset.id, ok: true,
      aligned: { t: aligned.t, n, baseIdx, recentIdx },
      tagDiag, derived, derivedDiag, observed,
      candidates, mv: mvResult,
    };
  }

  return { alignSeries, interp, detectPatterns, derivedSeries, analyzeAsset };
});
