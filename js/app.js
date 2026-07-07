/* MEDI 예지보전 — 앱 셸 (상태, 라우팅, 뷰)
 * 100% 룰베이스로 동작. LLM은 설정에서 키 입력 시에만 활성화되는 선택 기능.
 */
(function () {
  'use strict';
  const { stats, mv, equip, health, ontology, simulator, datasource, charts, report, llm, patterns, adv } = window.MEDI;

  // ---------- 상태 ----------
  const LS_SETTINGS = 'medi.settings.v1';
  const S = {
    view: 'dashboard',
    source: null,
    model: ontology.load(),
    seriesMap: {},
    results: [],          // [{asset, analysis, health}]
    alarmEngine: health.createAlarmEngine({ mOfN: [2, 3], offDelay: 2 }),
    selectedAsset: null,
    lastUpdate: null,
    loading: false,
    loadError: null,
    timer: null,
    patternTab: 'regression',
    settings: loadSettings(),
    llmBusy: false,
    llmOut: '',
  };

  function loadSettings() {
    const def = {
      mode: 'demo',
      gatewayUrl: 'http://localhost:8137',
      recentHours: 24,
      scenarios: simulator.DEFAULT_ACTIVE.map(a => a.id),
      autoRefresh: true,
    };
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) return Object.assign(def, JSON.parse(raw));
    } catch (e) { /* 기본값 사용 */ }
    return def;
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(S.settings)); } catch (e) { /* noop */ }
  }

  // ---------- 유틸 ----------
  const $ = sel => document.querySelector(sel);
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTimeShort(ms) {
    const d = new Date(ms);
    const p = x => String(x).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 간이 마크다운 렌더러 (리포트 표시용 — 신뢰된 내부 생성 텍스트 전용)
  function md2html(src) {
    const lines = String(src).split('\n');
    const out = [];
    let inUl = false, inTable = false, inCode = false;
    const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
    const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; } };
    const inline = t => esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const line of lines) {
      if (line.startsWith('```')) {
        closeUl(); closeTable();
        out.push(inCode ? '</pre>' : '<pre>');
        inCode = !inCode;
        continue;
      }
      if (inCode) { out.push(esc(line)); continue; }
      if (/^\|/.test(line)) {
        closeUl();
        if (/^\|[\s:-]+\|/.test(line.replace(/\|/g, '|').trim()) && /^[\s|:-]+$/.test(line)) continue; // 구분행
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (!inTable) { out.push('<table>'); inTable = true; out.push('<tr>' + cells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr>'); }
        else out.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
        continue;
      }
      closeTable();
      if (/^### /.test(line)) { closeUl(); out.push(`<h3>${inline(line.slice(4))}</h3>`); }
      else if (/^## /.test(line)) { closeUl(); out.push(`<h2>${inline(line.slice(3))}</h2>`); }
      else if (/^# /.test(line)) { closeUl(); out.push(`<h1>${inline(line.slice(2))}</h1>`); }
      else if (/^> /.test(line)) { closeUl(); out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); }
      else if (/^- /.test(line)) { if (!inUl) { out.push('<ul>'); inUl = true; } out.push(`<li>${inline(line.slice(2))}</li>`); }
      else if (line.trim() === '') { closeUl(); }
      else { closeUl(); out.push(`<p>${inline(line)}</p>`); }
    }
    closeUl(); closeTable();
    if (inCode) out.push('</pre>');
    return out.join('\n');
  }

  // ---------- 데이터 파이프라인 ----------
  async function initSource() {
    const st = S.settings;
    if (st.mode === 'gateway') {
      S.source = datasource.createGatewaySource(st.gatewayUrl, { hours: Math.max(st.recentHours * 4, 72) });
    } else if (st.mode === 'csv' && S.csvSeries) {
      S.source = datasource.createCsvSource(S.csvSeries, S.csvLabel);
    } else {
      const active = st.scenarios.map(id => {
        const d = simulator.DEFAULT_ACTIVE.find(a => a.id === id);
        const sc = simulator.SCENARIOS[id];
        return d || (sc && sc.frac ? Object.assign({ id }, sc.frac) : { id, startFrac: 0.5, endFrac: 1.4 });
      });
      S.source = datasource.createDemoSource({ active });
    }
    await S.source.init();
  }

  async function refreshData() {
    if (S.loading) return;
    S.loading = true; S.loadError = null;
    render();
    try {
      if (!S.source) await initSource();
      else await S.source.refresh();
      S.seriesMap = await S.source.getSeriesMap();
      analyzeAll();
      S.lastUpdate = Date.now();
    } catch (e) {
      S.loadError = e.message || String(e);
    }
    S.loading = false;
    render();
  }

  function analyzeAll() {
    const assets = ontology.listAssets(S.model);
    S.results = assets.map(asset => {
      const analysis = equip.analyzeAsset(asset, S.seriesMap, { recentHours: S.settings.recentHours });
      const h = health.computeHealth(analysis);
      return { asset, analysis, health: h };
    });
    // 알람 평가 — 첫 분석은 히스토리 전체를 본 결과이므로 m-of-n을 채워 즉시 반영
    const now = Date.now();
    let conds = [];
    for (const r of S.results) {
      if (r.analysis && r.analysis.ok) {
        conds = conds.concat(health.conditionsFromAnalysis(r.asset, r.analysis, r.health));
      }
    }
    const firstRun = S.alarmEngine.events.length === 0 && Object.keys(S.alarmEngine.states).length === 0;
    const rounds = firstRun ? 2 : 1;
    for (let i = 0; i < rounds; i++) S.alarmEngine.evaluate(conds, now);
  }

  function scheduleAutoRefresh() {
    if (S.timer) clearInterval(S.timer);
    if (S.settings.autoRefresh && S.settings.mode !== 'csv') {
      S.timer = setInterval(refreshData, 60000);
    }
  }

  function resultFor(assetId) {
    return S.results.find(r => r.asset.id === assetId) || null;
  }

  // ---------- 네비게이션 ----------
  const NAV = [
    { group: '감시' },
    { id: 'dashboard', ico: '📊', name: '대시보드' },
    { id: 'asset', ico: '⚙️', name: '설비 상세' },
    { id: 'alarms', ico: '🔔', name: '알람 / 이벤트' },
    { group: '분석' },
    { id: 'trends', ico: '📈', name: '트렌드 분석' },
    { id: 'patterns', ico: '🎓', name: '분석 실습 (5패턴)' },
    { id: 'report', ico: '📋', name: '진단 리포트' },
    { group: '지식 / 시스템' },
    { id: 'ontology', ico: '🕸️', name: '자산 온톨로지' },
    { id: 'settings', ico: '🔧', name: '설정 / 연동' },
  ];

  function go(view, assetId) {
    S.view = view;
    if (assetId) S.selectedAsset = assetId;
    render();
    window.scrollTo(0, 0);
  }

  // ---------- 렌더 루트 ----------
  function render() {
    const activeAlarms = S.alarmEngine.activeEvents().filter(e => e.state === 'active').length;
    const app = $('#app');
    app.innerHTML = `
      <div class="sidebar">
        <div class="logo">MEDI <span>PdM</span></div>
        <div class="tagline">설비 예지보전 · dataPARC 연동</div>
        ${NAV.map(n => n.group
          ? `<div class="nav-group">${n.group}</div>`
          : `<button class="nav-item ${S.view === n.id ? 'active' : ''}" data-nav="${n.id}">
              <span class="ico">${n.ico}</span>${n.name}
              ${n.id === 'alarms' && activeAlarms ? `<span class="nav-badge">${activeAlarms}</span>` : ''}
            </button>`).join('')}
        <div class="foot">
          ${esc((S.source && S.source.info().desc) || '데이터소스 초기화 중')}<br>
          룰베이스 엔진 v1 · AI 분석은 선택 기능
        </div>
      </div>
      <div class="main" id="main"></div>
    `;
    app.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));

    const main = $('#main');
    main.classList.add('view-enter');
    if (S.loading && !S.results.length) {
      main.innerHTML = `<div class="loading"><span class="spin"></span><br>데이터 로딩 / 분석 중…</div>`;
      return;
    }
    switch (S.view) {
      case 'dashboard': viewDashboard(main); break;
      case 'asset': viewAsset(main); break;
      case 'trends': viewTrends(main); break;
      case 'patterns': viewPatterns(main); break;
      case 'alarms': viewAlarms(main); break;
      case 'ontology': viewOntology(main); break;
      case 'report': viewReport(main); break;
      case 'settings': viewSettings(main); break;
      default: viewDashboard(main);
    }
  }

  function topbar(title, extra) {
    const src = S.source ? S.source.info() : { desc: '-' };
    return `
      <div class="topbar">
        <h1>${esc(title)}</h1>
        <span class="src-chip">📡 ${esc(src.desc || src.mode)}</span>
        <div class="spacer"></div>
        ${extra || ''}
        <span class="updated">${S.lastUpdate ? '갱신 ' + new Date(S.lastUpdate).toLocaleTimeString('ko-KR') : ''}</span>
        <button class="btn small" id="btn-refresh">↻ 새로고침</button>
      </div>
      ${S.loadError ? `<div class="notice warn">⚠ 데이터 로드 오류: ${esc(S.loadError)} — 설정에서 데이터소스를 확인하세요.</div>` : ''}
    `;
  }
  function wireTopbar() {
    const b = $('#btn-refresh');
    if (b) b.addEventListener('click', refreshData);
  }

  // 접이식 "쉽게 설명" 박스 — items: [[용어, 비유 설명], ...]
  function explainBox(title, items) {
    return `<details class="explain"><summary>${esc(title)}</summary><div class="ex-body">${
      items.map(([k, v]) => `<div class="ex-item"><span class="ex-k">${esc(k)}</span> — ${v}</div>`).join('')
    }</div></details>`;
  }

  // ---------- 뷰: 대시보드 ----------
  function viewDashboard(main) {
    const total = S.results.length;
    const warnCnt = S.results.filter(r => r.health.grade === 'warn' || r.health.grade === 'alarm').length;
    const watchCnt = S.results.filter(r => r.health.grade === 'watch').length;
    const active = S.alarmEngine.activeEvents();
    const points = Object.values(S.seriesMap).reduce((a, s) => a + (s.t ? s.t.length : 0), 0);

    main.innerHTML = `
      ${topbar('설비 건강 대시보드')}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="kpi"><div class="kpi-label">감시 설비</div><div class="kpi-value">${total}</div><div class="kpi-sub">태그 ${Object.keys(S.seriesMap).length}개 · ${points.toLocaleString()} 포인트</div></div>
        <div class="kpi ${warnCnt ? 'k-alarm' : 'k-good'}"><div class="kpi-label">주의/경고 설비</div><div class="kpi-value">${warnCnt}</div><div class="kpi-sub">관찰 ${watchCnt}건</div></div>
        <div class="kpi ${active.length ? 'k-warn' : 'k-good'}"><div class="kpi-label">활성 알람</div><div class="kpi-value">${active.length}</div><div class="kpi-sub">이벤트 누적 ${S.alarmEngine.events.length}건</div></div>
        <div class="kpi"><div class="kpi-label">분석 방식</div><div class="kpi-value" style="font-size:17px;padding-top:6px">룰베이스</div><div class="kpi-sub">SPC + PCA(T²/SPE) + 고장모드 매칭</div></div>
      </div>

      <div class="grid cols-2" id="asset-cards"></div>

      <div class="panel">
        <h2>🔔 활성 알람 ${active.length ? `(${active.length})` : '— 없음'}</h2>
        <div id="dash-alarms"></div>
      </div>
    `;
    wireTopbar();

    // 설비 카드
    const cardsEl = $('#asset-cards');
    for (const r of S.results) {
      const a = r.asset, h = r.health;
      const top = r.analysis && r.analysis.ok && r.analysis.candidates[0];
      const card = document.createElement('div');
      card.className = `asset-card g-${h.grade}`;
      card.innerHTML = `
        <div class="ac-head">
          <canvas class="gauge" width="84" height="84"></canvas>
          <div style="flex:1">
            <div class="ac-name">${esc(a.name)}</div>
            <div class="ac-loc">${esc(a.areaName)} · ${esc((ontology.EQUIP_CLASSES[a.class] || {}).ko || a.class)} · 등급 ${esc(a.criticality || '-')}</div>
            <div style="margin-top:4px"><span class="badge g-${h.grade}">${report.gradeKo(h.grade)}</span></div>
          </div>
        </div>
        <div class="ac-fm">${r.analysis && r.analysis.ok && r.analysis.tripped
          ? '<span style="color:var(--alarm)">⚡ 보호계전기 트립 (86 록아웃) — 정지 중</span>'
          : top && top.score >= 0.4
          ? `⚠ 의심: <span class="fm-name">${esc(top.mode.name)}</span> (일치도 ${(top.score * 100).toFixed(0)}%)`
          : '<span class="muted">유의미한 고장모드 징후 없음</span>'}${
          (r.analysis && r.analysis.ok && r.analysis.instruments && r.analysis.instruments.length)
            ? `<div style="margin-top:3px">🔧 계기 점검: ${r.analysis.instruments.map(i => esc(i.tagId)).join(', ')}</div>` : ''}</div>
        <div class="ac-sparks"></div>
      `;
      card.addEventListener('click', () => go('asset', a.id));
      cardsEl.appendChild(card);
      charts.gauge(card.querySelector('.gauge'), h.score);

      // 주요 태그 4개 스파크라인
      const sparks = card.querySelector('.ac-sparks');
      const keyTags = (a.tags || []).slice(0, 4);
      for (const t of keyTags) {
        const s = S.seriesMap[t.id];
        if (!s) continue;
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div class="spark-label">${esc(t.id)} ${esc(t.desc)}</div><canvas></canvas>`;
        sparks.appendChild(wrap);
        const d = r.analysis && r.analysis.ok && r.analysis.tagDiag[t.id];
        const color = d && (d.up > 0.65 || d.down > 0.65 || d.high > 0.5 || d.variance > 0.65) ? '#ff9800' : '#4fc3f7';
        charts.sparkline(wrap.querySelector('canvas'), s.v.slice(-200), { color, height: 30 });
      }
    }

    renderAlarmList($('#dash-alarms'), active.slice(0, 8), false);
    if (!active.length) $('#dash-alarms').innerHTML = '<div class="empty"><span class="empty-ico">✅</span>현재 활성 알람이 없습니다.<br>이상 징후가 감지되면 여기와 좌측 배지에 표시됩니다.</div>';
  }

  // ---------- 뷰: 설비 상세 ----------
  function viewAsset(main) {
    const assets = ontology.listAssets(S.model);
    if (!S.selectedAsset && assets.length) S.selectedAsset = assets[0].id;
    const r = resultFor(S.selectedAsset);

    main.innerHTML = `
      ${topbar('설비 상세 진단')}
      <div class="form-row">
        <label>설비 선택</label>
        <select id="asset-sel">${assets.map(a => `<option value="${a.id}" ${a.id === S.selectedAsset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      </div>
      <div id="asset-body"></div>
    `;
    wireTopbar();
    $('#asset-sel').addEventListener('change', e => { S.selectedAsset = e.target.value; render(); });

    const body = $('#asset-body');
    if (!r || !r.analysis || !r.analysis.ok) {
      body.innerHTML = `<div class="notice warn">분석 데이터가 없습니다 ${r && r.analysis ? '— ' + esc(r.analysis.reason || '') : ''}</div>`;
      return;
    }
    const a = r.asset, an = r.analysis;
    const top3 = an.candidates.slice(0, 3).filter(c => c.score > 0.15);

    body.innerHTML = `
      <div class="grid cols-3" style="margin-bottom:16px">
        <div class="kpi"><div class="kpi-label">건강지수</div><div class="kpi-value" style="color:${gradeColor(r.health.grade)}">${r.health.score}</div><div class="kpi-sub">${report.gradeKo(r.health.grade)}</div></div>
        <div class="kpi"><div class="kpi-label">최우선 의심 고장모드</div><div class="kpi-value" style="font-size:16px;padding-top:8px">${top3[0] ? esc(top3[0].mode.name) : '없음'}</div><div class="kpi-sub">${top3[0] ? '증상 일치도 ' + (top3[0].score * 100).toFixed(0) + '%' : '정상 패턴'}</div></div>
        <div class="kpi"><div class="kpi-label">다변량 상태 (T² / SPE 위반율)</div><div class="kpi-value" style="font-size:16px;padding-top:8px">${an.mv ? `${(an.mv.t2ViolFrac * 100).toFixed(0)}% / ${(an.mv.speViolFrac * 100).toFixed(0)}%` : '-'}</div><div class="kpi-sub">최근 ${S.settings.recentHours}시간</div></div>
      </div>

      ${explainBox('건강지수는 어떻게 계산되나요? (쉽게 설명)', [
        ['감점 방식', '100점에서 시작해 <b>근거가 있는 항목만</b> 깎습니다 — 다변량 이탈, 고장모드 일치, 설계한계 접근, 트립/알람 접점. 어떤 항목에서 몇 점 깎였는지가 항상 함께 표시되므로 "왜 이 점수인지" 역추적이 됩니다.'],
        ['등급', '85점 이상 양호 · 70~84 관찰 · 50~69 주의 · 50 미만 경고. 보호계전기 트립(86)이 걸려 있으면 통계와 무관하게 즉시 경고 등급입니다.'],
        ['오탐 억제', '한 가지 원인이 여러 항목을 동시에 깎는 중복 감점은 40점 이후 체감(60%)되고, 최신 기법(iForest·ECOD) 감점은 고전 지표가 동조할 때만 반영됩니다.'],
      ])}

      <div class="panel">
        <h2>주요 신호 트렌드 (베이스라인 대비)</h2>
        ${explainBox('베이스라인 밴드와 σ(시그마)가 뭔가요?', [
          ['베이스라인', '히스토리 <b>앞 40%</b> 구간을 "정상이었을 때"의 기준으로 삼습니다. 밴드(띠)는 그 시절 평균 ± 3σ 범위 — 신호가 띠를 벗어나 움직이면 기준에서 멀어진 것입니다.'],
          ['σ(시그마) 단위', '신호마다 단위(°C, kg/cm²…)가 달라 비교가 안 되므로, "평소 출렁임의 몇 배나 움직였나"로 통일해 셉니다. +3σ = 평소 변동폭의 3배만큼 위로 이동.'],
        ])}
        <div id="tag-charts" class="grid cols-2"></div>
      </div>

      <div class="panel">
        <h2>다변량 감시 — 여러 신호의 "관계"로 잡는 이상</h2>
        <div class="pattern-note">개별 태그가 정상범위여도 신호 간 상관구조가 무너지면(SPE↑) 설비 이상의 조기 신호입니다. 단순 임계값 알람으로는 잡히지 않는 유형입니다.</div>
        ${explainBox('T²와 SPE, 쉽게 말하면?', [
          ['T² (운전점 이탈)', '여러 신호를 한 점으로 묶어 "정상 운전 구름"에서 얼마나 멀어졌는지 재는 거리입니다. 구름 밖으로 나가면 운전 상태 자체가 낯설다는 뜻.'],
          ['SPE (관계 붕괴)', '"토출압력과 전류는 항상 같이 움직인다" 같은 <b>신호 사이의 관계</b>가 깨졌는지 봅니다. 키가 큰데 몸무게가 그대로면 이상하듯 — 각 값이 전부 정상범위여도 관계가 깨지면 경보. 단순 임계값 알람이 절대 못 잡는 유형입니다.'],
          ['기여도', '경보가 뜨면 어느 태그가 관계를 깼는지 지분(%)으로 지목합니다 — 현장에서 어디부터 볼지 알려주는 용도.'],
        ])}
        <div class="grid cols-2">
          <div class="chart-box"><h3>Hotelling T² (운전점 이탈)</h3><canvas id="ch-t2"></canvas></div>
          <div class="chart-box"><h3>SPE/Q (상관구조 붕괴)</h3><canvas id="ch-spe"></canvas></div>
        </div>
        <div id="mv-contrib" style="margin-top:10px"></div>
      </div>

      <div class="panel">
        <h2>최신 검증 기법 — 논문 기반 고급 진단</h2>
        <div class="pattern-note">
          Isolation Forest(ICDM 2008)·ECOD(TKDE 2022)가 <strong>비선형 복합 이상</strong>을, PELT 변화점(JASA 2012)이 <strong>열화 시작 시점</strong>을,
          Matrix Profile(ICDM 2016)이 <strong>과거에 없던 파형</strong>을 찾습니다. 두 검출기 합의 시에만 건강지수에 반영해 오탐을 억제합니다.
        </div>
        ${explainBox('네 가지 기법, 쉽게 말하면?', [
          ['Isolation Forest', '스무고개처럼 무작위 질문으로 데이터를 나눌 때 몇 번 만에 혼자 고립되면 이상치입니다. 정상 데이터는 무리 속에 있어 오래 걸립니다. 숲(트리 100개)의 평균 답이 점수.'],
          ['ECOD', '각 신호의 히스토그램에서 값이 꼬리(극단)에 있는 정도를 전부 더한 점수. 조절할 파라미터가 <b>0개</b>라 튜닝 실수가 원천 차단됩니다.'],
          ['PELT 변화점', '그래프를 "통계 성질이 같은 구간"으로 자동 분할합니다. 잘린 지점 = 열화가 시작된 시점 — 정비 이력과 대조할 때 유용.'],
          ['Matrix Profile', '파형을 조각내 과거 전체와 대조해 <b>과거에 한 번도 없던 모양</b>을 찾습니다. 값의 크기가 아니라 "모양"의 이상을 봅니다.'],
          ['RUL 근사', '열화 시작 이후 추세를 지수곡선으로 연장해 상한 도달 시점을 역산합니다. 어디까지나 근사치 — 정비 시기 "계획"의 참고용이지 보증이 아닙니다.'],
          ['왜 합의를 요구하나', '두 검출기(iForest·ECOD)가 <b>모두</b> 이상이라 하고, 고전 지표(SPE/고장모드)까지 동조할 때만 점수에 반영합니다. 새로운 운전점 이동을 고장으로 오인하는 것을 막기 위해서입니다.'],
        ])}
        <div id="adv-facts" style="margin-bottom:10px"></div>
        <div class="grid cols-2" id="adv-charts"></div>
      </div>

      <div class="panel" id="valve-panel" style="display:none">
        <h2>밸브 진단 — 논문 검증 기법</h2>
        <div class="pattern-note">
          제어밸브: ACF 진동 검출(Thornhill 2003) + PV-OP 타원 적합 스틱션 정량화(Choudhury 2006) + 이동량/반전 카운트(포지셔너 진단 지표).
          온오프/차단밸브: 스트로크 시간 추세 + 지령-리미트 정합 — SIS 부분행정시험(PST, IEC 61511 실무)의 히스토리안 근사.
        </div>
        ${explainBox('밸브 진단, 쉽게 말하면?', [
          ['진동 검출 (ACF)', '신호의 "자기 자신과의 닮음"이 일정한 간격으로 반복되면 진동입니다. 간격이 고를수록(r>1) 밸브 문제, 들쑥날쑥하면 외란일 가능성. 저희 임계는 Thornhill 논문 그대로.'],
          ['스틱션 정량화 (타원)', '제어기 출력(OP)과 유량(PV)을 가로세로로 그리면, 스틱션 루프는 <b>타원</b>을 그립니다. 타원의 가로 폭이 "겉보기 스틱션(%)" — 밸브가 움직이기 전에 OP가 헛도는 양입니다. 3% 넘으면 정비 대상으로 보는 것이 통례.'],
          ['이동량/반전', '개도의 하루 누적 이동량과 방향 반전 횟수. 갑자기 늘면 루프 헌팅(패킹 수명 단축), 0에 가까우면 밸브가 안 움직이는 것.'],
          ['스트로크 시간', '차단밸브가 열리고 닫히는 데 걸리는 시간. 느려지는 추세 = 액추에이터/공기계통 열화 — 완전 고착 전에 잡는 것이 PST의 목적.'],
        ])}
        <div id="valve-facts" style="margin-bottom:10px"></div>
      </div>

      <div class="panel" id="dig-panel" style="display:none">
        <h2>전기/디지털 신호 — 트립 · 알람 접점 · 상태</h2>
        <div class="pattern-note">
          보호계전기 트립(86 록아웃), 열동 알람(49), Aux Relay 상태 접점 등 0/1 신호를 아날로그와 분리 진단합니다.
          트립은 래치이므로 접점 1 = 리셋 전 상태, 반복 단속(채터링)은 결선·접점 문제의 대표 증상입니다. 정밀 사건순서는 SIS의 SOE 기록으로 교차 확인하세요.
        </div>
        ${explainBox('트립·채터링, 쉽게 말하면?', [
          ['86 록아웃 트립', '한 번 걸리면 스스로 풀리지 않는 <b>자물쇠(래치)</b>입니다. 접점이 1이면 아직 리셋 전 — 원인을 밝히기 전에 재기동하면 같은 사고가 반복되므로, 선행 신호(권선온도·전류 추세)와 49 알람 순서를 먼저 봅니다.'],
          ['숫자의 의미(ANSI C37.2)', '계전기 이름의 숫자는 세계 공통 약속: 49 열동(과부하) · 50/51 과전류 · 86 록아웃 · 87 차동. 도면과 알람 메시지에서 같은 번호를 쓰므로 그대로 통합니다.'],
          ['채터링', '스위치가 혼자 딸깍거리는 것 — 접점 마모·결선 이완·코일 전압 부족의 대표 증상. 완전히 죽기 전에 "가끔 끊기는" 시기가 먼저 오므로, 이때 잡으면 계획 정비로 끝납니다.'],
        ])}
        <div id="dig-cards"></div>
      </div>

      <div class="panel">
        <h2>계기 건전성 — 트랜스미터 자가진단 시그니처</h2>
        <div class="pattern-note">
          공정 이상과 <strong>계기 자체 고장</strong>(임펄스라인 막힘·출력 고착·드리프트·결선 노이즈)을 분리 진단합니다.
          스마트 트랜스미터 진단(Rosemount SPM · Yokogawa ILBD · ABB PILD)과 같은 신호 시그니처를 히스토리안 측에서 검사 — NAMUR NE 107 분류로 표시.
        </div>
        ${explainBox('계기 고장은 어떻게 신호만 보고 아나요?', [
          ['막힘 = 조용해짐', '임펄스라인이 막히면 계기가 공정에서 분리되어 <b>잔떨림(노이즈)이 사라집니다</b>. 값은 그대로인데 "너무 조용"하면 막힘 의심 — Rosemount SPM·Yokogawa ILBD·ABB PILD가 계기 안에서 하는 판정과 같은 원리입니다.'],
          ['고착 = 완전 정지', '출력이 몇 시간째 소수점까지 똑같으면 flatline. 살아있는 공정 신호는 반드시 미세하게 떨립니다. (밸브 개도는 스틱션 때 원래 몇 시간 멈추므로 더 긴 기준 적용)'],
          ['드리프트 = 혼자 이동', '연관된 다른 신호는 가만히 있는데 한 태그만 서서히 한 방향으로 가면, 공정보다 계기(영점 밀림) 가능성. 고장 사전으로 설명되는 경우(누유로 유위만 하강 등)는 제외합니다.'],
          ['확정은 현장에서', '여기서의 판정은 "의심 단계"입니다. 트랜스미터의 HART 진단(NE 107 상태)으로 교차 확인 후 조치하세요.'],
        ])}
        <div id="instr-cards"></div>
      </div>

      <div class="panel">
        <h2>고장모드 후보 (ISO 14224 라이브러리 매칭)</h2>
        ${explainBox('일치도 %는 어떻게 나오나요?', [
          ['증상 대조', '관측된 패턴 조합(베어링온도 상승 + 진동 상승 + 전류 상승…)을 고장 사전의 "증상 시그니처"와 대조해 가중 일치율을 냅니다.'],
          ['우연 일치 방지', '증상 1~2개짜리 우연 일치는 점수를 자동으로 깎고(증거가 적을수록 보수적), "이 고장이면 반드시 보여야 하는데 안 보이는 증상"은 감점합니다 — 감별 포인트로 함께 표시.'],
          ['활용법', '1위 후보의 권고 조치부터 확인하되, 일치도 40% 미만은 참고 수준으로만.'],
        ])}
        <div id="fm-cards"></div>
      </div>
    `;

    // 태그 차트: 이상 강도 순 상위 6개
    const diag = Object.entries(an.tagDiag).map(([id, d]) => ({ id, d, score: Math.max(d.up, d.down, d.variance, d.spike, d.high, d.low) }));
    diag.sort((x, y) => y.score - x.score);
    const chartsEl = $('#tag-charts');
    for (const { id, d } of diag.slice(0, 6)) {
      const s = S.seriesMap[id];
      if (!s) continue;
      const box = document.createElement('div');
      box.className = 'chart-box';
      box.innerHTML = `<h3>${esc(id)} — ${esc(d.desc || '')} <span class="faint">(${d.zShift >= 0 ? '+' : ''}${d.zShift.toFixed(1)}σ)</span></h3><canvas></canvas>`;
      chartsEl.appendChild(box);
      const tag = (a.tags || []).find(t => t.id === id) || {};
      const bandHi = s.t.map(() => d.baseMean + 3 * d.baseStd);
      const bandLo = s.t.map(() => d.baseMean - 3 * d.baseStd);
      charts.lineChart(box.querySelector('canvas'), {
        height: 190,
        series: [{ name: id, t: s.t, v: s.v, color: d.zShift > 1 || d.high > 0.3 ? '#ff9800' : '#4fc3f7' }],
        bands: [{ t: s.t, lo: bandLo, hi: bandHi, color: 'rgba(102,187,106,0.07)' }],
        thresholds: [
          ...(tag.hi !== undefined ? [{ y: tag.hi, label: `상한 ${tag.hi}`, color: '#ef5350' }] : []),
          { y: d.baseMean, label: '', color: 'rgba(160,180,200,0.35)' },
        ],
      });
    }

    // 다변량 차트
    if (an.mv) {
      charts.lineChart($('#ch-t2'), {
        height: 180,
        series: [{ name: 'T²', t: an.mv.t, v: an.mv.t2, color: '#ba68c8' }],
        thresholds: [{ y: an.mv.t2Limit, label: 'UCL', color: '#ef5350' }],
      });
      charts.lineChart($('#ch-spe'), {
        height: 180,
        series: [{ name: 'SPE', t: an.mv.t, v: an.mv.spe, color: '#4db6ac' }],
        thresholds: [{ y: an.mv.speLimit, label: 'UCL', color: '#ef5350' }],
      });
      $('#mv-contrib').innerHTML = `<span class="muted">현재 이상 기여 상위 태그:</span> ${an.mv.topContributors.map(c => `<span class="tag-chip on" style="cursor:default">${esc(c.name)} ${(c.share * 100).toFixed(0)}%</span>`).join(' ')}`;
    } else {
      $('#ch-t2').parentElement.parentElement.innerHTML = '<div class="faint">다변량 모델 구성 불가 (데이터/태그 부족)</div>';
    }

    // 최신 기법 패널
    if (an.adv) {
      const adv = an.adv;
      const facts = [];
      const consensus = Math.min(adv.iforest.recentFrac, adv.ecod.recentFrac);
      facts.push(`<span class="tag-chip ${consensus > 0.15 ? 'on' : ''}" style="cursor:default">iForest 최근 초과 ${(adv.iforest.recentFrac * 100).toFixed(0)}%</span>`);
      facts.push(`<span class="tag-chip ${consensus > 0.15 ? 'on' : ''}" style="cursor:default">ECOD 최근 초과 ${(adv.ecod.recentFrac * 100).toFixed(0)}%</span>`);
      const corroborated = consensus > 0.15 || (an.candidates && an.candidates[0] && an.candidates[0].score > 0.3);
      if (adv.onset && corroborated) facts.push(`<span class="tag-chip on" style="cursor:default">열화 시작(PELT): ${fmtTimeShort(adv.onset.t)}</span>`);
      if (adv.rul && adv.rul.hoursLeft !== null) {
        const h = adv.rul.hoursLeft;
        facts.push(`<span class="tag-chip on" style="cursor:default;color:var(--warn);border-color:var(--warn)">RUL 근사: ${adv.rul.tagId} 상한 도달 ~${h < 48 ? h.toFixed(0) + '시간' : (h / 24).toFixed(1) + '일'} 후 (R²=${adv.rul.r2})</span>`);
      }
      $('#adv-facts').innerHTML = facts.join(' ');

      const advCharts = $('#adv-charts');
      // iForest 점수
      const box1 = document.createElement('div');
      box1.className = 'chart-box';
      box1.innerHTML = '<h3>Isolation Forest 이상점수 (0.5≈정상)</h3><canvas></canvas>';
      advCharts.appendChild(box1);
      charts.lineChart(box1.querySelector('canvas'), {
        height: 180,
        series: [{ name: 'iForest', t: adv.t, v: adv.iforest.scores, color: '#f06292' }],
        thresholds: [{ y: adv.iforest.threshold, label: '경험적 한계', color: '#ef5350' }],
        vlines: adv.onset && corroborated ? [{ t: adv.onset.t, label: '열화 시작', color: 'rgba(255,213,79,0.8)' }] : [],
      });
      // Matrix Profile
      if (adv.discord) {
        const box2 = document.createElement('div');
        box2.className = 'chart-box';
        box2.innerHTML = `<h3>Matrix Profile — ${esc(adv.discord.tagId)} 형태 이상 거리</h3><canvas></canvas>`;
        advCharts.appendChild(box2);
        charts.lineChart(box2.querySelector('canvas'), {
          height: 180,
          series: [{ name: 'MP', t: adv.discord.mpT, v: adv.discord.mp, color: '#4db6ac' }],
          vlines: adv.discord.windows.map((w, i) => ({ t: w.t, label: i === 0 ? '디스코드' : '', color: 'rgba(239,83,80,0.7)' })),
        });
      }
    } else {
      $('#adv-facts').innerHTML = '<span class="faint">데이터가 부족해 고급 진단을 생략했습니다.</span>';
    }

    // 고장모드 카드
    const fmEl = $('#fm-cards');
    if (!top3.length) fmEl.innerHTML = '<div class="faint">유의미하게 일치하는 고장모드가 없습니다.</div>';
    for (const c of top3) {
      const div = document.createElement('div');
      div.className = 'panel';
      div.style.background = 'var(--bg2)';
      div.innerHTML = `
        <h3 style="margin-top:0">${esc(c.mode.name)} <span class="badge ${c.score > 0.6 ? 'g-alarm' : c.score > 0.4 ? 'g-warn' : 'g-watch'}">${(c.score * 100).toFixed(0)}%</span></h3>
        <div class="muted" style="font-size:12.5px">메커니즘: ${esc(c.mode.mechanism)}</div>
        <div style="font-size:12.5px;margin-top:6px">관측 증상: ${c.matched.map(m => `<code>${esc(m.role)}:${esc(health.patternKo(m.pattern))}</code>`).join(' ') || '없음'}</div>
        ${c.missing.length ? `<div class="faint" style="margin-top:4px">감별 포인트(미관측): ${c.missing.map(m => `${esc(m.role)}:${esc(health.patternKo(m.pattern))}`).join(', ')}</div>` : ''}
        <div style="font-size:12.5px;margin-top:6px"><strong>권고 조치</strong>: ${esc(c.mode.actions.join(' → '))}</div>
        <div class="faint" style="margin-top:4px">${esc(c.mode.leadTime)}</div>
      `;
      fmEl.appendChild(div);
    }

    // 밸브 진단 패널 (CV/OV)
    if (an.valve) {
      $('#valve-panel').style.display = '';
      const v = an.valve;
      const chips = [];
      if (v.kind === 'CV') {
        chips.push(`<span class="tag-chip ${v.osc.oscillating ? 'on' : ''}" style="cursor:default">진동 ${v.osc.oscillating ? `규칙적 (주기 ${v.osc.periodMin.toFixed(0)}분)` : v.osc.periodMin ? `불규칙 (주기 추정 ${v.osc.periodMin.toFixed(0)}분, r=${v.osc.r.toFixed(2)})` : '미검출'}</span>`);
        if (v.stiction) chips.push(`<span class="tag-chip on" style="cursor:default;color:var(--warn);border-color:var(--warn)">겉보기 스틱션 ${v.stiction.apparent.toFixed(1)}% (타원적합 ${(v.stiction.fit * 100).toFixed(0)}%) — 3% 초과 시 정비 검토</span>`);
        if (v.travel) chips.push(`<span class="tag-chip ${v.travel.travelRatio > 2 ? 'on' : ''}" style="cursor:default">이동량 ${v.travel.recent.travelPerDay.toFixed(0)}%/일 (평시 ${v.travel.base.travelPerDay.toFixed(0)}) · 반전 ${v.travel.recent.reversalsPerDay.toFixed(1)}회/일</span>`);
      } else if (v.kind === 'OV') {
        chips.push(`<span class="tag-chip" style="cursor:default">최근 24h 작동 ${v.recentOps}회 (누적 ${v.ops}회)</span>`);
        chips.push(`<span class="tag-chip ${v.recentMismatchFrac > 0.05 ? 'on' : ''}" style="cursor:default;${v.recentMismatchFrac > 0.05 ? 'color:var(--alarm);border-color:var(--alarm)' : ''}">지령-리미트 불일치 ${(v.recentMismatchFrac * 100).toFixed(1)}%${v.recentMismatchFrac > 0.05 ? ' — 현장 확인 필요' : ''}</span>`);
        const stTag = (a.tags || []).find(t => t.role === 'stroke_time');
        const st = stTag && an.tagDiag[stTag.id];
        if (st) chips.push(`<span class="tag-chip ${st.zShift > 2 ? 'on' : ''}" style="cursor:default">스트로크 시간 ${st.lastValue.toFixed(1)}s (평시 ${st.baseMean.toFixed(1)}s${st.zShift > 2 ? `, +${st.zShift.toFixed(1)}σ 증가 추세` : ''})</span>`);
      }
      $('#valve-facts').innerHTML = chips.join(' ');
    }

    // 전기/디지털 신호 카드
    const digEntries = Object.entries(an.digital || {});
    if (digEntries.length) {
      $('#dig-panel').style.display = '';
      const digEl = $('#dig-cards');
      digEl.innerHTML = digEntries.map(([tagId, d]) => {
        const isTrip = d.trip && d.state === 1;
        const isAlm = !d.trip && d.state === 1 && d.role !== 'run_status';
        const isChat = d.chatter > 0.3;
        const stateTxt = d.trip ? (d.state ? '트립 (래치)' : '정상')
          : d.role === 'run_status' ? (d.state ? '운전 중' : '정지')
          : (d.state ? '알람 활성' : '정상');
        const cls = isTrip ? 'g-alarm' : (isAlm || isChat) ? 'g-warn' : 'g-good';
        return `
          <div class="panel" style="background:var(--bg2)">
            <h3 style="margin-top:0">${esc(tagId)} — ${esc(d.desc)}
              <span class="badge ${cls}">${esc(stateTxt)}</span>
              ${isChat ? '<span class="badge g-warn">채터링</span>' : ''}</h3>
            <div style="font-size:12.5px" class="muted">
              최근 24h: 상태변화 ${d.edgesRecent}회 (시간당 ${d.ratePerHour.toFixed(1)} · 평시 ${d.baseRatePerHour.toFixed(1)}) ·
              활성시간 ${(d.activeFrac * 100).toFixed(0)}%
              ${d.lastChange ? ` · 마지막 변화 ${new Date(d.lastChange).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
            </div>
            ${isTrip ? '<div style="font-size:12.5px;margin-top:6px;color:var(--alarm)"><strong>86 록아웃 — 원인 규명·리셋 전 재기동 금지.</strong> 선행 신호(권선온도·전류·49 알람)와 SOE 기록으로 원인 추적.</div>' : ''}
            ${isChat ? '<div style="font-size:12.5px;margin-top:6px"><strong>확인 순서</strong>: 단자 결선 조임 → 접점 마모/코일 전압 확인 → 릴레이 교체 검토 (채터링은 결선 이완·접점 마모·코일전압 marginal의 대표 증상)</div>' : ''}
          </div>`;
      }).join('');
    }

    // 계기 건전성 카드
    const insEl = $('#instr-cards');
    const insList = an.instruments || [];
    if (!insList.length) {
      insEl.innerHTML = '<div class="faint">계기 이상 징후 없음 — 전 태그 노이즈·응답 정상 범위.</div>';
    }
    for (const ins of insList) {
      const lib = ontology.INSTRUMENT_LIB[ins.type] || {};
      const div = document.createElement('div');
      div.className = 'panel';
      div.style.background = 'var(--bg2)';
      div.innerHTML = `
        <h3 style="margin-top:0">${esc(ins.tagId)} — ${esc(lib.name || ins.type)}
          <span class="badge ${ins.sev > 0.7 ? 'g-alarm' : 'g-warn'}">${(ins.sev * 100).toFixed(0)}%</span>
          <span class="tag-chip" style="cursor:default">NE 107: ${esc(lib.ne107 || '-')}</span></h3>
        <div style="font-size:12.5px;margin-top:4px">근거: ${esc(ins.evidence)}</div>
        <div class="muted" style="font-size:12.5px;margin-top:4px">메커니즘: ${esc(lib.mechanism || '')}</div>
        ${lib.actions ? `<div style="font-size:12.5px;margin-top:6px"><strong>확인 순서</strong>: ${esc(lib.actions.join(' → '))}</div>` : ''}
        ${lib.vendorRefs ? `<div class="faint" style="margin-top:6px">${lib.vendorRefs.map(r => `· ${esc(r)}`).join('<br>')}</div>` : ''}
      `;
      insEl.appendChild(div);
    }
  }

  function gradeColor(g) {
    return { good: 'var(--good)', watch: 'var(--watch)', warn: 'var(--warn)', alarm: 'var(--alarm)' }[g] || 'var(--text-dim)';
  }

  // ---------- 뷰: 트렌드 ----------
  function viewTrends(main) {
    const assets = ontology.listAssets(S.model);
    if (!S.selectedAsset && assets.length) S.selectedAsset = assets[0].id;
    const asset = ontology.findAsset(S.model, S.selectedAsset) || assets[0];
    if (!S.trendTags) S.trendTags = {};
    const tagIds = (asset && asset.tags || []).map(t => t.id).filter(id => S.seriesMap[id]);
    // CSV 모드처럼 온톨로지 밖 태그도 있으면 표시
    const extraTags = Object.keys(S.seriesMap).filter(id => !ontology.listTags(S.model).some(t => t.id === id));
    const allIds = tagIds.concat(extraTags);
    if (!S.trendSel || !S.trendSel.length || !S.trendSel.some(id => allIds.includes(id))) {
      S.trendSel = allIds.slice(0, 2);
    }

    main.innerHTML = `
      ${topbar('트렌드 분석 (SPC 오버레이)')}
      <div class="panel">
        <div class="form-row">
          <label>설비</label>
          <select id="tr-asset">${assets.map(a => `<option value="${a.id}" ${a.id === S.selectedAsset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <label class="chk"><input type="checkbox" id="tr-ewma" ${S.trendEwma ? 'checked' : ''}> EWMA 관리한계</label>
          <label class="chk"><input type="checkbox" id="tr-rules" ${S.trendRules ? 'checked' : ''}> 런규칙 위반 표시</label>
        </div>
        <div class="tag-chips" id="tr-chips">
          ${allIds.map(id => `<button class="tag-chip ${S.trendSel.includes(id) ? 'on' : ''}" data-tag="${esc(id)}">${esc(id)}</button>`).join('')}
        </div>
        ${explainBox('EWMA·런규칙, 쉽게 말하면?', [
          ['EWMA', '최근 값에 더 큰 가중치를 준 평균선입니다. 저울 눈금이 조금씩 밀리는 것처럼 <b>작지만 지속되는 이동</b>을 원본 그래프보다 훨씬 빨리 알아챕니다. 주황 선이 점선 한계를 넘으면 위반.'],
          ['CUSUM (알람에 사용)', '기준보다 조금씩 넘친 양을 저금통처럼 계속 모읍니다. 하루하루는 티가 안 나도 쌓이면 임계를 넘어 경보 — 1σ급 미세 이동에 가장 민감한 기법.'],
          ['런규칙', '동전을 던져 앞면만 9번 연속 나오면 우연이 아니듯, 평균 위로만 연속 9점·연속 상승 6점 같은 "우연히 나오기 힘든 패턴"을 잡습니다(Western Electric/Nelson 규칙).'],
        ])}
      </div>
      <div class="panel"><div id="tr-charts"></div></div>
      <div class="panel">
        <h2>신호 상관 행렬 — "같이 움직여야 할 신호"를 찾는다</h2>
        <div class="pattern-note">상관이 높던 신호쌍의 상관이 깨지면 설비 이상 신호입니다. 다변량(SPE) 감시의 근거이기도 합니다.</div>
        <canvas id="tr-heat"></canvas>
      </div>
    `;
    wireTopbar();
    $('#tr-asset').addEventListener('change', e => { S.selectedAsset = e.target.value; S.trendSel = null; render(); });
    $('#tr-ewma').addEventListener('change', e => { S.trendEwma = e.target.checked; render(); });
    $('#tr-rules').addEventListener('change', e => { S.trendRules = e.target.checked; render(); });
    document.querySelectorAll('#tr-chips .tag-chip').forEach(ch => ch.addEventListener('click', () => {
      const id = ch.dataset.tag;
      if (S.trendSel.includes(id)) S.trendSel = S.trendSel.filter(x => x !== id);
      else S.trendSel.push(id);
      render();
    }));

    // 차트
    const wrap = $('#tr-charts');
    for (const id of S.trendSel) {
      const s = S.seriesMap[id];
      if (!s || s.t.length < 10) continue;
      const box = document.createElement('div');
      box.className = 'chart-box';
      box.innerHTML = `<h3>${esc(id)}</h3><canvas></canvas>`;
      wrap.appendChild(box);
      const n = s.v.length;
      const baseN = Math.max(20, Math.floor(n * 0.4));
      const base = s.v.slice(0, baseN);
      const mu = stats.mean(base), sd = Math.max(stats.robustStd(base), 1e-9);
      const cfg = {
        height: 210,
        series: [{ name: id, t: s.t, v: s.v, color: '#4fc3f7' }],
        thresholds: [{ y: mu, label: '', color: 'rgba(160,180,200,0.3)' }],
        vlines: [],
      };
      if (S.trendEwma) {
        const ew = stats.ewmaChart(s.v, { mu, sigma: sd });
        cfg.series.push({ name: 'EWMA', t: s.t, v: ew.z, color: '#ffb74d', width: 1.4 });
        cfg.bands = [{ t: s.t, lo: ew.lcl, hi: ew.ucl, color: 'rgba(255,183,77,0.07)' }];
      }
      if (S.trendRules) {
        const rr = stats.runRules(s.v.slice(baseN), { mu, sigma: sd });
        const marks = [].concat(rr.r1, rr.r5).slice(0, 12);
        for (const m of marks) {
          cfg.vlines.push({ t: s.t[baseN + m.i], label: '', color: 'rgba(239,83,80,0.5)' });
        }
      }
      charts.lineChart(box.querySelector('canvas'), cfg);
    }
    if (!S.trendSel.length) wrap.innerHTML = '<div class="faint">태그를 선택하세요.</div>';

    // 상관행렬 (선택 설비의 전체 태그)
    const corrIds = tagIds.slice(0, 10);
    if (corrIds.length >= 2) {
      const aligned = equip.alignSeries(S.seriesMap, corrIds);
      if (aligned.t.length > 20) {
        const X = aligned.t.map((_, i) => aligned.ids.map(id => aligned.cols[id][i]));
        const R = mv.corrMatrix(X);
        charts.heatmap($('#tr-heat'), R, aligned.ids);
      }
    } else {
      $('#tr-heat').parentElement.innerHTML += '<div class="faint">태그가 2개 이상 필요합니다.</div>';
    }
  }

  // ---------- 뷰: 5대 분석 패턴 실습 ----------
  const PATTERN_TABS = [
    { id: 'regression', name: '① 회귀' },
    { id: 'classification', name: '② 분류' },
    { id: 'clustering', name: '③ 군집' },
    { id: 'anomaly', name: '④ 이상탐지' },
    { id: 'timeseries', name: '⑤ 시계열 예측' },
  ];

  function viewPatterns(main) {
    const allTagIds = Object.keys(S.seriesMap);
    main.innerHTML = `
      ${topbar('분석 실습 — 5대 분석 패턴')}
      <div class="notice">
        회귀·분류·군집·이상탐지·시계열의 5대 패턴을 <strong>현재 로드된 데이터</strong>(데모/현장/CSV)로 직접 실행해 보는 실습 공간입니다.
        전부 룰베이스/통계 기법 — AI 불필요. 설정에서 <strong>내 업무 데이터(CSV)</strong>를 올리면 같은 분석을 바로 돌릴 수 있습니다.
      </div>
      ${explainBox('5대 패턴을 한 문장씩으로', [
        ['① 회귀', '"유량이 이만큼이면 전류는 이만큼"처럼 신호 사이의 <b>수식 관계</b>를 찾고, 관계에서 벗어나는 순간(잔차 증가)을 이상으로 봅니다.'],
        ['② 분류', '값의 조합을 보고 상태에 <b>이름표</b>(정상/주의/경고)를 붙입니다 — 규칙 나무를 따라가는 방식이라 "왜 그 판정인지"가 항상 설명됩니다.'],
        ['③ 군집', '비슷한 운전 상태끼리 <b>무리</b>를 짓습니다. 고부하/저부하 같은 운전모드가 저절로 나뉘고, 어느 무리에도 안 속하면 낯선 상태.'],
        ['④ 이상탐지', '"정상 무리에서 얼마나 떨어졌나"를 점수로 냅니다. 여기서는 3가지 알고리즘(Mahalanobis·iForest·ECOD)을 바꿔가며 비교할 수 있습니다.'],
        ['⑤ 시계열 예측', '추세를 앞으로 연장해 <b>한계 도달 시점</b>을 역산합니다 — 잔여수명(RUL)의 기본 아이디어.'],
      ])}
      <div class="tabs">
        ${PATTERN_TABS.map(t => `<button class="tab ${S.patternTab === t.id ? 'active' : ''}" data-pt="${t.id}">${t.name}</button>`).join('')}
      </div>
      <div id="pt-body"></div>
    `;
    wireTopbar();
    document.querySelectorAll('[data-pt]').forEach(b => b.addEventListener('click', () => { S.patternTab = b.dataset.pt; render(); }));

    const body = $('#pt-body');
    if (allTagIds.length < 2) { body.innerHTML = '<div class="notice warn">데이터가 부족합니다.</div>'; return; }
    switch (S.patternTab) {
      case 'regression': ptRegression(body, allTagIds); break;
      case 'classification': ptClassification(body, allTagIds); break;
      case 'clustering': ptClustering(body, allTagIds); break;
      case 'anomaly': ptAnomaly(body, allTagIds); break;
      case 'timeseries': ptTimeseries(body, allTagIds); break;
    }
  }

  function tagSelect(id, tags, sel) {
    return `<select id="${id}">${tags.map(t => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  }

  function alignedPair(xId, yId) {
    const al = equip.alignSeries(S.seriesMap, [xId, yId]);
    return { t: al.t, x: al.cols[xId] || [], y: al.cols[yId] || [] };
  }

  function ptRegression(body, tags) {
    if (!S.ptReg) S.ptReg = { x: tags.includes('FT-101') ? 'FT-101' : tags[0], y: tags.includes('IT-106') ? 'IT-106' : tags[1] };
    body.innerHTML = `
      <div class="panel">
        <h2>회귀 — 물리적으로 연결된 두 신호의 관계 감시</h2>
        <div class="pattern-note">예: 유량(X)이 늘면 모터 전류(Y)도 는다. 학습구간에서 관계식 Y=aX+b를 만들고, 이후 <strong>잔차(실제−예측)</strong>가 이동하면 설비 상태가 변한 것. 부하 변화와 설비 열화를 구분하는 핵심 기법.</div>
        <div class="form-row">
          <label>X (입력 신호)</label>${tagSelect('rg-x', tags, S.ptReg.x)}
          <label>Y (출력 신호)</label>${tagSelect('rg-y', tags, S.ptReg.y)}
        </div>
        <div id="rg-verdict" class="notice"></div>
        <div class="grid cols-2">
          <div class="chart-box"><h3>산점도 + 회귀선 (학습구간)</h3><canvas id="rg-scatter"></canvas></div>
          <div class="chart-box"><h3>잔차 추이 (0에서 벗어나면 관계 변화)</h3><canvas id="rg-resid"></canvas></div>
        </div>
      </div>
    `;
    $('#rg-x').addEventListener('change', e => { S.ptReg.x = e.target.value; render(); });
    $('#rg-y').addEventListener('change', e => { S.ptReg.y = e.target.value; render(); });

    const { t, x, y } = alignedPair(S.ptReg.x, S.ptReg.y);
    if (t.length < 20) { $('#rg-verdict').textContent = '두 태그의 공통 구간 데이터가 부족합니다.'; return; }
    const res = patterns.regression(x, y);
    $('#rg-verdict').innerHTML = `<strong>판정:</strong> ${esc(res.verdict)} <span class="faint">(기울기 ${res.slope.toFixed(3)}, 절편 ${res.intercept.toFixed(2)}, R²=${res.r2.toFixed(2)})</span>`;
    const step = Math.max(1, Math.floor(t.length / 800));
    const pts = [];
    for (let i = 0; i < t.length; i += step) pts.push({ x: x[i], y: y[i], c: i < res.split ? 0 : 1 });
    charts.scatter($('#rg-scatter'), {
      points: pts, xLabel: S.ptReg.x, yLabel: S.ptReg.y,
      line: { slope: res.slope, intercept: res.intercept },
      colors: ['#4fc3f7', '#ffb74d'],
    });
    charts.lineChart($('#rg-resid'), {
      height: 260,
      series: [{ name: '잔차', t, v: res.resid, color: '#81c784' }],
      thresholds: [
        { y: res.residMu + 3 * res.residSd, label: '+3σ', color: '#ef5350' },
        { y: res.residMu - 3 * res.residSd, label: '−3σ', color: '#ef5350' },
        { y: 0, label: '', color: 'rgba(160,180,200,0.35)' },
      ],
      vlines: [{ t: t[res.split], label: '학습|감시', color: 'rgba(255,213,79,0.6)' }],
    });
  }

  function ptClassification(body, tags) {
    const assets = ontology.listAssets(S.model).filter(a => (a.tags || []).some(t => S.seriesMap[t.id]));
    if (!S.ptCls) S.ptCls = { asset: assets[0] ? assets[0].id : null };
    body.innerHTML = `
      <div class="panel">
        <h2>분류 — 룰 트리로 운전상태에 라벨 붙이기</h2>
        <div class="pattern-note">라벨 없는 시계열에 도메인 룰(부하 분위수 + 3σ 이상판정)로 <strong>정지/저부하/정상/고부하/이상</strong> 라벨을 자동 부여합니다. 이렇게 만든 라벨이 나중에 지도학습(ML) 분류의 학습 데이터가 됩니다.</div>
        <div class="form-row">
          <label>설비</label>
          <select id="cl-asset">${assets.map(a => `<option value="${a.id}" ${a.id === S.ptCls.asset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        </div>
        <div id="cl-out"></div>
      </div>
    `;
    $('#cl-asset').addEventListener('change', e => { S.ptCls.asset = e.target.value; render(); });

    const asset = ontology.findAsset(S.model, S.ptCls.asset);
    if (!asset) return;
    const ids = asset.tags.map(t => t.id).filter(id => S.seriesMap[id]);
    const al = equip.alignSeries(S.seriesMap, ids);
    if (al.t.length < 30) { $('#cl-out').innerHTML = '<div class="faint">데이터 부족</div>'; return; }
    const X = al.t.map((_, i) => al.ids.map(id => al.cols[id][i]));
    // 부하 지표: flow 역할 태그 우선
    const flowIdx = al.ids.findIndex(id => /^F/.test(id));
    const res = patterns.classifyStates(al.t, X, al.ids, { loadIdx: Math.max(0, flowIdx) });
    const colorMap = { '정지': '#546e7a', '저부하': '#4fc3f7', '정상': '#66bb6a', '고부하': '#ffb74d', '이상': '#ef5350' };
    const total = res.labels.length;
    const stripN = 240;
    const step = Math.max(1, Math.floor(total / stripN));
    let strip = '';
    for (let i = 0; i < total; i += step) {
      strip += `<div title="${esc(res.labels[i])} · ${fmtTimeShort(al.t[i])}" style="flex:1;height:26px;background:${colorMap[res.labels[i]]}"></div>`;
    }
    $('#cl-out').innerHTML = `
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin:10px 0">
        ${Object.entries(res.counts).map(([k, v]) => `<span><span style="display:inline-block;width:10px;height:10px;background:${colorMap[k]};border-radius:2px;margin-right:4px"></span>${k}: <strong>${v}</strong> (${(v / total * 100).toFixed(1)}%)</span>`).join('')}
      </div>
      <div style="display:flex;border-radius:6px;overflow:hidden">${strip}</div>
      <div class="faint" style="margin-top:6px">시간축: ${fmtTimeShort(al.t[0])} → ${fmtTimeShort(al.t[al.t.length - 1])} · 분류 기준: ${esc(res.loadName)} 부하 분위수 + 잔여 신호 3σ 판정</div>
    `;
  }

  function ptClustering(body, tags) {
    if (!S.ptClu) S.ptClu = { x: tags.includes('FT-201') ? 'FT-201' : tags[0], y: tags.includes('PT-202') ? 'PT-202' : tags[1], k: 3 };
    body.innerHTML = `
      <div class="panel">
        <h2>군집 — 운전점을 자동으로 묶기 (k-means)</h2>
        <div class="pattern-note">라벨 없이 운전 데이터를 k개 군집으로 묶습니다. 정상 운전모드들이 각각의 군집을 이루고, <strong>어느 군집에도 속하지 않는 점</strong>이나 <strong>새 군집의 등장</strong>은 운전조건 변화/이상 신호입니다. 다변량 감시 모델을 운전모드별로 나눌 때도 씁니다.</div>
        <div class="form-row">
          <label>X축</label>${tagSelect('cu-x', tags, S.ptClu.x)}
          <label>Y축</label>${tagSelect('cu-y', tags, S.ptClu.y)}
          <label>군집 수 k</label>
          <select id="cu-k">${[2, 3, 4, 5].map(k => `<option ${k === S.ptClu.k ? 'selected' : ''}>${k}</option>`).join('')}</select>
        </div>
        <div id="cu-info" class="faint" style="margin-bottom:8px"></div>
        <div class="chart-box"><canvas id="cu-scatter"></canvas></div>
      </div>
    `;
    $('#cu-x').addEventListener('change', e => { S.ptClu.x = e.target.value; render(); });
    $('#cu-y').addEventListener('change', e => { S.ptClu.y = e.target.value; render(); });
    $('#cu-k').addEventListener('change', e => { S.ptClu.k = parseInt(e.target.value, 10); render(); });

    const { t, x, y } = alignedPair(S.ptClu.x, S.ptClu.y);
    if (t.length < 30) { $('#cu-info').textContent = '데이터 부족'; return; }
    const step = Math.max(1, Math.floor(t.length / 1500));
    const M = [];
    for (let i = 0; i < t.length; i += step) M.push([x[i], y[i]]);
    const res = patterns.kmeans(M, S.ptClu.k);
    $('#cu-info').innerHTML = `군집 크기: ${res.sizes.map((s2, i) => `<span style="color:${charts.PALETTE[i]}">#${i + 1}: ${s2}</span>`).join(' · ')} · 관성(작을수록 조밀) ${res.inertia.toFixed(0)}`;
    charts.scatter($('#cu-scatter'), {
      height: 320,
      points: M.map((p, i) => ({ x: p[0], y: p[1], c: res.assignments[i] })),
      centroids: res.centroids,
      xLabel: S.ptClu.x, yLabel: S.ptClu.y,
    });
  }

  function ptAnomaly(body, tags) {
    const assets = ontology.listAssets(S.model).filter(a => (a.tags || []).some(t => S.seriesMap[t.id]));
    if (!S.ptAno) S.ptAno = { asset: assets[0] ? assets[0].id : null, algo: 'mahalanobis' };
    const ALGOS = {
      mahalanobis: { name: 'Mahalanobis 거리 (고전·통계)', note: '정상 학습구간의 평균·공분산에서 얼마나 떨어졌는지를 한 점수로. 선형 상관 구조 기반 — 본 시스템 건강지수의 근간.' },
      iforest: { name: 'Isolation Forest (ICDM 2008)', note: '무작위 분할 트리에서 빨리 고립되는 점일수록 이상. 비선형·다봉(운전모드 여러 개) 데이터에 강함 — 5,500회 이상 인용된 검증 기법.' },
      ecod: { name: 'ECOD (IEEE TKDE 2022)', note: '차원별 경험적 누적분포의 꼬리확률 합. 파라미터가 전혀 없어 튜닝 불필요 — 최신 검증 기법.' },
    };
    body.innerHTML = `
      <div class="panel">
        <h2>이상탐지 — 복합 신호에서 "조합의 이상"을 찾기</h2>
        <div class="pattern-note" id="an-note">${ALGOS[S.ptAno.algo].note}</div>
        <div class="form-row">
          <label>설비</label>
          <select id="an-asset">${assets.map(a => `<option value="${a.id}" ${a.id === S.ptAno.asset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
          <label>알고리즘</label>
          <select id="an-algo">${Object.entries(ALGOS).map(([k, v]) => `<option value="${k}" ${k === S.ptAno.algo ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
        </div>
        <div class="chart-box"><canvas id="an-chart"></canvas></div>
        <div id="an-top" style="margin-top:10px"></div>
      </div>
    `;
    $('#an-asset').addEventListener('change', e => { S.ptAno.asset = e.target.value; render(); });
    $('#an-algo').addEventListener('change', e => { S.ptAno.algo = e.target.value; render(); });

    const asset = ontology.findAsset(S.model, S.ptAno.asset);
    if (!asset) return;
    const ids = asset.tags.map(t => t.id).filter(id => S.seriesMap[id]);
    const al = equip.alignSeries(S.seriesMap, ids);
    if (al.t.length < 50) { $('#an-top').innerHTML = '<div class="faint">데이터 부족</div>'; return; }
    const X = al.t.map((_, i) => al.ids.map(id => al.cols[id][i]));
    const split = Math.max(20, Math.floor(X.length * 0.5));
    const { mu, sd } = mv.meanStdCols(X.slice(0, split));

    let scores, warnLim, alarmLim, label;
    if (S.ptAno.algo === 'iforest') {
      scores = adv.isolationForest(X, { seed: 7 }).scores;
      const base = scores.slice(0, split);
      warnLim = stats.quantile(base, 0.99);
      alarmLim = Math.max(stats.quantile(base, 0.999), 0.6);
      label = 'iForest 점수';
    } else if (S.ptAno.algo === 'ecod') {
      scores = adv.ecod(X).scores;
      const base = scores.slice(0, split);
      warnLim = stats.quantile(base, 0.99);
      alarmLim = stats.quantile(base, 0.999) * 1.05;
      label = 'ECOD 점수';
    } else {
      const res = patterns.anomaly(al.t, X, al.ids);
      scores = res.scores; warnLim = res.dWarn; alarmLim = res.dAlarm;
      label = 'Mahalanobis 거리';
    }

    charts.lineChart($('#an-chart'), {
      height: 260,
      series: [{ name: label, t: al.t, v: scores, color: '#f06292' }],
      thresholds: [
        { y: warnLim, label: '주의', color: '#ffca28' },
        { y: alarmLim, label: '경보', color: '#ef5350' },
      ],
      vlines: [{ t: al.t[split], label: '학습|감시', color: 'rgba(255,213,79,0.6)' }],
    });

    // 이상 시점 + 기여 태그 (z-점수 기준 공통 산출)
    const anomIdx = [];
    for (let i = split; i < scores.length; i++) if (scores[i] > alarmLim) anomIdx.push(i);
    const topVars = i => X[i]
      .map((v, j) => ({ name: al.ids[j], z: sd[j] > 0 ? (v - mu[j]) / sd[j] : 0 }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
    const lastAnom = anomIdx.slice(-5).reverse();
    $('#an-top').innerHTML = lastAnom.length
      ? `<h3>최근 이상 시점과 기여 태그</h3>` + lastAnom.map(i =>
        `<div class="alarm-row"><span class="a-time">${fmtTimeShort(al.t[i])}</span><div class="a-msg">점수 ${scores[i].toFixed(2)} — ${topVars(i).map(v => `<code>${esc(v.name)} (${v.z >= 0 ? '+' : ''}${v.z.toFixed(1)}σ)</code>`).join(' ')}</div></div>`).join('')
      : `<div class="faint">감시구간에서 경보 수준(${alarmLim.toFixed(2)})을 넘은 시점이 없습니다.</div>`;
  }

  function ptTimeseries(body, tags) {
    if (!S.ptTs) S.ptTs = { tag: tags.includes('TT-103') ? 'TT-103' : tags[0] };
    const tagMeta = ontology.listTags(S.model).find(t => t.id === S.ptTs.tag);
    body.innerHTML = `
      <div class="panel">
        <h2>시계열 예측 — 추세 외삽으로 "언제 한계에 닿나" (잔여수명 근사)</h2>
        <div class="pattern-note">Holt 이중지수평활로 수준+추세를 학습해 미래를 예측하고, 설계 한계선에 닿는 시점을 역산합니다. 파울링/베어링 온도처럼 <strong>서서히 진행하는 열화의 정비 시기 결정</strong>에 쓰는 패턴입니다.</div>
        <div class="form-row">
          <label>태그</label>${tagSelect('ts-tag', tags, S.ptTs.tag)}
          <label>한계값</label><input type="number" id="ts-limit" value="${S.ptTs.limit ?? (tagMeta ? tagMeta.hi : '')}" style="width:110px">
        </div>
        <div id="ts-verdict" class="notice"></div>
        <div class="chart-box"><canvas id="ts-chart"></canvas></div>
      </div>
    `;
    $('#ts-tag').addEventListener('change', e => { S.ptTs.tag = e.target.value; S.ptTs.limit = undefined; render(); });
    $('#ts-limit').addEventListener('change', e => { S.ptTs.limit = parseFloat(e.target.value); render(); });

    const s = S.seriesMap[S.ptTs.tag];
    if (!s || s.t.length < 30) { $('#ts-verdict').textContent = '데이터 부족'; return; }
    const fc = patterns.holtForecast(s.t, s.v, { horizon: 0.5 });
    const limit = S.ptTs.limit ?? (tagMeta ? tagMeta.hi : null);
    let verdict = `추세: 스텝당 ${fc.trendPerStep >= 0 ? '+' : ''}${fc.trendPerStep.toFixed(4)} (잔차σ ${fc.residSd.toFixed(2)})`;
    let vline = null;
    if (limit !== null && isFinite(limit)) {
      const hit = patterns.timeToLimit(fc, limit, true);
      if (hit) {
        const hrs = (hit.t - s.t[s.t.length - 1]) / 3600000;
        verdict = `<strong>⚠ 한계값 ${limit} 도달 예상: ${new Date(hit.t).toLocaleString('ko-KR')} (약 ${hrs < 48 ? hrs.toFixed(0) + '시간' : (hrs / 24).toFixed(1) + '일'} 후${hit.extrapolated ? ', 외삽' : ''})</strong> — 그 전에 정비 계획을 검토하세요.`;
        vline = { t: hit.t, label: '도달 예상', color: 'rgba(239,83,80,0.8)' };
      } else {
        verdict = `현재 추세로는 예측 구간 내 한계값(${limit}) 도달하지 않음. ` + verdict;
      }
    }
    $('#ts-verdict').innerHTML = verdict;
    const cfg = {
      height: 300,
      series: [
        { name: '실측', t: s.t, v: s.v, color: '#4fc3f7' },
        { name: '예측', t: fc.forecastT, v: fc.forecastV, color: '#ffb74d', dash: [5, 4] },
      ],
      bands: [{ t: fc.forecastT, lo: fc.lo, hi: fc.hi, color: 'rgba(255,183,77,0.1)' }],
      thresholds: limit !== null && isFinite(limit) ? [{ y: limit, label: `한계 ${limit}`, color: '#ef5350' }] : [],
      vlines: vline ? [vline] : [],
    };
    charts.lineChart($('#ts-chart'), cfg);
  }

  // ---------- 뷰: 알람 ----------
  function renderAlarmList(el, events, withAck) {
    el.innerHTML = '';
    for (const ev of events) {
      const row = document.createElement('div');
      row.className = 'alarm-row';
      row.innerHTML = `
        <span class="a-time">${fmtTimeShort(ev.time)}</span>
        <span class="prio p-${ev.priority}">${ev.priority}</span>
        <div class="a-msg">${esc(ev.message)}
          ${ev.evidence && ev.evidence.detail ? `<div class="a-detail">${esc(ev.evidence.detail)}</div>` : ''}
          ${ev.evidence && ev.evidence.actions ? `<div class="a-detail">권고: ${esc(ev.evidence.actions.slice(0, 2).join(', '))}</div>` : ''}
        </div>
        <span class="state-chip s-${ev.state}">${{ active: '활성', acked: '확인됨', cleared: '해제' }[ev.state] || ev.state}</span>
        ${withAck && ev.state === 'active' ? `<button class="btn small" data-ack="${esc(ev.id)}">확인</button>` : ''}
      `;
      el.appendChild(row);
    }
    if (withAck) {
      el.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', () => {
        S.alarmEngine.ack(b.dataset.ack);
        render();
      }));
    }
  }

  function viewAlarms(main) {
    const all = S.alarmEngine.events;
    const active = all.filter(e => e.state === 'active' || e.state === 'acked');
    // ISA-18.2 지표: 최근 1시간 발생 건수
    const hourAgo = Date.now() - 3600000;
    const lastHour = all.filter(e => e.time >= hourAgo).length;

    main.innerHTML = `
      ${topbar('알람 / 이벤트')}
      <div class="notice">
        생산팀이 말해주지 않아도 아는 것이 목표입니다. 알람은 <strong>m-of-n 지속성 + 오프딜레이</strong>(ISA-18.2)로 채터링을 억제하며,
        각 알람에는 근거(증상·기여 태그)와 권고 조치가 붙습니다.
      </div>
      ${explainBox('알람이 적게 뜨는 이유 (설계 의도)', [
        ['m-of-n 지속성', '한 번 스친 이상으로는 울리지 않고, 최근 3회 평가 중 2회 이상 지속돼야 확정합니다. 해제도 연속 2회 정상이어야 — 껐다켰다(채터링) 방지.'],
        ['first-out 그룹핑', '고장모드가 확정되면 그 원인이 만든 하위 증상 알람(추세·다변량)은 자동으로 숨깁니다 — <b>원인 1건 = 알람 1건</b>. 어나운시에이터의 first-out(ISA 18.1)과 같은 사상.'],
        ['상태기반 억제', '보호 트립으로 정지된 설비는 저전류·저진동이 "정상"이므로 통계 알람 전체를 억제하고 트립 알람 1건만 남깁니다.'],
        ['우선순위', '긴급(트립·설계한계 이탈) > 높음(고장모드·알람접점) > 중간(계기·복합이상) > 낮음(추세 참고).'],
      ])}
      <div class="grid cols-3" style="margin-bottom:16px">
        <div class="kpi ${active.length ? 'k-warn' : 'k-good'}"><div class="kpi-label">활성 + 확인됨</div><div class="kpi-value">${active.length}</div></div>
        <div class="kpi"><div class="kpi-label">최근 1시간 발생</div><div class="kpi-value">${lastHour}</div><div class="kpi-sub">ISA-18.2 권고: 시간당 12건 이하</div></div>
        <div class="kpi"><div class="kpi-label">누적 이벤트</div><div class="kpi-value">${all.length}</div></div>
      </div>
      <div class="panel">
        <h2>활성 알람</h2>
        <div id="al-active"></div>
      </div>
      <div class="panel">
        <h2>이벤트 이력</h2>
        <div id="al-hist"></div>
      </div>
    `;
    wireTopbar();
    renderAlarmList($('#al-active'), active, true);
    if (!active.length) $('#al-active').innerHTML = '<div class="empty"><span class="empty-ico">✅</span>활성 알람이 없습니다.</div>';
    renderAlarmList($('#al-hist'), all.slice(0, 50), false);
    if (!all.length) $('#al-hist').innerHTML = '<div class="empty"><span class="empty-ico">🗂️</span>이벤트 이력이 없습니다.<br>데이터가 갱신되며 이상이 감지되면 기록됩니다.</div>';
  }

  // ---------- 뷰: 온톨로지 ----------
  function viewOntology(main) {
    main.innerHTML = `
      ${topbar('자산 온톨로지 (ISO 14224 / ISA-95 / ISA-5.1)')}
      <div class="notice">
        설비-태그-고장모드를 잇는 지식 그래프입니다. 룰베이스 진단의 근거이며, 추후 LLM 분석 시 그대로 컨텍스트로 전달됩니다(온톨로지 기반 분석).
        JSON으로 내보내 실제 공장 자산 구조로 바꿔 넣을 수 있습니다.
      </div>
      <div class="grid cols-2">
        <div class="panel">
          <h2>자산 계층 (${esc(S.model.site.name)})</h2>
          <div class="tree" id="onto-tree"></div>
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn small" id="onto-export">JSON 내보내기</button>
            <button class="btn small" id="onto-import">JSON 가져오기</button>
            <button class="btn small" id="onto-reset">기본값 복원</button>
            <input type="file" id="onto-file" accept=".json" style="display:none">
          </div>
        </div>
        <div class="panel">
          <h2>고장모드 라이브러리</h2>
          <div id="onto-fm"></div>
        </div>
      </div>
      <div class="panel">
        <h2>ISA-5.1 태그 자동분류 테스트</h2>
        <div class="form-row">
          <input type="text" id="isa-input" placeholder="예: 10-PT-1234A, PDT-306, VT-105" style="flex:1">
          <button class="btn small" id="isa-run">분류</button>
        </div>
        <div id="isa-out" class="faint"></div>
      </div>
      <div class="panel">
        <h2>계기 제조사 레퍼런스 — Emerson · Yokogawa · ABB</h2>
        <div class="pattern-note">
          본 시스템의 계기 건전성 진단(임펄스라인 막힘 = 노이즈 붕괴 등)은 아래 벤더 자가진단 기능과 같은 시그니처를
          히스토리안 측에서 검사합니다. 계기 이상 검출 시 해당 트랜스미터의 HART 진단으로 교차 확인하세요.
          <strong>[검증]</strong> = 공식 문서(제품 페이지·매뉴얼·기술노트)로 확인된 항목.
        </div>
        <div class="table-scroll"><table class="data">
          <thead><tr><th>제조사</th><th>측정</th><th>대표 기종</th><th>진단 기능</th></tr></thead>
          <tbody>
            ${Object.values(ontology.VENDOR_REFS).map(v => v.items.map((it, i) => `
              <tr>${i === 0 ? `<td rowspan="${v.items.length}"><strong>${esc(v.name)}</strong></td>` : ''}
              <td>${esc(it.measure)}</td><td>${esc(it.models)}</td><td style="font-size:12px">${esc(it.diag)}</td></tr>`).join('')).join('')}
          </tbody>
        </table></div>
      </div>
      <div class="panel">
        <h2>LLM 컨텍스트 미리보기 (추후 AI 분석에 전달될 형태)</h2>
        <div class="form-row">
          <label>설비</label>
          <select id="onto-ctx-asset">${ontology.listAssets(S.model).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
        </div>
        <pre class="stream-out" id="onto-ctx" style="max-height:320px;overflow:auto;font-family:var(--mono);font-size:11.5px"></pre>
      </div>
    `;
    wireTopbar();

    // 트리
    const tree = $('#onto-tree');
    let html = '<ul>';
    for (const area of S.model.areas) {
      html += `<li class="t-node">📍 ${esc(area.name)}<ul>`;
      for (const unit of area.units) {
        html += `<li class="t-node">🏭 ${esc(unit.name)}<ul>`;
        for (const asset of unit.assets) {
          html += `<li class="t-node"><span class="t-asset" data-asset="${esc(asset.id)}">⚙️ ${esc(asset.name)}</span> <span class="faint">[${esc((ontology.EQUIP_CLASSES[asset.class] || {}).ko || asset.class)}]</span><ul>`;
          for (const tag of asset.tags || []) {
            const cls = ontology.classifyTag(tag.id);
            html += `<li class="t-node t-tag">${esc(tag.id)} — ${esc(tag.desc)} <span class="faint">(${esc(cls.ko)}, ${esc(tag.unit)})</span></li>`;
          }
          html += '</ul></li>';
        }
        html += '</ul></li>';
      }
      html += '</ul></li>';
    }
    html += '</ul>';
    tree.innerHTML = html;
    tree.querySelectorAll('.t-asset').forEach(el => el.addEventListener('click', () => go('asset', el.dataset.asset)));

    // 고장모드 라이브러리
    const fmEl = $('#onto-fm');
    let fmHtml = '';
    for (const [cls, modes] of Object.entries(ontology.FAILURE_LIB)) {
      if (!modes.length) continue;
      fmHtml += `<h3>${esc((ontology.EQUIP_CLASSES[cls] || {}).ko || cls)}</h3>`;
      for (const m of modes) {
        fmHtml += `<div style="margin:4px 0 10px 8px;font-size:12.5px">
          <strong>${esc(m.name)}</strong> <span class="faint">(${esc(m.id)} · ISO14224: ${esc(m.iso14224)})</span><br>
          <span class="muted">증상: ${m.symptoms.map(s => `${esc(s.role)}:${esc(health.patternKo(s.pattern))}`).join(', ')}</span>
        </div>`;
      }
    }
    fmEl.innerHTML = fmHtml;

    // 내보내기/가져오기
    $('#onto-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(S.model, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'medi-ontology.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('#onto-import').addEventListener('click', () => $('#onto-file').click());
    $('#onto-file').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const m = JSON.parse(await file.text());
        if (!m.areas) throw new Error('areas 필드가 없습니다');
        S.model = m;
        ontology.save(m);
        analyzeAll();
        render();
      } catch (err) {
        alert('가져오기 실패: ' + err.message);
      }
    });
    $('#onto-reset').addEventListener('click', () => {
      if (!confirm('온톨로지를 기본 데모 모델로 복원할까요?')) return;
      S.model = ontology.reset();
      analyzeAll();
      render();
    });

    // ISA-5.1 분류기
    $('#isa-run').addEventListener('click', () => {
      const inputs = $('#isa-input').value.split(',').map(s => s.trim()).filter(Boolean);
      $('#isa-out').innerHTML = inputs.map(t => {
        const c = ontology.classifyTag(t);
        return `<code>${esc(t)}</code> → ${esc(c.ko)} (${esc(c.measure)})${c.unit ? ', 기본단위 ' + esc(c.unit) : ''}`;
      }).join('<br>') || '태그명을 입력하세요.';
    });

    // LLM 컨텍스트 미리보기
    const updateCtx = () => {
      const aid = $('#onto-ctx-asset').value;
      const r = resultFor(aid);
      const extra = r && r.analysis && r.analysis.ok ? {
        observedSymptoms: r.analysis.observed,
        healthScore: r.health.score,
        topCandidates: r.analysis.candidates.slice(0, 2).map(c => ({ id: c.mode.id, name: c.mode.name, score: +c.score.toFixed(2) })),
        instrumentIssues: (r.analysis.instruments || []).map(i => ({ tagId: i.tagId, type: i.type, sev: +i.sev.toFixed(2), evidence: i.evidence })),
      } : {};
      $('#onto-ctx').textContent = JSON.stringify(ontology.toLLMContext(S.model, aid, extra), null, 2);
    };
    $('#onto-ctx-asset').addEventListener('change', updateCtx);
    updateCtx();
  }

  // ---------- 뷰: 진단 리포트 (룰베이스 기본 + LLM 선택) ----------
  function viewReport(main) {
    const assets = ontology.listAssets(S.model);
    if (!S.selectedAsset && assets.length) S.selectedAsset = assets[0].id;
    const llmConf = llm.loadConf();
    const keyed = llm.ready(llmConf);

    main.innerHTML = `
      ${topbar('진단 리포트')}
      <div class="tabs">
        <button class="tab ${!S.reportTab || S.reportTab === 'rule' ? 'active' : ''}" data-rt="rule">룰베이스 리포트 (기본)</button>
        <button class="tab ${S.reportTab === 'llm' ? 'active' : ''}" data-rt="llm">AI 분석 (선택 · API 키 필요)</button>
      </div>
      <div id="rp-body"></div>
    `;
    wireTopbar();
    document.querySelectorAll('[data-rt]').forEach(b => b.addEventListener('click', () => { S.reportTab = b.dataset.rt; render(); }));

    const body = $('#rp-body');
    if (!S.reportTab || S.reportTab === 'rule') {
      body.innerHTML = `
        <div class="panel">
          <div class="form-row">
            <label>대상</label>
            <select id="rp-asset">
              <option value="__plant__">전체 플랜트 요약</option>
              ${assets.map(a => `<option value="${a.id}" ${a.id === S.selectedAsset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
            </select>
            <button class="btn small" id="rp-copy">📋 복사</button>
          </div>
          <div class="md" id="rp-md"></div>
        </div>
      `;
      const renderReport = () => {
        const v = $('#rp-asset').value;
        let text;
        if (v === '__plant__') {
          text = report.plantSummary(S.results, S.lastUpdate);
        } else {
          const r = resultFor(v);
          text = r ? report.assetReport(r.asset, r.analysis, r.health, { now: S.lastUpdate }) : '데이터 없음';
        }
        S.lastReportText = text;
        $('#rp-md').innerHTML = md2html(text);
      };
      $('#rp-asset').addEventListener('change', e => { if (e.target.value !== '__plant__') S.selectedAsset = e.target.value; renderReport(); });
      $('#rp-copy').addEventListener('click', () => {
        navigator.clipboard && navigator.clipboard.writeText(S.lastReportText || '');
      });
      renderReport();
    } else {
      const provName = (llm.PROVIDERS[llmConf.provider] || {}).name || llmConf.provider;
      body.innerHTML = `
        ${keyed ? '' : `<div class="notice warn">
          <strong>AI 분석은 추후 사용을 위한 선택 기능입니다.</strong> 지금은 API 키 없이도 룰베이스 리포트가 모든 진단을 수행합니다.<br>
          <a href="#" id="go-settings" style="color:var(--accent)">설정</a>에서 프로바이더(Anthropic·OpenAI·Gemini·사내 호환)와 키를 등록하면,
          온톨로지+분석결과를 컨텍스트로 LLM 심층 분석(자연어 질의, 감별진단, 정비계획 제안)이 활성화됩니다.
        </div>`}
        <div class="panel">
          <div class="form-row">
            <label>설비</label>
            <select id="ai-asset">${assets.map(a => `<option value="${a.id}" ${a.id === S.selectedAsset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
            <span class="src-chip">🤖 ${esc(provName)} · ${esc(llmConf.model || '모델 미지정')}</span>
            <button class="btn small" id="ai-goset">변경</button>
          </div>
          <div class="form-row">
            <input type="text" id="ai-q" placeholder="질문 예: 이 설비 증상의 가장 유력한 원인과 이번 주 안에 해야 할 조치는?" style="flex:1" ${keyed ? '' : 'disabled'}>
            <button class="btn primary" id="ai-run" ${keyed && !S.llmBusy ? '' : 'disabled'}>${S.llmBusy ? '분석 중…' : '분석 요청'}</button>
          </div>
          <div class="stream-out md" id="ai-out">${S.llmOut ? md2html(S.llmOut) : '<span class="faint">' + (keyed ? '질문을 입력하고 분석을 요청하세요.' : 'API 키 미설정 — 룰베이스 리포트 탭을 이용하세요.') + '</span>'}</div>
        </div>
      `;
      const goSet = $('#go-settings');
      if (goSet) goSet.addEventListener('click', e => { e.preventDefault(); go('settings'); });
      const goSet2 = $('#ai-goset');
      if (goSet2) goSet2.addEventListener('click', () => go('settings'));
      const runBtn = $('#ai-run');
      if (runBtn) runBtn.addEventListener('click', async () => {
        const aid = $('#ai-asset').value;
        const q = $('#ai-q').value.trim() || '현재 상태를 진단하고 우선순위별 조치를 제안해줘.';
        const r = resultFor(aid);
        const extra = r && r.analysis && r.analysis.ok ? {
          observedSymptoms: r.analysis.observed,
          healthScore: r.health.score,
          tagDetails: Object.fromEntries(Object.entries(r.analysis.tagDiag).map(([k, d]) => [k, {
            last: +d.lastValue.toFixed(2), shiftSigma: +d.zShift.toFixed(2), varRatio: +d.varRatio.toFixed(2), unit: d.unit,
          }])),
          multivariate: r.analysis.mv ? { t2ViolFrac: +r.analysis.mv.t2ViolFrac.toFixed(2), speViolFrac: +r.analysis.mv.speViolFrac.toFixed(2), topContributors: r.analysis.mv.topContributors } : null,
          instrumentIssues: (r.analysis.instruments || []).map(i => ({ tagId: i.tagId, type: i.type, sev: +i.sev.toFixed(2), evidence: i.evidence })),
        } : {};
        const ctx = ontology.toLLMContext(S.model, aid, extra);
        S.llmBusy = true; S.llmOut = '';
        render();
        try {
          await llm.analyze({
            context: ctx, question: q,
            onDelta: (d, full) => {
              S.llmOut = full;
              const out = $('#ai-out');
              if (out) { out.innerHTML = md2html(full); }
            },
          });
        } catch (err) {
          S.llmOut = '**오류**: ' + err.message;
        }
        S.llmBusy = false;
        render();
      });
    }
  }

  // ---------- 뷰: 설정 ----------
  function viewSettings(main) {
    const st = S.settings;
    main.innerHTML = `
      ${topbar('설정 / 데이터소스 연동')}
      <div class="panel">
        <h2>데이터소스</h2>
        <div class="form-row">
          <label>모드</label>
          <select id="set-mode">
            <option value="demo" ${st.mode === 'demo' ? 'selected' : ''}>데모 시뮬레이터 (내장)</option>
            <option value="gateway" ${st.mode === 'gateway' ? 'selected' : ''}>현장 게이트웨이 (dataPARC 연동)</option>
            <option value="csv" ${st.mode === 'csv' ? 'selected' : ''}>CSV 업로드 (dataPARC 내보내기)</option>
          </select>
          <label class="chk"><input type="checkbox" id="set-auto" ${st.autoRefresh ? 'checked' : ''}> 1분 자동 갱신</label>
        </div>

        <div id="set-demo" style="display:${st.mode === 'demo' ? 'block' : 'none'}">
          <h3>데모 고장 시나리오 주입</h3>
          <div class="faint" style="margin-bottom:6px">과거 시점부터 열화가 진행 중인 상황을 재현합니다. 켜고 새로고침하면 대시보드/알람에서 감지 과정을 볼 수 있습니다.</div>
          ${Object.values(simulator.SCENARIOS).filter(s => s.id !== 'none').map(sc => `
            <label class="chk"><input type="checkbox" data-scn="${sc.id}" ${st.scenarios.includes(sc.id) ? 'checked' : ''}>
              <strong>${esc(sc.name)}</strong>&nbsp;<span class="faint">— ${esc(sc.desc)}</span></label>`).join('')}
        </div>

        <div id="set-gw" style="display:${st.mode === 'gateway' ? 'block' : 'none'}">
          <h3>게이트웨이 (backend/ 폴더의 FastAPI 서버)</h3>
          <div class="form-row">
            <label>게이트웨이 URL</label>
            <input type="text" id="set-gwurl" value="${esc(st.gatewayUrl)}" style="flex:1" placeholder="http://localhost:8137">
            <button class="btn small" id="set-gwtest">연결 테스트</button>
          </div>
          <div class="faint">공장 PC에서 <code>backend/</code>의 게이트웨이를 실행하면 dataPARC(dataPARC.Store REST/OPC UA/PARCdata SQL)에서 태그 데이터를 가져옵니다. 설치법은 backend/README.md 참조.</div>
          <div id="set-gwout" class="faint" style="margin-top:6px"></div>
        </div>

        <div id="set-csv" style="display:${st.mode === 'csv' ? 'block' : 'none'}">
          <h3>CSV 업로드</h3>
          <div class="form-row">
            <input type="file" id="set-csvfile" accept=".csv,.txt,.tsv">
          </div>
          <div class="faint">
            지원 형식: <code>Time,FT-101,PT-101,…</code>(wide) 또는 <code>Time,Tag,Value</code>(long).
            dataPARC Excel 애드인/PARCview 내보내기 파일을 그대로 올리면 됩니다.
            태그명이 온톨로지와 일치하면 설비 진단까지, 아니면 트렌드/5패턴 분석이 가능합니다.
            ${S.csvSeries ? `<br>현재 로드됨: <strong>${esc(S.csvLabel)}</strong> (태그 ${Object.keys(S.csvSeries).length}개)` : ''}
          </div>
        </div>

        <div class="form-row" style="margin-top:12px">
          <label>최근 감시구간(시간)</label>
          <input type="number" id="set-recent" value="${st.recentHours}" min="1" max="168" style="width:90px">
          <button class="btn primary" id="set-apply">적용 후 재분석</button>
        </div>
      </div>

      <div class="panel" id="llm-panel">
        <h2>AI 분석 (선택 — 추후 사용, 멀티 프로바이더)</h2>
        <div class="faint" style="margin-bottom:8px">
          키가 없어도 모든 기능은 룰베이스로 동작합니다. 아래에서 프로바이더를 선택해 키를 등록하면 "진단 리포트 → AI 분석" 탭이 활성화됩니다.
          키는 기본적으로 <strong>메모리에만</strong> 보관(새로고침 시 삭제), "이 브라우저에 저장" 체크 시에만 localStorage에 저장됩니다.
          사내망 LLM(Ollama/vLLM/LiteLLM/Azure 등)은 "OpenAI 호환"을 선택해 주소만 지정하면 됩니다.
        </div>
        <div id="llm-form"></div>
      </div>

      <div class="panel">
        <h2>dataPARC 연동 안내 (요약)</h2>
        <div class="md">${md2html([
          '- **1순위 — dataPARC.Store REST API**: `GET /api/v1/read/raw|aggregate|current` (HTTPS, 기본 포트 12340 추정). 게이트웨이의 `dataparc_rest` 커넥터 사용.',
          '- **2순위 — OPC UA**: `opc.tcp://서버:51235/Capstone/OPCUAServer` (모든 dataPARC 서버에 존재). `opcua` 커넥터 사용.',
          '- **3순위 — PARCdata SQL**: `SELECT * FROM ctc_fn_PARCdata_ReadRawTags(...)` (구버전/SQL 환경). `parcdata_sql` 커넥터 사용.',
          '- **수동 — CSV**: PARCview/Excel 애드인 내보내기 → 위 CSV 업로드.',
          '- 상세 설정: 저장소의 `backend/README.md`, 설계문서 `docs/PLAN.md` 참조.',
        ].join('\n'))}</div>
      </div>
    `;
    wireTopbar();

    $('#set-mode').addEventListener('change', e => {
      st.mode = e.target.value; saveSettings();
      render();
    });
    $('#set-auto').addEventListener('change', e => { st.autoRefresh = e.target.checked; saveSettings(); scheduleAutoRefresh(); });
    document.querySelectorAll('[data-scn]').forEach(c => c.addEventListener('change', () => {
      st.scenarios = Array.from(document.querySelectorAll('[data-scn]:checked')).map(x => x.dataset.scn);
      saveSettings();
    }));
    $('#set-apply').addEventListener('click', async () => {
      st.recentHours = Math.max(1, parseInt($('#set-recent').value, 10) || 24);
      st.gatewayUrl = ($('#set-gwurl') ? $('#set-gwurl').value.trim() : st.gatewayUrl) || st.gatewayUrl;
      saveSettings();
      S.source = null;
      // 시나리오/소스가 바뀌면 이전 알람 상태는 무효 — 엔진 재생성(첫 로드처럼 2회 평가 시딩)
      S.alarmEngine = health.createAlarmEngine({ mOfN: [2, 3], offDelay: 2 });
      await refreshData();
      scheduleAutoRefresh();
    });
    const gwTest = $('#set-gwtest');
    if (gwTest) gwTest.addEventListener('click', async () => {
      const url = $('#set-gwurl').value.trim().replace(/\/+$/, '');
      const out = $('#set-gwout');
      out.textContent = '연결 중…';
      try {
        const res = await fetch(url + '/api/v1/health');
        const j = await res.json();
        out.innerHTML = `✅ 연결 성공 — 커넥터: <strong>${esc(j.connector || '?')}</strong>, 태그 ${j.tags ?? '?'}개`;
      } catch (e) {
        out.textContent = '❌ 연결 실패: ' + e.message + ' (게이트웨이 실행 여부/CORS/URL 확인)';
      }
    });
    const csvFile = $('#set-csvfile');
    if (csvFile) csvFile.addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        S.csvSeries = datasource.parseCsv(await f.text());
        S.csvLabel = f.name;
        st.mode = 'csv'; saveSettings();
        S.source = null;
        await refreshData();
      } catch (err) {
        alert('CSV 파싱 실패: ' + err.message);
      }
    });
    renderLlmForm();
  }

  // LLM 설정 폼 — 프로바이더 전환 시 부분 리렌더
  function renderLlmForm() {
    const wrap = $('#llm-form');
    if (!wrap) return;
    const conf = llm.loadConf();
    const prov = llm.PROVIDERS[conf.provider] || llm.PROVIDERS[llm.DEFAULT_PROVIDER];
    const hasKey = !!llm.getKey(conf.provider);
    const models = prov.models || [];
    wrap.innerHTML = `
      <div class="form-row">
        <label>프로바이더</label>
        <select id="llm-provider">
          ${Object.entries(llm.PROVIDERS).map(([id, p]) => `<option value="${id}" ${id === conf.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <label>모델</label>
        <input type="text" id="llm-model" list="llm-model-list" value="${esc(conf.model || prov.defaultModel)}" placeholder="${esc(prov.defaultModel || '모델명 입력')}" style="width:220px">
        <datalist id="llm-model-list">${models.map(m => `<option value="${esc(m)}">`).join('')}</datalist>
      </div>
      ${prov.needsBaseUrl ? `
      <div class="form-row">
        <label>Base URL</label>
        <input type="text" id="llm-baseurl" value="${esc(conf.baseUrl || '')}" placeholder="http://사내서버:8000/v1" style="flex:1">
        <span class="faint">/chat/completions 를 붙여 호출합니다</span>
      </div>` : ''}
      <div class="form-row">
        <label>API 키</label>
        <input type="password" id="llm-key" placeholder="${esc(prov.keyPlaceholder)}${hasKey ? ' (설정됨 — 변경 시에만 입력)' : ''}" style="flex:1" autocomplete="off">
        <label class="chk"><input type="checkbox" id="llm-remember" ${conf.remember ? 'checked' : ''}> 이 브라우저에 저장</label>
      </div>
      <div class="form-row">
        <button class="btn primary small" id="llm-save">저장</button>
        <button class="btn small" id="llm-clearkey">이 프로바이더 키 삭제</button>
        <span class="faint" id="llm-state">${llm.ready(conf) ? `✅ 사용 준비됨 (${esc(prov.name)} · ${esc(conf.model)})` : (prov.allowEmptyKey ? 'Base URL/모델을 저장하면 활성화됩니다' : '키 미설정 (룰베이스 모드)')}</span>
      </div>
    `;
    $('#llm-provider').addEventListener('change', e => {
      const next = llm.loadConf();
      next.provider = e.target.value;
      next.model = (llm.PROVIDERS[next.provider] || {}).defaultModel || '';
      llm.saveConf(next);
      renderLlmForm();
    });
    $('#llm-save').addEventListener('click', () => {
      const next = llm.loadConf();
      next.provider = $('#llm-provider').value;
      next.model = $('#llm-model').value.trim();
      next.remember = $('#llm-remember').checked;
      const bu = $('#llm-baseurl');
      if (bu) next.baseUrl = bu.value.trim().replace(/\/+$/, '');
      llm.saveConf(next);
      const keyVal = $('#llm-key').value;
      if (keyVal.trim()) llm.setKey(next.provider, keyVal, next.remember);
      renderLlmForm();
    });
    $('#llm-clearkey').addEventListener('click', () => {
      llm.clearKey($('#llm-provider').value);
      renderLlmForm();
    });
  }

  // ---------- 부트스트랩 ----------
  window.addEventListener('resize', () => {
    clearTimeout(S._rz);
    S._rz = setTimeout(render, 200);
  });

  (async function boot() {
    render();
    await refreshData();
    scheduleAutoRefresh();
  })();
})();
