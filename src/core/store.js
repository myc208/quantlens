/**
 * store.js: one in-memory state tree, one-way data flow, URL-synced view state.
 *
 * Stateless by design: nothing is written to localStorage, sessionStorage,
 * cookies or IndexedDB. Every visit starts from defaults plus whatever the URL
 * says. The URL carries only the shareable view (tickers, filters, currency,
 * mode). Account size and risk settings stay in memory so a shared link can
 * never leak them.
 *
 *   UI event -> dispatch(action) -> reduce(state, action) -> new state
 *            -> URL updated (history.replaceState) -> subscribers re-render
 */

export const MAX_SELECTED = 3;
export const DEFAULT_SELECTED = Object.freeze(['AAPL', 'D05.SI', 'BTC-USD']);

export const CURRENCIES = Object.freeze(['USD', 'SGD']);
export const MODES = Object.freeze(['guided', 'pro']);
export const FILTER_OPTIONS = Object.freeze({
  assetClass: Object.freeze(['all', 'equity', 'crypto']),
  market: Object.freeze(['all', 'US', 'SG', 'CRYPTO']),
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
});
const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/;

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
    account: { ...DEFAULT_ACCOUNT },
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
      return {
        ...state,
        status: 'ready',
        error: null,
        snapshot: action.snapshot,
        warnings: Array.isArray(action.warnings) ? action.warnings : [],
        selected,
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
      || next.currency !== previous.currency || next.mode !== previous.mode;
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
