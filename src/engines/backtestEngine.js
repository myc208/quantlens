/**
 * backtestEngine.js: the verdict's own track record.
 *
 * For every past day with a full window of history behind it, the Technical score
 * is recomputed from exactly that window, as the live engine would have computed it
 * on that day, then compared with what the price did over the next 21 trading days.
 *
 *   window    the same length as the live window (the asset's year of candles), so the
 *             last day of the backtest reproduces today's live score exactly
 *   verdict   the score's band (BUY 65+, HOLD 45 to 65, SELL below 45) with the two
 *             price-based safety rules applied (downtrend, overheated RSI)
 *   outcome   simple return from that day's close to the close 21 sessions later
 *
 * Reported per asset: the average forward return and hit rate of each band against
 * the asset's average day, and the rank IC (Spearman correlation between the score
 * and the forward return).
 *
 * Deliberately NOT tested: the Fundamental half of the composite. Free data only has
 * today's fundamentals, and scoring 2022 with 2026 accounts would leak the future into
 * the test (look-ahead bias). For ETFs, indices and crypto the Technical score is the
 * whole verdict; for stocks it is the half that moves day to day.
 */

import { isNum, safeDiv, mean, pearson, interpolateAnchors, weightedScore, minOf, maxOf, percentile } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';
import { TECH_CONFIG, smaSeries, emaSeries, macdSeries, rsiSeries } from './technicalEngine.js';
import { ADVISOR_CONFIG, verdictForScore } from './advisorEngine.js';

export const BACKTEST_CONFIG = Object.freeze({
  horizon: 21,          // trading sessions ahead
  minScoredDays: 120,   // days with a known outcome before the record is reported
  noiseIc: 0.05,        // |IC| below this is indistinguishable from noise in practice
});

/**
 * The Technical score of the last day of a window, computed exactly as technicalEngine does,
 * without building any trace. `high` and `low` may be the closes where no range data exists.
 * @returns {{ score:number|null, sma200:number|null, macdLine:number|null, macdSignal:number|null, rsi:number|null }}
 */
export function technicalScoreAt(close, high, low) {
  const last = close.length - 1;
  const price = close[last];
  const points = TECH_CONFIG.trendPoints;
  const sma200 = smaSeries(close, 200)[last];
  const ema20 = emaSeries(close, 20)[last];
  const ema50 = emaSeries(close, 50)[last];
  const checks = [
    { passed: isNum(sma200) ? price > sma200 : null, points: points.aboveSma200 },
    { passed: isNum(ema20) && isNum(ema50) ? ema20 > ema50 : null, points: points.emaCross },
    { passed: isNum(ema50) ? price > ema50 : null, points: points.aboveEma50 },
  ].filter((check) => check.passed !== null);
  const trendAvailable = checks.reduce((total, check) => total + check.points, 0);
  const trend = trendAvailable ? (checks.reduce((total, check) => total + (check.passed ? check.points : 0), 0) / trendAvailable) * 100 : null;

  const { fast, slow, signal: signalPeriod, lookback } = TECH_CONFIG.macd;
  const macd = macdSeries(close, fast, slow, signalPeriod);
  const line = macd.line[last];
  const signal = macd.signal[last];
  const histogram = macd.histogram[last];
  let macdScore = null;
  if (isNum(line) && isNum(signal) && isNum(histogram)) {
    const earlier = macd.histogram[last - lookback];
    const mp = TECH_CONFIG.macdPoints;
    const macdChecks = [
      { passed: line > signal, points: mp.aboveSignal },
      { passed: line > 0, points: mp.aboveZero },
      { passed: isNum(earlier) ? histogram > earlier : null, points: mp.rising },
    ].filter((check) => check.passed !== null);
    const available = macdChecks.reduce((total, check) => total + check.points, 0);
    macdScore = (macdChecks.reduce((total, check) => total + (check.passed ? check.points : 0), 0) / available) * 100;
  }

  const rsi = rsiSeries(close, TECH_CONFIG.rsiPeriod).rsi[last];
  const rsiResult = interpolateAnchors(isNum(rsi) ? rsi : null, TECH_CONFIG.rsiAnchors);
  const highest = maxOf(high);
  const lowest = minOf(low);
  const position = isNum(highest) && isNum(lowest) ? safeDiv(price - lowest, highest - lowest) : null;
  const range = position === null ? null : Math.min(100, Math.max(0, position * 100));

  const weights = TECH_CONFIG.weights;
  const result = weightedScore([
    { id: 'trendScore', weight: weights.trend, score: trend },
    { id: 'macdScore', weight: weights.macd, score: macdScore },
    { id: 'rsiScore', weight: weights.rsi, score: rsiResult ? rsiResult.score : null },
    { id: 'rangeScore', weight: weights.range, score: range },
  ]);
  return {
    score: result.score,
    sma200: isNum(sma200) ? sma200 : null,
    macdLine: isNum(line) ? line : null,
    macdSignal: isNum(signal) ? signal : null,
    rsi: isNum(rsi) ? rsi : null,
  };
}

