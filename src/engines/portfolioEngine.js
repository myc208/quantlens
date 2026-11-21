/**
 * portfolioEngine.js: Modern Portfolio Theory for a hand-weighted portfolio.
 *
 * Pipeline
 *   1. Keep the dates on which EVERY asset has a close.
 *   2. Convert each price into the base currency with that day's USD/SGD rate,
 *      so currency moves are part of the return, as they are for the investor.
 *   3. Daily simple returns rₜ = Pₜ ÷ Pₜ₋₁ − 1. Simple, not log, because a
 *      portfolio's return is the weighted sum of simple returns.
 *   4. Mean vector μ and sample covariance matrix Σ, annualised by × N
 *      (N = 252, or 365 for a crypto-only portfolio).
 *   5. Return        Rp  = wᵀμ
 *      Variance      σp² = wᵀΣw      Volatility σp = √(wᵀΣw)
 *      Sharpe ratio  S   = (Rp − Rf) ÷ σp     Rf = 10-year government yield
 *      Risk share    RCᵢ = wᵢ(Σw)ᵢ ÷ σp²      (sums to 1)
 *      Diversification ratio = Σ wᵢσᵢ ÷ σp    (1 = none, higher = better)
 *
 * Honesty notes carried into every trace: one year of history is a description
 * of the past, not an expected return, and the weights are long-only.
 *
 * Pure functions with no DOM or network access, so the same code runs in the
 * math worker, on the main thread as a fallback, and in the test page.
 */

import { isNum, safeDiv, safeSqrt, mean } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct,
} from '../core/derivationTracer.js';
import { mulberry32 } from './monteCarloEngine.js';
import { ledoitWolf, weeklyCloses } from './riskEngine.js';

export const PORTFOLIO_CONFIG = Object.freeze({
  minObservations: 15, // a 1-month window of a stock has about 20 daily returns
  maxAssets: 8,
  annualisation: Object.freeze({ equity: 252, crypto: 365, weekly: 52 }),
  frontierSamples: 2000,
  detailedTraceAssets: 4, // above this the volatility trace summarises the cross terms
});

const SHARPE_THRESHOLDS = [
  threshold('1.0 or more', 'Strong: well paid for the risk taken', 'healthy'),
  threshold('0.5 to 1.0', 'Acceptable', 'neutral'),
  threshold('0 to 0.5', 'Thin: little reward above the risk-free rate', 'caution'),
  threshold('Below 0', 'Worse than holding government bonds', 'risky'),
];

/* ------------------------------------------------------------------ */
/* Building blocks (exported for tests and for the frontier sampler)    */
/* ------------------------------------------------------------------ */

/**
 * Turn any non-negative weights (percentages or fractions) into fractions
 * that sum to 1. Returns null when nothing is positive.
 * @param {{ticker:string, weight:number}[]} entries
 */
export function normaliseWeights(entries) {
  const clean = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.ticker === 'string' && isNum(entry.weight) && entry.weight >= 0);
  const total = clean.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return null;
  return clean.map((entry) => ({ ticker: entry.ticker, weight: entry.weight / total }));
}

/** The latest rate on or before `date` (the first rate if the date precedes the series). */
function rateOn(fxSeries, date) {
  const { dates, rates } = fxSeries;
  let low = 0;
  let high = dates.length - 1;
  if (high < 0) return null;
  if (date <= dates[0]) return rates[0];
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (dates[middle] <= date) low = middle;
    else high = middle - 1;
  }
  return rates[low];
}

/**
 * Common-date prices in the base currency.
 * @returns {{ ok:true, dates:string[], prices:number[][], fxMode:'none'|'history'|'constant' } | { ok:false, reason:string }}
 */
