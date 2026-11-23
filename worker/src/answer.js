/**
 * answer.js: plain-English questions, answered by Gemini from the facts digest alone.
 *
 * The question (with the bot's earlier reply when it is a follow-up) goes to Gemini under the
 * rules in prompt.js. The answer is sent as plain text, as a reply to the question, with the
 * number check's warning when a figure is not in the snapshot and the snapshot footer always
 * last. Without a key, or when Gemini cannot answer, the reply says so and points to the
 * commands, which never need the model.
 */

import { sendLines } from './telegram.js';
import { loadContext } from './context.js';
import { footer, staleLine, unavailable } from './commands.js';
import { factsDigest } from './digest.js';
import { systemPrompt, userPrompt } from './prompt.js';
import { generate, modelName } from './gemini.js';
import { unsupportedNumbers } from './numbers.js';

const COMMAND_LINE = '/check D05 · /radar · /regime · /triggers · /rotation · /upcoming · /help';

export function noModelLines() {
  return [
    'Plain-English questions are switched off: no Gemini API key is set for this bot.',
    'The commands answer straight from the QuantLens snapshot:',
    COMMAND_LINE,
  ];
}

/** Why the model gave no answer, in words, and the commands that still work. */
export function fallbackLines(reason, env) {
  const why = {
    'rate-limited': 'The free Gemini quota is used up for the moment (a per-minute or daily limit), so plain-English questions are paused.',
    timeout: 'Gemini took too long to answer.',
    unavailable: 'Gemini is unavailable right now.',
    blocked: 'Gemini declined to answer that question.',
    empty: 'Gemini returned no answer.',
    'bad-model': `Gemini does not know the model "${modelName(env)}": check GEMINI_MODEL.`,
    'bad-request': `Gemini refused the request for "${modelName(env)}": check GEMINI_MODEL.`,
    'key-rejected': 'Gemini refused the API key: check GEMINI_API_KEY.',
  }[reason] ?? 'Gemini could not answer.';
  return [why, 'The commands still answer straight from the snapshot:', COMMAND_LINE];
}

/** Plain text, whatever the model wrote: no Markdown markers, bullets as "•". */
export function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[\s(])\*(\S[^*\n]*?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[*-][ \t]+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Answer one question. Never throws past sendLines.
 * @returns {Promise<{ outcome:string, answer:string, flagged:number }>}
 */
export async function answerQuestion(message, env, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const send = (lines) => sendLines(env, message.chat.id, lines, { fetchImpl, sleep: deps.sleep, markdown: false, replyTo: message.messageId });
  if (!String(env.GEMINI_API_KEY ?? '').trim()) return { outcome: await send(noModelLines()), answer: 'no-key', flagged: 0 };

  const loaded = await loadContext(env, { fetchImpl, now: deps.now });
  if (!loaded.ok) return { outcome: await send([...unavailable(loaded), '', COMMAND_LINE]), answer: 'no-data', flagged: 0 };

  const { context } = loaded;
  const digest = factsDigest(context);
  const prompt = { system: systemPrompt(context, digest), user: userPrompt(message.text, message.replyTo) };
  const result = await generate(env, prompt, { fetchImpl, sleep: deps.sleep });
  if (!result.ok) return { outcome: await send([...staleLine(loaded), ...fallbackLines(result.reason, env)]), answer: result.reason, flagged: 0 };

  const text = tidy(result.text);
  const flagged = unsupportedNumbers(text, digest, message.text, message.replyTo ?? '');
  const lines = [...staleLine(loaded), ...text.split('\n')];
  if (result.truncated) lines.push('… (the answer was cut short)');
  if (flagged.length) lines.push('', `⚠ Not in the snapshot, so check before relying on them: ${flagged.join(', ')}`);
  lines.push('', footer(context));
  return { outcome: await send(lines), answer: 'gemini', flagged: flagged.length };
}
