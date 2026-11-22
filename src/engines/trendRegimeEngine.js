/**
 * trendRegimeEngine.js: where the price stands against its own averages (V3.3).
 *
 *   Uptrend     close ≥ SMA200 and EMA20 ≥ EMA50
 *   Extended    close ≥ SMA200 and RSI(14) > 70        (checked before the EMA test)
 *   Pullback    close ≥ SMA200 but EMA20 < EMA50
 *   Recovering  close < SMA200 but EMA20 ≥ EMA50
 *   Downtrend   close < SMA200 and EMA20 < EMA50
 *
 * A description, not a forecast. Over 2022–2026 no price-only signal (this score, the
 * 200-day trend, 12-1 or volatility-adjusted momentum) predicted 21- or 63-day returns on
 * the watchlist, so QuantLens shows the trend state and publishes what followed each one,
 * rather than BUY, HOLD or SELL.
 *
 * The same function labels the live asset (from technicalEngine's metrics) and every day of
 * the backtest replay (from technicalScoreAt), so the replay's last day reproduces today.
 */

import { isNum, safeDiv } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';

export const TREND_CONFIG = Object.freeze({ extendedRsi: 70 });
export const TREND_REGIMES = Object.freeze(['Uptrend', 'Extended', 'Pullback', 'Recovering', 'Downtrend']);

const TONES = Object.freeze({ Uptrend: 'healthy', Extended: 'caution', Pullback: 'neutral', Recovering: 'neutral', Downtrend: 'risky' });
const SUMMARIES = Object.freeze({
  Uptrend: 'Above its 200-day average, with the shorter averages pointing up.',
  Extended: 'Above its 200-day average and stretched: RSI above 70 after a strong run.',
  Pullback: 'Still above its 200-day average, but the shorter averages have turned down.',
  Recovering: 'Below its 200-day average, but the shorter averages have turned up.',
  Downtrend: 'Below its 200-day average, with the shorter averages pointing down.',
});

/**
 * The trend regime for one day, or null when the 200-day average or the EMAs are not yet defined.
 * @param {{ close:number, sma200:number|null, ema20:number|null, ema50:number|null, rsi:number|null }} point
 */
export function classifyTrend({ close, sma200, ema20, ema50, rsi }) {
  if (!isNum(close) || !isNum(sma200) || !isNum(ema20) || !isNum(ema50)) return null;
  if (close >= sma200) {
    if (isNum(rsi) && rsi > TREND_CONFIG.extendedRsi) return 'Extended';
    return ema20 >= ema50 ? 'Uptrend' : 'Pullback';
  }
  return ema20 >= ema50 ? 'Recovering' : 'Downtrend';
}

/**
 * The traced trend-regime metric of an asset.
 * @param {{ ticker:string, currency:string }} asset
 * @param {{ close:number, sma200:number|null, ema20:number|null, ema50:number|null, rsi:number|null, asOf:string|null }} values
 */
export function traceTrendRegime(asset, values) {
  const id = 'trendRegime';
  const label = 'Trend regime';
  const formula = 'Close vs SMA 200, then RSI(14) > 70 (Extended), then EMA 20 vs EMA 50';
  const regime = classifyTrend(values);
  if (!regime) {
    return notAvailable({ id, label, unit: 'label', formula, dependsOn: ['sma200', 'ema20', 'ema50', 'rsi14'],
      reason: 'At least 200 daily closes are needed for the 200-day average.' });
  }
  const { close, sma200, ema20, ema50, rsi, asOf } = values;
  const above = close >= sma200;
  const distance = safeDiv(close - sma200, sma200);
  const extended = above && isNum(rsi) && rsi > TREND_CONFIG.extendedRsi;
  const ccy = asset.currency;
  const steps = [
    step('Is the close at or above the 200-day average?', `${fmtN(close)} ≥ ${fmtN(sma200)}`, above ? `yes (${fmtPct(distance, 1)} above)` : `no (${fmtPct(-distance, 1)} below)`),
  ];
  if (above) steps.push(step(`Is RSI(14) above ${TREND_CONFIG.extendedRsi}?`, isNum(rsi) ? `${fmtN(rsi, 1)} > ${TREND_CONFIG.extendedRsi}` : 'RSI not available', extended ? 'yes: Extended' : 'no'));
  if (!extended) steps.push(step('Is the EMA 20 at or above the EMA 50?', `${fmtN(ema20)} ≥ ${fmtN(ema50)}`, ema20 >= ema50 ? 'yes' : 'no'));
  steps.push(step('Trend regime', regime, regime));
  return traced({
    id, label, value: regime, unit: 'label', tone: TONES[regime],
    meta: { regime, close, sma200, ema20, ema50, rsi, distance200: distance, above200: above },
    formula,
    rawInputs: [
      input('Close', close, ccy, 'snapshot candles', asOf),
      input('SMA (200)', sma200, ccy, 'technicalEngine: sma200', asOf),
      input('EMA (20)', ema20, ccy, 'technicalEngine: ema20', asOf),
      input('EMA (50)', ema50, ccy, 'technicalEngine: ema50', asOf),
      input('RSI (14)', rsi, 'index', 'technicalEngine: rsi14', asOf),
    ],
    steps,
    interpretation: interpretation(
      SUMMARIES[regime],
      [
        threshold('Above SMA 200, EMA 20 ≥ EMA 50', 'Uptrend', 'healthy'),
        threshold(`Above SMA 200, RSI > ${TREND_CONFIG.extendedRsi}`, 'Extended', 'caution'),
        threshold('Above SMA 200, EMA 20 < EMA 50', 'Pullback', 'neutral'),
        threshold('Below SMA 200, EMA 20 ≥ EMA 50', 'Recovering', 'neutral'),
        threshold('Below SMA 200, EMA 20 < EMA 50', 'Downtrend', 'risky'),
      ],
      'A description of where the price stands, not a forecast or a recommendation. The regime track record shows what followed each label on this asset; over 2022–2026 no label, and no simple trend or momentum signal, predicted the next month on this watchlist.',
    ),
    dependsOn: ['sma200', 'ema20', 'ema50', 'rsi14'],
  });
}
