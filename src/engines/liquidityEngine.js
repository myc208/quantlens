/**
 * liquidityEngine.js: how easily an asset can be traded, from the candles already stored.
 *
 *   averageVolume    20-day average volume, in shares (or coins)
 *   dollarVolume     20-day average traded value, closeₜ × volumeₜ, in the trading currency
 *   amihud           Amihud (2002) illiquidity: mean of |rₜ| ÷ traded valueₜ in USD, shown as
 *                    basis points of price move per US$1 million traded
 *   spreadEstimate   the bid-ask spread can never be narrower than one tick of the exchange's
 *                    price grid: tick ÷ price. Exact where the grid is known (SGX, US); this is
 *                    the figure used for trading costs
 *   rangeSpread      the Corwin–Schultz (2012) estimate from daily highs and lows, shown for
 *                    reference only: in volatile markets it reads volatility as spread and
 *                    overstates it badly for liquid stocks (VOO 0.25%, MU 1.4% on 21 Nov 2026,
 *                    against one-cent ticks worth 0.002%), so it never drives a cost
 *
 * All four use the last 20 completed sessions, whatever the time range. Yahoo's own bid
 * and ask are not used: outside market hours they are stale or empty.
 *
 * Yahoo reports crypto volume in US dollars, not coins, so for crypto the traded value
 * is the volume itself and units are volume ÷ close. Indices are not traded and get N/A.
 */

import { isNum, mean } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';

export const LIQUIDITY_CONFIG = Object.freeze({
  window: 20,                 // sessions
  flagShare: 0.01,            // a position above 1% of the 20-day average volume is flagged
  capShare: 0.05,             // and never sized above 5% of it
  thinDays: 3,                // zero-volume sessions in the window that mark thin trading
  // SGX minimum bid sizes: below S$0.20, S$0.001; below S$1.00, S$0.005; from S$1.00, S$0.01.
  sgxTicks: Object.freeze([Object.freeze([0.2, 0.001]), Object.freeze([1, 0.005]), Object.freeze([Infinity, 0.01])]),
  usTick: 0.01,               // US shares and ETFs priced at US$1 or more
  usSubDollarTick: 0.0001,
});

export const LIQUIDITY_METRIC_IDS = Object.freeze(['averageVolume', 'dollarVolume', 'amihud', 'spreadEstimate', 'rangeSpread']);

const LABELS = Object.freeze({
  averageVolume: 'Average volume (20 days)',
  dollarVolume: 'Average traded value (20 days)',
  amihud: 'Amihud illiquidity',
  spreadEstimate: 'Bid-ask spread (at least one tick)',
  rangeSpread: 'Range-based spread (Corwin–Schultz)',
});
const UNITS = Object.freeze({ averageVolume: 'shares', dollarVolume: 'currency', amihud: 'ratio', spreadEstimate: 'pct', rangeSpread: 'pct' });
const FORMULAS = Object.freeze({
  averageVolume: 'Mean of the last 20 daily volumes',
  dollarVolume: 'Mean of closeₜ × volumeₜ over the last 20 sessions',
  amihud: 'ILLIQ = mean(|rₜ| ÷ traded valueₜ in USD) × 10⁶ × 10⁴: basis points of price move per US$1 million traded',
  spreadEstimate: 'Minimum spread = one tick ÷ last close (SGX: S$0.001 below S$0.20, S$0.005 below S$1, S$0.01 from S$1; US: US$0.01)',
  rangeSpread: 'Corwin–Schultz: α = (√(2β) − √β) ÷ (3 − 2√2) − √(γ ÷ (3 − 2√2)), S = 2(eᵅ − 1) ÷ (1 + eᵅ), per two-day window, negatives set to 0, averaged',
});

/** The exchange's minimum price step at this price, or null where it is not modelled. */
export function tickSize(asset, price) {
  if (!asset || !isNum(price) || price <= 0 || asset.assetClass === 'index' || asset.assetClass === 'crypto') return null;
  if (asset.market === 'SG') return LIQUIDITY_CONFIG.sgxTicks.find(([below]) => price < below)[1];
  if (asset.market === 'US') return price >= 1 ? LIQUIDITY_CONFIG.usTick : LIQUIDITY_CONFIG.usSubDollarTick;
  return null; // London's price grid depends on the instrument's liquidity band: not modelled
}

/**
 * Corwin–Schultz two-day spread estimates, negatives set to zero.
 * Before each pair, day 2's range is shifted by any overnight gap beyond day 1's close.
 * @returns {number[]} one estimate per consecutive pair of days
 */
