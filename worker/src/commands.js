/**
 * commands.js: the slash commands, answered by code from bot_context.json (no model involved).
 *
 *   /start, /help     what the bot does and how to ask
 *   /check <TICKER>   one asset: trend regime, close, relative strength, beta, volatility,
 *                     the latest move, spread, Amihud, the next earnings and ex-dividend
 *   /regime           the VIX curve, its inverted streak, and the next FOMC and CPI (ET and SGT)
 *   /triggers         what fired in the snapshot (the Telegram briefing's rules), or a quiet day
 *   /rotation         the groups by quadrant against the S&P 500 in USD
 *   /upcoming         the next 30 days: macro events, closures, earnings, ex-dividends
 *
 * A missing figure is shown with the snapshot's own reason, word for word. Every reply ends with
 * the snapshot's date, so an answer is never mistaken for a live quote.
 */

import { bold, pct, fixed, sig, price, compact, longDate, dayLabel, bothClocks, clockIn, ordinal } from './format.js';
import { resolveTicker, watchlistLines } from './tickers.js';

export const COMMANDS = ['start', 'help', 'check', 'regime', 'triggers', 'rotation', 'upcoming'];
const QUADRANTS = ['Leading', 'Weakening', 'Lagging', 'Improving'];
const TIMING = { 'before-open': 'before the open', 'during-session': 'during the session', 'after-close': 'after the close' };
const STATE_MARK = { normal: '🟢', elevated: '🟡', stressed: '🔴' };
const MARKETS = { US: 'US', SG: 'SGX', UK: 'London', CRYPTO: 'crypto' };

