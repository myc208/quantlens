/**
 * correlationEngine.js: how much the compared assets overlap.
 *
 * Method
 *   1. Keep only the dates on which BOTH assets have a candle (stocks do not
 *      trade at weekends, crypto does; US and Singapore holidays differ).
 *   2. Compute log returns between consecutive common dates.
 *   3. Pearson correlation of the two return series.
 *
 * At least 60 overlapping returns are required. |ρ| ≥ 0.80 raises a red
 * alert and 0.60 – 0.80 an amber one. The mean correlation of each asset with
 * the others feeds the position sizer's correlation haircut.
 */

import { isNum, pearson, mean } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, valueOf, fmtN,
} from '../core/derivationTracer.js';
import { weeklyCloses, sessionName } from './riskEngine.js';

export const CORR_CONFIG = Object.freeze({
  minOverlap: 60, // full-year view
  minWindowOverlap: 15, // shorter time ranges: allowed, and the trace says the figure is rough
  minWeeklyOverlap: 15, // weekly returns for markets that close at different times (about 4 months)
  roughBelow: 40,
  dangerThreshold: 0.8,
  elevatedThreshold: 0.6,
});

const THRESHOLDS = [
  threshold('0.80 to 1.00', 'Effectively one bet', 'risky'),
  threshold('0.60 to 0.80', 'Substantial overlap', 'caution'),
  threshold('−0.60 to 0.60', 'Genuinely different exposures', 'healthy'),
  threshold('−1.00 to −0.60', 'Move in opposite directions', 'neutral'),
];

/** Stable id for a pair, independent of argument order within the comparison list. */
export function pairId(tickerA, tickerB) {
  return `corr:${tickerA}|${tickerB}`;
}

/**
 * Log returns of two price series over their common dates.
 * @returns {{ dates:string[], a:number[], b:number[], commonDates:number } | null}
 */
export function alignedReturns(seriesA, seriesB) {
  if (!seriesA || !seriesB || !Array.isArray(seriesA.dates) || !Array.isArray(seriesB.dates)) return null;
  const closeByDate = new Map();
  for (let i = 0; i < seriesB.dates.length; i += 1) closeByDate.set(seriesB.dates[i], seriesB.close[i]);
  const dates = [];
  const pricesA = [];
  const pricesB = [];
  for (let i = 0; i < seriesA.dates.length; i += 1) {
    const date = seriesA.dates[i];
    const other = closeByDate.get(date);
    const own = seriesA.close[i];
    if (isNum(own) && own > 0 && isNum(other) && other > 0) {
      dates.push(date);
      pricesA.push(own);
      pricesB.push(other);
    }
  }
  if (dates.length < 2) return { dates: [], a: [], b: [], commonDates: dates.length };
  const a = [];
  const b = [];
  const returnDates = [];
  for (let i = 1; i < dates.length; i += 1) {
    a.push(Math.log(pricesA[i] / pricesA[i - 1]));
    b.push(Math.log(pricesB[i] / pricesB[i - 1]));
    returnDates.push(dates[i]);
  }
  return { dates: returnDates, a, b, commonDates: dates.length };
}

export function correlationLevel(rho) {
  if (!isNum(rho)) return 'unknown';
  const size = Math.abs(rho);
  if (size >= CORR_CONFIG.dangerThreshold) return 'danger';
  if (size >= CORR_CONFIG.elevatedThreshold) return 'elevated';
  return 'ok';
}

function toneFor(rho) {
  if (rho >= CORR_CONFIG.dangerThreshold) return 'risky';
  if (rho >= CORR_CONFIG.elevatedThreshold) return 'caution';
  if (rho <= -CORR_CONFIG.elevatedThreshold) return 'neutral';
  return 'healthy';
}

function describe(rho, a, b) {
  const text = fmtN(rho, 2);
  if (rho >= CORR_CONFIG.dangerThreshold) return `${a} and ${b} move together almost all the time (ρ = ${text}). Holding both is close to one larger bet, not two.`;
  if (rho >= CORR_CONFIG.elevatedThreshold) return `${a} and ${b} often move together (ρ = ${text}). They diversify each other only partly.`;
  if (rho <= -CORR_CONFIG.dangerThreshold) return `${a} and ${b} move in opposite directions almost all the time (ρ = ${text}). Holding both largely cancels out.`;
  if (rho <= -CORR_CONFIG.elevatedThreshold) return `${a} and ${b} often move in opposite directions (ρ = ${text}). One tends to offset the other.`;
  return `${a} and ${b} move largely independently (ρ = ${text}). Holding both spreads your risk.`;
}

