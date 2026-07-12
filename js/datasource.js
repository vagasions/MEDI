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
  // 따옴표를 존중하는 필드 분리 — 엑셀 내보내기의 "1,234.5" 같은 천단위 콤마 값 대응
  function splitLine(line, delim) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === delim && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  // 숫자 파싱 — 천단위 콤마("1,234.56")·공백 제거
  function parseNum(s) {
    let str = String(s == null ? '' : s).trim().replace(/^"|"$/g, '').trim();
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(str)) str = str.replace(/,/g, '');
    return parseFloat(str);
  }

  // 헤더 + 행 배열 → 시계열 (CSV/엑셀 공용)
  function rowsToSeries(header, rows) {
    const lower = header.map(h => String(h).toLowerCase().trim());
    const tagCol = lower.findIndex(h => ['tag', 'tagname', 'tag name', 'name', '태그', '태그명'].includes(h));
    const valCol = lower.findIndex(h => ['value', 'val', '값'].includes(h));
    const timeCol = lower.findIndex(h => ['time', 'timestamp', 'datetime', 'date', '시간', '시각', '일시', '날짜'].includes(h));

    const series = {};
    function push(tag, tms, v) {
      if (!isFinite(tms) || !isFinite(v)) return;
      if (!series[tag]) series[tag] = { t: [], v: [] };
      series[tag].t.push(tms); series[tag].v.push(v);
    }

    if (tagCol >= 0 && valCol >= 0 && timeCol >= 0) {
      for (const c of rows) {
        if (c.length <= Math.max(tagCol, valCol, timeCol)) continue;
        push(String(c[tagCol]).trim().replace(/^"|"$/g, ''), parseTime(c[timeCol]), parseNum(c[valCol]));
      }
    } else {
      const tCol = timeCol >= 0 ? timeCol : 0;
      for (const c of rows) {
        const tms = parseTime(c[tCol]);
        for (let j = 0; j < header.length; j++) {
          if (j === tCol) continue;
          push(String(header[j]).trim(), tms, parseNum(c[j]));
        }
      }
    }
    for (const k of Object.keys(series)) {
      const s = series[k];
      const idx = s.t.map((t, i) => i).sort((a, b) => s.t[a] - s.t[b]);
      s.t = idx.map(i => s.t[i]);
      s.v = idx.map(i => s.v[i]);
      if (s.t.length < 2) delete series[k];
    }
    if (!Object.keys(series).length) throw new Error('유효한 시계열을 찾지 못했습니다 (헤더/시간열/형식 확인)');
    return series;
  }

  function parseCsv(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim().length);
    if (lines.length < 2) throw new Error('CSV에 데이터 행이 없습니다');
    const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') && !lines[0].includes(',')) ? ';' : ',';
    const header = splitLine(lines[0], delim).map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) rows.push(splitLine(lines[i], delim));
    return rowsToSeries(header, rows);
  }

  function parseTime(s) {
    let str = String(s).trim().replace(/^"|"$/g, '').trim();
    if (/^\d{10,13}$/.test(str)) { // epoch
      const num = parseInt(str, 10);
      return str.length >= 13 ? num : num * 1000;
    }
    // 엑셀 직렬값 (1900 기준, 시간은 소수부) — PARCview/엑셀 내보내기에서 흔함.
    // 주의: 직렬값은 "로컬 시각"으로 저장되므로 로컬 타임존으로 해석한다.
    if (/^\d+(\.\d+)?$/.test(str) && parseFloat(str) > 20000 && parseFloat(str) < 80000) {
      const serial = parseFloat(str);
      const utcGuess = Math.round((serial - 25569) * 86400000);
      const tzOff = new Date(utcGuess).getTimezoneOffset() * 60000;
      return utcGuess + tzOff;
    }
    // 한국식 표기 정규화: "2026.07.12" → "2026-07-12", "오전/오후 3:05" → 24시간제
    str = str.replace(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})\.?/, (m, y, mo, d) =>
      `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
    const ap = str.match(/(오전|오후|AM|PM|am|pm)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (ap) {
      let h = parseInt(ap[2], 10);
      const pm = ap[1] === '오후' || ap[1].toLowerCase() === 'pm';
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
      str = str.replace(ap[0], `${String(h).padStart(2, '0')}:${ap[3]}${ap[4] ? ':' + ap[4] : ''}`);
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

  return { createDemoSource, createGatewaySource, createCsvSource, parseCsv, parseTime, rowsToSeries, parseNum, splitLine };
});
