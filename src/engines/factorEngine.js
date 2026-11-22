/**
 * factorEngine.js: how an asset moves with its market.
 *
 *   beta                 β = cov(rₐ, r_b) ÷ var(r_b): the asset's typical move when its benchmark moves 1%
 *   rSquared             R² = ρ²: the share of the asset's variance its benchmark explains
 *   idioVolatility       the volatility of what the benchmark does not explain, from the
 *                        residuals εₜ = rₐ − α − β·r_b of the same regression
 *   relativeStrength1m   (1 + asset return) ÷ (1 + benchmark return) − 1 over 30 calendar days
 *   relativeStrength3m   the same over 91 calendar days (the 1M and 3M ranges)
 *
 * Benchmarks are already in the snapshot: ^GSPC for US- and London-listed assets, ^STI for
 * Singapore, BTC-USD for other coins. Returns are simple returns on common dates. A pair that
 * trades in different sessions (CSPX.L in London against ^GSPC in New York) uses weekly
 * returns, Friday to Friday, so the two closes line up; on a range too short for that the
 * figures are N/A rather than biased toward zero.
 *
 * Beta, R² and idiosyncratic volatility follow the time range, like correlation. Relative
 * strength always covers its own fixed span.
 */

import { isNum, mean } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';
import { weeklyCloses, differentSessions, sessionName } from './riskEngine.js';

export const FACTOR_CONFIG = Object.freeze({
  benchmarks: Object.freeze({ US: '^GSPC', UK: '^GSPC', SG: '^STI', CRYPTO: 'BTC-USD' }),
  minWeekly: 15,               // about four months of weeks
  roughBelow: 40,
  annualisation: Object.freeze({ daily: 252, crypto: 365, weekly: 52 }),
  strengthDays: Object.freeze({ relativeStrength1m: 30, relativeStrength3m: 91 }),
});

export const FACTOR_METRIC_IDS = Object.freeze(['beta', 'rSquared', 'idioVolatility', 'relativeStrength1m', 'relativeStrength3m']);

const BENCHMARK_NAMES = Object.freeze({ '^GSPC': 'the S&P 500', '^STI': 'the Straits Times Index', 'BTC-USD': 'Bitcoin' });
const DAY_MS = 86400000;

/** The benchmark ticker for an asset, or null for a benchmark itself. */
export function benchmarkFor(asset) {
  if (!asset) return null;
  const ticker = asset.assetClass === 'crypto' ? FACTOR_CONFIG.benchmarks.CRYPTO : FACTOR_CONFIG.benchmarks[asset.market] ?? null;
  return ticker === asset.ticker ? null : ticker;
}

/** Simple returns of two price series over their common dates. */
export function pairedReturns(seriesA, seriesB) {
  const empty = { dates: [], a: [], b: [] };
  if (!seriesA || !seriesB || !Array.isArray(seriesA.dates) || !Array.isArray(seriesB.dates)) return empty;
  const closeByDate = new Map();
  for (let i = 0; i < seriesB.dates.length; i += 1) closeByDate.set(seriesB.dates[i], seriesB.close[i]);
  const dates = [];
  const pricesA = [];
  const pricesB = [];
  for (let i = 0; i < seriesA.dates.length; i += 1) {
    const other = closeByDate.get(seriesA.dates[i]);
    const own = seriesA.close[i];
    if (isNum(own) && own > 0 && isNum(other) && other > 0) {
      dates.push(seriesA.dates[i]);
      pricesA.push(own);
      pricesB.push(other);
    }
  }
  const out = { dates: [], a: [], b: [] };
  for (let i = 1; i < dates.length; i += 1) {
    out.dates.push(dates[i]);
    out.a.push(pricesA[i] / pricesA[i - 1] - 1);
    out.b.push(pricesB[i] / pricesB[i - 1] - 1);
  }
  return out;
}

/**
 * Least-squares regression rₐ = α + β·r_b + ε.
 * @returns {{ n, beta, alpha, rSquared, correlation, residualVariance, standardError, varianceA, varianceB, covariance } | null}
 *   varianceA, varianceB and covariance divide by n − 1; residualVariance by n − 2.
 */
