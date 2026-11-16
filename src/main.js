/**
 * main.js: application bootstrap and composition root.
 *
 * Responsibilities
 *   1. Create the store from the URL (?t=&ccy=&mode=&class=&mkt=&sector=&verdict=)
 *      and keep the URL and the store in sync in both directions.
 *   2. Load the daily snapshot, run every engine once per asset, and cache the result.
 *   3. Derive the comparison (correlation, position sizes, total risk) for the
 *      selected assets, memoised on exactly the inputs it depends on.
 *   4. Start the key-less live feeds and route their ticks into the store.
 *   5. Mount the UI modules, handing each the same `app` context. The modules
 *      never import each other: they talk only through the store.
 *
 * Nothing is persisted. A reload always starts from the URL plus the latest snapshot.
 */

import {
  createStore, createInitialState, actions, parseUrlState, writeUrlState,
  selectFx, selectPrice, selectSelectedAssets,
} from './core/store.js';
import {
  isNum, safeDiv, convertCurrency, formatNumber, formatPercent, formatCompact,
} from './core/precisionMath.js';
import {
  traced, input, step, threshold, interpretation, valueOf, buildTraceIndex, fmtN, fmtPct,
} from './core/derivationTracer.js';
import { loadSnapshot } from './services/snapshotService.js';
import { startLiveFeeds } from './services/liveFeedService.js';
import { getExplainer } from './services/glossaryService.js';
import { analyzeTechnicals } from './engines/technicalEngine.js';
import { analyzeFundamentals } from './engines/fundamentalEngine.js';
import { analyzeCorrelation } from './engines/correlationEngine.js';
import { advise } from './engines/advisorEngine.js';
import { sizePosition, portfolioHeat } from './engines/positionSizerEngine.js';
import { runMonteCarlo } from './engines/monteCarloEngine.js';
import { mountTelemetryBar } from './ui/telemetryBar.js';
import { mountScreenerPanel } from './ui/screenerPanel.js';
import { mountComparisonMatrix } from './ui/comparisonMatrix.js';
import { mountDerivationDrawer } from './ui/derivationDrawer.js';
import { mountRiskSandboxModal } from './ui/riskSandboxModal.js';

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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
    case 'pct': return formatPercent(value, 1);
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

const h = Object.freeze({
  esc, toneMark, toneWord, formatAmount, formatUnits, formatMetric, describeMetric, formatRaw,
  money, shortDate, relativeAge, formatNumber, formatPercent, formatCompact,
});

/* ------------------------------------------------------------------ */
/* Analysis cache: every engine, once per asset, per snapshot           */
/* ------------------------------------------------------------------ */

const analyses = new Map(); // ticker -> { asset, technical, fundamental, advisor }

function analyseAsset(asset, fxRate) {
  const technical = analyzeTechnicals(asset);
  const fundamental = analyzeFundamentals(asset, { fxRate });
  const advisor = advise({ asset, technical, fundamental });
  return { asset, technical, fundamental, advisor };
}

