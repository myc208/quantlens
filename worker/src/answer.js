/**
 * answer.js: plain-English questions.
 *
 * Checkpoint 1 answers with the commands only. Checkpoint 2 sends the question, with a facts
 * digest of bot_context.json, to Gemini under strict rules, and keeps this reply as the
 * fallback when no GEMINI_API_KEY is set.
 */

import { sendLines } from './telegram.js';

export function noModelLines() {
  return [
    'Plain-English questions are switched off: no Gemini API key is set for this bot.',
    'The commands answer straight from the QuantLens snapshot:',
    '/check D05 · /regime · /triggers · /rotation · /upcoming · /help',
  ];
}

export async function answerQuestion(message, env, deps = {}) {
  return sendLines(env, message.chat.id, noModelLines(), { fetchImpl: deps.fetchImpl, sleep: deps.sleep, markdown: false, replyTo: message.messageId });
}