export function corwinSchultz(highs, lows, closes) {
  const k = 3 - 2 * Math.SQRT2;
  const out = [];
  for (let t = 0; t + 1 < highs.length; t += 1) {
    const h0 = highs[t];
    const l0 = lows[t];
    const c0 = closes[t];
    let h1 = highs[t + 1];
    let l1 = lows[t + 1];
    if (![h0, l0, c0, h1, l1].every((value) => isNum(value) && value > 0)) continue;
    if (l1 > c0) {
      const gap = l1 - c0;
      h1 -= gap;
      l1 -= gap;
    } else if (h1 < c0) {
      const gap = c0 - h1;
      h1 += gap;
      l1 += gap;
    }
    const beta = Math.log(h0 / l0) ** 2 + Math.log(h1 / l1) ** 2;
    const gamma = Math.log(Math.max(h0, h1) / Math.min(l0, l1)) ** 2;
    const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / k - Math.sqrt(gamma / k);
    const spread = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
    out.push(Math.max(0, spread));
  }
  return out;
}

function toUsd(amount, currency, fxRate) {
  if (!isNum(amount)) return null;
  if (currency === 'USD') return amount;
  if (currency === 'SGD' && isNum(fxRate) && fxRate > 0) return amount / fxRate;
  return null;
}

function unavailable(reason) {
  const metrics = {};
  for (const id of LIQUIDITY_METRIC_IDS) metrics[id] = notAvailable({ id, label: LABELS[id], unit: UNITS[id], formula: FORMULAS[id], reason });
  return { summary: null, metrics };
}

/**
 * @param {object} asset normalised asset (series with high, low, close, volume; currency; market; assetClass)
 * @param {{ fxRate?: number|null }} [options] USD/SGD, to express traded value in US dollars for Amihud
 * @returns {{ summary: { averageVolume, spread, asOf, sessions }|null, metrics: object }}
 */
