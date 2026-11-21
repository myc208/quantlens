/**
 * eventEngine.js: scheduled events that can move a price past a stop.
 *
 *   nextEarnings     days until the next earnings release, and whether it falls inside the
 *                    sizing horizon (21 trading days), each simulation horizon (21, 63 and 126
 *                    trading days) and the 30-calendar-day projection
 *   earningsMove     the typical earnings-day move, measured from this asset's own past
 *                    releases and closes: the median absolute reaction, with the worst one
 *   nextExDividend   the next ex-dividend date (Yahoo's, or estimated from the payment rhythm)
 *                    and the price drop it implies
 *   gapRisk          what the suggested position would lose if the price gapped down by the
 *                    worst earnings-day move on record, set against the planned amount at risk
 *
 * The reaction day depends on when the release came out (the pipeline classifies each one
 * against the exchange's own hours):
 *   before-open, during-session  close of the release day ÷ close of the session before
 *   after-close                  close of the next session ÷ close of the release day
 *   unknown                      close of the session after ÷ close of the session before
 *                                (two sessions, so the move is captured either way)
 */

import { isNum, safeDiv, percentile } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct,
} from '../core/derivationTracer.js';

export const EVENT_CONFIG = Object.freeze({
  sizingHorizon: 21,                       // trading days: the first simulation horizon
  simulationHorizons: Object.freeze([21, 63, 126]),
  forecastDays: 30,                        // calendar days, like the projection
  minEarningsSamples: 4,
  cadenceMinPayments: 3,
  cadenceGapDays: Object.freeze([20, 400]),
});

const DAY_MS = 86400000;

/** Median of the finite values, or null. */
function median(values) {
  const list = (Array.isArray(values) ? values : []).filter(isNum).sort((a, b) => a - b);
  return list.length ? percentile(list, 0.5) : null;
}
const TIMING_WORDS = Object.freeze({
  'before-open': 'before the open', 'during-session': 'during the session', 'after-close': 'after the close', unknown: 'time not known',
});

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function calendarDaysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/**
 * Sessions after `fromIso` up to and including `toIso`: weekdays for exchange-traded assets,
 * less the market's holidays when they are known (V3.2: from the macro calendar), and every
 * day for crypto. Without holidays the count can run a day or two long.
 * @param {Set<string>|null} [holidays] ISO dates on which the market is closed
 */
export function tradingDaysBetween(fromIso, toIso, assetClass = 'equity', holidays = null) {
  const total = calendarDaysBetween(fromIso, toIso);
  if (!(total > 0)) return 0;
  if (assetClass === 'crypto') return total;
  let count = 0;
  let time = Date.parse(`${fromIso}T00:00:00Z`);
  for (let i = 0; i < total; i += 1) {
    time += DAY_MS;
    const date = new Date(time);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6 && !(holidays && holidays.has(date.toISOString().slice(0, 10)))) count += 1;
  }
  return count;
}

function sessionsWording(asset, holidays) {
  if (asset.assetClass === 'crypto') return 'Sessions until the release (crypto trades every day)';
  return holidays && holidays.size ? 'Trading days until the release (weekdays, less market holidays from the macro calendar)' : 'Trading days until the release (weekdays; holidays not known)';
}

/** Index of the first date on or after `iso` (dates ascending), or -1. */
function firstOnOrAfter(dates, iso) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (dates[middle] < iso) low = middle + 1;
    else high = middle;
  }
  return low < dates.length ? low : -1;
}

/**
 * The price reaction to one earnings release, from a close series.
 * @returns {{ date:string, timing:string, move:number, baseDate:string, reactionDate:string } | null}
 */
export function earningsReaction(series, release) {
  if (!series || !Array.isArray(series.dates) || !release) return null;
  const { dates, close } = series;
  const index = firstOnOrAfter(dates, release.date);
  if (index < 1) return null;
  const onTheDay = dates[index] === release.date;
  let base;
  let reaction;
  if (release.timing === 'after-close') {
    base = onTheDay ? index : index - 1;
    reaction = base + 1;
  } else if (release.timing === 'unknown') {
    base = index - 1;
    reaction = onTheDay ? index + 1 : index;
  } else {
    base = index - 1;
    reaction = index;
  }
  if (reaction >= dates.length || base < 0 || !isNum(close[base]) || !isNum(close[reaction]) || close[base] <= 0) return null;
  return { date: release.date, timing: release.timing, move: close[reaction] / close[base] - 1, baseDate: dates[base], reactionDate: dates[reaction] };
}

