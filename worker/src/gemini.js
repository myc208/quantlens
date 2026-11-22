/**
 * gemini.js: one generateContent call to the Gemini API (REST, no SDK).
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent
 *
 * The key travels in the x-goog-api-key header, never in the URL, and is never logged. No
 * temperature, topP or topK is sent: current Flash and Flash-Lite models are tuned for their
 * defaults. Thinking is set to MINIMAL; a model that rejects thinkingConfig is asked again
 * without it. A 5xx is retried once; a 429 is not (the free quota will not refill in time).
 *
 * Never throws: the result is { ok: true, text, truncated } or { ok: false, reason }.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const TIMEOUT_MS = 15000; // the reply must go out within the 30 seconds waitUntil allows
const MAX_OUTPUT_TOKENS = 1024;
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GEMINI_MODEL, if it is a plain model id ("models/" prefix allowed); the default otherwise. */
export function modelName(env) {
  const model = String(env.GEMINI_MODEL ?? '').trim().replace(/^models\//, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) ? model : DEFAULT_MODEL;
}

export function requestBody({ system, user }, { thinking = true } = {}) {
  const generationConfig = { maxOutputTokens: MAX_OUTPUT_TOKENS };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  };
}

/** The answer text of a 200 response (thought parts left out), or why there is none. */
export function readAnswer(body) {
  if (body?.promptFeedback?.blockReason) return { ok: false, reason: 'blocked' };
  const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null;
  if (!candidate) return { ok: false, reason: 'empty' };
  if (BLOCKED.has(candidate.finishReason)) return { ok: false, reason: 'blocked' };
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('').trim();
  if (!text) return { ok: false, reason: 'empty' };
  return { ok: true, text, truncated: candidate.finishReason === 'MAX_TOKENS' };
}

async function post(url, key, body, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, failure: error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable' };
  }
}

const errorText = (json) => String(json?.error?.message ?? '');

/**
 * Ask Gemini.
 * @param {object} env GEMINI_API_KEY, GEMINI_MODEL
 * @param {{ system:string, user:string }} prompt
 * @returns {Promise<{ ok:true, text:string, truncated:boolean } | { ok:false, reason:string }>}
 */
export async function generate(env, prompt, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const key = String(env.GEMINI_API_KEY ?? '').trim();
  if (!key) return { ok: false, reason: 'no-key' };
  const url = `${API}/${modelName(env)}:generateContent`;
  let thinking = true;
  let retried = false;
  for (;;) {
    const result = await post(url, key, requestBody(prompt, { thinking }), fetchImpl);
    const { status } = result;
    if (status === 200) return readAnswer(result.json);
    if (status === 0) return { ok: false, reason: result.failure };
    if (status === 429) return { ok: false, reason: 'rate-limited' };
    if (status === 400 && /api key/i.test(errorText(result.json))) return { ok: false, reason: 'key-rejected' };
    if (status === 400 && thinking && /thinking/i.test(errorText(result.json))) {
      thinking = false; // this model takes no thinking settings
      continue;
    }
    if (status === 400) return { ok: false, reason: 'bad-request' };
    if (status === 401 || status === 403) return { ok: false, reason: 'key-rejected' };
    if (status === 404) return { ok: false, reason: 'bad-model' };
    if (status >= 500 && !retried) {
      retried = true;
      await sleep(1000);
      continue;
    }
    return { ok: false, reason: 'unavailable' };
  }
}
