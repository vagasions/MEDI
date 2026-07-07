/* MEDI 예지보전 — 석유화학 공정신호 시뮬레이터
 * 온톨로지의 기본 플랜트 모델(P-101A/B, C-201, E-301)에 대해 물리적으로
 * 상관된 신호를 생성한다. 고장 시나리오(베어링 마모, 캐비테이션, 파울링,
 * 서지 접근, 모터 과열)를 과거 시점부터 주입해 "예지" 상황을 재현한다.
 * 브라우저(window.MEDI.simulator)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.simulator = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 재현 가능한 의사난수 (mulberry32)
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 시나리오 정의: ramp(t) 0→1 진행도에 따라 태그별 효과 적용
  const SCENARIOS = {
    none: { id: 'none', name: '정상 운전', asset: null, desc: '모든 설비 정상' },
    p101a_bearing: {
      id: 'p101a_bearing', name: 'P-101A 베어링 마모 (서서히 진행)', asset: 'P-101A',
      desc: 'DE측 베어링 온도·진동이 수일에 걸쳐 완만히 상승 — 단순 임계값으로는 늦게 잡히는 유형',
    },
    p101a_cavitation: {
      id: 'p101a_cavitation', name: 'P-101A 캐비테이션', asset: 'P-101A',
      desc: '흡입압 저하 + 토출압/유량 변동성 증가 + 진동 스파이크',
    },
    e301_fouling: {
      id: 'e301_fouling', name: 'E-301 열교환기 파울링', asset: 'E-301',
      desc: 'U값 저하로 출구온도 악화 + 차압 완만 상승 — 개별 태그는 정상범위 내',
    },
    c201_surge: {
      id: 'c201_surge', name: 'C-201 서지 접근', asset: 'C-201',
      desc: '흡입유량 감소 + 토출압 상승/맥동 + 간헐 진동 스파이크',
    },
    p101b_motor: {
      id: 'p101b_motor', name: 'P-101B 모터 권선 과열', asset: 'P-101B',
      desc: '권선온도 추세 상승 + 전류 미세 증가 — 냉각 불량 재현',
    },
    fv101_stiction: {
      id: 'fv101_stiction', name: 'FV-101 제어밸브 스틱션', asset: 'FV-101',
      desc: '고착-미끄럼으로 유량 루프 리미트사이클(OP 톱니파+PV 사각파) 발생',
    },
    t401_flooding: {
      id: 't401_flooding', name: 'T-401 증류탑 플러딩 접근', asset: 'T-401',
      desc: '차압 상승 + 차압 변동성 증가 + 온도 프로파일 붕괴',
    },
    f501_coking: {
      id: 'f501_coking', name: 'F-501 분해로 튜브 코킹', asset: 'F-501',
      desc: '동일 COT에서 TMT 완만 상승(~1°F/day) + 연료 증가',
    },
    vfd401_cooling: {
      id: 'vfd401_cooling', name: 'VFD-401 인버터 냉각 열화', asset: 'VFD-401',
      desc: '팬/필터 열화로 부하 대비 방열판 온도 잔차 상승',
    },
    tr101_oil: {
      id: 'tr101_oil', name: 'TR-101 변압기 누유', asset: 'TR-101',
      desc: '온도 보정 유위가 서서히 하강',
    },
    ct601_fouling: {
      id: 'ct601_fouling', name: 'CT-601 냉각탑 충전재 오염', asset: 'CT-601',
      desc: '접근온도차(냉수−습구) 상승 — 팬으로 회복 불가한 유형',
    },
    c202_valve: {
      id: 'c202_valve', name: 'C-202 왕복동압축기 밸브 누설', asset: 'C-202',
      desc: '단열 잔차·토출온도 상승 + 토출량 감소 (왕복동 정지원인 1위)',
    },
    pt202_plug: {
      id: 'pt202_plug', name: 'PT-202 임펄스라인 막힘 (계기)', asset: 'C-201',
      desc: '토출압력 트랜스미터 도압배관 막힘 — 노이즈(σ) 붕괴, 평균 유지 (SPM/ILBD/PILD 시그니처)',
      frac: { startFrac: 0.45, endFrac: 0.8 }, // 최근 구간에서 막힘 완성
    },
    tt113_stuck: {
      id: 'tt113_stuck', name: 'TT-113 출력 고착 (계기)', asset: 'P-101B',
      desc: '베어링 온도 트랜스미터 출력 고착 — flatline, 노이즈 완전 소실',
      frac: { startFrac: 0.45, endFrac: 0.8 },
    },
    m401_trip: {
      id: 'm401_trip', name: 'M-401 과열 → 49 알람 → 86 트립 (전기)', asset: 'M-401',
      desc: '냉각 막힘 과열 진행 → 열동(49) 알람 접점 → 보호계전기(86) 트립 래치, 정지·냉각',
      frac: { startFrac: 0.3, endFrac: 0.97 },
    },
    m401_relay_chatter: {
      id: 'm401_relay_chatter', name: 'M-401 Aux Relay 접점 채터링 (전기)', asset: 'M-401',
      desc: '운전상태 접점이 간헐 반복 단락 — 결선 이완/접점 마모/코일 전압 marginal 시그니처',
      frac: { startFrac: 0.5, endFrac: 0.9 },
    },
  };

  // 기본 데모: 3개 시나리오가 이미 진행 중
  const DEFAULT_ACTIVE = [
    { id: 'p101a_bearing', startFrac: 0.45, endFrac: 1.35 },  // 히스토리 45% 지점 시작, 아직 진행중
    { id: 'e301_fouling', startFrac: 0.25, endFrac: 1.8 },
    { id: 'fv101_stiction', startFrac: 0.55, endFrac: 1.2 },
  ];

  function makeSim(opts) {
    const o = Object.assign({
      days: 7,            // 히스토리 길이
      stepMin: 5,         // 샘플 주기(분)
      seed: 20260707,
      active: DEFAULT_ACTIVE.slice(),
      now: null,          // 기준 시각(ms) — 미지정 시 호출 시점
    }, opts);

    const nowMs = o.now || Date.now();
    const stepMs = o.stepMin * 60000;
    const n = Math.floor(o.days * 24 * 60 / o.stepMin) + 1;
    const t0 = nowMs - (n - 1) * stepMs;
    const rand = rng(o.seed);
    // 가우시안 노이즈 (Box-Muller)
    let spare = null;
    function gauss() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0;
      while (u === 0) u = rand();
      v = rand();
      const m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    }

    // 시나리오 진행도: startFrac~endFrac 구간을 0→1 (S-곡선)
    function progress(scnEntry, i) {
      const f = i / (n - 1);
      if (f < scnEntry.startFrac) return 0;
      const p = (f - scnEntry.startFrac) / Math.max(scnEntry.endFrac - scnEntry.startFrac, 0.01);
      const x = Math.min(1, p);
      return x * x * (3 - 2 * x); // smoothstep
    }

    function activeScn(id) {
      return o.active.find(a => a.id === id) || null;
    }

    // ---------- 신호 생성 ----------
    const series = {}; // tagId → {t:[], v:[]}
    function put(tagId, i, v) {
      if (!series[tagId]) series[tagId] = { t: new Array(n), v: new Array(n) };
      series[tagId].t[i] = t0 + i * stepMs;
      series[tagId].v[i] = Math.round(v * 1000) / 1000;
    }

    // 저주파 운전점 변화 (생산부하 78~98%) + 일변화
    const loadPhase = rand() * 6.28, loadPhase2 = rand() * 6.28;
    function plantLoad(i) {
      const f = i / (n - 1);
      const hrs = (t0 + i * stepMs) / 3600000;
      return 0.88
        + 0.06 * Math.sin(2 * Math.PI * f * 1.7 + loadPhase)
        + 0.04 * Math.sin(2 * Math.PI * f * 4.3 + loadPhase2);
    }
    function ambient(i) { // 주간/야간 냉각수 온도 영향
      const hrs = (t0 + i * stepMs) / 3600000;
      return Math.sin(2 * Math.PI * ((hrs % 24) / 24) - 1.2);
    }

    // FV-101 제어루프 상태 (스틱션 시뮬레이션 — 적분형 제어기 + 고착-미끄럼 밸브)
    let fvOp = 62, fvZt = 62, fvPv = 110;
    let m401Trip = 0, m401W = null, m401Th = 55; // 86 록아웃 래치 + 권선온도·열용량 상태

    for (let i = 0; i < n; i++) {
      const L = plantLoad(i);      // 0.78~0.98
      const amb = ambient(i);      // -1~1

      // ===== P-101A 나프타 공급펌프 =====
      {
        const brg = activeScn('p101a_bearing');
        const cav = activeScn('p101a_cavitation');
        const pBrg = brg ? progress(brg, i) : 0;
        const pCav = cav ? progress(cav, i) : 0;

        const flow = 220 * L * (1 - 0.03 * pCav) + gauss() * 2.2 + (pCav ? gauss() * 4.5 * pCav : 0);
        const sucP = 2.6 - 1.1 * pCav + gauss() * 0.06;
        // 원심펌프: 토출압 = 흡입압 + 정격양정 − k·Q²
        let disP = sucP + 16.5 - 3.2 * Math.pow(flow / 220, 2) + gauss() * 0.12;
        if (pCav > 0.2) disP += gauss() * 0.55 * pCav; // 캐비테이션 맥동
        const vibBase = 2.1 + 0.4 * (L - 0.88) * 5;
        let vib = vibBase + 2.6 * pBrg + gauss() * (0.15 + 0.35 * pBrg);
        if (pCav > 0.3 && rand() < 0.12 * pCav) vib += 1.5 + rand() * 2.5; // 간헐 스파이크
        const brgDE = 58 + 6 * (L - 0.88) * 3 + 14 * pBrg + 1.2 * amb + gauss() * 0.7;
        const brgNDE = 55 + 5 * (L - 0.88) * 3 + 4.5 * pBrg + 1.2 * amb + gauss() * 0.7;
        const cur = 78 * L * (1 + 0.05 * pBrg) * (1 - 0.02 * pCav) + gauss() * 1.1;
        const wind = 96 + 22 * (L - 0.88) * 2.2 + 2.5 * amb + 1.5 * pBrg + gauss() * 0.9;

        put('FT-101', i, flow); put('PT-101', i, sucP); put('PT-102', i, disP);
        put('TT-103', i, brgDE); put('TT-104', i, brgNDE); put('VT-105', i, Math.max(0.3, vib));
        put('IT-106', i, cur); put('TT-107', i, wind);
      }

      // ===== P-101B (병렬 운전, 부하 낮음) =====
      {
        const mot = activeScn('p101b_motor');
        const pMot = mot ? progress(mot, i) : 0;
        const Lb = L * 0.92;
        const flow = 205 * Lb + gauss() * 2.0;
        const sucP = 2.6 + gauss() * 0.05;
        const disP = sucP + 16.2 - 3.1 * Math.pow(flow / 220, 2) + gauss() * 0.11;
        const vib = 1.9 + 0.3 * (Lb - 0.8) * 4 + gauss() * 0.14;
        const brgDE = 56 + 5 * (Lb - 0.8) * 3 + 1.1 * amb + gauss() * 0.65;
        const cur = 72 * Lb * (1 + 0.06 * pMot) + gauss() * 1.0;
        const wind = 94 + 20 * (Lb - 0.8) * 2.2 + 2.4 * amb + 24 * pMot + gauss() * 0.9;
        put('FT-111', i, flow); put('PT-111', i, sucP); put('PT-112', i, disP);
        put('TT-113', i, brgDE); put('VT-115', i, Math.max(0.3, vib));
        put('IT-116', i, cur); put('TT-117', i, wind);
      }

      // ===== C-201 분해가스 압축기 =====
      {
        const srg = activeScn('c201_surge');
        const pSrg = srg ? progress(srg, i) : 0;
        let flow = 5200 * L * (1 - 0.22 * pSrg) + gauss() * 55;
        const sucP = 0.85 + 0.1 * (L - 0.88) + gauss() * 0.02;
        let disP = 4.1 + 0.5 * (L - 0.88) * 2 + 0.55 * pSrg + gauss() * 0.05;
        if (pSrg > 0.4 && rand() < 0.18 * pSrg) { // 서지 맥동
          disP += (rand() - 0.5) * 0.8;
          flow -= rand() * 380;
        }
        const ratio = disP / Math.max(sucP, 0.1);
        const disT = 78 + 9 * (ratio - 4.8) + 2 * (L - 0.88) * 3 + gauss() * 0.8;
        let vib = 2.0 + 0.3 * (L - 0.88) * 4 + gauss() * 0.13;
        if (pSrg > 0.35 && rand() < 0.15 * pSrg) vib += 1.0 + rand() * 1.8;
        const brgT = 62 + 6 * (L - 0.88) * 3 + 1.0 * amb + gauss() * 0.6;
        const cur = 380 * L * (1 + 0.04 * pSrg) + gauss() * 4.5;
        put('FT-201', i, Math.max(3000, flow)); put('PT-201', i, sucP); put('PT-202', i, disP);
        put('TT-203', i, disT); put('VT-204', i, Math.max(0.3, vib));
        put('TT-205', i, brgT); put('IT-206', i, cur);
      }

      // ===== E-301 급냉수 냉각기 =====
      {
        const fou = activeScn('e301_fouling');
        const pFou = fou ? progress(fou, i) : 0;
        const U = 1 - 0.28 * pFou;               // 전열성능 저하
        const hotFlow = 650 * L + gauss() * 8;
        const hotIn = 76 + 3 * (L - 0.88) * 3 + gauss() * 0.5;
        const coldIn = 27.5 + 2.2 * amb + gauss() * 0.3;
        // 유효도-NTU: NTU = UA/(m·cp) — 유량이 늘면 유효도↓, U 저하 시 유효도↓
        // 이래야 Q/LMTD(U·A 추정치)가 부하와 무관해져 파울링만 반영한다
        const ntu = 1.1 * U / Math.max(hotFlow / 650, 0.3);
        const effHX = 1 - Math.exp(-ntu);
        const hotOut = hotIn - effHX * (hotIn - coldIn) + gauss() * 0.35;
        const coldOut = coldIn + 0.82 * effHX * (hotIn - coldIn) * 0.55 + gauss() * 0.3;
        const dp = (0.32 + 0.22 * pFou) * Math.pow(hotFlow / 650, 2) + gauss() * 0.012;
        put('TT-301', i, hotIn); put('TT-302', i, hotOut);
        put('TT-303', i, coldIn); put('TT-304', i, coldOut);
        put('FT-305', i, hotFlow); put('PDT-306', i, dp);
      }

      // ===== FV-101 유량 제어밸브 (스틱션 시뮬레이션) =====
      {
        const stc = activeScn('fv101_stiction');
        const pStc = stc ? progress(stc, i) : 0;
        const sp = 110 * L;
        // 적분형 제어기 (스틱션 없으면 안정 수렴)
        fvOp += 0.10 * (sp - fvPv);
        fvOp = Math.max(8, Math.min(92, fvOp));
        // 고착-미끄럼: |OP-개도| > 데드밴드일 때만 미끄럼 점프 (Choudhury 2-파라미터 간이형)
        const dead = 0.4 + 6.5 * pStc;
        if (Math.abs(fvOp - fvZt) > dead) {
          fvZt += (fvOp - fvZt) - Math.sign(fvOp - fvZt) * dead * 0.55;
        }
        fvPv = fvZt * 1.32 * (0.96 + 0.04 * L) + gauss() * 1.0;
        put('FT-431', i, fvPv); put('ZT-432', i, fvZt); put('FY-433', i, fvOp);
      }

      // ===== T-401 탈프로판탑 =====
      {
        const fld = activeScn('t401_flooding');
        const pFld = fld ? progress(fld, i) : 0;
        const feed = 95 * L + gauss() * 1.4;
        let dpTop = 4.0 * Math.pow(feed / 95, 1.7) + 3.2 * pFld + gauss() * 0.09;
        if (pFld > 0.25 && rand() < 0.2 * pFld) dpTop += rand() * 1.4; // 전조 맥동
        const dpBot = 4.6 * Math.pow(feed / 95, 1.6) + 1.1 * pFld + gauss() * 0.1;
        const topT = 48 + 1.5 * (L - 0.88) * 2 + gauss() * 0.35;
        const trayT = topT + 22 - 9 * pFld + gauss() * 0.45; // 플러딩 시 프로파일 붕괴
        put('FT-441', i, feed); put('PDT-442', i, dpTop); put('PDT-443', i, dpBot);
        put('TT-444', i, trayT); put('TT-445', i, topT);
        put('PT-446', i, 16.5 + 0.4 * (L - 0.88) + gauss() * 0.07);
      }

      // ===== F-501 분해로 =====
      {
        const cok = activeScn('f501_coking');
        const pCok = cok ? progress(cok, i) : 0;
        const cot = 385 + 4 * (L - 0.88) * 2 + gauss() * 1.1; // COT는 제어됨
        const fuel = 42 * L * (1 + 0.11 * pCok) + gauss() * 0.7;
        const tmt = 540 + 20 * (L - 0.88) * 2 + 40 * pCok + gauss() * 2.2;
        const o2 = 2.8 - 0.5 * (L - 0.88) * 2 + gauss() * 0.22;
        const draft = -1.2 + gauss() * 0.16;
        // 코킹은 복사부 현상 — 스택온도 영향은 완만 (대류부 오염과의 감별점)
        const stack = 315 + 10 * (L - 0.88) * 2 + 7 * pCok + gauss() * 2.0;
        put('TT-451', i, tmt); put('TT-452', i, cot); put('FT-453', i, fuel);
        put('AT-454', i, Math.max(0.3, o2)); put('PT-455', i, draft); put('TT-456', i, stack);
      }

      // ===== TR-101 주변압기 =====
      {
        const oil = activeScn('tr101_oil');
        const pOil = oil ? progress(oil, i) : 0;
        const loadI = 1000 * L + gauss() * 14;
        const ambT = 18 + 7 * amb + gauss() * 0.4;
        const K = loadI / 1300;
        const topOil = ambT + 40 * Math.pow(K / 0.7, 1.6) + gauss() * 0.6;
        const wind = topOil + 15 * Math.pow(K / 0.7, 1.6) + gauss() * 0.7;
        const level = 46 + 0.45 * (topOil - 55) - 13 * pOil + gauss() * 0.5; // 유온 팽창 + 누유
        const h2 = 10 + gauss() * 1.4;
        put('TT-421', i, topOil); put('TT-422', i, wind); put('IT-423', i, loadI);
        put('LT-424', i, level); put('TT-425', i, ambT); put('AT-426', i, Math.max(0, h2));
      }

      // ===== VFD-401 인버터 + M-401 전동기 =====
      {
        const col = activeScn('vfd401_cooling');
        const pCol = col ? progress(col, i) : 0;
        const freq = 44 + 9 * L + gauss() * 0.25;
        const outI = 100 * L + gauss() * 1.4;
        const pwr = 66 * Math.pow(L, 1.9) + gauss() * 0.8;
        const hs = 38 + 30 * Math.pow(outI / 110, 2) + 2 * amb + 14 * pCol + gauss() * 0.7;
        const dcv = 650 + 6 * Math.sin(i / 97) + gauss() * 2.4;
        put('TT-411', i, hs); put('ET-412', i, dcv); put('IT-413', i, outI);
        put('ST-414', i, freq); put('JT-415', i, pwr);
        // M-401 (VFD 부하와 연동) — 트립 시나리오: 냉각 막힘 과열 → 49 알람 → 86 트립(래치) → 정지·냉각
        const trip = activeScn('m401_trip');
        const pTrip = trip ? progress(trip, i) : 0;
        if (pTrip >= 0.85) m401Trip = 1; // 86 록아웃은 수동 리셋 전까지 유지
        const mI = m401Trip ? Math.max(0, gauss() * 0.2) : outI * 0.97 * (1 + 0.06 * pTrip) + gauss() * 0.9;
        const wTarget = m401Trip
          ? 30 + 3 * amb                                             // 정지 후 주위온도로 냉각
          : 76 + 42 * Math.pow(mI / 105, 2) + 2 * amb + 26 * pTrip;  // 냉각 막힘 과열 진행
        if (m401W === null) m401W = wTarget;
        m401W += 0.12 * (wTarget - m401W); // 열용량(1차 지연)
        put('IT-401', i, mI);
        put('TT-403', i, m401W + gauss() * 0.9);
        put('TT-404', i, (m401Trip ? 30 + amb : 47 + 10 * (L - 0.8) * 2 + amb) + gauss() * 0.55);
        put('VT-405', i, m401Trip ? 0.05 : Math.max(0.3, 1.6 + 0.4 * (L - 0.8) * 3 + gauss() * 0.12));
        put('ST-406', i, m401Trip ? 0 : freq * 29.5 + gauss() * 3);
        // 디지털 접점: 운전상태(Aux) / 보호계전기 트립(86) / 열동 알람(49)
        const chat = activeScn('m401_relay_chatter');
        const pChat = chat ? progress(chat, i) : 0;
        let runSt = m401Trip ? 0 : 1;
        if (!m401Trip && pChat > 0.3 && rand() < 0.18 * pChat) runSt = 0; // 접점 채터링: 간헐 순간 단락
        put('XS-407', i, runSt);
        put('XA-408', i, m401Trip);
        put('XA-409', i, m401Trip || pTrip > 0.55 ? 1 : 0); // 트립 전 열동(49) 알람 선행
        // 보호계전기 아날로그 출력: 49 열모델의 열용량 사용률(%) — I²에 1차 지연 추종
        const thTarget = m401Trip ? 4 : Math.min(105, 72 * Math.pow(mI / 105, 2) + 34 * pTrip);
        m401Th += 0.15 * (thTarget - m401Th);
        put('THL-410', i, Math.max(0, Math.min(100, m401Th + gauss() * 0.5)));
      }

      // ===== CT-601 냉각탑 =====
      {
        const fil = activeScn('ct601_fouling');
        const pFil = fil ? progress(fil, i) : 0;
        const ambT = 20 + 6 * amb + gauss() * 0.4;
        const wb = ambT - 3.5; // 습구 근사
        const approach = 4.5 + 3.6 * pFil + gauss() * 0.25;
        const cold = wb + approach;
        const hot = cold + 8 * L + gauss() * 0.35;
        const fanP = 92 + 12 * (L - 0.88) * 2 + 5 * pFil + gauss() * 1.6; // 오염 시 팬 증속 시도
        put('TT-461', i, hot); put('TT-462', i, cold); put('TT-463', i, ambT);
        put('JT-464', i, fanP); put('FT-465', i, 1800 * L + gauss() * 22);
      }

      // ===== C-202 부스터 왕복동압축기 =====
      {
        const vlv = activeScn('c202_valve');
        const pVlv = vlv ? progress(vlv, i) : 0;
        const Ps = 3.2 + 0.3 * (L - 0.88) + gauss() * 0.05;
        const Pd = 12.5 + 1.4 * (L - 0.88) * 2 + gauss() * 0.12;
        const Ts = 32 + 2.5 * amb + gauss() * 0.5;
        // 단열 토출온도 (k=1.25) — 밸브 누설 시 재압축으로 초과 상승
        const r = (Pd + 1.03) / (Ps + 1.03);
        const tdIdeal = (Ts + 273.15) * Math.pow(r, 0.2) - 273.15;
        const Td = tdIdeal * 0.93 + 16 * pVlv + gauss() * 1.0;
        const cap = 950 * L * (1 - 0.07 * pVlv) + gauss() * 9;
        const pack = 64 + 10 * (L - 0.88) * 2 + gauss() * 0.7;
        put('PT-471', i, Ps); put('PT-472', i, Pd); put('TT-473', i, Ts);
        put('TT-474', i, Td); put('FT-475', i, cap); put('TT-476', i, pack);
      }
    }

    // ---------- 계기 고장 시나리오 (신호 후처리) ----------
    // 임펄스라인 막힘: 저역통과 혼합 → 노이즈 붕괴·평균 유지 / 출력 고착: 값 유지(flatline)
    const INSTR_FAULTS = { pt202_plug: { tag: 'PT-202', kind: 'plug' }, tt113_stuck: { tag: 'TT-113', kind: 'stuck' } };
    for (const [sid, f] of Object.entries(INSTR_FAULTS)) {
      const scn = activeScn(sid);
      const s = scn && series[f.tag];
      if (!s) continue;
      if (f.kind === 'plug') {
        let sm = s.v[0];
        for (let i = 0; i < n; i++) {
          sm += 0.08 * (s.v[i] - sm);
          const p = progress(scn, i);
          if (p > 0) s.v[i] = Math.round((s.v[i] * (1 - p) + sm * p) * 1000) / 1000;
        }
      } else if (f.kind === 'stuck') {
        let hold = null;
        for (let i = 0; i < n; i++) {
          if (hold === null && progress(scn, i) >= 0.5) hold = s.v[i];
          if (hold !== null) s.v[i] = hold;
        }
      }
    }

    return {
      series,
      meta: { t0, stepMs, n, nowMs, active: o.active, seed: o.seed, days: o.days },
    };
  }

  return { SCENARIOS, DEFAULT_ACTIVE, makeSim };
});
