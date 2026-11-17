/**
 * monteCarloEngine.js: a seeded price-path simulation for the risk sandbox.
 *
 * Model: geometric Brownian motion on daily steps.
 *
 *   Sₜ₊₁ = Sₜ × exp(d + σ × Z),   Z ~ N(0, 1)
 *
 *   σ  daily volatility: sample standard deviation of 1-year daily log returns
 *   d  daily log drift
 *        default ("zero drift"):  d = −σ² ÷ 2   so the EXPECTED price stays at
 *                                 today's price. One year of returns is far too
 *                                 noisy to extrapolate a trend from.
 *        Pro option (historical): d = mean daily log return of the past year
 *
 * 1,000 paths by default, horizons of 21, 63 and 126 trading days. The random
 * generator is seeded from the ticker and the snapshot date, so the same data
 * always produces the same fan and every number can be reproduced.
 *
 * Stop and target hits are checked on daily closes only.
 */

import {
  isNum, logReturns, mean, stdev, percentile, safeDiv,
} from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct,
} from '../core/derivationTracer.js';

export const MC_CONFIG = Object.freeze({
  paths: 1000,
  horizons: Object.freeze([21, 63, 126]),
  minReturns: 15, // enough for a 1-month window; the trace says when the estimate is rough
  annualisation: Object.freeze({ equity: 252, crypto: 365 }),
});

const Z_95 = 1.6448536269514722;

/** Small, fast, well-distributed 32-bit PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to an unsigned 32-bit seed. */
export function seedFromString(text) {
  let hash = 2166136261;
  const source = String(text);
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Standard normal sampler (Box–Muller) on top of a uniform generator. */
export function createNormalSampler(uniform) {
  let spare = null;
  return function nextNormal() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    while (u <= 1e-12) u = uniform();
    const v = uniform();
    const radius = Math.sqrt(-2 * Math.log(u));
    spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  };
}

/** Daily volatility and mean log return from a close series, or null. */
export function estimateDailyParams(closes) {
  const returns = logReturns(closes);
  if (!returns || returns.length < MC_CONFIG.minReturns) return null;
  const sigma = stdev(returns);
  const meanLogReturn = mean(returns);
  if (!isNum(sigma) || !isNum(meanLogReturn) || sigma <= 0) return null;
  return { sigma, meanLogReturn, observations: returns.length };
}

function unavailable(asset, reason) {
  return {
    ticker: asset.ticker,
    ok: false,
    metrics: {
      monteCarlo: notAvailable({ id: 'monteCarlo', label: 'Simulated price range', unit: 'currency', formula: 'Sₜ₊₁ = Sₜ × exp(d + σ × Z)', reason }),
      probStopFirst: notAvailable({ id: 'probStopFirst', label: 'Chance the stop is hit first', unit: 'pct', formula: 'paths that reach the stop before the target ÷ all paths', reason }),
    },
    fan: null,
    horizons: [],
    outcomes: null,
    params: null,
  };
}

/**
 * Run the simulation for one asset.
 *
 * @param {object} args
 * @param {object} args.asset normalised asset
 * @param {number} args.startPrice price to start from, in the asset's currency
 * @param {number|null} [args.stop] stop-loss level (optional)
 * @param {number|null} [args.target] target level (optional)
 * @param {boolean} [args.useHistoricalDrift] false = zero drift (default)
 * @param {number} [args.paths]
 * @param {number[]} [args.horizons] ascending day counts
 * @param {number} [args.seed] override the deterministic seed
 * @param {string} [args.historyLabel] the period the closes cover ("year", "3 months"), for the explanation
 * @returns {{ ticker, ok, metrics, fan, horizons, outcomes, params }}
 *   fan = { days, p05, p25, p50, p75, p95 } with one entry per day from 0 to the longest horizon
 */