/** The verdict a Technical score implies, with the two price-based safety rules applied. */
export function technicalVerdict(point, price) {
  const raw = verdictForScore(point.score);
  if (raw !== 'BUY') return raw;
  const downtrend = point.sma200 !== null && point.macdLine !== null && point.macdSignal !== null
    && price < point.sma200 && point.macdLine < point.macdSignal;
  const overheated = point.rsi !== null && point.rsi > ADVISOR_CONFIG.guardrails.rsiOverheated;
  return downtrend || overheated ? 'HOLD' : 'BUY';
}

/** Ranks with ties sharing their average rank (1-based). */
export function averageRanks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k].index] = rank;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation, or null. */
export function spearman(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 3) return null;
  const result = pearson(averageRanks(xs), averageRanks(ys));
  return result ? result.r : null;
}

/**
 * Band statistics and rank IC from per-day scores, verdicts and forward returns.
 * @returns {{ n:number, base:object, bands:Record<string, object>, ic:number|null, independent:number, tStat:number|null }}
 */
export function summariseBacktest(scores, verdicts, forward) {
  const n = forward.length;
  const describe = (returns) => {
    if (!returns.length) return { count: 0, mean: null, median: null, upShare: null };
    const sorted = [...returns].sort((a, b) => a - b);
    return { count: returns.length, mean: mean(returns), median: percentile(sorted, 0.5), upShare: returns.filter((r) => r > 0).length / returns.length };
  };
  const base = describe(forward);
  const bands = {};
  for (const verdict of ['BUY', 'HOLD', 'SELL']) {
    const band = describe(forward.filter((_, i) => verdicts[i] === verdict));
    band.share = n ? band.count / n : 0;
    band.excess = isNum(band.mean) && isNum(base.mean) ? band.mean - base.mean : null;
    // A BUY is right when the price rose; a SELL is right when it fell.
    band.hitRate = band.count === 0 ? null : verdict === 'SELL' ? 1 - band.upShare : band.upShare;
    bands[verdict] = band;
  }
  const ic = spearman(scores, forward);
  const independent = Math.floor(n / BACKTEST_CONFIG.horizon);
  const tStat = isNum(ic) && independent > 2 && Math.abs(ic) < 1 ? ic * Math.sqrt((independent - 2) / (1 - ic * ic)) : null;
  return { n, base, bands, ic, independent, tStat };
}

/**
 * The verdict's track record for one asset.
 * @param {{ ticker:string, assetClass:string, series:{dates:string[], high:number[], low:number[], close:number[]}, longSeries:{dates:string[], close:number[]} }} asset
 */