/** The next ex-dividend date: Yahoo's when it lists a future one, otherwise estimated from the payment rhythm. */
export function nextExDividendDate(events, dividends, today) {
  if (events && events.nextExDividend && events.nextExDividend.date >= today) {
    return { date: events.nextExDividend.date, estimated: false, gapDays: null };
  }
  const dates = dividends && Array.isArray(dividends.dates) ? dividends.dates : [];
  if (dates.length < EVENT_CONFIG.cadenceMinPayments) return null;
  const recent = dates.slice(-9);
  const gaps = recent.slice(1).map((date, i) => calendarDaysBetween(recent[i], date));
  const gap = median(gaps);
  const [low, high] = EVENT_CONFIG.cadenceGapDays;
  if (!isNum(gap) || gap < low || gap > high) return null;
  let time = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + Math.round(gap) * DAY_MS;
  // A payment that should already have happened may simply be late in Yahoo's records: allow one step forward.
  for (let step = 0; step < 2 && new Date(time).toISOString().slice(0, 10) < today; step += 1) time += Math.round(gap) * DAY_MS;
  const date = new Date(time).toISOString().slice(0, 10);
  return date >= today ? { date, estimated: true, gapDays: Math.round(gap) } : null;
}

function horizonFlags(tradingDays, calendarDays) {
  return {
    insideSizing: tradingDays <= EVENT_CONFIG.sizingHorizon,
    insideSimulation: EVENT_CONFIG.simulationHorizons.map((horizon) => tradingDays <= horizon),
    insideForecast: calendarDays <= EVENT_CONFIG.forecastDays,
  };
}

function horizonSentence(flags) {
  const inside = [];
  if (flags.insideSizing) inside.push(`the ${EVENT_CONFIG.sizingHorizon}-day sizing horizon`);
  const simulations = EVENT_CONFIG.simulationHorizons.filter((_, i) => flags.insideSimulation[i]);
  if (simulations.length) inside.push(`the ${simulations.join(', ')}-day simulation${simulations.length > 1 ? 's' : ''}`);
  if (flags.insideForecast) inside.push(`the ${EVENT_CONFIG.forecastDays}-day projection`);
  return inside.length ? `inside ${inside.join(', ')}` : 'beyond every horizon used here';
}

function buildNextEarnings(asset, events, today, holidays = null) {
  const id = 'nextEarnings';
  const label = 'Next earnings';
  const formula = 'Days to release = release date − today; trading days count weekdays (crypto: every day)';
  if (!events || events.status === 'unavailable') {
    return notAvailable({ id, label, unit: 'days', formula, reason: (events && events.note) || 'No event calendar is available for this asset.' });
  }
  const next = events.nextEarnings;
  if (!next) return notAvailable({ id, label, unit: 'days', formula, reason: events.note || 'Yahoo lists no upcoming earnings date.' });
  if (next.date < today) {
    return notAvailable({ id, label, unit: 'days', formula, reason: `The stored date (${next.date}) has passed. The calendar refreshes on the next daily run.` });
  }
  const calendarDays = calendarDaysBetween(today, next.date);
  const tradingDays = tradingDaysBetween(today, next.date, asset.assetClass, holidays);
  const flags = horizonFlags(tradingDays, calendarDays);
  const window = next.dateTo ? `${next.date} or ${next.dateTo}` : next.date;
  return traced({
    id, label, value: calendarDays, unit: 'days', tone: flags.insideSizing ? 'caution' : 'neutral',
    meta: { date: next.date, dateTo: next.dateTo, timing: next.timing, calendarDays, tradingDays, ...flags, stale: events.status === 'stale' },
    formula,
    rawInputs: [
      input('Next earnings release', window, '', next.dateTo ? "Yahoo's two sources disagree; both dates are kept" : 'Yahoo calendar and earnings dates', events.fetchedAt ? events.fetchedAt.slice(0, 10) : null),
      input('Timing', TIMING_WORDS[next.timing] ?? next.timing, '', 'against the exchange\'s own hours'),
      input('Today', today, '', 'browser clock'),
    ],
    steps: [
      step('Calendar days until the release', `${next.date} − ${today}`, calendarDays),
      step(sessionsWording(asset, holidays), `count of sessions after ${today}`, tradingDays),
      step(`Inside the ${EVENT_CONFIG.sizingHorizon}-day sizing horizon?`, `${tradingDays} ≤ ${EVENT_CONFIG.sizingHorizon}`, flags.insideSizing ? 'yes' : 'no'),
      step(`Inside the ${EVENT_CONFIG.forecastDays}-day projection?`, `${calendarDays} ≤ ${EVENT_CONFIG.forecastDays}`, flags.insideForecast ? 'yes' : 'no'),
    ],
    interpretation: interpretation(
      `${asset.ticker} reports around ${window} (${calendarDays} days, about ${tradingDays} trading days away, ${TIMING_WORDS[next.timing] ?? 'time not known'}). That is ${horizonSentence(flags)}.`,
      [threshold(`Within ${EVENT_CONFIG.sizingHorizon} trading days`, 'A gap can jump the stop', 'caution'), threshold('Further out', 'Outside the sizing horizon', 'neutral')],
      `${events.status === 'stale' ? 'The calendar could not be refreshed in the latest run. ' : ''}Release dates are Yahoo's and can move, especially before the company confirms them. A stop-loss is an order, not a guarantee: if the price opens below it after a release, the loss is larger than planned.`,
    ),
    dependsOn: ['earningsMove'],
  });
}

