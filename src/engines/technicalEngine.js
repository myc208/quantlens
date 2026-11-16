/**
 * technicalEngine.js: price-based indicators and the Technical score.
 *
 * All indicators use completed daily candles from the snapshot. Live ticks
 * are never mixed in, so a reading can always be reproduced by hand.
 *
 * Formulas
 *   SMA(n)   mean of the last n closes
 *   EMA(n)   k = 2 / (n + 1); seed = SMA of the first n closes;
 *            EMAₜ = Cₜ·k + EMAₜ₋₁·(1 − k)
 *   MACD     line = EMA12 − EMA26; signal = EMA9(line); histogram = line − signal
 *   RSI(14)  Wilder: first averages are simple means of 14 changes, then
 *            avg = (prev·13 + current) / 14; RSI = 100 − 100 / (1 + avgGain/avgLoss)
 *   ATR(14)  TR = max(H − L, |H − Cₜ₋₁|, |L − Cₜ₋₁|); first ATR = mean of 14 TRs,
 *            then ATR = (prev·13 + TR) / 14
 *
 * Technical score (0..100)
 *   Trend 40%   Close > SMA200 (40 pts) + EMA20 > EMA50 (30) + Close > EMA50 (30)
 *   MACD 25%    line > signal (50) + line > 0 (30) + histogram > 3 bars ago (20)
 *   RSI 20%     piecewise-linear through RSI_ANCHORS
 *   52-week 15% position in the 52-week range × 100
 */

import {
  isNum, safeDiv, sum, stdev, logReturns, maxOf, minOf,
  interpolateAnchors, weightedScore, scoreTone,
} from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, valueOf, fmtN, fmtPct,
} from '../core/derivationTracer.js';

export const TECH_CONFIG = Object.freeze({
  smaPeriods: Object.freeze([50, 200]),
  emaPeriods: Object.freeze([12, 20, 26, 50]),
  macd: Object.freeze({ fast: 12, slow: 26, signal: 9, lookback: 3 }),
  rsiPeriod: 14,
  atrPeriod: 14,
  weights: Object.freeze({ trend: 40, macd: 25, rsi: 20, range: 15 }),
  trendPoints: Object.freeze({ aboveSma200: 40, emaCross: 30, aboveEma50: 30 }),
  macdPoints: Object.freeze({ aboveSignal: 50, aboveZero: 30, rising: 20 }),
  rsiAnchors: Object.freeze([[0, 30], [30, 40], [50, 60], [60, 80], [70, 60], [80, 30], [100, 10]]),
  annualisation: Object.freeze({ equity: 252, crypto: 365 }),
});

const SCORE_THRESHOLDS = [
  threshold('65 – 100', 'Supportive', 'healthy'),
  threshold('45 – 65', 'Mixed', 'neutral'),
  threshold('30 – 45', 'Weak', 'caution'),
  threshold('0 – 30', 'Hostile', 'risky'),
];

/* ------------------------------------------------------------------ */
/* Pure series functions (arrays aligned to the input; null = undefined) */
/* ------------------------------------------------------------------ */

function nulls(length) {
  return new Array(length).fill(null);
}

