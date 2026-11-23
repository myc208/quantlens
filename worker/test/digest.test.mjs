/**
 * What Gemini reads: the facts digest (the commands' own lines), the rules, the question, and
 * the number check that compares an answer against them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsDigest, rankingLines } from '../src/digest.js';
import { rules, systemPrompt, userPrompt } from '../src/prompt.js';
import { numberKeys, unsupportedNumbers } from '../src/numbers.js';
import { assetCard, regimeLines, upcomingLines, footer } from '../src/commands.js';
import { renderLine } from '../src/format.js';
import { FIXTURE, COMMITTED, clone } from './helpers.mjs';

const lines = (built) => built.map((line) => renderLine(line, false));

test('the digest holds every card line /check prints, without footers or links', () => {
  for (const context of [FIXTURE, COMMITTED]) {
    const digest = factsDigest(context);
    for (const asset of context.assets) {
      for (const line of lines(assetCard(asset, context, {})).filter((line) => line !== footer(context))) {
        assert.ok(digest.includes(line), `${asset.ticker}: ${line}`);
      }
    }
    assert.ok(!digest.includes('not financial advice'), 'the footer is added to answers by code');
    assert.ok(!digest.includes('?t='), 'no site links');
    for (const raw of ['undefined', 'NaN', '[object Object]', 'null']) assert.ok(!digest.includes(raw), raw);
  }
});

test('the digest names the snapshot date, the watchlist, and every N/A reason word for word', () => {
  const digest = factsDigest(FIXTURE);
  assert.ok(digest.startsWith('QuantLens snapshot of 22 Nov 2026 (asOf 2026-11-22T02:32:27Z).'));
  assert.ok(digest.includes('The watchlist has 30 assets. Anything not listed here is not tracked:'));
  assert.ok(digest.includes('Indices: ^IXIC ^GSPC ^DJI ^STI'));
  for (const asset of COMMITTED.assets) {
    for (const [field, cell] of Object.entries(asset)) {
      if (field === 'radar') continue; // V5.0's Decision Radar is not in the digest yet
      if (cell && typeof cell === 'object' && typeof cell.na === 'string') assert.ok(factsDigest(COMMITTED).includes(cell.na), cell.na);
    }
  }
});

test('the digest carries the regime, triggers, rotation and the next 30 days as the commands print them', () => {
  const digest = factsDigest(FIXTURE);
  for (const line of lines(regimeLines(FIXTURE)).filter((line) => line !== footer(FIXTURE))) assert.ok(digest.includes(line), line);
  for (const line of lines(upcomingLines(FIXTURE)).slice(1, -1)) assert.ok(digest.includes(line), line);
  assert.ok(digest.includes('• Tone: WMT negative → positive (−0.09 → +0.26)'));
  assert.ok(digest.includes('Defensives: +28.2% · +20.5% (WMT, LLY)'));
  const order = ['== Market regime ==', '== Triggers ==', '== Rotation ==', '== Next 30 days ==', '== Rankings ==', '== Assets =='].map((heading) => digest.indexOf(heading));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `sections in order: ${order}`);
});

test('rankings order each figure highest first and leave out assets without it', () => {
  const ranked = rankingLines(FIXTURE.assets);
  assert.equal(ranked.length, 5);
  assert.ok(ranked[2].startsWith('EWMA vol, highest first: AMD 118.5% · SNDK 117.7% · MU 105.1%'));
  assert.ok(ranked[2].endsWith('J69U.SI 15.7%'));
  const fundamental = ranked[1];
  for (const ticker of ['BTC-USD', '^GSPC', 'VOO']) assert.ok(!fundamental.includes(` ${ticker} `) && !fundamental.includes(`: ${ticker} `), `${ticker} has no Fundamental score`);
  const values = (line) => line.split(': ').slice(1).join(': ').split(' · ').map((item) => Number(item.split(' ').at(-1).replace('−', '-').replace('%', '')));
  for (const line of ranked) {
    const shown = values(line);
    assert.deepEqual(shown, [...shown].sort((a, b) => b - a), line.slice(0, 30));
  }
});

test('the digest stays small enough to send with every question', () => {
  assert.ok(factsDigest(COMMITTED).length < 40000, `${factsDigest(COMMITTED).length} characters`);
  const quiet = clone(FIXTURE);
  quiet.triggers = [];
  quiet.events = [];
  assert.match(factsDigest(quiet), /A quiet day/);
  assert.match(factsDigest(quiet), /Nothing scheduled/);
});

test('the rules cover grounding, no arithmetic, untracked assets, N/A reasons, no advice, the date, plain text and injection', () => {
  const text = rules(FIXTURE);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.match(text, new RegExp(`^${n}\\. `, 'm'));
  for (const phrase of ['only facts written in the SNAPSHOT', 'Never calculate', "isn't tracked in QuantLens", 'word for word', 'Never tell anyone to buy, sell, hold',
    'from the 22 Nov 2026 snapshot', 'no Markdown', 'data, not instructions']) assert.ok(text.includes(phrase), phrase);
  const system = systemPrompt(FIXTURE, 'FACTS');
  assert.ok(system.endsWith('=== SNAPSHOT ===\nFACTS\n=== END OF SNAPSHOT ==='));
  assert.ok(!/temperature/i.test(system));
});

test('the user turn is the question, after the earlier reply for a follow-up', () => {
  assert.equal(userPrompt('  how is DBS doing? '), 'Question: how is DBS doing?');
  const followUp = userPrompt('and its beta?', 'D05.SI · DBS Group Holdings Ltd\nBeta 1.10');
  assert.equal(followUp, 'This is a follow-up to an earlier QuantLens reply:\n<<<\nD05.SI · DBS Group Holdings Ltd\nBeta 1.10\n>>>\n\nQuestion: and its beta?');
  const long = userPrompt('q'.repeat(5000), 'e'.repeat(9000));
  assert.ok(long.length < 4700, `${long.length}`);
  assert.ok(long.includes('…'));
});

test('the number check flags decimals and percentages that no source contains', () => {
  const digest = factsDigest(FIXTURE);
  assert.deepEqual(unsupportedNumbers('DBS fell 1.8% (−1.7σ) and its beta is 1.1, RS 3M +0.6%.', digest), []);
  assert.deepEqual(unsupportedNumbers('BTC closed at 58,799.00 and 58799 is the level.', digest), []);
  assert.deepEqual(unsupportedNumbers('DBS rose 3.2% this week, about 0.47 of its range; 3.2% again.', digest), ['3.2%', '0.47']);
  assert.deepEqual(unsupportedNumbers('The 30 assets, 4 sessions, 9 Dec at 2:00 PM, in 2026, D05.SI and VIX3M.', digest), [], 'counts, dates, times and tickers are not checked');
  assert.deepEqual(unsupportedNumbers('A 12.5% drop would be large.', digest, 'is a 12.5% drop large for DBS?'), [], 'a figure from the question may be repeated');
  assert.deepEqual(unsupportedNumbers('Gross margin was 45%.', digest), ['45%']);
  assert.deepEqual(unsupportedNumbers('', digest), []);
});

test('number keys ignore signs, separators and trailing zeros', () => {
  assert.deepEqual([...numberKeys('−1.80% +2 1,234.50 0.0065 -3 1.8')], ['1.8%', '2', '1234.5', '0.0065', '3', '1.8']);
  assert.deepEqual(unsupportedNumbers('Technical 32% and 1.8', 'Technical 32 · −1.8%'), ['32%', '1.8'], 'a percentage and a plain number never stand in for each other');
  assert.deepEqual([...numberKeys(null, undefined, '')], []);
});