export function analyzeLiquidity(asset, { fxRate = null } = {}) {
  if (asset.assetClass === 'index') return unavailable('An index is not traded, so it has no volume or spread of its own. A fund that tracks it does.');
  const series = asset.series;
  const count = Math.min(LIQUIDITY_CONFIG.window, series.close.length);
  if (count < LIQUIDITY_CONFIG.window || !Array.isArray(series.volume)) {
    return unavailable(`At least ${LIQUIDITY_CONFIG.window} daily candles with volume are needed.`);
  }
  const start = series.close.length - count;
  const dates = series.dates.slice(start);
  const closes = series.close.slice(start);
  const highs = series.high.slice(start);
  const lows = series.low.slice(start);
  const volumes = series.volume.slice(start).map((value) => (isNum(value) && value > 0 ? value : 0));
  const crypto = asset.assetClass === 'crypto';
  const unitName = crypto ? 'coins' : 'shares';
  const currency = asset.currency;
  // Yahoo's crypto volume is already a traded value in US dollars.
  const units = volumes.map((volume, i) => (crypto ? volume / closes[i] : volume));
  const values = volumes.map((volume, i) => (crypto ? volume : volume * closes[i]));
  const zeroDays = volumes.filter((volume) => volume === 0).length;
  const thin = zeroDays >= LIQUIDITY_CONFIG.thinDays;
  const from = dates[0];
  const to = dates[dates.length - 1];
  const last = closes[closes.length - 1];
  const averageVolume = mean(units);
  const averageValue = mean(values);
  const averageValueUsd = toUsd(averageValue, crypto ? 'USD' : currency, fxRate);
  const windowText = `${count} sessions, ${from} to ${to}`;
  const cryptoNote = crypto ? ' Yahoo reports crypto volume in US dollars, so units are that volume divided by each day\'s close.' : '';
  const metrics = {};

  metrics.averageVolume = traced({
    id: 'averageVolume', label: LABELS.averageVolume, value: averageVolume, unit: 'shares', tone: thin ? 'caution' : 'neutral',
    meta: { unitName, zeroDays, thin, from, to, sessions: count },
    formula: FORMULAS.averageVolume,
    rawInputs: [input('Daily volumes', count, 'sessions', `snapshot candles, ${from} to ${to}`, to)],
    steps: [
      step(`Add the last ${count} daily volumes${crypto ? ' (each divided by that day\'s close)' : ''}`, `Σ volumeₜ`, fmtN(averageVolume * count, 0)),
      step(`Divide by ${count}`, `${fmtN(averageVolume * count, 0)} ÷ ${count}`, fmtN(averageVolume, 0)),
      step('Sessions with no volume at all', `${zeroDays} of ${count}`, zeroDays),
    ],
    interpretation: interpretation(
      `About ${fmtN(averageVolume, 0)} ${unitName} changed hands on an average day over the last ${count} sessions.${thin ? ` ${zeroDays} sessions had no trades at all: thinly traded.` : ''}`,
      [threshold(`Fewer than ${LIQUIDITY_CONFIG.thinDays} zero-volume days`, 'Trades every day', 'neutral'), threshold(`${LIQUIDITY_CONFIG.thinDays} or more`, 'Thinly traded', 'caution')],
      `Volumes are not comparable across assets with very different prices; the traded value is.${cryptoNote}`,
    ),
  });

  let valueTone = 'healthy';
  if (!isNum(averageValueUsd)) valueTone = 'neutral';
  else if (averageValueUsd < 1e6) valueTone = 'risky';
  else if (averageValueUsd < 1e7) valueTone = 'caution';
  metrics.dollarVolume = traced({
    id: 'dollarVolume', label: LABELS.dollarVolume, value: averageValue, unit: 'currency', tone: valueTone,
    meta: { currency: crypto ? 'USD' : currency, usd: averageValueUsd, from, to, sessions: count },
    formula: FORMULAS.dollarVolume,
    rawInputs: [input('Daily closes and volumes', count, 'sessions', `snapshot candles, ${from} to ${to}`, to), ...(currency === 'SGD' ? [input('USD/SGD rate', fxRate, 'SGD per USD', 'snapshot')] : [])],
    steps: [
      step(crypto ? 'Each day\'s traded value is Yahoo\'s volume (already in US dollars)' : 'Each day\'s traded value: close × volume', crypto ? 'volumeₜ' : 'closeₜ × volumeₜ', `${count} values`),
      step(`Average over ${count} sessions`, 'Σ ÷ n', fmtN(averageValue, 0)),
      ...(currency === 'SGD' && isNum(averageValueUsd) ? [step('In US dollars, for comparison', `${fmtN(averageValue, 0)} ÷ ${fmtN(fxRate, 4)}`, fmtN(averageValueUsd, 0))] : []),
    ],
    interpretation: interpretation(
      `On an average day about ${fmtN(averageValueUsd ?? averageValue, 0)} ${isNum(averageValueUsd) ? 'USD' : currency} of ${asset.ticker} traded.`,
      [threshold('US$10M or more a day', 'Liquid', 'healthy'), threshold('US$1M – 10M', 'Modest', 'caution'), threshold('Below US$1M', 'Thin', 'risky')],
      `A rough guide: a position worth a few percent of a day's traded value can usually be bought or sold within the day without moving the price much.${cryptoNote}`,
    ),
  });

  // Amihud: price impact per dollar traded.
  const impacts = [];
  for (let i = 1; i < count; i += 1) {
    const valueUsd = toUsd(values[i], crypto ? 'USD' : currency, fxRate);
    if (isNum(valueUsd) && valueUsd > 0) impacts.push(Math.abs(closes[i] / closes[i - 1] - 1) / valueUsd);
  }
  if (impacts.length < LIQUIDITY_CONFIG.window / 2) {
    metrics.amihud = notAvailable({ id: 'amihud', label: LABELS.amihud, unit: 'ratio', formula: FORMULAS.amihud,
      reason: isNum(fxRate) || currency === 'USD' || crypto ? 'Too few sessions with trading to measure price impact.' : `Traded value cannot be converted from ${currency} to US dollars.` });
  } else {
    const perDollar = mean(impacts);
    const bps = perDollar * 1e6 * 1e4;
    metrics.amihud = traced({
      id: 'amihud', label: LABELS.amihud, value: bps, unit: 'ratio', tone: bps > 1 ? 'caution' : bps > 0.1 ? 'neutral' : 'healthy',
      meta: { perDollar, sessions: impacts.length, from, to },
      formula: FORMULAS.amihud,
      rawInputs: [input('Daily returns and traded values in USD', impacts.length, 'sessions', windowText, to)],
      steps: [
        step('Each day: absolute return ÷ traded value in USD', '|rₜ| ÷ valueₜ', `${impacts.length} values`),
        step('Average them', 'mean', perDollar.toExponential(3)),
        step('Per US$1 million traded, in basis points', `${perDollar.toExponential(3)} × 10⁶ × 10⁴`, fmtN(bps, 3)),
      ],
      interpretation: interpretation(
        `On an average day, each US$1 million traded went with a price move of about ${fmtN(bps, 2)} basis points.`,
        [threshold('Below 0.1 bp', 'Deep market', 'healthy'), threshold('0.1 – 1 bp', 'Normal', 'neutral'), threshold('Above 1 bp', 'Prices move easily', 'caution')],
        'A coarse daily measure: it mixes news-driven moves with genuine price impact, and twenty days is a small sample. Compare assets with it rather than reading the level literally.',
      ),
    });
  }

  // Range-based spread (Corwin–Schultz), for reference only.
  const twoDay = corwinSchultz(highs, lows, closes);
  const rangeEstimate = twoDay.length ? mean(twoDay) : null;
  const positive = twoDay.filter((value) => value > 0).length;
  // The floor that is exact: one tick of the exchange's price grid.
  const tick = tickSize(asset, last);
  const floor = isNum(tick) ? tick / last : null;
  const biasNote = 'Corwin–Schultz assumes a day\'s high-low range is volatility plus the spread. When volatility is high it reads part of the volatility as spread, so for liquid stocks it can be a hundred times the real figure. It is shown for reference and never used for a cost.';

  if (!isNum(floor)) {
    const reading = isNum(rangeEstimate) ? ` The range-based estimate reads ${fmtPct(rangeEstimate, 2)}, but it overstates spreads when volatility is high, so it is not used.` : '';
    let why = 'The price grid of this market is not modelled.';
    if (crypto) why = 'Crypto trades on many venues with fine price steps, so there is no tick floor to rely on.';
    else if (asset.market === 'UK') why = 'London\'s tick size depends on each instrument\'s liquidity band, which is not modelled here.';
    metrics.spreadEstimate = notAvailable({ id: 'spreadEstimate', label: LABELS.spreadEstimate, unit: 'pct', formula: FORMULAS.spreadEstimate, reason: `${why}${reading}` });
  } else {
    let spreadTone = 'healthy';
    if (floor > 0.005) spreadTone = 'risky';
    else if (floor > 0.001) spreadTone = 'caution';
    metrics.spreadEstimate = traced({
      id: 'spreadEstimate', label: LABELS.spreadEstimate, value: floor, unit: 'pct', tone: spreadTone,
      meta: { tick, currency, last, rangeEstimate, asOf: to },
      formula: FORMULAS.spreadEstimate,
      rawInputs: [
        input('Tick size', tick, currency, asset.market === 'SG' ? 'SGX minimum bid size for this price' : 'US minimum price increment'),
        input('Last close', last, currency, 'snapshot candles', to),
      ],
      steps: [
        step(`One tick at a price of ${fmtN(last, 2)} ${currency}`, asset.market === 'SG' ? 'SGX table' : 'US$0.01 from US$1', `${fmtN(tick, 3)} ${currency}`),
        step('As a share of the price', `${fmtN(tick, 4)} ÷ ${fmtN(last)}`, fmtPct(floor, 3)),
        ...(isNum(rangeEstimate) ? [step('For reference: the range-based estimate (not used)', 'Corwin–Schultz, last 20 sessions', fmtPct(rangeEstimate, 3))] : []),
      ],
      interpretation: interpretation(
        `Buying at the ask and selling at the bid costs at least ${fmtPct(floor, floor < 0.0001 ? 4 : 2)} of the position: one tick of ${fmtN(tick, 3)} ${currency} on a ${fmtN(last, 2)} price.`,
        [threshold('Up to 0.10%', 'Tight', 'healthy'), threshold('0.10% – 0.50%', 'Noticeable', 'caution'), threshold('Above 0.50%', 'Wide', 'risky')],
        `A floor, not a quote: the real spread is at least this, and wider in a fast or thin market. For low-priced SGX shares the tick itself is the main trading cost. ${biasNote}`,
      ),
    });
  }

  if (!isNum(rangeEstimate)) {
    metrics.rangeSpread = notAvailable({ id: 'rangeSpread', label: LABELS.rangeSpread, unit: 'pct', formula: FORMULAS.rangeSpread, reason: 'No usable daily highs and lows.' });
  } else {
    metrics.rangeSpread = traced({
      id: 'rangeSpread', label: LABELS.rangeSpread, value: rangeEstimate, unit: 'pct', tone: 'neutral',
      meta: { pairs: twoDay.length, positivePairs: positive, tickFloor: floor, multipleOfTick: isNum(floor) && floor > 0 ? rangeEstimate / floor : null, from, to },
      formula: FORMULAS.rangeSpread,
      rawInputs: [input('Daily highs, lows and closes', count, 'sessions', windowText, to)],
      steps: [
        step('Two-day estimates, overnight gaps removed', `${twoDay.length} pairs`, `${positive} above zero, ${twoDay.length - positive} set to zero`),
        step('Average', 'mean of the two-day estimates', fmtPct(rangeEstimate, 3)),
        ...(isNum(floor) && floor > 0 ? [step('Compared with the one-tick floor', `${fmtPct(rangeEstimate, 3)} ÷ ${fmtPct(floor, 3)}`, `${fmtN(rangeEstimate / floor, 1)}×`)] : []),
      ],
      interpretation: interpretation(`From daily highs and lows alone, the spread would be about ${fmtPct(rangeEstimate, 2)}.`, [], biasNote),
    });
  }

  return { summary: { averageVolume, spread: floor, tick, asOf: to, sessions: count, unitName }, metrics };
}
