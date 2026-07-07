/* MEDI 예지보전 — 설비별 진단 로직
 * 태그 시계열 → 패턴 검출(추세/변동성/스파이크/이탈) → 파생지표(효율, U값, 서지마진)
 * → ISO 14224 고장모드 후보 매칭 → 다변량(PCA T²/SPE) 종합.
 * 브라우저(window.MEDI.equip)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'), require('./multivariate.js'), require('../ontology.js'), require('./advanced.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.equip = factory(root.MEDI.stats, root.MEDI.mv, root.MEDI.ontology, root.MEDI.adv);
  }
})(typeof self !== 'undefined' ? self : this, function (stats, mv, ontology, adv) {
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

    // 추세항은 적합도(R²)로 감쇠 — 노이즈성 기울기의 오탐 방지
    const slopeTerm = slopeSig * 8 * Math.min(1, tr.r2 * 2);
    const out = {
      up: clamp01(Math.max(zShift / 3, slopeTerm)),
      down: clamp01(Math.max(-zShift / 3, -slopeTerm)),
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

  // 베이스라인 구간에서 y~x 선형회귀 적합 후 전체 잔차 시리즈 (부하 보정 잔차 지표용)
  function residualVs(y, x, baseIdx) {
    const b0 = baseIdx ? baseIdx[0] : 0;
    const b1 = baseIdx ? baseIdx[1] : Math.floor(y.length * 0.4);
    const fit = stats.linreg(x.slice(b0, b1), y.slice(b0, b1));
    return y.map((v, i) => v - (fit.slope * x[i] + fit.intercept));
  }

  // ---------- 파생 지표 ----------
  // 설비 클래스별 물리 기반 파생 시리즈 (열교환기 U값, 펌프 효율, 서지마진 등)
  function derivedSeries(asset, aligned, roleCol, baseIdx) {
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

    if (asset.class === 'RC') {
      // 단열(등엔트로피) 토출온도 잔차: Td − Ts,abs·r^((k−1)/k) — 밸브 누설 지표
      const ps = col('suction_pressure'), pd = col('discharge_pressure');
      const ts = col('suction_temp'), td = col('discharge_temp');
      if (ps && pd && ts && td) {
        const k = (asset.design && asset.design.k) || 1.25;
        const ex = (k - 1) / k;
        const resid = new Array(n);
        for (let i = 0; i < n; i++) {
          const r = (pd[i] + 1.033) / Math.max(ps[i] + 1.033, 0.2);
          const tdModel = (ts[i] + 273.15) * Math.pow(Math.max(r, 1), ex) - 273.15;
          resid[i] = td[i] - tdModel;
        }
        out.adiabatic_resid = { v: resid, desc: '단열 토출온도 잔차 (밸브 누설 지표)', unit: '°C', aboveIsBad: true };
      }
    }

    if (asset.class === 'VF') {
      const hs = col('heatsink_temp'), oi = col('output_current'), of = col('output_freq');
      if (hs && oi) {
        const x = oi.map(v => v * v); // 손실 ≈ 전도(∝I²) 지배 간이 모델
        out.hs_residual = { v: residualVs(hs, x, baseIdx), desc: '부하 보정 방열판 온도 잔차 (냉각 열화)', unit: '°C', aboveIsBad: true };
      }
      if (oi && of) {
        const x = of.map(v => v * v); // 원심 부하: 토크 ∝ f²
        out.if_residual = { v: residualVs(oi, x, baseIdx), desc: '주파수-전류 잔차 (기계측 부하 증가)', unit: 'A', aboveIsBad: true };
      }
    }

    if (asset.class === 'EM') {
      const wt = col('winding_temp'), mi = col('motor_current');
      if (wt && mi) {
        const x = mi.map(v => v * v); // 동손 ∝ I² — 부하로 설명되는 온도를 제거
        out.wt_residual = { v: residualVs(wt, x, baseIdx), desc: '부하 보정 권선온도 잔차 (냉각/절연 열화)', unit: '°C', aboveIsBad: true };
      }
    }

    if (asset.class === 'TR') {
      const to = col('top_oil_temp'), ambT = col('ambient_temp'), li = col('load_current'), lv = col('oil_level');
      if (to && ambT && li) {
        const rise = to.map((v, i) => v - ambT[i]);
        const x = li.map(v => v * v); // IEEE C57.91: 유온 상승 ≈ K² 지배
        out.cool_residual = { v: residualVs(rise, x, baseIdx), desc: '부하 보정 유온상승 잔차 (냉각 성능)', unit: '°C', aboveIsBad: true };
      }
      if (lv && to) {
        out.oil_level_c = { v: residualVs(lv, to, baseIdx), desc: '유온 보정 유위 (누유 지표)', unit: '%', aboveIsBad: false };
      }
    }

    if (asset.class === 'CV') {
      const op = col('controller_output'), zt = col('valve_position'), pv = col('flow_pv');
      if (pv) {
        // 루프 진동 지표: PV 증분의 이동 표준편차 (리미트사이클의 슬립 점프 검출)
        const diffs = pv.map((v, i) => (i ? v - pv[i - 1] : 0));
        out.loop_osc = { v: stats.rollingMeanStd(diffs, 24).std, desc: '루프 진동 지표 (PV 증분 이동σ)', unit: '', aboveIsBad: true };
      }
      if (op && zt) {
        const gap = op.map((v, i) => Math.abs(v - zt[i]));
        out.pos_gap = { v: gap, desc: 'OP-실개도 편차 (액추에이터 이상)', unit: '%', aboveIsBad: true };
      }
      if (pv && zt) {
        out.flow_op_resid = { v: residualVs(pv, zt, baseIdx), desc: '개도-유량 잔차 (트림 마모↑/막힘↓)', unit: '', aboveIsBad: null };
      }
    }

    if (asset.class === 'DC') {
      const dpT = col('dp_top'), feed = col('feed_flow'), tray = col('tray_temp'), top = col('top_temp');
      if (dpT && feed) {
        const fRef = (asset.design && asset.design.designFeed) || stats.mean(feed.slice(0, Math.floor(n * 0.4)));
        const v = dpT.map((d, i) => d / Math.max(Math.pow(feed[i] / fRef, 2), 0.15));
        out.dp_norm = { v, desc: '부하 정규화 차압 (내부 오염 지표)', unit: 'kPa', aboveIsBad: true };
      }
      if (tray && top) {
        out.profile_dt = { v: tray.map((v, i) => v - top[i]), desc: '온도 프로파일 구배 (붕괴=플러딩)', unit: '°C', aboveIsBad: false };
      }
    }

    if (asset.class === 'FH') {
      const tmt = col('tmt'), cot = col('cot');
      if (tmt && cot) {
        out.tmt_cot_gap = { v: tmt.map((v, i) => v - cot[i]), desc: 'TMT-COT 간극 (코킹 지표)', unit: '°C', aboveIsBad: true };
      }
    }

    if (asset.class === 'CT') {
      const hot = col('hot_water'), cold = col('cold_water'), ambT = col('ambient_temp');
      if (cold && ambT) {
        // 습구온도 프록시: 외기 − 3.5°C (RH 태그 있으면 정식 습구 계산으로 대체)
        out.approach = { v: cold.map((v, i) => v - (ambT[i] - 3.5)), desc: '접근온도차 (냉수−습구 프록시)', unit: '°C', aboveIsBad: true };
      }
      if (hot && cold) {
        out.range = { v: hot.map((v, i) => v - cold[i]), desc: '레인지 (온수−냉수)', unit: '°C', aboveIsBad: false };
      }
      if (out.approach && out.range) {
        // CTI 유효도 ε = R/(R+A) — 접근온도차 상승 시 하락
        out.effectiveness = {
          v: out.range.v.map((r, i) => r / Math.max(r + out.approach.v[i], 0.5)),
          desc: '냉각탑 유효도 R/(R+A)', unit: '', aboveIsBad: false,
        };
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
    const derived = derivedSeries(asset, aligned, roleCol, baseIdx);
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

    // 3.5) 계기(트랜스미터) 건전성 — 공정 이상과 분리해 계기 자체 고장을 검출
    const instruments = instrumentHealth(asset, aligned, tagDiag, candidates, baseIdx, recentIdx);

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

    // 5) 최신 검증 기법 (advanced.js) — 검출기별 결과 + 온셋/RUL
    let advResult = null;
    if (adv && baseEnd >= 60) {
      try {
        advResult = advancedAnalysis(asset, aligned, tagDiag, baseIdx, recentIdx);
      } catch (e) { advResult = null; }
    }

    return {
      assetId: asset.id, ok: true,
      aligned: { t: aligned.t, n, baseIdx, recentIdx },
      tagDiag, derived, derivedDiag, observed,
      candidates, instruments, mv: mvResult, adv: advResult,
    };
  }

  // ---------- 계기(트랜스미터) 건전성 진단 ----------
  // 히스토리안 신호 시그니처만으로 계기 고장을 검출 — 스마트 트랜스미터 자가진단과 동일 원리:
  //  · 임펄스라인 막힘 = 노이즈(표준편차) 붕괴, 평균 유지 (Rosemount 3051S SPM / Yokogawa EJX ILBD / ABB 266 PILD)
  //  · 출력 고착 = 노이즈 완전 소실(flatline)
  //  · 드리프트 = 한 태그만 단조 이동, 연관 태그·고장모드로 설명 안 됨 (이중센서 Drift Alert의 단독계기 근사)
  function instrumentHealth(asset, aligned, tagDiag, candidates, baseIdx, recentIdx) {
    const issues = [];
    const tags = (asset.tags || []).filter(t => tagDiag[t.id] && aligned.cols[t.id]);
    if (tags.length < 2) return issues;
    const dtH = aligned.t.length > 1 ? (aligned.t[1] - aligned.t[0]) / 3600000 : 1 / 12;
    const diffStd = (xs) => {
      if (xs.length < 3) return 0;
      const dif = [];
      for (let i = 1; i < xs.length; i++) dif.push(xs[i] - xs[i - 1]);
      return stats.std(dif);
    };

    // 상위 고장모드가 설명하는 role — 단독 드리프트의 공정원인 감별에 사용
    const explained = new Set();
    const top = candidates && candidates[0];
    if (top && top.score > 0.3) for (const s of top.mode.symptoms) explained.add(s.role);

    for (const t of tags) {
      const d = tagDiag[t.id];
      const v = aligned.cols[t.id];
      const rec = v.slice(recentIdx[0], recentIdx[1]);
      const meas = (ontology.classifyTag(t.id) || {}).measure;
      const sibs = tags.filter(x => x.id !== t.id).map(x => tagDiag[x.id]);

      // 1) 출력 고착(stuck/frozen): 최근 끝에서 연속 동일값 지속시간
      // 개도(position) 신호는 스틱션/정상 정지 시 수 시간 정지가 물리적으로 정상 — 장시간 기준 적용
      let run = 1;
      for (let i = rec.length - 1; i > 0 && rec[i] === rec[i - 1]; i--) run++;
      const stuckH = run * dtH;
      const stuckLim = meas === 'position' ? 12 : 1.5;
      if (stuckH >= stuckLim) {
        issues.push({
          type: 'stuck', tagId: t.id, role: t.role, desc: t.desc, sev: clamp01(stuckH / 6),
          evidence: `${stuckH.toFixed(1)}시간 연속 동일값 (노이즈 완전 소실) — 현재 ${d.lastValue}${t.unit || ''}`,
        });
        continue;
      }

      // 2) 노이즈 붕괴 — 임펄스라인 막힘 시그니처 (압력/차압/유량/레벨 등 도압배관 계기)
      // 전체 σ에는 부하 변동(저주파)이 섞이므로 1차 차분 σ(고주파 노이즈)의 비율로 판정 — SPM과 동일 관점
      const hfBase = diffStd(v.slice(baseIdx[0], baseIdx[1]));
      const hfRec = diffStd(rec);
      const nr = hfRec / Math.max(hfBase, 1e-9);
      const dpType = meas === 'pressure' || meas === 'dp' || meas === 'flow' || meas === 'level';
      if (dpType && hfBase > 1e-6 && nr < 0.3 && Math.abs(d.zShift) < 2) {
        issues.push({
          type: 'impulse_plug', tagId: t.id, role: t.role, desc: t.desc, sev: clamp01((0.3 - nr) / 0.25),
          evidence: `공정 노이즈(고주파 σ) ${((1 - nr) * 100).toFixed(0)}% 감소 (${hfBase.toFixed(3)}→${hfRec.toFixed(3)}), 평균은 유지 — 막힘/동결의 전형 시그니처`,
        });
        continue;
      }

      // 3) 스파이크 폭주 — 동일 설비 다른 태그는 조용한데 이 태그만 튐 (결선/EMI/접지)
      // zShift 가드: 평균이 크게 이동한 태그는 스파이크 지표가 오염되므로(모든 점이 4σ 초과) 제외
      const sibSpike = sibs.reduce((m, x) => Math.max(m, x.spike), 0);
      if (d.spike > 0.6 && sibSpike < 0.2 && Math.abs(d.zShift) < 2) {
        issues.push({
          type: 'noisy', tagId: t.id, role: t.role, desc: t.desc, sev: d.spike,
          evidence: `4σ 초과 스파이크 ${(d.spikeFrac * 100).toFixed(1)}% — 같은 설비 다른 태그는 정상(최대 ${(sibSpike * 100).toFixed(0)}%)`,
        });
        continue;
      }

      // 4) 단독 드리프트 — 이 태그만 단조 이동 + 연관 태그 정지 + 고장모드로 설명 불가
      const sibShift = sibs.reduce((m, x) => Math.max(m, Math.abs(x.zShift)), 0);
      if (Math.abs(d.zShift) > 2.5 && d.trendR2 > 0.4 && sibShift < 0.8 && !explained.has(t.role)) {
        issues.push({
          type: 'drift', tagId: t.id, role: t.role, desc: t.desc, sev: clamp01(Math.abs(d.zShift) / 6),
          evidence: `단독 ${d.zShift > 0 ? '상승' : '하강'} ${Math.abs(d.zShift).toFixed(1)}σ (R²=${d.trendR2.toFixed(2)}) — 연관 태그 최대 ${sibShift.toFixed(1)}σ, 고장모드 라이브러리로 설명 안 됨`,
        });
      }
    }
    return issues;
  }

  // ---------- 최신 기법 종합 (Isolation Forest·ECOD·PELT·Matrix Profile·RUL) ----------
  function advancedAnalysis(asset, aligned, tagDiag, baseIdx, recentIdx) {
    const n = aligned.t.length;
    const ids = aligned.ids;
    const X = aligned.t.map((_, i) => ids.map(id => aligned.cols[id][i]));
    const recLen = Math.max(1, recentIdx[1] - recentIdx[0]);

    // Isolation Forest — 정상 베이스라인으로 숲 구성, 전체 채점, 99분위 경험 임계
    const iso = adv.isolationForest(X, { seed: 7, trainRange: baseIdx });
    const isoBase = iso.scores.slice(baseIdx[0], baseIdx[1]);
    const isoThr = Math.max(stats.quantile(isoBase, 0.99), 0.55);
    const isoRecent = iso.scores.slice(recentIdx[0], recentIdx[1]);
    const isoFrac = isoRecent.filter(s => s > isoThr).length / recLen;

    // ECOD — 동일 방식의 경험적 보정
    const ec = adv.ecod(X);
    const ecBase = ec.scores.slice(baseIdx[0], baseIdx[1]);
    const ecThr = stats.quantile(ecBase, 0.99);
    const ecRecent = ec.scores.slice(recentIdx[0], recentIdx[1]);
    const ecFrac = ecRecent.filter(s => s > ecThr).length / recLen;

    // PELT 열화 온셋 — Mahalanobis 거리(≈건강 추이)를 평활·데시메이션 후 분할
    let onset = null;
    try {
      const mah = mv.mahalanobisFit(X.slice(baseIdx[0], baseIdx[1]));
      const dist = mv.mahalanobisApply(mah, X);
      const step = Math.max(1, Math.floor(n / 600));
      const ds = [], dt = [];
      for (let i = 0; i < n; i += step) {
        // step 구간 평균으로 평활 (자기상관 완화)
        let s = 0, c = 0;
        for (let j = i; j < Math.min(i + step, n); j++) { s += dist[j]; c++; }
        ds.push(s / c); dt.push(aligned.t[i]);
      }
      const cp = adv.pelt(ds, { minSeg: Math.max(20, Math.floor(ds.length * 0.05)) });
      // 마지막 변화점 중 "이후 평균이 이전보다 유의하게 높은" 것을 온셋으로
      for (let k = cp.changepoints.length - 1; k >= 0; k--) {
        const c = cp.changepoints[k];
        const pre = ds.slice(Math.max(0, c - 60), c);
        const post = ds.slice(c, Math.min(ds.length, c + 60));
        if (pre.length > 5 && post.length > 5) {
          const preMu = stats.mean(pre), postMu = stats.mean(post);
          const preSd = Math.max(stats.std(pre), 1e-9);
          if ((postMu - preMu) / preSd > 2) { onset = { t: dt[c], sigma: (postMu - preMu) / preSd }; break; }
        }
      }
    } catch (e) { onset = null; }

    // Matrix Profile 디스코드 — 이상 강도 최대 태그 1개에 대해 (형태 이상)
    let discord = null;
    try {
      const worst = Object.entries(tagDiag)
        .sort((a, b) => Math.max(b[1].up, b[1].down, b[1].variance, b[1].spike) - Math.max(a[1].up, a[1].down, a[1].variance, a[1].spike))[0];
      if (worst) {
        const col = aligned.cols[worst[0]];
        const step = Math.max(1, Math.floor(n / 1500));
        const ts = [], tt = [];
        for (let i = 0; i < n; i += step) { ts.push(col[i]); tt.push(aligned.t[i]); }
        const spanMs = tt[tt.length - 1] - tt[0];
        const m = Math.max(8, Math.min(120, Math.round(ts.length * (2 * 3600000) / Math.max(spanMs, 1)))); // ≈2시간 창
        const mp = adv.matrixProfile(ts, m, { topK: 2 });
        if (mp && mp.discords.length) {
          discord = {
            tagId: worst[0], m,
            windows: mp.discords.map(d => ({ t: tt[d.idx], dist: +d.dist.toFixed(2) })),
            mp: mp.mp, mpT: tt.slice(0, mp.mp.length),
          };
        }
      }
    } catch (e) { discord = null; }

    // RUL — 상한이 있는 태그 중 상승 추세 최대 태그에 지수 열화 적합
    let rul = null;
    try {
      let bestTag = null, bestShift = 1.2;
      for (const t of asset.tags || []) {
        const d = tagDiag[t.id];
        if (!d || t.hi === undefined || t.hi === null) continue;
        if (d.zShift > bestShift && d.slopePerHour > 0) { bestShift = d.zShift; bestTag = t; }
      }
      if (bestTag && onset) {
        // 온셋 이후 구간만 적합 (연구 권고: 온셋 전 데이터 혼입 금지)
        const col = aligned.cols[bestTag.id];
        const from = aligned.t.findIndex(tv => tv >= onset.t);
        if (from >= 0 && n - from >= 25) {
          const fit = adv.expDegradationFit(aligned.t.slice(from), col.slice(from));
          if (fit && fit.beta > 0 && fit.r2 > 0.2) {
            const hitMs = fit.timeToThreshold(bestTag.hi);
            rul = {
              tagId: bestTag.id, threshold: bestTag.hi, r2: +fit.r2.toFixed(2),
              beta: fit.beta, reachAt: hitMs,
              hoursLeft: hitMs ? (hitMs - aligned.t[n - 1]) / 3600000 : null,
            };
          }
        }
      }
    } catch (e) { rul = null; }

    return {
      ids, t: aligned.t,
      iforest: { scores: iso.scores, threshold: isoThr, recentFrac: isoFrac },
      ecod: { scores: ec.scores, threshold: ecThr, recentFrac: ecFrac },
      onset, discord, rul,
    };
  }

  return { alignSeries, interp, detectPatterns, derivedSeries, analyzeAsset, advancedAnalysis, instrumentHealth };
});
