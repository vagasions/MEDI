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
  };

  // 기본 데모: 2개 시나리오가 이미 진행 중 (베어링 마모 60%, 파울링 45%)
  const DEFAULT_ACTIVE = [
    { id: 'p101a_bearing', startFrac: 0.45, endFrac: 1.35 },  // 히스토리 45% 지점 시작, 아직 진행중
    { id: 'e301_fouling', startFrac: 0.25, endFrac: 1.8 },
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
    }

    return {
      series,
      meta: { t0, stepMs, n, nowMs, active: o.active, seed: o.seed, days: o.days },
    };
  }

  return { SCENARIOS, DEFAULT_ACTIVE, makeSim };
});
