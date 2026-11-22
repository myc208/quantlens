/** Fetching data/bot_context.json: edge caching, and every failure as words, never a throw. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContext, contextProblem, CONTEXT_SCHEMA, STALE_HOURS } from '../src/context.js';
import { FIXTURE, COMMITTED, ENV, clone, fakeFetch, hoursAfter, json } from './helpers.mjs';

const load = (fetchImpl, env = ENV, hours = 5) => loadContext(env, { fetchImpl, now: () => hoursAfter(FIXTURE.asOf, hours) });

test('the summary is fetched once, cached at the edge for CONTEXT_CACHE_SECONDS', async () => {
  const fetchImpl = fakeFetch();
  const loaded = await load(fetchImpl);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.stale, false);
  assert.ok(Math.abs(loaded.ageHours - 5) < 1e-9);
  assert.equal(loaded.context.schema, CONTEXT_SCHEMA);
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, ENV.CONTEXT_URL);
  assert.deepEqual(init.cf, { cacheTtl: 300, cacheEverything: true });
  assert.ok(init.signal instanceof AbortSignal);
});

test('the cache time comes from the environment, with 300 seconds as the fallback', async () => {
  for (const [value, ttl] of [['60', 60], ['900', 900], ['', 300], ['-5', 300], ['soon', 300], [undefined, 300]]) {
    const fetchImpl = fakeFetch();
    await load(fetchImpl, { ...ENV, CONTEXT_CACHE_SECONDS: value });
    assert.equal(fetchImpl.calls[0].init.cf.cacheTtl, ttl, `CONTEXT_CACHE_SECONDS=${value}`);
  }
});

test(`a snapshot older than ${STALE_HOURS} hours is marked stale`, async () => {
  assert.equal((await load(fakeFetch(), ENV, STALE_HOURS - 1)).stale, false);
  const old = await load(fakeFetch(), ENV, STALE_HOURS + 1);
  assert.equal(old.ok, true);
  assert.equal(old.stale, true);
});

test('failures come back as a problem in words', async () => {
  const cases = [
    [fakeFetch({ context: () => json({}, 503) }), 'GitHub Pages returned HTTP 503'],
    [fakeFetch({ context: () => json({}, 404) }), 'GitHub Pages returned HTTP 404'],
    [fakeFetch({ context: () => new Response('<html>', { status: 200 }) }), 'the snapshot summary is not valid JSON'],
    [fakeFetch({ context: { ...FIXTURE, schema: 'quantlens.bot_context/2' } }), `the summary has schema "quantlens.bot_context/2", not ${CONTEXT_SCHEMA}`],
    [fakeFetch({ context: { ...FIXTURE, asOf: 'yesterday' } }), 'the summary has no valid asOf date'],
    [fakeFetch({ context: { ...FIXTURE, assets: [] } }), 'the summary lists no assets'],
    [fakeFetch({ context: { ...FIXTURE, events: null } }), 'the summary has no events list'],
    [fakeFetch({ context: { ...FIXTURE, rotation: {} } }), 'the summary has no rotation groups'],
    [async () => { throw new TypeError('fetch failed'); }, 'GitHub Pages did not answer (network error)'],
    [async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }, 'GitHub Pages did not answer (timed out)'],
  ];
  for (const [fetchImpl, problem] of cases) assert.deepEqual(await load(fetchImpl), { ok: false, problem });
  assert.deepEqual(await load(fakeFetch(), { ...ENV, CONTEXT_URL: '' }), { ok: false, problem: 'CONTEXT_URL is not set' });
});

test('the fixture and the committed file are both usable summaries', () => {
  assert.equal(contextProblem(FIXTURE), null);
  assert.equal(contextProblem(COMMITTED), null);
  assert.equal(contextProblem(null), 'the summary is not an object');
  const broken = clone(FIXTURE);
  broken.assets.push({ name: 'no ticker' });
  assert.equal(contextProblem(broken), 'the summary lists no assets');
});