export function backtestAsset(asset) {
  const id = 'verdictBacktest';
  const label = 'Verdict track record (backtest)';
  const horizon = BACKTEST_CONFIG.horizon;
  const formula = `Rank IC = Spearman correlation between each day's Technical score and the return over the next ${horizon} sessions; band hit rate = share of BUY days followed by a rise (SELL: by a fall)`;
  const long = asset.longSeries ?? { dates: asset.series.dates, close: asset.series.close };
  const window = asset.series.close.length;
  const historyCount = long.close.length - window;
  const highs = long.close.map((close, i) => (i >= historyCount ? asset.series.high[i - historyCount] : close));
  const lows = long.close.map((close, i) => (i >= historyCount ? asset.series.low[i - historyCount] : close));

  const scores = [];
  const verdicts = [];
  const forward = [];
  const days = [];
  let lastPoint = null;
  for (let t = window - 1; t < long.close.length; t += 1) {
    const from = t - window + 1;
    const point = technicalScoreAt(long.close.slice(from, t + 1), highs.slice(from, t + 1), lows.slice(from, t + 1));
    if (t === long.close.length - 1) lastPoint = { ...point, verdict: technicalVerdict(point, long.close[t]) };
    if (!isNum(point.score) || t + horizon >= long.close.length) continue;
    scores.push(point.score);
    verdicts.push(technicalVerdict(point, long.close[t]));
    forward.push(long.close[t + horizon] / long.close[t] - 1);
    days.push(long.dates[t]);
  }

  const result = { ticker: asset.ticker, lastScore: lastPoint ? lastPoint.score : null, lastVerdict: lastPoint ? lastPoint.verdict : null, days: days.length };
  if (days.length < BACKTEST_CONFIG.minScoredDays) {
    return {
      ...result,
      summary: null,
      metrics: {
        [id]: notAvailable({
          id, label, unit: 'ratio', formula,
          reason: `Only ${days.length} past days have both a full year of history behind them and a ${horizon}-day outcome; at least ${BACKTEST_CONFIG.minScoredDays} are needed. ${historyCount <= 0 ? 'This snapshot holds no history older than the current year.' : ''}`.trim(),
        }),
      },
    };
  }

  const summary = summariseBacktest(scores, verdicts, forward);
  const { ic, tStat, independent, bands, base } = summary;
  const meaningful = isNum(tStat) && Math.abs(tStat) >= 2 && Math.abs(ic) >= BACKTEST_CONFIG.noiseIc;
  let tone = 'neutral';
  if (meaningful) tone = ic > 0 ? 'healthy' : 'risky';
  const pct = (value) => (isNum(value) ? `${value >= 0 ? '+' : ''}${fmtPct(value, 2)}` : 'N/A');
  const bandLine = (verdict) => {
    const band = bands[verdict];
    return band.count === 0 ? `${verdict}: no days` : `${verdict}: ${band.count} days, average ${pct(band.mean)} (${pct(band.excess)} against all days), ${verdict === 'HOLD' ? 'rose' : 'right'} ${fmtPct(verdict === 'HOLD' ? band.upShare : band.hitRate, 0)} of the time`;
  };

  let summaryText;
  if (!isNum(ic)) summaryText = 'The scores did not vary enough to measure a relationship with what followed.';
  else if (!meaningful) summaryText = `Over ${days.length} days the score showed no reliable link with the next ${horizon} days (rank IC ${fmtN(ic, 2)}, about ${independent} independent periods). Treat the verdict as a description of the trend, not a forecast.`;
  else if (ic > 0) summaryText = `Over ${days.length} days, higher scores were followed by better ${horizon}-day returns (rank IC ${fmtN(ic, 2)}). That is a modest, past-only edge for this asset, not a promise.`;
  else summaryText = `Over ${days.length} days, higher scores were followed by WORSE ${horizon}-day returns (rank IC ${fmtN(ic, 2)}). For this asset the verdict has pointed the wrong way.`;

  return {
    ...result,
    summary,
    metrics: {
      [id]: traced({
        id, label, value: ic, unit: 'ratio', tone,
        meta: { ...summary, from: days[0], to: days[days.length - 1], horizon, window, meaningful },
        formula,
        rawInputs: [
          input('Days scored', days.length, 'days', `${days[0]} to ${days[days.length - 1]}, each with a full ${window}-session window and a ${horizon}-session outcome`),
          input('Window per score', window, 'sessions', 'the same length as the live verdict uses'),
          input('Average return over all those days', base.mean, 'fraction', `${horizon}-session forward returns`),
          input('Share of all days followed by a rise', base.upShare, 'fraction', 'the base rate any verdict must beat'),
        ],
        steps: [
          step('Recompute the Technical score for every past day from the window ending that day', `${days.length} windows of ${window} sessions`, `${days.length} scores`),
          step('Map each score to its band, with the downtrend and overheated-RSI rules applied', 'BUY ≥ 65 · HOLD 45 to 65 · SELL < 45', `${bands.BUY.count} BUY · ${bands.HOLD.count} HOLD · ${bands.SELL.count} SELL`),
          step('BUY days against all days', bandLine('BUY'), pct(bands.BUY.excess)),
          step('HOLD days', bandLine('HOLD'), pct(bands.HOLD.excess)),
          step('SELL days against all days', bandLine('SELL'), pct(bands.SELL.excess)),
          step('Rank IC: correlation between the score\'s rank and the forward return\'s rank', `Spearman over ${days.length} days`, isNum(ic) ? fmtN(ic, 3) : 'N/A'),
          step(`Rough significance with about ${independent} non-overlapping ${horizon}-day periods`, 't ≈ IC × √((periods − 2) ÷ (1 − IC²))', isNum(tStat) ? fmtN(tStat, 2) : 'N/A'),
        ],
        interpretation: interpretation(
          summaryText,
          [
            threshold(`|IC| below ${BACKTEST_CONFIG.noiseIc}`, 'Indistinguishable from noise', 'neutral'),
            threshold(`IC ${BACKTEST_CONFIG.noiseIc} or more with t ≥ 2`, 'A modest historical edge', 'healthy'),
            threshold(`IC −${BACKTEST_CONFIG.noiseIc} or less with t ≥ 2`, 'The signal pointed the wrong way', 'risky'),
          ],
          `Tests the price-based (Technical) half of the verdict only: free data has no point-in-time fundamentals, and scoring past days with today's accounts would leak the future into the test. Before the last year the 52-week range uses closes, as highs and lows are not stored. Overlapping ${horizon}-day windows share days, so the effective sample is about ${independent} periods. The watchlist was chosen today, with hindsight, and prices are dividend-adjusted.`,
        ),
      }),
    },
  };
}