export function regress(returnsA, returnsB) {
  const n = Array.isArray(returnsA) ? returnsA.length : 0;
  if (n < 3 || !Array.isArray(returnsB) || returnsB.length !== n || !returnsA.every(isNum) || !returnsB.every(isNum)) return null;
  const meanA = mean(returnsA);
  const meanB = mean(returnsB);
  let sab = 0;
  let sbb = 0;
  let saa = 0;
  for (let i = 0; i < n; i += 1) {
    const da = returnsA[i] - meanA;
    const db = returnsB[i] - meanB;
    sab += da * db;
    sbb += db * db;
    saa += da * da;
  }
  if (!(sbb > 0) || !(saa > 0)) return null;
  const beta = sab / sbb;
  const alpha = meanA - beta * meanB;
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const residual = returnsA[i] - alpha - beta * returnsB[i];
    sse += residual * residual;
  }
  const residualVariance = sse / (n - 2);
  return {
    n, beta, alpha,
    rSquared: (sab * sab) / (saa * sbb),
    correlation: sab / Math.sqrt(saa * sbb),
    residualVariance,
    standardError: Math.sqrt(residualVariance / sbb),
    varianceA: saa / (n - 1),
    varianceB: sbb / (n - 1),
    covariance: sab / (n - 1),
  };
}

/** The last close on or before an ISO date: { date, close } or null. */
function closeOnOrBefore(series, isoDate) {
  let low = 0;
  let high = series.dates.length - 1;
  if (high < 0 || series.dates[0] > isoDate) return null;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (series.dates[middle] <= isoDate) low = middle;
    else high = middle - 1;
  }
  return isNum(series.close[low]) && series.close[low] > 0 ? { date: series.dates[low], close: series.close[low] } : null;
}

/**
 * Relative strength over `days` calendar days, ending on the asset's last close.
 * @returns {{ value, assetReturn, benchmarkReturn, from, to, start, end, benchmarkStart, benchmarkEnd } | null}
 */
