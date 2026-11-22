/**
 * backtestEngine.js: what followed the price-based readouts, replayed over the stored years.
 *
 * For every past day with a full window of history behind it, the Technical score and
 * the trend regime are recomputed from exactly that window, as the live engine would
 * have computed them on that day, then compared with what the price did over the next
 * 21 trading days.
 *
 *   window    the same length as the live window (the asset's year of candles), so the
 *             last day of the backtest reproduces today's live score and label exactly
 *   label     the trend regime (Uptrend, Extended, Pullback, Recovering, Downtrend)
 *   state     the VIX regime of that day (normal, elevated, stressed, macro.regime.history)
 *   outcome   simple return from that day's close to the close 21 sessions later
 *
 * Reported per asset: the regime track record (the average forward return after each
 * label, overall and within each VIX regime) and the Technical score's rank IC (Spearman
 * correlation between the score and the forward return), with the highest and lowest
 * third of scored days against the asset's average day.
 *
 * V3.3: the BUY / HOLD / SELL bands are gone. Over 2022–2026 neither the score nor any
 * simple trend or momentum signal predicted 21- or 63-day returns on this watchlist, so
 * QuantLens describes the trend and publishes what followed, rather than a verdict.
 *
 * Deliberately NOT tested: the Fundamental score. Free data only has today's
 * fundamentals, and scoring 2022 with 2026 accounts would leak the future into the test
 * (look-ahead bias).
 */

import { isNum, safeDiv, mean, pearson, interpolateAnchors, weightedScore, minOf, maxOf, percentile } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';
import { TECH_CONFIG, smaSeries, emaSeries, macdSeries, rsiSeries } from './technicalEngine.js';
import { classifyTrend, TREND_REGIMES } from './trendRegimeEngine.js';
import { classifyRegime, REGIME_STATES } from './regimeEngine.js';

export const BACKTEST_CONFIG = Object.freeze({
  horizon: 21,          // trading sessions ahead
  minScoredDays: 120,   // days with a known outcome before the record is reported
  noiseIc: 0.05,        // |IC| below this is indistinguishable from noise in practice
  minLabelDays: 20,     // days with a label before its average is reported
  minStateDays: 60,     // days within a VIX regime before an IC is computed there
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
    close: price,
    sma200: isNum(sma200) ? sma200 : null,
    ema20: isNum(ema20) ? ema20 : null,
    ema50: isNum(ema50) ? ema50 : null,
    macdLine: isNum(line) ? line : null,
    macdSignal: isNum(signal) ? signal : null,
    rsi: isNum(rsi) ? rsi : null,
  };
}

/**
 * The trend state of an asset's last `count` sessions, oldest first (V3.4). Each one is computed
 * from the window ending that day, exactly as the live engine would have computed it then, so the
 * last entry is today's live label. `above` (close ≥ SMA 200) and `emaUp` (EMA 20 ≥ EMA 50) are
 * the two crossings a trend flip is made of; RSI only separates Extended from Uptrend.
 * @returns {{ date:string, label:string|null, above:boolean|null, emaUp:boolean|null }[]}
 */
export function recentTrendStates(asset, count = 3) {
  const long = asset.longSeries ?? { dates: asset.series.dates, close: asset.series.close };
  const window = asset.series.close.length;
  const historyCount = long.close.length - window;
  const highs = long.close.map((close, i) => (i >= historyCount ? asset.series.high[i - historyCount] : close));
  const lows = long.close.map((close, i) => (i >= historyCount ? asset.series.low[i - historyCount] : close));
  const states = [];
  for (let t = Math.max(window - 1, long.close.length - count); t < long.close.length; t += 1) {
    const from = t - window + 1;
    const point = technicalScoreAt(long.close.slice(from, t + 1), highs.slice(from, t + 1), lows.slice(from, t + 1));
    const label = classifyTrend(point);
    states.push({
      date: long.dates[t], label,
      above: label ? point.close >= point.sma200 : null,
      emaUp: label ? point.ema20 >= point.ema50 : null,
    });
  }
  return states;
}

