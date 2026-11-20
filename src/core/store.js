/**
 * store.js: one in-memory state tree, one-way data flow, URL-synced view state.
 *
 * Stateless by design: nothing is written to localStorage, sessionStorage,
 * cookies or IndexedDB. Every visit starts from defaults plus whatever the URL
 * says. The URL carries only the shareable view (tickers, filters, currency,
 * mode, tab, time range and portfolio weights as percentages). Account size and
 * risk settings stay in memory so a shared link can never leak them.
 *
 * Heavy calculations run in a Web Worker. Their state lives in the `compute`
 * slice, keyed by the inputs they were started with, so a late reply for
 * inputs that have since changed is discarded ("latest wins").
 *
 *   UI event -> dispatch(action) -> reduce(state, action) -> new state
 *            -> URL updated (history.replaceState) -> subscribers re-render
 */

export const MAX_SELECTED = 3;
export const DEFAULT_SELECTED = Object.freeze(['AMD', 'D05.SI', 'BTC-USD']);

export const CURRENCIES = Object.freeze(['USD', 'SGD']);
export const MODES = Object.freeze(['guided', 'pro']);
export const VIEWS = Object.freeze(['compare', 'leaderboard', 'portfolio']);
export const RANGES = Object.freeze(['1m', '3m', '6m', '1y']);
export const DEFAULT_VIEW = 'compare';
export const DEFAULT_RANGE = '1y';
export const MAX_PORTFOLIO_ASSETS = 8;
export const COMPUTE_JOBS = Object.freeze(['monteCarlo', 'portfolio']);
export const FILTER_OPTIONS = Object.freeze({
  assetClass: Object.freeze(['all', 'equity', 'etf', 'index', 'crypto']),
  market: Object.freeze(['all', 'US', 'SG', 'UK', 'CRYPTO']),
  verdict: Object.freeze(['all', 'buy', 'hold', 'sell']),
});

export const DEFAULT_FILTERS = Object.freeze({ assetClass: 'all', market: 'all', sector: 'all', verdict: 'all' });
export const DEFAULT_ACCOUNT = Object.freeze({ equity: 10000, riskPct: 1, atrMultiple: 2, maxPositionPct: 25 });

/** Bounds for the personal risk inputs. Guided mode keeps risk per trade conservative. */
export const ACCOUNT_LIMITS = Object.freeze({
  equity: Object.freeze({ min: 100, max: 1e9 }),
  riskPct: Object.freeze({ guided: Object.freeze({ min: 0.25, max: 2 }), pro: Object.freeze({ min: 0.25, max: 5 }) }),
  atrMultiple: Object.freeze({ min: 1, max: 4 }),
  maxPositionPct: Object.freeze({ min: 5, max: 100 }),
});

const URL_KEYS = Object.freeze({
  selected: 't', currency: 'ccy', mode: 'mode',
  assetClass: 'class', market: 'mkt', sector: 'sector', verdict: 'verdict',
  view: 'view', range: 'range', portfolio: 'p',
});
// Yahoo symbols: AMD, BRK-B, D05.SI, CSPX.L, BTC-USD, and indices with a leading caret (^GSPC).
const TICKER_PATTERN = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/;

/* ------------------------------------------------------------------ */
/* URL <-> state                                                       */
/* ------------------------------------------------------------------ */

function uniqueTickers(list) {
  const seen = [];
  for (const raw of list) {
    const ticker = String(raw).trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker) && !seen.includes(ticker)) seen.push(ticker);
    if (seen.length === MAX_SELECTED) break;
  }
  return seen;
}

/** Round a percentage to two decimals and keep it inside 0..100. */
function cleanWeight(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  return Math.round(Math.min(100, Math.max(0, number)) * 100) / 100;
}

/** Equal percentages that add up to exactly 100 (the last one absorbs the rounding). */
export function equalWeights(tickers) {
  const count = tickers.length;
  if (count === 0) return [];
  const share = Math.floor((100 / count) * 100) / 100;
  return tickers.map((ticker, index) => ({
    ticker,
    weight: index === count - 1 ? Math.round((100 - share * (count - 1)) * 100) / 100 : share,
  }));
}

