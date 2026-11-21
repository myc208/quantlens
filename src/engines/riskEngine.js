/**
 * riskEngine.js: empirical risk measures for the selected time range.
 *
 *   EWMA volatility    σ²ₜ = λσ²ₜ₋₁ + (1 − λ)r²ₜ₋₁, λ = 0.94 (RiskMetrics). Reacts to the
 *                      most recent weeks instead of weighting every day of the window equally.
 *   Historical VaR     the loss exceeded on the worst 5% (or 1%) of days in the window,
 *                      read straight from the actual returns: no normal-distribution assumption.
 *   CVaR               the average loss on those worst days ("expected shortfall").
 *   10-day VaR/CVaR    the same, from overlapping 10-day returns.
 *
 * Also the building blocks the other engines share:
 *   filteredResiduals  past log returns divided by the EWMA volatility of their day, for the
 *                      Monte Carlo's filtered bootstrap (real shapes, today's volatility)
 *   weeklyCloses       the last close of each Friday-ending week, for pairs of markets that
 *                      close at different times
 *   ledoitWolf         shrinkage of a sample covariance toward a constant-correlation target
 *                      (Ledoit and Wolf, 2004)
 *
 * Every function returns finite numbers or null; every metric is traced.
 */

import { isNum, safeDiv, mean, stdev, percentile, logReturns } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, valueOf, fmtN, fmtPct,
} from '../core/derivationTracer.js';

export const RISK_CONFIG = Object.freeze({
  lambda: 0.94,          // RiskMetrics decay: today's squared return carries 6% of the weight
  ewmaSeed: 20,          // returns averaged to start the recursion
  minEwmaReturns: 30,
  var95Min: 100,         // returns needed before a 95% tail (5 days) means anything
  var99Min: 250,         // and before a 99% tail (2-3 days)
  horizonDays: 10,       // the regulatory "10-day" holding period
  annualisation: Object.freeze({ equity: 252, crypto: 365 }),
  minWeeklyReturns: 15,
});

const SESSION_NAMES = Object.freeze({ US: 'US', SG: 'Singapore', UK: 'London', CRYPTO: 'crypto (24/7)' });

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/** Simple returns Cₜ ÷ Cₜ₋₁ − 1 over `step` sessions (1 = daily, 10 = overlapping 10-day). */
export function periodReturns(closes, stepSize = 1) {
  if (!Array.isArray(closes) || closes.length <= stepSize) return null;
  const out = [];
  for (let i = stepSize; i < closes.length; i += 1) {
    const now = closes[i];
    const before = closes[i - stepSize];
    if (!isNum(now) || !isNum(before) || before <= 0 || now <= 0) return null;
    out.push(now / before - 1);
  }
  return out;
}

/**
 * EWMA variance of a return series. The recursion starts from the mean squared
 * return of the first `seedCount` days (zero-mean, as in RiskMetrics); each later
 * day gets the forecast made before it was seen.
 * @returns {{ forecasts:(number|null)[], next:number, seedCount:number } | null}
 */
export function ewmaVariance(returns, lambda = RISK_CONFIG.lambda, seedCount = RISK_CONFIG.ewmaSeed) {
  if (!Array.isArray(returns) || returns.length <= seedCount || !returns.every(isNum) || !(lambda > 0 && lambda < 1)) return null;
  let variance = returns.slice(0, seedCount).reduce((total, r) => total + r * r, 0) / seedCount;
  const forecasts = new Array(returns.length).fill(null);
  for (let t = seedCount; t < returns.length; t += 1) {
    forecasts[t] = variance;
    variance = lambda * variance + (1 - lambda) * returns[t] * returns[t];
  }
  return isNum(variance) && variance >= 0 ? { forecasts, next: variance, seedCount } : null;
}

/**
 * Historical value at risk and expected shortfall at a confidence level.
 * Losses are positive fractions: VaR 0.042 means "a fall of 4.2%".
 * @returns {{ var:number, cvar:number, quantile:number, tail:number, count:number } | null}
 */