export function alignPrices(assets, { baseCurrency, fxSeries, fxRate }) {
  if (!Array.isArray(assets) || assets.length === 0) return { ok: false, reason: 'Add at least one asset to the portfolio.' };
  for (const asset of assets) {
    const supported = asset.currency === baseCurrency || (['USD', 'SGD'].includes(asset.currency) && ['USD', 'SGD'].includes(baseCurrency));
    if (!supported) return { ok: false, reason: `${asset.ticker} trades in ${asset.currency}, which cannot be converted to ${baseCurrency}.` };
  }
  const needsFx = assets.some((asset) => asset.currency !== baseCurrency);
  const hasHistory = Boolean(fxSeries) && Array.isArray(fxSeries.dates) && fxSeries.dates.length > 1;
  if (needsFx && !hasHistory && !(isNum(fxRate) && fxRate > 0)) {
    return { ok: false, reason: 'No USD/SGD rate is available to bring the assets into one currency.' };
  }
  const fxMode = !needsFx ? 'none' : hasHistory ? 'history' : 'constant';

  let common = null;
  for (const asset of assets) {
    const own = new Set(asset.series.dates);
    common = common === null ? own : new Set([...common].filter((date) => own.has(date)));
  }
  const dates = [...common].sort();
  const prices = assets.map((asset) => {
    const closeByDate = new Map(asset.series.dates.map((date, index) => [date, asset.series.close[index]]));
    return dates.map((date) => {
      const close = closeByDate.get(date);
      if (asset.currency === baseCurrency) return close;
      const usdSgd = fxMode === 'history' ? rateOn(fxSeries, date) : fxRate;
      return asset.currency === 'USD' ? close * usdSgd : close / usdSgd; // USD -> SGD multiplies, SGD -> USD divides
    });
  });
  if (prices.some((series) => series.some((price) => !isNum(price) || price <= 0))) {
    return { ok: false, reason: 'A price could not be converted into the base currency.' };
  }
  return { ok: true, dates, prices, fxMode };
}

/** Daily simple returns Pₜ ÷ Pₜ₋₁ − 1. */
export function simpleReturns(prices) {
  const returns = new Array(Math.max(0, prices.length - 1));
  for (let i = 1; i < prices.length; i += 1) returns[i - 1] = prices[i] / prices[i - 1] - 1;
  return returns;
}

/** Mean vector and sample covariance matrix (n − 1) of equally long return series. */
export function covarianceMatrix(returnsByAsset) {
  const count = returnsByAsset.length;
  const length = count ? returnsByAsset[0].length : 0;
  if (count === 0 || length < 2 || returnsByAsset.some((series) => series.length !== length || !series.every(isNum))) return null;
  const means = returnsByAsset.map((series) => mean(series));
  const cov = Array.from({ length: count }, () => new Array(count).fill(0));
  for (let i = 0; i < count; i += 1) {
    for (let j = i; j < count; j += 1) {
      let cross = 0;
      for (let t = 0; t < length; t += 1) cross += (returnsByAsset[i][t] - means[i]) * (returnsByAsset[j][t] - means[j]);
      cov[i][j] = cross / (length - 1);
      cov[j][i] = cov[i][j];
    }
  }
  return { means, cov };
}

/** wᵀμ and wᵀΣw. */
export function portfolioMoments(weights, means, cov) {
  let ret = 0;
  let variance = 0;
  for (let i = 0; i < weights.length; i += 1) {
    ret += weights[i] * means[i];
    for (let j = 0; j < weights.length; j += 1) variance += weights[i] * weights[j] * cov[i][j];
  }
  return { ret, variance: Math.max(0, variance) }; // rounding can leave a perfectly hedged pair at −1e-20
}

/* ------------------------------------------------------------------ */
/* Traced metrics                                                      */
/* ------------------------------------------------------------------ */