/**
 * Correlation of two assets as a traced metric.
 * @param {object} assetA normalised asset
 * @param {object} assetB normalised asset
 * @param {{ minOverlap?: number, windowLabel?: string }} [options] minimum return pairs, and the
 *        name of the period the series cover ("year", "3 months"), used in the explanation
 */
export function correlatePair(assetA, assetB, { minOverlap = CORR_CONFIG.minOverlap, windowLabel = 'year', minWeeklyOverlap = CORR_CONFIG.minWeeklyOverlap } = {}) {
  const id = pairId(assetA.ticker, assetB.ticker);
  const label = `Correlation: ${assetA.ticker} vs ${assetB.ticker}`;
  const crossMarket = assetA.market !== assetB.market;

  // Markets that close at different times are compared week by week (Friday to Friday):
  // daily closes taken hours apart make two assets look less related than they are.
  let frequency = 'daily';
  let aligned = null;
  if (crossMarket) {
    const weekly = alignedReturns(weeklyCloses(assetA.series), weeklyCloses(assetB.series));
    if (weekly && weekly.a.length >= minWeeklyOverlap) {
      aligned = weekly;
      frequency = 'weekly';
    }
  }
  const asynchronous = crossMarket && frequency === 'daily';
  if (!aligned) aligned = alignedReturns(assetA.series, assetB.series);
  const required = frequency === 'weekly' ? minWeeklyOverlap : minOverlap;
  const unitWord = frequency === 'weekly' ? 'weekly' : 'daily';
  const sessions = `${sessionName(assetA.market)} and ${sessionName(assetB.market)}`;
  const formula = `ρ = covariance(rA, rB) ÷ (stdev(rA) × stdev(rB)), using ${unitWord} log returns on ${frequency === 'weekly' ? 'weeks' : 'dates'} both assets traded`;
  let caveat = `Correlation is measured over the past ${windowLabel} and rises sharply in market sell-offs, exactly when diversification is needed most.`;
  if (frequency === 'weekly') {
    caveat = `${assetA.ticker} and ${assetB.ticker} trade in different sessions (${sessions}), so their daily closes are hours apart. Weekly returns, Friday to Friday, line them up. ${caveat}`;
  } else if (asynchronous) {
    caveat = `${assetA.ticker} and ${assetB.ticker} trade in different sessions (${sessions}), so their daily closes are hours apart, and the last ${windowLabel} has too few weeks for weekly returns. This understates how closely they really move: treat the figure as a lower bound, or choose 6M or longer.`;
  }
  const base = { id, label, unit: 'ratio', formula, meta: { tickers: [assetA.ticker, assetB.ticker], crossMarket, window: windowLabel, frequency, asynchronous } };

  const overlap = aligned ? aligned.a.length : 0;
  const rawInputs = [
    input(`${assetA.ticker} daily closes`, assetA.series.close.length, 'candles', 'snapshot', assetA.quote.asOf),
    input(`${assetB.ticker} daily closes`, assetB.series.close.length, 'candles', 'snapshot', assetB.quote.asOf),
    input(`Overlapping ${unitWord} returns`, overlap, 'observations', frequency === 'weekly' ? 'Friday-ending weeks present in both series' : 'dates present in both series'),
  ];
  if (overlap < required) {
    return notAvailable({
      ...base, rawInputs,
      reason: `Only ${overlap} overlapping ${unitWord} returns are available; at least ${required} are needed for a reliable correlation.`,
    });
  }
  const stats = pearson(aligned.a, aligned.b);
  if (!stats) {
    return notAvailable({ ...base, rawInputs, reason: 'One of the assets did not move at all over the overlapping dates, so correlation is undefined.' });
  }
  const rho = stats.r;
  return traced({
    ...base, value: rho, tone: toneFor(rho),
    meta: { ...base.meta, overlap, level: correlationLevel(rho), from: aligned.dates[0], to: aligned.dates[aligned.dates.length - 1] },
    rawInputs,
    steps: [
      frequency === 'weekly'
        ? step("Keep each asset's last close of every Friday-ending week, and the weeks both traded", `${assetA.series.dates.length} and ${assetB.series.dates.length} candles`, `${aligned.commonDates} common weeks`)
        : step('Keep only dates on which both assets have a close', `${assetA.series.dates.length} and ${assetB.series.dates.length} candles`, `${aligned.commonDates} common dates`),
      step(`Log return between consecutive common ${frequency === 'weekly' ? 'weeks' : 'dates'}, for each asset`, 'ln(Cₜ ÷ Cₜ₋₁)', `${overlap} return pairs`),
      step(`Standard deviation of ${assetA.ticker} returns`, `stdev(${overlap} returns)`, stats.sdX),
      step(`Standard deviation of ${assetB.ticker} returns`, `stdev(${overlap} returns)`, stats.sdY),
      step('Covariance of the two return series', 'Σ (rA − mean A)(rB − mean B) ÷ (n − 1)', stats.covariance),
      step('Divide the covariance by the product of the standard deviations', `${fmtN(stats.covariance, 8)} ÷ (${fmtN(stats.sdX, 6)} × ${fmtN(stats.sdY, 6)})`, rho),
    ],
    interpretation: interpretation(
      describe(rho, assetA.ticker, assetB.ticker),
      THRESHOLDS,
      overlap < CORR_CONFIG.roughBelow ? `Based on only ${overlap} pairs of ${unitWord} returns, so this is a rough figure that can swing a lot from one month to the next. ${caveat}` : caveat,
    ),
  });
}