export function historicalVar(returns, level) {
  if (!Array.isArray(returns) || returns.length < 2 || !returns.every(isNum) || !(level > 0 && level < 1)) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const quantile = percentile(sorted, 1 - level);
  if (!isNum(quantile)) return null;
  const tail = sorted.filter((r) => r <= quantile);
  const shortfall = mean(tail);
  if (!isNum(shortfall)) return null;
  return { var: -quantile, cvar: -shortfall, quantile, tail: tail.length, count: sorted.length };
}

/**
 * Log returns standardised by the EWMA volatility forecast of their own day:
 * zₜ = rₜ ÷ σₜ. Rescaling them by today's σ gives returns with the past's shapes
 * (fat tails, skew) at today's level of volatility: filtered historical simulation.
 * @returns {{ residuals:number[], sigmaNow:number, sigmaSample:number, meanLogReturn:number, returns:number } | null}
 */
export function filteredResiduals(closes, lambda = RISK_CONFIG.lambda, seedCount = RISK_CONFIG.ewmaSeed) {
  const returns = logReturns(closes);
  if (!returns) return null;
  const ewma = ewmaVariance(returns, lambda, seedCount);
  if (!ewma) return null;
  const residuals = [];
  for (let t = seedCount; t < returns.length; t += 1) {
    const sigma = Math.sqrt(ewma.forecasts[t]);
    if (sigma > 0) residuals.push(returns[t] / sigma);
  }
  const sigmaSample = stdev(returns);
  const meanLogReturn = mean(returns);
  if (!residuals.length || !isNum(sigmaSample) || !isNum(meanLogReturn)) return null;
  return { residuals, sigmaNow: Math.sqrt(ewma.next), sigmaSample, meanLogReturn, returns: returns.length };
}

/** The Friday that ends the week of an ISO date (weekend days belong to the following week). */
export function weekKey(isoDate) {
  const time = Date.parse(`${isoDate}T00:00:00Z`);
  const day = new Date(time).getUTCDay(); // 0 Sunday ... 5 Friday, 6 Saturday
  const ahead = (5 - day + 7) % 7;
  return new Date(time + ahead * 86400000).toISOString().slice(0, 10);
}

/** The last close of each Friday-ending week, keyed by that Friday. */
export function weeklyCloses(series) {
  if (!series || !Array.isArray(series.dates)) return { dates: [], close: [] };
  const byWeek = new Map();
  for (let i = 0; i < series.dates.length; i += 1) {
    if (isNum(series.close[i]) && series.close[i] > 0) byWeek.set(weekKey(series.dates[i]), series.close[i]);
  }
  const dates = [...byWeek.keys()].sort();
  return { dates, close: dates.map((date) => byWeek.get(date)) };
}

/** True when two markets close at different times, so their daily closes are not simultaneous. */
export function differentSessions(marketA, marketB) {
  return marketA !== marketB;
}

export function sessionName(market) {
  return SESSION_NAMES[market] ?? market;
}

/**
 * Eigenvalues and eigenvectors of a small symmetric matrix (cyclic Jacobi rotations).
 * Exact to rounding for the at most 8 × 8 covariance matrices used here, with no
 * dependency. Values are sorted largest first; `vectors[k]` is the unit eigenvector
 * of `values[k]`.
 * @param {number[][]} matrix symmetric
 * @returns {{ values:number[], vectors:number[][], sweeps:number } | null}
 */
export function symmetricEigen(matrix, { tolerance = 1e-14, maxSweeps = 100 } = {}) {
  const n = Array.isArray(matrix) ? matrix.length : 0;
  if (n === 0 || matrix.some((row) => !Array.isArray(row) || row.length !== n || !row.every(isNum))) return null;
  const a = matrix.map((row) => [...row]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
  let sweeps = 0;
  for (; sweeps < maxSweeps; sweeps += 1) {
    let off = 0;
    let diagonal = 0;
    for (let i = 0; i < n; i += 1) {
      diagonal += a[i][i] * a[i][i];
      for (let j = i + 1; j < n; j += 1) off += a[i][j] * a[i][j];
    }
    if (off <= tolerance * tolerance * (diagonal + 2 * off)) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (a[p][q] === 0) continue;
        // Rotate in the (p, q) plane so that a[p][q] becomes zero.
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const kp = a[k][p];
          const kq = a[k][q];
          a[k][p] = c * kp - s * kq;
          a[k][q] = s * kp + c * kq;
        }
        for (let k = 0; k < n; k += 1) {
          const pk = a[p][k];
          const qk = a[q][k];
          a[p][k] = c * pk - s * qk;
          a[q][k] = s * pk + c * qk;
        }
        for (let k = 0; k < n; k += 1) {
          const kp = v[k][p];
          const kq = v[k][q];
          v[k][p] = c * kp - s * kq;
          v[k][q] = s * kp + c * kq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y][y] - a[x][x]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => v.map((row) => row[i])),
    sweeps,
  };
}

