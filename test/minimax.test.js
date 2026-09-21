'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chat, extractJson, stripThinking, MiniMaxError } = require('../src/main/minimax');

test('stripThinking removes reasoning blocks', () => {
  assert.equal(stripThinking('<think>hmm</think>\nHola'), 'Hola');
  assert.equal(stripThinking('Hola'), 'Hola');
});

test('extractJson handles fences, prose and nested braces', () => {
  assert.deepEqual(extractJson('```json\n{"a": [1, {"b": "}"}]}\n```'), { a: [1, { b: '}' }] });
  assert.deepEqual(extractJson('Aquí tienes: {"x": "y"} espero que sirva'), { x: 'y' });
  assert.deepEqual(extractJson('<think>pensando {no}</think>{"ok": true}'), { ok: true });
  assert.throws(() => extractJson('sin json'), MiniMaxError);
});

function fakeFetch(status, body) {
  return async (url, init) => {
    fakeFetch.last = { url, init: JSON.parse(init.body), headers: init.headers };
    return { ok: status < 400, status, statusText: 'x', text: async () => JSON.stringify(body) };
  };
}

test('chat posts to the OpenAI-compatible endpoint with bearer auth', async () => {
  const fetchImpl = fakeFetch(200, { model: 'MiniMax-M2.5', choices: [{ message: { content: '<think>r</think>Hola' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } });
  const res = await chat({ apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], baseUrl: 'https://api.minimax.io/v1/', fetchImpl });
  assert.equal(fakeFetch.last.url, 'https://api.minimax.io/v1/chat/completions');
  assert.equal(fakeFetch.last.headers.Authorization, 'Bearer k');
  assert.equal(fakeFetch.last.init.model, 'MiniMax-M2.5');
  assert.equal(res.content, 'Hola');
  assert.equal(res.rawContent, '<think>r</think>Hola');
  assert.equal(res.usage.total_tokens, 3);
});

test('chat surfaces auth and base_resp errors', async () => {
  await assert.rejects(chat({ apiKey: '', messages: [{ role: 'user', content: 'x' }] }), /Falta la clave/);
  await assert.rejects(chat({ apiKey: 'k', messages: [{ role: 'user', content: 'x' }], fetchImpl: fakeFetch(401, { error: { message: 'bad key' } }) }), (e) => e.code === 'AUTH');
  await assert.rejects(chat({ apiKey: 'k', messages: [{ role: 'user', content: 'x' }], fetchImpl: fakeFetch(200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }) }), (e) => e.code === 'BALANCE');
  await assert.rejects(chat({ apiKey: 'k', messages: [{ role: 'user', content: 'x' }], fetchImpl: fakeFetch(429, {}) }), (e) => e.code === 'RATE_LIMIT');
});
