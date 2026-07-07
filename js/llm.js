/* MEDI 예지보전 — LLM 연동 (선택 기능, 멀티 프로바이더)
 * API 키가 없으면 완전히 비활성 — 룰베이스(report.js)가 기본 경로다.
 *
 * 지원 프로바이더 (전부 브라우저 직접 호출, 서버 불필요):
 *  - anthropic : Anthropic Messages API (SSE 스트리밍, CORS 헤더 필요)
 *  - openai    : OpenAI Chat Completions (SSE)
 *  - gemini    : Google Gemini generateContent (SSE, ?alt=sse)
 *  - compatible: OpenAI 호환 엔드포인트(사내 vLLM/Ollama/LiteLLM/Azure 등) — base URL 지정
 *
 * 키는 프로바이더별로 분리 보관. 기본은 메모리(새로고침 시 삭제),
 * "이 브라우저에 저장"을 명시적으로 켠 경우에만 localStorage.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.llm = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROVIDERS = {
    anthropic: {
      name: 'Anthropic (Claude)',
      keyPlaceholder: 'sk-ant-…',
      defaultModel: 'claude-opus-4-8',
      models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
      needsBaseUrl: false,
    },
    openai: {
      name: 'OpenAI (GPT)',
      keyPlaceholder: 'sk-…',
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
      needsBaseUrl: false,
    },
    gemini: {
      name: 'Google (Gemini)',
      keyPlaceholder: 'AIza…',
      defaultModel: 'gemini-2.0-flash',
      models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      needsBaseUrl: false,
    },
    compatible: {
      name: 'OpenAI 호환 (사내/Ollama/vLLM/Azure)',
      keyPlaceholder: '(없으면 비워두기)',
      defaultModel: '',
      models: [],
      needsBaseUrl: true,
      allowEmptyKey: true, // 사내/로컬 엔드포인트는 무인증인 경우가 많다
    },
  };
  const DEFAULT_PROVIDER = 'anthropic';

  // ---------- 설정/키 보관 ----------
  const LS_KEYS = 'medi.llm.keys.v2';   // {provider: key} — 옵트인 시에만 기록
  const LS_CONF = 'medi.llm.conf.v2';   // {provider, model, baseUrl, remember}
  let memKeys = {};                      // 메모리 보관 (기본)

  function loadConf() {
    const def = { provider: DEFAULT_PROVIDER, model: PROVIDERS[DEFAULT_PROVIDER].defaultModel, baseUrl: 'http://localhost:11434/v1', remember: false };
    try {
      const raw = localStorage.getItem(LS_CONF);
      if (raw) return Object.assign(def, JSON.parse(raw));
    } catch (e) { /* 기본값 */ }
    return def;
  }
  function saveConf(conf) {
    try { localStorage.setItem(LS_CONF, JSON.stringify(conf)); } catch (e) { /* noop */ }
  }

  function setKey(provider, key, remember) {
    const k = (key || '').trim();
    if (k) memKeys[provider] = k; else delete memKeys[provider];
    try {
      const stored = JSON.parse(localStorage.getItem(LS_KEYS) || '{}');
      if (remember && k) stored[provider] = k;
      else delete stored[provider];
      localStorage.setItem(LS_KEYS, JSON.stringify(stored));
    } catch (e) { /* 저장 불가 무시 */ }
  }
  function getKey(provider) {
    if (memKeys[provider]) return memKeys[provider];
    try {
      const stored = JSON.parse(localStorage.getItem(LS_KEYS) || '{}');
      if (stored[provider]) { memKeys[provider] = stored[provider]; return stored[provider]; }
    } catch (e) { /* noop */ }
    return null;
  }
  function clearKey(provider) {
    delete memKeys[provider];
    try {
      const stored = JSON.parse(localStorage.getItem(LS_KEYS) || '{}');
      delete stored[provider];
      localStorage.setItem(LS_KEYS, JSON.stringify(stored));
    } catch (e) { /* noop */ }
  }
  function ready(conf) {
    conf = conf || loadConf();
    const p = PROVIDERS[conf.provider];
    if (!p) return false;
    if (p.allowEmptyKey) return !!(conf.baseUrl && conf.model);
    return !!getKey(conf.provider);
  }

  // ---------- 프롬프트 ----------
  function buildPrompt(ontologyCtx, question) {
    const system = [
      '너는 석유화학 공장의 설비 예지보전(PdM) 전문가다. 정비팀 엔지니어를 돕는다.',
      '아래 JSON은 ISO 14224/ISA-5.1 기반 자산 온톨로지와 통계 분석 결과 스냅샷이다.',
      '규칙:',
      '- 답변은 한국어. 현장 엔지니어가 바로 행동할 수 있게 구체적으로.',
      '- 고장모드 판단 시 반드시 온톨로지의 failureModeLibrary 항목 id를 인용하고, 관측 증상과 미관측 증상(감별 포인트)을 구분해 설명하라.',
      '- 데이터에 없는 사실을 만들지 마라. 불확실하면 추가로 확인할 태그/점검 항목을 제시하라.',
      '- 안전 관련(인화성, 회전체, 고전압) 조치는 반드시 언급하라.',
    ].join('\n');
    const user = `## 설비 스냅샷(JSON)\n\`\`\`json\n${JSON.stringify(ontologyCtx, null, 1)}\n\`\`\`\n\n## 질문\n${question}`;
    return { system, user };
  }

  // ---------- 공통 SSE 리더 ----------
  // onEvent(dataStr)를 이벤트 단위로 호출. 'data: ' 프리픽스 라인만 전달.
  async function readSSE(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data:')) onEvent(line.slice(5).trim());
        }
      }
    }
    if (buf) {
      for (const line of buf.split('\n')) {
        if (line.startsWith('data:')) onEvent(line.slice(5).trim());
      }
    }
  }

  async function httpError(res, provider) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg = (err.error && (err.error.message || err.error.type)) || err.message || msg;
    } catch (e) { /* 상태코드만 */ }
    if (res.status === 401 || res.status === 403) msg += ' — API 키를 확인하세요.';
    if (res.status === 429) msg += ' — 요청 한도 초과. 잠시 후 재시도.';
    return new Error(`[${provider}] ${msg}`);
  }

  // ---------- 프로바이더별 스트리밍 호출 ----------
  async function callAnthropic(conf, key, system, user, onDelta) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: conf.model, max_tokens: 8192, stream: true,
        system, messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw await httpError(res, 'Anthropic');
    let full = '';
    await readSSE(res, data => {
      let ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        full += ev.delta.text;
        onDelta(ev.delta.text, full);
      } else if (ev.type === 'error') {
        throw new Error('[Anthropic] ' + (ev.error ? ev.error.message : '스트림 오류'));
      }
    });
    return full;
  }

  async function callOpenAILike(conf, key, system, user, onDelta, baseUrl, label) {
    const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: conf.model, stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw await httpError(res, label);
    let full = '';
    await readSSE(res, data => {
      if (data === '[DONE]') return;
      let ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (d && typeof d.content === 'string' && d.content) {
        full += d.content;
        onDelta(d.content, full);
      }
    });
    return full;
  }

  async function callGemini(conf, key, system, user, onDelta) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(conf.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
      }),
    });
    if (!res.ok) throw await httpError(res, 'Gemini');
    let full = '';
    await readSSE(res, data => {
      let ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      const parts = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) { full += p.text; onDelta(p.text, full); }
        }
      }
    });
    return full;
  }

  // ---------- 공개 API ----------
  // opts: {context, question, onDelta(text, full), onDone(full)}
  async function analyze(opts) {
    const conf = opts.conf || loadConf();
    const prov = PROVIDERS[conf.provider];
    if (!prov) throw new Error('알 수 없는 프로바이더: ' + conf.provider);
    const key = getKey(conf.provider);
    if (!key && !prov.allowEmptyKey) throw new Error(`${prov.name} API 키가 설정되지 않았습니다 (설정 탭에서 입력)`);
    if (!conf.model) throw new Error('모델명을 입력하세요');

    const { system, user } = buildPrompt(opts.context, opts.question);
    const onDelta = opts.onDelta || (() => {});

    let full;
    if (conf.provider === 'anthropic') full = await callAnthropic(conf, key, system, user, onDelta);
    else if (conf.provider === 'gemini') full = await callGemini(conf, key, system, user, onDelta);
    else if (conf.provider === 'openai') full = await callOpenAILike(conf, key, system, user, onDelta, null, 'OpenAI');
    else full = await callOpenAILike(conf, key, system, user, onDelta, conf.baseUrl, '호환 엔드포인트');

    if (opts.onDone) opts.onDone(full);
    return full;
  }

  return {
    PROVIDERS, DEFAULT_PROVIDER,
    loadConf, saveConf,
    setKey, getKey, clearKey, ready,
    buildPrompt, analyze,
  };
});
