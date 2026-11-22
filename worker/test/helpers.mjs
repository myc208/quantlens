/**
 * helpers.mjs: shared fakes for the Worker tests. Nothing here talks to a network: Telegram,
 * GitHub Pages and Gemini are all answered by fakeFetch, and every token is a made-up value.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

/** A frozen copy of bot_context.json (asOf 2026-11-22): exact-text tests run against it. */
export const FIXTURE = read('./fixtures/bot_context.json');
/** The file the daily pipeline commits: shape and size tests run against whatever it holds today. */
export const COMMITTED = read('../../data/bot_context.json');

export const clone = (value) => structuredClone(value);
export const hoursAfter = (iso, hours) => new Date(Date.parse(iso) + hours * 3_600_000);

export const TOKEN = '123456789:TEST-fake_token-value';
export const SECRET = 'secret_ABC-123';
export const ENV = Object.freeze({
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_CHAT_ID: '4815162342, -1009876543210, @QuantLensTest',
  CONTEXT_URL: 'https://pages.example.test/quantlens/data/bot_context.json',
  SITE_URL: 'https://pages.example.test/quantlens/',
  CONTEXT_CACHE_SECONDS: '300',
  GEMINI_MODEL: 'gemini-test-model',
});
export const CHAT = 4815162342;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch that answers the three hosts the Worker uses and records every call.
 *   context   the summary to serve, or a function (call) => Response
 *   telegram  (call) => Response for Bot API calls; default: ok
 *   gemini    (call) => Response for generateContent; default: an error (no test should reach it)
 */
export function fakeFetch({ context = FIXTURE, telegram, gemini } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const href = String(url);
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url: href, init, body, method: null };
    calls.push(call);
    if (href.startsWith('https://api.telegram.org/')) {
      call.method = href.split('/').pop();
      return telegram ? telegram(call, calls) : json({ ok: true, result: { message_id: 9000 + calls.length } });
    }
    if (href === ENV.CONTEXT_URL) return typeof context === 'function' ? context(call) : json(context);
    if (href.startsWith('https://generativelanguage.googleapis.com/')) {
      return gemini ? gemini(call, calls) : json({ error: { code: 500, message: 'no fake Gemini in this test' } }, 500);
    }
    throw new TypeError(`fetch failed: no fake for ${href}`);
  };
  impl.calls = calls;
  impl.messages = () => calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);
  impl.texts = () => impl.messages().map((message) => message.text);
  return impl;
}

/** A Worker ExecutionContext that keeps what waitUntil was given, to await in a test. */
export function fakeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    settled: () => Promise.all(pending),
  };
}

/** A webhook request as Telegram sends it. */
export function webhook(update, { secret = SECRET, method = 'POST', path = '/webhook', raw = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  const body = method === 'GET' || method === 'HEAD' ? undefined : (raw ?? JSON.stringify(update));
  return new Request(`https://quantlens-bot.example.test${path}`, { method, headers, body });
}

let nextId = 100;

/** An update with one text message; `replyTo` makes it a reply to one of the bot's messages. */
export function textUpdate(text, { chatId = CHAT, type = 'private', username = undefined, replyTo = null, kind = 'message' } = {}) {
  nextId += 1;
  const chat = { id: chatId, type, ...(username ? { username } : {}) };
  const message = { message_id: nextId, date: 1795000000, chat, text };
  if (kind === 'message') message.from = { id: chatId > 0 ? chatId : 42, is_bot: false, first_name: 'Test' };
  if (replyTo) message.reply_to_message = { message_id: 7, date: 1794990000, chat, from: { id: 1, is_bot: true, first_name: 'QuantLens' }, text: replyTo };
  return { update_id: nextId, [kind]: message };
}

/** Run fn with console output captured: returns every line written. */
export async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[key] = console[key];
    console[key] = (...args) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

/** No waiting in tests: records the requested delays. */
export function fakeSleep() {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  sleep.waits = waits;
  return sleep;
}

/**
 * Check that a MarkdownV2 text would parse: every special character is escaped except the
 * asterisks of bold, and those come in pairs. Returns the problem, or null.
 */
export function markdownProblem(text) {
  const special = '_*[]()~`>#+-=|{}.!\\';
  let open = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      if (i + 1 >= text.length || !special.includes(text[i + 1])) return `stray backslash at ${i}`;
      i += 1;
    } else if (char === '*') open = !open;
    else if (special.includes(char)) return `unescaped ${char} at ${i}: ${text.slice(Math.max(0, i - 20), i + 20)}`;
  }
  return open ? 'unclosed bold' : null;
}

/** A made-up Gemini key: tests check it never reaches a URL, a log or a chat. */
export const GEMINI_KEY = 'test-gemini-key-not-real-0001';
export const GEMINI_ENV = Object.freeze({ ...ENV, GEMINI_API_KEY: GEMINI_KEY });

/** A generateContent response with one answer (and, optionally, a thought part before it). */
export function geminiReply(text, { finishReason = 'STOP', thought = null } = {}) {
  const parts = [...(thought ? [{ text: thought, thought: true }] : []), { text }];
  return json({ candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }], usageMetadata: { promptTokenCount: 7000, candidatesTokenCount: 60 } });
}

/** A Gemini API error response. */
export function geminiError(status, message, reason = 'ERROR') {
  return json({ error: { code: status, message, status: reason } }, status);
}