/**
 * Ledoit-Wolf shrinkage toward a constant-correlation target ("Honey, I shrunk the
 * sample covariance matrix", 2004). The target keeps every asset's own variance and
 * replaces each correlation by the average one; δ says how far to move toward it,
 * estimated from the data so that the expected error is smallest.
 *
 * @param {number[][]} returnsByAsset equally long return series, one per asset
 * @returns {{ delta:number, meanCorrelation:number|null, target:number[][], sample:number[][], shrunk:number[][] } | null}
 *   `sample`, `target` and `shrunk` use the n − 1 sample covariance, like the rest of the engine.
 */
export function ledoitWolf(returnsByAsset) {
  const n = returnsByAsset.length;
  const length = n ? returnsByAsset[0].length : 0;
  if (n === 0 || length < 3 || returnsByAsset.some((series) => series.length !== length || !series.every(isNum))) return null;
  const means = returnsByAsset.map((series) => mean(series));
  const x = returnsByAsset.map((series, i) => series.map((r) => r - means[i]));

  // Sample covariance with 1/T, as in the paper; δ does not depend on the normalisation.
  const s = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i; j < n; j += 1) {
      let cross = 0;
      for (let t = 0; t < length; t += 1) cross += x[i][t] * x[j][t];
      s[i][j] = cross / length;
      s[j][i] = s[i][j];
    }
  }
  const scale = length / (length - 1);
  const sample = s.map((row) => row.map((value) => value * scale));
  const sd = s.map((row, i) => Math.sqrt(row[i]));
  if (sd.some((value) => !(value > 0))) return null;

  if (n < 2) return { delta: 0, meanCorrelation: null, target: sample, sample, shrunk: sample };
  let correlationSum = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j) correlationSum += s[i][j] / (sd[i] * sd[j]);
  const rBar = correlationSum / (n * (n - 1));
  const targetT = s.map((row, i) => row.map((value, j) => (i === j ? value : rBar * sd[i] * sd[j])));

  // π: the asymptotic variance of the sample covariances; ρ: their covariance with the target.
  let pi = 0;
  let piDiagonal = 0;
  let thetaTerm = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let phi = 0;
      let theta = 0;
      for (let t = 0; t < length; t += 1) {
        const product = x[i][t] * x[j][t] - s[i][j];
        phi += product * product;
        theta += (x[i][t] * x[i][t] - s[i][i]) * product;
      }
      phi /= length;
      theta /= length;
      pi += phi;
      if (i === j) piDiagonal += phi;
      else thetaTerm += (sd[j] / sd[i]) * theta;
    }
  }
  const rho = piDiagonal + rBar * thetaTerm;
  let gamma = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) gamma += (targetT[i][j] - s[i][j]) ** 2;
  // With two assets (or a matrix already at the target) the target equals the sample: nothing to shrink.
  const delta = gamma > 1e-30 ? Math.max(0, Math.min(1, (pi - rho) / gamma / length)) : 0;

  // Build the upper triangle and mirror it: a covariance matrix must be exactly symmetric.
  const target = sample.map((row) => row.slice());
  const shrunk = sample.map((row) => row.slice());
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      target[i][j] = targetT[i][j] * scale;
      target[j][i] = target[i][j];
      shrunk[i][j] = delta * target[i][j] + (1 - delta) * sample[i][j];
      shrunk[j][i] = shrunk[i][j];
    }
  }
  return isNum(delta) ? { delta, meanCorrelation: rBar, target, sample, shrunk } : null;
}

/* ------------------------------------------------------------------ */
/* Traced metrics for one asset and window                             */
/* ------------------------------------------------------------------ */

