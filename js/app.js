/* MEDI 예지보전 — 앱 셸 (상태, 라우팅, 뷰)
 * 100% 룰베이스로 동작. LLM은 설정에서 키 입력 시에만 활성화되는 선택 기능.
 */
(function () {
  'use strict';
  const { stats, mv, equip, health, ontology, simulator, datasource, charts, report, llm, patterns } = window.MEDI;

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
      llmModel: llm.DEFAULT_MODEL,
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
        return d || { id, startFrac: 0.5, endFrac: 1.4 };
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
    { id: 'dashboard', ico: '📊', name: '대시보드' },
    { id: 'asset', ico: '⚙️', name: '설비 상세' },
    { id: 'trends', ico: '📈', name: '트렌드 분석' },
    { id: 'patterns', ico: '🎓', name: '분석 실습 (5패턴)' },
    { id: 'alarms', ico: '🔔', name: '알람 / 이벤트' },
    { id: 'ontology', ico: '🕸️', name: '자산 온톨로지' },
    { id: 'report', ico: '📋', name: '진단 리포트' },
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
        ${NAV.map(n => `
          <button class="nav-item ${S.view === n.id ? 'active' : ''}" data-nav="${n.id}">
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
    if (S.loading && !S.results.length) {
      main.innerHTML = `<div class="loading">데이터 로딩/분석 중…</div>`;
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
        <div class="ac-fm">${top && top.score >= 0.4
          ? `⚠ 의심: <span class="fm-name">${esc(top.mode.name)}</span> (일치도 ${(top.score * 100).toFixed(0)}%)`
          : '<span class="muted">유의미한 고장모드 징후 없음</span>'}</div>
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
    if (!active.length) $('#dash-alarms').innerHTML = '<div class="faint">현재 활성 알람이 없습니다. 이상 징후 발생 시 여기와 좌측 배지에 표시됩니다.</div>';
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

      <div class="panel">
        <h2>주요 신호 트렌드 (베이스라인 대비)</h2>
        <div id="tag-charts" class="grid cols-2"></div>
      </div>

      <div class="panel">
        <h2>다변량 감시 — 여러 신호의 "관계"로 잡는 이상</h2>
        <div class="pattern-note">개별 태그가 정상범위여도 신호 간 상관구조가 무너지면(SPE↑) 설비 이상의 조기 신호입니다. 단순 임계값 알람으로는 잡히지 않는 유형입니다.</div>
        <div class="grid cols-2">
          <div class="chart-box"><h3>Hotelling T² (운전점 이탈)</h3><canvas id="ch-t2"></canvas></div>
          <div class="chart-box"><h3>SPE/Q (상관구조 붕괴)</h3><canvas id="ch-spe"></canvas></div>
        </div>
        <div id="mv-contrib" style="margin-top:10px"></div>
      </div>

      <div class="panel">
        <h2>고장모드 후보 (ISO 14224 라이브러리 매칭)</h2>
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
    if (!S.ptAno) S.ptAno = { asset: assets[0] ? assets[0].id : null };
    body.innerHTML = `
      <div class="panel">
        <h2>이상탐지 — Mahalanobis 거리 기반 복합 이상 점수</h2>
        <div class="pattern-note">설비의 모든 신호를 하나의 벡터로 보고, 정상 학습구간의 평균·공분산에서 <strong>얼마나 떨어졌는지(거리)</strong>를 한 점수로 계산합니다. 개별 임계값으로는 안 보이는 "조합의 이상"을 잡는 예지보전의 핵심 패턴 — 본 시스템 건강지수의 근간입니다.</div>
        <div class="form-row">
          <label>설비</label>
          <select id="an-asset">${assets.map(a => `<option value="${a.id}" ${a.id === S.ptAno.asset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        </div>
        <div class="chart-box"><canvas id="an-chart"></canvas></div>
        <div id="an-top" style="margin-top:10px"></div>
      </div>
    `;
    $('#an-asset').addEventListener('change', e => { S.ptAno.asset = e.target.value; render(); });

    const asset = ontology.findAsset(S.model, S.ptAno.asset);
    if (!asset) return;
    const ids = asset.tags.map(t => t.id).filter(id => S.seriesMap[id]);
    const al = equip.alignSeries(S.seriesMap, ids);
    if (al.t.length < 50) { $('#an-top').innerHTML = '<div class="faint">데이터 부족</div>'; return; }
    const X = al.t.map((_, i) => al.ids.map(id => al.cols[id][i]));
    const res = patterns.anomaly(al.t, X, al.ids);
    charts.lineChart($('#an-chart'), {
      height: 260,
      series: [{ name: '이상 점수 (거리)', t: al.t, v: res.scores, color: '#f06292' }],
      thresholds: [
        { y: res.dWarn, label: '주의', color: '#ffca28' },
        { y: res.dAlarm, label: '경보', color: '#ef5350' },
      ],
      vlines: [{ t: al.t[res.split], label: '학습|감시', color: 'rgba(255,213,79,0.6)' }],
    });
    const lastAnom = res.anomalyIdx.slice(-5).reverse();
    $('#an-top').innerHTML = lastAnom.length
      ? `<h3>최근 이상 시점과 기여 태그</h3>` + lastAnom.map(i =>
        `<div class="alarm-row"><span class="a-time">${fmtTimeShort(al.t[i])}</span><div class="a-msg">점수 ${res.scores[i].toFixed(1)} — ${res.topVars(i).map(v => `<code>${esc(v.name)} (${v.z >= 0 ? '+' : ''}${v.z.toFixed(1)}σ)</code>`).join(' ')}</div></div>`).join('')
      : `<div class="faint">감시구간에서 경보 수준(${res.dAlarm.toFixed(1)})을 넘은 시점이 없습니다. 감시구간 주의 초과율 ${(res.recentWarnFrac * 100).toFixed(0)}%</div>`;
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
    if (!active.length) $('#al-active').innerHTML = '<div class="faint">활성 알람이 없습니다.</div>';
    renderAlarmList($('#al-hist'), all.slice(0, 50), false);
    if (!all.length) $('#al-hist').innerHTML = '<div class="faint">이벤트 이력이 없습니다. 데이터가 갱신되며 이상이 감지되면 기록됩니다.</div>';
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
    const keyed = llm.hasKey();

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
      body.innerHTML = `
        ${keyed ? '' : `<div class="notice warn">
          <strong>AI 분석은 추후 사용을 위한 선택 기능입니다.</strong> 지금은 API 키 없이도 룰베이스 리포트가 모든 진단을 수행합니다.<br>
          나중에 Anthropic API 키를 <a href="#" id="go-settings" style="color:var(--accent)">설정</a>에서 입력하면,
          온톨로지+분석결과를 컨텍스트로 Claude가 심층 분석(자연어 질의, 감별진단, 정비계획 제안)을 해 줍니다.
        </div>`}
        <div class="panel">
          <div class="form-row">
            <label>설비</label>
            <select id="ai-asset">${assets.map(a => `<option value="${a.id}" ${a.id === S.selectedAsset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
            <label>모델</label>
            <select id="ai-model">${llm.MODELS.map(m => `<option value="${m.id}" ${m.id === S.settings.llmModel ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
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
      const runBtn = $('#ai-run');
      if (runBtn) runBtn.addEventListener('click', async () => {
        const aid = $('#ai-asset').value;
        const q = $('#ai-q').value.trim() || '현재 상태를 진단하고 우선순위별 조치를 제안해줘.';
        const modelId = $('#ai-model').value;
        S.settings.llmModel = modelId; saveSettings();
        const r = resultFor(aid);
        const extra = r && r.analysis && r.analysis.ok ? {
          observedSymptoms: r.analysis.observed,
          healthScore: r.health.score,
          tagDetails: Object.fromEntries(Object.entries(r.analysis.tagDiag).map(([k, d]) => [k, {
            last: +d.lastValue.toFixed(2), shiftSigma: +d.zShift.toFixed(2), varRatio: +d.varRatio.toFixed(2), unit: d.unit,
          }])),
          multivariate: r.analysis.mv ? { t2ViolFrac: +r.analysis.mv.t2ViolFrac.toFixed(2), speViolFrac: +r.analysis.mv.speViolFrac.toFixed(2), topContributors: r.analysis.mv.topContributors } : null,
        } : {};
        const ctx = ontology.toLLMContext(S.model, aid, extra);
        S.llmBusy = true; S.llmOut = '';
        render();
        try {
          await llm.analyze({
            model: modelId, context: ctx, question: q,
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

      <div class="panel">
        <h2>AI 분석 (선택 — 추후 사용)</h2>
        <div class="faint" style="margin-bottom:8px">
          지금은 키가 없어도 모든 기능이 룰베이스로 동작합니다. 추후 Anthropic API 키를 입력하면 "진단 리포트 → AI 분석" 탭이 활성화됩니다.
          키는 기본적으로 <strong>메모리에만</strong> 보관되며(새로고침 시 삭제), "이 브라우저에 저장"을 체크한 경우에만 localStorage에 저장됩니다.
        </div>
        <div class="form-row">
          <label>API 키</label>
          <input type="password" id="set-key" placeholder="sk-ant-…" style="flex:1" value="">
          <label class="chk"><input type="checkbox" id="set-keyremember"> 이 브라우저에 저장</label>
          <button class="btn small" id="set-keysave">저장</button>
          <button class="btn small" id="set-keyclear">삭제</button>
        </div>
        <div class="faint" id="set-keystate">${llm.hasKey() ? '✅ 키 설정됨' : '키 미설정 (룰베이스 모드)'}</div>
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
    $('#set-keysave').addEventListener('click', () => {
      llm.setKey($('#set-key').value, $('#set-keyremember').checked);
      $('#set-keystate').textContent = llm.hasKey() ? '✅ 키 설정됨' : '키 미설정 (룰베이스 모드)';
      $('#set-key').value = '';
    });
    $('#set-keyclear').addEventListener('click', () => {
      llm.clearKey();
      $('#set-keystate').textContent = '키 미설정 (룰베이스 모드)';
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
