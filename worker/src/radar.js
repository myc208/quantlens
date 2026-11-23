/**
 * radar.js: the Decision Radar and the three-pillar macro regime (V5.0), as message lines.
 *
 * Everything is read from bot_context.json, where the site's own engines wrote it: each asset's
 * health tier and score on total return, the dividend-trap check, two-stage stops for three
 * holding horizons (fractions of the last close and tick-rounded prices), ex-dividend and
 * earnings-gap warnings, and the macro regime whose multiplier widens every stop. Nothing is
 * computed here, only written out. A summary published before V5.0 has neither block, and the
 * lines then say so instead of guessing.
 *
 * The weakest tier is labelled "Weakest · Dead Money": a description of the last year, never a
 * list to sell.
 */

import { bold, pct, fixed, tickPrice, longDate } from './format.js';

export const HORIZONS = Object.freeze({
  short: 'short (2 weeks to 1 month)',
  medium: 'medium (3 to 6 months)',
  long: 'long (1 year or more)',
});
const PILLARS = [['volatility', 'Volatility'], ['credit', 'Credit'], ['rates', 'Rates']];
const POINTS = ['trend', 'strength', 'momentum', 'drawdown'];
const STATE_MARK = { Calm: '🟢', Cautious: '🟡', Stressed: '🔴' };
const TIERS = [
  ['Healthy', 'Healthy · score 3-4'],
  ['Neutral', 'Neutral · score 2, or 0-1 not yet on three sessions'],
  ['Dead Money', 'Weakest · Dead Money · 0-1 of 4 on three sessions running'],
];

export const NOT_YET = 'The Decision Radar is not in this snapshot: it was published before QuantLens V5.0. It appears after the next daily refresh.';

const number = (value) => typeof value === 'number' && Number.isFinite(value);
const points = (fraction) => `${fixed(fraction * 100, 2, { signed: true })} points`;

/** True when the summary carries the V5.0 blocks. */
export function hasRadar(context) {
  return Boolean(context && context.stress && Array.isArray(context.assets) && context.assets.some((asset) => asset.radar && asset.radar.tier));
}

/* ------------------------------------------------------------------ */
/* The macro regime                                                    */
/* ------------------------------------------------------------------ */

function pillarLine(name, label, pillar, rules = {}) {
  if (!pillar || pillar.status === 'unavailable') return `• ${label}: not read.${pillar && pillar.note ? ` ${pillar.note}` : ''}`;
  const verdict = pillar.flag ? 'flagged' : 'clear';
  const older = pillar.status === 'stale' && pillar.asOf ? ` (an older reading, ${longDate(pillar.asOf)})` : '';
  const window = rules.window ?? 20;
  const change = number(pillar.change) ? `, ${points(pillar.change)} in ${window} sessions` : '';
  if (name === 'volatility') {
    return `• ${label}: ${verdict}. VIX ÷ VIX3M ${fixed(pillar.value, 2)} (flag at ${fixed(rules.volRatio ?? 1, 2)} or above)${older}`;
  }
  if (name === 'credit') {
    return `• ${label}: ${verdict}. US high-yield spread ${pct(pillar.value, 2)}${change} (flag at ${pct(rules.creditLevel, 2)}, or ${fixed((rules.creditWidening ?? 0) * 100, 2)} points wider)${older}`;
  }
  const twoYear = number(pillar.twoYearChange) ? `, 2-year yield ${points(pillar.twoYearChange)}` : '';
  return `• ${label}: ${verdict}. 10Y − 2Y spread ${pct(pillar.value, 2, { signed: true })}${change}${twoYear} (flag below 0, or ${fixed((rules.ratesSteepening ?? 0) * 100, 2)} points steeper while the 2-year fell)${older}`;
}

