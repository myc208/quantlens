/**
 * radarEngine.js: the Decision Radar (V5.0). Health tiers on total return, a dividend-trap check,
 * and two-stage stops for three holding horizons. Every figure describes the past or sizes a
 * risk boundary from volatility; none predicts a return, and none is advice.
 *
 * Health score, 0 to 4, on dividend-adjusted closes (total return), one point each:
 *   trend        close above its 50-day average, and the 50-day above the 200-day
 *   strength     3-month total return ahead of its benchmark (VOO for US and London, the
 *                SPDR STI ETF ES3.SI for SGX, Bitcoin for crypto); the benchmark itself (VOO,
 *                Bitcoin) earns it with a positive 3-month total return
 *   momentum     a positive 1-month total return, or, for an income asset (trailing yield at
 *                least 3.5%), annualised EWMA volatility below 22%
 *   drawdown     less than 12% below its 52-week high
 * Tier: 3-4 Healthy, 2 Neutral, 0-1 Dead Money, but only when the score was 0-1 on each of the
 * last three sessions; otherwise it is held at Neutral (no state is stored: the three scores are
 * recomputed from the price history every time).
 *
 * Dividend trap: a trailing yield of at least 3%, with the price more than 2.5 times the yield
 * below its 52-week high, or a negative one-year total return.
 *
 * Stops, as fractions of the last close, from the daily EWMA volatility σ and the macro
 * regime's multiplier M (stressEngine.js), with the initial stop capped at 25%:
 *   short   initial −min(max(2.0 σ √5 M, 4%), 25%),  breakeven at +1.25×, trail 1.00× its distance
 *   medium  initial −min(max(2.0 σ √21 M, 7%), 25%), breakeven at +1.25×, trail 1.15×
 *   long    initial −min(max(2.5 σ √21 M, 12%), 25%), breakeven at +1.50×, trail 1.25×
 * Stage one is the initial stop. Once the price has risen by the breakeven distance, stage two
 * raises the stop to the entry price and then trails it the trail distance below the highest
 * close. Reference prices are at the last close, rounded to the exchange's tick: stops down,
 * the breakeven trigger up, so a rounded level is never tighter than the computed one.
 */

import { isNum, mean, logReturns, decimalsOf } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';
import { ewmaVariance, RISK_CONFIG } from './riskEngine.js';
import { relativeStrength } from './factorEngine.js';
import { tickSize } from './liquidityEngine.js';

export const RADAR_CONFIG = Object.freeze({
  smaFast: 50,
  smaSlow: 200,
  strengthDays: 91,          // calendar days, as the 3-month relative strength
  momentumDays: 30,          // calendar days, as the 1-month relative strength
  yearDays: 365,
  incomeYield: 0.035,
  incomeVolatility: 0.22,
  drawdownLimit: -0.12,
  hysteresisSessions: 3,
  trapYield: 0.03,
  trapMultiple: 2.5,
  exDividendDays: 10,        // trading days
  earningsDays: 15,          // trading days
  cap: 0.25,
  horizons: Object.freeze({
    short: Object.freeze({ id: 'stopShort', label: 'Short horizon (2 weeks to 1 month)', k: 2, days: 5, floor: 0.04, breakeven: 1.25, trail: 1 }),
    medium: Object.freeze({ id: 'stopMedium', label: 'Medium horizon (3 to 6 months)', k: 2, days: 21, floor: 0.07, breakeven: 1.25, trail: 1.15 }),
    long: Object.freeze({ id: 'stopLong', label: 'Long horizon (1 year or more)', k: 2.5, days: 21, floor: 0.12, breakeven: 1.5, trail: 1.25 }),
  }),
  benchmarks: Object.freeze({ US: 'VOO', UK: 'VOO', SG: 'ES3.SI', CRYPTO: 'BTC-USD' }),
  fallbackBenchmarks: Object.freeze({ SG: '^STI' }),
});

export const RADAR_TIERS = Object.freeze(['Healthy', 'Neutral', 'Dead Money']);
export const RADAR_HORIZONS = Object.freeze(['short', 'medium', 'long']);
export const RADAR_METRIC_IDS = Object.freeze(['healthScore', 'healthTier', 'trailingYield', 'dividendTrap', 'stopShort', 'stopMedium', 'stopLong']);