function buildEarningsMove(asset, events) {
  const id = 'earningsMove';
  const label = 'Typical earnings-day move';
  const formula = 'Move = reaction close ÷ close before the release − 1; typical move = median of the absolute moves';
  if (!events || events.status === 'unavailable') {
    return notAvailable({ id, label, unit: 'pct', formula, reason: (events && events.note) || 'No event calendar is available for this asset.' });
  }
  const series = asset.longSeries ?? asset.series;
  const reactions = events.earnings.map((release) => earningsReaction(series, release)).filter(Boolean);
  if (reactions.length < EVENT_CONFIG.minEarningsSamples) {
    return notAvailable({
      id, label, unit: 'pct', formula, meta: { count: reactions.length },
      reason: `Only ${reactions.length} past release${reactions.length === 1 ? '' : 's'} fall${reactions.length === 1 ? 's' : ''} inside the stored price history; at least ${EVENT_CONFIG.minEarningsSamples} are needed for a typical move.`,
    });
  }
  const absolute = reactions.map((r) => Math.abs(r.move));
  const typical = median(absolute);
  const worst = reactions.reduce((low, r) => (r.move < low.move ? r : low));
  const best = reactions.reduce((high, r) => (r.move > high.move ? r : high));
  const daily = [];
  for (let i = 1; i < series.close.length; i += 1) daily.push(Math.abs(series.close[i] / series.close[i - 1] - 1));
  const normalDay = median(daily);
  const ratio = safeDiv(typical, normalDay);
  return traced({
    id, label, value: typical, unit: 'pct', tone: isNum(ratio) && ratio >= 3 ? 'caution' : 'neutral',
    meta: {
      count: reactions.length, typical, worst: worst.move, worstDate: worst.date, best: best.move, bestDate: best.date,
      normalDay, ratio, moves: reactions.map((r) => ({ date: r.date, timing: r.timing, move: r.move })),
    },
    formula,
    rawInputs: reactions.slice(0, 12).map((r) => input(`Release ${r.date} (${TIMING_WORDS[r.timing] ?? r.timing})`, r.move, 'fraction', `${r.baseDate} → ${r.reactionDate}`, r.reactionDate)),
    steps: [
      step('Pick the reaction session for each release from its timing', 'before the open or during the session: that day; after the close: the next day; time unknown: both', `${reactions.length} releases`),
      step('Median of the absolute moves', `median(|move|) over ${reactions.length} releases`, fmtPct(typical, 2)),
      step('Largest fall and largest rise', `${worst.date} and ${best.date}`, `${fmtPct(worst.move, 1)} | +${fmtPct(Math.max(0, best.move), 1)}`),
      step('Compare with an ordinary day (median absolute daily move)', `${fmtPct(typical, 2)} ÷ ${fmtPct(normalDay, 2)}`, isNum(ratio) ? `${fmtN(ratio, 1)}×` : 'N/A'),
    ],
    interpretation: interpretation(
      `On a typical earnings day ${asset.ticker} moves about ${fmtPct(typical, 1)} either way, ${isNum(ratio) ? `${fmtN(ratio, 1)} times an ordinary day` : 'unlike an ordinary day'}. The worst reaction in the stored history was ${fmtPct(worst.move, 1)} (${worst.date}).`,
      [threshold('Under 3× an ordinary day', 'Releases are usually absorbed', 'neutral'), threshold('3× or more', 'Releases are major price events', 'caution')],
      `Measured from ${reactions.length} releases and dividend-adjusted closes. Past reactions say how big surprises have been, not which way the next one will go.`,
    ),
  });
}

