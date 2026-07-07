/* MEDI 백테스트 — 과거 데이터를 시간 순으로 재생하며 "그때 경고가 떴을까"를 검증
 *
 * 목적: 실제 발생했던 고장/트립 데이터(CSV 등)에 대해, 본 시스템이
 * 실제 사고 몇 시간 전에 첫 경고를 냈을지(리드타임)를 추정한다.
 * — 비계획 정지(인터록 트립)를 막을 수 있었는지의 사후 검증.
 *
 * 방식: 평가 시점을 stepHours 간격으로 전진시키며, 각 시점까지의 데이터만으로
 * analyzeAsset(당시 시점 기준 최근창) + 알람 조건 + m-of-n 알람엔진을 그대로 실행.
 * 미래 데이터 누수 없음(각 시점에서 그 이후 데이터는 보이지 않음).
 *
 * 브라우저(window.MEDI.backtest)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./equipment.js'), require('./health.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.backtest = factory(root.MEDI.equip, root.MEDI.health);
  }
})(typeof self !== 'undefined' ? self : this, function (equip, health) {
  'use strict';

  // 시리즈를 특정 시각까지 잘라낸 뷰
  function sliceUntil(seriesMap, tagIds, untilMs) {
    const out = {};
    for (const id of tagIds) {
      const s = seriesMap[id];
      if (!s) continue;
      let e = s.t.length;
      while (e > 0 && s.t[e - 1] > untilMs) e--;
      if (e < 2) continue;
      out[id] = { t: s.t.slice(0, e), v: s.v.slice(0, e) };
    }
    return out;
  }

  /**
   * runBacktest(asset, seriesMap, opts)
   *  opts: stepHours(평가 간격, 기본 2), recentHours(진단 최근창, 기본 24),
   *        minHours(최소 데이터, 기본 48), light(고급기법 생략, 기본 true),
   *        failureMs(실제 고장 시각 — 선택), onStep(진행 콜백 (i,total)),
   *  반환: { points: [{t, score, grade, topFm, topScore}], alarms: [{t, key, priority, message}],
   *          firstWarnMs, firstAlarmMs, leadHours(실제 고장 대비), evalCount }
   */
  function runBacktest(asset, seriesMap, opts) {
    const o = Object.assign({ stepHours: 2, recentHours: 24, baselineHours: null, light: true, failureMs: null, onStep: null }, opts);
    const tagIds = (asset.tags || []).map(t => t.id).filter(id => seriesMap[id]);
    if (!tagIds.length) return { points: [], alarms: [], firstWarnMs: null, firstAlarmMs: null, leadHours: null, evalCount: 0, reason: '태그 데이터 없음' };
    let t0 = Infinity, t1 = -Infinity;
    for (const id of tagIds) {
      const s = seriesMap[id];
      t0 = Math.min(t0, s.t[0]);
      t1 = Math.max(t1, s.t[s.t.length - 1]);
    }
    const end = o.failureMs ? Math.min(t1, o.failureMs) : t1; // 고장 시각 이후는 평가 무의미
    // 캘리브레이션(정상 학습) 구간: 지정 없으면 기록 앞 40% (48h~7일 클램프)
    // — 부하 사이클을 충분히 포함해야 부하 추종을 고장으로 오인하지 않는다
    const spanH = (end - t0) / 3600000;
    if (!o.baselineHours) o.baselineHours = Math.max(48, Math.min(168, spanH * 0.4));
    if (!o.minHours) o.minHours = o.baselineHours + o.recentHours;
    const start = t0 + o.minHours * 3600000;
    if (end <= start) return { points: [], alarms: [], firstWarnMs: null, firstAlarmMs: null, leadHours: null, evalCount: 0, reason: '데이터 기간 부족 (최소 ' + o.minHours + 'h)' };

    const engine = health.createAlarmEngine({ mOfN: [2, 3], offDelay: 2 });
    const points = [], alarms = [];
    let firstWarnMs = null, firstAlarmMs = null;
    const times = [];
    for (let tm = start; tm <= end; tm += o.stepHours * 3600000) times.push(tm);
    if (times[times.length - 1] !== end) times.push(end);

    for (let i = 0; i < times.length; i++) {
      const tm = times[i];
      const cut = sliceUntil(seriesMap, tagIds, tm);
      const an = equip.analyzeAsset(asset, cut, { recentHours: o.recentHours, skipAdv: o.light, baselineHours: o.baselineHours });
      if (!an.ok) { points.push({ t: tm, score: null }); continue; }
      const h = health.computeHealth(an);
      const top = (an.candidates || [])[0];
      points.push({
        t: tm, score: h.score, grade: h.grade,
        topFm: top && top.score > 0.2 ? top.mode.name : null,
        topScore: top ? top.score : 0,
      });
      if (firstWarnMs === null && h.score !== null && h.score < 70) firstWarnMs = tm;
      const conds = health.conditionsFromAnalysis(asset, an, h);
      const { raised } = engine.evaluate(conds, tm);
      for (const ev of raised) {
        alarms.push({ t: tm, key: ev.id, priority: ev.priority, message: ev.message });
        if (firstAlarmMs === null && (ev.priority === health.PRIORITY.HIGH || ev.priority === health.PRIORITY.URGENT || ev.priority === health.PRIORITY.MED)) {
          firstAlarmMs = tm;
        }
      }
      if (o.onStep) o.onStep(i + 1, times.length);
    }

    const ref = firstAlarmMs !== null ? firstAlarmMs : firstWarnMs;
    const leadHours = o.failureMs && ref !== null ? (o.failureMs - ref) / 3600000 : null;
    return { points, alarms, firstWarnMs, firstAlarmMs, leadHours, evalCount: times.length };
  }

  return { runBacktest, sliceUntil };
});