const DAY_MS = 86400000;
const TIER_TONES = Object.freeze({ Healthy: 'healthy', Neutral: 'neutral', 'Dead Money': 'caution' });
const BENCHMARK_NAMES = Object.freeze({ VOO: 'VOO (the S&P 500, total return)', 'ES3.SI': 'ES3.SI (the Straits Times Index, total return)', '^STI': '^STI (the Straits Times Index, price only)', 'BTC-USD': 'Bitcoin' });
const INDEX_REASON = 'Indices are not in the radar: they cannot be bought.';

const daysBefore = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

function closeOnOrBefore(series, isoDate, end = series.dates.length - 1) {
  let low = 0;
  let high = end;
  if (high < 0 || series.dates[0] > isoDate) return null;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (series.dates[middle] <= isoDate) low = middle;
    else high = middle - 1;
  }
  return isNum(series.close[low]) && series.close[low] > 0 ? { date: series.dates[low], close: series.close[low], index: low } : null;
}

/** The radar's benchmark for an asset: { ticker, series, totalReturn, fallback } | { self: true } | null. */
export function radarBenchmark(asset, { byTicker = {}, benchmarks = {} } = {}) {
  if (!asset || asset.assetClass === 'index') return null;
  const wanted = asset.assetClass === 'crypto' ? RADAR_CONFIG.benchmarks.CRYPTO : RADAR_CONFIG.benchmarks[asset.market];
  if (!wanted) return null;
  if (wanted === asset.ticker) return { self: true, ticker: wanted };
  const extra = benchmarks[wanted];
  if (extra && extra.series && extra.series.dates.length) return { ticker: wanted, name: BENCHMARK_NAMES[wanted] ?? wanted, series: extra.series, totalReturn: true, fallback: false };
  const listed = byTicker[wanted];
  if (listed) return { ticker: wanted, name: BENCHMARK_NAMES[wanted] ?? wanted, series: listed.longSeries ?? listed.series, totalReturn: true, fallback: false };
  const backup = RADAR_CONFIG.fallbackBenchmarks[asset.market];
  const index = backup ? byTicker[backup] : null;
  if (index) return { ticker: backup, name: BENCHMARK_NAMES[backup] ?? backup, series: index.longSeries ?? index.series, totalReturn: false, fallback: true };
  return null;
}

/** Dividends with an ex-date in the 365 days to `day`, over the close on that day. */
export function trailingYield(dividends, day, close) {
  if (!isNum(close) || close <= 0) return { value: null, total: null, payments: 0 };
  const from = daysBefore(day, RADAR_CONFIG.yearDays);
  let total = 0;
  let payments = 0;
  const dates = dividends && Array.isArray(dividends.dates) ? dividends.dates : [];
  dates.forEach((exDate, i) => {
    if (exDate > from && exDate <= day && isNum(dividends.amounts[i])) {
      total += dividends.amounts[i];
      payments += 1;
    }
  });
  return { value: total / close, total, payments, from };
}

/** Annualised and daily EWMA volatility over `window` closes ending at `end` (the risk engine's recursion). */
function ewmaAt(asset, closes, end, window) {
  const start = Math.max(0, end - window + 1);
  const returns = logReturns(closes.slice(start, end + 1));
  if (!returns || returns.length < RISK_CONFIG.minEwmaReturns) return null;
  const ewma = ewmaVariance(returns);
  if (!ewma) return null;
  const daily = Math.sqrt(ewma.next);
  const periods = RISK_CONFIG.annualisation[asset.assetClass] ?? RISK_CONFIG.annualisation.equity;
  return { daily, annual: daily * Math.sqrt(periods), periods, returns: returns.length };
}

/**
 * The four points of the health score on the session at index `end` of the long (adjusted) series.
 * @returns {object|null} null when the history is too short for a 200-day average
 */
