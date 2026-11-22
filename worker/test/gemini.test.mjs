/** The Gemini REST call, with fetch faked: request shape, answer reading, and every failure. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, requestBody, readAnswer, modelName, DEFAULT_MODEL } from '../src/gemini.js';
import { GEMINI_ENV, GEMINI_KEY, fakeFetch, fakeSleep, geminiReply, geminiError, json } from './helpers.mjs';

const PROMPT = { system: 'RULES\n\n=== SNAPSHOT ===\nFACTS\n=== END OF SNAPSHOT ===', user: 'Question: how is DBS doing?' };

/** A fake fetch whose Gemini answers come from a list, one per call. */
function scripted(...responses) {
  let index = 0;
  return fakeFetch({ gemini: () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  } });
}
const geminiCalls = (fetchImpl) => fetchImpl.calls.filter((call) => call.url.startsWith('https://generativelanguage.googleapis.com/'));

test('the request: model in the path, key in a header, rules as the system instruction, minimal thinking', async () => {
  const fetchImpl = scripted(() => geminiReply('DBS is in a Pullback.'));
  const result = await generate(GEMINI_ENV, PROMPT, { fetchImpl });
  assert.deepEqual(result, { ok: true, text: 'DBS is in a Pullback.', truncated: false });
  const [call] = geminiCalls(fetchImpl);
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent');
  assert.ok(!call.url.includes(GEMINI_KEY), 'the key is never in the URL');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-goog-api-key'], GEMINI_KEY);
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(call.body, {
    systemInstruction: { parts: [{ text: PROMPT.system }] },
    contents: [{ role: 'user', parts: [{ text: PROMPT.user }] }],
    generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
  });
  assert.ok(!/temperature|topP|topK|top_p|top_k/i.test(JSON.stringify(call.body)), 'no sampling settings');
});

test('GEMINI_MODEL picks the model; anything that is not a plain id falls back to the default', () => {
  assert.equal(DEFAULT_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(modelName({ GEMINI_MODEL: 'gemini-3.6-flash' }), 'gemini-3.6-flash');
  assert.equal(modelName({ GEMINI_MODEL: ' models/gemini-3.5-flash-lite ' }), 'gemini-3.5-flash-lite');
  for (const bad of [undefined, '', '../../v1/other', 'gemini x', 'gemini?key=1', 'a/b']) assert.equal(modelName({ GEMINI_MODEL: bad }), DEFAULT_MODEL, String(bad));
  assert.equal(requestBody(PROMPT, { thinking: false }).generationConfig.thinkingConfig, undefined);
});

test('reading the answer: thoughts left out, blocks and empty replies named, a cut-off marked', () => {
  const ok = (body) => readAnswer(body);
  assert.deepEqual(ok({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Part one. ' }, { text: 'Part two.' }] }, finishReason: 'STOP' }] }),
    { ok: true, text: 'Part one. Part two.', truncated: false });
  assert.deepEqual(ok({ candidates: [{ content: { parts: [{ text: 'Long answer' }] }, finishReason: 'MAX_TOKENS' }] }), { ok: true, text: 'Long answer', truncated: true });
  assert.deepEqual(ok({ promptFeedback: { blockReason: 'SAFETY' } }), { ok: false, reason: 'blocked' });
  assert.deepEqual(ok({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] }), { ok: false, reason: 'blocked' });
  assert.deepEqual(ok({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }), { ok: false, reason: 'blocked' });
  assert.deepEqual(ok({ candidates: [] }), { ok: false, reason: 'empty' });
  assert.deepEqual(ok({ candidates: [{ content: { parts: [{ text: '  ' }] }, finishReason: 'STOP' }] }), { ok: false, reason: 'empty' });
  assert.deepEqual(ok({ candidates: [{ content: { parts: [{ text: 'only a thought', thought: true }] } }] }), { ok: false, reason: 'empty' });
  assert.deepEqual(ok(null), { ok: false, reason: 'empty' });
});

test('no key: nothing is sent', async () => {
  for (const key of [undefined, '', '   ']) {
    const fetchImpl = scripted(() => geminiReply('x'));
    assert.deepEqual(await generate({ ...GEMINI_ENV, GEMINI_API_KEY: key }, PROMPT, { fetchImpl }), { ok: false, reason: 'no-key' });
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('a 429 is not retried: the free quota will not refill in time', async () => {
  const fetchImpl = scripted(() => geminiError(429, 'Resource has been exhausted (e.g. check quota).', 'RESOURCE_EXHAUSTED'));
  const sleep = fakeSleep();
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl, sleep }), { ok: false, reason: 'rate-limited' });
  assert.equal(geminiCalls(fetchImpl).length, 1);
  assert.deepEqual(sleep.waits, []);
});

test('a 5xx is retried once after a second', async () => {
  const recovered = scripted(() => geminiError(503, 'The model is overloaded.', 'UNAVAILABLE'), () => geminiReply('Back.'));
  const sleep = fakeSleep();
  assert.equal((await generate(GEMINI_ENV, PROMPT, { fetchImpl: recovered, sleep })).text, 'Back.');
  assert.deepEqual(sleep.waits, [1000]);
  const down = scripted(() => geminiError(500, 'Internal error', 'INTERNAL'));
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl: down, sleep: fakeSleep() }), { ok: false, reason: 'unavailable' });
  assert.equal(geminiCalls(down).length, 2);
});

test('a model that takes no thinking settings is asked again without them', async () => {
  const fetchImpl = scripted(() => geminiError(400, 'Thinking level is not supported for this model.', 'INVALID_ARGUMENT'), () => geminiReply('Answer.'));
  assert.equal((await generate(GEMINI_ENV, PROMPT, { fetchImpl })).text, 'Answer.');
  const [first, second] = geminiCalls(fetchImpl);
  assert.ok(first.body.generationConfig.thinkingConfig);
  assert.equal(second.body.generationConfig.thinkingConfig, undefined);
  const stubborn = scripted(() => geminiError(400, 'thinking is broken', 'INVALID_ARGUMENT'));
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl: stubborn }), { ok: false, reason: 'bad-request' });
  assert.equal(geminiCalls(stubborn).length, 2, 'asked again once, not forever');
});

test('refusals are named: a bad key, a bad request, an unknown model', async () => {
  const cases = [
    [geminiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'), 'key-rejected'],
    [geminiError(403, 'Permission denied.', 'PERMISSION_DENIED'), 'key-rejected'],
    [geminiError(401, 'Unauthenticated.', 'UNAUTHENTICATED'), 'key-rejected'],
    [geminiError(400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT'), 'bad-request'],
    [geminiError(404, 'models/gemini-test-model is not found for API version v1beta.', 'NOT_FOUND'), 'bad-model'],
    [new Response('not json', { status: 418 }), 'unavailable'],
  ];
  for (const [response, reason] of cases) {
    const fetchImpl = scripted(() => response);
    assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl, sleep: fakeSleep() }), { ok: false, reason });
  }
});

test('a network error or a timeout is an answer too, never a throw', async () => {
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl: scripted(new TypeError('fetch failed')) }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl: scripted(new DOMException('timed out', 'TimeoutError')) }), { ok: false, reason: 'timeout' });
  const garbled = scripted(() => new Response('<html>', { status: 200 }));
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl: garbled }), { ok: false, reason: 'empty' });
  assert.deepEqual(await generate(GEMINI_ENV, PROMPT, { fetchImpl: scripted(() => json({ candidates: 'odd' })) }), { ok: false, reason: 'empty' });
});