export function runMonteCarlo({
  asset, startPrice, stop = null, target = null, useHistoricalDrift = false,
  paths = MC_CONFIG.paths, horizons = MC_CONFIG.horizons, seed, historyLabel = 'year',
}) {
  if (!isNum(startPrice) || startPrice <= 0) return unavailable(asset, 'No valid starting price is available.');
  const pathCount = Number.isInteger(paths) ? Math.min(20000, Math.max(100, paths)) : MC_CONFIG.paths;
  const horizonList = [...new Set((Array.isArray(horizons) ? horizons : []).filter((h) => Number.isInteger(h) && h > 0 && h <= 756))].sort((a, b) => a - b);
  if (horizonList.length === 0) return unavailable(asset, 'No valid simulation horizon was supplied.');
  const params = estimateDailyParams(asset.series.close);
  if (!params) {
    return unavailable(asset, `At least ${MC_CONFIG.minReturns} daily returns with some movement are needed to estimate volatility.`);
  }

  const { sigma, meanLogReturn, observations } = params;
  const drift = useHistoricalDrift ? meanLogReturn : -(sigma * sigma) / 2;
  const maxDays = horizonList[horizonList.length - 1];
  const usedSeed = Number.isInteger(seed) ? seed >>> 0 : seedFromString(`${asset.ticker}|${asset.quote.asOf}`);
  const normal = createNormalSampler(mulberry32(usedSeed));
  const currency = asset.currency;
  const periods = MC_CONFIG.annualisation[asset.assetClass] ?? MC_CONFIG.annualisation.equity;

  const hasLevels = isNum(stop) && isNum(target) && stop > 0 && stop < startPrice && target > startPrice;
  const byDay = Array.from({ length: maxDays + 1 }, () => new Float64Array(pathCount));
  let stopFirst = 0;
  let targetFirst = 0;
  for (let p = 0; p < pathCount; p += 1) {
    let price = startPrice;
    let outcome = 0; // 0 none, 1 stop, 2 target
    byDay[0][p] = price;
    for (let day = 1; day <= maxDays; day += 1) {
      price *= Math.exp(drift + sigma * normal());
      byDay[day][p] = price;
      if (hasLevels && outcome === 0) {
        if (price <= stop) outcome = 1;
        else if (price >= target) outcome = 2;
      }
    }
    if (outcome === 1) stopFirst += 1;
    else if (outcome === 2) targetFirst += 1;
  }

  const fan = { days: [], p05: [], p25: [], p50: [], p75: [], p95: [] };
  for (let day = 0; day <= maxDays; day += 1) {
    const sorted = Array.from(byDay[day]).sort((a, b) => a - b);
    if (!sorted.every(isNum)) return unavailable(asset, 'The simulation produced a non-finite price and was discarded.');
    fan.days.push(day);
    fan.p05.push(percentile(sorted, 0.05));
    fan.p25.push(percentile(sorted, 0.25));
    fan.p50.push(percentile(sorted, 0.5));
    fan.p75.push(percentile(sorted, 0.75));
    fan.p95.push(percentile(sorted, 0.95));
  }

  const horizonRows = horizonList.map((days) => {
    const root = Math.sqrt(days);
    return {
      days,
      p05: fan.p05[days],
      p50: fan.p50[days],
      p95: fan.p95[days],
      theoryP05: startPrice * Math.exp(drift * days - Z_95 * sigma * root),
      theoryP50: startPrice * Math.exp(drift * days),
      theoryP95: startPrice * Math.exp(drift * days + Z_95 * sigma * root),
    };
  });
  const longest = horizonRows[horizonRows.length - 1];
  const downside = safeDiv(longest.p05 - startPrice, startPrice);
  const upside = safeDiv(longest.p95 - startPrice, startPrice);

  const monteCarlo = traced({
    id: 'monteCarlo',
    label: `Simulated price range (${maxDays} days)`,
    value: longest.p50,
    unit: 'currency',
    tone: 'neutral',
    meta: { currency, horizons: horizonRows, paths: pathCount, seed: usedSeed, sigmaDaily: sigma, sigmaAnnual: sigma * Math.sqrt(periods), drift, driftMode: useHistoricalDrift ? 'historical' : 'zero' },
    formula: 'Sₜ₊₁ = Sₜ × exp(d + σ × Z), Z ~ N(0, 1); d = −σ² ÷ 2 for zero drift, or the mean daily log return for historical drift',
    rawInputs: [
      input('Starting price', startPrice, currency, 'live tick or last daily close', asset.quote.asOf),
      input('Daily volatility σ', sigma, 'fraction', `stdev of ${observations} daily log returns`, asset.quote.asOf),
      input(`Mean daily log return (past ${historyLabel})`, meanLogReturn, 'fraction', useHistoricalDrift ? 'used as the drift' : 'shown for reference; not used with zero drift', asset.quote.asOf),
      input('Paths', pathCount, 'simulations', 'fixed'),
      input('Random seed', usedSeed, '', 'hash of the ticker and snapshot date, so results are reproducible'),
    ],
    steps: [
      step(`Estimate daily volatility from ${observations} daily log returns`, `stdev(ln(Cₜ ÷ Cₜ₋₁))`, fmtPct(sigma, 3)),
      useHistoricalDrift
        ? step(`Daily log drift: the mean daily log return of the past ${historyLabel}`, 'mean(ln(Cₜ ÷ Cₜ₋₁))', fmtPct(drift, 4))
        : step('Daily log drift for a zero expected return', `−(${fmtN(sigma, 6)})² ÷ 2`, fmtPct(drift, 4)),
      step(`Simulate ${fmtN(pathCount, 0)} paths of ${maxDays} daily steps`, 'S × exp(d + σ × Z) repeated each day', `${fmtN(pathCount * maxDays, 0)} random steps`),
      ...horizonRows.map((row) => step(
        `After ${row.days} days: 5th percentile, median, 95th percentile`,
        `sort ${fmtN(pathCount, 0)} simulated prices on day ${row.days}`,
        `${fmtN(row.p05, 2)} | ${fmtN(row.p50, 2)} | ${fmtN(row.p95, 2)}`,
      )),
      step(
        `Cross-check day ${longest.days} against the exact formula S × exp(d × T ± 1.645 × σ × √T)`,
        `${fmtN(startPrice)} × exp(${fmtN(drift * longest.days, 6)} ± 1.645 × ${fmtN(sigma, 6)} × √${longest.days})`,
        `${fmtN(longest.theoryP05, 2)} | ${fmtN(longest.theoryP50, 2)} | ${fmtN(longest.theoryP95, 2)}`,
      ),
    ],
    interpretation: interpretation(
      `In 90% of simulated paths the price after ${maxDays} trading days lies between ${fmtN(longest.p05, 2)} and ${fmtN(longest.p95, 2)} ${currency} (${fmtPct(downside, 0)} to +${fmtPct(upside, 0)} from today).`,
      [
        threshold('5th percentile', 'A bad but plausible outcome', 'caution'),
        threshold('Median', 'Half of the paths end above, half below', 'neutral'),
        threshold('95th percentile', 'A good but plausible outcome', 'healthy'),
      ],
      `${observations < 40 ? `Volatility was estimated from only ${observations} days, so the width of this fan is a rough figure. ` : ''}The model assumes constant volatility and no sudden jumps. Real markets have fatter tails, so extreme outcomes are more likely than shown.`,
    ),
    dependsOn: ['volatility'],
  });

  let probStopFirst;
  const neither = pathCount - stopFirst - targetFirst;
  if (!hasLevels) {
    probStopFirst = notAvailable({
      id: 'probStopFirst', label: 'Chance the stop is hit first', unit: 'pct',
      formula: 'paths that reach the stop before the target ÷ all paths',
      reason: 'A stop below the starting price and a target above it are needed. Size a position first.',
    });
  } else {
    const value = stopFirst / pathCount;
    const decided = stopFirst + targetFirst;
    const shareOfDecided = safeDiv(stopFirst, decided);
    probStopFirst = traced({
      id: 'probStopFirst', label: 'Chance the stop is hit first', value, unit: 'pct', tone: 'neutral',
      meta: { stopFirst, targetFirst, neither, paths: pathCount, days: maxDays, shareOfDecided },
      formula: 'P(stop first) = paths that close at or below the stop before closing at or above the target ÷ all paths',
      rawInputs: [
        input('Starting price', startPrice, currency, 'live tick or last daily close', asset.quote.asOf),
        input('Stop-loss level', stop, currency, 'positionSizerEngine: stopLoss'),
        input('Target level', target, currency, 'positionSizerEngine: target2R'),
        input('Paths', pathCount, 'simulations', 'fixed'),
      ],
      steps: [
        step(`Paths that reached the stop first within ${maxDays} days`, `count of ${fmtN(pathCount, 0)} paths`, stopFirst),
        step('Paths that reached the target first', `count of ${fmtN(pathCount, 0)} paths`, targetFirst),
        step('Paths that reached neither', `${fmtN(pathCount, 0)} − ${stopFirst} − ${targetFirst}`, neither),
        step('Chance the stop is hit first', `${stopFirst} ÷ ${fmtN(pathCount, 0)}`, fmtPct(value, 1)),
        step('Of the paths that reached either level, the share that hit the stop', `${stopFirst} ÷ ${decided}`, shareOfDecided === null ? 'N/A' : fmtPct(shareOfDecided, 1)),
      ],
      interpretation: interpretation(
        `Within ${maxDays} trading days, ${fmtPct(value, 0)} of paths hit the stop first, ${fmtPct(targetFirst / pathCount, 0)} hit the target first and ${fmtPct(neither / pathCount, 0)} reached neither.`,
        [
          threshold('About two in three decided paths', 'Expected when the target is twice as far as the stop', 'neutral'),
          threshold('Well above that', 'The stop may be too tight for this volatility', 'caution'),
        ],
        'With no edge, a target twice as far away as the stop is reached about half as often. That is arithmetic, not a flaw: the payoff is twice as large.',
      ),
      dependsOn: ['stopLoss', 'target2R', 'monteCarlo'],
    });
  }

  return {
    ticker: asset.ticker,
    ok: true,
    metrics: { monteCarlo, probStopFirst },
    fan,
    horizons: horizonRows,
    outcomes: hasLevels ? { stopFirst, targetFirst, neither, paths: pathCount } : null,
    params: { sigmaDaily: sigma, sigmaAnnual: sigma * Math.sqrt(periods), meanLogReturn, drift, driftMode: useHistoricalDrift ? 'historical' : 'zero', paths: pathCount, seed: usedSeed, days: maxDays, observations },
  };
}
