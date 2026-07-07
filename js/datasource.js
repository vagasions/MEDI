/* MEDI 예지보전 — 데이터소스 추상화 계층
 * 모드: demo(내장 시뮬레이터) | gateway(현장 백엔드 REST) | csv(dataPARC 내보내기 파일)
 * 공통 인터페이스: init(), getSeriesMap(), refresh(), info()
 * gateway 모드는 backend/의 FastAPI 게이트웨이(dataPARC.Store REST/OPC UA/SQL 프록시)를 바라본다.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./simulator.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.datasource = factory(root.MEDI.simulator);
  }
})(typeof self !== 'undefined' ? self : this, function (simulator) {
  'use strict';

  // ---------- 데모 (시뮬레이터) ----------
  function createDemoSource(opts) {
    let cfg = Object.assign({ days: 7, stepMin: 5, active: simulator.DEFAULT_ACTIVE.slice() }, opts);
    let sim = null;
    return {
      mode: 'demo',
      async init() { sim = simulator.makeSim(Object.assign({}, cfg, { now: Date.now() })); return true; },
      async refresh() { sim = simulator.makeSim(Object.assign({}, cfg, { now: Date.now() })); return true; },
      async getSeriesMap() { return sim ? sim.series : {}; },
      setScenarios(active) { cfg.active = active; },
      getScenarios() { return cfg.active; },
      info() {
        const names = cfg.active.map(a => (simulator.SCENARIOS[a.id] || {}).name || a.id);
        return { mode: 'demo', desc: `데모 시뮬레이터 (${cfg.days}일 × ${cfg.stepMin}분 주기)`, scenarios: names };
      },
    };
  }

  // ---------- 게이트웨이 (현장 백엔드 REST) ----------
  function createGatewaySource(baseUrl, opts) {
    const o = Object.assign({ hours: 168, timeout: 20000 }, opts);
    const base = String(baseUrl || '').replace(/\/+$/, '');
    let tags = [];
    let lastError = null;

    async function reqOnce(path) {
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), o.timeout) : null;
      try {
        const res = await fetch(base + path, { signal: ctl ? ctl.signal : undefined });
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
        return await res.json();
      } finally { if (timer) clearTimeout(timer); }
    }
    // 자동 재시도(1s/2s 백오프) — 일시 장애 자가 회복
    async function req(path, tries) {
      const n = tries || 3;
      let last;
      for (let i = 0; i < n; i++) {
        try { return await reqOnce(path); }
        catch (e) { last = e; if (i < n - 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i))); }
      }
      throw last;
    }

    return {
      mode: 'gateway',
      async init() {
        lastError = null;
        const h = await req('/api/v1/health');
        tags = (await req('/api/v1/tags')).tags || [];
        return !!h;
      },
      async refresh() { return true; },
      async getSeriesMap(tagIds) {
        const ids = (tagIds && tagIds.length ? tagIds : tags.map(t => t.id));
        if (!ids.length) return {};
        const end = new Date();
        const start = new Date(end.getTime() - o.hours * 3600000);
        const out = {};
        // 태그를 배치로 나눠 요청 (URL 길이 제한 대비)
        for (let i = 0; i < ids.length; i += 20) {
          const batch = ids.slice(i, i + 20);
          const q = `/api/v1/read/raw?tagIds=${encodeURIComponent(batch.join(','))}` +
            `&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
          const data = await req(q);
          Object.assign(out, data.series || {});
        }
        return out;
      },
      getTagList() { return tags; },
      info() { return { mode: 'gateway', desc: `현장 게이트웨이 ${base}`, tags: tags.length, lastError }; },
    };
  }

  // ---------- CSV (dataPARC Excel/CSV 내보내기) ----------
  // 지원 형식:
  //  wide: Time,FT-101,PT-101,...  (첫 열이 시각)
  //  long: Time,Tag,Value  (또는 Tagname/Timestamp/Value 순서 무관, 헤더로 판별)
  function parseCsv(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim().length);
    if (lines.length < 2) throw new Error('CSV에 데이터 행이 없습니다');
    const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') && !lines[0].includes(',')) ? ';' : ',';
    const header = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, ''));
    const lower = header.map(h => h.toLowerCase());

    const tagCol = lower.findIndex(h => ['tag', 'tagname', 'tag name', 'name', '태그'].includes(h));
    const valCol = lower.findIndex(h => ['value', 'val', '값'].includes(h));
    const timeCol = lower.findIndex(h => ['time', 'timestamp', 'datetime', 'date', '시간', '시각'].includes(h));

    const series = {};
    function push(tag, tms, v) {
      if (!isFinite(tms) || !isFinite(v)) return;
      if (!series[tag]) series[tag] = { t: [], v: [] };
      series[tag].t.push(tms); series[tag].v.push(v);
    }

    if (tagCol >= 0 && valCol >= 0 && timeCol >= 0) {
      // long 형식
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(delim);
        if (c.length <= Math.max(tagCol, valCol, timeCol)) continue;
        push(c[tagCol].trim().replace(/^"|"$/g, ''), parseTime(c[timeCol]), parseFloat(c[valCol]));
      }
    } else {
      // wide 형식: 첫 열 = 시간, 나머지 열 = 태그
      const tCol = timeCol >= 0 ? timeCol : 0;
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(delim);
        const tms = parseTime(c[tCol]);
        for (let j = 0; j < header.length; j++) {
          if (j === tCol) continue;
          push(header[j], tms, parseFloat(c[j]));
        }
      }
    }
    // 시간 정렬
    for (const k of Object.keys(series)) {
      const s = series[k];
      const idx = s.t.map((t, i) => i).sort((a, b) => s.t[a] - s.t[b]);
      s.t = idx.map(i => s.t[i]);
      s.v = idx.map(i => s.v[i]);
      if (s.t.length < 2) delete series[k];
    }
    if (!Object.keys(series).length) throw new Error('CSV에서 유효한 시계열을 찾지 못했습니다 (헤더/형식 확인)');
    return series;
  }

  function parseTime(s) {
    const str = String(s).trim().replace(/^"|"$/g, '');
    if (/^\d{10,13}$/.test(str)) { // epoch
      const num = parseInt(str, 10);
      return str.length >= 13 ? num : num * 1000;
    }
    // "2026-07-07 14:00", "07/07/2026 14:00:00", 엑셀 직렬값 등
    if (/^\d+(\.\d+)?$/.test(str) && parseFloat(str) > 20000 && parseFloat(str) < 80000) {
      // Excel serial date (1900 기준)
      return Math.round((parseFloat(str) - 25569) * 86400000);
    }
    const d = new Date(str.replace(' ', 'T'));
    if (!isNaN(d.getTime())) return d.getTime();
    const d2 = new Date(str);
    return d2.getTime();
  }

  function createCsvSource(seriesMap, label) {
    return {
      mode: 'csv',
      async init() { return true; },
      async refresh() { return true; },
      async getSeriesMap() { return seriesMap; },
      info() {
        return { mode: 'csv', desc: `CSV 파일: ${label || '업로드'}`, tags: Object.keys(seriesMap).length };
      },
    };
  }

  return { createDemoSource, createGatewaySource, createCsvSource, parseCsv, parseTime };
});