/**
 * Full correlation picture for the compared assets (normally up to three).
 *
 * @param {object[]} assets normalised assets
 * @param {{ minOverlap?: number, windowLabel?: string }} [options] see correlatePair
 * @returns {{
 *   tickers: string[],
 *   matrix: (number|null)[][],
 *   pairs: Record<string, object>,
 *   alerts: { level:'danger'|'elevated', pairId:string, tickers:string[], rho:number, message:string }[],
 *   meanByTicker: Record<string, number|null>,
 *   pairsByTicker: Record<string, string[]>,
 *   overall: { level:'danger'|'elevated'|'ok'|'unknown', headline:string }
 * }}
 */
export function analyzeCorrelation(assets, options = {}) {
  const list = Array.isArray(assets) ? assets.filter(Boolean) : [];
  const tickers = list.map((asset) => asset.ticker);
  const size = list.length;
  const matrix = list.map((_, row) => list.map((__, column) => (row === column ? 1 : null)));
  const pairs = {};
  const alerts = [];
  const pairsByTicker = Object.fromEntries(tickers.map((ticker) => [ticker, []]));

  for (let i = 0; i < size; i += 1) {
    for (let j = i + 1; j < size; j += 1) {
      const metric = correlatePair(list[i], list[j], options);
      pairs[metric.id] = metric;
      pairsByTicker[tickers[i]].push(metric.id);
      pairsByTicker[tickers[j]].push(metric.id);
      const rho = valueOf(metric);
      matrix[i][j] = rho;
      matrix[j][i] = rho;
      const level = correlationLevel(rho);
      if (level === 'danger' || level === 'elevated') {
        alerts.push({
          level,
          pairId: metric.id,
          tickers: [tickers[i], tickers[j]],
          rho,
          message: metric.trace.interpretation.summary,
        });
      }
    }
  }
  alerts.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));

  const meanByTicker = {};
  for (let i = 0; i < size; i += 1) {
    const others = matrix[i].filter((value, column) => column !== i && isNum(value));
    meanByTicker[tickers[i]] = others.length ? mean(others) : null;
  }

  let overall;
  const known = Object.values(pairs).filter((metric) => metric.status === 'ok').length;
  if (size < 2) {
    overall = { level: 'unknown', headline: 'Select at least two assets to see how much they overlap.' };
  } else if (known === 0) {
    overall = { level: 'unknown', headline: 'There is not enough overlapping history to measure correlation.' };
  } else if (alerts.some((alert) => alert.level === 'danger' && alert.rho > 0)) {
    overall = { level: 'danger', headline: 'Dangerous overlap: some of these assets behave like a single position. Sizes are reduced to compensate.' };
  } else if (alerts.some((alert) => alert.rho > 0)) {
    overall = { level: 'elevated', headline: 'Noticeable overlap: these assets diversify each other only partly. Sizes are trimmed slightly.' };
  } else {
    overall = { level: 'ok', headline: 'Good spread: these assets move largely independently of each other.' };
  }

  return { tickers, matrix, pairs, alerts, meanByTicker, pairsByTicker, overall };
}
