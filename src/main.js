/**
 * main.js: application bootstrap and composition root.
 *
 * Responsibilities
 *   1. Create the store from the URL
 *      (?t=&ccy=&mode=&class=&mkt=&sector=&verdict=&view=&range=&p=) and keep the
 *      URL and the store in sync in both directions.
 *   2. Load the daily snapshot, run every engine once per asset, and cache the result.
 *   3. Slice each asset to the selected time range (1M / 3M / 6M / 1Y) and derive
 *      the windowed statistics. The verdict and its indicators always use the
 *      full year: the time range never changes them.
 *   4. Derive the comparison (correlation, position sizes, total risk) for the
 *      selected assets, memoised on exactly the inputs it depends on.
 *   5. Send the heavy maths (Monte Carlo, portfolio statistics and the frontier
 *      sample) to the Web Worker through a "latest wins" job runner, so dragging
 *      a slider never freezes the page and a late reply never overwrites a newer one.
 *   6. Start the key-less live feeds and route their ticks into the store.
 *   7. Mount the UI modules, handing each the same `app` context. The modules
 *      never import each other: they talk only through the store.
 *
 * Nothing is persisted. A reload always starts from the URL plus the latest snapshot.
 */

import {
  createStore, createInitialState, actions, parseUrlState, writeUrlState,
  selectFx, selectPrice, selectSelectedAssets, selectPortfolioWeights, selectRiskFree,
} from './core/store.js';
import {
  isNum, safeDiv, convertCurrency, formatNumber, formatPercent, formatCompact,
} from './core/precisionMath.js';
import {
  traced, input, step, threshold, interpretation, valueOf, buildTraceIndex, fmtN, fmtPct,
} from './core/derivationTracer.js';
import { loadSnapshot, sliceSeries } from './services/snapshotService.js';
import { startLiveFeeds } from './services/liveFeedService.js';
import { getExplainer } from './services/glossaryService.js';
import { createWorkerService, createJobRunner, jobKey } from './services/workerService.js';
import { analyzeTechnicals, analyzeWindow } from './engines/technicalEngine.js';
import { analyzeFundamentals } from './engines/fundamentalEngine.js';
import { analyzeCorrelation, CORR_CONFIG } from './engines/correlationEngine.js';
import { advise } from './engines/advisorEngine.js';
import { sizePosition, portfolioHeat } from './engines/positionSizerEngine.js';
import { analyzeSentiment } from './engines/sentimentEngine.js';
import { analyzeForecast } from './engines/forecastEngine.js';
import { seedFromString } from './engines/monteCarloEngine.js';
import { PORTFOLIO_CONFIG } from './engines/portfolioEngine.js';
import { mountTelemetryBar } from './ui/telemetryBar.js';
import { mountAppTabs } from './ui/appTabs.js';
import { mountScreenerPanel } from './ui/screenerPanel.js';
import { mountComparisonMatrix } from './ui/comparisonMatrix.js';
import { mountLeaderboardView } from './ui/leaderboardView.js';
import { mountPortfolioSandbox } from './ui/portfolioSandbox.js';
import { mountDerivationDrawer } from './ui/derivationDrawer.js';
import { mountRiskSandboxModal } from './ui/riskSandboxModal.js';
import { mountCommandPalette } from './ui/commandPalette.js';

/* ------------------------------------------------------------------ */
/* Store and URL state                                                 */
/* ------------------------------------------------------------------ */

// The initial view comes straight from the query string (URLSearchParams inside
// parseUrlState). From here on the store rewrites the query on every view change.
const store = createStore(createInitialState(window.location.search));

/**
 * Re-read the URL into the store. Runs when the user moves through history
 * (back/forward) to a different query on this page.
 */
function hydrateFromUrl() {
  const view = parseUrlState(window.location.search);
  store.dispatch(actions.setSelected(view.selected));
  store.dispatch(actions.setCurrency(view.currency));
  store.dispatch(actions.setMode(view.mode));
  store.dispatch(actions.setView(view.view));
  store.dispatch(actions.setRange(view.range));
  if (Array.isArray(view.portfolio.weights) && view.portfolio.weights.length) {
    store.dispatch(actions.setPortfolioWeights(view.portfolio.weights));
  } else {
    store.dispatch(actions.resetPortfolio());
  }
  for (const [key, value] of Object.entries(view.filters)) store.dispatch(actions.setFilter(key, value));
}
window.addEventListener('popstate', hydrateFromUrl);