const VOL_THRESHOLDS = [threshold('Below 25%', 'Stable', 'healthy'), threshold('25% – 50%', 'Elevated', 'caution'), threshold('Above 50%', 'High', 'risky')];

function volatilityTone(volatility) {
  if (volatility < 0.25) return 'healthy';
  return volatility < 0.5 ? 'caution' : 'risky';
}

function lossTone(loss, horizon) {
  const scaled = horizon === 1 ? loss : loss / Math.sqrt(horizon);
  if (scaled < 0.02) return 'healthy';
  return scaled < 0.04 ? 'caution' : 'risky';
}

function buildEwma(asset, closes, dates, rangeLabel) {
  const id = 'ewmaVolatility';
  const label = 'EWMA volatility (annualised)';
  const periods = RISK_CONFIG.annualisation[asset.assetClass] ?? RISK_CONFIG.annualisation.equity;
  const formula = `σ²ₜ = ${RISK_CONFIG.lambda} × σ²ₜ₋₁ + ${fmtN(1 - RISK_CONFIG.lambda, 2)} × r²ₜ₋₁; annualised volatility = σ × √${periods}`;
  const returns = logReturns(closes);
  if (!returns || returns.length < RISK_CONFIG.minEwmaReturns) {
    return notAvailable({ id, label, unit: 'pct', formula, reason: `At least ${RISK_CONFIG.minEwmaReturns} daily returns are needed; this window has ${returns ? returns.length : 0}.` });
  }
  const ewma = ewmaVariance(returns);
  const sample = stdev(returns);
  if (!ewma || !isNum(sample)) return notAvailable({ id, label, unit: 'pct', formula, reason: 'The returns in this window could not be used.' });
  const daily = Math.sqrt(ewma.next);
  const value = daily * Math.sqrt(periods);
  const flat = sample * Math.sqrt(periods);
  const ratio = safeDiv(value, flat);
  const halfLife = Math.log(0.5) / Math.log(RISK_CONFIG.lambda);
  return traced({
    id, label, value, unit: 'pct', tone: volatilityTone(value),
    meta: { daily, flat, ratio, lambda: RISK_CONFIG.lambda, returns: returns.length, halfLifeDays: halfLife },
    formula,
    rawInputs: [
      input('Daily log returns', returns.length, 'observations', `${dates[0]} to ${dates[dates.length - 1]}`, dates[dates.length - 1]),
      input('Decay λ', RISK_CONFIG.lambda, '', 'RiskMetrics convention'),
      input('Starting variance', returns.slice(0, RISK_CONFIG.ewmaSeed).reduce((t, r) => t + r * r, 0) / RISK_CONFIG.ewmaSeed, '', `mean squared return of the first ${RISK_CONFIG.ewmaSeed} days`),
    ],
    steps: [
      step('Update the variance every day, giving the newest squared return 6% of the weight', `σ² ← ${RISK_CONFIG.lambda} × σ² + ${fmtN(1 - RISK_CONFIG.lambda, 2)} × r²`, `${returns.length - RISK_CONFIG.ewmaSeed} updates`),
      step("Tomorrow's daily volatility", `√σ²`, fmtPct(daily, 3)),
      step('Annualise', `${fmtPct(daily, 3)} × √${periods}`, fmtPct(value)),
      step('Compare with the equal-weighted volatility of the same window', `stdev × √${periods} = ${fmtPct(flat)}`, ratio === null ? 'N/A' : `${fmtN(ratio, 2)}×`),
    ],
    interpretation: interpretation(
      ratio !== null && ratio > 1.15
        ? `Volatility is running hot: recent weeks point to ${fmtPct(value, 0)} a year, above the ${fmtPct(flat, 0)} average of the last ${rangeLabel}.`
        : ratio !== null && ratio < 0.85
          ? `Recent weeks have been calmer: ${fmtPct(value, 0)} a year, below the ${fmtPct(flat, 0)} average of the last ${rangeLabel}.`
          : `Recent volatility of ${fmtPct(value, 0)} a year is close to the ${fmtPct(flat, 0)} average of the last ${rangeLabel}.`,
      VOL_THRESHOLDS,
      `Half of the weight sits on the last ${fmtN(halfLife, 0)} trading days. It adapts quickly, which also makes it jumpy after a single large move.`,
    ),
  });
}