/** Parse "AAPL:40,D05.SI:35,BTC-USD:25" into weights. Returns null when nothing valid is present. */
function parsePortfolio(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const entries = [];
  for (const part of raw.split(',')) {
    const [rawTicker, rawWeight] = part.split(':');
    const ticker = String(rawTicker ?? '').trim().toUpperCase();
    const weight = cleanWeight(rawWeight);
    if (!TICKER_PATTERN.test(ticker) || weight === null || entries.some((entry) => entry.ticker === ticker)) continue;
    entries.push({ ticker, weight });
    if (entries.length === MAX_PORTFOLIO_ASSETS) break;
  }
  return entries.length ? entries : null;
}

function matchOption(options, raw) {
  if (typeof raw !== 'string') return null;
  const wanted = raw.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted) ?? null;
}

/**
 * Parse a query string into view state. Unknown or malformed values fall back
 * to defaults, so a hand-edited or stale link can never break the page.
 * A missing `t` means "use the default trio"; an empty `t=` means "none selected".
 */
export function parseUrlState(search = '') {
  const params = new URLSearchParams(search);
  const rawTickers = params.get(URL_KEYS.selected);
  const rawSector = params.get(URL_KEYS.sector);
  return {
    selected: rawTickers === null ? [...DEFAULT_SELECTED] : uniqueTickers(rawTickers.split(',')),
    currency: matchOption(CURRENCIES, params.get(URL_KEYS.currency)) ?? 'USD',
    mode: matchOption(MODES, params.get(URL_KEYS.mode)) ?? 'guided',
    view: matchOption(VIEWS, params.get(URL_KEYS.view)) ?? DEFAULT_VIEW,
    range: matchOption(RANGES, params.get(URL_KEYS.range)) ?? DEFAULT_RANGE,
    portfolio: { weights: parsePortfolio(params.get(URL_KEYS.portfolio)) },
    filters: {
      assetClass: matchOption(FILTER_OPTIONS.assetClass, params.get(URL_KEYS.assetClass)) ?? 'all',
      market: matchOption(FILTER_OPTIONS.market, params.get(URL_KEYS.market)) ?? 'all',
      sector: rawSector && rawSector.trim() && rawSector.trim().length <= 60 ? rawSector.trim() : 'all',
      verdict: matchOption(FILTER_OPTIONS.verdict, params.get(URL_KEYS.verdict)) ?? 'all',
    },
  };
}

function sameList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Serialise view state to a query string. Defaults are omitted, so the
 * default view has a clean URL with no query at all.
 */