/** Simple moving average. out[i] is the mean of values[i-period+1 .. i]. */
export function smaSeries(values, period) {
  const out = nulls(values.length);
  if (!Number.isInteger(period) || period <= 0) return out;
  let total = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (isNum(values[i])) {
      total += values[i];
      valid += 1;
    }
    if (i >= period && isNum(values[i - period])) {
      total -= values[i - period];
      valid -= 1;
    }
    if (i >= period - 1 && valid === period) out[i] = total / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values. Leading nulls are skipped, so it can be applied to another
 * indicator (the MACD signal line is an EMA of the MACD line).
 */
export function emaSeries(values, period) {
  const out = nulls(values.length);
  if (!Number.isInteger(period) || period <= 0) return out;
  const start = values.findIndex(isNum);
  if (start < 0) return out;
  const seedIndex = start + period - 1;
  if (seedIndex >= values.length) return out;
  let seed = 0;
  for (let i = start; i <= seedIndex; i += 1) {
    if (!isNum(values[i])) return out;
    seed += values[i];
  }
  seed /= period;
  out[seedIndex] = seed;
  const k = 2 / (period + 1);
  let previous = seed;
  for (let i = seedIndex + 1; i < values.length; i += 1) {
    if (!isNum(values[i])) break;
    previous = values[i] * k + previous * (1 - k);
    out[i] = previous;
  }
  return out;
}

export function macdSeries(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const line = closes.map((_, i) => (isNum(emaFast[i]) && isNum(emaSlow[i]) ? emaFast[i] - emaSlow[i] : null));
  const signal = emaSeries(line, signalPeriod);
  const histogram = line.map((value, i) => (isNum(value) && isNum(signal[i]) ? value - signal[i] : null));
  return { emaFast, emaSlow, line, signal, histogram };
}

/** RSI from Wilder-smoothed averages. Zero average loss gives 100 (50 if nothing moved). */
export function rsiFromAverages(avgGain, avgLoss) {
  if (!isNum(avgGain) || !isNum(avgLoss) || avgGain < 0 || avgLoss < 0) return null;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function rsiSeries(closes, period = 14) {
  const length = closes.length;
  const rsi = nulls(length);
  const avgGain = nulls(length);
  const avgLoss = nulls(length);
  if (!Number.isInteger(period) || period <= 0 || length <= period || !closes.every(isNum)) return { rsi, avgGain, avgLoss };
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  avgGain[period] = gain;
  avgLoss[period] = loss;
  rsi[period] = rsiFromAverages(gain, loss);
  for (let i = period + 1; i < length; i += 1) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    avgGain[i] = gain;
    avgLoss[i] = loss;
    rsi[i] = rsiFromAverages(gain, loss);
  }
  return { rsi, avgGain, avgLoss };
}

/** True range needs the previous close, so trueRange[0] is null. */
export function atrSeries(high, low, close, period = 14) {
  const length = close.length;
  const atr = nulls(length);
  const trueRange = nulls(length);
  const usable = Number.isInteger(period) && period > 0 && length > period
    && high.length === length && low.length === length
    && high.every(isNum) && low.every(isNum) && close.every(isNum);
  if (!usable) return { atr, trueRange };
  for (let i = 1; i < length; i += 1) {
    trueRange[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  let average = 0;
  for (let i = 1; i <= period; i += 1) average += trueRange[i];
  average /= period;
  atr[period] = average;
  for (let i = period + 1; i < length; i += 1) {
    average = (average * (period - 1) + trueRange[i]) / period;
    atr[i] = average;
  }
  return { atr, trueRange };
}

/* ------------------------------------------------------------------ */
/* Traced metrics                                                      */
/* ------------------------------------------------------------------ */

function historyReason(needed, available) {
  return `Needs at least ${needed} daily candles; only ${available} are available.`;
}

function traceSma(ctx, period, series) {
  const { close, dates, last, currency } = ctx;
  const id = `sma${period}`;
  const label = `SMA (${period})`;
  const formula = `SMA(${period}) = (sum of the last ${period} closes) ÷ ${period}`;
  const value = series[last];
  if (!isNum(value)) {
    return notAvailable({ id, label, unit: 'currency', meta: { currency }, formula, reason: historyReason(period, close.length) });
  }
  const first = last - period + 1;
  const total = sum(close.slice(first, last + 1));
  const price = close[last];
  const above = price >= value;
  const gap = safeDiv(price - value, value);
  return traced({
    id, label, value, unit: 'currency', tone: above ? 'healthy' : 'caution', meta: { currency, period },
    formula,
    rawInputs: [
      input(`Sum of the last ${period} closes`, total, currency, `candles ${dates[first]} to ${dates[last]}`, dates[last]),
      input('Number of closes', period, 'days', 'fixed period'),
      input('Latest close', price, currency, 'last candle', dates[last]),
    ],
    steps: [
      step(`Add the ${period} closes from ${dates[first]} to ${dates[last]}`, `C(${dates[first]}) + … + C(${dates[last]})`, total),
      step(`Divide by ${period}`, `${fmtN(total)} ÷ ${period}`, value),
      step('Compare the latest close with the average', `(${fmtN(price)} − ${fmtN(value)}) ÷ ${fmtN(value)}`, `${fmtPct(gap)} ${above ? 'above' : 'below'}`),
    ],
    interpretation: interpretation(
      `The price is ${fmtPct(Math.abs(gap ?? 0))} ${above ? 'above' : 'below'} its ${period}-day average, so the ${period === 200 ? 'long' : 'medium'}-term trend is ${above ? 'up' : 'down'}.`,
      [threshold('Price above the average', 'Uptrend', 'healthy'), threshold('Price below the average', 'Downtrend', 'caution')],
      'Moving averages lag: they confirm a trend after it has started and turn late.',
    ),
  });
}

function traceEma(ctx, period, series) {
  const { close, dates, last, currency } = ctx;
  const id = `ema${period}`;
  const label = `EMA (${period})`;
  const formula = `EMAₜ = Cₜ × k + EMAₜ₋₁ × (1 − k), with k = 2 ÷ (${period} + 1); the first EMA is the SMA of the first ${period} closes`;
  const value = series[last];
  if (!isNum(value)) {
    return notAvailable({ id, label, unit: 'currency', meta: { currency }, formula, reason: historyReason(period + 1, close.length) });
  }
  const k = 2 / (period + 1);
  const seedIndex = series.findIndex(isNum);
  const price = close[last];
  const above = price >= value;
  const recursion = [];
  for (let i = Math.max(seedIndex + 1, last - 2); i <= last; i += 1) {
    recursion.push(step(
      `Update for ${dates[i]}`,
      `${fmtN(close[i])} × ${fmtN(k, 6)} + ${fmtN(series[i - 1])} × ${fmtN(1 - k, 6)}`,
      series[i],
    ));
  }
  return traced({
    id, label, value, unit: 'currency', tone: above ? 'healthy' : 'caution', meta: { currency, period },
    formula,
    rawInputs: [
      input('Smoothing factor k', k, 'ratio', `2 ÷ (${period} + 1)`),
      input(`Seed: SMA of the first ${period} closes`, series[seedIndex], currency, `candles ${dates[seedIndex - period + 1]} to ${dates[seedIndex]}`, dates[seedIndex]),
      input('Previous EMA', series[last - 1], currency, 'previous step of the same recursion', dates[last - 1]),
      input('Latest close', price, currency, 'last candle', dates[last]),
    ],
    steps: [
      step('Smoothing factor', `2 ÷ (${period} + 1)`, k),
      step(`Seed the EMA on ${dates[seedIndex]} with the SMA of the first ${period} closes`, `SMA(${period})`, series[seedIndex]),
      step(`Apply the recursion for every day since (${last - seedIndex} updates); the last ${recursion.length} are shown`, 'EMA = C × k + previous EMA × (1 − k)', series[last]),
      ...recursion,
    ],
    interpretation: interpretation(
      `The latest close (${fmtN(price)}) is ${above ? 'above' : 'below'} the ${period}-day EMA (${fmtN(value)}).`,
      [threshold('Price above the EMA', 'Trend support', 'healthy'), threshold('Price below the EMA', 'Trend resistance', 'caution')],
      'An EMA weights recent prices more heavily than an SMA, so it turns sooner but also gives more false signals.',
    ),
  });
}

function traceMacd(ctx, macd) {
  const { dates, last, currency } = ctx;
  const { fast, slow, signal: signalPeriod, lookback } = TECH_CONFIG.macd;
  const id = 'macd';
  const label = `MACD (${fast}, ${slow}, ${signalPeriod})`;
  const formula = `MACD line = EMA${fast} − EMA${slow}; Signal = EMA${signalPeriod} of the MACD line; Histogram = MACD line − Signal`;
  const line = macd.line[last];
  const signal = macd.signal[last];
  const histogram = macd.histogram[last];
  if (!isNum(line) || !isNum(signal) || !isNum(histogram)) {
    return notAvailable({ id, label, unit: 'currency', meta: { currency }, formula, reason: historyReason(slow + signalPeriod, ctx.close.length), dependsOn: ['ema12', 'ema26'] });
  }
  const earlier = macd.histogram[last - lookback];
  const k = 2 / (signalPeriod + 1);
  const bullish = line > signal;
  let tone = 'neutral';
  if (bullish && line > 0) tone = 'healthy';
  else if (!bullish && line < 0) tone = 'risky';
  else if (!bullish) tone = 'caution';
  return traced({
    id, label, value: histogram, unit: 'currency', tone,
    meta: { currency, line, signal, histogram, histogramEarlier: isNum(earlier) ? earlier : null },
    formula,
    rawInputs: [
      input(`EMA (${fast})`, macd.emaFast[last], currency, 'technicalEngine: ema12', dates[last]),
      input(`EMA (${slow})`, macd.emaSlow[last], currency, 'technicalEngine: ema26', dates[last]),
      input('Previous signal line', macd.signal[last - 1], currency, `EMA${signalPeriod} of the MACD line`, dates[last - 1]),
      input(`Histogram ${lookback} sessions ago`, earlier, currency, 'same calculation', dates[last - lookback]),
    ],
    steps: [
      step('MACD line: fast EMA minus slow EMA', `${fmtN(macd.emaFast[last])} − ${fmtN(macd.emaSlow[last])}`, line),
      step(`Signal line: ${signalPeriod}-day EMA of the MACD line (k = 2 ÷ ${signalPeriod + 1})`, `${fmtN(line)} × ${fmtN(k)} + ${fmtN(macd.signal[last - 1])} × ${fmtN(1 - k)}`, signal),
      step('Histogram: MACD line minus signal line', `${fmtN(line)} − ${fmtN(signal)}`, histogram),
      step(`Is momentum building? Compare with the histogram ${lookback} sessions ago`, `${fmtN(histogram)} vs ${fmtN(earlier)}`, isNum(earlier) ? (histogram > earlier ? 'Rising' : 'Falling') : 'N/A'),
    ],
    interpretation: interpretation(
      `The MACD line is ${bullish ? 'above' : 'below'} its signal line and ${line > 0 ? 'above' : 'below'} zero: momentum is ${bullish ? (line > 0 ? 'positive and confirmed' : 'improving from a weak base') : (line > 0 ? 'fading within an uptrend' : 'negative')}.`,
      [
        threshold('Line > signal and line > 0', 'Bullish momentum', 'healthy'),
        threshold('Line > signal, line < 0', 'Recovering', 'neutral'),
        threshold('Line < signal, line > 0', 'Losing steam', 'caution'),
        threshold('Line < signal and line < 0', 'Bearish momentum', 'risky'),
      ],
      'MACD is built from moving averages, so it lags and whipsaws when the price moves sideways.',
    ),
    dependsOn: ['ema12', 'ema26'],
  });
}

function traceRsi(ctx, rsi) {
  const { close, dates, last, currency } = ctx;
  const period = TECH_CONFIG.rsiPeriod;
  const id = 'rsi14';
  const label = `RSI (${period})`;
  const formula = `RSI = 100 − 100 ÷ (1 + RS), RS = average gain ÷ average loss, Wilder smoothing: avg = (previous avg × ${period - 1} + today) ÷ ${period}`;
  const value = rsi.rsi[last];
  if (!isNum(value)) {
    return notAvailable({ id, label, unit: 'index', formula, reason: historyReason(period + 1, close.length) });
  }
  const change = close[last] - close[last - 1];
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);
  const avgGain = rsi.avgGain[last];
  const avgLoss = rsi.avgLoss[last];
  const hasPrevious = isNum(rsi.avgGain[last - 1]);
  const previousGain = hasPrevious ? rsi.avgGain[last - 1] : null;
  const previousLoss = hasPrevious ? rsi.avgLoss[last - 1] : null;
  const rs = safeDiv(avgGain, avgLoss);
  let tone = 'neutral';
  let reading = 'Momentum is balanced.';
  if (value >= 80) { tone = 'risky'; reading = 'Extremely overbought: buyers are stretched and a pullback is likely.'; }
  else if (value >= 70) { tone = 'caution'; reading = 'Overbought: the move is strong but extended.'; }
  else if (value >= 50) { tone = 'healthy'; reading = 'Healthy upward momentum that is not yet overheated.'; }
  else if (value >= 30) { tone = 'caution'; reading = 'Momentum is weak: sellers have had the upper hand.'; }
  else { tone = 'risky'; reading = 'Oversold: selling has been heavy. A bounce can follow, but the trend is down.'; }
  const smoothing = hasPrevious
    ? [
      step('New average gain (Wilder smoothing)', `(${fmtN(previousGain)} × ${period - 1} + ${fmtN(gain)}) ÷ ${period}`, avgGain),
      step('New average loss (Wilder smoothing)', `(${fmtN(previousLoss)} × ${period - 1} + ${fmtN(loss)}) ÷ ${period}`, avgLoss),
    ]
    : [
      step(`Average gain: simple mean of the first ${period} daily gains`, `sum of gains ÷ ${period}`, avgGain),
      step(`Average loss: simple mean of the first ${period} daily losses`, `sum of losses ÷ ${period}`, avgLoss),
    ];
  return traced({
    id, label, value, unit: 'index', tone, meta: { avgGain, avgLoss },
    formula,
    rawInputs: [
      input('Latest close', close[last], currency, 'last candle', dates[last]),
      input('Previous close', close[last - 1], currency, 'previous candle', dates[last - 1]),
      input('Previous average gain', previousGain, currency, 'Wilder average up to the previous session', dates[last - 1]),
      input('Previous average loss', previousLoss, currency, 'Wilder average up to the previous session', dates[last - 1]),
    ],
    steps: [
      step('Today\'s price change', `${fmtN(close[last])} − ${fmtN(close[last - 1])}`, change),
      step('Split into gain and loss (one of them is zero)', `gain = max(change, 0); loss = max(−change, 0)`, `gain ${fmtN(gain)}, loss ${fmtN(loss)}`),
      ...smoothing,
      step('Relative strength', avgLoss === 0 ? 'average loss is zero' : `${fmtN(avgGain)} ÷ ${fmtN(avgLoss)}`, rs ?? 'No losses in the window'),
      step('Convert to the 0 – 100 index', rs === null ? 'no losses: RSI is 100 by definition (50 if nothing moved)' : `100 − 100 ÷ (1 + ${fmtN(rs)})`, value),
    ],
    interpretation: interpretation(
      reading,
      [
        threshold('Above 80', 'Extremely overbought', 'risky'),
        threshold('70 – 80', 'Overbought', 'caution'),
        threshold('50 – 70', 'Healthy momentum', 'healthy'),
        threshold('30 – 50', 'Weak momentum', 'caution'),
        threshold('Below 30', 'Oversold', 'risky'),
      ],
      'RSI can stay overbought for weeks in a strong uptrend and oversold for weeks in a decline.',
    ),
  });
}

function traceAtr(ctx, atr) {
  const { high, low, close, dates, last, currency } = ctx;
  const period = TECH_CONFIG.atrPeriod;
  const id = 'atr14';
  const label = `ATR (${period})`;
  const formula = `TR = max(H − L, |H − previous C|, |L − previous C|); ATR = (previous ATR × ${period - 1} + TR) ÷ ${period}`;
  const value = atr.atr[last];
  if (!isNum(value)) {
    return notAvailable({ id, label, unit: 'currency', meta: { currency }, formula, reason: historyReason(period + 1, close.length) });
  }
  const previousClose = close[last - 1];
  const range = high[last] - low[last];
  const gapUp = Math.abs(high[last] - previousClose);
  const gapDown = Math.abs(low[last] - previousClose);
  const trueRange = atr.trueRange[last];
  const previousAtr = isNum(atr.atr[last - 1]) ? atr.atr[last - 1] : null;
  return traced({
    id, label, value, unit: 'currency', tone: 'neutral', meta: { currency, trueRange },
    formula,
    rawInputs: [
      input('High', high[last], currency, 'last candle', dates[last]),
      input('Low', low[last], currency, 'last candle', dates[last]),
      input('Previous close', previousClose, currency, 'previous candle', dates[last - 1]),
      input('Previous ATR', previousAtr, currency, 'Wilder average up to the previous session', dates[last - 1]),
    ],
    steps: [
      step('Day range: high minus low', `${fmtN(high[last])} − ${fmtN(low[last])}`, range),
      step('Gap from the previous close to the high', `|${fmtN(high[last])} − ${fmtN(previousClose)}|`, gapUp),
      step('Gap from the previous close to the low', `|${fmtN(low[last])} − ${fmtN(previousClose)}|`, gapDown),
      step('True range: the largest of the three', `max(${fmtN(range)}, ${fmtN(gapUp)}, ${fmtN(gapDown)})`, trueRange),
      previousAtr === null
        ? step(`First ATR: simple mean of the first ${period} true ranges`, `sum of TR ÷ ${period}`, value)
        : step('Wilder smoothing', `(${fmtN(previousAtr)} × ${period - 1} + ${fmtN(trueRange)}) ÷ ${period}`, value),
    ],
    interpretation: interpretation(
      `Over the last ${period} sessions the price has typically moved about ${fmtN(value)} ${currency} per day.`,
      [
        threshold('Low relative to price', 'Calm: a larger position fits the same risk', 'healthy'),
        threshold('High relative to price', 'Violent: positions must be smaller', 'caution'),
      ],
      'ATR measures the size of moves, not their direction. See ATR % to compare assets.',
    ),
  });
}

function traceAtrPct(ctx, atrMetric) {
  const { close, dates, last, currency, assetClass } = ctx;
  const id = 'atrPct';
  const label = 'ATR %';
  const formula = 'ATR % = ATR(14) ÷ latest close';
  const atr = valueOf(atrMetric);
  const value = safeDiv(atr, close[last]);
  if (value === null) {
    return notAvailable({ id, label, unit: 'pct', formula, reason: 'ATR is not available, so it cannot be expressed as a percentage.', dependsOn: ['atr14'] });
  }
  const calm = assetClass === 'crypto' ? 0.03 : 0.02;
  const wild = assetClass === 'crypto' ? 0.06 : 0.04;
  let tone = 'neutral';
  if (value <= calm) tone = 'healthy';
  else if (value >= wild) tone = 'risky';
  else tone = 'caution';
  return traced({
    id, label, value, unit: 'pct', tone,
    formula,
    rawInputs: [
      input('ATR (14)', atr, currency, 'technicalEngine: atr14', dates[last]),
      input('Latest close', close[last], currency, 'last candle', dates[last]),
    ],
    steps: [step('Divide ATR by the latest close', `${fmtN(atr)} ÷ ${fmtN(close[last])}`, fmtPct(value))],
    interpretation: interpretation(
      `A typical day moves the price by about ${fmtPct(value)}.`,
      [
        threshold(`Up to ${fmtPct(calm, 0)}`, 'Calm', 'healthy'),
        threshold(`${fmtPct(calm, 0)} – ${fmtPct(wild, 0)}`, 'Lively', 'caution'),
        threshold(`Above ${fmtPct(wild, 0)}`, 'Very volatile', 'risky'),
      ],
      assetClass === 'crypto' ? 'Crypto trades around the clock and is structurally more volatile than stocks, so its bands are wider.' : null,
    ),
    dependsOn: ['atr14'],
  });
}

function traceVolatility(ctx) {
  const { close, dates, last, assetClass } = ctx;
  const periods = TECH_CONFIG.annualisation[assetClass] ?? TECH_CONFIG.annualisation.equity;
  const id = 'volatility';
  const label = 'Annualised volatility';
  const formula = `Volatility = standard deviation of daily log returns × √${periods}`;
  const returns = logReturns(close);
  const daily = returns ? stdev(returns) : null;
  const value = isNum(daily) ? daily * Math.sqrt(periods) : null;
  if (value === null) {
    return notAvailable({ id, label, unit: 'pct', formula, reason: 'Needs at least three valid daily closes.' });
  }
  let tone = 'caution';
  if (value < 0.25) tone = 'healthy';
  else if (value >= 0.5) tone = 'risky';
  return traced({
    id, label, value, unit: 'pct', tone, meta: { dailyVolatility: daily, observations: returns.length },
    formula,
    rawInputs: [
      input('Daily log returns', returns.length, 'observations', `ln(Cₜ ÷ Cₜ₋₁) for ${dates[0]} to ${dates[last]}`, dates[last]),
      input('Trading periods per year', periods, 'days', assetClass === 'crypto' ? 'crypto trades every day' : 'stock-market convention'),
    ],
    steps: [
      step(`Compute ${returns.length} daily log returns`, 'ln(Cₜ ÷ Cₜ₋₁)', `${returns.length} values`),
      step('Sample standard deviation of those returns', `stdev(${returns.length} returns)`, fmtPct(daily, 3)),
      step('Scale from one day to one year', `${fmtPct(daily, 3)} × √${periods}`, fmtPct(value)),
    ],
    interpretation: interpretation(
      `If the past year is a guide, yearly returns would typically land within about ±${fmtPct(value, 0)} of the average.`,
      [
        threshold('Below 25%', 'Stable', 'healthy'),
        threshold('25% – 50%', 'Elevated', 'caution'),
        threshold('Above 50%', 'High', 'risky'),
      ],
      'Volatility describes the past year. It clusters: calm periods and violent periods both tend to persist.',
    ),
  });
}

function traceRange(ctx) {
  const { high, low, close, dates, last, currency } = ctx;
  const id = 'range52w';
  const label = '52-week range position';
  const formula = 'Position = (Close − 52-week low) ÷ (52-week high − 52-week low)';
  const highest = maxOf(high);
  const lowest = minOf(low);
  const value = safeDiv(close[last] - lowest, highest - lowest);
  if (value === null) {
    return notAvailable({ id, label, unit: 'pct', formula, reason: 'The 52-week high and low are identical, so a position within the range is undefined.' });
  }
  const highDate = dates[high.indexOf(highest)];
  const lowDate = dates[low.indexOf(lowest)];
  let tone = 'caution';
  if (value >= 0.5) tone = 'healthy';
  else if (value < 0.25) tone = 'risky';
  return traced({
    id, label, value, unit: 'pct', tone, meta: { currency, high: highest, low: lowest, highDate, lowDate },
    formula,
    rawInputs: [
      input('Latest close', close[last], currency, 'last candle', dates[last]),
      input('52-week high', highest, currency, `highest high, ${dates[0]} to ${dates[last]}`, highDate),
      input('52-week low', lowest, currency, `lowest low, ${dates[0]} to ${dates[last]}`, lowDate),
    ],
    steps: [
      step('Distance above the low', `${fmtN(close[last])} − ${fmtN(lowest)}`, close[last] - lowest),
      step('Width of the range', `${fmtN(highest)} − ${fmtN(lowest)}`, highest - lowest),
      step('Position within the range', `${fmtN(close[last] - lowest)} ÷ ${fmtN(highest - lowest)}`, fmtPct(value)),
    ],
    interpretation: interpretation(
      `The price sits ${fmtPct(value, 0)} of the way from its 52-week low (${fmtN(lowest)}) to its high (${fmtN(highest)}).`,
      [
        threshold('50% – 100%', 'Upper half: buyers in control', 'healthy'),
        threshold('25% – 50%', 'Lower half', 'caution'),
        threshold('0% – 25%', 'Near the lows', 'risky'),
      ],
      'Prices are adjusted for splits and dividends, so older levels can differ slightly from what was quoted at the time.',
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Sub-scores and the Technical score                                  */
/* ------------------------------------------------------------------ */

function checkStep(text, expression, passed, points) {
  return step(text, expression, passed === null ? 'N/A (not counted)' : `${passed ? 'Yes' : 'No'}: ${passed ? points : 0} of ${points} points`);
}

function traceTrendScore(ctx, metrics) {
  const { close, last, dates, currency } = ctx;
  const points = TECH_CONFIG.trendPoints;
  const price = close[last];
  const sma200 = valueOf(metrics.sma200);
  const ema20 = valueOf(metrics.ema20);
  const ema50 = valueOf(metrics.ema50);
  const checks = [
    { text: 'Is the close above the 200-day SMA?', expression: `${fmtN(price)} > ${fmtN(sma200)}`, passed: sma200 === null ? null : price > sma200, points: points.aboveSma200 },
    { text: 'Is the EMA 20 above the EMA 50?', expression: `${fmtN(ema20)} > ${fmtN(ema50)}`, passed: ema20 === null || ema50 === null ? null : ema20 > ema50, points: points.emaCross },
    { text: 'Is the close above the EMA 50?', expression: `${fmtN(price)} > ${fmtN(ema50)}`, passed: ema50 === null ? null : price > ema50, points: points.aboveEma50 },
  ];
  const counted = checks.filter((check) => check.passed !== null);
  const available = counted.reduce((total, check) => total + check.points, 0);
  const earned = counted.reduce((total, check) => total + (check.passed ? check.points : 0), 0);
  const id = 'trendScore';
  const label = 'Trend score';
  const formula = `Trend = points earned ÷ points available × 100. Close > SMA200: ${points.aboveSma200} pts; EMA20 > EMA50: ${points.emaCross} pts; Close > EMA50: ${points.aboveEma50} pts`;
  const dependsOn = ['sma200', 'ema20', 'ema50'];
  if (available === 0) {
    return notAvailable({ id, label, unit: 'score', formula, reason: 'None of the trend averages could be calculated from the available history.', dependsOn });
  }
  const value = (earned / available) * 100;
  const passedCount = counted.filter((check) => check.passed).length;
  return traced({
    id, label, value, unit: 'score', tone: scoreTone(value), meta: { earned, available },
    formula,
    rawInputs: [
      input('Latest close', price, currency, 'last candle', dates[last]),
      input('SMA (200)', sma200, currency, 'technicalEngine: sma200', dates[last]),
      input('EMA (20)', ema20, currency, 'technicalEngine: ema20', dates[last]),
      input('EMA (50)', ema50, currency, 'technicalEngine: ema50', dates[last]),
    ],
    steps: [
      ...checks.map((check) => checkStep(check.text, check.expression, check.passed, check.points)),
      step('Points earned out of points available', `${earned} ÷ ${available} × 100`, value),
    ],
    interpretation: interpretation(
      `${passedCount} of ${counted.length} trend checks pass.`,
      [
        threshold('100', 'Uptrend on every time frame', 'healthy'),
        threshold('30 – 70', 'Mixed: time frames disagree', 'neutral'),
        threshold('0', 'Downtrend on every time frame', 'risky'),
      ],
      available < 100 ? 'One or more averages are unavailable, so the score uses only the checks that could be made.' : null,
    ),
    dependsOn,
  });
}

function traceMacdScore(ctx, macdMetric) {
  const { dates, last } = ctx;
  const points = TECH_CONFIG.macdPoints;
  const id = 'macdScore';
  const label = 'MACD score';
  const formula = `MACD score = line > signal: ${points.aboveSignal} pts + line > 0: ${points.aboveZero} pts + histogram above ${TECH_CONFIG.macd.lookback} sessions ago: ${points.rising} pts`;
  if (macdMetric.status !== 'ok') {
    return notAvailable({ id, label, unit: 'score', formula, reason: 'MACD is not available.', dependsOn: ['macd'] });
  }
  const { line, signal, histogram, histogramEarlier } = macdMetric.meta;
  const checks = [
    { text: 'Is the MACD line above the signal line?', expression: `${fmtN(line)} > ${fmtN(signal)}`, passed: line > signal, points: points.aboveSignal },
    { text: 'Is the MACD line above zero?', expression: `${fmtN(line)} > 0`, passed: line > 0, points: points.aboveZero },
    { text: `Is the histogram higher than ${TECH_CONFIG.macd.lookback} sessions ago?`, expression: `${fmtN(histogram)} > ${fmtN(histogramEarlier)}`, passed: isNum(histogramEarlier) ? histogram > histogramEarlier : null, points: points.rising },
  ];
  const counted = checks.filter((check) => check.passed !== null);
  const available = counted.reduce((total, check) => total + check.points, 0);
  const earned = counted.reduce((total, check) => total + (check.passed ? check.points : 0), 0);
  const value = (earned / available) * 100;
  return traced({
    id, label, value, unit: 'score', tone: scoreTone(value), meta: { earned, available },
    formula,
    rawInputs: [
      input('MACD line', line, '', 'technicalEngine: macd', dates[last]),
      input('Signal line', signal, '', 'technicalEngine: macd', dates[last]),
      input('Histogram', histogram, '', 'technicalEngine: macd', dates[last]),
      input(`Histogram ${TECH_CONFIG.macd.lookback} sessions ago`, histogramEarlier, '', 'technicalEngine: macd', dates[last - TECH_CONFIG.macd.lookback]),
    ],
    steps: [
      ...checks.map((check) => checkStep(check.text, check.expression, check.passed, check.points)),
      step('Points earned out of points available', `${earned} ÷ ${available} × 100`, value),
    ],
    interpretation: interpretation(
      `${counted.filter((check) => check.passed).length} of ${counted.length} momentum checks pass.`,
      [
        threshold('80 – 100', 'Momentum confirmed', 'healthy'),
        threshold('30 – 70', 'Momentum mixed', 'neutral'),
        threshold('0 – 20', 'Momentum negative', 'risky'),
      ],
    ),
    dependsOn: ['macd'],
  });
}

function traceRsiScore(ctx, rsiMetric) {
  const id = 'rsiScore';
  const label = 'RSI score';
  const anchors = TECH_CONFIG.rsiAnchors;
  const formula = `RSI score = straight-line interpolation through (RSI → score): ${anchors.map(([x, y]) => `${x}→${y}`).join(', ')}`;
  const rsi = valueOf(rsiMetric);
  const result = interpolateAnchors(rsi, anchors);
  if (!result) {
    return notAvailable({ id, label, unit: 'score', formula, reason: 'RSI is not available.', dependsOn: ['rsi14'] });
  }
  const { lower, upper, score } = result;
  const expression = result.position === 'between'
    ? `${lower[1]} + (${fmtN(rsi, 2)} − ${lower[0]}) ÷ (${upper[0]} − ${lower[0]}) × (${upper[1]} − ${lower[1]})`
    : `RSI is at the edge of the scale: score = ${lower[1]}`;
  return traced({
    id, label, value: score, unit: 'score', tone: scoreTone(score),
    formula,
    rawInputs: [input('RSI (14)', rsi, 'index', 'technicalEngine: rsi14', ctx.dates[ctx.last])],
    steps: [
      step('Find the two anchors around the RSI', `RSI ${fmtN(rsi, 2)} lies between ${lower[0]} and ${upper[0]}`, `scores ${lower[1]} and ${upper[1]}`),
      step('Interpolate between them', expression, score),
    ],
    interpretation: interpretation(
      'The score peaks at RSI 60 (steady momentum) and falls away when RSI is very low (weak) or very high (overheated).',
      [
        threshold('RSI 50 – 65', 'Score 60 – 80: steady momentum', 'healthy'),
        threshold('RSI 30 – 50 or 65 – 75', 'Score 40 – 70', 'neutral'),
        threshold('RSI above 80', 'Score 30 or less: overheated', 'risky'),
        threshold('RSI below 30', 'Score 40 or less: weak', 'caution'),
      ],
      'This is a trend-following reading. A contrarian would score oversold readings higher.',
    ),
    dependsOn: ['rsi14'],
  });
}

function traceRangeScore(ctx, rangeMetric) {
  const id = 'rangeScore';
  const label = '52-week position score';
  const formula = '52-week score = range position × 100';
  const position = valueOf(rangeMetric);
  if (position === null) {
    return notAvailable({ id, label, unit: 'score', formula, reason: 'The 52-week range position is not available.', dependsOn: ['range52w'] });
  }
  const value = Math.min(100, Math.max(0, position * 100));
  return traced({
    id, label, value, unit: 'score', tone: scoreTone(value),
    formula,
    rawInputs: [input('52-week range position', position, 'fraction', 'technicalEngine: range52w', ctx.dates[ctx.last])],
    steps: [step('Scale the position to 0 – 100', `${fmtN(position)} × 100`, value)],
    interpretation: interpretation(
      'Closer to the 52-week high scores higher: strength tends to persist.',
      [threshold('Above 50', 'Upper half of the range', 'healthy'), threshold('Below 25', 'Near the lows', 'risky')],
    ),
    dependsOn: ['range52w'],
  });
}

function traceTechnicalScore(ctx, metrics) {
  const weights = TECH_CONFIG.weights;
  const id = 'technicalScore';
  const label = 'Technical score';
  const formula = `Technical = Trend × ${weights.trend}% + MACD × ${weights.macd}% + RSI × ${weights.rsi}% + 52-week position × ${weights.range}% (missing parts are dropped and the rest re-weighted)`;
  const components = [
    { id: 'trendScore', label: 'Trend', weight: weights.trend, score: valueOf(metrics.trendScore) },
    { id: 'macdScore', label: 'MACD', weight: weights.macd, score: valueOf(metrics.macdScore) },
    { id: 'rsiScore', label: 'RSI', weight: weights.rsi, score: valueOf(metrics.rsiScore) },
    { id: 'rangeScore', label: '52-week position', weight: weights.range, score: valueOf(metrics.rangeScore) },
  ];
  const dependsOn = components.map((component) => component.id);
  const result = weightedScore(components);
  if (result.score === null) {
    return notAvailable({
      id, label, unit: 'score', formula, dependsOn, meta: { coverage: result.coverage },
      reason: `Only ${fmtPct(result.coverage, 0)} of the Technical score's inputs could be calculated; at least 50% is required.`,
    });
  }
  const reweighted = result.missing.length > 0;
  return traced({
    id, label, value: result.score, unit: 'score', tone: scoreTone(result.score),
    meta: { coverage: result.coverage, parts: result.parts, missing: result.missing },
    formula,
    rawInputs: components.map((component) => input(`${component.label} score (weight ${component.weight}%)`, component.score, 'score', `technicalEngine: ${component.id}`, ctx.dates[ctx.last])),
    steps: [
      ...result.parts.map((part) => step(
        `${part.label}: score × weight`,
        `${fmtN(part.score, 2)} × ${fmtPct(part.normalisedWeight, 1)}`,
        part.contribution,
      )),
      step('Add the contributions', result.parts.map((part) => fmtN(part.contribution, 2)).join(' + '), result.score),
    ],
    interpretation: interpretation(
      `Price behaviour is ${result.score >= 65 ? 'supportive' : result.score >= 45 ? 'mixed' : 'working against a new position'}.`,
      SCORE_THRESHOLDS,
      reweighted
        ? `Not available and left out: ${result.missing.join(', ')}. The remaining weights were scaled up to total 100%.`
        : 'Volatility is deliberately not scored here; it already shrinks the position size through the ATR stop.',
    ),
    dependsOn,
  });
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute every technical indicator for one asset.
 *
 * @param {object} asset normalised asset from snapshotService (needs series, currency, assetClass)
 * @returns {{ ticker:string, asOf:string|null, metrics:Record<string, object>, series:Record<string, (number|null)[]> }}
 */
export function analyzeTechnicals(asset) {
  const { series } = asset;
  const close = series.close;
  const ctx = {
    close,
    high: series.high,
    low: series.low,
    dates: series.dates,
    last: close.length - 1,
    currency: asset.currency,
    assetClass: asset.assetClass,
  };

  const sma = Object.fromEntries(TECH_CONFIG.smaPeriods.map((period) => [period, smaSeries(close, period)]));
  const ema = Object.fromEntries(TECH_CONFIG.emaPeriods.map((period) => [period, emaSeries(close, period)]));
  const macd = macdSeries(close, TECH_CONFIG.macd.fast, TECH_CONFIG.macd.slow, TECH_CONFIG.macd.signal);
  const rsi = rsiSeries(close, TECH_CONFIG.rsiPeriod);
  const atr = atrSeries(series.high, series.low, close, TECH_CONFIG.atrPeriod);

  const metrics = {};
  for (const period of TECH_CONFIG.smaPeriods) metrics[`sma${period}`] = traceSma(ctx, period, sma[period]);
  for (const period of TECH_CONFIG.emaPeriods) metrics[`ema${period}`] = traceEma(ctx, period, ema[period]);
  metrics.macd = traceMacd(ctx, macd);
  metrics.rsi14 = traceRsi(ctx, rsi);
  metrics.atr14 = traceAtr(ctx, atr);
  metrics.atrPct = traceAtrPct(ctx, metrics.atr14);
  metrics.volatility = traceVolatility(ctx);
  metrics.range52w = traceRange(ctx);
  metrics.trendScore = traceTrendScore(ctx, metrics);
  metrics.macdScore = traceMacdScore(ctx, metrics.macd);
  metrics.rsiScore = traceRsiScore(ctx, metrics.rsi14);
  metrics.rangeScore = traceRangeScore(ctx, metrics.range52w);
  metrics.technicalScore = traceTechnicalScore(ctx, metrics);

  return {
    ticker: asset.ticker,
    asOf: series.dates[ctx.last] ?? null,
    metrics,
    series: {
      sma50: sma[50],
      sma200: sma[200],
      ema20: ema[20],
      ema50: ema[50],
      macdLine: macd.line,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
      rsi14: rsi.rsi,
      atr14: atr.atr,
    },
  };
}