/* ------------------------------------------------------------------ */
/* View helpers shared by every UI module                               */
/* ------------------------------------------------------------------ */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const TONES = ['healthy', 'neutral', 'caution', 'risky'];
const TONE_WORDS = { healthy: 'healthy', neutral: 'neutral', caution: 'caution', risky: 'risky' };
const MULTIPLE_IDS = new Set(['evEbitda', 'trailingPE', 'forwardPE', 'priceToBook', 'debtToEquity']);
// Changes read better with an explicit sign: "+4.2%" cannot be mistaken for a level.
const SIGNED_IDS = new Set(['periodReturn', 'forecast30d', 'portfolioReturn', 'maxDrawdown']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The four time ranges. `label` completes the phrase "over the last …",
 * `short` is the button text and `title` stands on its own.
 */
const RANGE_INFO = Object.freeze({
  '1m': Object.freeze({ id: '1m', short: '1M', label: 'month', title: '1 month' }),
  '3m': Object.freeze({ id: '3m', short: '3M', label: '3 months', title: '3 months' }),
  '6m': Object.freeze({ id: '6m', short: '6M', label: '6 months', title: '6 months' }),
  '1y': Object.freeze({ id: '1y', short: '1Y', label: 'year', title: '1 year' }),
  '5y': Object.freeze({ id: '5y', short: '5Y', label: '5 years', title: '5 years' }),
});

/** Ranges long enough for the full-year correlation rule (at least 60 overlapping returns). */
const FULL_CORRELATION_RANGES = new Set(['1y', '5y']);

/** Escape text for safe insertion into HTML. Every dynamic string goes through this. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** A small shape that carries a tone without relying on colour alone. */
function toneMark(tone) {
  const key = TONES.includes(tone) ? tone : 'none';
  return `<span class="tone tone--${key}" aria-hidden="true"></span>`;
}

function toneWord(tone) {
  return TONE_WORDS[tone] ?? '';
}

/** Amount with sensible decimals: 5.18T, 82,713, 1,781.35, 0.0421. */
function formatAmount(value) {
  if (!isNum(value)) return 'N/A';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6) return formatCompact(value, 2);
  // Above 10,000 the cents are noise and would not fit a phone column.
  if (magnitude >= 10000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  let maximum = 2;
  if (magnitude > 0 && magnitude < 0.01) maximum = 6;
  else if (magnitude < 1) maximum = 4;
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maximum });
}

/** Shares or coins: whole numbers stay whole, fractions keep up to six decimals. */
function formatUnits(value) {
  if (!isNum(value)) return 'N/A';
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

/** A percentage with an explicit sign: +4.2%, −3.1%, 0.0%. */
function signedPercent(value, digits = 1) {
  if (!isNum(value)) return 'N/A';
  const text = formatPercent(Math.abs(value), digits);
  if (value > 0) return `+${text}`;
  return value < 0 ? `−${text}` : text;
}

/** Convert an amount into the display currency. Falls back to the original currency if no rate applies. */
function money(value, fromCurrency) {
  const state = store.getState();
  if (!isNum(value)) return { value: null, currency: fromCurrency ?? state.currency, converted: false };
  if (!fromCurrency || fromCurrency === state.currency) return { value, currency: state.currency, converted: false };
  const fx = selectFx(state);
  const converted = convertCurrency(value, fromCurrency, state.currency, fx ? fx.rate : null);
  if (converted === null) return { value, currency: fromCurrency, converted: false };
  return { value: converted, currency: state.currency, converted: true };
}

/**
 * Display text for a traced metric. Currency metrics are converted to the
 * display currency unless `native` is set (the derivation drawer shows the
 * asset's own currency, because that is what the arithmetic used).
 */
function formatMetric(metric, { withCurrency = false, native = false } = {}) {
  if (!metric || metric.status !== 'ok') return 'N/A';
  const { value, unit } = metric;
  if (typeof value === 'string') return value;
  switch (unit) {
    case 'score': return formatNumber(value, 0);
    case 'index': return formatNumber(value, 1);
    case 'pct': return SIGNED_IDS.has(metric.id) ? signedPercent(value, 1) : formatPercent(value, 1);
    case 'shares': return formatUnits(value);
    case 'currency': {
      const sourceCurrency = metric.meta ? metric.meta.currency : null;
      const shown = native ? { value, currency: sourceCurrency } : money(value, sourceCurrency);
      const text = formatAmount(shown.value);
      return withCurrency && shown.currency ? `${shown.currency} ${text}` : text;
    }
    case 'ratio':
    default:
      return `${formatNumber(value, 2)}${MULTIPLE_IDS.has(metric.id) ? '×' : ''}`;
  }
}

/** One-line spoken description of a metric, for aria-labels. */
function describeMetric(metric) {
  if (!metric) return 'not available';
  if (metric.status !== 'ok') return `not available. ${metric.naReason}`;
  const tone = toneWord(metric.tone);
  return `${formatMetric(metric, { withCurrency: true })}${tone ? `, ${tone}` : ''}`;
}

/** Format a raw trace input or step result with its unit. */
function formatRaw(value, unit = '') {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'string') return value;
  if (unit === 'fraction') return fmtPct(value, 2);
  const text = fmtN(value, 4);
  if (!unit) return text;
  return /^[A-Z]{3}$/.test(unit) ? `${unit} ${text}` : `${text} ${unit}`;
}