/** "/check@QuantLensBot d05" → { name: 'check', args: 'd05' }; null for text that is not a command. */
export function parseCommand(text) {
  const match = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** The last line of every reply: the snapshot's date, and that this is not advice. */
function footer(context) {
  return `Snapshot ${longDate(context.asOf)} · not financial advice`;
}

function staleLine(loaded) {
  if (!loaded.stale) return [];
  const days = Math.floor(loaded.ageHours / 24);
  return [`⚠ This snapshot is ${days} day${days === 1 ? '' : 's'} old: the daily refresh may have failed.`];
}

function unavailable(loaded) {
  return [`QuantLens data is unreachable right now: ${loaded.problem}. Try again in a few minutes; the commands answer only from the published snapshot.`];
}

/* ------------------------------------------------------------------ */
/* /help                                                               */
/* ------------------------------------------------------------------ */

export function helpLines(loaded) {
  const lines = [
    [bold('QuantLens bot')],
    'Facts about the 30-asset QuantLens watchlist, straight from the latest daily snapshot.',
    '',
    '/check D05 · one asset: trend regime, relative strength, beta, volatility, last move, spread, next events',
    '/regime · the VIX curve, and the next FOMC decision and CPI release',
    '/triggers · what fired in the latest snapshot',
    '/rotation · which groups lead and lag the S&P 500',
    '/upcoming · the next 30 days: macro events, closures, earnings, ex-dividends',
    '',
    'Plain-English questions work too ("how is DBS trending?"). They are answered only from the snapshot; reply to an answer to ask a follow-up.',
  ];
  if (loaded.ok) lines.push('', footer(loaded.context));
  else lines.push('', unavailable(loaded)[0]);
  return lines;
}

/* ------------------------------------------------------------------ */
/* /check                                                              */
/* ------------------------------------------------------------------ */

const has = (cell) => cell && typeof cell === 'object' && 'v' in cell && cell.v !== null;
const missing = (cell) => (cell && typeof cell === 'object' && typeof cell.na === 'string' ? cell.na : null);

/** The card of one asset, as message lines. */
export function assetCard(asset, context, env = {}) {
  const lines = [[bold(`${asset.ticker} · ${asset.name}`)]];
  const market = MARKETS[asset.market] ?? asset.market;
  const kind = asset.class === market ? market : `${market} · ${asset.class}`;
  lines.push(`${kind} · close ${asset.ccy} ${price(asset.close)} on ${longDate(asset.asOf)}${asset.status && asset.status !== 'fresh' ? ` (${asset.status})` : ''}`);
  const gaps = new Map(); // reason -> labels: a reason shared by several figures is written once
  const gap = (label, cell) => {
    const reason = missing(cell);
    if (reason) gaps.set(reason, [...(gaps.get(reason) ?? []), label]);
  };
  const row = (items) => {
    const shown = items.filter(Boolean);
    if (shown.length) lines.push(shown.join(' · '));
  };

  row([
    has(asset.trend) ? `Trend: ${asset.trend.v}` : (gap('Trend', asset.trend), null),
    has(asset.technical) ? `Technical ${fixed(asset.technical.v, 0)}` : (gap('Technical score', asset.technical), null),
    has(asset.fundamental) ? `Fundamental ${fixed(asset.fundamental.v, 0)}` : (gap('Fundamental score', asset.fundamental), null),
  ]);
  const vs = asset.rs1m && asset.rs1m.vs ? ` vs ${asset.rs1m.vs}` : '';
  row([
    has(asset.rs1m) ? `RS 1M ${pct(asset.rs1m.v, 1, { signed: true })}` : (gap('RS 1M', asset.rs1m), null),
    has(asset.rs3m) ? `RS 3M ${pct(asset.rs3m.v, 1, { signed: true })}${vs}` : (gap('RS 3M', asset.rs3m), null),
  ]);
  row([
    has(asset.rotation) ? `Rotation vs S&P 500 (USD): ${asset.rotation.v}${asset.group ? ` · group ${asset.group}` : ''}` : (gap('Rotation', asset.rotation), null),
  ]);
  row([
    has(asset.beta) ? `Beta ${fixed(asset.beta.v, 2)}` : (gap('Beta', asset.beta), null),
    has(asset.ewmaVol) ? `EWMA vol ${pct(asset.ewmaVol.v, 1)} a year` : (gap('EWMA volatility', asset.ewmaVol), null),
    has(asset.var95) ? `1-day VaR 95% ${pct(asset.var95.v, 1)}` : (gap('VaR 95%', asset.var95), null),
  ]);
  if (asset.shock && typeof asset.shock.ret === 'number') {
    lines.push(`Last move ${pct(asset.shock.ret, 1, { signed: true })} (${fixed(asset.shock.z, 1, { signed: true })}σ) on ${longDate(asset.shock.date)}`);
  } else gap('Last move', asset.shock);
  row([
    has(asset.spread) ? `Spread at least ${pct(asset.spread.v, 3)} (one tick)` : (gap('Spread', asset.spread), null),
    has(asset.amihud) ? `Amihud ${sig(asset.amihud.v, 2)} bp per US$1M` : (gap('Amihud', asset.amihud), null),
    has(asset.adv) ? `traded ${asset.adv.ccy ?? asset.ccy} ${compact(asset.adv.v)} a day` : (gap('Traded value', asset.adv), null),
  ]);
  const earnings = asset.nextEarnings;
  if (earnings && earnings.date) {
    const when = TIMING[earnings.timing] ?? 'time not known';
    const days = Number.isInteger(earnings.tradingDays) ? ` (${earnings.tradingDays} trading day${earnings.tradingDays === 1 ? '' : 's'})` : '';
    lines.push(`Next earnings ~${longDate(earnings.date)}, ${when}${days}`);
  } else gap('Next earnings', earnings);
  const dividend = asset.nextExDividend;
  if (dividend && dividend.date) lines.push(`Next ex-dividend ${dividend.estimated ? '~' : ''}${longDate(dividend.date)}${dividend.estimated ? ' (estimated)' : ''}`);
  else gap('Next ex-dividend', dividend);

  for (const [reason, labels] of gaps) lines.push(`${labels.join(', ')}: N/A. ${reason}`);
  lines.push(footer(context));
  if (env.SITE_URL) lines.push(`${env.SITE_URL}?t=${encodeURIComponent(asset.ticker)}`);
  return lines;
}

function checkLines(args, context, env) {
  if (!args) return ['Which asset? For example /check D05, /check BTC or /check TSLA.', '', ...watchlistLines(context.assets)];
  const found = resolveTicker(args, context.assets);
  if (found.asset) return assetCard(found.asset, context, env);
  const guess = found.suggestion ? ` Did you mean ${found.suggestion.ticker} (${found.suggestion.name})?` : '';
  return [`${found.query} isn't tracked in QuantLens.${guess}`, '', 'The watchlist:', ...watchlistLines(context.assets)];
}

/* ------------------------------------------------------------------ */
/* /regime                                                             */
/* ------------------------------------------------------------------ */

function curveLine(regime) {
  const { vix, vix3m } = regime.levels ?? {};
  const ratio = fixed(regime.ratio, 2);
  if (regime.inverted || regime.state === 'stressed') {
    const streak = Number.isInteger(regime.invertedStreak) && regime.invertedStreak > 0 ? `, ${ordinal(regime.invertedStreak)} session in a row` : '';
    return `VIX ${fixed(vix, 1)} above VIX3M ${fixed(vix3m, 1)} (ratio ${ratio}): the curve is inverted${streak}`;
  }
  const shape = regime.ratio < (regime.rules?.elevatedRatio ?? 0.95) ? 'the curve slopes up (contango)' : 'the curve is flat';
  return `VIX ${fixed(vix, 1)} and VIX3M ${fixed(vix3m, 1)} (ratio ${ratio}): ${shape}`;
}

function regimeLines(context) {
  const regime = context.regime;
  const lines = [];
  if (!regime || regime.status === 'unavailable' || !regime.levels) {
    lines.push([bold('Market regime: unavailable')], 'The VIX curve could not be read for this snapshot.');
  } else {
    lines.push([bold(`Market regime: ${regime.state}`), ` ${STATE_MARK[regime.state] ?? ''}`.trimEnd()]);
    lines.push(curveLine(regime));
    lines.push(`VIX9D ${fixed(regime.levels.vix9d, 1)} · reading of ${longDate(regime.asOf)}${regime.status === 'stale' ? ' (an older reading)' : ''}`);
  }
  for (const [kind, name] of [['fomc-decision', 'FOMC rate decision'], ['cpi', 'US CPI release']]) {
    const next = context.events.find((event) => event.kind === kind && event.at);
    lines.push(next ? `Next ${next.label ?? name}: ${bothClocks(next.at)}` : `No ${name} in the next 30 days of the snapshot.`);
  }
  lines.push('Context only: the regime changes no score, trend regime or position size.');
  lines.push(footer(context));
  return lines;
}

/* ------------------------------------------------------------------ */
/* /triggers                                                           */
/* ------------------------------------------------------------------ */

function moveText(move) {
  const z = typeof move.zScore === 'number' ? `${fixed(move.zScore, 1, { signed: true })}σ` : 'σ not known';
  const size = move.rule === 'size' && typeof move.threshold === 'number' ? `, beyond ${fixed(move.threshold * 100, 0)}%` : '';
  return `${move.ticker} ${pct(move.dailyReturn, 1, { signed: true })} (${z}${size})`;
}

export function triggerLines(context) {
  const triggers = context.triggers;
  const lines = [[bold(`Triggers in the snapshot of ${longDate(context.asOf)}`)]];
  if (!triggers.length) {
    lines.push('A quiet day: no big moves, trend flips, VIX curve change, FOMC or CPI within 48 hours, earnings within 5 trading days or tone shifts.');
    lines.push(footer(context));
    return lines;
  }
  const of = (kind) => triggers.filter((trigger) => trigger.kind === kind);
  for (const event of of('macro')) lines.push(`• ${event.label}: ${bothClocks(event.at)}`);
  for (const vix of of('vix')) {
    lines.push(vix.change === 'inverted'
      ? `• VIX curve inverted, day 1: VIX ${fixed(vix.vix, 1)} above VIX3M ${fixed(vix.vix3m, 1)}`
      : `• VIX curve no longer inverted: ${vix.state} after ${vix.priorStreak} inverted session${vix.priorStreak === 1 ? '' : 's'} (VIX ${fixed(vix.vix, 1)}, VIX3M ${fixed(vix.vix3m, 1)})`);
  }
  if (of('move').length) lines.push(`• Big moves: ${of('move').map(moveText).join(' · ')}`);
  if (of('flip').length) lines.push(`• Trend flips (held two closes): ${of('flip').map((flip) => `${flip.ticker} ${flip.from} → ${flip.to}`).join(' · ')}`);
  for (const earnings of of('earnings')) {
    const when = TIMING[earnings.timing] ?? 'time not known';
    const size = typeof earnings.typicalMove === 'number' && typeof earnings.worstMove === 'number'
      ? ` · typical move ±${pct(earnings.typicalMove, 1)}, worst ${pct(earnings.worstMove, 1, { signed: true })}` : '';
    lines.push(`• Earnings: ${earnings.ticker} ~${dayLabel(earnings.date)}, ${when} (${earnings.tradingDays} trading day${earnings.tradingDays === 1 ? '' : 's'})${size}`);
  }
  for (const tone of of('tone')) {
    lines.push(`• Tone: ${tone.ticker} ${tone.from} → ${tone.to} (${fixed(tone.before, 2, { signed: true })} → ${fixed(tone.after, 2, { signed: true })})`);
    if (tone.headline) lines.push(`   “${tone.headline}”`);
  }
  lines.push(`Computed when the snapshot was built (${String(context.builtAt ?? context.asOf).replace('T', ' ').replace('Z', ' UTC')}), against the snapshot before it.`);
  lines.push(footer(context));
  return lines;
}

/* ------------------------------------------------------------------ */
/* /rotation                                                           */
/* ------------------------------------------------------------------ */

function rotationLines(context) {
  const { groups = [] } = context.rotation;
  const lines = [[bold('Rotation vs the S&P 500 in USD')], 'Group medians of relative strength over 3 months · 1 month.'];
  for (const quadrant of QUADRANTS) {
    const members = groups.filter((group) => group.quadrant === quadrant).sort((a, b) => (b.rs3m ?? 0) - (a.rs3m ?? 0));
    lines.push('', [bold(`${quadrant}${members.length ? '' : ': none'}`)]);
    for (const group of members) lines.push(`${group.group}: ${pct(group.rs3m, 1, { signed: true })} · ${pct(group.rs1m, 1, { signed: true })} (${group.members.join(', ')})`);
  }
  const unplaced = groups.filter((group) => !QUADRANTS.includes(group.quadrant));
  if (unplaced.length) lines.push('', `No reading: ${unplaced.map((group) => group.group).join(', ')}`);
  lines.push('', 'A description of the past one and three months, not a signal.', footer(context));
  return lines;
}

/* ------------------------------------------------------------------ */
/* /upcoming                                                           */
/* ------------------------------------------------------------------ */

function eventText(event) {
  switch (event.kind) {
    case 'earnings':
      return `earnings ${event.ticker} (${TIMING[event.timing] ?? 'time not known'})`;
    case 'ex-dividend':
      return `ex-dividend ${event.ticker}${event.estimated ? ' (estimated)' : ''}`;
    case 'fomc-decision':
    case 'cpi':
    case 'fomc-minutes': {
      if (!event.at) return event.label;
      const sgt = clockIn(event.at, 'Asia/Singapore');
      return `${event.label} at ${clockIn(event.at, 'America/New_York').time} ET (${sgt.weekday} ${sgt.time} SGT)`;
    }
    default:
      return event.label ?? event.kind;
  }
}

function upcomingLines(context) {
  const lines = [[bold('The next 30 days')]];
  if (!context.events.length) {
    lines.push('Nothing scheduled: no FOMC, CPI, market closures, watchlist earnings or ex-dividend dates.');
  } else {
    const byDate = new Map();
    for (const event of context.events) byDate.set(event.date, [...(byDate.get(event.date) ?? []), eventText(event)]);
    for (const [day, items] of byDate) lines.push([bold(dayLabel(day)), `: ${items.join(' · ')}`]);
  }
  lines.push('Counted from the snapshot date. Earnings dates come from company calendars and can move.');
  lines.push(footer(context));
  return lines;
}

/* ------------------------------------------------------------------ */

/**
 * The reply to a command, as message lines.
 * @param {{ name:string, args:string }} command
 * @param {{ ok:boolean, context?:object, problem?:string, stale?:boolean, ageHours?:number }} loaded
 */
export function runCommand(command, loaded, env = {}) {
  if (command.name === 'start' || command.name === 'help') return helpLines(loaded);
  if (!COMMANDS.includes(command.name)) return [`/${command.name} isn't a command here.`, '', ...helpLines(loaded)];
  if (!loaded.ok) return unavailable(loaded);
  const { context } = loaded;
  const body = {
    check: () => checkLines(command.args, context, env),
    regime: () => regimeLines(context),
    triggers: () => triggerLines(context),
    rotation: () => rotationLines(context),
    upcoming: () => upcomingLines(context),
  }[command.name]();
  return [...staleLine(loaded), ...body];
}