export function scoreSession(asset, series, end, { benchmark = null, window = 252 } = {}) {
  if (!series || end < RADAR_CONFIG.smaSlow - 1 || end >= series.dates.length) return null;
  const closes = series.close;
  const day = series.dates[end];
  const close = closes[end];
  const fast = mean(closes.slice(end - RADAR_CONFIG.smaFast + 1, end + 1));
  const slow = mean(closes.slice(end - RADAR_CONFIG.smaSlow + 1, end + 1));
  if (!isNum(close) || !isNum(fast) || !isNum(slow)) return null;
  const trend = close > fast && fast > slow;

  let strength = null;
  let ownReturn = null;
  const self = Boolean(benchmark && benchmark.self);
  if (self) {
    const start = closeOnOrBefore(series, daysBefore(day, RADAR_CONFIG.strengthDays), end);
    ownReturn = start && start.index < end ? close / start.close - 1 : null;
  } else if (benchmark) {
    strength = relativeStrength({ dates: series.dates.slice(0, end + 1), close: closes.slice(0, end + 1) }, benchmark.series, RADAR_CONFIG.strengthDays);
  }
  const ahead = self ? isNum(ownReturn) && ownReturn > 0 : Boolean(strength && isNum(strength.value) && strength.value > 0);

  const monthStart = closeOnOrBefore(series, daysBefore(day, RADAR_CONFIG.momentumDays), end);
  const monthReturn = monthStart && monthStart.index < end ? close / monthStart.close - 1 : null;
  const yieldNow = trailingYield(asset.dividends, day, close);
  const volatility = ewmaAt(asset, closes, end, window);
  const income = isNum(yieldNow.value) && yieldNow.value >= RADAR_CONFIG.incomeYield;
  const steady = income && volatility !== null && volatility.annual < RADAR_CONFIG.incomeVolatility;
  const momentum = (isNum(monthReturn) && monthReturn > 0) || steady;

  const yearFrom = daysBefore(day, RADAR_CONFIG.yearDays);
  let high = close;
  let highDate = day;
  for (let i = end; i >= 0 && series.dates[i] > yearFrom; i -= 1) {
    if (closes[i] > high) {
      high = closes[i];
      highDate = series.dates[i];
    }
  }
  const drawdown = close / high - 1;
  const contained = drawdown > RADAR_CONFIG.drawdownLimit;
  const yearStart = closeOnOrBefore(series, yearFrom, end);
  const yearReturn = yearStart && yearStart.index < end ? close / yearStart.close - 1 : null;

  return {
    date: day, close, fast, slow, trend, strength, self, ownReturn, ahead, monthReturn, monthFrom: monthStart ? monthStart.date : null,
    dividendYield: yieldNow, volatility, income, steady, momentum, high, highDate, drawdown, contained, yearReturn,
    yearFrom: yearStart ? yearStart.date : null,
    score: Number(trend) + Number(ahead) + Number(momentum) + Number(contained),
  };
}

/** Tier from the scores of the latest sessions, newest first: Dead Money needs 0-1 on all three. */
export function healthTier(scores) {
  const latest = scores[0];
  if (!isNum(latest)) return { tier: null, held: false };
  if (latest >= 3) return { tier: 'Healthy', held: false };
  if (latest === 2) return { tier: 'Neutral', held: false };
  const confirmed = scores.length >= RADAR_CONFIG.hysteresisSessions
    && scores.slice(0, RADAR_CONFIG.hysteresisSessions).every((score) => isNum(score) && score <= 1);
  return confirmed ? { tier: 'Dead Money', held: false } : { tier: 'Neutral', held: true };
}

/** Dividend trap: a yield of 3% or more with a deep drawdown or a losing year. */
export function dividendTrap({ dividendYield, drawdown, yearReturn }) {
  const eligible = isNum(dividendYield) && dividendYield >= RADAR_CONFIG.trapYield;
  const deep = eligible && isNum(drawdown) && Math.abs(drawdown) > RADAR_CONFIG.trapMultiple * dividendYield;
  const losing = eligible && isNum(yearReturn) && yearReturn < 0;
  return { trap: deep || losing, eligible, deep, losing };
}

