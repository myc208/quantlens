/** The Bot API side: the allowlist, reading updates, and sending (splitting, fallback, 429). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedChats, isAllowed, readUpdate, sendLines, sendPlain, sendTyping } from '../src/telegram.js';
import { bold, TELEGRAM_LIMIT } from '../src/format.js';
import { ENV, CHAT, TOKEN, fakeFetch, fakeSleep, json, textUpdate, markdownProblem } from './helpers.mjs';

const parseError = () => json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: character '.' is reserved" }, 400);
const manyLines = (count) => Array.from({ length: count }, (_, i) => [bold(`Row ${i}.`), ` value ${i}.5% (est.) ${'x'.repeat(40)}`]);

test('TELEGRAM_CHAT_ID holds ids and @channel names, comma-separated', () => {
  assert.deepEqual([...allowedChats(' 111, -1009876543210 ,@MyChannel, junk, 12a, @ab, ')], ['111', '-1009876543210', '@mychannel']);
  assert.equal(allowedChats(undefined).size, 0);
  assert.equal(allowedChats('').size, 0);
  const allowed = allowedChats(ENV.TELEGRAM_CHAT_ID);
  assert.equal(isAllowed({ id: CHAT }, allowed), true);
  assert.equal(isAllowed({ id: String(CHAT) }, allowed), true);
  assert.equal(isAllowed({ id: -1009876543210 }, allowed), true);
  assert.equal(isAllowed({ id: -100555, username: 'QUANTLENSTEST' }, allowed), true);
  assert.equal(isAllowed({ id: -100555, username: 'someoneelse' }, allowed), false);
  assert.equal(isAllowed({ id: 4815162343 }, allowed), false);
  assert.equal(isAllowed({}, allowed), false);
  assert.equal(isAllowed(null, allowed), false);
});

test('readUpdate takes text messages and channel posts, and replies to the bot', () => {
  const plain = readUpdate(textUpdate(' /check d05 '));
  assert.equal(plain.text, '/check d05');
  assert.equal(plain.chat.id, CHAT);
  assert.equal(plain.replyTo, null);
  const post = readUpdate(textUpdate('/regime', { kind: 'channel_post', chatId: -1001, type: 'channel' }));
  assert.equal(post.text, '/regime');
  const followUp = readUpdate(textUpdate('and its beta?', { replyTo: 'D05.SI · DBS Group Holdings Ltd' }));
  assert.equal(followUp.replyTo, 'D05.SI · DBS Group Holdings Ltd');
  const toPerson = textUpdate('and its beta?', { replyTo: 'hi' });
  toPerson.message.reply_to_message.from.is_bot = false;
  assert.equal(readUpdate(toPerson).replyTo, null);
  for (const update of [null, {}, { edited_message: { text: 'x', chat: { id: 1 } } }, { message: { chat: { id: 1 } } }, { message: { text: 'x' } }]) {
    assert.equal(readUpdate(update), null);
  }
});

test('a reply is sent as escaped MarkdownV2, without link previews, replying to the question', async () => {
  const fetchImpl = fakeFetch();
  const outcome = await sendLines(ENV, CHAT, [[bold('D05.SI')], 'RS 1M −2.1% (vs ^STI)'], { fetchImpl, replyTo: 55 });
  assert.equal(outcome, 'sent');
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.body, {
    chat_id: CHAT,
    text: '*D05\\.SI*\nRS 1M −2\\.1% \\(vs ^STI\\)',
    link_preview_options: { is_disabled: true },
    parse_mode: 'MarkdownV2',
    reply_parameters: { message_id: 55, allow_sending_without_reply: true },
  });
});

test('a token stored with a stray newline still makes a valid URL', async () => {
  const fetchImpl = fakeFetch();
  await sendLines({ ...ENV, TELEGRAM_BOT_TOKEN: `${TOKEN}\r\n` }, CHAT, ['hi'], { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
});

test('a long reply goes out as several messages, each under 4,096 characters', async () => {
  const fetchImpl = fakeFetch();
  assert.equal(await sendLines(ENV, CHAT, manyLines(200), { fetchImpl, replyTo: 9 }), 'sent');
  const messages = fetchImpl.messages();
  assert.ok(messages.length >= 3, `${messages.length} messages`);
  for (const message of messages) {
    assert.ok(message.text.length <= TELEGRAM_LIMIT);
    assert.equal(markdownProblem(message.text), null);
  }
  assert.equal(messages[0].reply_parameters.message_id, 9);
  assert.ok(messages.slice(1).every((message) => !message.reply_parameters), 'only the first message is a reply');
  const rows = messages.flatMap((message) => message.text.split('\n'));
  assert.equal(rows.length, 200);
  assert.ok(rows[199].startsWith('*Row 199\\.*'));
});

test('formatting Telegram rejects is resent as plain text, from that message on', async () => {
  let markdownCalls = 0;
  const fetchImpl = fakeFetch({
    telegram: (call) => {
      if (!call.body.parse_mode) return json({ ok: true, result: {} });
      markdownCalls += 1;
      return markdownCalls === 2 ? parseError() : json({ ok: true, result: {} });
    },
  });
  const lines = manyLines(200);
  assert.equal(await sendLines(ENV, CHAT, lines, { fetchImpl }), 'sent-plain');
  const messages = fetchImpl.messages();
  assert.equal(messages[0].parse_mode, 'MarkdownV2');
  assert.equal(messages[1].parse_mode, 'MarkdownV2', 'the rejected one');
  const resent = messages.slice(2);
  assert.ok(resent.length >= 2);
  assert.ok(resent.every((message) => message.parse_mode === undefined));
  assert.ok(resent[0].text.startsWith('Row '), 'plain text, no asterisks');
  const delivered = [messages[0], ...resent].flatMap((message) => message.text.split('\n'));
  assert.equal(delivered.length, 200, 'every line delivered once');
});

test('a 429 is waited out once, for at most 5 seconds', async () => {
  for (const [retryAfter, waited] of [[3, 3000], [60, 5000]]) {
    let calls = 0;
    const sleep = fakeSleep();
    const fetchImpl = fakeFetch({
      telegram: () => {
        calls += 1;
        return calls === 1 ? json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: retryAfter } }, 429) : json({ ok: true, result: {} });
      },
    });
    assert.equal(await sendLines(ENV, CHAT, ['hello'], { fetchImpl, sleep }), 'sent');
    assert.deepEqual(sleep.waits, [waited]);
    assert.equal(fetchImpl.messages().length, 2);
  }
  const always = fakeFetch({ telegram: () => json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429) });
  assert.equal(await sendLines(ENV, CHAT, ['hello'], { fetchImpl: always, sleep: fakeSleep() }), 'failed');
  assert.equal(always.messages().length, 2);
});

test('other errors are not retried', async () => {
  const blocked = fakeFetch({ telegram: () => json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 403) });
  assert.equal(await sendLines(ENV, CHAT, ['a', 'b'], { fetchImpl: blocked }), 'failed');
  assert.equal(blocked.messages().length, 1);
  const garbled = fakeFetch({ telegram: () => new Response('<html>bad gateway</html>', { status: 502 }) });
  assert.equal(await sendLines(ENV, CHAT, ['a'], { fetchImpl: garbled }), 'failed');
});

test('plain text is sent as is, and "typing" never fails the answer', async () => {
  const fetchImpl = fakeFetch();
  assert.equal(await sendPlain(ENV, CHAT, 'Beta 1.10 (vs ^STI).\n*not bold*', { fetchImpl }), 'sent-plain');
  const [message] = fetchImpl.messages();
  assert.equal(message.text, 'Beta 1.10 (vs ^STI).\n*not bold*');
  assert.equal(message.parse_mode, undefined);
  await sendTyping(ENV, CHAT, { fetchImpl: async () => { throw new TypeError('offline'); } });
  const typing = fakeFetch();
  await sendTyping(ENV, CHAT, { fetchImpl: typing });
  assert.deepEqual(typing.calls[0].body, { chat_id: CHAT, action: 'typing' });
});
