/* MEDI 예지보전 — LLM(Claude) 연동 (선택 기능, 추후 사용)
 * API 키가 없으면 완전히 비활성 — 룰베이스(report.js)가 기본 경로다.
 * 키 입력 시: 온톨로지 + 분석결과 스냅샷을 컨텍스트로 브라우저에서 직접
 * Anthropic Messages API 호출(스트리밍). 백엔드 불필요(BYOK + CORS 헤더).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.MEDI = root.MEDI || {}; root.MEDI.llm = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODELS = [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 (권장)' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (저비용)' },
  ];
  const DEFAULT_MODEL = 'claude-opus-4-8';

  // 키는 기본 메모리 보관. "기억하기"는 명시적 옵트인(localStorage) — XSS 시 유출 위험 고지 필요.
  const KEY_LS = 'medi.llm.key';
  let memKey = null;

  function setKey(key, remember) {
    memKey = (key || '').trim() || null;
    try {
      if (remember && memKey) localStorage.setItem(KEY_LS, memKey);
      else localStorage.removeItem(KEY_LS);
    } catch (e) { /* 저장 불가 환경 무시 */ }
  }

  function getKey() {
    if (memKey) return memKey;
    try {
      const k = localStorage.getItem(KEY_LS);
      if (k) { memKey = k; return k; }
    } catch (e) { /* noop */ }
    return null;
  }

  function clearKey() {
    memKey = null;
    try { localStorage.removeItem(KEY_LS); } catch (e) { /* noop */ }
  }

  function hasKey() { return !!getKey(); }

  // 온톨로지 + 분석결과 → LLM 컨텍스트 프롬프트
  function buildPrompt(ontologyCtx, question) {
    const system = [
      '너는 석유화학 공장의 설비 예지보전(PdM) 전문가다. 정비팀 엔지니어를 돕는다.',
      '아래 JSON은 ISO 14224/ISA-5.1 기반 자산 온톨로지와 통계 분석 결과 스냅샷이다.',
      '규칙:',
      '- 답변은 한국어. 현장 엔지니어가 바로 행동할 수 있게 구체적으로.',
      '- 고장모드 판단 시 반드시 온톨로지의 failureModeLibrary 항목 id를 인용하고, 관측 증상과 미관측 증상(감별 포인트)을 구분해 설명하라.',
      '- 데이터에 없는 사실을 만들지 마라. 불확실하면 추가로 확인할 태그/점검 항목을 제시하라.',
      '- 안전 관련(인화성, 회전체) 조치는 반드시 언급하라.',
    ].join('\n');
    const user = `## 설비 스냅샷(JSON)\n\`\`\`json\n${JSON.stringify(ontologyCtx, null, 1)}\n\`\`\`\n\n## 질문\n${question}`;
    return { system, user };
  }

  // 스트리밍 호출: onDelta(text), onDone(fullText), onError(err)
  async function analyze(opts) {
    const key = getKey();
    if (!key) throw new Error('API 키가 설정되지 않았습니다 (설정 탭에서 입력)');
    const model = opts.model || DEFAULT_MODEL;
    const { system, user } = buildPrompt(opts.context, opts.question);

    const messages = (opts.history || []).concat([{ role: 'user', content: user }]);

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        system,
        messages,
      }),
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        msg = (err.error && err.error.message) || msg;
      } catch (e) { /* 본문 파싱 실패 시 상태코드만 */ }
      if (res.status === 401) { clearKey(); msg += ' — API 키가 유효하지 않아 저장된 키를 삭제했습니다.'; }
      throw new Error(msg);
    }

    // SSE 수동 파싱 (EventSource는 POST/커스텀헤더 불가)
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const dataLine = part.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          full += ev.delta.text;
          if (opts.onDelta) opts.onDelta(ev.delta.text, full);
        } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'refusal') {
          throw new Error('모델이 요청을 거부했습니다 (safety refusal)');
        } else if (ev.type === 'error') {
          throw new Error(ev.error ? ev.error.message : '스트림 오류');
        }
      }
    }
    if (opts.onDone) opts.onDone(full);
    return full;
  }

  return { MODELS, DEFAULT_MODEL, setKey, getKey, clearKey, hasKey, buildPrompt, analyze };
});
