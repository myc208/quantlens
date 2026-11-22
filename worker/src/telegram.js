/**
 * telegram.js: reading webhook updates and sending replies through the Bot API.
 *
 * Replies are rendered as MarkdownV2 (bold headings, everything else escaped), split under
 * Telegram's 4,096-character limit at line breaks, and resent as plain text if Telegram rejects
 * the formatting. A 429 is waited out once (at most 5 seconds). The token is part of every
 * request URL, so no URL and no response body is ever logged.
 */

import { groupLines, renderLine } from './format.js';

const API = 'https://api.telegram.org';
const MAX_RETRY_WAIT_S = 5;
const CHAT_ID = /^-?\d+$/;
const CHANNEL = /^@[A-Za-z][A-Za-z0-9_]{3,}$/;

/** The chats in TELEGRAM_CHAT_ID: numeric ids and @channel names, comma-separated (as for the briefing). */
export function allowedChats(raw) {
  const allowed = new Set();
  for (const entry of String(raw ?? '').split(',')) {
    const value = entry.trim();
    if (CHAT_ID.test(value)) allowed.add(value);
    else if (CHANNEL.test(value)) allowed.add(value.toLowerCase());
  }
  return allowed;
}

export function isAllowed(chat, allowed) {
  if (!chat || chat.id === undefined || chat.id === null) return false;
  if (allowed.has(String(chat.id))) return true;
  return typeof chat.username === 'string' && allowed.has(`@${chat.username}`.toLowerCase());
}

/**
 * The text message in an update, or null for anything else (edits, stickers, joins, reactions).
 * `replyTo` is the text of the message it replies to, when that was one of the bot's answers:
 * the stateless way to ask a follow-up.
 */
export function readUpdate(update) {
  const message = update && (update.message || update.channel_post);
  if (!message || typeof message.text !== 'string' || !message.text.trim() || !message.chat) return null;
  const replied = message.reply_to_message;
  return {
    chat: message.chat,
    messageId: message.message_id,
    text: message.text.trim(),
    replyTo: replied && replied.from && replied.from.is_bot && typeof replied.text === 'string' ? replied.text : null,
  };
}

async function call(env, method, payload, fetchImpl) {
  const response = await fetchImpl(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, ok: Boolean(body && body.ok), description: body && body.description ? String(body.description) : '', retryAfter: body?.parameters?.retry_after ?? null };
}

async function send(env, chatId, text, markdown, fetchImpl, sleep, replyTo) {
  const payload = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
  if (markdown) payload.parse_mode = 'MarkdownV2';
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  let result = await call(env, 'sendMessage', payload, fetchImpl);
  if (result.status === 429 && result.retryAfter !== null) {
    await sleep(Math.min(MAX_RETRY_WAIT_S, Number(result.retryAfter) || 1) * 1000);
    result = await call(env, 'sendMessage', payload, fetchImpl);
  }
  return result;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a message built of lines (see format.js), split into as many messages as needed.
 * @returns {Promise<'sent'|'sent-plain'|'failed'>}
 */
export async function sendLines(env, chatId, lines, { fetchImpl = fetch, sleep = defaultSleep, replyTo = null, markdown = true } = {}) {
  const groups = groupLines(lines);
  const render = (group, asMarkdown) => group.map((line) => renderLine(line, asMarkdown)).join('\n');
  for (const [index, group] of groups.entries()) {
    const reply = index === 0 ? replyTo : null;
    const result = await send(env, chatId, render(group, markdown), markdown, fetchImpl, sleep, reply);
    if (result.ok) continue;
    if (markdown && result.status === 400 && /parse entities|can't find end/i.test(result.description)) {
      // Formatting rejected: this message and the rest go out as plain text.
      for (const [offset, rest] of groups.slice(index).entries()) {
        const plain = await send(env, chatId, render(rest, false), false, fetchImpl, sleep, offset === 0 ? reply : null);
        if (!plain.ok) return 'failed';
      }
      return 'sent-plain';
    }
    return 'failed';
  }
  return markdown ? 'sent' : 'sent-plain';
}

/** Plain text (used for model answers, which must never fail on formatting). */
export function sendPlain(env, chatId, text, options = {}) {
  return sendLines(env, chatId, String(text).split('\n'), { ...options, markdown: false });
}

/** "typing…" while a slower answer is prepared. Best effort: a failure is ignored. */
export async function sendTyping(env, chatId, { fetchImpl = fetch } = {}) {
  try {
    await call(env, 'sendChatAction', { chat_id: chatId, action: 'typing' }, fetchImpl);
  } catch {
    // ignored: the answer itself still goes out
  }
}

export { renderLine };