/** The regime's state, its multiplier and one line per pillar. */
export function stressLines(context) {
  const stress = context.stress;
  if (!stress) return [NOT_YET];
  if (!stress.state) {
    return [[bold('Macro regime: not read')], 'None of the three pillars could be read, so the stops carry no regime multiplier (×1.00).'];
  }
  const flagged = PILLARS.filter(([name]) => stress.pillars[name] && stress.pillars[name].flag === true).map(([, label]) => label.toLowerCase());
  const lines = [
    [bold(`Macro regime: ${stress.state} ×${fixed(stress.multiplier, 2)}`), ` ${STATE_MARK[stress.state] ?? ''}`.trimEnd()],
    `${stress.flags} flag${stress.flags === 1 ? '' : 's'} out of ${stress.active} pillar${stress.active === 1 ? '' : 's'} read${flagged.length ? ` (${flagged.join(', ')})` : ''}, so every Decision Radar stop is widened ×${fixed(stress.multiplier, 2)}. The scale: 0 flags Calm ×1.00, 1 Cautious ×1.15, 2-3 Stressed ×1.35.`,
    ...PILLARS.map(([name, label]) => pillarLine(name, label, stress.pillars[name], stress.rules)),
  ];
  if (stress.active < 3) {
    // The pillars already carry the snapshot's note; repeat it only when it says something else.
    const said = PILLARS.some(([name]) => stress.pillars[name] && stress.pillars[name].note === stress.note);
    lines.push(`${stress.note && !said ? `${stress.note} ` : ''}With fewer than three pillars read, the count can only understate stress.`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* /radar                                                              */
/* ------------------------------------------------------------------ */

/** "yield 4.9%, 15.0% below its 52-week high" (and the losing year, when there was one). */
function trapText(radar) {
  const reasons = [`yield ${pct(radar.dividendYield, 1)}`];
  if (number(radar.drawdown)) reasons.push(`${pct(Math.abs(radar.drawdown), 1)} below its 52-week high`);
  if (number(radar.yearReturn) && radar.yearReturn < 0) reasons.push(`1-year total return ${pct(radar.yearReturn, 1, { signed: true })}`);
  return reasons.join(', ');
}

const trapLine = (asset) => `${asset.ticker}: ${trapText(asset.radar)}`;

/** The whole radar: the regime, the tiers and the dividend traps (the caller adds the footer). */
export function radarLines(context) {
  const lines = [[bold('Decision Radar')]];
  if (!hasRadar(context)) return [...lines, NOT_YET];
  lines.push(...stressLines(context), '');
  const scored = context.assets.filter((asset) => asset.radar && asset.radar.tier);
  for (const [tier, title] of TIERS) {
    const members = scored.filter((asset) => asset.radar.tier === tier)
      .sort((a, b) => b.radar.score - a.radar.score || a.ticker.localeCompare(b.ticker));
    lines.push([bold(`${title} (${members.length})`)]);
    lines.push(members.length ? members.map((asset) => `${asset.ticker} ${asset.radar.score}/4${asset.radar.held ? ' (held)' : ''}`).join(' · ') : 'none');
  }
  const traps = scored.filter((asset) => asset.radar.dividendTrap);
  lines.push('', [bold(`Dividend traps (${traps.length})`)]);
  if (traps.length) lines.push(...traps.map(trapLine), 'A trap: a yield of 3% or more with a drawdown deeper than 2.5 × the yield, or a losing year. The yield may be high because the price fell.');
  else lines.push('None: no asset yielding 3% or more has a deep drawdown or a losing year.');
  lines.push(
    '',
    'Points: trend, strength against the benchmark over 3 months, momentum, and a drawdown under 12%, on total return. "(held)": scored 0-1 but not yet on three sessions running.',
    'Tiers describe the last year; they are not a forecast or a recommendation to buy or sell. /check <ticker> shows an asset\'s stops.',
  );
  return lines;
}

/* ------------------------------------------------------------------ */
/* An asset's radar, for /check and the digest                          */
/* ------------------------------------------------------------------ */

/** "initial −12.2% at SGD 58.04 · breakeven trigger +15.3% at 76.20 · then trail −14.1% (56.83 today)" */
export function stopText(stop, ccy, tick) {
  return `initial ${pct(stop.init, 1, { signed: true })} at ${ccy} ${tickPrice(stop.initPrice, tick)} · `
    + `breakeven trigger ${pct(stop.breakeven, 1, { signed: true })} at ${tickPrice(stop.breakevenPrice, tick)}, then raise the stop to the entry · `
    + `trail ${pct(stop.trail, 1, { signed: true })} below the highest close (${tickPrice(stop.trailPrice, tick)} today)`;
}

function warningLine(warning) {
  const days = `${warning.tradingDays} trading day${warning.tradingDays === 1 ? '' : 's'}`;
  if (warning.kind === 'ex-dividend') {
    const amount = number(warning.amount) ? ` (${warning.currency} ${Number(warning.amount.toFixed(4))})` : '';
    const drop = number(warning.drop) ? `the price drops about ${pct(warning.drop, 1)}${amount} at the open, mechanically, toward the stop` : 'the price drops by the dividend at the open';
    return `⚠ Ex-dividend ${warning.estimated ? '~' : ''}${longDate(warning.date)}${warning.estimated ? ' (estimated)' : ''}, in ${days}: ${drop}`;
  }
  if (warning.kind === 'earnings-gap') {
    const which = warning.horizons.map((entry) => entry.horizon);
    const named = which.length > 1 ? `${which.slice(0, -1).join(', ')} and ${which.at(-1)}` : which[0];
    const worst = number(warning.worstMove) ? `, worst ${pct(warning.worstMove, 1, { signed: true })}` : '';
    return `⚠ Earnings ~${longDate(warning.date)}, in ${days}: the typical earnings-day move ±${pct(warning.typicalMove, 1)}${worst} is larger than the ${named} stop${which.length > 1 ? 's' : ''}; a gap can open beyond it`;
  }
  return null;
}

/**
 * The radar part of an asset's card: the tier and score, the trap, the medium stop and the warnings.
 * @returns {{ lines: string[], gaps: Array<[string, string]> }} gaps: [label, reason] for the card's N/A list
 */
export function radarCard(asset, context) {
  const radar = asset.radar;
  if (!radar) return { lines: [], gaps: [] };
  if (typeof radar.na === 'string') return { lines: [], gaps: [['Decision Radar', radar.na]] };
  const lines = [];
  const gaps = [];
  const marks = POINTS.map((name) => `${name} ${radar.points && radar.points[name] ? '✓' : '✗'}`).join(' ');
  let versus = '';
  if (radar.vs === 'self') versus = ' · strength: its own 3-month return';
  else if (radar.vs) versus = ` · strength vs ${radar.vs}${radar.vsTotalReturn === false ? ', a price index' : ''}`;
  lines.push(`Decision Radar: ${radar.tier}${radar.held ? ' (held: not yet three weak sessions)' : ''}, score ${radar.score}/4 · ${marks}${versus}`);
  if (radar.dividendTrap) {
    lines.push(`⚠ Dividend trap: ${trapText(radar)}`);
  } else if (number(radar.dividendYield) && radar.dividendYield >= 0.03) {
    lines.push(`Dividend yield ${pct(radar.dividendYield, 1)}: no dividend trap`);
  }
  const stop = radar.stops ? radar.stops.medium : null;
  const stress = context.stress && context.stress.state ? ` · regime ${context.stress.state} ×${fixed(context.stress.multiplier, 2)}` : '';
  if (stop && typeof stop.na === 'string') gaps.push(['Medium stop', stop.na]);
  else if (stop) lines.push(`Medium stop, 3 to 6 months${stress}: ${stopText(stop, asset.ccy, radar.tick)}`);
  for (const warning of radar.warnings ?? []) {
    const line = warningLine(warning);
    if (line) lines.push(line);
  }
  return { lines, gaps };
}

/** "initial −12.2% at 58.04 · breakeven +15.3% at 76.20 · trail −14.0% (56.83 today)": the digest's short form. */
export function compactStop(stop, tick) {
  return `initial ${pct(stop.init, 1, { signed: true })} at ${tickPrice(stop.initPrice, tick)} · `
    + `breakeven ${pct(stop.breakeven, 1, { signed: true })} at ${tickPrice(stop.breakevenPrice, tick)} · `
    + `trail ${pct(stop.trail, 1, { signed: true })} (${tickPrice(stop.trailPrice, tick)} today)`;
}

/** Every asset's stops for all three horizons, one line each, for the digest (its glossary explains the stages). */
export function stopLines(context) {
  const lines = [];
  for (const asset of context.assets) {
    const radar = asset.radar;
    if (!radar || !radar.stops) continue;
    const parts = Object.keys(HORIZONS).map((horizon) => {
      const stop = radar.stops[horizon];
      return typeof stop.na === 'string' ? `${horizon}: N/A. ${stop.na}` : `${horizon}: ${compactStop(stop, radar.tick)}`;
    });
    lines.push(`${asset.ticker}, prices in ${asset.ccy}: ${parts.join(' | ')}`);
  }
  return lines;
}
