/**
 * index.js: the QuantLens Telegram agent, a Cloudflare Worker (V4.0).
 *
 *   GET  /          a one-line health check (no data, no configuration)
 *   POST /webhook   Telegram updates
 *
 * A webhook request must carry the X-Telegram-Bot-Api-Secret-Token header given to setWebhook
 * (compared in constant time), and must come from a chat in TELEGRAM_CHAT_ID; anything else is
 * answered with nothing. Telegram gets its 200 at once and the reply is prepared afterwards in
 * ctx.waitUntil, so a slow answer never makes Telegram retry and deliver the message twice.
 *
 * Slash commands are answered by code from data/bot_context.json (commands.js). Other text goes
 * to the plain-English path (answer.js), which only ever speaks from the same file.
 *
 * Stateless: no KV, no database, no stored conversation. Logs name what happened, never a
 * token, a chat id or a message's text.
 */

import { allowedChats, isAllowed, readUpdate, sendLines, sendTyping } from './telegram.js';
import { loadContext } from './context.js';
import { parseCommand, runCommand } from './commands.js';
import { answerQuestion } from './answer.js';

/** Constant-time string comparison, so the secret cannot be guessed one character at a time. */
export function sameSecret(given, expected) {
  const a = new TextEncoder().encode(String(given ?? ''));
  const b = new TextEncoder().encode(String(expected ?? ''));
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0 && b.length > 0;
}

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function log(event, detail = {}) {
  console.log(JSON.stringify({ event, ...detail }));
}

/** Prepare and send the reply to one allowed message. Never throws. */
export async function respond(message, env, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const chatId = message.chat.id;
  try {
    const command = parseCommand(message.text);
    if (command) {
      const loaded = await loadContext(env, { fetchImpl, now });
      const lines = runCommand(command, loaded, env);
      const outcome = await sendLines(env, chatId, lines, { fetchImpl, sleep: deps.sleep });
      log('command', { command: command.name, data: loaded.ok ? 'ok' : 'unavailable', outcome });
      return outcome;
    }
    await sendTyping(env, chatId, { fetchImpl });
    const { outcome, answer, flagged } = await answerQuestion(message, env, { ...deps, fetchImpl, now });
    log('question', { followUp: Boolean(message.replyTo), answer, flagged, outcome });
    return outcome;
  } catch (error) {
    log('error', { kind: error && error.name ? error.name : 'Error' });
    try {
      await sendLines(env, chatId, ['Something went wrong while preparing that answer. Try /help.'], { fetchImpl, sleep: deps.sleep, markdown: false });
    } catch {
      // nothing more to do
    }
    return 'failed';
  }
}

/**
 * The request handler, with its dependencies injectable for tests.
 * @param {Request} request
 * @param {object} env
 * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
 */
export async function handle(request, env, ctx, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/' && request.method === 'GET') return text('QuantLens bot: ok\n');
  if (url.pathname !== '/webhook') return text('Not found\n', 404);
  if (request.method !== 'POST') return text('Method not allowed\n', 405);
  if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    log('rejected', { reason: 'secret' });
    return text('Unauthorized\n', 401);
  }
  let update;
  try {
    update = await request.json();
  } catch {
    log('ignored', { reason: 'not JSON' });
    return text('ok\n');
  }
  const message = readUpdate(update);
  if (!message) return text('ok\n');
  if (!isAllowed(message.chat, allowedChats(env.TELEGRAM_CHAT_ID))) {
    log('ignored', { reason: 'chat not allowed' });
    return text('ok\n');
  }
  ctx.waitUntil(respond(message, env, deps));
  return text('ok\n');
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};