/** "2026-11-16" -> "16 Nov" (or "16 Nov 2025" with the year). */
function shortDate(isoDate, withYear = false) {
  if (typeof isoDate !== 'string' || isoDate.length < 10) return '';
  const year = isoDate.slice(0, 4);
  const month = MONTHS[Number(isoDate.slice(5, 7)) - 1];
  const day = Number(isoDate.slice(8, 10));
  if (!month || !day) return isoDate;
  return withYear ? `${day} ${month} ${year}` : `${day} ${month}`;
}

/** "3 h ago", "2 days ago". */
function relativeAge(hours) {
  if (!isNum(hours)) return '';
  if (hours < 1) return 'under an hour ago';
  if (hours < 36) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function rangeInfo(range = store.getState().range) {
  return RANGE_INFO[range] ?? RANGE_INFO['1y'];
}

const h = Object.freeze({
  esc, toneMark, toneWord, formatAmount, formatUnits, formatMetric, describeMetric, formatRaw,
  money, shortDate, relativeAge, formatNumber, formatPercent, formatCompact, signedPercent, rangeInfo,
});

/* ------------------------------------------------------------------ */
/* Analysis cache: every engine, once per asset, per snapshot           */
/* ------------------------------------------------------------------ */

// ticker -> { asset, technical, fundamental, advisor, sentiment, forecast }
const analyses = new Map();

function analyseAsset(asset, fxRate, now) {
  const technical = analyzeTechnicals(asset);
  const fundamental = analyzeFundamentals(asset, { fxRate });
  const advisor = advise({ asset, technical, fundamental });
  // Context only: neither of these ever reaches the verdict.
  const sentiment = analyzeSentiment(asset, { now });
  const forecast = analyzeForecast(asset);
  return { asset, technical, fundamental, advisor, sentiment, forecast };
}

function verdicts() {
  const result = {};
  for (const [ticker, analysis] of analyses) result[ticker] = analysis.advisor.verdict;
  return result;
}

/* ------------------------------------------------------------------ */
/* Time-range windows                                                   */
/* ------------------------------------------------------------------ */

const windows = new Map(); // `${ticker}|${range}` -> window

/**
 * One asset cut down to a time range, with the statistics of that window.
 * Used by the charts, the Period rows, correlation, the simulation's
 * volatility and the portfolio maths. RSI, MACD, the moving averages and the
 * verdict are never computed from a window: they need their full warm-up.
 *
 * @returns {{ range:string, info:object, series:object, asset:object, metrics:object, from:string, to:string, observations:number }|null}
 */
function windowFor(ticker, range = store.getState().range) {
  const analysis = analyses.get(ticker);
  if (!analysis) return null;
  const info = rangeInfo(range);
  const key = `${ticker}|${info.id}`;
  let cached = windows.get(key);
  if (!cached) {
    // 5Y reads the long close-only series; every shorter range is cut from the year of candles.
    const source = info.id === '5y' ? analysis.asset.longSeries : analysis.asset.series;
    const series = sliceSeries(source, info.id);
    const result = analyzeWindow(analysis.asset, series, info.label);
    cached = Object.freeze({
      range: info.id,
      info,
      series,
      asset: { ...analysis.asset, series },
      metrics: result.metrics,
      from: result.from,
      to: result.to,
      observations: result.observations,
    });
    windows.set(key, cached);
  }
  return cached;
}

/* ------------------------------------------------------------------ */
/* Price metric (live tick or last close) with its own trace             */
/* ------------------------------------------------------------------ */

const priceMetricCache = new Map(); // ticker -> { key, metric }

function priceMetric(ticker) {
  const state = store.getState();
  const quote = selectPrice(state, ticker);
  if (!quote) return null;
  const key = `${quote.price}|${quote.source}`;
  const cached = priceMetricCache.get(ticker);
  if (cached && cached.key === key) return cached.metric;

  const asset = state.snapshot.byTicker[ticker];
  const reference = quote.live ? asset.quote.lastClose : asset.quote.previousClose;
  const referenceLabel = quote.live ? `last daily close (${asset.quote.asOf})` : 'previous session close';
  const change = quote.price - reference;
  const changePct = safeDiv(change, reference);
  const metric = traced({
    id: 'price',
    label: 'Last price',
    value: quote.price,
    unit: 'currency',
    tone: null,
    meta: { currency: asset.currency, change, changePct, live: quote.live, source: quote.source, referenceLabel },
    formula: 'Change % = (Price − Reference close) ÷ Reference close',
    rawInputs: [
      input(quote.live ? 'Live price' : 'Last daily close', quote.price, asset.currency, quote.live ? 'Binance public market data (USDT pair)' : 'snapshot: last candle', quote.live ? null : asset.quote.asOf),
      input(quote.live ? 'Last daily close' : 'Previous close', reference, asset.currency, 'snapshot candles', quote.live ? asset.quote.asOf : null),
    ],
    steps: [
      step('Change against the reference close', `${fmtN(quote.price)} − ${fmtN(reference)}`, change),
      step('As a percentage of the reference close', `${fmtN(change)} ÷ ${fmtN(reference)}`, fmtPct(changePct)),
    ],
    interpretation: interpretation(
      quote.live
        ? `Live price from Binance, ${fmtPct(Math.abs(changePct ?? 0))} ${change >= 0 ? 'above' : 'below'} the ${referenceLabel}.`
        : `Last completed daily close (${asset.quote.asOf}), ${fmtPct(Math.abs(changePct ?? 0))} ${change >= 0 ? 'above' : 'below'} the previous session.`,
      [
        threshold('Indicators', 'Always use completed daily candles', 'neutral'),
        threshold('Position sizing', 'Uses this price as the entry', 'neutral'),
      ],
      quote.live
        ? 'Binance quotes BTC and ETH against USDT, which normally trades within a fraction of a percent of the US dollar. Live ticks never feed RSI, MACD or any other indicator.'
        : 'Stock prices are end-of-day and adjusted for splits and dividends. There is no intraday feed for stocks.',
    ),
  });
  priceMetricCache.set(ticker, { key, metric });
  return metric;
}

/* ------------------------------------------------------------------ */
/* Comparison: correlation, sizing and total risk for the selection      */
/* ------------------------------------------------------------------ */

const EMPTY_COMPARISON = Object.freeze({
  assets: [], tickers: [], fx: null, sizings: {}, sizingList: [],
  correlation: analyzeCorrelation([]), heat: portfolioHeat([], null, 'USD'),
});
let correlationMemo = { key: null, value: null };
let comparisonMemo = { key: null, value: EMPTY_COMPARISON };

function comparison() {
  const state = store.getState();
  if (!state.snapshot) return EMPTY_COMPARISON;
  const assets = selectSelectedAssets(state);
  const fx = selectFx(state);
  const fxRate = fx ? fx.rate : null;
  const quotes = assets.map((asset) => selectPrice(state, asset.ticker));
  const info = rangeInfo(state.range);
  const selectionKey = `${state.snapshot.generatedAt}|${info.id}|${assets.map((asset) => asset.ticker).join(',')}`;
  const key = [
    selectionKey, state.currency, fxRate, JSON.stringify(state.account),
    quotes.map((quote) => quote.price).join(','),
  ].join('#');
  if (comparisonMemo.key === key) return comparisonMemo.value;

  // Correlation depends on which assets are selected and on the time range, never on live ticks.
  // A shorter range has fewer return pairs, so it is allowed a lower minimum and says so in its trace.
  if (correlationMemo.key !== selectionKey) {
    const windowed = assets.map((asset) => windowFor(asset.ticker, info.id).asset);
    correlationMemo = {
      key: selectionKey,
      value: analyzeCorrelation(windowed, {
        minOverlap: FULL_CORRELATION_RANGES.has(info.id) ? CORR_CONFIG.minOverlap : CORR_CONFIG.minWindowOverlap,
        windowLabel: info.label,
      }),
    };
  }
  const correlation = correlationMemo.value;

  const sizings = {};
  const sizingList = assets.map((asset, index) => {
    const analysis = analyses.get(asset.ticker);
    const quote = quotes[index];
    const sizing = sizePosition({
      asset,
      entryPrice: quote.price,
      entrySource: quote.live ? 'live Binance price' : `last daily close (${asset.quote.asOf})`,
      atr: valueOf(analysis.technical.metrics.atr14),
      verdict: analysis.advisor.verdict,
      account: state.account,
      accountCurrency: state.currency,
      fxRate,
      comparedCount: assets.length,
      meanCorrelation: correlation.meanByTicker[asset.ticker],
      correlationIds: correlation.pairsByTicker[asset.ticker] ?? [],
    });
    sizings[asset.ticker] = sizing;
    return sizing;
  });
  const heat = portfolioHeat(sizingList, state.account, state.currency);
  const value = { assets, tickers: assets.map((asset) => asset.ticker), fx, sizings, sizingList, correlation, heat, range: info };
  comparisonMemo = { key, value };
  return value;
}

/* ------------------------------------------------------------------ */
/* Web Worker: Monte Carlo and portfolio maths, latest request wins      */
/* ------------------------------------------------------------------ */

// The worker starts on the first request. If module workers are unavailable the
// service runs the same code on the main thread, so results never depend on it.
const workerService = createWorkerService();
const jobs = createJobRunner({ service: workerService, store, actions });

/** Inputs of one simulation: the key identifies them, the payload is what the worker receives. */
function simulationRequest(ticker, { useHistoricalDrift = false } = {}) {
  const state = store.getState();
  const view = state.snapshot ? windowFor(ticker, state.range) : null;
  if (!view) return null;
  const { asset } = view;
  const sizing = comparison().sizings[ticker];
  const quote = selectPrice(state, ticker);
  const summary = sizing && sizing.ok ? sizing.summary : null;
  const startPrice = summary ? summary.entryPrice : quote.price;
  const stop = summary ? summary.stop : null;
  const target = summary ? summary.target : null;
  const drift = Boolean(useHistoricalDrift);
  return {
    key: jobKey('monteCarlo', state.snapshot.generatedAt, ticker, view.range, startPrice, stop, target, drift),
    payload: {
      // Only what the engine reads: the worker does not need a year of candles and fundamentals.
      asset: {
        ticker: asset.ticker,
        currency: asset.currency,
        assetClass: asset.assetClass,
        quote: { asOf: asset.quote.asOf },
        series: { close: view.series.close },
      },
      startPrice,
      stop,
      target,
      useHistoricalDrift: drift,
      historyLabel: view.info.label,
    },
  };
}

/** Ask for a simulation. Safe to call repeatedly: identical inputs are not recomputed. */
function requestSimulation(ticker, options) {
  const request = simulationRequest(ticker, options);
  if (!request) return false;
  return jobs.submit('monteCarlo', request.key, 'monteCarlo', request.payload);
}

/** The simulation slot as seen by one asset: its result is null while another asset's is on screen. */
function simulation(ticker) {
  const job = store.getState().compute.monteCarlo;
  const result = job.result && job.result.ticker === ticker ? job.result : null;
  return { status: job.status, result, error: job.error, ms: job.ms, mode: job.mode };
}

function portfolioRequest(state) {
  if (!state.snapshot) return null;
  const weights = selectPortfolioWeights(state).filter((entry) => state.snapshot.byTicker[entry.ticker]);
  if (weights.length === 0) return null;
  const info = rangeInfo(state.range);
  const fx = selectFx(state);
  const riskFree = selectRiskFree(state);
  const assets = weights.map((entry) => {
    const view = windowFor(entry.ticker, info.id);
    return {
      ticker: view.asset.ticker,
      currency: view.asset.currency,
      assetClass: view.asset.assetClass,
      series: { dates: view.series.dates, close: view.series.close },
    };
  });
  const mix = weights.map((entry) => `${entry.ticker}:${entry.weight}`).join(',');
  return {
    key: jobKey('portfolio', state.snapshot.generatedAt, info.id, state.currency, mix, fx ? fx.rate : null, riskFree ? riskFree.yield : null),
    payload: {
      assets,
      weights,
      baseCurrency: state.currency,
      fx: fx ? { rate: fx.rate, series: state.snapshot.fx.series } : null,
      riskFree,
      frontierSamples: PORTFOLIO_CONFIG.frontierSamples,
      // The sample depends on the assets and the window, not on the weights, so the
      // cloud of alternatives stays put while the user moves a slider.
      frontierSeed: seedFromString(`${weights.map((entry) => entry.ticker).join(',')}|${info.id}|${state.snapshot.generatedAt}`),
    },
  };
}

/** The portfolio slot plus the allocation it belongs to. */
function portfolio() {
  const state = store.getState();
  const job = state.compute.portfolio;
  return {
    status: job.status,
    result: job.result,
    error: job.error,
    ms: job.ms,
    mode: job.mode,
    weights: selectPortfolioWeights(state),
    range: rangeInfo(state.range),
  };
}

let portfolioTimer = null;

function schedulePortfolio(delay = 140) {
  clearTimeout(portfolioTimer);
  portfolioTimer = setTimeout(() => {
    const state = store.getState();
    if (state.status !== 'ready' || state.view !== 'portfolio') return;
    const request = portfolioRequest(state);
    if (request) jobs.submit('portfolio', request.key, 'portfolio', request.payload);
  }, delay);
}

// Portfolio statistics are only computed while the Portfolio view is open. Slider
// drags arrive many times a second, so they are debounced before reaching the worker.
store.subscribe((next, previous) => {
  if (next.status !== 'ready' || next.view !== 'portfolio') return;
  if (next.view !== previous.view || next.status !== previous.status || next.snapshot !== previous.snapshot) {
    schedulePortfolio(0);
  } else if (next.portfolio !== previous.portfolio || next.selected !== previous.selected || next.currency !== previous.currency
    || next.range !== previous.range || next.live.fx !== previous.live.fx) {
    schedulePortfolio();
  }
});

/* ------------------------------------------------------------------ */
/* Trace lookup: one index per asset, used by every view and the drawer  */
/* ------------------------------------------------------------------ */

const indexCache = new Map(); // ticker|'' -> { parts, index }

/**
 * Every traced metric that is in scope for an asset: its indicators,
 * fundamentals, verdict, headline tone, projection and time-range statistics,
 * its position sizing, the latest simulation, plus the selection-wide
 * correlation pairs and total risk. Pass null for the metrics that belong to
 * no single asset: correlation, total risk and the portfolio statistics.
 */
function traceIndex(ticker) {
  const state = store.getState();
  const current = comparison();
  const analysis = ticker ? analyses.get(ticker) ?? null : null;
  const view = analysis ? windowFor(ticker, state.range) : null;
  const sizing = ticker ? current.sizings[ticker] ?? null : null;
  const simulated = state.compute.monteCarlo.result;
  const run = ticker && simulated && simulated.ticker === ticker ? simulated : null;
  const price = analysis ? priceMetric(ticker) : null;
  const held = !ticker && state.compute.portfolio.result ? state.compute.portfolio.result.analysis : null;
  const parts = [analysis, view, sizing, run, price, current.correlation, current.heat, held];
  const cacheKey = ticker ?? '';
  const cached = indexCache.get(cacheKey);
  if (cached && cached.parts.every((part, position) => part === parts[position])) return cached.index;
  const index = buildTraceIndex(
    analysis ? [analysis.technical.metrics, analysis.fundamental.metrics, analysis.advisor.metrics, analysis.sentiment.metrics, analysis.forecast.metrics] : null,
    view ? view.metrics : null,
    sizing ? sizing.metrics : null,
    run ? run.metrics : null,
    price,
    current.correlation.pairs,
    current.heat,
    held ? held.metrics : null,
  );
  indexCache.set(cacheKey, { parts, index });
  return index;
}

function trace(ticker, id) {
  return traceIndex(ticker || null).get(id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Application context handed to every UI module                         */
/* ------------------------------------------------------------------ */

let lastTriggerKey = null;

const app = {
  store,
  actions,
  h,
  analysis: (ticker) => analyses.get(ticker) ?? null,
  window: (ticker, range) => windowFor(ticker, range),
  verdicts,
  comparison,
  priceMetric,
  requestSimulation,
  simulation,
  portfolio,
  traceIndex,
  trace,
  explain: (id, profile) => getExplainer(id, profile),
  reload: () => boot(),
  /** Set by the command palette when it mounts, so any module can open it. */
  openPalette: () => {},
  /** Remember which control opened the drawer, so focus can return to it. */
  rememberTrigger(key) {
    lastTriggerKey = key || null;
  },
  takeTrigger() {
    const key = lastTriggerKey;
    lastTriggerKey = null;
    return key;
  },
};

/* ------------------------------------------------------------------ */
/* Page-level rendering: status, views, body attributes, title, notices   */
/* ------------------------------------------------------------------ */

const elements = {
  telemetry: document.getElementById('telemetry-bar'),
  tabs: document.getElementById('app-tabs'),
  screener: document.getElementById('screener'),
  workspace: document.getElementById('workspace'),
  status: document.getElementById('app-status'),
  matrix: document.getElementById('comparison-matrix'),
  leaderboard: document.getElementById('leaderboard'),
  portfolio: document.getElementById('portfolio'),
  drawer: document.getElementById('derivation-drawer'),
  scrim: document.getElementById('drawer-scrim'),
  sandbox: document.getElementById('risk-sandbox'),
  palette: document.getElementById('command-palette'),
  notices: document.getElementById('notice-region'),
};

const viewPanels = Object.freeze({
  compare: elements.matrix,
  leaderboard: elements.leaderboard,
  portfolio: elements.portfolio,
});
const VIEW_TITLES = Object.freeze({ leaderboard: 'Leaderboard', portfolio: 'Portfolio' });

let lastError = null;

function renderStatus(state) {
  document.body.dataset.status = state.status;
  elements.workspace.setAttribute('aria-busy', state.status === 'loading' ? 'true' : 'false');
  // Exactly one tab panel is visible, and only once the data is ready.
  for (const [view, panel] of Object.entries(viewPanels)) panel.hidden = !(state.status === 'ready' && state.view === view);
  elements.status.hidden = state.status === 'ready';
  if (state.status === 'loading') {
    elements.status.innerHTML = `
      <div class="status-card">
        <span class="spinner" aria-hidden="true"></span>
        <p class="status-card__title">Loading the market snapshot…</p>
        <p class="status-card__text">Prices and fundamentals are read from a file that is refreshed once a day.</p>
      </div>`;
  } else if (state.status === 'error') {
    const details = lastError && Array.isArray(lastError.details) ? lastError.details.filter(Boolean) : [];
    elements.status.innerHTML = `
      <div class="status-card status-card--error">
        <p class="status-card__title">The market data could not be loaded</p>
        <p class="status-card__text">${esc(state.error)}</p>
        ${details.length ? `<p class="status-card__details">${details.slice(0, 5).map(esc).join('<br>')}</p>` : ''}
        <button type="button" class="btn btn--primary" data-action="retry">Try again</button>
      </div>`;
  }
}

elements.status.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="retry"]')) boot();
});

