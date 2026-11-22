/**
 * The webhook's front door: routing, the secret header, the chat allowlist, which updates are
 * answered, and what reaches the logs (never a token, a chat id or a message's text).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, respond, sameSecret } from '../src/index.js';
import { ENV, CHAT, TOKEN, SECRET, FIXTURE, fakeFetch, fakeCtx, fakeSleep, webhook, textUpdate, captureConsole, hoursAfter, json } from './helpers.mjs';

const deps = (fetchImpl) => ({ fetchImpl, sleep: fakeSleep(), now: () => hoursAfter(FIXTURE.asOf, 5) });

async function run(request, { fetchImpl = fakeFetch(), env = ENV } = {}) {
  const ctx = fakeCtx();
  const response = await handle(request, env, ctx, deps(fetchImpl));
  await ctx.settled();
  return { response, body: await response.text(), ctx, fetchImpl };
}

test('GET / is a health check that shows no configuration', async () => {
  const { response, body, fetchImpl } = await run(new Request('https://bot.example.test/'));
  assert.equal(response.status, 200);
  assert.equal(body, 'QuantLens bot: ok\n');
  for (const value of Object.values(ENV)) assert.ok(!body.includes(value));
  assert.equal(fetchImpl.calls.length, 0);
});

test('other paths are 404 and other methods on /webhook are 405', async () => {
  assert.equal((await run(webhook({}, { path: '/other' }))).response.status, 404);
  assert.equal((await run(webhook({}, { path: '/webhook/extra' }))).response.status, 404);
  assert.equal((await run(webhook(null, { method: 'GET' }))).response.status, 405);
  assert.equal((await run(webhook({}, { method: 'PUT' }))).response.status, 405);
});

test('a missing or wrong secret header is 401 and nothing is sent', async () => {
  // (Header values lose surrounding spaces in transit, so a trailing space is no test.)
  for (const secret of [null, '', 'secret_ABC-12', 'secret_ABC-1234', 'SECRET_ABC-123', 'secret_ABC_123']) {
    const { response, ctx, fetchImpl } = await run(webhook(textUpdate('/help'), { secret }));
    assert.equal(response.status, 401, `secret ${JSON.stringify(secret)}`);
    assert.equal(ctx.pending.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('with no secret configured every webhook request is refused', async () => {
  const env = { ...ENV, TELEGRAM_WEBHOOK_SECRET: '' };
  for (const secret of [null, '']) {
    const { response } = await run(webhook(textUpdate('/help'), { secret }), { env });
    assert.equal(response.status, 401);
  }
  const { response } = await run(webhook(textUpdate('/help')), { env: { ...ENV, TELEGRAM_WEBHOOK_SECRET: undefined } });
  assert.equal(response.status, 401);
});

test('sameSecret compares whole values', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abd', 'abc'), false);
  assert.equal(sameSecret('ab', 'abc'), false);
  assert.equal(sameSecret('abcd', 'abc'), false);
  assert.equal(sameSecret(undefined, 'abc'), false);
  assert.equal(sameSecret('', ''), false);
  assert.equal(sameSecret(null, undefined), false);
  assert.equal(sameSecret('abc', 'abc\r\n'), true, 'a pasted secret may end in a newline');
  assert.equal(sameSecret('', '  \n'), false, 'a blank secret is no secret');
});

test('an allowed private chat gets its answer, after Telegram has its 200', async () => {
  const { response, ctx, fetchImpl } = await run(webhook(textUpdate('/regime')));
  assert.equal(response.status, 200);
  assert.equal(ctx.pending.length, 1);
  const [message] = fetchImpl.messages();
  assert.equal(message.chat_id, CHAT);
  assert.equal(message.parse_mode, 'MarkdownV2');
  assert.match(message.text, /Market regime: stressed/);
  assert.ok(fetchImpl.calls.some((call) => call.url === ENV.CONTEXT_URL));
});

test('a chat outside TELEGRAM_CHAT_ID gets nothing, and nothing is fetched', async () => {
  for (const update of [textUpdate('/check D05', { chatId: 1234 }), textUpdate('hello', { chatId: -100111, type: 'group' })]) {
    const { response, ctx, fetchImpl } = await run(webhook(update));
    assert.equal(response.status, 200);
    assert.equal(ctx.pending.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('a group id and a channel username from the allowlist are both answered', async () => {
  const group = await run(webhook(textUpdate('/help', { chatId: -1009876543210, type: 'supergroup' })));
  assert.equal(group.fetchImpl.messages().length, 1);
  const channel = await run(webhook(textUpdate('/help', { chatId: -1001111, type: 'channel', username: 'quantlenstest', kind: 'channel_post' })));
  assert.equal(channel.fetchImpl.messages().length, 1);
  assert.equal(channel.fetchImpl.messages()[0].chat_id, -1001111);
});

test('updates without text, edits and malformed bodies are acknowledged and ignored', async () => {
  const sticker = { update_id: 1, message: { message_id: 2, date: 1, chat: { id: CHAT, type: 'private' }, sticker: { file_id: 'x' } } };
  const edited = { update_id: 3, edited_message: { message_id: 4, date: 1, chat: { id: CHAT, type: 'private' }, text: '/help' } };
  const blank = textUpdate('   ');
  for (const request of [webhook(sticker), webhook(edited), webhook(blank), webhook(null, { raw: '{not json' }), webhook(null, { raw: '' })]) {
    const { response, ctx, fetchImpl } = await run(request);
    assert.equal(response.status, 200);
    assert.equal(ctx.pending.length, 0);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('the logs never hold the token, the secret, a chat id or what was asked', async () => {
  const question = 'how is DBS trending this week?';
  const failing = fakeFetch({ telegram: (call) => { throw new TypeError(`fetch failed: ${call.url}`); } });
  const lines = await captureConsole(async () => {
    await run(webhook(textUpdate('/check D05')));
    await run(webhook(textUpdate(question)));
    await run(webhook(textUpdate('/check D05', { chatId: 1234 })));
    await run(webhook(textUpdate('/help'), { secret: 'guess-1' }));
    await run(webhook(null, { raw: '{oops' }));
    await run(webhook(textUpdate('/upcoming')), { fetchImpl: failing });
    await run(webhook(textUpdate('/check D05')), { fetchImpl: fakeFetch({ context: () => json({ error: 'gone' }, 503) }) });
  });
  assert.ok(lines.length >= 6, `expected log lines, got ${lines.length}`);
  const forbidden = [TOKEN, SECRET, 'guess-1', String(CHAT), '1234', 'D05', 'DBS', question, 'api.telegram.org', 'bot123456789'];
  for (const line of lines) {
    for (const value of forbidden) assert.ok(!line.includes(value), `log line leaks ${value}: ${line}`);
    assert.doesNotThrow(() => JSON.parse(line), `log lines are JSON: ${line}`);
  }
  const events = lines.map((line) => JSON.parse(line).event);
  for (const event of ['command', 'question', 'ignored', 'rejected', 'error']) assert.ok(events.includes(event), `no ${event} log`);
});

test('respond never throws: a failure becomes a short plain apology', async () => {
  let attempts = 0;
  const flaky = fakeFetch({
    telegram: (call) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('network down');
      return json({ ok: true, result: {} });
    },
  });
  const outcome = await respond({ chat: { id: CHAT }, messageId: 5, text: '/regime' }, ENV, deps(flaky));
  assert.equal(outcome, 'failed');
  const [attempt, apology] = flaky.messages();
  assert.match(attempt.text, /Market regime/, 'the reply that failed in transit');
  assert.equal(apology.text, 'Something went wrong while preparing that answer. Try /help.');
  assert.equal(apology.parse_mode, undefined);
});

test('when GitHub Pages is down a command says so in words', async () => {
  const down = fakeFetch({ context: () => json({}, 503) });
  await respond({ chat: { id: CHAT }, messageId: 5, text: '/check D05' }, ENV, deps(down));
  const [text] = down.texts();
  assert.match(text, /QuantLens data is unreachable right now: GitHub Pages returned HTTP 503/);
});

test('a plain question shows "typing" and replies to the question', async () => {
  const fetchImpl = fakeFetch();
  await respond({ chat: { id: CHAT }, messageId: 77, text: 'what is the VIX doing?' }, { ...ENV, GEMINI_API_KEY: undefined }, deps(fetchImpl));
  assert.equal(fetchImpl.calls[0].method, 'sendChatAction');
  assert.equal(fetchImpl.calls[0].body.action, 'typing');
  const [message] = fetchImpl.messages();
  assert.equal(message.reply_parameters.message_id, 77);
});
