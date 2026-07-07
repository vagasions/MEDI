/* MEDI 예지보전 — 자산 온톨로지
 * ISA-95 계층(사이트→공정지역→유닛→설비) + ISO 14224 설비클래스/고장모드 +
 * ISA-5.1 계기 태그 자동분류. LLM 분석 컨텍스트의 원천이기도 하다.
 * 의존성 없음. 브라우저(window.MEDI.ontology)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.ontology = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- ISA-5.1 계기 식별문자 ----------
  // 첫 글자 = 측정변수, 뒤 글자(T/I/E...) = 기능. PDT처럼 D는 차압 수식어.
  const ISA51_FIRST = {
    A: { ko: '분석(조성)', measure: 'analysis', unit: '%' },
    E: { ko: '전압', measure: 'voltage', unit: 'V' },
    F: { ko: '유량', measure: 'flow', unit: 'm³/h' },
    I: { ko: '전류', measure: 'current', unit: 'A' },
    J: { ko: '전력', measure: 'power', unit: 'kW' },
    L: { ko: '레벨', measure: 'level', unit: '%' },
    P: { ko: '압력', measure: 'pressure', unit: 'kg/cm²' },
    PD: { ko: '차압', measure: 'dp', unit: 'kg/cm²' },
    S: { ko: '속도/회전수', measure: 'speed', unit: 'rpm' },
    T: { ko: '온도', measure: 'temperature', unit: '°C' },
    TD: { ko: '온도차', measure: 'dt', unit: '°C' },
    V: { ko: '진동', measure: 'vibration', unit: 'mm/s' },
    W: { ko: '중량/힘', measure: 'weight', unit: 'kg' },
    Z: { ko: '위치(변위)', measure: 'position', unit: 'µm' },
  };

  // 태그명에서 측정종류 추정: "10-PT-1234A", "PDT-306", "TI_101" 등 처리
  function classifyTag(tagName) {
    const m = String(tagName).toUpperCase().match(/(?:^|[^A-Z])((?:PD|TD)|[AEFIJLPSTVWZ])[TIRCEGSAQ]{0,3}[-_ ]?\d/);
    if (!m) return { measure: 'unknown', ko: '미분류', unit: '' };
    const key = m[1];
    const def = ISA51_FIRST[key];
    return def ? { measure: def.measure, ko: def.ko, unit: def.unit, letter: key } : { measure: 'unknown', ko: '미분류', unit: '' };
  }

  // ---------- ISO 14224 기반 설비 클래스 ----------
  const EQUIP_CLASSES = {
    CP: { ko: '원심펌프', en: 'Centrifugal pump', iso: 'PU' },
    CO: { ko: '압축기', en: 'Compressor', iso: 'CO' },
    EM: { ko: '전동기', en: 'Electric motor', iso: 'EM' },
    HE: { ko: '열교환기', en: 'Heat exchanger', iso: 'HE' },
    VE: { ko: '용기/드럼', en: 'Vessel', iso: 'VE' },
  };

  // ---------- 고장모드 라이브러리 (ISO 14224 고장모드 + FMEA 지식) ----------
  // symptoms: tagRole별 기대 패턴 — up(상승추세) down(하강) spike(간헐 스파이크)
  //           variance(변동성 증가) low(저측 이탈) high(고측 이탈)
  const FAILURE_LIB = {
    CP: [
      {
        id: 'CP-BRG', name: '베어링 열화/마모', iso14224: 'BRD (Breakdown)/VIB',
        mechanism: '윤활 불량, 피로 박리(spalling), 오염 입자 침투',
        symptoms: [
          { role: 'bearing_temp_de', pattern: 'up', w: 3 },
          { role: 'bearing_temp_nde', pattern: 'up', w: 3 },
          { role: 'vibration', pattern: 'up', w: 3 },
          { role: 'vibration', pattern: 'variance', w: 2 },
          { role: 'motor_current', pattern: 'up', w: 1 },
        ],
        causes: ['윤활유 열화·부족', '오정렬(misalignment)', '임펠러 불평형', '베어링 수명 도달'],
        actions: ['오일 분석 및 보충/교체', '진동 정밀진단(스펙트럼) 의뢰', '예비기 전환 검토', '정비 오더 발행'],
        leadTime: '수 주 ~ 수개월에 걸쳐 서서히 진행. 온도+진동 동시 상승 시 잔여수명 짧음.',
      },
      {
        id: 'CP-CAV', name: '캐비테이션', iso14224: 'VIB/ERO',
        mechanism: 'NPSH 부족으로 임펠러 입구에서 기포 생성·붕괴 → 침식',
        symptoms: [
          { role: 'suction_pressure', pattern: 'down', w: 3 },
          { role: 'discharge_pressure', pattern: 'variance', w: 3 },
          { role: 'flow', pattern: 'variance', w: 2 },
          { role: 'vibration', pattern: 'spike', w: 3 },
          { role: 'flow', pattern: 'down', w: 1 },
        ],
        causes: ['흡입측 여과기(스트레이너) 막힘', '탱크 레벨 저하', '흡입배관 기포 유입', '운전점 이탈(과유량)'],
        actions: ['흡입 스트레이너 차압 확인/청소', '흡입측 밸브 개도 확인', '탱크 레벨·NPSH 재계산', '유량 운전점 조정'],
        leadTime: '운전조건에 따라 급격히 발생 가능. 지속되면 임펠러 침식으로 성능 저하 고착.',
      },
      {
        id: 'CP-SEAL', name: '메커니컬 씰 누설', iso14224: 'ELP (External leakage-process)',
        mechanism: '씰 페이스 마모/열손상, O-링 열화, 플러싱 이상',
        symptoms: [
          { role: 'seal_pot_level', pattern: 'down', w: 3 },
          { role: 'seal_pot_pressure', pattern: 'up', w: 2 },
          { role: 'bearing_temp_de', pattern: 'up', w: 1 },
          { role: 'vibration', pattern: 'up', w: 1 },
        ],
        causes: ['씰 페이스 마모', '플러싱 유량 부족', '운전점 이탈로 인한 진동', '씰 포트 오염'],
        actions: ['씰 포트 레벨/압력 점검', 'API 플랜 유량 확인', '누설 육안 점검', '씰 교체 계획 수립'],
        leadTime: '완만한 레벨 변화로 시작 → 급가속 가능. 인화성 유체는 즉시 조치.',
      },
      {
        id: 'CP-PERF', name: '성능 저하(임펠러 마모/막힘)', iso14224: 'LOO (Low output)',
        mechanism: '임펠러 침식·부식, 웨어링 간극 확대, 이물 부착',
        symptoms: [
          { role: 'flow', pattern: 'down', w: 3 },
          { role: 'discharge_pressure', pattern: 'down', w: 2 },
          { role: 'motor_current', pattern: 'down', w: 1 },
        ],
        causes: ['임펠러/웨어링 마모', '슬러리·폴리머 부착', '내부 재순환'],
        actions: ['성능곡선 대비 운전점 평가', '효율 추이 확인', '오버홀 계획 검토'],
        leadTime: '수개월 단위의 완만한 추세. 효율 지표로 조기 포착 가능.',
      },
    ],
    CO: [
      {
        id: 'CO-SURGE', name: '서지(surge) 접근', iso14224: 'VIB/STD',
        mechanism: '유량 감소로 서지라인 접근 → 유동 역류·맥동',
        symptoms: [
          { role: 'suction_flow', pattern: 'down', w: 3 },
          { role: 'discharge_pressure', pattern: 'up', w: 2 },
          { role: 'discharge_pressure', pattern: 'variance', w: 3 },
          { role: 'vibration', pattern: 'spike', w: 3 },
        ],
        causes: ['후단 수요 감소', '안티서지 밸브 이상', '흡입 조건 변화'],
        actions: ['서지 마진 확인', '안티서지 밸브 동작 점검', '운전점 이동(리사이클 증가)'],
        leadTime: '수 분 내 급격 진행 가능 — 즉시 대응 필요한 고위험 모드.',
      },
      {
        id: 'CO-FOUL', name: '내부 오염(fouling)/효율 저하', iso14224: 'LOO',
        mechanism: '폴리머·코크 부착으로 유로 축소, 압축효율 저하',
        symptoms: [
          { role: 'discharge_temp', pattern: 'up', w: 3 },
          { role: 'motor_current', pattern: 'up', w: 2 },
          { role: 'suction_flow', pattern: 'down', w: 1 },
        ],
        causes: ['공정 유체 내 중합성 성분', '워시오일 주입 부족', '흡입 온도 상승'],
        actions: ['압축비 대비 토출온도 추이 확인', '워시오일 계통 점검', '세정 계획 수립'],
        leadTime: '수 주~수개월 완만 진행. 토출온도·전류 동반 상승이 특징.',
      },
      {
        id: 'CO-BRG', name: '베어링/축계 이상', iso14224: 'VIB',
        mechanism: '베어링 마모, 오정렬, 밸런스 불량',
        symptoms: [
          { role: 'bearing_temp', pattern: 'up', w: 3 },
          { role: 'vibration', pattern: 'up', w: 3 },
          { role: 'vibration', pattern: 'variance', w: 2 },
        ],
        causes: ['윤활 계통 이상', '커플링 오정렬', '로터 오염 불평형'],
        actions: ['윤활유 압력/온도 점검', '진동 정밀진단', '정지 시 축계 점검'],
        leadTime: '수 주 이상 추세 진행 — 조기 포착 시 계획정비 가능.',
      },
    ],
    HE: [
      {
        id: 'HE-FOUL', name: '전열면 오염(fouling)', iso14224: 'PDE (Parameter deviation)',
        mechanism: '스케일·폴리머·생물막 부착으로 총괄전열계수(U) 저하',
        symptoms: [
          { role: 'u_proxy', pattern: 'down', w: 3 },
          { role: 'hot_out', pattern: 'up', w: 2 },
          { role: 'cold_out', pattern: 'down', w: 2 },
          { role: 'dp', pattern: 'up', w: 2 },
          { role: 'approach', pattern: 'up', w: 3 },
        ],
        causes: ['냉각수 수질 저하', '공정측 중합물 부착', '유속 저하로 침적 가속'],
        actions: ['U값·접근온도차 추이 확인', '세정(CIP/기계식) 시기 산정', '냉각수 약품 처리 점검'],
        leadTime: '수개월 단위 완만 진행. ΔP 상승이 겹치면 세정 시기 도래.',
      },
      {
        id: 'HE-LEAK', name: '튜브 누설', iso14224: 'ELP/INL',
        mechanism: '부식·침식·진동 마모에 의한 튜브 관통',
        symptoms: [
          { role: 'dp', pattern: 'down', w: 1 },
          { role: 'cold_out', pattern: 'up', w: 2 },
          { role: 'hot_out', pattern: 'variance', w: 1 },
        ],
        causes: ['튜브 부식 수명', '튜브 진동(유체 유발)', '동결/열충격'],
        actions: ['양측 유체 오염 분석(샘플링)', '차압·온도 프로필 확인', '누설 시험 계획'],
        leadTime: '미세 누설로 시작 → 확산. 공정 오염 위험으로 조기 확인 중요.',
      },
    ],
    EM: [
      {
        id: 'EM-WIND', name: '권선 절연 열화/과열', iso14224: 'OHE (Overheating)',
        mechanism: '절연물 열화, 냉각 불량, 과부하',
        symptoms: [
          { role: 'winding_temp', pattern: 'up', w: 3 },
          { role: 'motor_current', pattern: 'up', w: 2 },
          { role: 'motor_current', pattern: 'variance', w: 1 },
        ],
        causes: ['냉각팬/필터 막힘', '전압 불평형', '과부하 운전', '절연 수명'],
        actions: ['냉각 계통 점검', '절연저항 측정 계획', '부하율 확인', '서모그래피 점검'],
        leadTime: '온도 10°C 상승 시 절연수명 절반 — 추세 감시가 핵심.',
      },
      {
        id: 'EM-BRG', name: '모터 베어링 이상', iso14224: 'VIB',
        mechanism: '그리스 열화, 전식(bearing current), 피로',
        symptoms: [
          { role: 'vibration', pattern: 'up', w: 3 },
          { role: 'bearing_temp_nde', pattern: 'up', w: 2 },
          { role: 'motor_current', pattern: 'variance', w: 1 },
        ],
        causes: ['그리스 보충 주기 초과', 'VFD 전식', '벨트/커플링 장력 이상'],
        actions: ['그리스 보충', '진동 정밀진단', '절연 베어링 검토'],
        leadTime: '수 주~수개월. 진동 추세 상승 시 계획 교체.',
      },
    ],
    VE: [],
  };

  // ---------- 기본 플랜트 모델 (데모: NCC 분해가스 구역 일부) ----------
  // tags[].role 은 FAILURE_LIB의 symptom role과 매칭된다.
  function defaultModel() {
    return {
      version: 2,
      site: { id: 'YC-PC', name: '여천 석유화학단지 (데모)', standard: 'ISA-95 / ISO 14224' },
      areas: [
        {
          id: 'A-100', name: '원료 공급 구역 (Feed Section)',
          units: [
            {
              id: 'U-101', name: '나프타 공급 유닛',
              assets: [
                {
                  id: 'P-101A', name: 'P-101A 나프타 공급펌프 (운전)',
                  class: 'CP', criticality: 'A', driver: 'EM',
                  design: { ratedFlow: 220, ratedHead: 180, ratedCurrent: 92, maxBearingTemp: 85, maxVib: 7.1, alarmVib: 4.5 },
                  tags: [
                    { id: 'FT-101', role: 'flow', desc: '토출 유량', unit: 'm³/h', lo: 120, hi: 260 },
                    { id: 'PT-101', role: 'suction_pressure', desc: '흡입 압력', unit: 'kg/cm²', lo: 1.0, hi: 4.0 },
                    { id: 'PT-102', role: 'discharge_pressure', desc: '토출 압력', unit: 'kg/cm²', lo: 12, hi: 20 },
                    { id: 'TT-103', role: 'bearing_temp_de', desc: '베어링 온도(DE)', unit: '°C', lo: 40, hi: 85 },
                    { id: 'TT-104', role: 'bearing_temp_nde', desc: '베어링 온도(NDE)', unit: '°C', lo: 40, hi: 85 },
                    { id: 'VT-105', role: 'vibration', desc: '진동(overall)', unit: 'mm/s', lo: 0, hi: 7.1 },
                    { id: 'IT-106', role: 'motor_current', desc: '모터 전류', unit: 'A', lo: 40, hi: 100 },
                    { id: 'TT-107', role: 'winding_temp', desc: '모터 권선 온도', unit: '°C', lo: 50, hi: 130 },
                  ],
                },
                {
                  id: 'P-101B', name: 'P-101B 나프타 공급펌프 (예비→병렬운전)',
                  class: 'CP', criticality: 'A', driver: 'EM',
                  design: { ratedFlow: 220, ratedHead: 180, ratedCurrent: 92, maxBearingTemp: 85, maxVib: 7.1, alarmVib: 4.5 },
                  tags: [
                    { id: 'FT-111', role: 'flow', desc: '토출 유량', unit: 'm³/h', lo: 120, hi: 260 },
                    { id: 'PT-111', role: 'suction_pressure', desc: '흡입 압력', unit: 'kg/cm²', lo: 1.0, hi: 4.0 },
                    { id: 'PT-112', role: 'discharge_pressure', desc: '토출 압력', unit: 'kg/cm²', lo: 12, hi: 20 },
                    { id: 'TT-113', role: 'bearing_temp_de', desc: '베어링 온도(DE)', unit: '°C', lo: 40, hi: 85 },
                    { id: 'VT-115', role: 'vibration', desc: '진동(overall)', unit: 'mm/s', lo: 0, hi: 7.1 },
                    { id: 'IT-116', role: 'motor_current', desc: '모터 전류', unit: 'A', lo: 40, hi: 100 },
                    { id: 'TT-117', role: 'winding_temp', desc: '모터 권선 온도', unit: '°C', lo: 50, hi: 130 },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'A-200', name: '분해가스 압축 구역 (Cracked Gas Compression)',
          units: [
            {
              id: 'U-201', name: '분해가스 압축 유닛',
              assets: [
                {
                  id: 'C-201', name: 'C-201 분해가스 압축기 (1단)',
                  class: 'CO', criticality: 'A', driver: 'EM',
                  design: { ratedFlow: 5200, surgeFlow: 3400, maxDischTemp: 105, maxVib: 4.5, ratedCurrent: 420 },
                  tags: [
                    { id: 'FT-201', role: 'suction_flow', desc: '흡입 유량', unit: 'Nm³/h', lo: 3400, hi: 6000 },
                    { id: 'PT-201', role: 'suction_pressure', desc: '흡입 압력', unit: 'kg/cm²', lo: 0.3, hi: 1.5 },
                    { id: 'PT-202', role: 'discharge_pressure', desc: '토출 압력', unit: 'kg/cm²', lo: 3.0, hi: 5.5 },
                    { id: 'TT-203', role: 'discharge_temp', desc: '토출 온도', unit: '°C', lo: 60, hi: 105 },
                    { id: 'VT-204', role: 'vibration', desc: '진동(overall)', unit: 'mm/s', lo: 0, hi: 4.5 },
                    { id: 'TT-205', role: 'bearing_temp', desc: '베어링 온도', unit: '°C', lo: 40, hi: 90 },
                    { id: 'IT-206', role: 'motor_current', desc: '구동모터 전류', unit: 'A', lo: 200, hi: 460 },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'A-300', name: '급냉 구역 (Quench Section)',
          units: [
            {
              id: 'U-301', name: '급냉수 순환 유닛',
              assets: [
                {
                  id: 'E-301', name: 'E-301 급냉수 냉각기 (Shell&Tube)',
                  class: 'HE', criticality: 'B',
                  design: { area: 850, designU: 620, maxDP: 0.8, cleanApproach: 6 },
                  tags: [
                    { id: 'TT-301', role: 'hot_in', desc: '급냉수 입구온도(Shell)', unit: '°C', lo: 60, hi: 90 },
                    { id: 'TT-302', role: 'hot_out', desc: '급냉수 출구온도(Shell)', unit: '°C', lo: 35, hi: 60 },
                    { id: 'TT-303', role: 'cold_in', desc: '냉각수 입구온도(Tube)', unit: '°C', lo: 20, hi: 35 },
                    { id: 'TT-304', role: 'cold_out', desc: '냉각수 출구온도(Tube)', unit: '°C', lo: 28, hi: 48 },
                    { id: 'FT-305', role: 'hot_flow', desc: '급냉수 유량', unit: 'm³/h', lo: 400, hi: 900 },
                    { id: 'PDT-306', role: 'dp', desc: '튜브측 차압', unit: 'kg/cm²', lo: 0.1, hi: 0.8 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  // ---------- 모델 탐색 유틸 ----------
  function listAssets(model) {
    const out = [];
    for (const area of model.areas || []) {
      for (const unit of area.units || []) {
        for (const asset of unit.assets || []) {
          out.push(Object.assign({ areaId: area.id, areaName: area.name, unitId: unit.id, unitName: unit.name }, asset));
        }
      }
    }
    return out;
  }

  function findAsset(model, assetId) {
    return listAssets(model).find(a => a.id === assetId) || null;
  }

  function listTags(model) {
    const out = [];
    for (const a of listAssets(model)) {
      for (const t of a.tags || []) {
        out.push(Object.assign({ assetId: a.id, assetName: a.name, assetClass: a.class }, t));
      }
    }
    return out;
  }

  function tagsByRole(asset) {
    const map = {};
    for (const t of asset.tags || []) {
      if (!map[t.role]) map[t.role] = [];
      map[t.role].push(t);
    }
    return map;
  }

  function failureModesFor(assetClass) {
    return FAILURE_LIB[assetClass] || [];
  }

  // ---------- 증상 → 고장모드 매칭 ----------
  // observed: { role: {up,down,spike,variance,high,low} → 강도 0~1 }
  // 반환: 점수순 후보 [{mode, score, matched[], missing[]}]
  function matchFailureModes(assetClass, observed) {
    const modes = failureModesFor(assetClass);
    const results = [];
    for (const mode of modes) {
      let got = 0, tot = 0;
      const matched = [], missing = [];
      for (const s of mode.symptoms) {
        tot += s.w;
        const obs = observed[s.role];
        const strength = obs ? (obs[s.pattern] || 0) : 0;
        if (strength > 0.15) {
          got += s.w * Math.min(1, strength);
          matched.push({ role: s.role, pattern: s.pattern, strength });
        } else {
          missing.push({ role: s.role, pattern: s.pattern });
        }
      }
      const score = tot > 0 ? got / tot : 0;
      if (score > 0) results.push({ mode, score, matched, missing });
    }
    return results.sort((a, b) => b.score - a.score);
  }

  // ---------- 저장/불러오기 ----------
  const LS_KEY = 'medi.ontology.v2';

  function load() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const m = JSON.parse(raw);
          if (m && m.version === 2) return m;
        }
      }
    } catch (e) { /* 손상 시 기본 모델로 */ }
    return defaultModel();
  }

  function save(model) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(model));
      return true;
    } catch (e) { return false; }
  }

  function reset() {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY); } catch (e) { /* noop */ }
    return defaultModel();
  }

  // ---------- LLM 컨텍스트 직렬화 ----------
  // 자산 서브그래프 + 고장모드 라이브러리 + 관측 증상을 압축 JSON으로.
  function toLLMContext(model, assetId, extra) {
    const asset = findAsset(model, assetId);
    if (!asset) return null;
    const ctx = {
      standard: 'ISO 14224 / ISA-95 / ISA-5.1',
      site: model.site && model.site.name,
      location: { area: asset.areaName, unit: asset.unitName },
      asset: {
        id: asset.id, name: asset.name,
        class: (EQUIP_CLASSES[asset.class] || {}).ko || asset.class,
        criticality: asset.criticality,
        design: asset.design,
        tags: (asset.tags || []).map(t => ({ id: t.id, role: t.role, desc: t.desc, unit: t.unit, normalRange: [t.lo, t.hi] })),
      },
      failureModeLibrary: failureModesFor(asset.class).map(fm => ({
        id: fm.id, name: fm.name, mechanism: fm.mechanism,
        expectedSymptoms: fm.symptoms.map(s => `${s.role}:${s.pattern}(w${s.w})`),
        causes: fm.causes, actions: fm.actions, leadTime: fm.leadTime,
      })),
    };
    return Object.assign(ctx, extra || {});
  }

  return {
    ISA51_FIRST, classifyTag,
    EQUIP_CLASSES, FAILURE_LIB, failureModesFor, matchFailureModes,
    defaultModel, listAssets, findAsset, listTags, tagsByRole,
    load, save, reset, toLLMContext,
  };
});