/**
 * Backtest every asset of the watchlist (run in the Web Worker).
 * @param {{ assets: object[] }} payload
 */
export function backtestWatchlist({ assets }) {
  const byTicker = {};
  const ics = [];
  const pooled = { BUY: [], HOLD: [], SELL: [], all: [] };
  for (const asset of Array.isArray(assets) ? assets : []) {
    const result = backtestAsset(asset);
    byTicker[asset.ticker] = result;
    if (result.summary && isNum(result.summary.ic)) ics.push(result.summary.ic);
  }
  for (const result of Object.values(byTicker)) {
    if (!result.summary) continue;
    for (const verdict of ['BUY', 'HOLD', 'SELL']) {
      const band = result.summary.bands[verdict];
      if (band.count) pooled[verdict].push({ count: band.count, mean: band.mean });
    }
    pooled.all.push({ count: result.summary.n, mean: result.summary.base.mean });
  }
  const weighted = (list) => {
    const count = list.reduce((total, item) => total + item.count, 0);
    return count ? { count, mean: list.reduce((total, item) => total + item.count * item.mean, 0) / count } : { count: 0, mean: null };
  };
  return {
    byTicker,
    summary: {
      assets: ics.length,
      meanIc: ics.length ? mean(ics) : null,
      positiveIc: ics.filter((ic) => ic > 0).length,
      buy: weighted(pooled.BUY),
      hold: weighted(pooled.HOLD),
      sell: weighted(pooled.SELL),
      all: weighted(pooled.all),
      horizon: BACKTEST_CONFIG.horizon,
    },
  };
}