export function serializeUrlState(state) {
  const parts = [];
  const add = (key, value) => parts.push(`${key}=${value}`);
  if (!sameList(state.selected, DEFAULT_SELECTED)) {
    add(URL_KEYS.selected, state.selected.map(encodeURIComponent).join(','));
  }
  if (state.currency !== 'USD') add(URL_KEYS.currency, state.currency);
  if (state.mode !== 'guided') add(URL_KEYS.mode, state.mode);
  const { filters } = state;
  if (filters.assetClass !== 'all') add(URL_KEYS.assetClass, filters.assetClass);
  if (filters.market !== 'all') add(URL_KEYS.market, filters.market);
  if (filters.sector !== 'all') add(URL_KEYS.sector, encodeURIComponent(filters.sector).replace(/%20/g, '+'));
  if (filters.verdict !== 'all') add(URL_KEYS.verdict, filters.verdict);
  if (state.view && state.view !== DEFAULT_VIEW) add(URL_KEYS.view, state.view);
  if (state.range && state.range !== DEFAULT_RANGE) add(URL_KEYS.range, state.range);
  // Weights are percentages only, so a shared portfolio never reveals an amount of money.
  const weights = state.portfolio ? state.portfolio.weights : null;
  if (Array.isArray(weights) && weights.length) {
    add(URL_KEYS.portfolio, weights.map((entry) => `${encodeURIComponent(entry.ticker)}:${entry.weight}`).join(','));
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Write the shareable view state into the address bar without adding a history
 * entry. Called by the store on every view change and by main.js at boot to
 * canonicalise a hand-edited link.
 */
export function writeUrlState(state) {
  if (typeof window === 'undefined' || !window.history || !window.location) return;
  const next = `${window.location.pathname}${serializeUrlState(state)}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  try {
    window.history.replaceState(null, '', next);
  } catch (error) {
    // Some embedded or sandboxed contexts forbid history writes; the view still works.
  }
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export function createInitialState(search) {
  const query = typeof search === 'string'
    ? search
    : (typeof window !== 'undefined' && window.location ? window.location.search : '');
  const view = parseUrlState(query);
  return {
    status: 'loading', // loading | ready | error
    error: null,
    snapshot: null,
    warnings: [],
    selected: view.selected,
    filters: view.filters,
    currency: view.currency,
    mode: view.mode,
    view: view.view,
    range: view.range,
    // weights: null means "follow the compared assets, equally weighted".
    portfolio: view.portfolio,
    account: { ...DEFAULT_ACCOUNT },
    compute: Object.fromEntries(COMPUTE_JOBS.map((job) => [job, emptyJob()])),
    live: {
      prices: {}, // ticker -> { price, ts, source }
      fx: null, // { rate, asOf, source, live }
      feeds: { crypto: 'idle', fx: 'idle' },
    },
    drawer: { open: false, ticker: null, traceId: null, trail: [] },
    sandbox: { open: false, ticker: null },
    notice: null, // { id, text }
  };
}

function emptyJob() {
  return { key: null, status: 'idle', result: null, error: null, ms: null, mode: null };
}

/** The portfolio in force: explicit weights, or the compared assets weighted equally. */
function effectiveWeights(state) {
  if (Array.isArray(state.portfolio.weights)) return state.portfolio.weights;
  return equalWeights(state.selected);
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function riskLimits(mode) {
  return mode === 'pro' ? ACCOUNT_LIMITS.riskPct.pro : ACCOUNT_LIMITS.riskPct.guided;
}

function sanitiseAccount(account, mode) {
  const risk = riskLimits(mode);
  return {
    equity: clampNumber(account.equity, ACCOUNT_LIMITS.equity.min, ACCOUNT_LIMITS.equity.max, DEFAULT_ACCOUNT.equity),
    riskPct: clampNumber(account.riskPct, risk.min, risk.max, DEFAULT_ACCOUNT.riskPct),
    atrMultiple: clampNumber(account.atrMultiple, ACCOUNT_LIMITS.atrMultiple.min, ACCOUNT_LIMITS.atrMultiple.max, DEFAULT_ACCOUNT.atrMultiple),
    maxPositionPct: clampNumber(account.maxPositionPct, ACCOUNT_LIMITS.maxPositionPct.min, ACCOUNT_LIMITS.maxPositionPct.max, DEFAULT_ACCOUNT.maxPositionPct),
  };
}

let noticeCounter = 0;
function notice(text) {
  noticeCounter += 1;
  return { id: noticeCounter, text };
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export const actions = Object.freeze({
  snapshotLoaded: (snapshot, warnings = []) => ({ type: 'SNAPSHOT_LOADED', snapshot, warnings }),
  snapshotLoading: () => ({ type: 'SNAPSHOT_LOADING' }),
  snapshotFailed: (message) => ({ type: 'SNAPSHOT_FAILED', message }),
  toggleTicker: (ticker) => ({ type: 'TOGGLE_TICKER', ticker }),
  removeTicker: (ticker) => ({ type: 'REMOVE_TICKER', ticker }),
  setSelected: (tickers) => ({ type: 'SET_SELECTED', tickers }),
  setFilter: (key, value) => ({ type: 'SET_FILTER', key, value }),
  resetFilters: () => ({ type: 'RESET_FILTERS' }),
  setCurrency: (currency) => ({ type: 'SET_CURRENCY', currency }),
  setMode: (mode) => ({ type: 'SET_MODE', mode }),
  setAccount: (key, value) => ({ type: 'SET_ACCOUNT', key, value }),
  setView: (view) => ({ type: 'SET_VIEW', view }),
  setRange: (range) => ({ type: 'SET_RANGE', range }),
  setPortfolioWeight: (ticker, weight) => ({ type: 'SET_PORTFOLIO_WEIGHT', ticker, weight }),
  setPortfolioWeights: (weights) => ({ type: 'SET_PORTFOLIO_WEIGHTS', weights }),
  addPortfolioAsset: (ticker) => ({ type: 'ADD_PORTFOLIO_ASSET', ticker }),
  removePortfolioAsset: (ticker) => ({ type: 'REMOVE_PORTFOLIO_ASSET', ticker }),
  equalisePortfolio: () => ({ type: 'EQUALISE_PORTFOLIO' }),
  normalisePortfolio: () => ({ type: 'NORMALISE_PORTFOLIO' }),
  resetPortfolio: () => ({ type: 'RESET_PORTFOLIO' }),
  computeStarted: (job, key) => ({ type: 'COMPUTE_STARTED', job, key }),
  computeFinished: (job, key, result, ms = null, mode = null) => ({ type: 'COMPUTE_FINISHED', job, key, result, ms, mode }),
  computeFailed: (job, key, message) => ({ type: 'COMPUTE_FAILED', job, key, message }),
  livePrice: (ticker, price, ts, source) => ({ type: 'LIVE_PRICE', ticker, price, ts, source }),
  liveFx: (fx) => ({ type: 'LIVE_FX', fx }),
  feedStatus: (feed, status) => ({ type: 'FEED_STATUS', feed, status }),
  openTrace: (ticker, traceId) => ({ type: 'OPEN_TRACE', ticker, traceId }),
  drillTrace: (traceId) => ({ type: 'DRILL_TRACE', traceId }),
  backTrace: () => ({ type: 'BACK_TRACE' }),
  jumpTrace: (index) => ({ type: 'JUMP_TRACE', index }),
  notify: (text) => ({ type: 'NOTIFY', text }),
  closeTrace: () => ({ type: 'CLOSE_TRACE' }),
  openSandbox: (ticker) => ({ type: 'OPEN_SANDBOX', ticker }),
  closeSandbox: () => ({ type: 'CLOSE_SANDBOX' }),
  dismissNotice: () => ({ type: 'DISMISS_NOTICE' }),
});

/* ------------------------------------------------------------------ */
/* Reducer (pure: same state + action -> same result)                   */
/* ------------------------------------------------------------------ */

export function reduce(state, action) {
  switch (action.type) {
    case 'SNAPSHOT_LOADED': {
      const known = new Set(action.snapshot.assets.map((asset) => asset.ticker));
      const selected = state.selected.filter((ticker) => known.has(ticker));
      const dropped = state.selected.filter((ticker) => !known.has(ticker));
      const sectorKnown = state.filters.sector === 'all' || action.snapshot.sectors.includes(state.filters.sector);
      let portfolio = state.portfolio;
      if (Array.isArray(portfolio.weights)) {
        const kept = portfolio.weights.filter((entry) => known.has(entry.ticker));
        if (kept.length !== portfolio.weights.length) portfolio = { weights: kept.length ? kept : null };
      }
      return {
        ...state,
        status: 'ready',
        error: null,
        snapshot: action.snapshot,
        warnings: Array.isArray(action.warnings) ? action.warnings : [],
        selected,
        portfolio,
        filters: sectorKnown ? state.filters : { ...state.filters, sector: 'all' },
        notice: dropped.length ? notice(`Not in the watchlist, so removed from the comparison: ${dropped.join(', ')}`) : state.notice,
      };
    }
    case 'SNAPSHOT_LOADING':
      return state.status === 'loading' ? state : { ...state, status: 'loading', error: null };
    case 'SNAPSHOT_FAILED':
      return { ...state, status: 'error', error: String(action.message || 'The market snapshot could not be loaded.') };

    case 'TOGGLE_TICKER': {
      const ticker = String(action.ticker || '').toUpperCase();
      if (!TICKER_PATTERN.test(ticker)) return state;
      if (state.selected.includes(ticker)) {
        return { ...state, selected: state.selected.filter((item) => item !== ticker) };
      }
      if (state.selected.length >= MAX_SELECTED) {
        return { ...state, notice: notice(`You can compare up to ${MAX_SELECTED} assets. Remove one first.`) };
      }
      if (state.snapshot && !state.snapshot.byTicker[ticker]) return state;
      return { ...state, selected: [...state.selected, ticker] };
    }
    case 'REMOVE_TICKER': {
      if (!state.selected.includes(action.ticker)) return state;
      return { ...state, selected: state.selected.filter((item) => item !== action.ticker) };
    }
    case 'SET_SELECTED': {
      let selected = uniqueTickers(Array.isArray(action.tickers) ? action.tickers : []);
      if (state.snapshot) selected = selected.filter((ticker) => state.snapshot.byTicker[ticker]);
      return sameList(selected, state.selected) ? state : { ...state, selected };
    }

    case 'SET_FILTER': {
      const { key } = action;
      if (!(key in DEFAULT_FILTERS)) return state;
      let value;
      if (key === 'sector') {
        const sectors = state.snapshot ? state.snapshot.sectors : null;
        value = action.value === 'all' || !sectors || sectors.includes(action.value) ? String(action.value) : 'all';
      } else {
        value = matchOption(FILTER_OPTIONS[key], String(action.value)) ?? 'all';
      }
      if (state.filters[key] === value) return state;
      return { ...state, filters: { ...state.filters, [key]: value } };
    }
    case 'RESET_FILTERS':
      return { ...state, filters: { ...DEFAULT_FILTERS } };

    case 'SET_CURRENCY': {
      const currency = matchOption(CURRENCIES, String(action.currency));
      if (!currency || currency === state.currency) return state;
      return { ...state, currency };
    }
    case 'SET_MODE': {
      const mode = matchOption(MODES, String(action.mode));
      if (!mode || mode === state.mode) return state;
      // Switching back to Guided re-applies the conservative risk cap.
      return { ...state, mode, account: sanitiseAccount(state.account, mode) };
    }
    case 'SET_ACCOUNT': {
      if (!(action.key in DEFAULT_ACCOUNT)) return state;
      const account = sanitiseAccount({ ...state.account, [action.key]: action.value }, state.mode);
      if (account[action.key] === state.account[action.key]) return state;
      return { ...state, account };
    }

    case 'SET_VIEW': {
      const view = matchOption(VIEWS, String(action.view));
      return !view || view === state.view ? state : { ...state, view };
    }
    case 'SET_RANGE': {
      const range = matchOption(RANGES, String(action.range));
      return !range || range === state.range ? state : { ...state, range };
    }

    case 'SET_PORTFOLIO_WEIGHT': {
      const weight = cleanWeight(action.weight);
      const current = effectiveWeights(state);
      const index = current.findIndex((entry) => entry.ticker === action.ticker);
      if (weight === null || index < 0 || (Array.isArray(state.portfolio.weights) && current[index].weight === weight)) return state;
      const weights = current.map((entry, position) => (position === index ? { ticker: entry.ticker, weight } : entry));
      return { ...state, portfolio: { weights } };
    }
    case 'SET_PORTFOLIO_WEIGHTS': {
      // Replace the whole allocation at once (used when applying a suggested mix).
      const weights = [];
      for (const entry of Array.isArray(action.weights) ? action.weights : []) {
        const ticker = String((entry && entry.ticker) || '').toUpperCase();
        const weight = cleanWeight(entry ? entry.weight : null);
        if (!TICKER_PATTERN.test(ticker) || weight === null || weights.some((item) => item.ticker === ticker)) continue;
        if (state.snapshot && !state.snapshot.byTicker[ticker]) continue;
        weights.push({ ticker, weight });
        if (weights.length === MAX_PORTFOLIO_ASSETS) break;
      }
      return weights.length ? { ...state, portfolio: { weights } } : state;
    }
    case 'ADD_PORTFOLIO_ASSET': {
      const ticker = String(action.ticker || '').toUpperCase();
      const current = effectiveWeights(state);
      if (!TICKER_PATTERN.test(ticker) || current.some((entry) => entry.ticker === ticker)) return state;
      if (state.snapshot && !state.snapshot.byTicker[ticker]) return state;
      if (current.length >= MAX_PORTFOLIO_ASSETS) {
        return { ...state, notice: notice(`A portfolio can hold up to ${MAX_PORTFOLIO_ASSETS} assets. Remove one first.`) };
      }
      // A new asset starts at 0% so that adding it never silently changes the existing allocation.
      return { ...state, portfolio: { weights: [...current, { ticker, weight: 0 }] } };
    }
    case 'REMOVE_PORTFOLIO_ASSET': {
      const current = effectiveWeights(state);
      if (!current.some((entry) => entry.ticker === action.ticker)) return state;
      return { ...state, portfolio: { weights: current.filter((entry) => entry.ticker !== action.ticker) } };
    }
    case 'EQUALISE_PORTFOLIO': {
      const current = effectiveWeights(state);
      if (current.length === 0) return state;
      return { ...state, portfolio: { weights: equalWeights(current.map((entry) => entry.ticker)) } };
    }
    case 'NORMALISE_PORTFOLIO': {
      const current = effectiveWeights(state);
      const total = current.reduce((sum, entry) => sum + entry.weight, 0);
      if (!(total > 0) || Math.abs(total - 100) < 0.005) return state;
      const scaled = current.map((entry) => ({ ticker: entry.ticker, weight: Math.round((entry.weight / total) * 10000) / 100 }));
      // Put the rounding remainder on the largest holding so the total is exactly 100.
      const drift = Math.round((100 - scaled.reduce((sum, entry) => sum + entry.weight, 0)) * 100) / 100;
      const largest = scaled.reduce((best, entry, index) => (entry.weight > scaled[best].weight ? index : best), 0);
      scaled[largest] = { ticker: scaled[largest].ticker, weight: Math.round((scaled[largest].weight + drift) * 100) / 100 };
      return { ...state, portfolio: { weights: scaled } };
    }
    case 'RESET_PORTFOLIO':
      return state.portfolio.weights === null ? state : { ...state, portfolio: { weights: null } };

    case 'COMPUTE_STARTED': {
      const job = state.compute[action.job];
      if (!job || typeof action.key !== 'string' || (job.key === action.key && job.status === 'running')) return state;
      // The previous result is kept on purpose: the UI shows it dimmed while the new one is computed.
      return { ...state, compute: { ...state.compute, [action.job]: { ...job, key: action.key, status: 'running', error: null } } };
    }
    case 'COMPUTE_FINISHED': {
      const job = state.compute[action.job];
      // Latest wins: a reply for inputs that are no longer current is discarded.
      if (!job || job.key !== action.key || job.status !== 'running') return state;
      return {
        ...state,
        compute: { ...state.compute, [action.job]: { key: action.key, status: 'done', result: action.result, error: null, ms: action.ms ?? null, mode: action.mode ?? null } },
      };
    }
    case 'COMPUTE_FAILED': {
      const job = state.compute[action.job];
      if (!job || job.key !== action.key || job.status !== 'running') return state;
      return {
        ...state,
        compute: { ...state.compute, [action.job]: { ...job, status: 'error', result: null, error: String(action.message || 'The calculation failed.') } },
      };
    }

    case 'LIVE_PRICE': {
      if (typeof action.price !== 'number' || !Number.isFinite(action.price) || action.price <= 0) return state;
      const previous = state.live.prices[action.ticker];
      if (previous && previous.price === action.price && previous.source === action.source) return state;
      return {
        ...state,
        live: {
          ...state.live,
          prices: { ...state.live.prices, [action.ticker]: { price: action.price, ts: action.ts, source: action.source } },
        },
      };
    }
    case 'LIVE_FX': {
      const fx = action.fx;
      if (!fx || typeof fx.rate !== 'number' || !Number.isFinite(fx.rate) || fx.rate <= 0) return state;
      return { ...state, live: { ...state.live, fx: { rate: fx.rate, asOf: fx.asOf ?? null, source: fx.source ?? 'unknown', live: Boolean(fx.live) } } };
    }
    case 'FEED_STATUS': {
      if (!(action.feed in state.live.feeds) || state.live.feeds[action.feed] === action.status) return state;
      return { ...state, live: { ...state.live, feeds: { ...state.live.feeds, [action.feed]: action.status } } };
    }

    case 'OPEN_TRACE':
      return { ...state, drawer: { open: true, ticker: action.ticker ?? null, traceId: action.traceId, trail: [action.traceId] } };
    case 'DRILL_TRACE': {
      if (!state.drawer.open || state.drawer.traceId === action.traceId) return state;
      return { ...state, drawer: { ...state.drawer, traceId: action.traceId, trail: [...state.drawer.trail, action.traceId] } };
    }
    case 'BACK_TRACE': {
      if (!state.drawer.open || state.drawer.trail.length <= 1) return state;
      const trail = state.drawer.trail.slice(0, -1);
      return { ...state, drawer: { ...state.drawer, trail, traceId: trail[trail.length - 1] } };
    }
    case 'JUMP_TRACE': {
      const { trail } = state.drawer;
      if (!state.drawer.open || !Number.isInteger(action.index) || action.index < 0 || action.index >= trail.length - 1) return state;
      const shorter = trail.slice(0, action.index + 1);
      return { ...state, drawer: { ...state.drawer, trail: shorter, traceId: shorter[shorter.length - 1] } };
    }
    case 'NOTIFY':
      return typeof action.text === 'string' && action.text ? { ...state, notice: notice(action.text) } : state;
    case 'CLOSE_TRACE':
      return state.drawer.open ? { ...state, drawer: { open: false, ticker: null, traceId: null, trail: [] } } : state;

    case 'OPEN_SANDBOX':
      return { ...state, sandbox: { open: true, ticker: action.ticker ?? null } };
    case 'CLOSE_SANDBOX':
      return state.sandbox.open ? { ...state, sandbox: { open: false, ticker: null } } : state;

    case 'DISMISS_NOTICE':
      return state.notice ? { ...state, notice: null } : state;

    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} [initialState]
 * @param {{ syncUrl?: boolean }} [options] set syncUrl false in tests
 */
export function createStore(initialState = createInitialState(), { syncUrl = true } = {}) {
  let state = initialState;
  const listeners = new Set();

  function getState() {
    return state;
  }

  function dispatch(action) {
    if (!action || typeof action.type !== 'string') return state;
    const previous = state;
    const next = reduce(previous, action);
    if (next === previous) return state;
    state = next;
    const viewChanged = next.selected !== previous.selected || next.filters !== previous.filters
      || next.currency !== previous.currency || next.mode !== previous.mode
      || next.view !== previous.view || next.range !== previous.range || next.portfolio !== previous.portfolio;
    if (syncUrl && viewChanged) writeUrlState(next);
    for (const listener of [...listeners]) {
      try {
        listener(next, previous, action);
      } catch (error) {
        // One broken panel must not stop the others from updating.
        if (typeof console !== 'undefined') console.error('[store] subscriber failed', error);
      }
    }
    return state;
  }

  /**
   * Subscribe to changes. With a selector, the listener only fires when the
   * selected slice changes identity (state updates are immutable), which keeps
   * once-per-second live ticks from re-rendering unrelated panels.
   */
  function subscribe(listener, selector) {
    const wrapped = typeof selector === 'function'
      ? (next, previous, action) => {
        if (!Object.is(selector(next), selector(previous))) listener(next, previous, action);
      }
      : listener;
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  }

  return { getState, dispatch, subscribe };
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

/** The USD->SGD rate in force: live reference rate if we have one, else the snapshot's. */
export function selectFx(state) {
  if (state.live.fx) return state.live.fx;
  if (state.snapshot) {
    return { rate: state.snapshot.fx.rate, asOf: state.snapshot.fx.asOf, source: 'snapshot', live: false };
  }
  return null;
}

/** The price to display for a ticker: live tick if we have one, else the last daily close. */
export function selectPrice(state, ticker) {
  const asset = state.snapshot ? state.snapshot.byTicker[ticker] : null;
  if (!asset) return null;
  const tick = state.live.prices[ticker];
  if (tick) return { price: tick.price, source: tick.source, ts: tick.ts, live: true, currency: asset.currency };
  return { price: asset.quote.lastClose, source: 'snapshot', ts: asset.quote.asOf, live: false, currency: asset.currency };
}

/** The portfolio weights in force, as percentages: explicit, or the compared assets weighted equally. */
export function selectPortfolioWeights(state) {
  return effectiveWeights(state);
}

/** True when the user has set weights by hand (and so they are in the URL). */
export function hasCustomPortfolio(state) {
  return Array.isArray(state.portfolio.weights);
}

/** The risk-free rate for the display currency, or null before the snapshot loads. */
export function selectRiskFree(state) {
  if (!state.snapshot || !state.snapshot.macro) return null;
  return state.snapshot.macro.riskFree[state.currency] ?? null;
}

export function selectSelectedAssets(state) {
  if (!state.snapshot) return [];
  return state.selected.map((ticker) => state.snapshot.byTicker[ticker]).filter(Boolean);
}

/**
 * Apply the screener filters.
 * @param {object[]} assets normalised assets
 * @param {object} filters state.filters
 * @param {Record<string, string|null>} [verdictByTicker] e.g. { AAPL: 'BUY' }
 */
export function filterAssets(assets, filters, verdictByTicker = {}) {
  return assets.filter((asset) => {
    if (filters.assetClass !== 'all' && asset.assetClass !== filters.assetClass) return false;
    if (filters.market !== 'all' && asset.market !== filters.market) return false;
    if (filters.sector !== 'all' && asset.sector !== filters.sector) return false;
    if (filters.verdict !== 'all') {
      const verdict = verdictByTicker[asset.ticker];
      if (typeof verdict !== 'string' || verdict.toLowerCase() !== filters.verdict) return false;
    }
    return true;
  });
}

export function hasActiveFilters(filters) {
  return Object.keys(DEFAULT_FILTERS).some((key) => filters[key] !== DEFAULT_FILTERS[key]);
}
