/**
 * The six commands, answered by code from bot_context.json: exact text against the frozen
 * fixture, and shape, size and escaping against the file the pipeline commits today.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, runCommand, assetCard, COMMANDS } from '../src/commands.js';
import { renderLine, groupLines, chunk, TELEGRAM_LIMIT } from '../src/format.js';
import { FIXTURE, COMMITTED, ENV, clone, markdownProblem } from './helpers.mjs';

const loadedOf = (context, extra = {}) => ({ ok: true, context, ageHours: 5, stale: false, ...extra });
const reply = (text, context = FIXTURE, env = ENV, extra = {}) => runCommand(parseCommand(text), loadedOf(context, extra), env);
const plain = (lines) => lines.map((line) => renderLine(line, false));
const plainText = (lines) => plain(lines).join('\n');

test('parseCommand reads a command, its bot suffix and its argument', () => {
  assert.deepEqual(parseCommand('/check d05'), { name: 'check', args: 'd05' });
  assert.deepEqual(parseCommand('  /CHECK@QuantLensBot   D05  '), { name: 'check', args: 'D05' });
  assert.deepEqual(parseCommand('/regime'), { name: 'regime', args: '' });
  assert.deepEqual(parseCommand('/check\nS&P 500'), { name: 'check', args: 'S&P 500' });
  assert.deepEqual(parseCommand('/upcoming@bot'), { name: 'upcoming', args: '' });
  for (const text of ['hello', 'what does /check do?', '/ check', '/', '', null, '//check']) assert.equal(parseCommand(text), null, String(text));
});

test('/check D05 is the full card, in display units', () => {
  assert.deepEqual(plain(reply('/check D05')), [
    'D05.SI · DBS Group Holdings Ltd',
    'SGX · equity · close SGD 66.11 on 20 Nov 2026',
    'Trend: Pullback · Technical 32 · Fundamental 65',
    'RS 1M −2.1% · RS 3M +0.6% vs ^STI',
    'Rotation vs S&P 500 (USD): Lagging · group SG banks',
    'Beta 1.10 · EWMA vol 18.4% a year · 1-day VaR 95% 1.4%',
    'Last move −1.8% (−1.7σ) on 20 Nov 2026',
    'Spread at least 0.015% (one tick) · Amihud 0.24 bp per US$1M · traded SGD 428.7M a day',
    'Next earnings ~15 Feb 2027, after the close (58 trading days)',
    'Next ex-dividend ~12 Feb 2027 (estimated)',
    'Snapshot 22 Nov 2026 · not financial advice',
    'https://pages.example.test/quantlens/?t=D05.SI',
  ]);
  assert.deepEqual(reply('/check dbs'), reply('/check D05.SI'));
});

test('/check BTC repeats each N/A reason word for word, once', () => {
  const lines = plain(reply('/check btc'));
  assert.equal(lines[0], 'BTC-USD · Bitcoin');
  assert.equal(lines[1], 'crypto · close USD 58,799.00 on 20 Nov 2026');
  const btc = FIXTURE.assets.find((asset) => asset.ticker === 'BTC-USD');
  const benchmark = btc.rs1m.na;
  assert.ok(lines.includes(`RS 1M, RS 3M: N/A. ${benchmark}`));
  assert.ok(lines.includes(`Beta: N/A. ${btc.beta.na}`));
  assert.ok(lines.includes(`Fundamental score: N/A. ${btc.fundamental.na}`));
  assert.ok(lines.includes(`Spread: N/A. ${btc.spread.na}`));
  assert.ok(lines.includes(`Next earnings: N/A. ${btc.nextEarnings.na}`));
  assert.ok(lines.includes(`Next ex-dividend: N/A. ${btc.nextExDividend.na}`));
  assert.equal(lines.filter((line) => line.includes(benchmark)).length, 1);
});

test('an index card links with its ^ encoded', () => {
  const lines = plain(reply('/check spx'));
  assert.equal(lines[0], '^GSPC · S&P 500');
  assert.equal(lines.at(-1), 'https://pages.example.test/quantlens/?t=%5EGSPC');
  assert.equal(plain(reply('/check spx', FIXTURE, {})).at(-1), 'Snapshot 22 Nov 2026 · not financial advice', 'no link without SITE_URL');
});

test('/check of something untracked says so and lists the watchlist', () => {
  const amdd = plain(reply('/check AMDD'));
  assert.equal(amdd[0], "AMDD isn't tracked in QuantLens. Did you mean AMD (Advanced Micro Devices, Inc.)?");
  assert.equal(amdd[2], 'The watchlist:');
  const aapl = plain(reply('/check aapl'));
  assert.equal(aapl[0], "AAPL isn't tracked in QuantLens.");
  for (const asset of FIXTURE.assets) assert.ok(aapl.join(' ').split(/\s/).includes(asset.ticker), asset.ticker);
  const none = plain(reply('/check'));
  assert.equal(none[0], 'Which asset? For example /check D05, /check BTC or /check TSLA.');
  assert.ok(none.some((line) => line.startsWith('SGX: D05.SI')));
});

test('/regime: the VIX curve, its streak, and the next FOMC and CPI in both clocks', () => {
  assert.deepEqual(plain(reply('/regime')), [
    'Market regime: stressed 🔴',
    'VIX 35.9 above VIX3M 30.9 (ratio 1.16): the curve is inverted, 4th session in a row',
    'VIX9D 40.7 · reading of 20 Nov 2026',
    'Next FOMC rate decision (+ projections): Wed 9 Dec 2:00 PM ET · Thu 3:00 AM SGT',
    'Next US CPI (November): Thu 10 Dec 8:30 AM ET · Thu 9:30 PM SGT',
    'Context only: the regime changes no score, trend regime or position size.',
    'Snapshot 22 Nov 2026 · not financial advice',
  ]);
});

test('/regime in calm and flat markets, without data, and with no FOMC or CPI ahead', () => {
  const calm = clone(FIXTURE);
  Object.assign(calm.regime, { state: 'normal', inverted: false, invertedStreak: 0, ratio: 0.85, levels: { vix9d: 13.2, vix: 14.1, vix3m: 16.6 } });
  const calmLines = plain(reply('/regime', calm));
  assert.equal(calmLines[0], 'Market regime: normal 🟢');
  assert.equal(calmLines[1], 'VIX 14.1 and VIX3M 16.6 (ratio 0.85): the curve slopes up (contango)');
  Object.assign(calm.regime, { state: 'elevated', ratio: 0.97 });
  assert.equal(plain(reply('/regime', calm))[1], 'VIX 14.1 and VIX3M 16.6 (ratio 0.97): the curve is flat');

  const none = clone(FIXTURE);
  none.regime = { status: 'unavailable', state: null, levels: null };
  none.events = none.events.filter((event) => !['fomc-decision', 'cpi'].includes(event.kind));
  const lines = plain(reply('/regime', none));
  assert.equal(lines[0], 'Market regime: unavailable');
  assert.ok(lines.includes('No FOMC rate decision in the next 30 days of the snapshot.'));
  assert.ok(lines.includes('No US CPI release in the next 30 days of the snapshot.'));
});

test('/triggers lists what fired in the snapshot', () => {
  const lines = plain(reply('/triggers'));
  assert.equal(lines[0], 'Triggers in the snapshot of 22 Nov 2026');
  assert.equal(lines[1], '• Tone: WMT negative → positive (−0.09 → +0.26)');
  assert.equal(lines[2], '   “Walmart (WMT) Stock May Be Fully Valued After Earnings News”');
  assert.equal(lines.filter((line) => line.startsWith('• Tone:')).length, 3);
  assert.equal(lines.at(-2), 'Computed when the snapshot was built (2026-11-22 04:03:19 UTC), against the snapshot before it.');
});

test('/triggers on a quiet day and on a busy one', () => {
  const quiet = clone(FIXTURE);
  quiet.triggers = [];
  assert.match(plainText(reply('/triggers', quiet)), /A quiet day: no big moves, trend flips, VIX curve change/);

  const busy = clone(FIXTURE);
  busy.triggers = [
    { kind: 'macro', type: 'fomc-decision', date: '2026-12-09', at: '2026-12-09T14:00:00-05:00', label: 'FOMC rate decision (+ projections)', hours: 30 },
    { kind: 'vix', change: 'inverted', state: 'stressed', vix: 35.89, vix3m: 30.94, priorStreak: 0 },
    { kind: 'vix', change: 'uninverted', state: 'elevated', vix: 22.1, vix3m: 23.04, priorStreak: 6 },
    { kind: 'move', ticker: 'BTC-USD', assetClass: 'crypto', dailyReturn: -0.0712, zScore: -2.24, threshold: 0.15, rule: 'sigma', date: '2026-11-20' },
    { kind: 'move', ticker: 'SNDK', assetClass: 'equity', dailyReturn: 0.124, zScore: 1.6, threshold: 0.1, rule: 'size', date: '2026-11-20' },
    { kind: 'flip', ticker: 'TSLA', from: 'Uptrend', to: 'Pullback', date: '2026-11-20', crossed200: false, crossedEma: true },
    { kind: 'earnings', ticker: 'ORCL', date: '2026-12-14', days: 22, tradingDays: 3, timing: 'after-close', typicalMove: 0.072, worstMove: -0.135 },
  ];
  const lines = plain(reply('/triggers', busy));
  for (const expected of [
    '• FOMC rate decision (+ projections): Wed 9 Dec 2:00 PM ET · Thu 3:00 AM SGT',
    '• VIX curve inverted, day 1: VIX 35.9 above VIX3M 30.9',
    '• VIX curve no longer inverted: elevated after 6 inverted sessions (VIX 22.1, VIX3M 23.0)',
    '• Big moves: BTC-USD −7.1% (−2.2σ) · SNDK +12.4% (+1.6σ, beyond 10%)',
    '• Trend flips (held two closes): TSLA Uptrend → Pullback',
    '• Earnings: ORCL ~Mon 14 Dec, after the close (3 trading days) · typical move ±7.2%, worst −13.5%',
  ]) assert.ok(lines.includes(expected), `missing: ${expected}\n${lines.join('\n')}`);
});

test('/rotation: groups by quadrant, strongest three-month reading first', () => {
  const lines = plain(reply('/rotation'));
  assert.equal(lines[0], 'Rotation vs the S&P 500 in USD');
  const headings = ['Leading', 'Weakening: none', 'Lagging', 'Improving: none'].map((heading) => lines.indexOf(heading));
  assert.ok(headings.every((index, i) => index > 0 && (i === 0 || index > headings[i - 1])), `headings in order: ${headings}`);
  const leading = lines.slice(headings[0] + 1, headings[1] - 1).map((line) => line.split(':')[0]);
  assert.deepEqual(leading, ['Defensives', 'Financials', 'SG other', 'SG REITs', 'Broad US']);
  assert.ok(lines[headings[0] + 1].startsWith('Defensives: +28.2% · +20.5% ('));
  const lagging = lines.slice(headings[2] + 1, headings[3] - 1).map((line) => line.split(':')[0]);
  assert.deepEqual(lagging, ['SG banks', 'Energy & uranium', 'Crypto', 'Gold & metals', 'Tech & semis', 'Industrials']);
  assert.ok(lines.includes('A description of the past one and three months, not a signal.'));
});

test('/upcoming: the next 30 days by date, macro times in both clocks', () => {
  assert.deepEqual(plain(reply('/upcoming')), [
    'The next 30 days',
    'Wed 25 Nov: ex-dividend C6L.SI · ex-dividend NEM',
    'Thu 26 Nov: US markets closed (Thanksgiving Day)',
    'Fri 27 Nov: US closes 1:00 PM ET (Day after Thanksgiving)',
    'Mon 30 Nov: ex-dividend CCJ',
    'Tue 8 Dec: ex-dividend BLK',
    'Wed 9 Dec: FOMC rate decision (+ projections) at 2:00 PM ET (Thu 3:00 AM SGT)',
    'Thu 10 Dec: US CPI (November) at 8:30 AM ET (Thu 9:30 PM SGT)',
    'Fri 11 Dec: ex-dividend WMT',
    'Mon 14 Dec: earnings ORCL (after the close)',
    'Thu 17 Dec: earnings MU (after the close)',
    'Counted from the snapshot date. Earnings dates come from company calendars and can move.',
    'Snapshot 22 Nov 2026 · not financial advice',
  ]);
  const estimated = clone(FIXTURE);
  estimated.events[0].estimated = true;
  assert.ok(plain(reply('/upcoming', estimated))[1].startsWith('Wed 25 Nov: ex-dividend C6L.SI (estimated) · '));
  const empty = clone(FIXTURE);
  empty.events = [];
  assert.match(plainText(reply('/upcoming', empty)), /Nothing scheduled/);
});

test('/help and /start are the same, and an unknown command points to them', () => {
  assert.deepEqual(reply('/start'), reply('/help'));
  const help = plainText(reply('/help'));
  for (const command of COMMANDS.filter((name) => name !== 'start' && name !== 'help')) assert.match(help, new RegExp(`/${command}`));
  const unknown = plain(reply('/buy TSLA'));
  assert.equal(unknown[0], "/buy isn't a command here.");
  assert.ok(unknown.includes('QuantLens bot'));
});

test('a stale snapshot is flagged first, and missing data is said in words', () => {
  const stale = plain(reply('/regime', FIXTURE, ENV, { stale: true, ageHours: 75 }));
  assert.equal(stale[0], '⚠ This snapshot is 3 days old: the daily refresh may have failed.');
  const down = { ok: false, problem: 'GitHub Pages returned HTTP 503' };
  for (const name of ['check', 'regime', 'triggers', 'rotation', 'upcoming']) {
    const lines = plain(runCommand({ name, args: 'D05' }, down, ENV));
    assert.deepEqual(lines, ['QuantLens data is unreachable right now: GitHub Pages returned HTTP 503. Try again in a few minutes; the commands answer only from the published snapshot.']);
  }
  const help = plainText(runCommand({ name: 'help', args: '' }, down, ENV));
  assert.match(help, /\/check D05/);
  assert.match(help, /unreachable right now/);
});

/* The committed file: every reply fits, parses as MarkdownV2 and shows no raw values. */

