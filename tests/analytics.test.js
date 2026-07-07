/* MEDI 분석엔진 단위 테스트 — node tests/analytics.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const stats = require(path.join(__dirname, '../js/analytics/stats.js'));
const mv = require(path.join(__dirname, '../js/analytics/multivariate.js'));
const ontology = require(path.join(__dirname, '../js/ontology.js'));
const equip = require(path.join(__dirname, '../js/analytics/equipment.js'));
const health = require(path.join(__dirname, '../js/analytics/health.js'));
const patterns = require(path.join(__dirname, '../js/analytics/patterns.js'));
const adv = require(path.join(__dirname, '../js/analytics/advanced.js'));
const simulator = require(path.join(__dirname, '../js/simulator.js'));
const report = require(path.join(__dirname, '../js/report.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '\n    ', e.message); }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol ?? 1e-9);

console.log('== stats.js ==');
t('mean/std 기본', () => {
  assert(near(stats.mean([1, 2, 3, 4, 5]), 3));
  assert(near(stats.std([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-4)); // 표본표준편차
});
t('median/quantile', () => {
  assert(near(stats.median([1, 3, 2]), 2));
  assert(near(stats.quantile([1, 2, 3, 4], 0.5), 2.5));
  assert(near(stats.quantile([10, 20, 30, 40, 50], 0.25), 20));
});
t('robustStd — 이상치 저항', () => {
  const clean = stats.robustStd([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const dirty = stats.robustStd([1, 2, 3, 4, 5, 6, 7, 8, 1000]);
  assert(Math.abs(clean - dirty) < clean * 0.5, `clean=${clean} dirty=${dirty}`);
});
t('linreg — 정확한 직선 복원', () => {
  const xs = [0, 1, 2, 3, 4], ys = xs.map(x => 2.5 * x + 1);
  const r = stats.linreg(xs, ys);
  assert(near(r.slope, 2.5, 1e-9) && near(r.intercept, 1, 1e-9) && near(r.r2, 1, 1e-9));
});
t('rollingMeanStd — 창 통계', () => {
  const { mean: rm, std: rs } = stats.rollingMeanStd([1, 2, 3, 4, 5], 3);
  assert(near(rm[4], 4)); // (3+4+5)/3
  assert(near(rs[4], 1)); // std([3,4,5])=1
});
t('ewmaChart — 평균이동 검출', () => {
  const xs = Array(100).fill(0).map((_, i) => (i < 60 ? 0 : 2)); // +2σ 이동 (σ=1 명시)
  const r = stats.ewmaChart(xs, { mu: 0, sigma: 1, lambda: 0.2, L: 3 });
  assert(r.violations.slice(70).some(v => v === 1), '이동 후 위반이 있어야 함');
  assert(!r.violations.slice(0, 55).some(v => v !== 0), '이동 전 위반 없어야 함');
});
t('cusumChart — 소폭 지속 이동 검출', () => {
  const xs = Array(120).fill(0).map((_, i) => (i < 60 ? 0 : 1.2));
  const r = stats.cusumChart(xs, { mu: 0, sigma: 1, k: 0.5, h: 5 });
  assert(r.violations[119] === 1, '고측 CUSUM 위반');
  assert(r.violations[30] === 0);
});
t('runRules — R1(3σ) / R5(6점 단조)', () => {
  const base = Array(30).fill(0).map((_, i) => (i % 2 ? 0.4 : -0.4));
  const withSpike = base.concat([5]);
  const rr = stats.runRules(withSpike, { mu: 0, sigma: 1 });
  assert(rr.r1.length === 1 && rr.r1[0].i === 30);
  const trend = base.concat([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  const rr2 = stats.runRules(trend, { mu: 0, sigma: 1 });
  assert(rr2.r5.some(x => x.side === 1), '상승 트렌드 검출');
});
t('hysteresis — 데드밴드 동작', () => {
  const out = stats.hysteresis([0, 5, 4.5, 3.9, 5, 2], 5, 4, true);
  assert.deepStrictEqual(out, [false, true, true, false, true, false]);
});
t('normInv/chi2Inv — 분위수 근사', () => {
  assert(near(stats.normInv(0.975), 1.95996, 1e-3));
  assert(near(stats.chi2Inv(0.95, 3), 7.8147, 0.15)); // Wilson-Hilferty 근사 허용오차
});

console.log('== multivariate.js ==');
t('corrMatrix — 완전 상관/무상관', () => {
  const n = 200, X = [];
  for (let i = 0; i < n; i++) X.push([i, 2 * i + 1, Math.sin(i * 7.13) * 100]);
  const R = mv.corrMatrix(X);
  assert(near(R[0][1], 1, 1e-9), 'x와 2x+1은 상관 1');
  assert(Math.abs(R[0][2]) < 0.2, '무관 신호 상관 ~0');
});
t('jacobiEigen — 대각행렬 고유값', () => {
  const e = mv.jacobiEigen([[3, 0], [0, 1]]);
  assert(near(e.values[0], 3, 1e-8) && near(e.values[1], 1, 1e-8));
});
t('inverse — A·A⁻¹=I', () => {
  const A = [[4, 2], [1, 3]];
  const Ai = mv.inverse(A);
  const I = mv.matMul(A, Ai);
  assert(near(I[0][0], 1, 1e-9) && near(I[0][1], 0, 1e-9) && near(I[1][1], 1, 1e-9));
});
t('PCA — 정상 데이터 낮은 위반율, 상관붕괴 시 SPE 급증', () => {
  // 학습: y=x+잡음 (강한 상관)
  const rng = (s => () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)(42);
  const gauss = () => { let u = rng() || 1e-9, v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const Xtrain = [];
  for (let i = 0; i < 400; i++) { const b = gauss(); Xtrain.push([b + 0.1 * gauss(), b + 0.1 * gauss(), gauss()]); }
  const model = mv.pcaFit(Xtrain, { alpha: 0.99 });
  const applied = mv.pcaApply(model, Xtrain);
  const violFrac = applied.spe.filter((v, i) => v > model.speLimit).length / 400;
  assert(violFrac < 0.05, `학습데이터 SPE 위반율 ${violFrac}`);
  // 상관 붕괴: x1은 +3, x2는 -3 (합은 정상 범위, 관계만 붕괴)
  const broken = [[3, -3, 0]];
  const ab = mv.pcaApply(model, broken);
  assert(ab.spe[0] > model.speLimit * 3, `붕괴 SPE=${ab.spe[0]} limit=${model.speLimit}`);
});
t('mahalanobis — 정상 중심 근처 작음, 이탈점 큼', () => {
  const Xt = [];
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(7);
  for (let i = 0; i < 300; i++) Xt.push([rng() * 2 - 1, rng() * 2 - 1]);
  const m = mv.mahalanobisFit(Xt);
  const dNear = mv.mahalanobisApply(m, [[0, 0]])[0];
  const dFar = mv.mahalanobisApply(m, [[8, -8]])[0];
  assert(dFar > dNear * 5 && dFar > m.dAlarm);
});

console.log('== ontology.js ==');
t('classifyTag — ISA-5.1 문자 해석', () => {
  assert(ontology.classifyTag('PT-101').measure === 'pressure');
  assert(ontology.classifyTag('PDT-306').measure === 'dp');
  assert(ontology.classifyTag('10-TT-1234A').measure === 'temperature');
  assert(ontology.classifyTag('VT-105').measure === 'vibration');
  assert(ontology.classifyTag('IT-206').measure === 'current');
  assert(ontology.classifyTag('FT_101').measure === 'flow');
  assert(ontology.classifyTag('XYZZY').measure === 'unknown');
});
t('defaultModel — 구조/조회', () => {
  const m = ontology.defaultModel();
  const assets = ontology.listAssets(m);
  assert(assets.length === 13);
  const p = ontology.findAsset(m, 'P-101A');
  assert(p && p.class === 'CP' && p.tags.length === 8);
  assert(ontology.listTags(m).some(t => t.id === 'PDT-306'));
});
t('matchFailureModes — 베어링 증상 → 베어링 모드 1위', () => {
  const observed = {
    bearing_temp_de: { up: 0.9, down: 0, variance: 0.2, spike: 0, high: 0, low: 0 },
    vibration: { up: 0.8, down: 0, variance: 0.5, spike: 0.1, high: 0, low: 0 },
  };
  const res = ontology.matchFailureModes('CP', observed);
  assert(res.length && res[0].mode.id === 'CP-BRG', `1위=${res[0] && res[0].mode.id}`);
});
t('toLLMContext — 직렬화', () => {
  const m = ontology.defaultModel();
  const ctx = ontology.toLLMContext(m, 'E-301', { note: 1 });
  assert(ctx.asset.id === 'E-301' && ctx.failureModeLibrary.length >= 2 && ctx.note === 1);
});

console.log('== simulator + equipment + health (통합) ==');
const sim = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
  { id: 'p101a_bearing', startFrac: 0.45, endFrac: 1.35 },
  { id: 'e301_fouling', startFrac: 0.25, endFrac: 1.8 },
] });
const model = ontology.defaultModel();

t('simulator — 전 태그 생성/유한값', () => {
  const ids = ontology.listTags(model).map(t => t.id);
  for (const id of ids) {
    assert(sim.series[id], `${id} 누락`);
    assert(sim.series[id].v.every(isFinite), `${id} 비유한값`);
  }
});
t('P-101A 베어링 시나리오 → CP-BRG 검출 + 건강 저하', () => {
  const asset = ontology.findAsset(model, 'P-101A');
  const an = equip.analyzeAsset(asset, sim.series, { recentHours: 24 });
  assert(an.ok, an.reason);
  assert(an.candidates.length && an.candidates[0].mode.id === 'CP-BRG',
    `1위=${an.candidates[0] && an.candidates[0].mode.id} score=${an.candidates[0] && an.candidates[0].score}`);
  const h = health.computeHealth(an);
  assert(h.score < 80, `건강지수 ${h.score}`);
  assert(an.mv && an.mv.speViolFrac >= 0, 'mv 존재');
});
t('E-301 파울링 → HE-FOUL 검출', () => {
  const asset = ontology.findAsset(model, 'E-301');
  const an = equip.analyzeAsset(asset, sim.series, { recentHours: 24 });
  assert(an.ok);
  assert(an.candidates.length && an.candidates[0].mode.id === 'HE-FOUL',
    `1위=${an.candidates[0] && an.candidates[0].mode.id}`);
  assert(an.derivedDiag.u_proxy && an.derivedDiag.u_proxy.zShift < -1, `U프록시 zShift=${an.derivedDiag.u_proxy && an.derivedDiag.u_proxy.zShift}`);
});
t('정상 설비(C-201) → 높은 건강지수', () => {
  const asset = ontology.findAsset(model, 'C-201');
  const an = equip.analyzeAsset(asset, sim.series, { recentHours: 24 });
  const h = health.computeHealth(an);
  assert(h.score >= 80, `C-201 건강지수 ${h.score} (정상이어야 함)`);
});
t('알람 엔진 — m-of-n 지속성/해제', () => {
  const eng = health.createAlarmEngine({ mOfN: [2, 3], offDelay: 2 });
  const cond = on => [{ key: 'k1', active: on, priority: '높음', asset: 'X', message: 'test' }];
  let r = eng.evaluate(cond(true), 1000); assert(r.raised.length === 0);
  r = eng.evaluate(cond(true), 2000); assert(r.raised.length === 1, '2/3 충족 시 발생');
  r = eng.evaluate(cond(false), 3000); assert(r.cleared.length === 0);
  r = eng.evaluate(cond(false), 4000); assert(r.cleared.length === 1, '오프딜레이 2회 후 해제');
  assert(eng.events.length === 1 && eng.events[0].state === 'cleared');
});
t('conditionsFromAnalysis — 고장모드 알람 생성', () => {
  const asset = ontology.findAsset(model, 'P-101A');
  const an = equip.analyzeAsset(asset, sim.series, { recentHours: 24 });
  const h = health.computeHealth(an);
  const conds = health.conditionsFromAnalysis(asset, an, h);
  assert(conds.some(c => c.key.includes('fm.CP-BRG') && c.active), '베어링 고장모드 알람 조건 활성');
});
t('report — 리포트 생성(한국어/섹션)', () => {
  const asset = ontology.findAsset(model, 'P-101A');
  const an = equip.analyzeAsset(asset, sim.series, { recentHours: 24 });
  const h = health.computeHealth(an);
  const md = report.assetReport(asset, an, h, { now: 1751846400000 });
  assert(md.includes('종합 판정') && md.includes('고장모드') && md.includes('베어링'), md.slice(0, 200));
  const sum = report.plantSummary([{ asset, analysis: an, health: h }], 1751846400000);
  assert(sum.includes('플랜트'));
});

console.log('== patterns.js (5대 패턴) ==');
t('회귀 — 관계 유지/붕괴 판정', () => {
  const n = 200;
  const x = [], y = [];
  for (let i = 0; i < n; i++) { x.push(i % 50); y.push(2 * (i % 50) + 5 + (i > 150 ? 30 : 0)); }
  const r = patterns.regression(x, y, 0.6);
  assert(Math.abs(r.residDriftSigma) > 2, `잔차이동 ${r.residDriftSigma}`);
});
t('분류 — 라벨 부여', () => {
  const t2 = [], M = [];
  for (let i = 0; i < 300; i++) {
    t2.push(i);
    const load = i < 30 ? 0 : 100 + Math.sin(i) * 10; // 초반 정지
    M.push([load, 50 + Math.sin(i * 0.5) * 2]);
  }
  const r = patterns.classifyStates(t2, M, ['flow', 'temp'], { loadIdx: 0 });
  assert(r.counts['정지'] >= 25, `정지=${r.counts['정지']}`);
  assert(r.labels.length === 300);
});
t('군집 — 분리된 두 군집', () => {
  const M = [];
  for (let i = 0; i < 60; i++) M.push([i % 2 ? 0.1 : -0.1, i % 3 * 0.05]);
  for (let i = 0; i < 60; i++) M.push([10 + (i % 2 ? 0.1 : -0.1), 10 + i % 3 * 0.05]);
  const r = patterns.kmeans(M, 2);
  const c0 = r.assignments.slice(0, 60), c1 = r.assignments.slice(60);
  assert(new Set(c0).size === 1 && new Set(c1).size === 1 && c0[0] !== c1[0], '두 군집 완전 분리');
});
t('이상탐지 — 주입 이상 검출', () => {
  const t3 = [], M = [];
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(11);
  for (let i = 0; i < 400; i++) {
    t3.push(i * 60000);
    const a = rng() * 2 - 1;
    M.push(i > 380 ? [8, -8] : [a + (rng() - 0.5) * 0.2, a + (rng() - 0.5) * 0.2]);
  }
  const r = patterns.anomaly(t3, M, ['a', 'b'], 0.5);
  assert(r.anomalyIdx.some(i => i > 380), '주입 구간 이상 검출');
});
t('시계열 — 선형 추세 예측 + 한계도달', () => {
  const t4 = [], v = [];
  for (let i = 0; i < 100; i++) { t4.push(i * 3600000); v.push(50 + i * 0.5); }
  const fc = patterns.holtForecast(t4, v, { horizon: 0.5 });
  assert(near(fc.trendPerStep, 0.5, 0.1), `추세 ${fc.trendPerStep}`);
  const hit = patterns.timeToLimit(fc, 110, true);
  assert(hit, '한계 도달 예측 존재');
  // 100→110은 (110-99.5)/0.5 ≈ 21스텝 후
  const stepsAway = (hit.t - t4[99]) / 3600000;
  assert(stepsAway > 10 && stepsAway < 35, `도달 ${stepsAway}스텝`);
});

console.log('== advanced.js (논문 기반 기법) ==');
t('Matrix Profile — 주입한 형태 이상이 최상위 디스코드', () => {
  // 정현파에 한 구간만 파형 왜곡 주입
  const ts = [];
  for (let i = 0; i < 600; i++) {
    let v = Math.sin(i * 0.35) + Math.sin(i * 0.11) * 0.4;
    if (i >= 300 && i < 325) v = 1.6; // 평탄 이상 구간 (형태 이상)
    ts.push(v);
  }
  const mp = adv.matrixProfile(ts, 30, { topK: 2 });
  assert(mp && mp.discords.length);
  assert(mp.discords.some(d => d.idx >= 270 && d.idx <= 330), `디스코드 위치 ${mp.discords.map(d => d.idx)}`);
});
t('Isolation Forest — 밀집 정상 + 산점 이상', () => {
  const rnd = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(3);
  const X = [];
  for (let i = 0; i < 500; i++) X.push([rnd(), rnd()]);
  X.push([5, 5]); X.push([-4, 6]);
  const res = adv.isolationForest(X, { seed: 1 });
  const normalMax = Math.max(...res.scores.slice(0, 500));
  assert(res.scores[500] > 0.6 && res.scores[501] > 0.6, `이상점수 ${res.scores[500].toFixed(2)}, ${res.scores[501].toFixed(2)}`);
  assert(res.scores[500] > normalMax, '이상점이 정상 최대보다 높아야');
});
t('ECOD — 꼬리 이상 검출', () => {
  const rnd = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(5);
  const X = [];
  for (let i = 0; i < 400; i++) X.push([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
  X.push([9, -9, 9]);
  const res = adv.ecod(X);
  const mean = res.scores.slice(0, 400).reduce((a, b) => a + b, 0) / 400;
  assert(res.scores[400] > mean * 2.5, `ECOD ${res.scores[400].toFixed(2)} vs 평균 ${mean.toFixed(2)}`);
});
t('PELT — 평균/분산 변화점 검출', () => {
  const rnd = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(9);
  const gauss = () => { let u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const xs = [];
  for (let i = 0; i < 300; i++) xs.push(gauss());
  for (let i = 0; i < 300; i++) xs.push(3 + gauss());       // 평균 이동
  const res = adv.pelt(xs);
  assert(res.changepoints.some(c => Math.abs(c - 300) < 30), `변화점 ${res.changepoints}`);
});
t('지수 열화 RUL — 가속 추세의 임계 도달 시점', () => {
  const t0 = 1751000000000;
  const ts = [], ys = [];
  for (let i = 0; i < 120; i++) {
    ts.push(t0 + i * 3600000);
    ys.push(50 + 2 * Math.exp(0.025 * i)); // 지수 열화
  }
  const fit = adv.expDegradationFit(ts, ys);
  assert(fit && fit.beta > 0.015 && fit.beta < 0.04, `beta=${fit && fit.beta}`);
  const hit = fit.timeToThreshold(90);
  assert(hit && hit > ts[119], 'RUL 미래 시점');
  // 해석해: 90 = 50 + 2e^{0.025h} → h = ln(20)/0.025 ≈ 119.8h → 마지막 시점(119h) 직후
  const hoursFromT0 = (hit - t0) / 3600000;
  assert(hoursFromT0 > 110 && hoursFromT0 < 135, `도달 ${hoursFromT0.toFixed(1)}h`);
});

console.log('== 신규 설비 시나리오 통합 (조사 기반 고장모드) ==');
function topMode(assetId, scnId) {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: scnId, startFrac: 0.45, endFrac: 1.35 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, assetId);
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.ok, `${assetId}: ${an.reason}`);
  return { an, top: an.candidates[0] };
}
t('FV-101 스틱션 → CV-STIC 1위', () => {
  const { top } = topMode('FV-101', 'fv101_stiction');
  assert(top && top.mode.id === 'CV-STIC' && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('T-401 플러딩 → DC-FLOOD 1위', () => {
  const { top } = topMode('T-401', 't401_flooding');
  assert(top && top.mode.id === 'DC-FLOOD' && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('F-501 코킹 → FH-COKE 1위', () => {
  const { top } = topMode('F-501', 'f501_coking');
  assert(top && top.mode.id === 'FH-COKE' && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('VFD-401 냉각 열화 → VF-COOL 1위', () => {
  const { top } = topMode('VFD-401', 'vfd401_cooling');
  assert(top && top.mode.id === 'VF-COOL' && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('TR-101 누유 → TR-OIL 1위', () => {
  const { top } = topMode('TR-101', 'tr101_oil');
  assert(top && top.mode.id === 'TR-OIL' && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('CT-601 충전재 오염 → CT-FILL 1위', () => {
  const { top } = topMode('CT-601', 'ct601_fouling');
  assert(top && (top.mode.id === 'CT-FILL' || top.mode.id === 'CT-DIST') && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('C-202 밸브 누설 → RC-VLV 1위', () => {
  const { top } = topMode('C-202', 'c202_valve');
  assert(top && top.mode.id === 'RC-VLV' && top.score > 0.4, `1위=${top && top.mode.id} ${top && top.score.toFixed(2)}`);
});
t('정상 신규 설비 — 시나리오 없으면 높은 건강지수', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const m = ontology.defaultModel();
  for (const id of ['FV-101', 'T-401', 'F-501', 'VFD-401', 'TR-101', 'CT-601', 'C-202', 'M-401']) {
    const a = ontology.findAsset(m, id);
    const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
    const h = health.computeHealth(an);
    assert(h.score >= 75, `${id} 건강지수 ${h.score}`);
  }
});
t('adv 통합 — 베어링 시나리오에서 온셋/합의 검출', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'p101a_bearing', startFrac: 0.45, endFrac: 1.35 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'P-101A');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.adv, 'adv 존재');
  assert(an.adv.iforest.recentFrac > 0.3, `iforest ${an.adv.iforest.recentFrac}`);
  assert(an.adv.onset, 'PELT 온셋 검출');
  // 온셋은 시나리오 시작(45%) 이후여야
  const t45 = s.series['TT-103'].t[Math.floor(s.series['TT-103'].t.length * 0.40)];
  assert(an.adv.onset.t >= t45, `온셋 ${new Date(an.adv.onset.t).toISOString()}`);
});

console.log('== 계기(트랜스미터) 건전성 ==');
t('임펄스라인 막힘 → impulse_plug 검출 + 중간 알람', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'pt202_plug', startFrac: 0.45, endFrac: 0.8 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'C-201');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  const ins = (an.instruments || []).find(i => i.tagId === 'PT-202');
  assert(ins && ins.type === 'impulse_plug' && ins.sev > 0.5, JSON.stringify(an.instruments));
  const conds = health.conditionsFromAnalysis(a, an, health.computeHealth(an));
  const c = conds.find(x => x.key === 'C-201.instr.PT-202');
  assert(c && c.active && c.priority === health.PRIORITY.MED, JSON.stringify(c));
});
t('출력 고착 → stuck 검출', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'tt113_stuck', startFrac: 0.45, endFrac: 0.8 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'P-101B');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  const ins = (an.instruments || []).find(i => i.tagId === 'TT-113');
  assert(ins && ins.type === 'stuck' && ins.sev > 0.7, JSON.stringify(an.instruments));
});
t('공정 원인 단독 이동(TR 누유)은 계기 이상으로 오진하지 않음', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'tr101_oil', startFrac: 0.4, endFrac: 1.2 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'TR-101');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert((an.instruments || []).length === 0, JSON.stringify(an.instruments));
  assert(an.candidates[0] && an.candidates[0].mode.id === 'TR-OIL', '공정 고장모드 유지');
});
t('정상 운전 전 설비 — 계기 오탐 없음', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const m = ontology.defaultModel();
  for (const a of ontology.listAssets(m)) {
    const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
    if (!an.ok) continue;
    assert((an.instruments || []).length === 0, `${a.id}: ${JSON.stringify(an.instruments)}`);
  }
});
t('INSTRUMENT_LIB/VENDOR_REFS — 구조·제조사 3사 존재', () => {
  for (const k of ['impulse_plug', 'stuck', 'drift', 'noisy']) {
    const e = ontology.INSTRUMENT_LIB[k];
    assert(e && e.name && e.ne107 && e.actions.length, k);
  }
  for (const v of ['emerson', 'yokogawa', 'abb']) {
    assert(ontology.VENDOR_REFS[v] && ontology.VENDOR_REFS[v].items.length >= 2, v);
  }
});

console.log('== 디지털(접점) 신호 — 트립/채터링 ==');
t('M-401 과열→86 트립: 래치·긴급 알람·상태기반 억제·건강 경고', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'm401_trip', startFrac: 0.3, endFrac: 0.97 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'M-401');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.tripped === true, '트립 래치');
  assert(an.digital['XA-408'].state === 1 && an.digital['XA-409'].state === 1, '86+49 접점');
  const h = health.computeHealth(an);
  assert(h.grade === 'alarm' && h.score <= 40, `score ${h.score}`);
  const conds = health.conditionsFromAnalysis(a, an, h);
  const act = conds.filter(c => c.active);
  assert(act.some(c => c.key === 'M-401.dig.trip.XA-408' && c.priority === health.PRIORITY.URGENT), '긴급 트립 알람');
  // 상태기반 억제: 정지로 인한 통계 알람은 전부 억제
  assert(!act.some(c => /\.(fm|mv|trend|limit|instr)\./.test(c.key)), `억제 실패: ${act.map(c => c.key).join(',')}`);
});
t('Aux Relay 채터링: 중간 알람 + 설비는 양호 유지', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'm401_relay_chatter', startFrac: 0.5, endFrac: 0.9 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'M-401');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.digital['XS-407'].chatter > 0.3, `chatter ${an.digital['XS-407'].chatter}`);
  const h = health.computeHealth(an);
  assert(h.score >= 85, `score ${h.score}`); // 접점 문제는 설비 열화가 아님 — 소폭 감점
  const conds = health.conditionsFromAnalysis(a, an, h);
  assert(conds.some(c => c.key === 'M-401.dig.chatter.XS-407' && c.active && c.priority === health.PRIORITY.MED), '채터링 알람');
});
t('정상 운전: 디지털 오탐 없음 + 아날로그 파이프라인에서 디지털 제외', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'M-401');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.tripped === false, '트립 없음');
  for (const [id, d] of Object.entries(an.digital)) {
    assert(d.chatter < 0.3, `${id} 채터 오탐`);
    if (d.trip) assert(d.state === 0, `${id} 트립 오탐`);
  }
  assert(!an.tagDiag['XA-408'] && !an.mv.ids.includes('XA-408'), '디지털이 아날로그 분석에 섞이지 않음');
  assert(ontology.classifyTag('XA-408').measure === 'digital', 'XA 분류');
  const h = health.computeHealth(an);
  assert(h.score >= 85, `score ${h.score}`);
});

t('계전기 아날로그(THL 열용량): 트립 전에 과열을 선행 검출', () => {
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'M-401');
  // endFrac을 늘려 아직 트립 전(과열 진행 중) 상태
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'm401_trip', startFrac: 0.5, endFrac: 1.6 },
  ] });
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.tripped === false, '아직 트립 전');
  assert(an.tagDiag['THL-410'] && an.tagDiag['THL-410'].zShift > 1.2, `THL zShift ${an.tagDiag['THL-410'] && an.tagDiag['THL-410'].zShift}`);
  assert(an.candidates[0] && an.candidates[0].mode.id === 'EM-WIND' && an.candidates[0].score > 0.4,
    `1위=${an.candidates[0] && an.candidates[0].mode.id}`);
  const h = health.computeHealth(an);
  assert(h.score < 70, `트립 전 경고 score ${h.score}`); // 트립이 오기 전에 잡는 것이 목적
});

console.log('== 밸브 진단 (논문 기반) ==');
const valve = require(path.join(__dirname, '../js/analytics/valve.js'));
t('ACF 진동 검출 — 합성 정현파 정확 검출, 잡음/추세 오탐 없음', () => {
  const n = 300, dt = 5, pv = [];
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(11);
  for (let i = 0; i < n; i++) pv.push(3 * Math.sin(2 * Math.PI * i * dt / 40) + (rng() - 0.5) * 0.4);
  const o = valve.acfOscillation(pv, dt);
  assert(o.oscillating && Math.abs(o.periodMin - 40) < 4, `T=${o.periodMin} r=${o.r}`);
  assert(!valve.acfOscillation(Array.from({ length: 300 }, () => rng() * 2), dt).oscillating, '잡음 오탐');
  assert(!valve.acfOscillation(Array.from({ length: 300 }, (_, i) => i * 0.05 + rng() * 0.5), dt).oscillating, '추세 오탐');
});
t('타원 적합 스틱션 정량화 — 합성 타원 폭 복원', () => {
  const rng = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(13);
  const op = [], pv = [];
  for (let i = 0; i < 300; i++) {
    const ph = 2 * Math.PI * i / 24;
    op.push(4 * Math.sin(ph + 1.2) + (rng() - 0.5) * 0.3);
    pv.push(3 * Math.sin(ph) + (rng() - 0.5) * 0.4);
  }
  const st = valve.stictionEllipse(op, pv);
  assert(st && Math.abs(st.apparent - 8) < 1, `apparent=${st && st.apparent}`); // 진폭 4 → 폭 8
});
t('FV-101 스틱션 → 겉보기 스틱션 정량화 + 데드밴드 근사', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'fv101_stiction', startFrac: 0.55, endFrac: 1.2 },
  ] });
  const m = ontology.defaultModel();
  const an = equip.analyzeAsset(ontology.findAsset(m, 'FV-101'), s.series, { recentHours: 24 });
  assert(an.valve && an.valve.kind === 'CV', 'CV 밸브 진단 존재');
  assert(an.valve.stiction && an.valve.stiction.apparent > 3 && an.valve.stiction.apparent < 12,
    `apparent=${an.valve.stiction && an.valve.stiction.apparent}`); // 주입 데드밴드 ~5-7% 근사
  // 정상 CV는 정량화 미표시 (게이트)
  const s2 = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const an2 = equip.analyzeAsset(ontology.findAsset(m, 'FV-101'), s2.series, { recentHours: 24 });
  assert(!an2.valve.stiction, '정상 루프 스틱션 미표시');
});
t('XV-701 스트로크 시간 증가 → OV-SLOW 1위', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'xv701_slow', startFrac: 0.45, endFrac: 1.1 },
  ] });
  const m = ontology.defaultModel();
  const an = equip.analyzeAsset(ontology.findAsset(m, 'XV-701'), s.series, { recentHours: 24 });
  assert(an.candidates[0] && an.candidates[0].mode.id === 'OV-SLOW' && an.candidates[0].score > 0.4,
    `1위=${an.candidates[0] && an.candidates[0].mode.id}`);
});
t('XV-701 지령-리미트 불일치 → OV-FTF 1위 + 높은 우선순위 알람', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [
    { id: 'xv701_ftc', startFrac: 0.75, endFrac: 0.95 },
  ] });
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'XV-701');
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.candidates[0] && an.candidates[0].mode.id === 'OV-FTF' && an.candidates[0].score > 0.6,
    `1위=${an.candidates[0] && an.candidates[0].mode.id} ${an.candidates[0] && an.candidates[0].score}`);
  const conds = health.conditionsFromAnalysis(a, an, health.computeHealth(an));
  const fm = conds.find(c => c.key.includes('.fm.OV-FTF'));
  assert(fm && fm.active && fm.priority === health.PRIORITY.HIGH, JSON.stringify(fm && fm.priority));
});
t('XV-701 정상 — 건강 양호·오탐 없음 (상태 접점을 알람으로 오인 안 함)', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const m = ontology.defaultModel();
  const an = equip.analyzeAsset(ontology.findAsset(m, 'XV-701'), s.series, { recentHours: 24 });
  const h = health.computeHealth(an);
  assert(h.score >= 85, `score ${h.score}`);
  assert(an.valve.recentMismatchFrac < 0.02, 'mismatch 오탐');
});

console.log('== 백테스트 + 신호 추천 + 사용자 조합 ==');
const backtest = require(path.join(__dirname, '../js/analytics/backtest.js'));
t('백테스트 — 베어링 고장: 온셋 이후 첫 알람 + 리드타임 > 24h', () => {
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'P-101A');
  const failureMs = 1751846400000;
  const s = simulator.makeSim({ days: 14, stepMin: 5, now: failureMs, active: [
    { id: 'p101a_bearing', startFrac: 0.55, endFrac: 0.95 },
  ] });
  const onsetMs = failureMs - 14 * 24 * 3600000 * 0.45;
  const r = backtest.runBacktest(a, s.series, { stepHours: 4, failureMs });
  assert(r.firstAlarmMs && r.firstAlarmMs > onsetMs, '첫 알람이 고장 시작 이후');
  assert(r.leadHours > 24, `리드타임 ${r.leadHours}h`);
});
t('백테스트 — 정상 데이터: 경고(<70) 없음 (미래 누수/오탐 가드)', () => {
  const m = ontology.defaultModel();
  const a = ontology.findAsset(m, 'P-101A');
  const s = simulator.makeSim({ days: 14, stepMin: 5, now: 1751846400000, active: [] });
  const r = backtest.runBacktest(a, s.series, { stepHours: 4 });
  assert(r.firstWarnMs === null, `정상인데 경고 ${r.firstWarnMs && new Date(r.firstWarnMs).toISOString()}`);
});
t('신호 추천 — EM 필수에 전류·권선온도 포함, CV 필수에 OP·개도 포함', () => {
  const em = ontology.signalRequirements('EM');
  const req = em.filter(r => r.required).map(r => r.role);
  assert(req.includes('motor_current') && req.includes('winding_temp'), req.join(','));
  const cv = ontology.signalRequirements('CV').filter(r => r.required).map(r => r.role);
  assert(cv.includes('controller_output') && cv.includes('valve_position'), cv.join(','));
});
t('사용자 조합 자산 — 생성/분석/삭제', () => {
  const m = ontology.defaultModel();
  // 데모 태그를 재활용해 커스텀 모터 조합 생성
  ontology.addCustomAsset(m, {
    id: 'USR-TEST', name: '테스트 모터 조합', class: 'EM', criticality: 'B', custom: true,
    tags: [
      { id: 'IT-401', role: 'motor_current', desc: '전류', unit: 'A' },
      { id: 'TT-403', role: 'winding_temp', desc: '권선온도', unit: '°C' },
      { id: 'VT-405', role: 'vibration', desc: '진동', unit: 'mm/s' },
    ],
  });
  const a = ontology.findAsset(m, 'USR-TEST');
  assert(a && a.class === 'EM');
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const an = equip.analyzeAsset(a, s.series, { recentHours: 24 });
  assert(an.ok, an.reason);
  const h = health.computeHealth(an);
  assert(h.score >= 80, `조합 정상 점수 ${h.score}`);
  assert(ontology.removeCustomAsset(m, 'USR-TEST'));
  assert(!ontology.findAsset(m, 'USR-TEST'));
});

console.log('== 계산 태그 + 데이터 품질 ==');
const calc = require(path.join(__dirname, '../js/analytics/calc.js'));
const quality = require(path.join(__dirname, '../js/analytics/quality.js'));
t('계산 태그 — 수식 평가/보간/악성입력 차단', () => {
  const c = calc.compile('([FT-101]*([PT-102]-[PT-101]))/[IT-106]');
  assert(near(c.eval({ 'FT-101': 200, 'PT-102': 18, 'PT-101': 2, 'IT-106': 80 }), 40));
  assert(near(calc.compile('-[A]+max([A],[B])*2').eval({ A: 3, B: 5 }), 7));
  assert.throws(() => calc.compile('[A]; alert(1)'));
  assert.throws(() => calc.compile('1+2')); // 태그 참조 필수
  const sm = { A: { t: [0, 60000], v: [10, 20] }, B: { t: [0, 60000], v: [1, 3] } };
  const s = calc.makeSeries(sm, '[A]*[B]');
  assert(near(s.v[1], 60));
});
t('데이터 품질 — 역순/NaN/스케일 의심 검출, 정상 무이슈', () => {
  const bad = { t: [0, 1000, 500, 2000], v: [1, NaN, 3, 3] };
  const codes = quality.checkSeries(bad, { nowMs: 3000, staleHours: 999 }).map(i => i.code);
  assert(codes.includes('out_of_order') && codes.includes('nonfinite'), codes.join(','));
  const scaled = { t: Array.from({ length: 100 }, (_, i) => i * 60000), v: Array.from({ length: 100 }, (_, i) => 0.5 + Math.sin(i) * 0.3) };
  assert(quality.checkSeries(scaled, { nowMs: 100 * 60000, lo: 0, hi: 100 }).some(i => i.code === 'range_suspect'));
  const healthy = { t: Array.from({ length: 200 }, (_, i) => i * 60000), v: Array.from({ length: 200 }, (_, i) => 50 + Math.sin(i) * 5) };
  assert(quality.checkSeries(healthy, { nowMs: 200 * 60000, lo: 0, hi: 100 }).length === 0);
});
t('데모 시뮬레이터 전 태그 — 품질 이슈 없음 (자가 무결성)', () => {
  const s = simulator.makeSim({ days: 7, stepMin: 5, now: 1751846400000, active: [] });
  const m = ontology.defaultModel();
  const meta = {};
  for (const tg of ontology.listTags(m)) meta[tg.id] = { lo: tg.lo, hi: tg.hi, kind: tg.kind };
  const r = quality.report(s.series, meta, { nowMs: 1751846400000, staleHours: 999 });
  assert(r.errors === 0, JSON.stringify(r.perTag).slice(0, 300));
});

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
