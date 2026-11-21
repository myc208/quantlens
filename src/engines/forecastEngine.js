/**
 * forecastEngine.js: turns the snapshot's forecast block into traced metrics.
 *
 * The pipeline fits a small Prophet model to log(close) (trend plus weekly
 * seasonality, no MCMC), anchors the projection to the last close and stores
 * 30 calendar days of estimates with an 80% band. It also hides the last 30
 * days from a second fit and records how far that projection was from what
 * actually happened.
 *
 * This engine reports two things and is blunt about the second:
 *
 *   forecast30d       projected change = last projected price ÷ last close − 1
 *   forecastBacktest  the model's own recent miss (MAPE), next to the miss of
 *                     simply assuming the price would not move
 *
 * A trend model cannot foresee news. The projection is an extrapolation with a
 * measured track record, shown for context. It is not part of any score.
 */

import { isNum, safeDiv } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct,
} from '../core/derivationTracer.js';

const FORECAST_FORMULA = 'Projected change = projected price on the last forecast day ÷ last close − 1';
const BACKTEST_FORMULA = 'MAPE = mean of |projected − actual| ÷ actual over the held-out days';

function emptySeries() {
  return { dates: [], yhat: [], lower: [], upper: [] };
}

function describeModel(forecast) {
  const config = forecast.config ?? {};
  const parts = [forecast.model ?? 'model'];
  if (forecast.modelVersion) parts.push(forecast.modelVersion);
  const traits = [];
  if (config.target) traits.push(`fitted to ${config.target}`);
  if (config.weeklySeasonality) traits.push('weekly seasonality');
  if (config.yearlySeasonality === false) traits.push('no yearly seasonality');
  if (config.mcmcSamples === 0) traits.push('no MCMC');
  return `${parts.join(' ')}${traits.length ? ` (${traits.join(', ')})` : ''}`;
}

/**
 * @param {object} asset normalised asset from snapshotService (needs ticker, currency, quote, forecast)
 * @returns {{
 *   ticker:string, status:string, note:string|null, aligned:boolean,
 *   anchor:{ date:string, close:number }, series:{ dates:string[], yhat:number[], lower:number[], upper:number[] },
 *   metrics:{ forecast30d:object, forecastBacktest:object }
 * }}
 */