export function relativeStrength(series, benchmarkSeries, days) {
  const count = series && Array.isArray(series.dates) ? series.dates.length : 0;
  if (count < 2 || !benchmarkSeries || !Array.isArray(benchmarkSeries.dates)) return null;
  const to = series.dates[count - 1];
  const target = new Date(Date.parse(`${to}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  const start = closeOnOrBefore(series, target);
  const end = { date: to, close: series.close[count - 1] };
  const benchmarkStart = closeOnOrBefore(benchmarkSeries, target);
  const benchmarkEnd = closeOnOrBefore(benchmarkSeries, to);
  if (!start || !benchmarkStart || !benchmarkEnd || !isNum(end.close) || end.close <= 0) return null;
  const assetReturn = end.close / start.close - 1;
  const benchmarkReturn = benchmarkEnd.close / benchmarkStart.close - 1;
  return { value: (1 + assetReturn) / (1 + benchmarkReturn) - 1, assetReturn, benchmarkReturn, from: start.date, to, start, end, benchmarkStart, benchmarkEnd };
}

function na(id, label, unit, formula, reason) {
  return notAvailable({ id, label, unit, formula, reason });
}

const FORMULAS = Object.freeze({
  beta: 'β = cov(rₐ, r_b) ÷ var(r_b), simple returns on common dates',
  rSquared: 'R² = ρ², the squared correlation with the benchmark = 1 − unexplained ÷ total variance',
  idioVolatility: 'σ_ε = √(Σ εₜ² ÷ (n − 2)) × √periods per year, εₜ = rₐ − α − β·r_b',
  relativeStrength1m: 'RS = (1 + asset return) ÷ (1 + benchmark return) − 1, over 30 calendar days',
  relativeStrength3m: 'RS = (1 + asset return) ÷ (1 + benchmark return) − 1, over 91 calendar days',
});

/**
 * @param {object} args
 * @param {object} args.asset normalised asset (ticker, market, assetClass, series = its year of candles)
 * @param {{dates:string[], close:number[]}} args.series the asset's selected window
 * @param {object|null} args.benchmark the normalised benchmark asset, or null
 * @param {{dates:string[], close:number[]}|null} args.benchmarkSeries the benchmark's window for the same range
 * @param {string} [args.windowLabel] "year", "3 months", ...
 * @param {number} [args.minOverlap] daily returns required (the correlation engine's minimum for the range)
 */
export function analyzeFactors({ asset, series, benchmark = null, benchmarkSeries = null, windowLabel = 'year', minOverlap = 60 }) {
  const ticker = asset.ticker;
  const benchmarkTicker = benchmarkFor(asset);
  const labels = {
    beta: `Beta vs ${benchmarkTicker ?? 'benchmark'}`,
    rSquared: `R² vs ${benchmarkTicker ?? 'benchmark'}`,
    idioVolatility: 'Idiosyncratic volatility',
    relativeStrength1m: `Relative strength (1M) vs ${benchmarkTicker ?? 'benchmark'}`,
    relativeStrength3m: `Relative strength (3M) vs ${benchmarkTicker ?? 'benchmark'}`,
  };
  const units = { beta: 'ratio', rSquared: 'pct', idioVolatility: 'pct', relativeStrength1m: 'pct', relativeStrength3m: 'pct' };
  const allNa = (reason) => Object.fromEntries(FACTOR_METRIC_IDS.map((id) => [id, na(id, labels[id], units[id], FORMULAS[id], reason)]));

  if (!benchmarkTicker) {
    const group = asset.assetClass === 'crypto' ? 'crypto' : asset.market === 'SG' ? 'Singapore assets' : 'US- and London-listed assets';
    return { benchmark: null, metrics: allNa(`${ticker} is the benchmark for ${group}: measured against itself its beta is 1 by definition.`) };
  }
  if (!benchmark || !benchmark.series) {
    return { benchmark: benchmarkTicker, metrics: allNa(`The benchmark ${benchmarkTicker} is not in this snapshot.`) };
  }
  const benchmarkName = BENCHMARK_NAMES[benchmarkTicker] ?? benchmarkTicker;
  const metrics = {};

  /* ---- beta, R², idiosyncratic volatility: the selected window ---- */
  const cross = differentSessions(asset.market, benchmark.market);
  const frequency = cross ? 'weekly' : 'daily';
  const pair = cross ? pairedReturns(weeklyCloses(series), weeklyCloses(benchmarkSeries)) : pairedReturns(series, benchmarkSeries);
  const required = cross ? FACTOR_CONFIG.minWeekly : minOverlap;
  const sessions = `${sessionName(asset.market)} and ${sessionName(benchmark.market)}`;
  const fit = pair.a.length >= required ? regress(pair.a, pair.b) : null;
  if (!fit) {
    const reason = pair.a.length < required
      ? cross
        ? `${ticker} and ${benchmarkTicker} trade in different sessions (${sessions}), so they are compared week by week, and the last ${windowLabel} has only ${pair.a.length} weekly returns (at least ${required} are needed). Choose 6M or longer.`
        : `Only ${pair.a.length} daily returns of ${ticker} overlap with ${benchmarkTicker} in the last ${windowLabel}; at least ${required} are needed.`
      : `${ticker} or ${benchmarkTicker} did not move over the last ${windowLabel}, so a beta cannot be estimated.`;
    for (const id of ['beta', 'rSquared', 'idioVolatility']) metrics[id] = na(id, labels[id], units[id], FORMULAS[id], reason);
  } else {
    const periods = cross ? FACTOR_CONFIG.annualisation.weekly
      : asset.assetClass === 'crypto' && benchmark.assetClass === 'crypto' ? FACTOR_CONFIG.annualisation.crypto : FACTOR_CONFIG.annualisation.daily;
    const from = pair.dates[0];
    const to = pair.dates[pair.dates.length - 1];
    const rough = fit.n < FACTOR_CONFIG.roughBelow;
    const low = fit.beta - 2 * fit.standardError;
    const high = fit.beta + 2 * fit.standardError;
    const unit = frequency === 'weekly' ? 'weekly' : 'daily';
    const sampleText = `${fit.n} ${unit} returns, ${from} to ${to}`;
    const crossNote = cross ? ` ${ticker} and ${benchmarkTicker} trade in different sessions (${sessions}), so weekly returns are used: daily closes taken hours apart would understate the link.` : '';
    const roughNote = rough ? ` Rough: only ${fit.n} returns.` : '';
    const pairInput = input(`${unit[0].toUpperCase()}${unit.slice(1)} returns of ${ticker} and ${benchmarkTicker}`, fit.n, 'pairs', sampleText, to);

    let betaTone = 'neutral';
    if (fit.beta > 2) betaTone = 'risky';
    else if (fit.beta > 1.3) betaTone = 'caution';
    metrics.beta = traced({
      id: 'beta', label: labels.beta, value: fit.beta, unit: 'ratio', tone: betaTone,
      meta: { benchmark: benchmarkTicker, frequency, observations: fit.n, standardError: fit.standardError, low, high, rough, from, to, alpha: fit.alpha },
      formula: `${FORMULAS.beta} (${unit})`,
      rawInputs: [pairInput, input(`Covariance with ${benchmarkTicker}`, fit.covariance, `per ${unit} return²`, sampleText, to), input(`Variance of ${benchmarkTicker}`, fit.varianceB, `per ${unit} return²`, sampleText, to)],
      steps: [
        step(`Covariance of ${ticker} with ${benchmarkTicker} (n − 1)`, 'Σ (rₐ − r̄ₐ)(r_b − r̄_b) ÷ (n − 1)', fmtN(fit.covariance, 8)),
        step(`Variance of ${benchmarkTicker} (n − 1)`, 'Σ (r_b − r̄_b)² ÷ (n − 1)', fmtN(fit.varianceB, 8)),
        step('Beta: covariance ÷ variance', `${fmtN(fit.covariance, 8)} ÷ ${fmtN(fit.varianceB, 8)}`, fmtN(fit.beta, 3)),
        step('Standard error of beta', '√(residual variance ÷ Σ (r_b − r̄_b)²)', fmtN(fit.standardError, 3)),
        step('Rough 95% range: β ± 2 × standard error', `${fmtN(fit.beta, 3)} ± 2 × ${fmtN(fit.standardError, 3)}`, `${fmtN(low, 2)} to ${fmtN(high, 2)}`),
      ],
      interpretation: interpretation(
        `When ${benchmarkName} moved 1% over the last ${windowLabel}, ${ticker} moved about ${fmtN(fit.beta, 2)}% the same way on average (plausibly ${fmtN(low, 2)} to ${fmtN(high, 2)}).`,
        [
          threshold('Below 0', 'Moves against the benchmark', 'neutral'),
          threshold('0 – 0.8', 'Defensive: moves less', 'neutral'),
          threshold('0.8 – 1.3', 'Moves with the benchmark', 'neutral'),
          threshold('1.3 – 2.0', 'Amplifies the benchmark', 'caution'),
          threshold('Above 2.0', 'Strongly amplifies it', 'risky'),
        ],
        `Beta describes the past ${windowLabel} and changes with the window; company news can swamp it.${crossNote}${roughNote}`,
      ),
    });

    metrics.rSquared = traced({
      id: 'rSquared', label: labels.rSquared, value: fit.rSquared, unit: 'pct', tone: 'neutral',
      meta: { benchmark: benchmarkTicker, frequency, observations: fit.n, correlation: fit.correlation, rough },
      formula: FORMULAS.rSquared,
      rawInputs: [pairInput],
      steps: [
        step(`Correlation of ${ticker} with ${benchmarkTicker}`, 'cov ÷ (σₐ × σ_b)', fmtN(fit.correlation, 3)),
        step('Square it', `${fmtN(fit.correlation, 3)}²`, fmtPct(fit.rSquared, 1)),
      ],
      interpretation: interpretation(
        `${benchmarkName.charAt(0).toUpperCase()}${benchmarkName.slice(1)} explains ${fmtPct(fit.rSquared, 0)} of ${ticker}'s ${unit} moves; the other ${fmtPct(1 - fit.rSquared, 0)} is its own.`,
        [threshold('Above 70%', 'Mostly the benchmark', 'neutral'), threshold('30% – 70%', 'Partly the benchmark', 'neutral'), threshold('Below 30%', 'Mostly its own story', 'neutral')],
        `A low R² also means the beta is a weaker guide: the benchmark explains little of what this asset does.${crossNote}${roughNote}`,
      ),
      dependsOn: ['beta'],
    });

    const idio = Math.sqrt(fit.residualVariance) * Math.sqrt(periods);
    const total = Math.sqrt(fit.varianceA) * Math.sqrt(periods);
    const systematic = Math.abs(fit.beta) * Math.sqrt(fit.varianceB) * Math.sqrt(periods);
    metrics.idioVolatility = traced({
      id: 'idioVolatility', label: labels.idioVolatility, value: idio, unit: 'pct', tone: idio > 0.4 ? 'caution' : 'neutral',
      meta: { benchmark: benchmarkTicker, frequency, observations: fit.n, total, systematic, periodsPerYear: periods, rough },
      formula: FORMULAS.idioVolatility,
      rawInputs: [pairInput, input('Periods per year', periods, unit, cross ? 'weekly returns' : asset.assetClass === 'crypto' ? 'crypto trades every day' : 'trading days')],
      steps: [
        step('Residual of each period: what beta does not explain', 'εₜ = rₐ − α − β × r_b', `α = ${fmtN(fit.alpha, 6)}, β = ${fmtN(fit.beta, 3)}`),
        step('Standard deviation of the residuals (n − 2)', `√(Σ εₜ² ÷ ${fit.n - 2})`, fmtN(Math.sqrt(fit.residualVariance), 6)),
        step('Annualise', `${fmtN(Math.sqrt(fit.residualVariance), 6)} × √${periods}`, fmtPct(idio, 1)),
        step('For comparison: total volatility and the part that follows the benchmark (|β| × σ_b)', `${fmtPct(total, 1)} total`, `${fmtPct(systematic, 1)} from ${benchmarkTicker}`),
      ],
      interpretation: interpretation(
        `${fmtPct(idio, 0)} a year of ${ticker}'s volatility is its own, against ${fmtPct(total, 0)} in total.`,
        [threshold('Below 20%', 'Modest', 'neutral'), threshold('20% – 40%', 'Substantial', 'neutral'), threshold('Above 40%', 'Large: company news dominates', 'caution')],
        `This is the part of the risk that holding many unrelated assets can average away; the benchmark part cannot be.${crossNote}${roughNote}`,
      ),
      dependsOn: ['beta'],
    });
  }

  /* ---- relative strength: fixed spans of the year of closes ---- */
  const dividendNote = (asset.assetClass === 'equity' || asset.assetClass === 'etf') && benchmark.assetClass === 'index'
    ? ` ${ticker}'s closes are adjusted for dividends but ${benchmarkTicker} is a price index, so this is flattered by roughly the dividends paid in the period.` : '';
  const timingNote = cross
    ? ` ${ticker} and ${benchmarkTicker} close at different times (${sessions}), so a move after the earlier close counts for one and not yet for the other.` : '';
  for (const id of ['relativeStrength1m', 'relativeStrength3m']) {
    const days = FACTOR_CONFIG.strengthDays[id];
    const rs = relativeStrength(asset.series, benchmark.series, days);
    if (!rs) {
      metrics[id] = na(id, labels[id], 'pct', FORMULAS[id], `${ticker} or ${benchmarkTicker} has no close ${days} days before the latest one.`);
      continue;
    }
    const verb = (value) => (value >= 0 ? 'rose' : 'fell');
    metrics[id] = traced({
      id, label: labels[id], value: rs.value, unit: 'pct', tone: 'neutral',
      meta: { benchmark: benchmarkTicker, days, assetReturn: rs.assetReturn, benchmarkReturn: rs.benchmarkReturn, from: rs.from, to: rs.to },
      formula: FORMULAS[id],
      rawInputs: [
        input(`${ticker} close`, rs.start.close, asset.currency, 'snapshot candles', rs.start.date),
        input(`${ticker} close`, rs.end.close, asset.currency, 'snapshot candles', rs.end.date),
        input(`${benchmarkTicker} close`, rs.benchmarkStart.close, benchmark.currency, 'snapshot candles', rs.benchmarkStart.date),
        input(`${benchmarkTicker} close`, rs.benchmarkEnd.close, benchmark.currency, 'snapshot candles', rs.benchmarkEnd.date),
      ],
      steps: [
        step(`${ticker}'s return`, `${fmtN(rs.end.close)} ÷ ${fmtN(rs.start.close)} − 1`, fmtPct(rs.assetReturn, 2)),
        step(`${benchmarkTicker}'s return`, `${fmtN(rs.benchmarkEnd.close)} ÷ ${fmtN(rs.benchmarkStart.close)} − 1`, fmtPct(rs.benchmarkReturn, 2)),
        step('Relative strength', `(1 + ${fmtPct(rs.assetReturn, 2)}) ÷ (1 + ${fmtPct(rs.benchmarkReturn, 2)}) − 1`, fmtPct(rs.value, 2)),
      ],
      interpretation: interpretation(
        `Since ${rs.from}, ${ticker} ${verb(rs.assetReturn)} ${fmtPct(Math.abs(rs.assetReturn), 1)} while ${benchmarkName} ${verb(rs.benchmarkReturn)} ${fmtPct(Math.abs(rs.benchmarkReturn), 1)}: ${rs.value >= 0 ? 'ahead' : 'behind'} by ${fmtPct(Math.abs(rs.value), 1)}.`,
        [threshold('Above 0', 'Outperformed the benchmark', 'neutral'), threshold('Below 0', 'Underperformed it', 'neutral')],
        `A description of the past ${days} days, not a signal: momentum like this did not predict the next month on this watchlist over 2022–2026, and it is not part of any score.${dividendNote}${timingNote}`,
      ),
    });
  }

  return { benchmark: benchmarkTicker, metrics };
}

