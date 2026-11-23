/**
 * V4.1 (QuantLens V5.0): the Decision Radar in the bot. /radar, the radar lines of /check and
 * /regime, the digest Gemini reads, the rules about stops and the weakest tier, and the
 * questions the radar was built for, end to end with Telegram, GitHub Pages and Gemini faked.
 * A summary published before V5.0 (FIXTURE) must still be read, and must say the radar is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, runCommand, assetCard, COMMANDS } from '../src/commands.js';
import { radarLines, radarCard, stressLines, stopLines, hasRadar, NOT_YET, HORIZONS } from '../src/radar.js';
import { factsDigest } from '../src/digest.js';
import { rules } from '../src/prompt.js';
import { unsupportedNumbers } from '../src/numbers.js';
import { renderLine, tickPrice } from '../src/format.js';
import { answerQuestion } from '../src/answer.js';
import { handle } from '../src/index.js';
import {
  FIXTURE, FIXTURE_V5, ENV, GEMINI_ENV, GEMINI_KEY, CHAT, TOKEN, clone, fakeFetch, fakeCtx, fakeSleep, geminiReply, hoursAfter,
  webhook, textUpdate, captureConsole,
} from './helpers.mjs';

const plain = (lines) => lines.map((line) => renderLine(line, false));
const loaded = (context) => ({ ok: true, context, ageHours: 5, stale: false });
const reply = (text, context = FIXTURE_V5) => plain(runCommand(parseCommand(text), loaded(context), ENV));
const assetOf = (context, ticker) => context.assets.find((asset) => asset.ticker === ticker);
const FOOTER = 'Snapshot 23 Nov 2026 · not financial advice';

/** A full three-pillar regime: credit and rates read from FRED, two pillars flagged. */
function stressed() {
  const context = clone(FIXTURE_V5);
  context.stress = {
    ...context.stress,
    state: 'Stressed', multiplier: 1.35, flags: 2, active: 3, status: 'fresh', note: null,
    pillars: {
      volatility: { ...context.stress.pillars.volatility },
      credit: { status: 'fresh', flag: true, value: 0.0468, change: 0.0061, from: '2026-10-22', twoYearChange: null, asOf: '2026-11-20', series: 'BAMLH0A0HYM2' },
      rates: { status: 'stale', flag: false, value: 0.0052, change: 0.0012, from: '2026-10-22', twoYearChange: -0.0008, asOf: '2026-11-19', series: 'T10Y2Y' },
    },
  };
  return context;
}

test('tick prices keep exactly the decimals of the tick, with thousands separated', () => {
  assert.equal(tickPrice(58.04, 0.01), '58.04');
  assert.equal(tickPrice(76.2, 0.01), '76.20');
  assert.equal(tickPrice(0.975, 0.005), '0.975');
  assert.equal(tickPrice(0.0712, 0.0001), '0.0712');
  assert.equal(tickPrice(51716.14, 0.01), '51,716.14');
  assert.equal(tickPrice(1234567.5, 0.5), '1,234,567.5');
  assert.equal(tickPrice(12, 1), '12');
  assert.equal(tickPrice(-3.5, 0.01), '−3.50');
  assert.equal(tickPrice(null, 0.01), 'N/A');
  assert.equal(tickPrice(5.85, null), '5.85', 'no tick: a cent');
});

test('/radar is a command, listed in /help', () => {
  assert.ok(COMMANDS.includes('radar'));
  assert.ok(reply('/help').some((line) => line.startsWith('/radar · ')));
  assert.deepEqual(parseCommand('/radar@QuantLensBot'), { name: 'radar', args: '' });
});