function renderChrome(state) {
  document.body.dataset.mode = state.mode;
  document.body.dataset.view = state.view;
  document.body.dataset.drawer = state.drawer.open ? 'open' : 'closed';
  document.documentElement.lang = 'en';
  if (VIEW_TITLES[state.view]) {
    document.title = `${VIEW_TITLES[state.view]} · QuantLens`;
  } else {
    document.title = state.selected.length
      ? `${state.selected.join(' vs ')} · QuantLens`
      : 'QuantLens · Multi-Asset Comparison Workstation';
  }
}

let noticeTimer = null;
function renderNotice(state) {
  clearTimeout(noticeTimer);
  if (!state.notice) {
    elements.notices.innerHTML = '';
    return;
  }
  elements.notices.innerHTML = `
    <div class="notice">
      <span>${esc(state.notice.text)}</span>
      <button type="button" class="icon-btn" data-action="dismiss-notice" aria-label="Dismiss message">×</button>
    </div>`;
  noticeTimer = setTimeout(() => store.dispatch(actions.dismissNotice()), 5000);
}

elements.notices.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="dismiss-notice"]')) store.dispatch(actions.dismissNotice());
});

store.subscribe((next, previous) => {
  if (next.status !== previous.status || next.error !== previous.error || next.view !== previous.view) renderStatus(next);
  if (next.mode !== previous.mode || next.drawer.open !== previous.drawer.open || next.selected !== previous.selected
    || next.view !== previous.view) renderChrome(next);
  if (next.notice !== previous.notice) renderNotice(next);
});