export function analyzeForecast(asset) {
  const forecast = asset.forecast ?? { status: 'unavailable', series: emptySeries(), note: null };
  const { currency } = asset;
  const anchor = { date: asset.quote.asOf, close: asset.quote.lastClose };
  const series = forecast.series ?? emptySeries();
  const count = series.dates.length;

  const unavailable = (reason) => ({
    ticker: asset.ticker,
    status: 'unavailable',
    note: forecast.note ?? null,
    aligned: false,
    anchor,
    series: emptySeries(),
    metrics: {
      forecast30d: notAvailable({ id: 'forecast30d', label: '30-day projection', unit: 'pct', formula: FORECAST_FORMULA, reason }),
      forecastBacktest: notAvailable({ id: 'forecastBacktest', label: 'Projection track record', unit: 'pct', formula: BACKTEST_FORMULA, reason }),
    },
  });

  if (forecast.status === 'unavailable' || count === 0) {
    return unavailable(forecast.note || 'No price projection is available for this asset.');
  }
  // A projection must start after the candle it was anchored to. If the prices have moved on
  // without it (a carried-over forecast), drawing it would put a line in the wrong place.
  if (series.dates[0] <= anchor.date) {
    return unavailable(`The stored projection starts on ${series.dates[0]}, which is not after the latest candle (${anchor.date}). It was made for older prices and is not shown.`);
  }

  const trainedTo = forecast.trainedOn && typeof forecast.trainedOn.to === 'string' ? forecast.trainedOn.to : null;
  const aligned = trainedTo === null || trainedTo === anchor.date;
  const stale = forecast.status === 'stale' || !aligned;
  const endDate = series.dates[count - 1];
  const endPrice = series.yhat[count - 1];
  const endLower = series.lower[count - 1];
  const endUpper = series.upper[count - 1];
  const change = safeDiv(endPrice - anchor.close, anchor.close);
  const lowerChange = safeDiv(endLower - anchor.close, anchor.close);
  const upperChange = safeDiv(endUpper - anchor.close, anchor.close);
  if (change === null) return unavailable('The projection could not be compared with the last close.');

  const config = forecast.config ?? {};
  const horizon = forecast.horizon ?? {};
  const backtest = forecast.backtest ?? {};
  const days = isNum(horizon.calendarDays) ? horizon.calendarDays : 30;
  const bandWidth = isNum(config.intervalWidth) ? config.intervalWidth : 0.8;
  const hasBacktest = isNum(backtest.mape) && isNum(backtest.naiveMape);
  const beatsNaive = hasBacktest ? backtest.mape < backtest.naiveMape : null;
  const signed = (value, digits = 1) => `${value >= 0 ? '+' : ''}${fmtPct(value, digits)}`;

  /* ---- the projection ---- */
  let projectionCaveat = 'This is a trend extrapolation, not a prediction. The model sees only past prices: it knows nothing about earnings, news or interest rates, and it is not part of any score.';
  if (hasBacktest) {
    projectionCaveat = beatsNaive
      ? `${projectionCaveat} In its last test it was slightly closer than assuming no change at all (${fmtPct(backtest.mape)} against ${fmtPct(backtest.naiveMape)}).`
      : `${projectionCaveat} In its last test it did WORSE than simply assuming the price would not move (${fmtPct(backtest.mape)} against ${fmtPct(backtest.naiveMape)}).`;
  }
  if (stale) projectionCaveat = `This projection was not refreshed in the latest run, so it is based on older prices. ${projectionCaveat}`;

  const forecast30d = traced({
    id: 'forecast30d',
    label: `${days}-day projection`,
    value: change,
    unit: 'pct',
    tone: 'neutral', // never coloured as good or bad: the model has not earned that
    meta: {
      currency, endDate, endPrice, endLower, endUpper, lowerChange, upperChange, points: count,
      bandWidth, stale, aligned, beatsNaive, levelGap: isNum(config.levelGap) ? config.levelGap : null,
    },
    formula: FORECAST_FORMULA,
    rawInputs: [
      input('Last close', anchor.close, currency, 'snapshot: last candle', anchor.date),
      input(`Projected price on ${endDate}`, endPrice, currency, `snapshot.forecast.points (${describeModel(forecast)})`, trainedTo ?? anchor.date),
      input(`Lower edge of the ${fmtPct(bandWidth, 0)} band`, endLower, currency, 'snapshot.forecast.points', trainedTo ?? anchor.date),
      input(`Upper edge of the ${fmtPct(bandWidth, 0)} band`, endUpper, currency, 'snapshot.forecast.points', trainedTo ?? anchor.date),
      input('History the model was fitted to', forecast.trainedOn && isNum(forecast.trainedOn.observations) ? forecast.trainedOn.observations : null, 'daily closes', forecast.trainedOn ? `${forecast.trainedOn.from} to ${forecast.trainedOn.to}` : 'not recorded'),
    ],
    steps: [
      step('Projected change to the last forecast day', `${fmtN(endPrice)} ÷ ${fmtN(anchor.close)} − 1`, signed(change, 2)),
      step(`Lower edge of the band, as a change`, `${fmtN(endLower)} ÷ ${fmtN(anchor.close)} − 1`, signed(lowerChange, 2)),
      step(`Upper edge of the band, as a change`, `${fmtN(endUpper)} ÷ ${fmtN(anchor.close)} − 1`, signed(upperChange, 2)),
      isNum(config.levelGap)
        ? step('Anchoring: how far the model\'s fitted trend sat from the last close before the projection was re-based onto it', 'fitted value ÷ last close − 1', signed(config.levelGap, 2))
        : null,
    ],
    interpretation: interpretation(
      `If the recent trend simply continued, the price would be about ${fmtN(endPrice)} ${currency} on ${endDate} (${signed(change)}), with a ${fmtPct(bandWidth, 0)} band of ${signed(lowerChange)} to ${signed(upperChange)}.`,
      [
        threshold('The line', 'Where the fitted trend points', 'neutral'),
        threshold('The band', `Where the model expects ${fmtPct(bandWidth, 0)} of outcomes; see its track record for how often that held`, 'neutral'),
      ],
      projectionCaveat,
    ),
    dependsOn: ['forecastBacktest'],
  });

  /* ---- its track record ---- */
  let forecastBacktest;
  if (!hasBacktest) {
    forecastBacktest = notAvailable({
      id: 'forecastBacktest', label: 'Projection track record', unit: 'pct', formula: BACKTEST_FORMULA,
      reason: backtest.note || 'There was not enough history to hold back a test period for this asset.',
    });
  } else {
    const held = isNum(backtest.holdoutPoints) ? backtest.holdoutPoints : null;
    const holdoutDays = isNum(backtest.holdoutDays) ? backtest.holdoutDays : 30;
    const coverage = isNum(backtest.coverage) ? backtest.coverage : null;
    const direction = typeof backtest.directionCorrect === 'boolean' ? backtest.directionCorrect : null;
    const steps = [
      step(`Hide the last ${holdoutDays} calendar days and refit the same model on what remains`, `${held ?? 'some'} trading days held out`, 'Refit'),
      step('Average size of the miss on those days (MAPE)', 'mean of |projected − actual| ÷ actual', fmtPct(backtest.mape)),
      step('The same measure for "the price will not move"', 'mean of |last known close − actual| ÷ actual', fmtPct(backtest.naiveMape)),
      step('Did the model beat doing nothing?', `${fmtPct(backtest.mape)} < ${fmtPct(backtest.naiveMape)}`, beatsNaive ? 'Yes' : 'No'),
    ];
    if (isNum(backtest.endError)) steps.push(step('Miss on the final held-out day', '(projected − actual) ÷ actual', signed(backtest.endError, 2)));
    if (direction !== null) steps.push(step('Did it get the direction of the move right?', 'sign of projected change against sign of actual change', direction ? 'Yes' : 'No'));
    if (coverage !== null) steps.push(step(`Share of actual prices that fell inside the ${fmtPct(bandWidth, 0)} band`, 'days inside the band ÷ days held out', fmtPct(coverage, 0)));

    let summary = beatsNaive
      ? `Over the last ${holdoutDays} days this model missed by ${fmtPct(backtest.mape)} on average, a little better than assuming no change (${fmtPct(backtest.naiveMape)}).`
      : `Over the last ${holdoutDays} days this model missed by ${fmtPct(backtest.mape)} on average. Assuming the price would not move at all missed by ${fmtPct(backtest.naiveMape)}, so the model added nothing.`;
    if (coverage !== null && coverage + 0.1 < bandWidth) {
      summary += ` Its ${fmtPct(bandWidth, 0)} band held only ${fmtPct(coverage, 0)} of the time, so the band is too narrow.`;
    }
    forecastBacktest = traced({
      id: 'forecastBacktest',
      label: 'Projection track record',
      value: backtest.mape,
      unit: 'pct',
      tone: beatsNaive ? 'neutral' : 'caution',
      meta: { naiveMape: backtest.naiveMape, beatsNaive, endError: isNum(backtest.endError) ? backtest.endError : null, directionCorrect: direction, coverage, holdoutPoints: held, holdoutDays, bandWidth },
      formula: BACKTEST_FORMULA,
      rawInputs: [
        input('Model error (MAPE)', backtest.mape, 'fraction', 'snapshot.forecast.backtest.mape', trainedTo ?? anchor.date),
        input('"No change" error (MAPE)', backtest.naiveMape, 'fraction', 'snapshot.forecast.backtest.naiveMape', trainedTo ?? anchor.date),
        input('Days held out', held, 'trading days', `the last ${holdoutDays} calendar days`),
      ],
      steps,
      interpretation: interpretation(
        summary,
        [
          threshold('Below the "no change" error', 'The model added a little information', 'neutral'),
          threshold('At or above the "no change" error', 'The model added nothing over doing nothing', 'caution'),
        ],
        'One 30-day test is a small sample: a model can look good or bad by luck. It is shown so the projection is never read without its recent record.',
      ),
    });
  }

  return {
    ticker: asset.ticker,
    status: stale ? 'stale' : 'fresh',
    note: forecast.note ?? null,
    aligned,
    anchor,
    series: { dates: [...series.dates], yhat: [...series.yhat], lower: [...series.lower], upper: [...series.upper] },
    metrics: { forecast30d, forecastBacktest },
  };
}