test('/radar: the regime, every tier with its count, and the dividend traps with their reasons', () => {
  const lines = reply('/radar');
  assert.equal(lines[0], 'Decision Radar');
  assert.equal(lines[1], 'Macro regime: Cautious ×1.15 🟡');
  assert.ok(lines.includes('• Volatility: flagged. VIX ÷ VIX3M 1.16 (flag at 1.00 or above)'));
  assert.ok(lines.includes(`• Credit: not read. ${FIXTURE_V5.stress.pillars.credit.note}`));
  assert.ok(lines.includes('With fewer than three pillars read, the count can only understate stress.'));
  assert.ok(lines.includes('Healthy · score 3-4 (6)'));
  assert.ok(lines.includes('BRK-B 4/4 · C6L.SI 4/4 · LLY 4/4 · AJBU.SI 3/4 · J69U.SI 3/4 · WMT 3/4'));
  assert.ok(lines.includes('Neutral · score 2, or 0-1 not yet on three sessions (5)'));
  assert.ok(lines.includes('BLK 2/4 · CSPX.L 2/4 · D05.SI 2/4 · A17U.SI 1/4 (held) · TSLA 1/4 (held)'));
  assert.ok(lines.includes('Weakest · Dead Money · 0-1 of 4 on three sessions running (15)'));
  assert.ok(lines.includes('Dividend traps (5)'));
  assert.ok(lines.includes('D05.SI: yield 4.9%, 15.0% below its 52-week high'));
  assert.ok(lines.includes('A17U.SI: yield 7.1%, 22.6% below its 52-week high, 1-year total return −20.1%'));
  assert.equal(lines.at(-1), FOOTER);
  // Every tradable asset is in exactly one tier; indices are left out.
  const listed = lines.filter((line) => / \d\/4/.test(line)).flatMap((line) => line.split(' · ').map((item) => item.split(' ')[0]));
  const tradable = FIXTURE_V5.assets.filter((asset) => asset.radar.tier).map((asset) => asset.ticker);
  assert.deepEqual([...listed].sort(), [...tradable].sort());
  assert.ok(!listed.some((ticker) => ticker.startsWith('^')));
});

test('/radar labels the weakest factually: no cut, sell or buy instruction', () => {
  const text = reply('/radar').join('\n');
  assert.ok(!/cut candidate/i.test(text));
  assert.ok(!/\b(cut|sell|buy|exit|trim)\b(?! or sell)/i.test(text.replace('a recommendation to buy or sell', '')), 'no instruction words outside the disclaimer');
  assert.match(text, /not a forecast or a recommendation to buy or sell/);
});

test('/radar on a summary from before V5.0 says the radar is not there yet', () => {
  assert.equal(hasRadar(FIXTURE), false);
  assert.equal(hasRadar(FIXTURE_V5), true);
  assert.deepEqual(reply('/radar', FIXTURE), ['Decision Radar', NOT_YET, 'Snapshot 22 Nov 2026 · not financial advice']);
  assert.deepEqual(plain(stressLines(FIXTURE)), [NOT_YET]);
});

test('the three pillars when FRED was read: values, changes, the 2-year, an older reading and the state', () => {
  const lines = plain(stressLines(stressed()));
  assert.equal(lines[0], 'Macro regime: Stressed ×1.35 🔴');
  assert.equal(lines[1], '2 flags out of 3 pillars read (volatility, credit), so every Decision Radar stop is widened ×1.35. The scale: 0 flags Calm ×1.00, 1 Cautious ×1.15, 2-3 Stressed ×1.35.');
  assert.equal(lines[3], '• Credit: flagged. US high-yield spread 4.68%, +0.61 points in 20 sessions (flag at 4.50%, or 0.50 points wider)');
  assert.equal(lines[4], '• Rates: clear. 10Y − 2Y spread +0.52%, +0.12 points in 20 sessions, 2-year yield −0.08 points (flag below 0, or 0.35 points steeper while the 2-year fell) (an older reading, 19 Nov 2026)');
  assert.equal(lines.length, 5, 'all three pillars read: no fallback note');
  const none = clone(FIXTURE_V5);
  none.stress = { ...none.stress, state: null, flags: 0, active: 0, status: 'unavailable' };
  assert.deepEqual(plain(stressLines(none)), ['Macro regime: not read', 'None of the three pillars could be read, so the stops carry no regime multiplier (×1.00).']);
});

test('/check D05 adds the tier, score, trap and the medium stop at tick prices', () => {
  const lines = reply('/check D05');
  assert.ok(lines.includes('Decision Radar: Neutral, score 2/4 · trend ✗ strength ✓ momentum ✓ drawdown ✗ · strength vs ^STI, a price index'));
  assert.ok(lines.includes('⚠ Dividend trap: yield 4.9%, 15.0% below its 52-week high'));
  assert.ok(lines.includes('Medium stop, 3 to 6 months · regime Cautious ×1.15: initial −12.2% at SGD 58.04 · breakeven trigger +15.3% at 76.20, then raise the stop to the entry · trail −14.0% below the highest close (56.83 today)'));
  assert.equal(lines.at(-2), FOOTER);
  const before = plain(assetCard(assetOf(FIXTURE, 'D05.SI'), FIXTURE, ENV));
  assert.ok(!before.some((line) => line.startsWith('Decision Radar') || line.includes('stop')), 'a summary from before V5.0 prints the V4.0 card');
});