function buildNextExDividend(asset, events, dividends, today, holidays = null) {
  const id = 'nextExDividend';
  const label = 'Next ex-dividend date';
  const formula = 'Expected price drop ≈ last dividend ÷ last close; estimated date = last ex-date + median gap between payments';
  const next = nextExDividendDate(events, dividends, today);
  if (!next) {
    const reason = !dividends || dividends.dates.length === 0
      ? 'No dividend was paid in the stored five years.'
      : 'Yahoo lists no upcoming ex-dividend date, and the payment rhythm is too irregular to estimate one.';
    return notAvailable({ id, label, unit: 'days', formula, reason });
  }
  const amount = dividends && dividends.amounts.length ? dividends.amounts[dividends.amounts.length - 1] : null;
  const dropFraction = isNum(amount) ? safeDiv(amount, asset.quote.lastClose) : null;
  const calendarDays = calendarDaysBetween(today, next.date);
  const tradingDays = tradingDaysBetween(today, next.date, asset.assetClass, holidays);
  const flags = horizonFlags(tradingDays, calendarDays);
  return traced({
    id, label, value: calendarDays, unit: 'days', tone: 'neutral',
    meta: { date: next.date, estimated: next.estimated, gapDays: next.gapDays, amount, dropFraction, calendarDays, tradingDays, currency: asset.currency, ...flags },
    formula,
    rawInputs: [
      input(next.estimated ? 'Last ex-dividend date' : 'Next ex-dividend date', next.estimated ? dividends.dates[dividends.dates.length - 1] : next.date, '', next.estimated ? 'dividend history in the snapshot' : 'Yahoo calendar'),
      ...(next.estimated ? [input('Median gap between payments', next.gapDays, 'days', `last ${Math.min(9, dividends.dates.length)} payments`)] : []),
      input('Last dividend per share', amount, asset.currency, 'dividend history in the snapshot'),
      input('Last close', asset.quote.lastClose, asset.currency, 'snapshot', asset.quote.asOf),
    ],
    steps: [
      ...(next.estimated ? [step('Estimate the next ex-date from the usual gap', `${dividends.dates[dividends.dates.length - 1]} + ${next.gapDays} days`, next.date)] : []),
      step('Calendar days until then', `${next.date} − ${today}`, calendarDays),
      step('Expected price drop on the ex-date (assuming the same dividend)', isNum(amount) ? `${fmtN(amount, 4)} ÷ ${fmtN(asset.quote.lastClose)}` : 'no amount', isNum(dropFraction) ? fmtPct(dropFraction, 2) : 'N/A'),
    ],
    interpretation: interpretation(
      `${next.estimated ? 'Estimated' : 'Next'} ex-dividend date ${next.date} (${calendarDays} days away)${isNum(dropFraction) ? `: the price should open about ${fmtPct(dropFraction, 2)} lower that morning, all else equal` : ''}. It is ${horizonSentence(flags)}.`,
      [],
      `${next.estimated ? 'The date is an estimate from past payments, not an announcement. ' : ''}The drop is not a loss to a holder, who receives the dividend, but it can trigger a tight stop-loss.`,
    ),
  });
}

/**
 * Event metrics for one asset.
 * @param {object} asset normalised asset (events, dividends, longSeries, quote)
 * @param {{ now?: Date|string }} [options]
 */
