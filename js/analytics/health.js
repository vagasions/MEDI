/* MEDI 예지보전 — 종합 건강지수 + 알람 엔진
 * equipment.analyzeAsset 결과를 0~100 건강지수로 종합하고,
 * ISA-18.2 개념(우선순위, m-of-n 지속성, 데드밴드/오프딜레이, 상태기반 억제)을
 * 적용한 이벤트를 생성한다.
 * 브라우저(window.MEDI.health)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.health = factory(root.MEDI.stats);
  }
})(typeof self !== 'undefined' ? self : this, function (stats) {
  'use strict';

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ---------- 건강지수 (0~100) ----------
  // 감점 방식: 다변량 위반(구조 이탈) + 고장모드 매칭 강도 + 태그 한계 접근/이탈
  function computeHealth(analysis) {
    if (!analysis || !analysis.ok) return { score: null, grade: 'unknown', parts: [] };
    const parts = [];

    // 1) 다변량: T²/SPE 최근 위반율 (연속적 이탈일수록 큰 감점)
    if (analysis.mv) {
      const t2p = clamp(analysis.mv.t2ViolFrac * 40, 0, 22);
      const spp = clamp(analysis.mv.speViolFrac * 45, 0, 27);
      if (t2p > 0.5) parts.push({ name: '다변량 T² 이탈', penalty: t2p, detail: `최근 위반율 ${(analysis.mv.t2ViolFrac * 100).toFixed(0)}%` });
      if (spp > 0.5) parts.push({ name: '상관구조 붕괴(SPE)', penalty: spp, detail: `최근 위반율 ${(analysis.mv.speViolFrac * 100).toFixed(0)}%` });
    }

    // 2) 고장모드 후보 (최상위 후보의 매칭 점수)
    const top = (analysis.candidates || [])[0];
    if (top && top.score > 0.2) {
      parts.push({ name: `고장모드: ${top.mode.name}`, penalty: clamp(top.score * 45, 0, 45), detail: `증상 일치도 ${(top.score * 100).toFixed(0)}%` });
    }
    const second = (analysis.candidates || [])[1];
    if (second && second.score > 0.35) {
      parts.push({ name: `고장모드(차순위): ${second.mode.name}`, penalty: clamp(second.score * 15, 0, 15), detail: `일치도 ${(second.score * 100).toFixed(0)}%` });
    }

    // 2b) 최신 기법 합의 (iForest ∧ ECOD) — 단, 고전 지표(SPE 또는 고장모드)가
    // 동조할 때만 감점. 새 운전점 이동(novelty)을 고장으로 오인하는 것을 막는다.
    if (analysis.adv) {
      const consensus = Math.min(analysis.adv.iforest.recentFrac, analysis.adv.ecod.recentFrac);
      const speAgree = analysis.mv && analysis.mv.speViolFrac > 0.1;
      const fmAgree = top && top.score > 0.3;
      if (consensus > 0.2 && (speAgree || fmAgree)) {
        parts.push({
          name: '다중 검출기 합의 이상 (iForest+ECOD)',
          penalty: clamp(consensus * 24, 0, 12),
          detail: `최근 초과율 iForest ${(analysis.adv.iforest.recentFrac * 100).toFixed(0)}% · ECOD ${(analysis.adv.ecod.recentFrac * 100).toFixed(0)}%`,
        });
      }
    }

    // 3) 설계한계 접근/이탈 (high/low)
    for (const [tagId, d] of Object.entries(analysis.tagDiag || {})) {
      const lim = Math.max(d.high || 0, d.low || 0);
      if (lim > 0.3) {
        parts.push({ name: `${tagId} 한계 ${d.high > d.low ? '상한' : '하한'} 접근`, penalty: clamp(lim * 20, 0, 20), detail: `현재 ${fmt(d.lastValue)}${d.unit || ''}` });
      }
    }

    let total = parts.reduce((a, p) => a + p.penalty, 0);
    // 단일 원인 중복 과대감점 방지 — 체감 감점
    if (total > 40) total = 40 + (total - 40) * 0.6;
    const score = clamp(Math.round(100 - total), 0, 100);
    const grade = score >= 85 ? 'good' : score >= 70 ? 'watch' : score >= 50 ? 'warn' : 'alarm';
    return { score, grade, parts: parts.sort((a, b) => b.penalty - a.penalty) };
  }

  function fmt(v) {
    if (v === undefined || v === null || isNaN(v)) return '-';
    return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  // ---------- 알람 엔진 ----------
  // 규칙 평가 → m-of-n 지속성 → 이벤트 생성/해제. 상태는 엔진 인스턴스에 유지.
  const PRIORITY = { LOW: '낮음', MED: '중간', HIGH: '높음', URGENT: '긴급' };

  function createAlarmEngine(opts) {
    const o = Object.assign({ mOfN: [3, 4], offDelay: 3 }, opts);
    // key → {history: bool[], active, clearCount, event}
    const states = {};
    const events = []; // 전체 이벤트 로그

    // conditions: [{key, active(bool), priority, message, asset, evidence}]
    // 매 평가 주기마다 호출. 반환: 새로 발생/해제된 이벤트
    function evaluate(conditions, now) {
      const raised = [], cleared = [];
      const seen = new Set();
      for (const c of conditions) {
        seen.add(c.key);
        let st = states[c.key];
        if (!st) st = states[c.key] = { history: [], active: false, clearCount: 0, event: null };
        st.history.push(!!c.active);
        if (st.history.length > o.mOfN[1]) st.history.shift();
        const hits = st.history.filter(Boolean).length;

        if (!st.active && hits >= o.mOfN[0]) {
          // m-of-n 충족 → 알람 확정
          st.active = true;
          st.clearCount = 0;
          st.event = {
            id: c.key + '@' + now,
            time: now, asset: c.asset, priority: c.priority,
            message: c.message, evidence: c.evidence || null,
            state: 'active', ackBy: null, clearedAt: null,
          };
          events.unshift(st.event);
          raised.push(st.event);
        } else if (st.active) {
          if (!c.active) {
            // 오프딜레이: 연속 offDelay회 정상이어야 해제 (채터링 방지)
            st.clearCount++;
            if (st.clearCount >= o.offDelay) {
              st.active = false;
              if (st.event) { st.event.state = 'cleared'; st.event.clearedAt = now; cleared.push(st.event); }
              st.event = null;
              st.history = [];
            }
          } else {
            st.clearCount = 0;
            if (st.event) { st.event.message = c.message; st.event.evidence = c.evidence || st.event.evidence; }
          }
        }
      }
      // 조건 목록에서 사라진 키(설비 정지 등 상태기반 억제)는 자동 해제
      for (const key of Object.keys(states)) {
        if (!seen.has(key) && states[key].active) {
          states[key].active = false;
          if (states[key].event) { states[key].event.state = 'cleared'; states[key].event.clearedAt = now; cleared.push(states[key].event); }
          states[key].event = null;
          states[key].history = [];
        }
      }
      return { raised, cleared };
    }

    function ack(eventId, by) {
      const ev = events.find(e => e.id === eventId);
      if (ev && ev.state === 'active') { ev.state = 'acked'; ev.ackBy = by || '사용자'; return true; }
      return false;
    }

    function activeEvents() {
      return events.filter(e => e.state === 'active' || e.state === 'acked');
    }

    return { evaluate, ack, events, activeEvents, states };
  }

  // ---------- 분석결과 → 알람 조건 변환 ----------
  // analyzeAsset 결과와 건강지수로부터 알람 조건 목록 생성
  function conditionsFromAnalysis(asset, analysis, healthRes) {
    if (!analysis || !analysis.ok) return [];
    const conds = [];
    const aid = asset.id;

    // 1) 고장모드 후보
    const top = (analysis.candidates || [])[0];
    if (top) {
      const evid = top.matched.map(m => `${m.role}:${patternKo(m.pattern)}(${(m.strength * 100).toFixed(0)}%)`).join(', ');
      conds.push({
        key: `${aid}.fm.${top.mode.id}`,
        active: top.score >= 0.4,
        priority: top.score >= 0.65 ? PRIORITY.HIGH : PRIORITY.MED,
        asset: aid,
        message: `${asset.name}: [${top.mode.name}] 의심 — 증상 일치 ${(top.score * 100).toFixed(0)}%`,
        evidence: { type: 'failureMode', modeId: top.mode.id, score: top.score, matched: top.matched, detail: evid, actions: top.mode.actions },
      });
    }

    // 2) 다변량 이상 (T²/SPE)
    if (analysis.mv) {
      const contrib = (analysis.mv.topContributors || []).map(c => `${c.name}(${(c.share * 100).toFixed(0)}%)`).join(', ');
      conds.push({
        key: `${aid}.mv.spe`,
        active: analysis.mv.speViolFrac >= 0.3,
        priority: analysis.mv.speViolFrac >= 0.6 ? PRIORITY.HIGH : PRIORITY.MED,
        asset: aid,
        message: `${asset.name}: 신호 상관구조 이상(SPE) — 단독 임계값으로는 안 보이는 복합 이상. 기여: ${contrib}`,
        evidence: { type: 'spe', violFrac: analysis.mv.speViolFrac, contributors: analysis.mv.topContributors },
      });
      conds.push({
        key: `${aid}.mv.t2`,
        active: analysis.mv.t2ViolFrac >= 0.3,
        priority: PRIORITY.MED,
        asset: aid,
        message: `${asset.name}: 운전상태 통계 이탈(T²) — 정상운전 영역을 벗어나는 중`,
        evidence: { type: 't2', violFrac: analysis.mv.t2ViolFrac },
      });
    }

    // 3) 설계한계 접근 (긴급 단계)
    for (const [tagId, d] of Object.entries(analysis.tagDiag || {})) {
      const isHigh = (d.high || 0) > (d.low || 0);
      const lim = Math.max(d.high || 0, d.low || 0);
      conds.push({
        key: `${aid}.limit.${tagId}`,
        active: lim >= 0.6,
        priority: lim >= 0.9 ? PRIORITY.URGENT : PRIORITY.HIGH,
        asset: aid,
        message: `${asset.name}: ${tagId} ${d.desc || ''} ${isHigh ? '상한' : '하한'} ${lim >= 0.9 ? '이탈' : '접근'} (현재 ${fmt(d.lastValue)}${d.unit || ''})`,
        evidence: { type: 'limit', tagId, value: d.lastValue, side: isHigh ? 'high' : 'low' },
      });
    }

    // 4) 추세 경보 (CUSUM 확정 + 추세 기울기)
    for (const [tagId, d] of Object.entries(analysis.tagDiag || {})) {
      // 부하 변동에 의한 통계적 추세는 흔하므로 2σ + CUSUM 동시 충족만 알람화
      const trending = d.cusumViol !== 0 && Math.abs(d.zShift) > 2;
      conds.push({
        key: `${aid}.trend.${tagId}`,
        active: trending,
        priority: PRIORITY.LOW,
        asset: aid,
        message: `${asset.name}: ${tagId} ${d.desc || ''} 지속 ${d.zShift > 0 ? '상승' : '하강'} 추세 (베이스라인 대비 ${d.zShift.toFixed(1)}σ)`,
        evidence: { type: 'trend', tagId, zShift: d.zShift, slopePerHour: d.slopePerHour },
      });
    }

    // 5) 계기(트랜스미터) 이상 — 공정 알람과 별도 채널 (정비 계기팀 대상)
    const instrTags = new Set();
    for (const ins of analysis.instruments || []) {
      instrTags.add(ins.tagId);
      conds.push({
        key: `${aid}.instr.${ins.tagId}`,
        active: ins.sev >= 0.3,
        priority: (ins.type === 'stuck' || ins.type === 'impulse_plug') ? PRIORITY.MED : PRIORITY.LOW,
        asset: aid,
        message: `${asset.name}: ${ins.tagId} 계기 점검 — ${ins.evidence}`,
        evidence: { type: 'instrument', instrType: ins.type, tagId: ins.tagId, sev: ins.sev },
      });
    }
    // 계기 이상 태그가 SPE 최대 기여자면 SPE 알람에 계기 원인 가능성 주석
    if (instrTags.size && analysis.mv) {
      const spe = conds.find(c => c.key === `${aid}.mv.spe`);
      const topC = (analysis.mv.topContributors || [])[0];
      if (spe && topC && instrTags.has(topC.name)) {
        spe.message += ` ⚠ 최대 기여 태그(${topC.name})에 계기 이상 징후 — 공정보다 계기 원인 가능성 먼저 확인`;
      }
    }

    // 알람 합리화 (ISA-18.2 first-out 그룹핑):
    // 진단(고장모드) 알람이 활성이면 같은 설비의 하위 증상 알람(추세/T²/SPE)은 억제
    // — 원인 1건에 알람 1건. 설계한계(limit) 알람은 안전 관련이라 항상 유지.
    // 계기(instr) 알람은 별도 채널이라 억제 대상에서 제외.
    const fmActive = conds.some(c => c.key.startsWith(`${aid}.fm.`) && c.active);
    if (fmActive) {
      for (const c of conds) {
        if (c.key.startsWith(`${aid}.trend.`) || c.key.startsWith(`${aid}.mv.`)) c.active = false;
      }
    } else {
      // 고장모드 미확정 시에도 SPE(복합이상)가 활성이면 개별 추세 알람은 억제
      const speActive = conds.some(c => c.key === `${aid}.mv.spe` && c.active);
      if (speActive) {
        for (const c of conds) {
          if (c.key.startsWith(`${aid}.trend.`)) c.active = false;
        }
      }
    }

    return conds;
  }

  function patternKo(p) {
    return { up: '상승', down: '하강', spike: '스파이크', variance: '변동성증가', high: '상한접근', low: '하한접근' }[p] || p;
  }

  return { computeHealth, createAlarmEngine, conditionsFromAnalysis, PRIORITY, patternKo, fmt };
});