function verdicts() {
  const result = {};
  for (const [ticker, analysis] of analyses) result[ticker] = analysis.advisor.verdict;
  return result;
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
  const selectionKey = `${state.snapshot.generatedAt}|${assets.map((asset) => asset.ticker).join(',')}`;
  const key = [
    selectionKey, state.currency, fxRate, JSON.stringify(state.account),
    quotes.map((quote) => quote.price).join(','),
  ].join('#');
  if (comparisonMemo.key === key) return comparisonMemo.value;

  // Correlation depends only on which assets are selected, never on live ticks.
  if (correlationMemo.key !== selectionKey) {
    correlationMemo = { key: selectionKey, value: analyzeCorrelation(assets) };
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
  const value = { assets, tickers: assets.map((asset) => asset.ticker), fx, sizings, sizingList, correlation, heat };
  comparisonMemo = { key, value };
  return value;
}

/* ------------------------------------------------------------------ */
/* Monte Carlo (run on demand by the risk sandbox)                       */
/* ------------------------------------------------------------------ */

const simulations = new Map(); // ticker -> { key, result }

function simulate(ticker, { useHistoricalDrift = false } = {}) {
  const state = store.getState();
  const asset = state.snapshot ? state.snapshot.byTicker[ticker] : null;
  if (!asset) return null;
  const sizing = comparison().sizings[ticker];
  const quote = selectPrice(state, ticker);
  const summary = sizing && sizing.ok ? sizing.summary : null;
  const startPrice = summary ? summary.entryPrice : quote.price;
  const stop = summary ? summary.stop : null;
  const target = summary ? summary.target : null;
  const key = [startPrice, stop, target, useHistoricalDrift].join('|');
  const cached = simulations.get(ticker);
  if (cached && cached.key === key) return cached.result;
  const result = runMonteCarlo({ asset, startPrice, stop, target, useHistoricalDrift });
  simulations.set(ticker, { key, result });
  return result;
}

/* ------------------------------------------------------------------ */
/* Trace lookup: one index per asset, used by the matrix and the drawer  */
/* ------------------------------------------------------------------ */

const indexCache = new Map(); // ticker|'' -> { parts, index }

/**
 * Every traced metric that is in scope for an asset: its indicators,
 * fundamentals and verdict, its position sizing, the latest simulation, plus
 * the selection-wide correlation pairs and total risk. Pass null for the
 * selection-wide metrics only.
 */
function traceIndex(ticker) {
  const current = comparison();
  const analysis = ticker ? analyses.get(ticker) : null;
  const sizing = ticker ? current.sizings[ticker] : null;
  const simulation = ticker ? simulations.get(ticker) : null;
  const price = ticker && analysis ? priceMetric(ticker) : null;
  const parts = [analysis, sizing, simulation ? simulation.result : null, price, current.correlation, current.heat];
  const cacheKey = ticker ?? '';
  const cached = indexCache.get(cacheKey);
  if (cached && cached.parts.every((part, position) => part === parts[position])) return cached.index;
  const index = buildTraceIndex(
    analysis ? [analysis.technical.metrics, analysis.fundamental.metrics, analysis.advisor.metrics] : null,
    sizing ? sizing.metrics : null,
    simulation ? simulation.result.metrics : null,
    price,
    current.correlation.pairs,
    current.heat,
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
  verdicts,
  comparison,
  priceMetric,
  simulate,
  traceIndex,
  trace,
  explain: (id, profile) => getExplainer(id, profile),
  reload: () => boot(),
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
/* Page-level rendering: status, body attributes, title, notices         */
/* ------------------------------------------------------------------ */

const elements = {
  telemetry: document.getElementById('telemetry-bar'),
  screener: document.getElementById('screener'),
  workspace: document.getElementById('workspace'),
  status: document.getElementById('app-status'),
  matrix: document.getElementById('comparison-matrix'),
  drawer: document.getElementById('derivation-drawer'),
  scrim: document.getElementById('drawer-scrim'),
  sandbox: document.getElementById('risk-sandbox'),
  notices: document.getElementById('notice-region'),
};

let lastError = null;

function renderStatus(state) {
  document.body.dataset.status = state.status;
  elements.workspace.setAttribute('aria-busy', state.status === 'loading' ? 'true' : 'false');
  elements.matrix.hidden = state.status !== 'ready';
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
  document.body.dataset.drawer = state.drawer.open ? 'open' : 'closed';
  document.documentElement.lang = 'en';
  document.title = state.selected.length
    ? `${state.selected.join(' vs ')} · QuantLens`
    : 'QuantLens · Multi-Asset Comparison Workstation';
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
  if (next.status !== previous.status || next.error !== previous.error) renderStatus(next);
  if (next.mode !== previous.mode || next.drawer.open !== previous.drawer.open || next.selected !== previous.selected) renderChrome(next);
  if (next.notice !== previous.notice) renderNotice(next);
});

/* ------------------------------------------------------------------ */
/* Mount the UI                                                         */
/* ------------------------------------------------------------------ */

mountTelemetryBar(elements.telemetry, app);
mountScreenerPanel(elements.screener, app);
mountComparisonMatrix(elements.matrix, app);
mountDerivationDrawer(elements.drawer, app, elements.scrim);
mountRiskSandboxModal(elements.sandbox, app);
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
    priceMetricCache.clear();
    simulations.clear();
    indexCache.clear();
    for (const asset of snapshot.assets) analyses.set(asset.ticker, analyseAsset(asset, snapshot.fx.rate));

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
window.QuantLens = Object.freeze({ store, app });

if (window.location.protocol !== 'file:') boot();