function riskFreeMetric(riskFree, baseCurrency) {
  const id = 'riskFreeRate';
  const label = 'Risk-free rate';
  const formula = 'Reported figure: the 10-year government bond yield for the portfolio currency';
  if (!riskFree || !isNum(riskFree.yield)) {
    return notAvailable({ id, label, unit: 'pct', formula, meta: { currency: baseCurrency, status: 'unavailable' }, reason: `No 10-year government yield is available for ${baseCurrency}, so excess return cannot be measured.` });
  }
  const proxy = riskFree.status === 'proxy';
  const stale = riskFree.status === 'stale';
  let caveat = 'A 10-year yield is used as the baseline. Many textbooks use a 3-month bill instead, which would usually give a slightly different Sharpe ratio.';
  if (proxy) caveat = 'The Singapore yield could not be fetched, so the US 10-year yield stands in for it. Singapore yields are normally lower, so the Sharpe ratio shown is understated.';
  else if (stale) caveat = 'This yield is carried over from an earlier day because the source could not be reached.';
  return traced({
    id, label, value: riskFree.yield, unit: 'pct', tone: proxy || stale ? 'caution' : 'neutral',
    meta: { currency: baseCurrency, status: riskFree.status, source: riskFree.source ?? null, name: riskFree.name ?? null, asOf: riskFree.asOf ?? null },
    formula,
    rawInputs: [input(riskFree.name ?? '10-year government yield', riskFree.yield, 'fraction', `snapshot.macro.riskFree.${baseCurrency} (${riskFree.source ?? 'unknown source'}, ${riskFree.status})`, riskFree.asOf ?? null)],
    steps: [step('Read the yield from the daily snapshot', `macro.riskFree.${baseCurrency}.yield`, fmtPct(riskFree.yield))],
    interpretation: interpretation(
      `Lending to the government for ten years currently pays about ${fmtPct(riskFree.yield)} a year. A portfolio has to beat that to justify its risk.`,
      [threshold('fresh', 'Fetched today', 'healthy'), threshold('stale', 'Carried over from an earlier day', 'caution'), threshold('proxy', 'Another country\'s yield standing in', 'caution')],
      caveat,
    ),
  });
}