function assertSendable(lines, label) {
  const messages = chunk(lines);
  for (const message of messages) {
    assert.ok(message.length <= TELEGRAM_LIMIT, `${label}: ${message.length} characters`);
    assert.equal(markdownProblem(message), null, label);
  }
  assert.equal(groupLines(lines).length, messages.length);
  const text = plainText(lines);
  for (const raw of ['undefined', 'NaN', '[object Object]', 'null']) assert.ok(!text.includes(raw), `${label} shows "${raw}"`);
}

test('every committed asset has a card that fits one message, with its date and every N/A reason', () => {
  for (const asset of COMMITTED.assets) {
    const lines = reply(`/check ${asset.ticker}`, COMMITTED);
    assertSendable(lines, asset.ticker);
    assert.equal(chunk(lines).length, 1, `${asset.ticker} fits one message`);
    const text = plainText(lines);
    assert.ok(text.startsWith(`${asset.ticker} · ${asset.name}`));
    assert.match(text, /Snapshot \d{1,2} \w{3} \d{4} · not financial advice/);
    for (const [field, cell] of Object.entries(asset)) {
      if (cell && typeof cell === 'object' && typeof cell.na === 'string') assert.ok(text.includes(cell.na), `${asset.ticker}.${field} reason shown verbatim`);
    }
    assert.deepEqual(assetCard(asset, COMMITTED, ENV), lines);
  }
});

test('every command on the committed file is sendable', () => {
  for (const text of ['/help', '/start', '/check', '/check AAPL', '/check amdd', '/regime', '/triggers', '/rotation', '/upcoming', '/nope']) {
    assertSendable(reply(text, COMMITTED), text);
  }
});
