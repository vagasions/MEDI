/* MEDI 엑셀(.xlsx) 리더 — 외부 라이브러리 없이 브라우저 내장 API만 사용 (의존성 0)
 *
 * 원리: .xlsx = ZIP(XML 묶음). ZIP 해제는 브라우저/Node 내장 DecompressionStream('deflate-raw'),
 * XML은 정규식 기반 경량 파싱(셀 값만 필요). PARCview 7 / 엑셀 애드인 내보내기 대응:
 *  · 공유문자열(sharedStrings) / 인라인 문자열 / 숫자 / 날짜(직렬값 — 로컬 시각으로 해석)
 *  · 첫 워크시트를 표로 읽어 datasource.rowsToSeries(와이드/롱 자동 인식)로 전달
 * 브라우저(window.MEDI.xlsx)와 Node(18+) 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./datasource.js'));
  } else {
    root.MEDI = root.MEDI || {};
    root.MEDI.xlsx = factory(root.MEDI.datasource);
  }
})(typeof self !== 'undefined' ? self : this, function (datasource) {
  'use strict';

  function supported() {
    return typeof DecompressionStream !== 'undefined';
  }

  const td = new TextDecoder('utf-8');

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // ZIP 중앙 디렉터리에서 엔트리 목록을 읽고, 이름→압축해제 함수 맵 반환
  async function readZip(buf) {
    const b = new Uint8Array(buf);
    // EOCD(0x06054b50)를 끝에서 탐색
    let eocd = -1;
    const min = Math.max(0, b.length - 66000);
    for (let i = b.length - 22; i >= min; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 형식이 아닙니다 (.xlsx가 맞는지 확인)');
    const count = u16(b, eocd + 10);
    let off = u32(b, eocd + 16);
    const entries = {};
    for (let n = 0; n < count; n++) {
      if (u32(b, off) !== 0x02014b50) break;
      const method = u16(b, off + 10);
      const csize = u32(b, off + 20);
      const nameLen = u16(b, off + 28);
      const extraLen = u16(b, off + 30);
      const cmtLen = u16(b, off + 32);
      const lho = u32(b, off + 42);
      const name = td.decode(b.subarray(off + 46, off + 46 + nameLen));
      entries[name] = { method, csize, lho };
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return {
      names: Object.keys(entries),
      async read(name) {
        const e = entries[name];
        if (!e) return null;
        // 로컬 헤더에서 실제 데이터 시작 위치 계산
        const nl = u16(b, e.lho + 26), el = u16(b, e.lho + 28);
        const start = e.lho + 30 + nl + el;
        const raw = b.subarray(start, start + e.csize);
        if (e.method === 0) return raw;
        if (e.method === 8) return inflateRaw(raw);
        throw new Error(`지원하지 않는 압축 방식(${e.method}) — 일반 저장한 .xlsx를 사용하세요`);
      },
    };
  }

  function xmlUnescape(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
  }

  function parseSharedStrings(xml) {
    const out = [];
    const re = /<si[\s>][\s\S]*?<\/si>/g;
    let m;
    while ((m = re.exec(xml))) {
      let text = '';
      const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tre.exec(m[0]))) text += t[1];
      out.push(xmlUnescape(text));
    }
    return out;
  }

  function colIndex(ref) { // "BC12" → 54
    let n = 0;
    for (const ch of ref) {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
      else break;
    }
    return n - 1;
  }

  // 워크시트 XML → 2차원 배열 (문자열 값)
  function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1];
        const inner = cm[2] || '';
        const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
        const type = (attrs.match(/t="(\w+)"/) || [])[1] || 'n';
        let val = '';
        if (type === 'inlineStr') {
          const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = t ? xmlUnescape(t[1]) : '';
        } else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          val = v ? xmlUnescape(v[1]) : '';
          if (type === 's') val = shared[parseInt(val, 10)] ?? '';
        }
        const idx = ref ? colIndex(ref) : cells.length;
        cells[idx] = val;
      }
      if (cells.some(c => c !== undefined && String(c).trim() !== '')) rows.push(cells);
    }
    return rows;
  }

  // ArrayBuffer(.xlsx) → seriesMap
  async function parse(buf) {
    if (!supported()) {
      throw new Error('이 브라우저는 .xlsx 직접 읽기를 지원하지 않습니다(구형 브라우저) — PARCview에서 CSV로 내보내 업로드하세요');
    }
    const zip = await readZip(buf);
    const sheetName = zip.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    if (!sheetName) throw new Error('워크시트를 찾지 못했습니다 (.xlsx 형식 확인)');
    const ssRaw = await zip.read('xl/sharedStrings.xml');
    const shared = ssRaw ? parseSharedStrings(td.decode(ssRaw)) : [];
    const sheetRaw = await zip.read(sheetName);
    const rows = parseSheet(td.decode(sheetRaw), shared);
    if (rows.length < 3) throw new Error('데이터 행이 부족합니다 (헤더 + 2행 이상 필요)');
    const header = rows[0].map(h => String(h ?? '').trim());
    return datasource.rowsToSeries(header, rows.slice(1));
  }

  return { parse, supported };
});
