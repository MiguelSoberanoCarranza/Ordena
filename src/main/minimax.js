'use strict';

// Minimal client for MiniMax's OpenAI-compatible Chat Completions API.
// Docs: https://platform.minimax.io  (international)  |  https://platform.minimaxi.com (China)

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = 'MiniMax-M2.5';
const KNOWN_MODELS = ['MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2', 'MiniMax-M1', 'MiniMax-Text-01'];

class MiniMaxError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'MiniMaxError';
    this.status = status;
    this.code = code;
  }
}

/** Remove the <think>…</think> reasoning block some MiniMax models prepend to their answer. */
function stripThinking(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Extract the first JSON object/array from a free-form answer (handles ```json fences). */
function extractJson(text) {
  const clean = stripThinking(text);
  const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(clean);
  for (const c of candidates) {
    const start = Math.min(...['{', '['].map((ch) => c.indexOf(ch)).filter((i) => i >= 0));
    if (!Number.isFinite(start)) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < c.length; i += 1) {
      const ch = c[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) {
          const slice = c.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch {
            break;
          }
        }
      }
    }
    void close;
  }
  throw new MiniMaxError('La respuesta de la IA no contiene JSON válido');
}

/**
 * Send a chat completion request.
 * @param {object} p
 * @param {string} p.apiKey
 * @param {Array<{role:string, content:string}>} p.messages
 * @param {string} [p.baseUrl]
 * @param {string} [p.model]
 * @param {number} [p.temperature]
 * @param {number} [p.maxTokens]
 * @param {AbortSignal} [p.signal]
 * @param {typeof fetch} [p.fetchImpl]  injectable for tests
 * @returns {Promise<{content:string, usage:object|null, model:string}>}
 */
async function chat(p) {
  const {
    apiKey,
    messages,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    temperature = 0.3,
    maxTokens = 8192,
    signal,
    fetchImpl = globalThis.fetch,
  } = p;
  if (!apiKey) throw new MiniMaxError('Falta la clave de API de MiniMax. Configúrala en Ajustes.', { code: 'NO_API_KEY' });
  if (!Array.isArray(messages) || messages.length === 0) throw new MiniMaxError('Sin mensajes');

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new MiniMaxError('Solicitud cancelada', { code: 'ABORTED' });
    throw new MiniMaxError(`No se pudo conectar con MiniMax: ${err.message}`, { code: 'NETWORK' });
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch { /* handled below */ }

  if (!res.ok) {
    const msg = data?.error?.message || data?.base_resp?.status_msg || raw.slice(0, 300) || res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new MiniMaxError(`Clave de API rechazada (${res.status}): ${msg}`, { status: res.status, code: 'AUTH' });
    }
    if (res.status === 429) throw new MiniMaxError(`Límite de uso alcanzado: ${msg}`, { status: 429, code: 'RATE_LIMIT' });
    throw new MiniMaxError(`Error de MiniMax (${res.status}): ${msg}`, { status: res.status });
  }
  // MiniMax may answer HTTP 200 with an error inside base_resp.
  if (data?.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    const code = data.base_resp.status_code;
    const msg = data.base_resp.status_msg || 'error desconocido';
    if (code === 1004) throw new MiniMaxError(`Clave de API inválida: ${msg}`, { code: 'AUTH' });
    if (code === 1008) throw new MiniMaxError(`Saldo insuficiente en la cuenta de MiniMax: ${msg}`, { code: 'BALANCE' });
    if (code === 1002 || code === 1039) throw new MiniMaxError(`Límite de uso alcanzado: ${msg}`, { code: 'RATE_LIMIT' });
    throw new MiniMaxError(`Error de MiniMax (${code}): ${msg}`, { code: String(code) });
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') {
    throw new MiniMaxError('Respuesta inesperada de MiniMax (sin contenido)');
  }
  return {
    content: stripThinking(content),
    rawContent: content,
    finishReason: choice.finish_reason || null,
    usage: data.usage || null,
    model: data.model || model,
  };
}

module.exports = { chat, extractJson, stripThinking, MiniMaxError, DEFAULT_BASE_URL, DEFAULT_MODEL, KNOWN_MODELS };