test('/check: a held tier, a self-benchmark, a yield with no trap, an ex-dividend warning and an index', () => {
  const tsla = reply('/check TSLA');
  assert.ok(tsla.some((line) => line.startsWith('Decision Radar: Neutral (held: not yet three weak sessions), score 1/4')));
  const voo = reply('/check VOO');
  assert.ok(voo.some((line) => line.startsWith('Decision Radar: Dead Money, score 1/4') && line.endsWith('· strength: its own 3-month return')));
  const sia = reply('/check SIA');
  assert.ok(sia.includes('Dividend yield 5.3%: no dividend trap'));
  assert.ok(sia.includes('⚠ Ex-dividend 25 Nov 2026, in 2 trading days: the price drops about 4.1% (SGD 0.29) at the open, mechanically, toward the stop'));
  const spx = reply('/check spx');
  assert.ok(spx.includes(`Decision Radar: N/A. ${assetOf(FIXTURE_V5, '^GSPC').radar.na}`));
  assert.ok(!spx.some((line) => line.startsWith('Medium stop')));
});

test('the earnings-gap warning names the horizons whose stop the typical move exceeds', () => {
  const asset = clone(assetOf(FIXTURE_V5, 'AMD'));
  asset.radar.warnings = [{ kind: 'earnings-gap', date: '2026-12-02', tradingDays: 7, typicalMove: 0.0912, worstMove: -0.172, horizons: [{ horizon: 'short', stop: -0.08 }, { horizon: 'medium', stop: -0.09 }] }];
  const { lines } = radarCard(asset, FIXTURE_V5);
  assert.equal(lines.at(-1), '⚠ Earnings ~2 Dec 2026, in 7 trading days: the typical earnings-day move ±9.1%, worst −17.2% is larger than the short and medium stops; a gap can open beyond it');
  asset.radar.warnings[0].horizons = [{ horizon: 'short', stop: -0.08 }];
  assert.match(radarCard(asset, FIXTURE_V5).lines.at(-1), /larger than the short stop; a gap/);
});

test('a stop the engine could not size is an N/A with its reason', () => {
  const asset = clone(assetOf(FIXTURE_V5, 'D05.SI'));
  asset.radar.stops.medium = { na: 'At least 20 daily returns are needed for the EWMA volatility.' };
  const { lines, gaps } = radarCard(asset, FIXTURE_V5);
  assert.ok(!lines.some((line) => line.startsWith('Medium stop')));
  assert.deepEqual(gaps, [['Medium stop', 'At least 20 daily returns are needed for the EWMA volatility.']]);
  const card = plain(assetCard(asset, FIXTURE_V5, ENV));
  assert.ok(card.includes('Medium stop: N/A. At least 20 daily returns are needed for the EWMA volatility.'));
});

test('/regime points to the three-pillar regime when the summary has it, and keeps its V4.0 text otherwise', () => {
  const lines = reply('/regime');
  assert.ok(lines.includes('Macro regime (three pillars): Cautious ×1.15, 1 of 1 flagged · /radar for the pillars'));
  assert.ok(lines.includes("Context: the regime changes no score, trend regime or position size; its multiplier widens the Decision Radar's stops."));
  assert.ok(reply('/regime', FIXTURE).includes('Context only: the regime changes no score, trend regime or position size.'));
});

test('the digest carries the radar, the regime, and all three stops of every tradable asset', () => {
  const digest = factsDigest(FIXTURE_V5);
  const order = ['== Market regime ==', '== Decision Radar ==', '== Stops by horizon ==', '== Triggers ==', '== Assets =='].map((heading) => digest.indexOf(heading));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), `sections in order: ${order}`);
  for (const line of plain(radarLines(FIXTURE_V5)).slice(1).filter(Boolean)) assert.ok(digest.includes(line), line);
  assert.ok(digest.includes('D05.SI, prices in SGD: short: initial −6.0% at 62.17 · breakeven +7.4% at 71.04 · trail −6.0% (62.17 today) | medium: initial −12.2% at 58.04 · breakeven +15.3% at 76.20 · trail −14.0% (56.83 today) | long: initial −15.3% at 56.02 · breakeven +22.9% at 81.24 · trail −19.1% (53.50 today)'));
  const stops = stopLines(FIXTURE_V5);
  assert.equal(stops.length, FIXTURE_V5.assets.filter((asset) => asset.radar.tier).length, 'one line per tradable asset');
  assert.ok(digest.includes('Stops by horizon: short = 2 weeks to 1 month, medium = 3 to 6 months, long = 1 year or more.'));
  assert.ok(digest.includes('Weakest · Dead Money = 0-1 on three sessions running'));
  assert.ok(digest.length < 48000, `${digest.length} characters`);
  const before = factsDigest(FIXTURE);
  for (const heading of ['== Decision Radar ==', '== Stops by horizon ==', 'Stops by horizon:']) assert.ok(!before.includes(heading), heading);
  for (const raw of ['undefined', 'NaN', '[object Object]', 'null']) assert.ok(!digest.includes(raw), raw);
});