function unavailableAnalysis(reason, tickers, riskFree, baseCurrency) {
  const na = (id, label, unit, formula) => notAvailable({ id, label, unit, formula, reason });
  return {
    ok: false,
    reason,
    tickers,
    weights: [],
    observations: 0,
    period: null,
    periodsPerYear: null,
    fxMode: 'none',
    baseCurrency,
    stats: null,
    contributions: [],
    metrics: {
      portfolioReturn: na('portfolioReturn', 'Historical return (annualised)', 'pct', 'Rp = Σ wᵢ × μᵢ'),
      portfolioVolatility: na('portfolioVolatility', 'Portfolio volatility (annualised)', 'pct', 'σp = √(wᵀ Σ w)'),
      sharpeRatio: na('sharpeRatio', 'Sharpe ratio', 'ratio', 'Sharpe = (Rp − Rf) ÷ σp'),
      diversificationRatio: na('diversificationRatio', 'Diversification ratio', 'ratio', 'DR = Σ wᵢσᵢ ÷ σp'),
      riskFreeRate: riskFreeMetric(riskFree, baseCurrency),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Public: analyse a weighted portfolio                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} args
 * @param {{ticker:string, currency:string, assetClass:string, series:{dates:string[], close:number[]}}[]} args.assets
 * @param {{ticker:string, weight:number}[]} args.weights percentages or fractions; normalised here
 * @param {string} args.baseCurrency USD | SGD
 * @param {{rate:number, series?:{dates:string[], rates:number[]}}} [args.fx]
 * @param {{yield:number|null, status?:string, name?:string, source?:string, asOf?:string}|null} [args.riskFree]
 * @param {number} [args.minObservations]
 */
export function analyzePortfolio({ assets, weights, baseCurrency, fx = null, riskFree = null, minObservations = PORTFOLIO_CONFIG.minObservations }) {
  const list = (Array.isArray(assets) ? assets : []).filter(Boolean);
  const tickers = list.map((asset) => asset.ticker);
  const fail = (reason) => unavailableAnalysis(reason, tickers, riskFree, baseCurrency);

  if (list.length === 0) return fail('Add at least one asset to the portfolio.');
  if (list.length > PORTFOLIO_CONFIG.maxAssets) return fail(`A portfolio can hold at most ${PORTFOLIO_CONFIG.maxAssets} assets here.`);
  const normalised = normaliseWeights((Array.isArray(weights) ? weights : []).filter((entry) => entry && tickers.includes(entry.ticker)));
  if (!normalised) return fail('Give at least one asset a weight above zero.');
  const weightByTicker = new Map(normalised.map((entry) => [entry.ticker, entry.weight]));
  const w = tickers.map((ticker) => weightByTicker.get(ticker) ?? 0);

  const fxArgs = { baseCurrency, fxSeries: fx ? fx.series : null, fxRate: fx ? fx.rate : null };
  // Markets that close at different times (US, London, Singapore, crypto) are compared week by
  // week: daily closes taken hours apart understate how closely the assets move.
  const sessions = new Set(list.map((asset) => asset.market).filter(Boolean));
  const mixedSessions = sessions.size > 1;
  let aligned = null;
  let frequency = 'daily';
  if (mixedSessions) {
    const weekly = alignPrices(list.map((asset) => ({ ...asset, series: weeklyCloses(asset.series) })), fxArgs);
    if (weekly.ok && weekly.dates.length - 1 >= minObservations) {
      aligned = weekly;
      frequency = 'weekly';
    }
  }
  const asynchronous = mixedSessions && frequency === 'daily';
  if (!aligned) aligned = alignPrices(list, fxArgs);
  if (!aligned.ok) return fail(aligned.reason);
  const observations = aligned.dates.length - 1;
  if (observations < minObservations) {
    return fail(`Only ${Math.max(0, observations)} ${frequency === 'weekly' ? 'weeks' : 'days'} of overlapping returns are available; at least ${minObservations} are needed.`);
  }

  const returns = aligned.prices.map(simpleReturns);
  const moments = covarianceMatrix(returns);
  if (!moments) return fail('The return series could not be formed from these prices.');
  // Ledoit-Wolf: pull the noisy sample covariances toward equal correlations (no effect with two assets).
  const shrinkage = ledoitWolf(returns);
  const baseCov = shrinkage ? shrinkage.shrunk : moments.cov;

  let periods = list.every((asset) => asset.assetClass === 'crypto') ? PORTFOLIO_CONFIG.annualisation.crypto : PORTFOLIO_CONFIG.annualisation.equity;
  if (frequency === 'weekly') periods = PORTFOLIO_CONFIG.annualisation.weekly;
  const mu = moments.means.map((value) => value * periods);
  const cov = baseCov.map((row) => row.map((value) => value * periods));
  const sampleCov = moments.cov.map((row) => row.map((value) => value * periods));
  const vols = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  const corr = cov.map((row, i) => row.map((value, j) => (i === j ? 1 : safeDiv(value, vols[i] * vols[j]))));
  const delta = shrinkage ? shrinkage.delta : 0;

  const { ret, variance } = portfolioMoments(w, mu, cov);
  const volatility = safeSqrt(variance);
  const rf = riskFree && isNum(riskFree.yield) ? riskFree.yield : null;
  const weightedVol = w.reduce((sum, weight, i) => sum + weight * vols[i], 0);
  // A perfect hedge leaves a volatility of about 1e-9 from floating-point rounding, not
  // exactly zero. Judge "no volatility" relative to the assets' own, so that dividing by
  // rounding noise can never produce a Sharpe ratio in the millions.
  const hasVolatility = isNum(volatility) && volatility > 1e-7 * Math.max(weightedVol, 1e-12);
  const sharpe = rf === null || !hasVolatility ? null : safeDiv(ret - rf, volatility);
  const diversification = hasVolatility ? safeDiv(weightedVol, volatility) : null;

  const marginal = cov.map((row) => row.reduce((sum, value, j) => sum + value * w[j], 0)); // (Σw)ᵢ
  const contributions = tickers.map((ticker, i) => ({
    ticker,
    weight: w[i],
    annualReturn: mu[i],
    annualVolatility: vols[i],
    returnContribution: w[i] * mu[i],
    riskShare: variance > 1e-18 ? (w[i] * marginal[i]) / variance : null,
  }));

  const from = aligned.dates[0];
  const to = aligned.dates[aligned.dates.length - 1];
  const windowText = `${observations} ${frequency} returns, ${from} to ${to}`;
  const fxNote = [
    { none: null, history: `Prices were converted to ${baseCurrency} with each ${frequency === 'weekly' ? "week's" : "day's"} USD/SGD rate, so currency moves are included.`, constant: `No USD/SGD history is available, so today's rate was applied to every day. Currency moves are therefore NOT included.` }[aligned.fxMode],
    frequency === 'weekly' ? `These markets close at different times (${[...sessions].join(', ')}), so the figures use weekly returns, which line them up.` : null,
    asynchronous ? 'These markets close at different times, and this range has too few weeks to use weekly returns, so daily closes are used: they understate how closely the assets move. Choose 6M or longer.' : null,
  ].filter(Boolean).join(' ') || null;
  const weightInputs = tickers.map((ticker, i) => input(`Weight of ${ticker}`, w[i], 'fraction', 'your allocation, scaled to total 100%'));
  const activeIndexes = tickers.map((_, i) => i).filter((i) => w[i] > 0);

  /* ---- return ---- */
  const portfolioReturn = traced({
    id: 'portfolioReturn', label: 'Historical return (annualised)', value: ret, unit: 'pct', tone: null,
    meta: { periodsPerYear: periods, observations, from, to, baseCurrency },
    formula: `Rp = Σ wᵢ × μᵢ, where μᵢ = mean ${frequency} simple return of asset i × ${periods}`,
    rawInputs: [
      ...weightInputs,
      ...tickers.map((ticker, i) => input(`Annualised mean return of ${ticker}`, mu[i], 'fraction', windowText, to)),
    ],
    steps: [
      ...activeIndexes.map((i) => step(`${tickers[i]}: weight × annualised mean return`, `${fmtPct(w[i])} × ${fmtPct(mu[i])}`, fmtPct(w[i] * mu[i], 3))),
      step('Add the contributions', activeIndexes.map((i) => fmtPct(w[i] * mu[i], 3)).join(' + '), fmtPct(ret, 3)),
    ],
    interpretation: interpretation(
      `Held at these weights over the past period, the portfolio's average ${frequency} return scales to about ${fmtPct(ret)} a year in ${baseCurrency}.`,
      [],
      `This describes the past ${observations} ${frequency === 'weekly' ? 'weeks' : 'days'}. It is not a forecast: past average returns are a very noisy guide to the next period.${fxNote ? ` ${fxNote}` : ''}`,
    ),
  });

  /* ---- volatility ---- */
  const detailed = activeIndexes.length <= PORTFOLIO_CONFIG.detailedTraceAssets;
  const varianceSteps = activeIndexes.map((i) => step(`${tickers[i]}: weight² × variance`, `${fmtPct(w[i])}² × ${fmtN(cov[i][i], 6)}`, w[i] * w[i] * cov[i][i]));
  let crossTotal = 0;
  const crossSteps = [];
  for (let a = 0; a < activeIndexes.length; a += 1) {
    for (let b = a + 1; b < activeIndexes.length; b += 1) {
      const i = activeIndexes[a];
      const j = activeIndexes[b];
      const term = 2 * w[i] * w[j] * cov[i][j];
      crossTotal += term;
      if (detailed) crossSteps.push(step(`${tickers[i]} with ${tickers[j]}: 2 × weights × covariance`, `2 × ${fmtPct(w[i])} × ${fmtPct(w[j])} × ${fmtN(cov[i][j], 6)}`, term));
    }
  }
  if (!detailed && activeIndexes.length > 1) {
    crossSteps.push(step(`All ${(activeIndexes.length * (activeIndexes.length - 1)) / 2} pairs: 2 × weights × covariance, added together`, 'Σ 2 wᵢ wⱼ Σᵢⱼ', crossTotal));
  }
  const portfolioVolatility = traced({
    id: 'portfolioVolatility', label: 'Portfolio volatility (annualised)', value: volatility, unit: 'pct',
    tone: volatility < 0.15 ? 'healthy' : volatility < 0.3 ? 'caution' : 'risky',
    meta: { variance, periodsPerYear: periods, observations, weightedAverageVolatility: weightedVol, frequency, shrinkage: delta },
    formula: 'σp = √(wᵀ Σ w) = √( Σ wᵢ² σᵢ² + Σ 2 wᵢ wⱼ Σᵢⱼ ), with Σ the Ledoit-Wolf shrunk covariance',
    rawInputs: [
      ...weightInputs,
      ...tickers.map((ticker, i) => input(`Annualised volatility of ${ticker}`, vols[i], 'fraction', windowText, to)),
    ],
    steps: [
      ...(shrinkage && tickers.length > 2
        ? [step(
          'Shrink the sample covariance toward equal correlations (Ledoit-Wolf); variances are kept',
          `Σ = δ × target + (1 − δ) × sample, average correlation r̄ = ${fmtN(shrinkage.meanCorrelation, 3)}`,
          `δ = ${fmtPct(delta, 1)}`,
        )]
        : []),
      ...varianceSteps,
      ...crossSteps,
      step('Portfolio variance: add every term', 'wᵀ Σ w', variance),
      step('Volatility: square root of the variance', `√${fmtN(variance, 6)}`, fmtPct(volatility)),
      step('For comparison, the weighted average of the assets\' own volatilities', activeIndexes.map((i) => `${fmtPct(w[i])} × ${fmtPct(vols[i])}`).join(' + '), fmtPct(weightedVol)),
    ],
    interpretation: interpretation(
      activeIndexes.length > 1
        ? `The portfolio swings about ${fmtPct(volatility)} a year, against ${fmtPct(weightedVol)} if its assets moved in lockstep. The difference is what diversification bought.`
        : `With a single asset the portfolio's volatility is simply that asset's: ${fmtPct(volatility)} a year.`,
      [threshold('Below 15%', 'Calm', 'healthy'), threshold('15% to 30%', 'Lively', 'caution'), threshold('Above 30%', 'Rough', 'risky')],
      `Roughly two years in three would land within plus or minus this figure of the average, if the past is a guide.${tickers.length > 2 ? ` The covariances were shrunk ${fmtPct(delta, 0)} of the way toward equal correlations, which tames estimation noise.` : ''}${fxNote ? ` ${fxNote}` : ''}`,
    ),
  });

  /* ---- Sharpe ---- */
  const riskFreeRate = riskFreeMetric(riskFree, baseCurrency);
  let sharpeRatio;
  const sharpeFormula = 'Sharpe = (Rp − Rf) ÷ σp';
  const sharpeDependsOn = ['portfolioReturn', 'riskFreeRate', 'portfolioVolatility'];
  if (rf === null) {
    sharpeRatio = notAvailable({ id: 'sharpeRatio', label: 'Sharpe ratio', unit: 'ratio', formula: sharpeFormula, dependsOn: sharpeDependsOn, reason: `No risk-free rate is available for ${baseCurrency}, so the excess return cannot be measured.` });
  } else if (sharpe === null) {
    sharpeRatio = notAvailable({ id: 'sharpeRatio', label: 'Sharpe ratio', unit: 'ratio', formula: sharpeFormula, dependsOn: sharpeDependsOn, reason: 'The portfolio shows no volatility over this period (its assets cancelled each other out), so a ratio of return to risk is undefined.' });
  } else {
    let tone = 'risky';
    if (sharpe >= 1) tone = 'healthy';
    else if (sharpe >= 0.5) tone = 'neutral';
    else if (sharpe >= 0) tone = 'caution';
    sharpeRatio = traced({
      id: 'sharpeRatio', label: 'Sharpe ratio', value: sharpe, unit: 'ratio', tone,
      meta: { excessReturn: ret - rf, riskFree: rf, riskFreeStatus: riskFree.status ?? null },
      formula: sharpeFormula,
      rawInputs: [
        input('Historical return (annualised)', ret, 'fraction', 'portfolioEngine: portfolioReturn', to),
        input(riskFree.name ?? 'Risk-free rate', rf, 'fraction', `snapshot.macro.riskFree.${baseCurrency} (${riskFree.status ?? 'unknown'})`, riskFree.asOf ?? null),
        input('Portfolio volatility (annualised)', volatility, 'fraction', 'portfolioEngine: portfolioVolatility', to),
      ],
      steps: [
        step('Excess return: portfolio return minus the risk-free rate', `${fmtPct(ret)} − ${fmtPct(rf)}`, fmtPct(ret - rf)),
        step('Divide by the portfolio volatility', `${fmtPct(ret - rf)} ÷ ${fmtPct(volatility)}`, sharpe),
      ],
      interpretation: interpretation(
        sharpe >= 0
          ? `For each unit of risk taken, the portfolio earned ${fmtN(sharpe, 2)} units of return above government bonds over this period.`
          : `The portfolio returned less than government bonds over this period (${fmtPct(ret)} against ${fmtPct(rf)}), so the risk was not rewarded.`,
        SHARPE_THRESHOLDS,
        riskFree.status === 'proxy'
          ? 'The risk-free rate is a US proxy for Singapore, which understates this ratio. And like the return it is built on, the ratio describes the past, not the future.'
          : `Built on only ${observations} days of history, this ratio can change sharply from one month to the next${observations < 120 ? ', and a short window exaggerates it: a few good weeks annualise into a very large number' : ''}. It rewards smoothness, and says nothing about rare large losses.`,
      ),
      dependsOn: sharpeDependsOn,
    });
  }

  /* ---- diversification ---- */
  let diversificationRatio;
  if (diversification === null) {
    diversificationRatio = notAvailable({ id: 'diversificationRatio', label: 'Diversification ratio', unit: 'ratio', formula: 'DR = Σ wᵢσᵢ ÷ σp', dependsOn: ['portfolioVolatility'], reason: 'The portfolio shows no volatility over this period, so the ratio is undefined.' });
  } else {
    let tone = 'caution';
    if (diversification >= 1.2) tone = 'healthy';
    else if (diversification >= 1.05) tone = 'neutral';
    diversificationRatio = traced({
      id: 'diversificationRatio', label: 'Diversification ratio', value: diversification, unit: 'ratio', tone,
      formula: 'DR = (Σ wᵢ × σᵢ) ÷ σp',
      rawInputs: [
        input('Weighted average of the assets\' volatilities', weightedVol, 'fraction', 'Σ wᵢσᵢ', to),
        input('Portfolio volatility (annualised)', volatility, 'fraction', 'portfolioEngine: portfolioVolatility', to),
      ],
      steps: [step('Weighted average volatility ÷ portfolio volatility', `${fmtPct(weightedVol)} ÷ ${fmtPct(volatility)}`, diversification)],
      interpretation: interpretation(
        diversification >= 1.05
          ? `Combining these assets removed about ${fmtPct(1 - 1 / diversification, 0)} of the risk that their individual volatilities would add up to.`
          : 'These assets move so closely together that combining them removes almost no risk.',
        [threshold('1.20 or more', 'Meaningful diversification', 'healthy'), threshold('1.05 to 1.20', 'Some', 'neutral'), threshold('Below 1.05', 'Almost none: effectively one bet', 'caution')],
        'A ratio of exactly 1 means no benefit at all, which is the case for a single asset.',
      ),
      dependsOn: ['portfolioVolatility'],
    });
  }

  return {
    ok: true,
    reason: null,
    tickers,
    weights: w,
    observations,
    period: { from, to },
    periodsPerYear: periods,
    fxMode: aligned.fxMode,
    frequency,
    asynchronous,
    shrinkage: { delta, meanCorrelation: shrinkage ? shrinkage.meanCorrelation : null },
    baseCurrency,
    stats: { means: mu, volatilities: vols, covariance: cov, correlation: corr, sampleCovariance: sampleCov },
    contributions,
    metrics: { portfolioReturn, portfolioVolatility, sharpeRatio, diversificationRatio, riskFreeRate },
  };
}

/* ------------------------------------------------------------------ */
/* Public: sample the long-only opportunity set                         */
/* ------------------------------------------------------------------ */

/**
 * Draw random long-only portfolios to show where a chosen allocation sits.
 *
 * Weights are uniform on the simplex (normalised exponentials), plus every
 * single-asset portfolio and the equal-weight portfolio. The "highest Sharpe"
 * and "lowest risk" results are the best of the sample, not an exact optimum.
 * Seeded, so the same inputs always produce the same cloud.
 *
 * @param {object} args
 * @param {number[]} args.means annualised mean returns
 * @param {number[][]} args.covariance annualised covariance matrix
 * @param {string[]} args.tickers
 * @param {number|null} [args.riskFree]
 * @param {number} [args.count]
 * @param {number} [args.seed]
 */
export function sampleFrontier({ means, covariance, tickers, riskFree = null, count = PORTFOLIO_CONFIG.frontierSamples, seed = 1 }) {
  const size = Array.isArray(means) ? means.length : 0;
  if (size === 0 || !Array.isArray(covariance) || covariance.length !== size) return null;
  const samples = Number.isInteger(count) ? Math.min(20000, Math.max(0, count)) : PORTFOLIO_CONFIG.frontierSamples;
  const random = mulberry32(seed >>> 0);
  const risk = [];
  const ret = [];
  let best = null;
  let safest = null;

  const consider = (weights) => {
    const moments = portfolioMoments(weights, means, covariance);
    const volatility = Math.sqrt(moments.variance);
    risk.push(volatility);
    ret.push(moments.ret);
    const sharpe = isNum(riskFree) && volatility > 1e-9 ? (moments.ret - riskFree) / volatility : null;
    const candidate = { weights: weights.slice(), ret: moments.ret, risk: volatility, sharpe };
    if (sharpe !== null && (best === null || sharpe > best.sharpe)) best = candidate;
    if (safest === null || volatility < safest.risk) safest = candidate;
  };

  for (let i = 0; i < size; i += 1) consider(means.map((_, j) => (i === j ? 1 : 0)));
  if (size > 1) consider(means.map(() => 1 / size));
  if (size > 1) {
    for (let n = 0; n < samples; n += 1) {
      const draws = means.map(() => -Math.log(Math.max(random(), 1e-12)));
      const total = draws.reduce((sum, value) => sum + value, 0);
      consider(draws.map((value) => value / total));
    }
  }
  const describe = (candidate) => (candidate ? {
    ...candidate,
    allocation: tickers.map((ticker, i) => ({ ticker, weight: candidate.weights[i] })),
  } : null);
  return { count: risk.length, risk, ret, maxSharpe: describe(best), minVariance: describe(safest), seed: seed >>> 0 };
}