/**
 * A function from an ISO date to the VIX regime of the last session on or before it
 * (normal | elevated | stressed), or null before the history starts.
 * @param {{ history:{dates:string[], vix:number[], vix3m:number[]}, rules:object }|null} regime the normalised macro.regime
 */
export function regimeLookup(regime) {
  if (!regime || !regime.history || !Array.isArray(regime.history.dates) || !regime.history.dates.length || !regime.rules) return () => null;
  const { dates, vix, vix3m } = regime.history;
  const states = dates.map((_, i) => classifyRegime(vix[i], vix3m[i], regime.rules));
  return (iso) => {
    if (iso < dates[0]) return null;
    let low = 0;
    let high = dates.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (dates[middle] <= iso) low = middle;
      else high = middle - 1;
    }
    return states[low];
  };
}

/** Count, mean and share up of a list of forward returns. */
function describeReturns(returns) {
  if (!returns.length) return { count: 0, mean: null, upShare: null };
  return { count: returns.length, mean: mean(returns), upShare: returns.filter((r) => r > 0).length / returns.length };
}

/** Forward returns by trend label, overall and within each VIX regime. */
export function summariseRegimes(labels, states, scores, forward) {
  const byLabel = {};
  for (const label of TREND_REGIMES) byLabel[label] = describeReturns(forward.filter((_, i) => labels[i] === label));
  const byState = {};
  for (const state of REGIME_STATES) {
    const inside = forward.map((_, i) => i).filter((i) => states[i] === state);
    const labelsInside = {};
    for (const label of TREND_REGIMES) labelsInside[label] = describeReturns(inside.filter((i) => labels[i] === label).map((i) => forward[i]));
    byState[state] = {
      ...describeReturns(inside.map((i) => forward[i])),
      ic: inside.length >= BACKTEST_CONFIG.minStateDays ? spearman(inside.map((i) => scores[i]), inside.map((i) => forward[i])) : null,
      labels: labelsInside,
    };
  }
  return { byLabel, byState, base: describeReturns(forward) };
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
 * Rank IC of per-day scores against forward returns, with the highest and lowest third
 * of scored days (by score) against the average day.
 * @returns {{ n:number, base:object, top:object, bottom:object, ic:number|null, independent:number, tStat:number|null }}
 */
export function summariseBacktest(scores, forward) {
  const n = forward.length;
  const describe = (returns) => {
    if (!returns.length) return { count: 0, mean: null, median: null, upShare: null };
    const sorted = [...returns].sort((a, b) => a - b);
    return { count: returns.length, mean: mean(returns), median: percentile(sorted, 0.5), upShare: returns.filter((r) => r > 0).length / returns.length };
  };
  const base = describe(forward);
  // Days ordered by score (ties keep their date order); a third at each end.
  const order = scores.map((score, i) => ({ score, i })).sort((a, b) => a.score - b.score || a.i - b.i).map((item) => item.i);
  const third = Math.floor(n / 3);
  const slice = (indices) => {
    const band = describe(indices.map((i) => forward[i]));
    band.excess = isNum(band.mean) && isNum(base.mean) ? band.mean - base.mean : null;
    band.minScore = indices.length ? Math.min(...indices.map((i) => scores[i])) : null;
    band.maxScore = indices.length ? Math.max(...indices.map((i) => scores[i])) : null;
    return band;
  };
  const top = slice(third ? order.slice(n - third) : []);
  const bottom = slice(order.slice(0, third));
  const ic = spearman(scores, forward);
  const independent = Math.floor(n / BACKTEST_CONFIG.horizon);
  const tStat = isNum(ic) && independent > 2 && Math.abs(ic) < 1 ? ic * Math.sqrt((independent - 2) / (1 - ic * ic)) : null;
  return { n, base, top, bottom, ic, independent, tStat };
}

/**
 * The regime track record and the Technical score's track record for one asset.
 * @param {{ ticker:string, assetClass:string, series:{dates:string[], high:number[], low:number[], close:number[]}, longSeries:{dates:string[], close:number[]} }} asset
 */
export function backtestAsset(asset, { regimeOf = () => null } = {}) {
  const id = 'scoreBacktest';
  const label = 'Technical score track record (backtest)';
  const horizon = BACKTEST_CONFIG.horizon;
  const formula = `Rank IC = Spearman correlation between each day's Technical score and the return over the next ${horizon} sessions`;
  const long = asset.longSeries ?? { dates: asset.series.dates, close: asset.series.close };
  const window = asset.series.close.length;
  const historyCount = long.close.length - window;
  const highs = long.close.map((close, i) => (i >= historyCount ? asset.series.high[i - historyCount] : close));
  const lows = long.close.map((close, i) => (i >= historyCount ? asset.series.low[i - historyCount] : close));

  const scores = [];
  const labels = [];
  const states = [];
  const forward = [];
  const days = [];
  let lastPoint = null;
  for (let t = window - 1; t < long.close.length; t += 1) {
    const from = t - window + 1;
    const point = technicalScoreAt(long.close.slice(from, t + 1), highs.slice(from, t + 1), lows.slice(from, t + 1));
    if (t === long.close.length - 1) lastPoint = { ...point, label: classifyTrend(point) };
    if (!isNum(point.score) || t + horizon >= long.close.length) continue;
    scores.push(point.score);
    labels.push(classifyTrend(point));
    states.push(regimeOf(long.dates[t]));
    forward.push(long.close[t + horizon] / long.close[t] - 1);
    days.push(long.dates[t]);
  }

  const result = {
    ticker: asset.ticker, lastScore: lastPoint ? lastPoint.score : null,
    lastLabel: lastPoint ? lastPoint.label : null, days: days.length,
    span: days.length ? { from: days[0], to: days[days.length - 1] } : null,
  };
  const recordId = 'regimeRecord';
  const recordLabel = 'Regime track record (backtest)';
  const recordFormula = `Average return over the next ${horizon} sessions after each past day with the same trend regime, overall and within each VIX regime`;
  if (days.length < BACKTEST_CONFIG.minScoredDays) {
    const reason = `Only ${days.length} past days have both a full year of history behind them and a ${horizon}-day outcome; at least ${BACKTEST_CONFIG.minScoredDays} are needed. ${historyCount <= 0 ? 'This snapshot holds no history older than the current year.' : ''}`.trim();
    return {
      ...result,
      summary: null,
      regimes: null,
      metrics: {
        [id]: notAvailable({ id, label, unit: 'ratio', formula, reason }),
        [recordId]: notAvailable({ id: recordId, label: recordLabel, unit: 'pct', formula: recordFormula, reason }),
      },
    };
  }

  const summary = summariseBacktest(scores, forward);
  const regimes = summariseRegimes(labels, states, scores, forward);
  const { ic, tStat, independent, top, bottom, base } = summary;
  const meaningful = isNum(tStat) && Math.abs(tStat) >= 2 && Math.abs(ic) >= BACKTEST_CONFIG.noiseIc;
  let tone = 'neutral';
  if (meaningful) tone = ic > 0 ? 'healthy' : 'risky';
  const pct = (value) => (isNum(value) ? `${value >= 0 ? '+' : ''}${fmtPct(value, 2)}` : 'N/A');
  const thirdLine = (band) => (band.count === 0 ? 'no days'
    : `${band.count} days scoring ${fmtN(band.minScore, 0)} to ${fmtN(band.maxScore, 0)}: average ${pct(band.mean)}, rose ${fmtPct(band.upShare, 0)} of the time`);

  let summaryText;
  if (!isNum(ic)) summaryText = 'The scores did not vary enough to measure a relationship with what followed.';
  else if (!meaningful) summaryText = `Over ${days.length} days the score showed no reliable link with the next ${horizon} days (rank IC ${fmtN(ic, 2)}, about ${independent} independent periods). It describes the trend; it does not forecast it.`;
  else if (ic > 0) summaryText = `Over ${days.length} days, higher scores were followed by better ${horizon}-day returns (rank IC ${fmtN(ic, 2)}). That is a modest, past-only edge for this asset, not a promise.`;
  else summaryText = `Over ${days.length} days, higher scores were followed by WORSE ${horizon}-day returns (rank IC ${fmtN(ic, 2)}). For this asset a high score has pointed the wrong way.`;

  return {
    ...result,
    summary,
    regimes,
    metrics: {
      [recordId]: regimeRecordMetric(asset, result.lastLabel, regimes, { days, horizon, recordId, recordLabel, recordFormula }),
      [id]: traced({
        id, label, value: ic, unit: 'ratio', tone,
        meta: { ...summary, from: days[0], to: days[days.length - 1], horizon, window, meaningful },
        formula,
        rawInputs: [
          input('Days scored', days.length, 'days', `${days[0]} to ${days[days.length - 1]}, each with a full ${window}-session window and a ${horizon}-session outcome`),
          input('Window per score', window, 'sessions', 'the same length as the live score uses'),
          input('Average return over all those days', base.mean, 'fraction', `${horizon}-session forward returns`),
          input('Share of all days followed by a rise', base.upShare, 'fraction', 'the base rate any signal must beat'),
        ],
        steps: [
          step('Recompute the Technical score for every past day from the window ending that day', `${days.length} windows of ${window} sessions`, `${days.length} scores`),
          step('Highest third of days by score, against all days', thirdLine(top), pct(top.excess)),
          step('Lowest third of days by score, against all days', thirdLine(bottom), pct(bottom.excess)),
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
          `Tests the price-based score only: free data has no point-in-time fundamentals, and scoring past days with today's accounts would leak the future into the test. Before the last year the 52-week range uses closes, as highs and lows are not stored. Overlapping ${horizon}-day windows share days, so the effective sample is about ${independent} periods. The watchlist was chosen today, with hindsight, and prices are dividend-adjusted.`,
        ),
      }),
    },
  };
}

/** What followed the asset's current trend regime, and every other one, as a traced metric. */
function regimeRecordMetric(asset, current, regimes, { days, horizon, recordId, recordLabel, recordFormula }) {
  const { byLabel, byState, base } = regimes;
  const pct = (value) => (isNum(value) ? `${value >= 0 ? '+' : ''}${fmtPct(value, 2)}` : 'N/A');
  const meta = { label: current, horizon, n: days.length, from: days[0], to: days[days.length - 1], base, byLabel, byState };
  const own = current ? byLabel[current] : null;
  if (!own || own.count < BACKTEST_CONFIG.minLabelDays) {
    return notAvailable({
      id: recordId, label: recordLabel, unit: 'pct', formula: recordFormula, meta,
      reason: current
        ? `Only ${own ? own.count : 0} of the ${days.length} past days were in a ${current} regime; at least ${BACKTEST_CONFIG.minLabelDays} are needed to report what followed.`
        : 'The current trend regime is not defined yet.',
    });
  }
  const stateSteps = REGIME_STATES.filter((state) => byState[state].count > 0).map((state) => {
    const inside = byState[state].labels[current];
    return step(`Within ${state} VIX regimes`, `${byState[state].count} days, ${inside.count} of them ${current}`,
      inside.count >= BACKTEST_CONFIG.minLabelDays ? `${pct(inside.mean)} after ${current} days · ${pct(byState[state].mean)} on all` : `too few ${current} days`);
  });
  return traced({
    id: recordId, label: recordLabel, value: own.mean, unit: 'pct', tone: 'neutral',
    meta,
    formula: recordFormula,
    rawInputs: [
      input('Days replayed', days.length, 'days', `${days[0]} to ${days[days.length - 1]}, each labelled from the window ending that day`),
      input('Average return over all those days', base.mean, 'fraction', `${horizon}-session forward returns`),
    ],
    steps: [
      ...TREND_REGIMES.map((label) => step(`${label} days`, `${byLabel[label].count} days`,
        byLabel[label].count ? `${pct(byLabel[label].mean)} on average, rose ${fmtPct(byLabel[label].upShare, 0)} of the time` : 'none')),
      step('All days', `${base.count} days`, `${pct(base.mean)} on average`),
      ...stateSteps,
    ],
    interpretation: interpretation(
      `After ${current} days, ${asset.ticker} moved ${pct(own.mean)} on average over the next ${horizon} sessions, against ${pct(base.mean)} on all ${base.count} days (${own.count} were ${current}).`,
      [],
      `What followed, not a forecast: the label describes the trend. Over 2022–2026 no trend regime, and no simple trend or momentum signal, predicted the next month on this watchlist. Overlapping ${horizon}-day windows share days, and stressed VIX regimes cover only a few short episodes, so their averages rest on very little.`,
    ),
  });
}

/** Contiguous runs of each VIX regime between two dates, from the stored history. */
export function regimeEpisodes(regime, from, to) {
  const counts = Object.fromEntries(REGIME_STATES.map((state) => [state, { sessions: 0, episodes: 0 }]));
  if (!regime || !regime.history || !regime.rules) return counts;
  const { dates, vix, vix3m } = regime.history;
  let previous = null;
  for (let i = 0; i < dates.length; i += 1) {
    if (dates[i] < from || dates[i] > to) continue;
    const state = classifyRegime(vix[i], vix3m[i], regime.rules);
    counts[state].sessions += 1;
    if (state !== previous) counts[state].episodes += 1;
    previous = state;
  }
  return counts;
}

/**
 * Backtest every asset of the watchlist (run in the Web Worker).
 * @param {{ assets: object[], regime?: object }} payload regime: the normalised macro.regime, for the VIX split
 */
export function backtestWatchlist({ assets, regime = null }) {
  const byTicker = {};
  const ics = [];
  const pooled = [];
  const regimeOf = regimeLookup(regime);
  for (const asset of Array.isArray(assets) ? assets : []) {
    const result = backtestAsset(asset, { regimeOf });
    byTicker[asset.ticker] = result;
    if (result.summary && isNum(result.summary.ic)) ics.push(result.summary.ic);
  }
  for (const result of Object.values(byTicker)) {
    if (result.summary) pooled.push({ count: result.summary.n, mean: result.summary.base.mean });
  }
  const weighted = (list) => {
    const count = list.reduce((total, item) => total + item.count, 0);
    return count ? { count, mean: list.reduce((total, item) => total + item.count * item.mean, 0) / count } : { count: 0, mean: null };
  };
  // Pool the regime track record: by trend label, and by label within each VIX regime.
  const results = Object.values(byTicker).filter((result) => result.regimes);
  const labels = {};
  for (const label of TREND_REGIMES) {
    labels[label] = weighted(results.map((result) => result.regimes.byLabel[label]).filter((band) => band.count).map((band) => ({ count: band.count, mean: band.mean })));
  }
  const states = {};
  for (const state of REGIME_STATES) {
    const icList = results.map((result) => result.regimes.byState[state].ic).filter(isNum);
    const stateLabels = {};
    for (const label of TREND_REGIMES) {
      stateLabels[label] = weighted(results.map((result) => result.regimes.byState[state].labels[label]).filter((band) => band.count).map((band) => ({ count: band.count, mean: band.mean })));
    }
    states[state] = {
      ...weighted(results.map((result) => result.regimes.byState[state]).filter((band) => band.count).map((band) => ({ count: band.count, mean: band.mean }))),
      meanIc: icList.length ? mean(icList) : null,
      icAssets: icList.length,
      labels: stateLabels,
    };
  }
  const span = results.length ? { from: results.map((result) => result.span.from).sort()[0], to: results.map((result) => result.span.to).sort().at(-1) } : null;
  const episodes = span ? regimeEpisodes(regime, span.from, span.to) : null;
  if (episodes) for (const state of REGIME_STATES) Object.assign(states[state], episodes[state]);
  return {
    byTicker,
    summary: {
      labels,
      states,
      span,
      regimeAvailable: Boolean(regime && regime.history && regime.history.dates && regime.history.dates.length),
      assets: ics.length,
      meanIc: ics.length ? mean(ics) : null,
      positiveIc: ics.filter((ic) => ic > 0).length,
      all: weighted(pooled),
      horizon: BACKTEST_CONFIG.horizon,
    },
  };
}
