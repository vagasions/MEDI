/* MEDI 계산 태그 — 안전한 수식 평가기 (eval 미사용)
 * 용도: 불러온 태그 값을 원하는 대로 응용/가공 — 단위 환산, 차이, 비율, 스케일 보정 등.
 *   예: "[FT-101] * 0.16667"          (m³/h → L/s)
 *       "[PT-102] - [PT-101]"          (차압 직접 계산)
 *       "max([TT-103],[TT-104])"       (베어링 온도 최댓값)
 *       "([FT-101]*([PT-102]-[PT-101]))/[IT-106]"  (펌프 효율 프록시)
 * 문법: 숫자, [태그ID], + - * / ( ), 단항 -, 함수 abs/min/max/sqrt/log/exp
 * 브라우저(window.MEDI.calc)와 Node 양쪽 동작.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.calc = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FUNCS = {
    abs: [1, a => Math.abs(a)],
    sqrt: [1, a => Math.sqrt(a)],
    log: [1, a => Math.log(a)],
    exp: [1, a => Math.exp(a)],
    min: [2, (a, b) => Math.min(a, b)],
    max: [2, (a, b) => Math.max(a, b)],
  };

  function tokenize(src) {
    const toks = [];
    let i = 0;
    const s = String(src);
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '[') {
        const j = s.indexOf(']', i);
        if (j < 0) throw new Error('닫히지 않은 태그 참조 "["');
        const id = s.slice(i + 1, j).trim();
        if (!id) throw new Error('빈 태그 참조 []');
        toks.push({ t: 'tag', v: id });
        i = j + 1;
      } else if (/[0-9.]/.test(c)) {
        const m = s.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
        if (!m) throw new Error(`숫자 형식 오류: ${s.slice(i, i + 8)}`);
        toks.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
      } else if (/[A-Za-z_]/.test(c)) {
        const m = s.slice(i).match(/^[A-Za-z_]+/);
        const name = m[0].toLowerCase();
        if (!FUNCS[name]) throw new Error(`알 수 없는 함수: ${m[0]} (사용 가능: ${Object.keys(FUNCS).join(', ')})`);
        toks.push({ t: 'fn', v: name });
        i += m[0].length;
      } else if ('+-*/(),'.includes(c)) {
        toks.push({ t: c });
        i++;
      } else {
        throw new Error(`허용되지 않는 문자: "${c}" (태그는 [대괄호]로 감싸세요)`);
      }
    }
    return toks;
  }

  // 재귀 하강 파서 → AST 없이 클로저 평가기로 직접 컴파일
  function compile(src) {
    const toks = tokenize(src);
    if (!toks.length) throw new Error('빈 수식');
    let p = 0;
    const refs = new Set();
    const peek = () => toks[p];
    const eat = (t) => {
      if (!toks[p] || toks[p].t !== t) throw new Error(`구문 오류: ${t} 필요 (위치 ${p})`);
      return toks[p++];
    };

    function expr() { // 덧셈 수준
      let f = term();
      while (peek() && (peek().t === '+' || peek().t === '-')) {
        const op = toks[p++].t;
        const g = term();
        const l = f;
        f = op === '+' ? (v) => l(v) + g(v) : (v) => l(v) - g(v);
      }
      return f;
    }
    function term() { // 곱셈 수준
      let f = unary();
      while (peek() && (peek().t === '*' || peek().t === '/')) {
        const op = toks[p++].t;
        const g = unary();
        const l = f;
        f = op === '*' ? (v) => l(v) * g(v) : (v) => l(v) / g(v);
      }
      return f;
    }
    function unary() {
      if (peek() && peek().t === '-') { p++; const g = unary(); return (v) => -g(v); }
      return atom();
    }
    function atom() {
      const tk = peek();
      if (!tk) throw new Error('수식이 갑자기 끝남');
      if (tk.t === 'num') { p++; return () => tk.v; }
      if (tk.t === 'tag') { p++; refs.add(tk.v); return (v) => v[tk.v]; }
      if (tk.t === 'fn') {
        p++;
        const [arity, fn] = FUNCS[tk.v];
        eat('(');
        const args = [expr()];
        while (args.length < arity) { eat(','); args.push(expr()); }
        eat(')');
        return arity === 1 ? (v) => fn(args[0](v)) : (v) => fn(args[0](v), args[1](v));
      }
      if (tk.t === '(') { p++; const g = expr(); eat(')'); return g; }
      throw new Error(`구문 오류: 예상치 못한 토큰 (위치 ${p})`);
    }

    const f = expr();
    if (p !== toks.length) throw new Error('수식 끝에 해석되지 않은 부분이 있음');
    if (!refs.size) throw new Error('태그 참조가 없음 — [태그ID]를 최소 1개 사용하세요');
    return { eval: f, refs: [...refs] };
  }

  // 수식 → 가상 시리즈 생성. 첫 참조 태그의 시간축 기준, 나머지는 선형보간.
  function makeSeries(seriesMap, exprSrc) {
    const c = compile(exprSrc);
    for (const r of c.refs) {
      if (!seriesMap[r] || seriesMap[r].t.length < 2) throw new Error(`태그 데이터 없음: ${r}`);
    }
    const baseT = seriesMap[c.refs[0]].t;
    const interp = (s, tq) => {
      const { t, v } = s;
      let j = 0;
      return tq.map(g => {
        while (j < t.length - 2 && t[j + 1] < g) j++;
        const t0 = t[j], t1 = t[j + 1];
        return t1 > t0 ? v[j] + (v[j + 1] - v[j]) * ((g - t0) / (t1 - t0)) : v[j];
      });
    };
    const cols = {};
    for (const r of c.refs) cols[r] = r === c.refs[0] ? seriesMap[r].v : interp(seriesMap[r], baseT);
    const out = new Array(baseT.length);
    const row = {};
    for (let i = 0; i < baseT.length; i++) {
      for (const r of c.refs) row[r] = cols[r][i];
      const y = c.eval(row);
      out[i] = isFinite(y) ? Math.round(y * 10000) / 10000 : NaN;
    }
    return { t: baseT.slice(), v: out, refs: c.refs };
  }

  return { compile, makeSeries, FUNCS };
});