test('the rules tell Gemini how to answer a stop-loss question and how to name the weakest', () => {
  const text = rules(FIXTURE_V5);
  for (const n of [9, 10]) assert.match(text, new RegExp(`^${n}\\. `, 'm'));
  for (const phrase of ['/radar', 'short: 2 weeks to 1 month; medium: 3 to 6 months; long: 1 year or more', 'exactly as "Stops by horizon" writes them',
    'volatility-sized risk boundaries', 'never present the weakest as a list to sell', 'Quoting the Decision Radar\'s stops under rule 9 is allowed']) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.deepEqual(Object.keys(HORIZONS), ['short', 'medium', 'long']);
});

test('answers quoting the radar pass the number check; an invented stop does not', () => {
  const digest = factsDigest(FIXTURE_V5);
  const sixMonths = 'For a 3 to 6 month hold of D05.SI the medium stop is an initial −12.2% at SGD 58.04, a breakeven trigger of +15.3% at 76.20, then a trail of −14.0% (56.83 today). It is a dividend trap: yield 4.9%, 15.0% below its 52-week high.';
  assert.deepEqual(unsupportedNumbers(sixMonths, digest), []);
  const year = 'Held for a year, BTC-USD has a long stop of −25.0% at 45,070.56, breakeven +37.5% at 82,629.38.';
  assert.deepEqual(unsupportedNumbers(year, digest), []);
  const deadMoney = 'Weakest · Dead Money (15): AVAX-USD 1/4 · VOO 1/4 · XOM 1/4 · AMD 0/4 · BHP 0/4. The regime is Cautious ×1.15.';
  assert.deepEqual(unsupportedNumbers(deadMoney, digest), []);
  assert.deepEqual(unsupportedNumbers('A safer stop for D05 would be −9.5% at SGD 59.83.', digest), ['−9.5%', '59.83']);
});

test('"What\'s a good stop-loss for D05 if I hold for 6 months?" end to end: Gemini sees the stops and the reply keeps its figures', async () => {
  const answer = 'QuantLens describes the data and does not advise. For a 3 to 6 month hold of D05.SI (snapshot of 23 Nov 2026), the medium stop is −12.2% at SGD 58.04; after a rise of +15.3% (76.20) the stop moves to the entry and trails −14.0% (56.83 today). These are volatility-sized risk boundaries, not advice.';
  const fetchImpl = fakeFetch({ context: FIXTURE_V5, gemini: () => geminiReply(answer) });
  const result = await answerQuestion({ chat: { id: CHAT }, messageId: 77, text: "What's a good stop-loss for D05 if I hold for 6 months?", replyTo: null },
    GEMINI_ENV, { fetchImpl, sleep: fakeSleep(), now: () => hoursAfter(FIXTURE_V5.asOf, 5) });
  assert.deepEqual(result, { outcome: 'sent-plain', answer: 'gemini', flagged: 0 });
  const [call] = fetchImpl.calls.filter((entry) => entry.url.startsWith('https://generativelanguage.googleapis.com/'));
  const system = call.body.systemInstruction.parts[0].text;
  assert.ok(system.includes('9. Stop-loss questions'));
  assert.ok(system.includes('medium: initial −12.2% at 58.04 · breakeven +15.3% at 76.20 · trail −14.0% (56.83 today)'));
  const [sent] = fetchImpl.messages();
  assert.equal(sent.text, `${answer}\n\n${FOOTER}`);
});

test('/radar through the webhook: one MarkdownV2 reply, and the logs hold no token, chat id or text', async () => {
  const fetchImpl = fakeFetch({ context: FIXTURE_V5 });
  const ctx = fakeCtx();
  const logs = await captureConsole(async () => {
    const response = await handle(webhook(textUpdate('/radar')), ENV, ctx, { fetchImpl, sleep: fakeSleep(), now: () => hoursAfter(FIXTURE_V5.asOf, 5) });
    assert.equal(response.status, 200);
    await ctx.settled();
  });
  const [message] = fetchImpl.messages();
  assert.equal(message.parse_mode, 'MarkdownV2');
  assert.ok(message.text.startsWith('*Decision Radar*'));
  assert.ok(message.text.includes('*Weakest · Dead Money · 0\\-1 of 4 on three sessions running \\(15\\)*'));
  const logged = logs.join('\n');
  assert.match(logged, /"command":"radar"/);
  for (const secret of [TOKEN, String(CHAT), GEMINI_KEY, 'Decision Radar', '/radar']) assert.ok(!logged.includes(secret), `log leaks ${secret}`);
});