function buildTail(asset, closes, dates, rangeLabel, { level, horizon, kind }) {
  const pct = Math.round(level * 100);
  const suffix = horizon === 1 ? '' : 'x10';
  const id = `${kind}${pct}${suffix}`;
  const horizonText = horizon === 1 ? '1-day' : `${horizon}-day`;
  const label = `${horizonText} ${kind === 'var' ? 'VaR' : 'CVaR'} ${pct}%`;
  const minimum = level >= 0.99 ? RISK_CONFIG.var99Min : RISK_CONFIG.var95Min;
  const formula = kind === 'var'
    ? `VaR ${pct}% = −(the ${100 - pct}th percentile of ${horizonText} returns)`
    : `CVaR ${pct}% = −(average of the ${horizonText} returns at or below the ${100 - pct}th percentile)`;
  const returns = periodReturns(closes, horizon);
  const count = returns ? returns.length : 0;
  if (count < minimum) {
    return notAvailable({
      id, label, unit: 'pct', formula, meta: { level, horizon, kind },
      reason: `${horizonText} ${pct}% tail risk needs at least ${minimum} ${horizon === 1 ? 'daily' : 'overlapping 10-day'} returns; the last ${rangeLabel} has ${count}. Choose a longer range.`,
    });
  }
  const result = historicalVar(returns, level);
  if (!result) return notAvailable({ id, label, unit: 'pct', formula, reason: 'The returns in this window could not be used.' });
  const value = kind === 'var' ? result.var : result.cvar;
  const worst = Math.min(...returns);
  const daysInTail = result.tail;
  return traced({
    id, label, value, unit: 'pct', tone: lossTone(Math.max(0, value), horizon),
    meta: { level, horizon, kind, observations: count, tail: daysInTail, quantile: result.quantile, var: result.var, cvar: result.cvar, worst, from: dates[0], to: dates[dates.length - 1] },
    formula,
    rawInputs: [
      input(`${horizonText} returns`, count, 'observations', horizon === 1 ? `${dates[0]} to ${dates[dates.length - 1]}` : 'overlapping: each day starts a new 10-day window', dates[dates.length - 1]),
      input('Confidence level', level, 'fraction', 'fixed'),
      input('Worst return in the window', worst, 'fraction', 'for scale'),
    ],
    steps: [
      step('Sort the returns from worst to best', `${count} returns`, `worst ${fmtPct(worst, 2)}`),
      step(`Read the ${100 - pct}th percentile (straight-line between neighbours)`, `position (${count} − 1) × ${fmtN(1 - level, 2)}`, fmtPct(result.quantile, 2)),
      kind === 'var'
        ? step('VaR is that loss, as a positive number', `−(${fmtPct(result.quantile, 2)})`, fmtPct(result.var, 2))
        : step(`Average the ${daysInTail} returns at or below it`, `mean of the ${daysInTail} worst returns`, fmtPct(-result.cvar, 2)),
      ...(kind === 'cvar' ? [step('CVaR is that average loss, as a positive number', `−(${fmtPct(-result.cvar, 2)})`, fmtPct(result.cvar, 2))] : []),
    ],
    interpretation: interpretation(
      kind === 'var'
        ? `Over the last ${rangeLabel}, ${horizon === 1 ? 'one day' : 'one 10-day stretch'} in ${Math.round(1 / (1 - level))} lost more than ${fmtPct(result.var, 1)}.`
        : `When ${horizon === 1 ? 'a day' : 'a 10-day stretch'} was among the worst ${100 - pct}%, it lost ${fmtPct(result.cvar, 1)} on average.`,
      [threshold('Below 2% a day', 'Low', 'healthy'), threshold('2% – 4% a day', 'Elevated', 'caution'), threshold('Above 4% a day', 'High', 'risky')],
      `${daysInTail < 5 ? `The tail rests on only ${daysInTail} observations, so this figure is fragile. ` : ''}Historical simulation assumes the next period resembles the last ${rangeLabel}: a calm window understates risk going into a storm.${horizon > 1 ? ' Overlapping windows share days, so they are not independent observations.' : ''}`,
    ),
    dependsOn: kind === 'cvar' ? [`var${pct}${suffix}`] : [],
  });
}