/** One horizon's stop distances, as fractions of the last close. */
export function horizonStop(horizon, sigmaDaily, multiplier) {
  const spec = RADAR_CONFIG.horizons[horizon];
  const raw = spec.k * sigmaDaily * Math.sqrt(spec.days) * multiplier;
  const distance = Math.min(Math.max(raw, spec.floor), RADAR_CONFIG.cap);
  return {
    horizon, raw, distance, floored: raw < spec.floor, capped: raw > RADAR_CONFIG.cap,
    initPct: -distance, breakevenPct: spec.breakeven * distance, trailPct: -spec.trail * distance,
  };
}

/** A price rounded to a step: 'down' for stops, 'up' for the breakeven trigger. */
export function roundToTick(price, tick, direction) {
  if (!isNum(price) || !isNum(tick) || tick <= 0) return null;
  const steps = price / tick;
  const count = direction === 'up' ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Number((count * tick).toFixed(decimalsOf(tick)));
}

/** The exchange's tick at a price, or a cent (a hundredth of a cent below 1) where no tick is modelled. */
export function priceStep(asset, price) {
  const tick = tickSize(asset, price);
  if (isNum(tick)) return { tick, modelled: true };
  return { tick: isNum(price) && price < 1 ? 0.0001 : 0.01, modelled: false };
}

/** The three reference prices of a stop at the last close. */
export function stopPrices(asset, close, stop) {
  const at = (fraction, direction) => {
    const target = close * (1 + fraction);
    const { tick, modelled } = priceStep(asset, target);
    return { price: roundToTick(target, tick, direction), target, tick, modelled };
  };
  return { init: at(stop.initPct, 'down'), breakeven: at(stop.breakevenPct, 'up'), trail: at(stop.trailPct, 'down') };
}

/** Ex-dividend and earnings-gap warnings, from the event engine's metrics. */
export function radarWarnings(asset, events, stops) {
  const warnings = [];
  const exDividend = events ? events.nextExDividend : null;
  if (exDividend && exDividend.status === 'ok' && isNum(exDividend.meta.tradingDays) && exDividend.meta.tradingDays <= RADAR_CONFIG.exDividendDays) {
    warnings.push({
      kind: 'ex-dividend', date: exDividend.meta.date, tradingDays: exDividend.meta.tradingDays, estimated: Boolean(exDividend.meta.estimated),
      amount: isNum(exDividend.meta.amount) ? exDividend.meta.amount : null, drop: isNum(exDividend.meta.dropFraction) ? exDividend.meta.dropFraction : null,
      currency: asset.currency,
    });
  }
  const earnings = events ? events.nextEarnings : null;
  const move = events ? events.earningsMove : null;
  if (earnings && earnings.status === 'ok' && isNum(earnings.meta.tradingDays) && earnings.meta.tradingDays <= RADAR_CONFIG.earningsDays
      && move && move.status === 'ok' && isNum(move.value)) {
    const horizons = RADAR_HORIZONS.filter((horizon) => stops[horizon] && move.value > stops[horizon].distance);
    if (horizons.length) {
      warnings.push({
        kind: 'earnings-gap', date: earnings.meta.date, tradingDays: earnings.meta.tradingDays,
        typicalMove: move.value, worstMove: isNum(move.meta.worst) ? move.meta.worst : null,
        horizons: horizons.map((horizon) => ({ horizon, stop: stops[horizon].initPct })),
      });
    }
  }
  return warnings;
}

function allUnavailable(reason) {
  const metrics = {};
  const units = { healthScore: 'score', healthTier: 'label', trailingYield: 'pct', dividendTrap: 'label', stopShort: 'pct', stopMedium: 'pct', stopLong: 'pct' };
  const labels = {
    healthScore: 'Health score (0-4)', healthTier: 'Health tier', trailingYield: 'Trailing dividend yield', dividendTrap: 'Dividend trap',
    stopShort: RADAR_CONFIG.horizons.short.label, stopMedium: RADAR_CONFIG.horizons.medium.label, stopLong: RADAR_CONFIG.horizons.long.label,
  };
  for (const id of RADAR_METRIC_IDS) metrics[id] = notAvailable({ id, label: labels[id], unit: units[id], formula: 'Decision Radar', reason });
  return metrics;
}

const yesNo = (flag) => (flag ? '+1' : '0');