/* ------------------------------------------------------------------ */
/* Mount the UI                                                         */
/* ------------------------------------------------------------------ */

mountTelemetryBar(elements.telemetry, app);
mountAppTabs(elements.tabs, app);
mountScreenerPanel(elements.screener, app);
mountComparisonMatrix(elements.matrix, app);
mountLeaderboardView(elements.leaderboard, app);
mountPortfolioSandbox(elements.portfolio, app);
mountDerivationDrawer(elements.drawer, app, elements.scrim);
mountRiskSandboxModal(elements.sandbox, app);
const palette = mountCommandPalette(elements.palette, app);
app.openPalette = palette.open;
renderChrome(store.getState());

/* ------------------------------------------------------------------ */
/* Boot: snapshot -> engines -> store -> live feeds                      */
/* ------------------------------------------------------------------ */

let feeds = null;
let booting = false;

async function boot() {
  if (booting) return;
  booting = true;
  lastError = null;
  store.dispatch(actions.snapshotLoading());
  try {
    const snapshot = await loadSnapshot();

    analyses.clear();
    windows.clear();
    priceMetricCache.clear();
    indexCache.clear();
    correlationMemo = { key: null, value: null };
    comparisonMemo = { key: null, value: EMPTY_COMPARISON };
    const now = new Date();
    for (const asset of snapshot.assets) analyses.set(asset.ticker, analyseAsset(asset, snapshot.fx.rate, now));

    store.dispatch(actions.snapshotLoaded(snapshot, snapshot.warnings));
    // Canonicalise the address bar: drop unknown tickers and malformed values from a hand-edited link.
    writeUrlState(store.getState());

    if (feeds) feeds.stop();
    feeds = startLiveFeeds({
      snapshot,
      onPrice: (tick) => store.dispatch(actions.livePrice(tick.ticker, tick.price, tick.ts, tick.source)),
      onFx: (fx) => store.dispatch(actions.liveFx(fx)),
      onStatus: (feed, status) => store.dispatch(actions.feedStatus(feed, status)),
    });
  } catch (error) {
    lastError = error;
    console.error('[QuantLens] boot failed', error);
    const message = error && error.name === 'SnapshotError'
      ? error.message
      : 'Something went wrong while preparing the analysis. Reload the page to try again.';
    if (!(error && error.name === 'SnapshotError')) {
      lastError = { details: [String(error && error.message ? error.message : error)] };
    }
    store.dispatch(actions.snapshotFailed(message));
  } finally {
    booting = false;
  }
}

// A debugging handle for the console and the test page. Read-only by convention.
window.QuantLens = Object.freeze({ store, app, worker: workerService });

if (window.location.protocol !== 'file:') boot();
