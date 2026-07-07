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
    X: { ko: '이벤트/접점(디지털)', measure: 'digital', unit: '' }, // XA 알람접점, XS 상태접점
    Z: { ko: '위치(변위)', measure: 'position', unit: 'µm' },
  };

  // 태그명에서 측정종류 추정: "10-PT-1234A", "PDT-306", "TI_101" 등 처리
  function classifyTag(tagName) {
    const m = String(tagName).toUpperCase().match(/(?:^|[^A-Z])((?:PD|TD)|[AEFIJLPSTVWXZ])[TIRCEGSAQ]{0,3}[-_ ]?\d/);
    if (!m) return { measure: 'unknown', ko: '미분류', unit: '' };
    const key = m[1];
    const def = ISA51_FIRST[key];
    return def ? { measure: def.measure, ko: def.ko, unit: def.unit, letter: key } : { measure: 'unknown', ko: '미분류', unit: '' };
  }

  // ---------- ISO 14224 기반 설비 클래스 ----------
  const EQUIP_CLASSES = {
    CP: { ko: '원심펌프', en: 'Centrifugal pump', iso: 'PU' },
    CO: { ko: '원심압축기', en: 'Centrifugal compressor', iso: 'CO' },
    RC: { ko: '왕복동압축기', en: 'Reciprocating compressor', iso: 'CO' },
    EM: { ko: '전동기', en: 'Electric motor', iso: 'EM' },
    VF: { ko: '인버터(VFD)', en: 'Frequency converter', iso: 'FC' },
    TR: { ko: '변압기', en: 'Power transformer', iso: 'PT' },
    CV: { ko: '제어밸브', en: 'Control valve', iso: 'VA*' }, // 밸브 클래스 코드는 표준 원문 확인 필요
    HE: { ko: '열교환기', en: 'Heat exchanger', iso: 'HE' },
    DC: { ko: '증류탑', en: 'Distillation column', iso: 'VE' },
    FH: { ko: '가열로', en: 'Fired heater', iso: 'HB' },
    CT: { ko: '냉각탑', en: 'Cooling tower', iso: '(시스템)' }, // ISO 14224에 전용 클래스 없음 — 팬은 BL
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
          { role: 'wt_residual', pattern: 'up', w: 4 },
          { role: 'winding_temp', pattern: 'up', w: 1 },
          { role: 'thermal_capacity', pattern: 'up', w: 2 },
          { role: 'thermal_capacity', pattern: 'high', w: 2 },
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
    RC: [
      {
        id: 'RC-VLV', name: '실린더 밸브 누설', iso14224: 'INL',
        mechanism: '밸브 플레이트/스프링 피로, 이물·액적 유입 — 왕복동 압축기 비계획 정지 원인 1위(EFRC 조사)',
        symptoms: [
          { role: 'adiabatic_resid', pattern: 'up', w: 3 },
          { role: 'discharge_temp', pattern: 'up', w: 3 },
          { role: 'capacity_flow', pattern: 'down', w: 2 },
        ],
        causes: ['밸브 피로 파손', '액체 슬러그 유입', '이물질', '맥동/사이징 부적합'],
        actions: ['단열 토출온도 잔차(T_s·r^((k-1)/k) 대비) 확인', '실린더별 밸브캡 온도 측정', '밸브 교체 및 근본원인(액적·맥동) 조사'],
        leadTime: '수일~수주. 방치 시 로드 반전 상실 → 크로스헤드 핀 손상 위험.',
      },
      {
        id: 'RC-RING', name: '피스톤 링/라이더 밴드 마모', iso14224: 'LOO',
        mechanism: '링 블로바이로 체적효율 저하',
        symptoms: [
          { role: 'capacity_flow', pattern: 'down', w: 3 },
          { role: 'discharge_temp', pattern: 'up', w: 1 },
        ],
        causes: ['무급유 운전', '오염 가스', '정렬 불량'],
        actions: ['체적효율 추이 확인', '로드드롭(설치 시) 확인', '오버홀 계획'],
        leadTime: '수주~수개월 완만.',
      },
      {
        id: 'RC-PACK', name: '로드 패킹 마모/누설', iso14224: 'ELP',
        mechanism: '패킹 링 마모 — 벤트 유량 증가(신품 5~10 SCFH → 마모 100+ SCFH)',
        symptoms: [
          { role: 'packing_temp', pattern: 'up', w: 3 },
        ],
        causes: ['로드 마모/스코어링', '윤활 불량', '정렬 불량'],
        actions: ['패킹 벤트 유량/디스턴스피스 압력 확인', '가스 검지', '패킹 교체 계획'],
        leadTime: '수주~수개월, 파손 시 계단식 악화. 인화성 가스 누출 — 안전 주의.',
      },
    ],
    VF: [
      {
        id: 'VF-COOL', name: '냉각 열화 (팬/필터/방열핀)', iso14224: 'OHE',
        mechanism: '냉각팬 베어링 마모·정지, 필터 막힘, 방열핀 오염 → 방열판 온도 상승',
        symptoms: [
          { role: 'hs_residual', pattern: 'up', w: 3 },
          { role: 'heatsink_temp', pattern: 'up', w: 2 },
          { role: 'heatsink_temp', pattern: 'high', w: 2 },
        ],
        causes: ['냉각팬 수명(약 6년 주기 교체 권고)', '필터/방열핀 분진·유막 오염', '판넬 냉각 불량'],
        actions: ['부하 보정 방열판 온도 잔차 확인', '팬 상태·수명 카운터 확인', '필터 청소 후 잔차 복귀 확인'],
        leadTime: '팬 마모는 수주~수개월 완만, 팬 정지는 부하 시 수 시간 내 OH 트립.',
      },
      {
        id: 'VF-CAP', name: 'DC 버스 커패시터 노화', iso14224: 'PDE',
        mechanism: '전해액 증발로 ESR↑/정전용량↓ — 리플은 히스토리안으로 안 보이므로 수명 카운터·UV 트립 통계로 감시',
        symptoms: [
          { role: 'dc_bus_voltage', pattern: 'variance', w: 3 },
          { role: 'dc_bus_voltage', pattern: 'down', w: 2 },
        ],
        causes: ['고온 가속 노화', '수명 도달(전해 커패시터 ~10년)'],
        actions: ['드라이브 자체 수명 카운터(U4-05 등) 확인 — 80~90%에서 교체 계획', '동일 모선 형제 드라이브 대비 저전압 트립률 비교'],
        leadTime: '수개월~수년 완만, 말기 급격(벤팅/단락) 가능.',
      },
      {
        id: 'VF-LOAD', name: '구동계 과부하/기계측 이상', iso14224: 'HIO',
        mechanism: '피구동기 마모·오염으로 "동일 주파수에서" 전류 증가 (부하 상승과의 감별은 주파수-전류 잔차)',
        symptoms: [
          { role: 'if_residual', pattern: 'up', w: 4 },
          { role: 'heatsink_temp', pattern: 'up', w: 1 },
        ],
        causes: ['피구동 펌프/팬 마모·오염', '공정 조건 변화', '커플링 이상'],
        actions: ['주파수-전류 잔차 확인 → 기계/공정팀 통보', '모터·부하측 점검'],
        leadTime: '수일~수주.',
      },
    ],
    TR: [
      {
        id: 'TR-COOL', name: '냉각 성능 저하 (라디에이터/팬)', iso14224: 'OHE',
        mechanism: '라디에이터 오염·팬 고장으로 동일 부하에서 유온 상승 (IEEE C57.91 열모델 잔차로 검출)',
        symptoms: [
          { role: 'cool_residual', pattern: 'up', w: 3 },
          { role: 'top_oil_temp', pattern: 'up', w: 2 },
          { role: 'winding_hotspot', pattern: 'up', w: 2 },
        ],
        causes: ['냉각팬/펌프 고장', '라디에이터 핀 오염(분진+유막)', '라디에이터 밸브 잠김'],
        actions: ['팬 기동 시 유온 하강 여부 확인', '라디에이터 청소/팬 정비', '수리 전 부하 제한'],
        leadTime: '팬 트립은 계단식, 오염은 수주~수개월 완만.',
      },
      {
        id: 'TR-AGING', name: '절연 열화 가속 (과부하)', iso14224: 'OHE',
        mechanism: '핫스팟 110°C 초과 시 절연수명 가속 (6~7°C당 수명 절반 — IEEE C57.91)',
        symptoms: [
          { role: 'winding_hotspot', pattern: 'high', w: 3 },
          { role: 'winding_hotspot', pattern: 'up', w: 2 },
          { role: 'load_current', pattern: 'up', w: 2 },
        ],
        causes: ['지속 과부하', '고외기온', '냉각 열화 동반'],
        actions: ['C57.91 부하 한계 준수', '노화 가속계수 F_AA 누적 관리', '랩 DGA·퓨란 분석'],
        leadTime: '수년 만성 — 추세 감시가 핵심.',
      },
      {
        id: 'TR-OIL', name: '누유/유위 저하', iso14224: 'ELU',
        mechanism: '가스켓/라디에이터/용접부 누유 (유위는 유온에 따라 변하므로 온도 보정 후 판정)',
        symptoms: [
          { role: 'oil_level_c', pattern: 'down', w: 3 },
          { role: 'oil_level', pattern: 'down', w: 2 },
        ],
        causes: ['가스켓 열화', '부식', '밸브 누설'],
        actions: ['누유 지점 탐색', '탈기유 보충', '부흐홀츠 상태 확인'],
        leadTime: '수주~수개월. 활선부 노출 전 조치 필수.',
      },
      {
        id: 'TR-ARC', name: '내부 방전/아크 (가스 발생)', iso14224: 'BRD',
        mechanism: 'H2 급증=부분방전, C2H2=아크 (IEEE C57.104/IEC 60599)',
        symptoms: [
          { role: 'h2_gas', pattern: 'up', w: 3 },
          { role: 'h2_gas', pattern: 'spike', w: 3 },
        ],
        causes: ['절연 파괴 진행', '접속부 이완', '관통 고장 후 손상'],
        actions: ['**즉시 정밀 DGA 랩 분석**', '증가율(ppm/day) 감시 강화', '보호계전 동작 시 재투입 금지'],
        leadTime: '가스 발생 시작 후 수 시간~수 주 — 최우선 대응.',
      },
    ],
    CV: [
      {
        id: 'CV-STIC', name: '스틱션 (고착-미끄럼)', iso14224: 'DOP',
        mechanism: '패킹 과체결·스템 부착물로 정지마찰↑ → AUTO에서 지속 리미트사이클. OP-개도 편차가 데드밴드 폭으로 "진동"하는 것이 핵심 시그니처 (편차의 일방향 증가는 액추에이터 고장)',
        symptoms: [
          { role: 'pos_gap', pattern: 'variance', w: 3 },
          { role: 'pos_gap', pattern: 'spike', w: 2 },
          { role: 'pos_gap', pattern: 'up', w: 1 },
          { role: 'controller_output', pattern: 'spike', w: 1 },
          { role: 'loop_osc', pattern: 'up', w: 1 },
        ],
        causes: ['패킹 과체결/열화', '스템 부식·부착물', '장기 정지 후 고착'],
        actions: ['수동 스텝 테스트로 확인(데드밴드+슬립 점프)', '포지셔너 스틱션 보상', '터닝 시 패킹 정비'],
        leadTime: '수주~수개월 완만 악화, 정지 후 재기동 시 심화.',
      },
      {
        id: 'CV-ACT', name: '액추에이터/공기공급 이상', iso14224: 'DOP',
        mechanism: '다이어프램 누기·공기압 저하로 OP-실개도 편차가 지속 확대 (제어기는 이를 쫓아 OP 상승)',
        symptoms: [
          { role: 'pos_gap', pattern: 'up', w: 3 },
          { role: 'controller_output', pattern: 'up', w: 2 },
        ],
        absent: [
          { role: 'pos_gap', pattern: 'variance', w: 4 }, // 편차가 "진동"하면 스틱션 — 액추에이터 고장 아님
          { role: 'pos_gap', pattern: 'spike', w: 2 },
        ],
        causes: ['계장공기 압력 저하', '다이어프램/씰 누기', 'I/P 드리프트'],
        actions: ['공기공급 압력 확인', '포지셔너 진단(압력) 확인', '다이어프램 교체'],
        leadTime: '누기 시작 후 수일 내 악화 가능.',
      },
      {
        id: 'CV-EROS', name: '트림 마모/침식', iso14224: 'INL',
        mechanism: '캐비테이션·플래싱·슬러리로 트림 침식 → 동일 개도에서 유량 증가(특성 변화)',
        symptoms: [
          { role: 'flow_op_resid', pattern: 'up', w: 3 },
          { role: 'flow_pv', pattern: 'variance', w: 1 },
        ],
        causes: ['캐비테이션/플래싱', '침식성 유체', '트림 재질 부적합'],
        actions: ['기준 운전점 OP 추이 확인', '오프라인 밸브 시그니처 테스트', '트림 경화/재선정'],
        leadTime: '수개월. 침식 채널 형성 후 가속.',
      },
      {
        id: 'CV-PLUG', name: '막힘/개도 부족', iso14224: 'PLU',
        mechanism: '이물·왁스·수화물로 유로 축소 → 동일 유량에 더 큰 개도 필요',
        symptoms: [
          { role: 'flow_op_resid', pattern: 'down', w: 3 },
          { role: 'controller_output', pattern: 'up', w: 2 },
        ],
        causes: ['이물질', '스케일/왁스', '전단 스트레이너 통과물'],
        actions: ['플러싱', '스트레이너 점검', 'OP 포화(>95%) 감시'],
        leadTime: '수일~수주.',
      },
    ],
    DC: [
      {
        id: 'DC-FLOOD', name: '플러딩 (범람)', iso14224: 'PDE',
        mechanism: '증기/액 부하 초과로 트레이 액면 상승 — dP 급상승 + dP 변동성 상승이 전조(수십 분 선행)',
        symptoms: [
          { role: 'dp_top', pattern: 'up', w: 3 },
          { role: 'dp_top', pattern: 'variance', w: 3 },
          { role: 'profile_dt', pattern: 'down', w: 2 },
          { role: 'dp_bottom', pattern: 'up', w: 1 },
        ],
        causes: ['리보일러 과부하', '오염으로 용량 감소', '포밍', '트레이 손상'],
        actions: ['리보일러 듀티/피드 감량', 'dP 변동성(고역통과 σ) 감시', '감마스캔 검토', '포밍 시 소포제'],
        leadTime: '부하 변경 후 수십 분~수 시간. dP σ 상승이 조기 경보.',
      },
      {
        id: 'DC-FOUL', name: '내부 오염 (트레이/충전물)', iso14224: 'PLU',
        mechanism: '중합물·염·부식생성물 침적 → 동일 부하에서 dP 완만 상승, 저부하에서도 조기 플러딩',
        symptoms: [
          { role: 'dp_norm', pattern: 'up', w: 3 },
        ],
        causes: ['중합성 성분', '부식 생성물', '염 석출'],
        actions: ['부하 정규화 dP 추이 확인', '세정 계획 수립', '운전 여유 재평가'],
        leadTime: '수주~수개월 완만.',
      },
      {
        id: 'DC-WEEP', name: '위핑/덤핑 (저부하 누액)', iso14224: 'PDE',
        mechanism: '증기 부하 부족으로 트레이 구멍으로 액 누출 → 분리효율 저하',
        symptoms: [
          { role: 'dp_top', pattern: 'down', w: 2 },
          { role: 'profile_dt', pattern: 'down', w: 2 },
        ],
        causes: ['턴다운 이하 운전', '리보일 부족'],
        actions: ['리보일/환류 증가', '운전범위 조정'],
        leadTime: '즉시 발생, 가역적.',
      },
      {
        id: 'DC-DMG', name: '트레이 손상/붕괴', iso14224: 'STD',
        mechanism: '압력 서지·수격으로 트레이 이탈 — 손상 구간 dP 급락 + 온도구배 소실',
        symptoms: [
          { role: 'dp_top', pattern: 'down', w: 3 },
          { role: 'profile_dt', pattern: 'down', w: 3 },
        ],
        causes: ['수분 유입 급증(수격)', '압력 서지', '슬러그'],
        actions: ['감마스캔', '이력 dP 대비 확인', '터닝 시 보수'],
        leadTime: '사건성(급격) 후 지속.',
      },
    ],
    FH: [
      {
        id: 'FH-COKE', name: '튜브 내부 코킹', iso14224: 'PLU',
        mechanism: '중질 성분 코크 침적 → 동일 COT에 TMT 상승(전형 ~1°F/day), 연료 증가 (API RP 573)',
        symptoms: [
          { role: 'tmt', pattern: 'up', w: 3 },
          { role: 'tmt_cot_gap', pattern: 'up', w: 3 },
          { role: 'fuel_flow', pattern: 'up', w: 2 },
          { role: 'tmt', pattern: 'high', w: 2 },
          { role: 'stack_temp', pattern: 'up', w: 1 },
        ],
        causes: ['저유속 패스', '화염 접촉(임핀지먼트)', '중질 피드'],
        actions: ['TMT-설계한계(API 530 DMT) 마진 관리', '패스별 유량 밸런싱', '디코킹(스팀-에어/피깅) 계획'],
        leadTime: '수주~수개월. TMT가 런렝스 종료 기준.',
      },
      {
        id: 'FH-O2', name: '저산소 불완전연소', iso14224: 'PDE',
        mechanism: '과잉공기 부족 → CO 급증(브레이크스루), 노내 불안정 — 안전 직결',
        symptoms: [
          { role: 'o2', pattern: 'down', w: 3 },
          { role: 'o2', pattern: 'low', w: 3 },
        ],
        causes: ['과화력', '공기 레지스터/댐퍼 부적정', '연료 조성 급변'],
        actions: ['**즉시 O2 2~3%로 복귀** (CO 브레이크스루 마진 확보)', 'API RP 556 인터록 확인', '버너 점검'],
        leadTime: '수 분 — 안전 최우선.',
      },
      {
        id: 'FH-DRAFT', name: '드래프트 이상 (양압/과드래프트)', iso14224: 'PDE',
        mechanism: '아치 양압 시 고온 배가스 누출(위험), 과드래프트 시 공기 침입으로 효율 저하',
        symptoms: [
          { role: 'draft', pattern: 'high', w: 3 },
          { role: 'draft', pattern: 'up', w: 2 },
          { role: 'draft', pattern: 'variance', w: 2 },
        ],
        causes: ['스택 댐퍼 위치', '팬(FD/ID) 이상', '외기 급변'],
        actions: ['아치 드래프트 −0.05~−0.15 inH2O 유지', '양압 시 즉시 조치', '댐퍼/팬 점검'],
        leadTime: '수 분 — 양압은 즉시 대응.',
      },
      {
        id: 'FH-CONV', name: '대류부 오염', iso14224: 'PLU',
        mechanism: '수트/재 침적으로 대류부 흡수 저하 → 스택온도 상승, 효율 저하(스택 22°C당 ~1%)',
        symptoms: [
          { role: 'stack_temp', pattern: 'up', w: 3 },
          { role: 'fuel_flow', pattern: 'up', w: 1 },
        ],
        causes: ['수트 침적', '핀 열화'],
        actions: ['수트블로잉/워터워시', '지거트식 효율 추이 확인'],
        leadTime: '수개월 완만.',
      },
    ],
    CT: [
      {
        id: 'CT-FILL', name: '충전재 오염/스케일', iso14224: 'PDE',
        mechanism: '수질 불량·생물막으로 충전재 전열 저하 → 접근온도차(냉수-습구) 상승. 팬으로 회복 불가',
        symptoms: [
          { role: 'approach', pattern: 'up', w: 3 },
          { role: 'effectiveness', pattern: 'down', w: 2 },
        ],
        causes: ['고농축(COC 과다)', '수처리 불량', '생물막/조류', '비산 이물'],
        actions: ['수처리(농축배수·약품) 감사', '블로다운 증가', '충전재 세정/교체 계획'],
        leadTime: '수주~수개월 완만.',
      },
      {
        id: 'CT-AIR', name: '공기유량 저하 (벨트/피치/팬)', iso14224: 'LOO',
        mechanism: '벨트 슬립·블레이드 피치 이탈로 풍량 감소 (팬동력 ∝ 풍량³ 큐브법칙 잔차로 검출)',
        symptoms: [
          { role: 'fan_power', pattern: 'down', w: 2 },
          { role: 'approach', pattern: 'up', w: 3 },
        ],
        causes: ['벨트 마모/슬립', '블레이드 피치 드리프트', '기어박스 이상'],
        actions: ['벨트 장력/피치 점검', '팬동력 큐브법칙 잔차 확인', '기어박스 오일 분석'],
        leadTime: '벨트는 수일 내 급진행 가능.',
      },
      {
        id: 'CT-DIST', name: '살수 분배 불량', iso14224: 'PLU',
        mechanism: '노즐 막힘·온수분배조 손상으로 편류 → 팬·유량 정상인데 접근온도차 상승',
        symptoms: [
          { role: 'approach', pattern: 'up', w: 2 },
          { role: 'range', pattern: 'down', w: 2 },
        ],
        causes: ['노즐 막힘(이물/스케일)', '분배조 파손'],
        actions: ['분배 데크 육안점검/청소', '노즐 교체'],
        leadTime: '수주.',
      },
    ],
    VE: [],
  };

  // ---------- 계기(트랜스미터) 고장모드 라이브러리 ----------
  // 신호 시그니처는 벤더 자가진단 기능과 동일 원리 — 히스토리안 측에서 근사 검출.
  // NE107: NAMUR NE 107 표준 상태분류 (F=Failure, C=Function Check, S=Out of Spec, M=Maintenance Required)
  const INSTRUMENT_LIB = {
    impulse_plug: {
      name: '임펄스라인 막힘/동결 의심', ne107: 'M (Maintenance Required)',
      mechanism: '도압배관 막힘(슬러리·왁스·수화물) 또는 히트트레이싱 고장에 의한 동결 — 계기가 공정에서 "분리"되어 공정 노이즈(σ)가 급감하고 평균은 유지되다가, 완전 막힘 시 값이 고착됨',
      appliesTo: '압력(PT)·차압(PDT)·유량(FT, DP식)·레벨(LT, DP식)',
      actions: ['현장에서 임펄스라인 블로우다운/퍼지', '히트트레이싱(동절기) 통전 확인', 'HART 진단(막힘 검출 기능) 교차 확인', '3-밸브 매니폴드 조작 이력 확인'],
      vendorRefs: [
        'Emerson Rosemount 3051S Advanced HART Diagnostics(옵션 DA2) — SPM(통계공정감시): 노이즈 σ 감소로 막힘 검출 [공식 기술노트 검증]',
        'Yokogawa EJX 시리즈(옵션 /DG6) — ILBD(임펄스라인 막힘 검출): DPharp 멀티센싱 압력요동 분석, 고압측/저압측/양측 막힘 구분 + 플랜지 온도로 히트트레이스 감시 [공식 문서 검증]',
        'ABB 266(2600T) 시리즈 — PILD(막힘 임펄스라인 검출), HART/PA/FF 표준 탑재 [공식 매뉴얼 검증]',
      ],
    },
    stuck: {
      name: '출력 고착(stuck/frozen) 의심', ne107: 'F (Failure)',
      mechanism: '센서/전자부 고장, 완전 막힘, 통신 홀드 등으로 출력이 변하지 않음 — 노이즈 완전 소실(flatline)이 특징. 제어루프에 들어가 있으면 제어 성능 저하로 직결',
      appliesTo: '모든 아날로그 계기',
      actions: ['현장 지시계와 DCS 값 비교', '해당 태그가 제어 PV면 수동 전환 검토', '계기 전원/루프 전류(4-20mA) 점검', 'HART 상태 진단 확인'],
      vendorRefs: [
        'NAMUR NE 107 상태분류 기준 F(Failure) — 즉시 조치 대상 [표준 검증]',
      ],
    },
    drift: {
      name: '계기 드리프트(영점/스팬) 의심', ne107: 'S (Out of Specification)',
      mechanism: '센서 노화·온도영향·과압이력 등으로 서서히 한 방향으로 치우침 — 연관 신호는 정지 상태인데 한 태그만 단조 이동하면 공정보다 계기 원인 가능성. 이중센서 계기의 Drift Alert와 같은 논리를 태그 간 상관으로 근사',
      appliesTo: '모든 아날로그 계기 (특히 온도 센서)',
      actions: ['교정 이력·주기 확인 후 현장 교정', '이중화 계기면 상호 편차 확인', '온도계는 센서(RTD/TC) 열화 점검', '공정 원인(실제 변화) 배제 후 조치'],
      vendorRefs: [
        'Emerson Rosemount 3144P(이중센서) — Hot Backup(센서 자동절체) + Sensor Drift Alert(두 센서 편차 감시) [공식 PDS 검증]',
        'Yokogawa YTA 시리즈 — 이중 입력·센서 백업 기능',
        'ABB TTH300 — 이중센서 드리프트 감시(허용편차 설정)·센서 리던던시 [공식 매뉴얼 검증]',
      ],
    },
    noisy: {
      name: '과도 노이즈/스파이크 (결선·접지·EMI) 의심', ne107: 'M (Maintenance Required)',
      mechanism: '단자 이완, 실드 접지 불량, 인버터(VFD) 노이즈 유입, 수분 침투 등 — 같은 설비의 다른 태그는 조용한데 한 태그만 스파이크가 반복되면 공정보다 계기·결선 원인 가능성',
      appliesTo: '모든 계기 (VFD 주변 4-20mA 루프 특히 취약)',
      actions: ['단자함 결선·실드 접지 점검', '케이블 루트의 동력선 이격 확인', '루프 전류 파형 확인', '수분/부식 점검'],
      vendorRefs: [
        'NAMUR NE 107 상태분류 기준 M(Maintenance Required) [표준 검증]',
      ],
    },
  };

  // ---------- 제조사 계기 레퍼런스 (현장 사용 벤더: Emerson·Yokogawa·ABB) ----------
  // 용도: 계기 이상 검출 시 현장 확인 포인트(HART 진단 기능명) 안내 + 온톨로지 지식.
  // [검증] 표시는 공식 문서(제품 페이지/매뉴얼/기술노트)로 확인된 항목.
  const VENDOR_REFS = {
    emerson: {
      name: 'Emerson (Rosemount)',
      items: [
        { measure: '압력/차압 (PT·PDT·FT·LT DP식)', models: 'Rosemount 3051 / 3051S', diag: 'Advanced HART Diagnostics Suite(옵션 DA2): SPM 통계공정감시(σ·평균·변동계수)로 임펄스라인 막힘 검출, Power Advisory(루프 전원 열화) [검증]' },
        { measure: '온도 (TT)', models: 'Rosemount 3144P / 644', diag: '이중센서 Hot Backup(무충격 자동절체), Sensor Drift Alert(센서 간 편차 감시, 기본 3°C), 열화 진단 [검증]' },
      ],
    },
    yokogawa: {
      name: 'Yokogawa',
      items: [
        { measure: '압력/차압 (PT·PDT·FT·LT DP식)', models: 'EJX/EJA 시리즈 (DPharp 실리콘 공진 센서)', diag: '옵션 /DG6 고급진단: ILBD 임펄스라인 막힘 검출(고압측/저압측/양측 구분), 플랜지 온도 기반 히트트레이스 감시 [검증]' },
        { measure: '온도 (TT)', models: 'YTA610 / YTA710', diag: '이중 센서 입력, 센서 백업 자동절체, 센서 단선 진단' },
      ],
    },
    abb: {
      name: 'ABB',
      items: [
        { measure: '압력/차압 (PT·PDT·FT·LT DP식)', models: '266 시리즈 (2600T)', diag: 'PILD 막힘 임펄스라인 검출 — HART/PROFIBUS PA/FF 표준 탑재 [검증]' },
        { measure: '온도 (TT)', models: 'TTH300 / TTF300', diag: '이중센서 드리프트 감시(허용편차 설정형), 센서 리던던시(평균+백업), 부식 검출 [검증]' },
      ],
    },
    bently: {
      name: 'Bently Nevada (Baker Hughes)',
      items: [
        { measure: '진동 (VT) — 대형 회전기계', models: '3500 Machinery Protection System + 3300 XL 근접 프로브', diag: 'API 670 기반 상시 보호(랙 타입). 채널별 OK 검출: 신호가 OK 리밋을 벗어나면 "NOT OK"(프로브/케이블 고장) — 갭 전압 중심 약 -9~-11V(3300 XL 8mm 기준) 이탈로 판별. 진동값이 갑자기 0 근처로 떨어지면 기계가 아니라 프로브/케이블 먼저 의심 [검증]' },
        { measure: '상태감시 소프트웨어', models: 'System 1', diag: '3500 랙 데이터 기반 상태감시(궤도·스펙트럼·트렌드). 히스토리안(dataPARC)에는 보통 overall 값만 오므로, 본 시스템이 overall 추세 이상을 잡으면 System 1에서 스펙트럼 정밀진단하는 흐름 권장 [검증]' },
      ],
    },
    atlasCopco: {
      name: 'Atlas Copco (유틸리티/계장 공기 압축기)',
      items: [
        { measure: '압축기 컨트롤러', models: 'Elektronikon Mk5 / Mk5s Touch / Nano', diag: '엘리먼트 토출온도·압력·운전시간·서비스 카운터 감시, 알람/셧다운 이력 보관. SMARTLINK 원격감시로 이메일 경보 [검증]' },
        { measure: '연동 방법', models: '—', diag: '컨트롤러 Modbus/게이트웨이로 토출온도·부하율을 히스토리안에 수집하면 본 시스템의 압축기 로직(온도 잔차·용량 추세)을 그대로 적용 가능' },
      ],
    },
    yokogawaDcs: {
      name: 'Yokogawa DCS/SIS',
      items: [
        { measure: 'DCS', models: 'CENTUM VP', diag: '알람/이벤트 저널 — 공정 알람·조작 이력. 외부 연계는 Exaopc(OPC A&E)·Exaquantum(PIMS) 경유 [검증]' },
        { measure: 'SIS (트립)', models: 'ProSafe-RS', diag: 'SOE(밀리초 단위 사건순서기록) — 트립 시 무엇이 먼저였는지 확정 근거. CENTUM HIS에서 통합 조회 [검증]' },
        { measure: '연동 방법', models: '—', diag: '트립/알람 접점을 XA/XS 태그로 히스토리안에 수집하면 본 시스템이 트립 감지·채터링·선행 알람 분석 수행. 정밀 시각은 SOE로 교차 확인' },
      ],
    },
    protRelay: {
      name: '보호계전기 / 전기 (ANSI·IEEE C37.2)',
      items: [
        { measure: '디바이스 번호', models: 'C37.2 표준', diag: '49 열동(과부하) · 50/51 순시/한시 과전류 · 27/59 부족/과전압 · 46 역상(불평형) · 66 기동횟수 제한 · 86 록아웃(수동 리셋) · 87 차동 · 94 트립 릴레이 [검증]' },
        { measure: '보호계전기 (ABB Relion)', models: 'REF615(피더) · REM615/REM620(모터)', diag: '49M 열동(MPTTR)·66 기동제한(STTPMSU)·46M 역상 내장. 핵심: 열모델의 <열용량 수준>(TEMP_RL, 1.00=동작레벨)을 모니터링 값으로 노출 — IEC 61850/Modbus로 히스토리안 수집 시 트립 전 선행 감시 가능. 이벤트·고장기록(COMTRADE)·웹 HMI [검증]' },
        { measure: '보호계전기 (ABB 구형 RE_54x)', models: 'REF541/543/545 피더 터미널 · REM543/545 머신 터미널', diag: 'CAP505 설정, SPA-bus/LON 통신. IEC 61850 연계는 SPA-ZC 400 어댑터, 상위(히스토리안) 연계는 COM600 게이트웨이(내장 OPC 서버) 경유 [검증]' },
        { measure: '모터 보호계전기 (기타)', models: 'GE Multilin 869, Schneider 등', diag: '트립/알람 이벤트·고장 기록 내장. 트립·알람 접점(a/b접점)을 XA 태그로 수집 → 본 시스템이 아날로그 선행 징후(권선온도·전류·열용량)와 연계 분석 [검증]' },
        { measure: 'Aux Relay / 알람유닛', models: 'ISA 18.1 어나운시에이터', diag: 'first-out 시퀀스(무엇이 먼저 떴는지) 표준. 접점 채터링(반복 단속)은 결선 이완·접점 마모·코일전압 marginal의 대표 증상 (Omron 릴레이 FAQ) [검증]' },
      ],
    },
    common: {
      name: '공통 표준',
      items: [
        { measure: '전 계기', models: 'NAMUR NE 107', diag: '자가진단 상태 4분류: F(Failure)·C(Function Check)·S(Out of Specification)·M(Maintenance Required) — HART/FF/PROFIBUS 공통 채택 [검증]' },
      ],
    },
  };

  // ---------- 기본 플랜트 모델 (데모: NCC 분해가스 구역 일부) ----------
  // tags[].role 은 FAILURE_LIB의 symptom role과 매칭된다.
  function defaultModel() {
    return {
      version: 4,
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
                {
                  id: 'FV-101', name: 'FV-101 나프타 유량 제어밸브',
                  class: 'CV', criticality: 'B',
                  design: { size: '6"', characteristic: 'EQ%', failAction: 'FC' },
                  tags: [
                    { id: 'FT-431', role: 'flow_pv', desc: '유량 (PV)', unit: 'm³/h', lo: 60, hi: 160 },
                    { id: 'ZT-432', role: 'valve_position', desc: '밸브 개도', unit: '%', lo: 5, hi: 95 },
                    { id: 'FY-433', role: 'controller_output', desc: '제어기 출력 (OP)', unit: '%', lo: 5, hi: 95 },
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
                {
                  id: 'C-202', name: 'C-202 부스터 왕복동압축기',
                  class: 'RC', criticality: 'A',
                  design: { ratedFlow: 950, maxDischTemp: 150, k: 1.25, stages: 1 },
                  tags: [
                    { id: 'PT-471', role: 'suction_pressure', desc: '흡입 압력', unit: 'kg/cm²', lo: 2.0, hi: 5.0 },
                    { id: 'PT-472', role: 'discharge_pressure', desc: '토출 압력', unit: 'kg/cm²', lo: 9, hi: 16 },
                    { id: 'TT-473', role: 'suction_temp', desc: '흡입 온도', unit: '°C', lo: 20, hi: 50 },
                    { id: 'TT-474', role: 'discharge_temp', desc: '토출 온도', unit: '°C', lo: 70, hi: 150 },
                    { id: 'FT-475', role: 'capacity_flow', desc: '토출 유량', unit: 'Nm³/h', lo: 600, hi: 1100 },
                    { id: 'TT-476', role: 'packing_temp', desc: '로드 패킹 온도', unit: '°C', lo: 40, hi: 120 },
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
                {
                  id: 'CT-601', name: 'CT-601 냉각탑 (기계통풍 2셀)',
                  class: 'CT', criticality: 'B',
                  design: { designApproach: 5, designRange: 8, cells: 2 },
                  tags: [
                    { id: 'TT-461', role: 'hot_water', desc: '온수(리턴) 온도', unit: '°C', lo: 18, hi: 45 },
                    { id: 'TT-462', role: 'cold_water', desc: '냉수(공급) 온도', unit: '°C', lo: 10, hi: 35 },
                    { id: 'TT-463', role: 'ambient_temp', desc: '외기 온도(습구 프록시)', unit: '°C' },
                    { id: 'JT-464', role: 'fan_power', desc: '팬 전력 (합산)', unit: 'kW', lo: 20, hi: 130 },
                    { id: 'FT-465', role: 'circ_flow', desc: '순환수 유량', unit: 'm³/h', lo: 1200, hi: 2400 },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'A-400', name: '전기 구역 (Electrical)',
          units: [
            {
              id: 'U-401', name: '수배전/구동 유닛',
              assets: [
                {
                  id: 'TR-101', name: 'TR-101 주변압기 (22.9kV/6.6kV)',
                  class: 'TR', criticality: 'A',
                  design: { ratedMVA: 15, ratedCurrent: 1300, coolClass: 'ONAF', hotspotLimit: 110 },
                  tags: [
                    { id: 'TT-421', role: 'top_oil_temp', desc: '상부 유온', unit: '°C', lo: 20, hi: 95 },
                    { id: 'TT-422', role: 'winding_hotspot', desc: '권선온도(WTI)', unit: '°C', lo: 25, hi: 110 },
                    { id: 'IT-423', role: 'load_current', desc: '부하 전류', unit: 'A', lo: 300, hi: 1300 },
                    { id: 'LT-424', role: 'oil_level', desc: '콘서베이터 유위', unit: '%', lo: 25, hi: 85 },
                    { id: 'TT-425', role: 'ambient_temp', desc: '외기 온도', unit: '°C' },
                    { id: 'AT-426', role: 'h2_gas', desc: '용존 수소(H2)', unit: 'ppm', lo: 0, hi: 100 },
                  ],
                },
                {
                  id: 'VFD-401', name: 'VFD-401 인버터 (M-401 구동)',
                  class: 'VF', criticality: 'B',
                  design: { ratedCurrent: 110, ratedPower: 75, dcBusNominal: 650 },
                  tags: [
                    { id: 'TT-411', role: 'heatsink_temp', desc: '방열판 온도', unit: '°C', lo: 25, hi: 85 },
                    { id: 'ET-412', role: 'dc_bus_voltage', desc: 'DC 버스 전압', unit: 'V', lo: 580, hi: 720 },
                    { id: 'IT-413', role: 'output_current', desc: '출력 전류', unit: 'A', lo: 20, hi: 110 },
                    { id: 'ST-414', role: 'output_freq', desc: '출력 주파수', unit: 'Hz', lo: 30, hi: 60 },
                    { id: 'JT-415', role: 'drive_power', desc: '출력 전력', unit: 'kW', lo: 10, hi: 75 },
                  ],
                },
                {
                  id: 'M-401', name: 'M-401 이송펌프 전동기 (인버터 구동)',
                  class: 'EM', criticality: 'B', driver: 'VF',
                  design: { ratedCurrent: 105, ratedKw: 75, insulation: 'F', maxWinding: 130 },
                  tags: [
                    { id: 'IT-401', role: 'motor_current', desc: '모터 전류', unit: 'A', lo: 20, hi: 110 },
                    { id: 'TT-403', role: 'winding_temp', desc: '권선 온도', unit: '°C', lo: 40, hi: 130 },
                    { id: 'TT-404', role: 'bearing_temp_nde', desc: '베어링 온도(NDE)', unit: '°C', lo: 35, hi: 85 },
                    { id: 'VT-405', role: 'vibration', desc: '진동(overall)', unit: 'mm/s', lo: 0, hi: 7.1 },
                    { id: 'ST-406', role: 'speed', desc: '회전수', unit: 'rpm', lo: 900, hi: 1800 },
                    { id: 'XS-407', role: 'run_status', desc: '운전 상태 (Aux Relay 접점)', unit: '', kind: 'digital' },
                    { id: 'XA-408', role: 'protection_trip', desc: '보호계전기 트립 (86 록아웃)', unit: '', kind: 'digital', trip: true },
                    { id: 'XA-409', role: 'thermal_alarm', desc: '열동 알람 접점 (49)', unit: '', kind: 'digital' },
                    { id: 'THL-410', role: 'thermal_capacity', desc: '열용량 사용률 (보호계전기 49 Thermal Level)', unit: '%', lo: 0, hi: 100 },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'A-500', name: '열분해/분리 구역 (Furnace & Separation)',
          units: [
            {
              id: 'U-501', name: '분해로 유닛',
              assets: [
                {
                  id: 'F-501', name: 'F-501 나프타 분해로',
                  class: 'FH', criticality: 'A',
                  design: { dmtLimit: 590, o2Target: 2.8, draftTarget: -1.2 },
                  tags: [
                    { id: 'TT-451', role: 'tmt', desc: '튜브 스킨온도(TMT)', unit: '°C', lo: 480, hi: 590 },
                    { id: 'TT-452', role: 'cot', desc: '코일 출구온도(COT)', unit: '°C', lo: 370, hi: 400 },
                    { id: 'FT-453', role: 'fuel_flow', desc: '연료가스 유량', unit: 'Nm³/h', lo: 25, hi: 60 },
                    { id: 'AT-454', role: 'o2', desc: '배가스 O2', unit: '%', lo: 1.5, hi: 5 },
                    { id: 'PT-455', role: 'draft', desc: '아치 드래프트', unit: 'mmH2O', lo: -4, hi: 0 },
                    { id: 'TT-456', role: 'stack_temp', desc: '스택 온도', unit: '°C', lo: 260, hi: 380 },
                  ],
                },
              ],
            },
            {
              id: 'U-502', name: '분리 유닛',
              assets: [
                {
                  id: 'T-401', name: 'T-401 탈프로판탑',
                  class: 'DC', criticality: 'A',
                  design: { trays: 42, floodDp: 9.0, designFeed: 95 },
                  tags: [
                    { id: 'FT-441', role: 'feed_flow', desc: '피드 유량', unit: 'm³/h', lo: 55, hi: 115 },
                    { id: 'PDT-442', role: 'dp_top', desc: '상부구간 차압', unit: 'kPa', lo: 2, hi: 9 },
                    { id: 'PDT-443', role: 'dp_bottom', desc: '하부구간 차압', unit: 'kPa', lo: 2, hi: 10 },
                    { id: 'TT-444', role: 'tray_temp', desc: '감온 트레이 온도', unit: '°C', lo: 55, hi: 85 },
                    { id: 'TT-445', role: 'top_temp', desc: '탑정 온도', unit: '°C', lo: 40, hi: 60 },
                    { id: 'PT-446', role: 'top_pressure', desc: '탑정 압력', unit: 'kg/cm²', lo: 14, hi: 19 },
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
  // 증거량 보정: 매칭된 증상 가중치 합이 작을수록(단일 증상 모드) 점수를 축소해
  // "증상 1개짜리 모드가 항상 100%"가 되는 편향을 막는다.
  function matchFailureModes(assetClass, observed) {
    const modes = failureModesFor(assetClass);
    const results = [];
    const K = 1.5; // 증거량 축소 상수
    for (const mode of modes) {
      let got = 0, tot = 0, wMatched = 0;
      const matched = [], missing = [];
      for (const s of mode.symptoms) {
        tot += s.w;
        const obs = observed[s.role];
        const strength = obs ? (obs[s.pattern] || 0) : 0;
        if (strength > 0.15) {
          got += s.w * Math.min(1, strength);
          wMatched += s.w;
          matched.push({ role: s.role, pattern: s.pattern, strength });
        } else {
          missing.push({ role: s.role, pattern: s.pattern });
        }
      }
      let raw = tot > 0 ? got / tot : 0;
      // 부재 증상(absent): 이 패턴이 관측되면 해당 모드가 아니라는 감별 증거 → 감점
      if (mode.absent) {
        for (const s of mode.absent) {
          const obs = observed[s.role];
          const strength = obs ? (obs[s.pattern] || 0) : 0;
          if (strength > 0.3) raw = Math.max(0, raw - (s.w / Math.max(tot, 1)) * strength);
        }
      }
      const score = raw * (wMatched / (wMatched + K));
      if (score > 0) results.push({ mode, score, raw, matched, missing });
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
          if (m && m.version === 4) return m;
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
    INSTRUMENT_LIB, VENDOR_REFS,
    defaultModel, listAssets, findAsset, listTags, tagsByRole,
    load, save, reset, toLLMContext,
  };
});