/**
 * The Decision Radar of one normalised asset.
 * @param {object} asset normalised asset (longSeries: adjusted closes; series: the last year)
 * @param {object} context
 * @param {object|null} context.benchmark from radarBenchmark()
 * @param {object} context.stress from analyzeStress(): its multiplier and state
 * @param {object|null} [context.events] the event engine's metrics (nextExDividend, nextEarnings, earningsMove)
 */
export function analyzeRadar(asset, { benchmark = null, stress = null, events = null } = {}) {
  const empty = (reason) => ({ ticker: asset.ticker, metrics: allUnavailable(reason), warnings: [], scores: [], benchmark: null });
  if (asset.assetClass === 'index') return empty(INDEX_REASON);
  const series = asset.longSeries;
  const last = series ? series.dates.length - 1 : -1;
  const window = asset.series && Array.isArray(asset.series.close) ? asset.series.close.length : 252;
  const sessions = [];
  for (let back = 0; back < RADAR_CONFIG.hysteresisSessions; back += 1) {
    const scored = scoreSession(asset, series, last - back, { benchmark, window });
    if (scored) sessions.push(scored);
  }
  if (!sessions.length) return empty(`At least ${RADAR_CONFIG.smaSlow} daily closes are needed for the 200-day average.`);
  const now = sessions[0];
  const scores = sessions.map((session) => session.score);
  const { tier, held } = healthTier(scores);
  const asOf = now.date;
  const benchmarkText = benchmark ? (benchmark.self ? `${asset.ticker} is its own benchmark` : benchmark.name) : 'no benchmark';
  const metrics = {};
  const strengthValue = now.strength ? now.strength.value : null;

  metrics.healthScore = traced({
    id: 'healthScore', label: 'Health score (0-4)', value: now.score, unit: 'score', tone: now.score >= 3 ? 'healthy' : now.score === 2 ? 'neutral' : 'caution',
    meta: {
      score: now.score, scores, asOf, points: { trend: now.trend, strength: now.ahead, momentum: now.momentum, drawdown: now.contained },
      benchmark: benchmark && !benchmark.self ? benchmark.ticker : null, benchmarkFallback: Boolean(benchmark && benchmark.fallback), selfBenchmark: now.self,
      close: now.close, sma50: now.fast, sma200: now.slow, strength3m: strengthValue, ownReturn3m: now.ownReturn, monthReturn: now.monthReturn,
      ewmaVolatility: now.volatility ? now.volatility.annual : null, dividendYield: now.dividendYield.value, drawdown: now.drawdown, high52w: now.high,
    },
    formula: 'Score = trend + strength + momentum + drawdown, one point each, on dividend-adjusted closes',
    rawInputs: [
      input('Dividend-adjusted closes', series.dates.length, 'sessions', 'snapshot history and candles', asOf),
      input('Benchmark', benchmark && !benchmark.self ? benchmark.ticker : 'none', '', benchmarkText, benchmark && benchmark.series ? benchmark.series.dates[benchmark.series.dates.length - 1] : null),
      input('Trailing dividend yield', now.dividendYield.value, 'fraction', `${now.dividendYield.payments} payment(s) in 365 days`, asOf),
    ],
    steps: [
      step('Trend: close above the 50-day average, and the 50-day above the 200-day', `${fmtN(now.close)} vs ${fmtN(now.fast)} vs ${fmtN(now.slow)}`, yesNo(now.trend)),
      now.self
        ? step(`Strength: ${asset.ticker} is its own benchmark, so a positive 3-month total return`, isNum(now.ownReturn) ? `${fmtPct(now.ownReturn, 2)} vs 0` : 'not measurable', yesNo(now.ahead))
        : step(`Strength: 3-month total return ahead of ${benchmark ? benchmark.ticker : 'a benchmark'}`, isNum(strengthValue) ? `RS ${fmtPct(strengthValue, 2)} vs 0` : 'not measurable', yesNo(now.ahead)),
      step(now.income ? 'Momentum: a positive 1-month total return, or EWMA volatility below 22% (an income asset, yield of 3.5% or more)' : 'Momentum: a positive 1-month total return',
        `${isNum(now.monthReturn) ? fmtPct(now.monthReturn, 2) : 'N/A'}${now.income ? `; volatility ${now.volatility ? fmtPct(now.volatility.annual, 1) : 'N/A'}` : ''}`, yesNo(now.momentum)),
      step('Drawdown: less than 12% below the 52-week high', `${fmtN(now.close)} ÷ ${fmtN(now.high)} − 1 = ${fmtPct(now.drawdown, 2)}`, yesNo(now.contained)),
      step('Add the points', `${Number(now.trend)} + ${Number(now.ahead)} + ${Number(now.momentum)} + ${Number(now.contained)}`, now.score),
      step('The same score on the two sessions before', sessions.slice(1).map((session) => `${session.date}: ${session.score}`).join(' · ') || 'not available', scores.slice(1).join(', ') || 'N/A'),
    ],
    interpretation: interpretation(
      `${now.score} of 4 on ${asOf}: ${[now.trend && 'in a trend', now.ahead && (now.self ? 'up over 3 months' : `ahead of ${benchmark ? benchmark.ticker : 'its benchmark'}`), now.momentum && (now.steady && !(now.monthReturn > 0) ? 'a steady income asset' : 'up over the month'), now.contained && 'near its high'].filter(Boolean).join(', ') || 'no point earned'}.`,
      [threshold('3-4', 'Healthy', 'healthy'), threshold('2', 'Neutral', 'neutral'), threshold('0-1 on three sessions in a row', 'Dead Money', 'caution')],
      `A description of the last year on total return, not a forecast: the trend-regime research found that price-based readouts did not predict 21- or 63-day returns on this watchlist.${benchmark && benchmark.fallback ? ' ES3.SI was not in this snapshot, so strength is measured against ^STI, a price index without dividends: dividend payers look slightly stronger than they are.' : ''}`,
    ),
  });

  metrics.healthTier = traced({
    id: 'healthTier', label: 'Health tier', value: tier, unit: 'label', tone: TIER_TONES[tier] ?? null,
    meta: { tier, held, scores, asOf },
    formula: 'Healthy = 3-4; Neutral = 2; Dead Money = 0-1 on each of the last three sessions, otherwise held at Neutral',
    rawInputs: sessions.map((session) => input(`Score on ${session.date}`, session.score, 'points', 'health score', session.date)),
    steps: [
      step('Latest score', `${now.score} of 4`, now.score),
      ...(now.score <= 1 ? [step('Dead Money needs 0-1 on all of the last three sessions', scores.join(', '), held ? 'not all three: held at Neutral' : 'all three')] : []),
      step('Tier', `${now.score} → ${tier}`, tier),
    ],
    interpretation: interpretation(
      held ? `Scored ${now.score}, but not on three sessions in a row, so it is held at Neutral to avoid a one-day flip.` : `${tier}: ${{ Healthy: 'trend, strength and momentum mostly in its favour', Neutral: 'a mixed picture', 'Dead Money': 'weak on trend, strength, momentum and drawdown for three sessions running' }[tier]}.`,
      [threshold('Healthy', '3-4 points', 'healthy'), threshold('Neutral', '2 points, or 0-1 not yet confirmed', 'neutral'), threshold('Dead Money', '0-1 on three sessions in a row', 'caution')],
      'A health tier describes how the holding has behaved; it is not a recommendation to buy, keep or sell.',
    ),
    dependsOn: ['healthScore'],
  });

  const yieldNow = now.dividendYield;
  metrics.trailingYield = traced({
    id: 'trailingYield', label: 'Trailing dividend yield', value: yieldNow.value, unit: 'pct', tone: 'neutral',
    meta: { total: yieldNow.total, payments: yieldNow.payments, from: yieldNow.from, to: asOf, close: now.close, currency: asset.currency },
    formula: 'Yield = dividends with an ex-date in the last 365 days ÷ the last close',
    rawInputs: [input('Dividends in 365 days', yieldNow.total, asset.currency, `${yieldNow.payments} payment(s), dividend history in the snapshot`, asOf), input('Last close', now.close, asset.currency, 'adjusted close', asOf)],
    steps: [step('Divide', `${fmtN(yieldNow.total, 4)} ÷ ${fmtN(now.close)}`, fmtPct(yieldNow.value, 2))],
    interpretation: interpretation(`${fmtPct(yieldNow.value, 2)} paid out over the last year, at the last close.`, [threshold('3.5% or more', 'An income asset for the momentum point', 'neutral'), threshold('3% or more', 'Checked for a dividend trap', 'neutral')], 'Past payments: a dividend can be cut.'),
  });

  const trap = dividendTrap({ dividendYield: yieldNow.value, drawdown: now.drawdown, yearReturn: now.yearReturn });
  metrics.dividendTrap = traced({
    id: 'dividendTrap', label: 'Dividend trap', value: trap.trap ? 'Dividend trap' : trap.eligible ? 'No trap' : 'Not applicable', unit: 'label',
    tone: trap.trap ? 'risky' : 'neutral',
    meta: { ...trap, dividendYield: yieldNow.value, drawdown: now.drawdown, yearReturn: now.yearReturn, yearFrom: now.yearFrom },
    formula: 'Trap = yield ≥ 3% and (drawdown from the 52-week high deeper than 2.5 × yield, or 1-year total return < 0)',
    rawInputs: [input('Trailing yield', yieldNow.value, 'fraction', 'trailingYield', asOf), input('Drawdown from the 52-week high', now.drawdown, 'fraction', `high ${fmtN(now.high)} on ${now.highDate}`, asOf), input('1-year total return', now.yearReturn, 'fraction', now.yearFrom ? `from ${now.yearFrom}` : 'not enough history', asOf)],
    steps: [
      step('Yield of 3% or more?', fmtPct(yieldNow.value, 2), trap.eligible ? 'yes' : 'no: not checked'),
      ...(trap.eligible ? [
        step('Drawdown deeper than 2.5 × yield?', `${fmtPct(Math.abs(now.drawdown), 2)} vs ${fmtPct(RADAR_CONFIG.trapMultiple * yieldNow.value, 2)}`, trap.deep ? 'yes' : 'no'),
        step('1-year total return below zero?', isNum(now.yearReturn) ? fmtPct(now.yearReturn, 2) : 'N/A', trap.losing ? 'yes' : 'no'),
      ] : []),
    ],
    interpretation: interpretation(
      trap.trap ? `A high yield with ${trap.deep ? 'a price far below its high' : 'a losing year'}: the yield may be high because the price fell, not because the payout grew.` : trap.eligible ? 'A high yield without a deep drawdown or a losing year.' : 'The yield is below 3%, so the check does not apply.',
      [threshold('Yield ≥ 3% with a deep drawdown or a losing year', 'Dividend trap', 'risky'), threshold('Otherwise', 'No trap', 'neutral')],
      'A screen for a yield inflated by a falling price, not a verdict on the payout.',
    ),
    dependsOn: ['trailingYield'],
  });

  const volatility = ewmaAt(asset, series.close, last, window);
  const multiplier = stress && isNum(stress.multiplier) ? stress.multiplier : 1;
  const state = stress && stress.state ? stress.state : 'not read';
  const close = isNum(asset.quote && asset.quote.lastClose) ? asset.quote.lastClose : now.close;
  const stops = {};
  for (const horizon of RADAR_HORIZONS) {
    const spec = RADAR_CONFIG.horizons[horizon];
    if (!volatility) {
      metrics[spec.id] = notAvailable({ id: spec.id, label: spec.label, unit: 'pct', formula: 'Decision Radar stop', reason: `At least ${RISK_CONFIG.minEwmaReturns} daily returns are needed for the EWMA volatility.` });
      continue;
    }
    const stop = horizonStop(horizon, volatility.daily, multiplier);
    const prices = stopPrices(asset, close, stop);
    stops[horizon] = stop;
    const formula = `Initial = −min(max(${spec.k} × σ × √${spec.days} × M, ${fmtPct(spec.floor, 0)}), ${fmtPct(RADAR_CONFIG.cap, 0)}); breakeven at +${spec.breakeven} ×; trail ${spec.trail} × the initial distance`;
    metrics[spec.id] = traced({
      id: spec.id, label: spec.label, value: stop.initPct, unit: 'pct', tone: 'neutral',
      meta: {
        horizon, initPct: stop.initPct, breakevenPct: stop.breakevenPct, trailPct: stop.trailPct, raw: stop.raw, floored: stop.floored, capped: stop.capped,
        initPrice: prices.init.price, breakevenPrice: prices.breakeven.price, trailPrice: prices.trail.price,
        tick: prices.init.tick, tickModelled: prices.init.modelled, close, currency: asset.currency,
        sigmaDaily: volatility.daily, multiplier, state, asOf,
      },
      formula,
      rawInputs: [
        input('Daily EWMA volatility σ', volatility.daily, 'fraction', `${volatility.returns} daily log returns, λ ${RISK_CONFIG.lambda}`, asOf),
        input('Macro regime multiplier M', multiplier, '×', `macro regime: ${state}`, stress && stress.asOf ? stress.asOf : null),
        input('Last close', close, asset.currency, 'snapshot quote', asset.quote ? asset.quote.asOf : asOf),
        input('Price step', prices.init.tick, asset.currency, prices.init.modelled ? 'the exchange tick at the stop price' : 'no exchange tick modelled: rounded to this step', null),
      ],
      steps: [
        step('Volatility over the horizon, widened by the regime', `${spec.k} × ${fmtPct(volatility.daily, 3)} × √${spec.days} × ${fmtN(multiplier, 2)}`, fmtPct(stop.raw, 2)),
        step(`At least ${fmtPct(spec.floor, 0)}, at most ${fmtPct(RADAR_CONFIG.cap, 0)}`, `min(max(${fmtPct(stop.raw, 2)}, ${fmtPct(spec.floor, 0)}), ${fmtPct(RADAR_CONFIG.cap, 0)})`, fmtPct(stop.distance, 2)),
        step('Stage 1, the initial stop: below the last close, rounded down', `${fmtN(close)} × (1 − ${fmtPct(stop.distance, 2)})`, fmtN(prices.init.price, decimalsOf(prices.init.tick))),
        step(`Breakeven trigger: +${spec.breakeven} × the distance, rounded up`, `${fmtN(close)} × (1 + ${fmtPct(stop.breakevenPct, 2)})`, fmtN(prices.breakeven.price, decimalsOf(prices.breakeven.tick))),
        step(`Stage 2, the trail: ${spec.trail} × the distance below the highest close`, `${fmtN(close)} × (1 − ${fmtPct(Math.abs(stop.trailPct), 2)}) at today's close`, fmtN(prices.trail.price, decimalsOf(prices.trail.tick))),
      ],
      interpretation: interpretation(
        `For a ${horizon} hold from the last close: an initial stop ${fmtPct(stop.distance, 1)} below (${fmtN(prices.init.price, decimalsOf(prices.init.tick))} ${asset.currency}); after a rise of ${fmtPct(stop.breakevenPct, 1)} (${fmtN(prices.breakeven.price, decimalsOf(prices.breakeven.tick))}), move it to the entry price and trail it ${fmtPct(Math.abs(stop.trailPct), 1)} below the highest close.${stop.floored ? ` The volatility distance was below the ${fmtPct(spec.floor, 0)} floor.` : ''}${stop.capped ? ` The volatility distance was above the ${fmtPct(RADAR_CONFIG.cap, 0)} cap.` : ''}`,
        [threshold(`${fmtPct(spec.floor, 0)} floor`, 'the least room for normal noise', 'neutral'), threshold(`${fmtPct(RADAR_CONFIG.cap, 0)} cap`, 'the most an initial stop allows', 'neutral')],
        'A deterministic risk boundary sized from volatility, not a prediction or advice. A gap (earnings, ex-dividend, news) can open beyond any stop, and an order may fill below it.',
      ),
      dependsOn: ['macroStress'],
    });
  }
  const warnings = radarWarnings(asset, events, stops);
  return {
    ticker: asset.ticker, asOf, metrics, warnings, scores, benchmark: benchmark && !benchmark.self ? benchmark.ticker : null,
    benchmarkFallback: Boolean(benchmark && benchmark.fallback), selfBenchmark: Boolean(benchmark && benchmark.self),
  };
}
