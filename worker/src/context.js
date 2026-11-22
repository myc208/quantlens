/**
 * context.js: fetch the snapshot summary (data/bot_context.json on GitHub Pages).
 *
 * The daily pipeline publishes it; the Worker only reads it. Cloudflare caches it at the edge
 * for CONTEXT_CACHE_SECONDS (5 minutes by default), so a burst of messages costs one request to
 * GitHub Pages. Nothing is stored by the Worker itself.
 *
 * Never throws: a failure comes back as { ok: false, problem } in words the reply can use.
 */

export const CONTEXT_SCHEMA = 'quantlens.bot_context/1';
export const STALE_HOURS = 48;
const TIMEOUT_MS = 10000;

/** What is wrong with a parsed summary, or null when it is usable. */
export function contextProblem(context) {
  if (!context || typeof context !== 'object') return 'the summary is not an object';
  if (context.schema !== CONTEXT_SCHEMA) return `the summary has schema ${JSON.stringify(context.schema)}, not ${CONTEXT_SCHEMA}`;
  if (typeof context.asOf !== 'string' || Number.isNaN(Date.parse(context.asOf))) return 'the summary has no valid asOf date';
  if (!Array.isArray(context.assets) || !context.assets.length || !context.assets.every((asset) => asset && typeof asset.ticker === 'string')) {
    return 'the summary lists no assets';
  }
  for (const key of ['events', 'triggers']) if (!Array.isArray(context[key])) return `the summary has no ${key} list`;
  if (!context.rotation || !Array.isArray(context.rotation.groups)) return 'the summary has no rotation groups';
  return null;
}

/**
 * @param {object} env the Worker's environment (CONTEXT_URL, CONTEXT_CACHE_SECONDS)
 * @param {{ fetchImpl?: Function, now?: () => Date }} [deps]
 * @returns {Promise<{ ok:true, context:object, ageHours:number, stale:boolean } | { ok:false, problem:string }>}
 */
export async function loadContext(env, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const url = env.CONTEXT_URL;
  if (!url) return { ok: false, problem: 'CONTEXT_URL is not set' };
  const ttl = Number(env.CONTEXT_CACHE_SECONDS) > 0 ? Number(env.CONTEXT_CACHE_SECONDS) : 300;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: ttl, cacheEverything: true },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, problem: `GitHub Pages did not answer (${error && error.name === 'TimeoutError' ? 'timed out' : 'network error'})` };
  }
  if (!response.ok) return { ok: false, problem: `GitHub Pages returned HTTP ${response.status}` };
  let context;
  try {
    context = await response.json();
  } catch {
    return { ok: false, problem: 'the snapshot summary is not valid JSON' };
  }
  const problem = contextProblem(context);
  if (problem) return { ok: false, problem };
  const ageHours = (now().getTime() - Date.parse(context.asOf)) / 3_600_000;
  return { ok: true, context, ageHours, stale: ageHours > STALE_HOURS };
}