/**
 * Risk measures of one asset over a window.
 * @param {object} asset normalised asset (assetClass for annualisation)
 * @param {{dates:string[], close:number[]}} series the window
 * @param {string} [rangeLabel] "year", "5 years", ...
 */
export function analyzeRisk(asset, series, rangeLabel = 'year') {
  const closes = series && Array.isArray(series.close) ? series.close : [];
  const dates = series && Array.isArray(series.dates) ? series.dates : [];
  const metrics = { ewmaVolatility: buildEwma(asset, closes, dates, rangeLabel) };
  for (const spec of [
    { level: 0.95, horizon: 1, kind: 'var' }, { level: 0.95, horizon: 1, kind: 'cvar' },
    { level: 0.99, horizon: 1, kind: 'var' }, { level: 0.99, horizon: 1, kind: 'cvar' },
    { level: 0.95, horizon: RISK_CONFIG.horizonDays, kind: 'var' }, { level: 0.95, horizon: RISK_CONFIG.horizonDays, kind: 'cvar' },
  ]) {
    const metric = buildTail(asset, closes, dates, rangeLabel, spec);
    metrics[metric.id] = metric;
  }
  return { ticker: asset.ticker, range: rangeLabel, observations: closes.length, metrics };
}

/**
 * 1-day 95% VaR and CVaR of a sized position, in the account currency.
 * @param {{ sizing:object, risk:object, accountCurrency:string }} args
 */
export function positionTailRisk({ sizing, risk, accountCurrency }) {
  const specs = [
    { id: 'positionVar95', label: 'Position VaR 95% (1 day)', source: 'var95' },
    { id: 'positionCvar95', label: 'Position CVaR 95% (1 day)', source: 'cvar95' },
  ];
  const metrics = {};
  for (const spec of specs) {
    const formula = `${spec.label.replace(' (1 day)', '')} = Position value × ${spec.source === 'var95' ? '1-day VaR 95%' : '1-day CVaR 95%'}`;
    const base = { id: spec.id, label: spec.label, unit: 'currency', formula, dependsOn: ['positionValue', spec.source] };
    const fraction = risk ? valueOf(risk.metrics[spec.source]) : null;
    const summary = sizing && sizing.ok ? sizing.summary : null;
    if (!summary || !(summary.units > 0)) {
      metrics[spec.id] = notAvailable({ ...base, reason: 'There is no position to measure: the suggested size is zero or unavailable.' });
      continue;
    }
    if (fraction === null) {
      metrics[spec.id] = notAvailable({ ...base, reason: risk ? risk.metrics[spec.source].naReason : 'No tail-risk estimate is available for this range.' });
      continue;
    }
    const value = summary.positionValue * Math.max(0, fraction);
    metrics[spec.id] = traced({
      ...base, value, tone: 'neutral',
      meta: { currency: accountCurrency, fraction, positionValue: summary.positionValue, amountAtRisk: summary.amountAtRisk },
      rawInputs: [
        input('Position value', summary.positionValue, accountCurrency, 'positionSizerEngine: positionValue'),
        input(spec.source === 'var95' ? '1-day VaR 95%' : '1-day CVaR 95%', fraction, 'fraction', `riskEngine: ${spec.source}`),
      ],
      steps: [step('Position value × daily tail loss', `${fmtN(summary.positionValue, 2)} × ${fmtPct(fraction, 2)}`, value)],
      interpretation: interpretation(
        spec.source === 'var95'
          ? `On about one day in 20, this position would lose more than ${fmtN(value, 2)} ${accountCurrency}, judging by the selected range.`
          : `On those worst days, the loss would average ${fmtN(value, 2)} ${accountCurrency}.`,
        [],
        `For comparison, the stop-loss puts ${fmtN(summary.amountAtRisk, 2)} ${accountCurrency} at risk in total. VaR is a one-day figure; the stop limits the loss over the whole trade unless the price gaps through it.`,
      ),
    });
  }
  return metrics;
}