export function analyzeEvents(asset, { now = new Date(), holidays = null } = {}) {
  const today = isoDay(now) ?? asset.quote.asOf;
  const events = asset.events ?? null;
  const dividends = asset.dividends ?? { dates: [], amounts: [] };
  return {
    ticker: asset.ticker,
    today,
    metrics: {
      nextEarnings: buildNextEarnings(asset, events, today, holidays),
      earningsMove: buildEarningsMove(asset, events),
      nextExDividend: buildNextExDividend(asset, events, dividends, today, holidays),
    },
  };
}

/**
 * What the suggested position would lose if the price gapped down by the worst
 * earnings-day move on record (an order cannot fill at a stop the price jumps over).
 * @param {{ sizing:object, events:object, accountCurrency:string }} args
 */
export function gapRisk({ sizing, events, accountCurrency }) {
  const id = 'gapRisk';
  const label = 'Loss in a gap like the worst earnings day';
  const formula = 'Gap loss = Position value × |worst earnings-day fall|, set against the amount at risk at the stop';
  const base = { id, label, unit: 'currency', formula, dependsOn: ['positionValue', 'earningsMove', 'nextEarnings', 'amountAtRisk'] };
  const summary = sizing && sizing.ok ? sizing.summary : null;
  if (!summary || !(summary.units > 0)) return notAvailable({ ...base, reason: 'There is no position to measure: the suggested size is zero or unavailable.' });
  const move = events ? events.metrics.earningsMove : null;
  if (!move || move.status !== 'ok') return notAvailable({ ...base, reason: move ? move.naReason : 'No earnings history is available.' });
  const worstFall = Math.min(0, move.meta.worst);
  if (worstFall === 0) return notAvailable({ ...base, reason: 'None of the past releases in the stored history was followed by a fall.' });
  const next = events.metrics.nextEarnings;
  const inside = next.status === 'ok' && next.meta.insideSizing;
  const value = summary.positionValue * -worstFall;
  const typicalLoss = summary.positionValue * move.value;
  const beyondStop = value > summary.amountAtRisk;
  return traced({
    ...base, value, tone: inside && beyondStop ? 'risky' : beyondStop ? 'caution' : 'neutral',
    meta: { currency: accountCurrency, worstFall, typicalLoss, amountAtRisk: summary.amountAtRisk, inside, beyondStop, nextDate: next.status === 'ok' ? next.meta.date : null },
    rawInputs: [
      input('Position value', summary.positionValue, accountCurrency, 'positionSizerEngine: positionValue'),
      input('Worst earnings-day fall on record', worstFall, 'fraction', `eventEngine: earningsMove (${move.meta.worstDate})`),
      input('Typical earnings-day move', move.value, 'fraction', 'eventEngine: earningsMove'),
      input('Amount at risk at the stop', summary.amountAtRisk, accountCurrency, 'positionSizerEngine: amountAtRisk'),
    ],
    steps: [
      step('Position value × the worst fall', `${fmtN(summary.positionValue, 2)} × ${fmtPct(-worstFall, 2)}`, value),
      step('Position value × a typical move', `${fmtN(summary.positionValue, 2)} × ${fmtPct(move.value, 2)}`, typicalLoss),
      step('Compare with the planned amount at risk', `${fmtN(value, 2)} vs ${fmtN(summary.amountAtRisk, 2)}`, beyondStop ? `${fmtN(value / summary.amountAtRisk, 1)}× the plan` : 'within the plan'),
    ],
    interpretation: interpretation(
      `${inside ? `Earnings fall inside the sizing horizon (${next.meta.date}). ` : ''}A gap like the worst one on record would cost about ${fmtN(value, 2)} ${accountCurrency}, ${beyondStop ? `${fmtN(value / summary.amountAtRisk, 1)} times the ${fmtN(summary.amountAtRisk, 2)} planned at the stop` : `within the ${fmtN(summary.amountAtRisk, 2)} planned at the stop`}.`,
      [threshold('Within the amount at risk', 'The stop still bounds the loss', 'neutral'), threshold('Beyond it, earnings ahead', 'Consider a smaller size or waiting', 'risky')],
      'The worst past reaction is not a ceiling: the next surprise can be larger. Gaps also happen without scheduled news.',
    ),
  });
}
