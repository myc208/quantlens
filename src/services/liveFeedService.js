/**
 * liveFeedService.js: key-less live data in the browser.
 *
 *   Crypto ticks  Binance public market-data WebSocket, seeded by REST.
 *                 Fallback chain: WebSocket -> REST polling -> snapshot close.
 *   USD/SGD       Frankfurter (ECB daily reference rate, not a live quote).
 *                 Fallback chain: frankfurter.dev -> frankfurter.app -> snapshot rate.
 *
 * Nothing here ever throws to the caller or blocks the page: every failure
 * degrades to the next source and is reported through a status callback so the
 * telemetry bar can show exactly which source is in use.
 *
 * Live ticks are display-only. Indicators are always computed from completed
 * daily candles in the snapshot.
 */

import { isNum } from '../core/precisionMath.js';

// api.frankfurter.app now answers with a 301 to api.frankfurter.dev that carries no CORS
// headers, so browsers block it. The .dev host is therefore tried first; .app stays as a
// second attempt in case the redirect is ever fixed or the hosts swap roles again.
export const FX_ENDPOINTS = Object.freeze([
  Object.freeze({ id: 'frankfurter.dev', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=SGD' }),
  Object.freeze({ id: 'frankfurter.app', url: 'https://api.frankfurter.app/latest?from=USD&to=SGD' }),
]);
export const BINANCE_REST_HOSTS = Object.freeze(['https://data-api.binance.vision', 'https://api.binance.com']);
export const BINANCE_WS_HOSTS = Object.freeze(['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443']);

/** Feed states reported through onStatus. */
export const FEED_STATUS = Object.freeze({
  CONNECTING: 'connecting', // trying to reach a live source
  LIVE: 'live', // WebSocket ticks arriving
  POLLING: 'polling', // WebSocket unavailable, REST prices every few seconds
  OFFLINE: 'offline', // no live source; the snapshot close is shown
  PAUSED: 'paused', // tab hidden
  STOPPED: 'stopped',
});

const DEFAULTS = Object.freeze({
  requestTimeoutMs: 6000,
  wsSilenceMs: 20000, // reconnect if no message for this long
  wsMaxAttempts: 5, // then fall back to REST polling
  wsRetryAfterFallbackMs: 300000, // retry the WebSocket every 5 minutes while polling
  backoffBaseMs: 1000,
  backoffMaxMs: 30000,
  pollIntervalMs: 20000,
  fxRefreshMs: 3600000, // the reference rate changes once per working day
});

/* ------------------------------------------------------------------ */
/* HTTP helper                                                         */
/* ------------------------------------------------------------------ */

/** GET JSON with a hard timeout. Rejects on network error, timeout or non-2xx. */
export async function fetchJson(url, { timeoutMs = DEFAULTS.requestTimeoutMs, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* USD/SGD reference rate                                              */
/* ------------------------------------------------------------------ */

function parseFrankfurter(payload) {
  const rate = payload && payload.rates ? payload.rates.SGD : null;
  if (!isNum(rate) || rate < 0.5 || rate > 3) throw new Error('response did not contain a plausible SGD rate');
  const asOf = typeof payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date) ? payload.date : null;
  return { rate, asOf };
}

/**
 * Fetch the USD->SGD reference rate. Never throws.
 *
 * @param {{ fallback?: {rate:number, asOf:string}|null, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ rate:number|null, asOf:string|null, source:string, live:boolean, errors:string[] }>}
 *   `live` is true when the rate came from Frankfurter, false when it is the snapshot fallback.
 */
export async function fetchUsdSgd({ fallback = null, timeoutMs = DEFAULTS.requestTimeoutMs, fetchImpl } = {}) {
  const errors = [];
  for (const endpoint of FX_ENDPOINTS) {
    try {
      const payload = await fetchJson(endpoint.url, { timeoutMs, fetchImpl });
      const { rate, asOf } = parseFrankfurter(payload);
      return { rate, asOf, source: endpoint.id, live: true, errors };
    } catch (error) {
      errors.push(`${endpoint.id}: ${error && error.message ? error.message : error}`);
    }
  }
  if (fallback && isNum(fallback.rate) && fallback.rate > 0) {
    return { rate: fallback.rate, asOf: fallback.asOf ?? null, source: 'snapshot', live: false, errors };
  }
  return { rate: null, asOf: null, source: 'none', live: false, errors };
}

/* ------------------------------------------------------------------ */
/* Binance crypto feed                                                 */
/* ------------------------------------------------------------------ */

function restPriceUrl(host, binanceSymbols) {
  return `${host}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(binanceSymbols))}`;
}

function streamUrl(host, binanceSymbols) {
  const streams = binanceSymbols.map((symbol) => `${symbol.toLowerCase()}@miniTicker`).join('/');
  return `${host}/stream?streams=${streams}`;
}

/** Fetch last prices over REST, trying each host in turn. Resolves to { SYMBOL: price }. */
export async function fetchBinancePrices(binanceSymbols, { timeoutMs = DEFAULTS.requestTimeoutMs, fetchImpl } = {}) {
  const errors = [];
  for (const host of BINANCE_REST_HOSTS) {
    try {
      const payload = await fetchJson(restPriceUrl(host, binanceSymbols), { timeoutMs, fetchImpl });
      const prices = {};
      for (const row of Array.isArray(payload) ? payload : []) {
        const price = Number(row && row.price);
        if (row && typeof row.symbol === 'string' && isNum(price) && price > 0) prices[row.symbol] = price;
      }
      if (Object.keys(prices).length === 0) throw new Error('response contained no prices');
      return prices;
    } catch (error) {
      errors.push(`${host}: ${error && error.message ? error.message : error}`);
    }
  }
  throw new Error(errors.join(' | '));
}

/**
 * Live crypto prices with automatic degradation.
 *
 * @param {object} options
 * @param {{ticker:string, binanceSymbol:string}[]} options.symbols
 * @param {(tick:{ticker:string, symbol:string, price:number, ts:number, source:string}) => void} options.onTick
 * @param {(status:string, detail?:string) => void} [options.onStatus]
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {{ start: () => void, stop: () => void, getStatus: () => string }}
 */
export function createCryptoFeed({ symbols, onTick, onStatus = () => {}, WebSocketImpl, fetchImpl, config = {} }) {
  const settings = { ...DEFAULTS, ...config };
  const Socket = WebSocketImpl ?? (typeof WebSocket === 'function' ? WebSocket : null);
  const pairs = (Array.isArray(symbols) ? symbols : []).filter((s) => s && s.ticker && s.binanceSymbol);
  const tickerBySymbol = new Map(pairs.map((s) => [s.binanceSymbol.toUpperCase(), s.ticker]));
  const binanceSymbols = [...tickerBySymbol.keys()];
  const lastEmitted = new Map(); // ticker -> { price, ts }

  let status = FEED_STATUS.STOPPED;
  let running = false;
  let socket = null;
  let wsAttempts = 0;
  let hostIndex = 0;
  let lastMessageAt = 0;
  let reconnectTimer = null;
  let watchdogTimer = null;
  let pollTimer = null;
  let visibilityHandler = null;

  function setStatus(next, detail) {
    if (status === next) return;
    status = next;
    try {
      onStatus(next, detail);
    } catch (error) { /* a broken status handler must not kill the feed */ }
  }

  function emit(symbol, price, ts, source) {
    const ticker = tickerBySymbol.get(symbol);
    if (!ticker || !isNum(price) || price <= 0) return;
    const previous = lastEmitted.get(ticker);
    // At most one update per second per asset, and only when the price moved.
    if (previous && (previous.price === price || ts - previous.ts < 1000)) return;
    lastEmitted.set(ticker, { price, ts });
    try {
      onTick({ ticker, symbol, price, ts, source });
    } catch (error) { /* a broken tick handler must not kill the feed */ }
  }

  async function pollOnce() {
    try {
      const prices = await fetchBinancePrices(binanceSymbols, { timeoutMs: settings.requestTimeoutMs, fetchImpl });
      if (!running) return true;
      const now = Date.now();
      for (const [symbol, price] of Object.entries(prices)) emit(symbol, price, now, 'binance-rest');
      return true;
    } catch (error) {
      return false;
    }
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    if (pollTimer || !running) return;
    const tick = async () => {
      const ok = await pollOnce();
      if (!running || status === FEED_STATUS.LIVE) return;
      setStatus(ok ? FEED_STATUS.POLLING : FEED_STATUS.OFFLINE, ok ? 'REST prices' : 'Binance is unreachable');
    };
    tick();
    pollTimer = setInterval(tick, settings.pollIntervalMs);
  }

  function clearSocket() {
    if (!socket) return;
    const old = socket;
    socket = null;
    old.onopen = null;
    old.onmessage = null;
    old.onerror = null;
    old.onclose = null;
    try {
      old.close();
    } catch (error) { /* already closed */ }
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    wsAttempts += 1;
    hostIndex = (hostIndex + 1) % BINANCE_WS_HOSTS.length;
    let delay;
    if (wsAttempts >= settings.wsMaxAttempts) {
      // The WebSocket is blocked or down: serve REST prices and retry occasionally.
      startPolling();
      delay = settings.wsRetryAfterFallbackMs;
    } else {
      setStatus(FEED_STATUS.CONNECTING, `reconnecting (attempt ${wsAttempts + 1})`);
      // Exponential backoff plus jitter of up to half the base delay, so many tabs do not reconnect in step.
      delay = Math.min(settings.backoffMaxMs, settings.backoffBaseMs * 2 ** (wsAttempts - 1)) + Math.random() * settings.backoffBaseMs * 0.5;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleMessage(event) {
    lastMessageAt = Date.now();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    const data = message && message.data ? message.data : message;
    if (!data || typeof data.s !== 'string') return;
    const price = Number(data.c);
    if (!isNum(price) || price <= 0) return;
    if (status !== FEED_STATUS.LIVE) {
      wsAttempts = 0;
      stopPolling();
      setStatus(FEED_STATUS.LIVE, 'Binance WebSocket');
    }
    emit(data.s.toUpperCase(), price, isNum(data.E) ? data.E : lastMessageAt, 'binance-ws');
  }

  function connect() {
    if (!running) return;
    if (!Socket) {
      startPolling();
      return;
    }
    clearSocket();
    let next;
    try {
      next = new Socket(streamUrl(BINANCE_WS_HOSTS[hostIndex], binanceSymbols));
    } catch (error) {
      scheduleReconnect();
      return;
    }
    socket = next;
    lastMessageAt = Date.now();
    next.onmessage = handleMessage;
    next.onerror = () => { /* onclose always follows and drives the reconnect */ };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      scheduleReconnect();
    };
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!running || !socket) return;
      if (Date.now() - lastMessageAt > settings.wsSilenceMs) {
        clearSocket();
        scheduleReconnect();
      }
    }, 5000);
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    reconnectTimer = null;
    watchdogTimer = null;
    stopPolling();
  }

  function resume() {
    if (running) return;
    running = true;
    wsAttempts = 0;
    setStatus(FEED_STATUS.CONNECTING, 'connecting');
    pollOnce(); // seed prices immediately; the WebSocket takes over when it opens
    connect();
    startWatchdog();
  }

  function pause(nextStatus) {
    running = false;
    clearTimers();
    clearSocket();
    setStatus(nextStatus);
  }

  function start() {
    if (binanceSymbols.length === 0) {
      setStatus(FEED_STATUS.OFFLINE, 'no crypto assets in the watchlist');
      return;
    }
    if (typeof document !== 'undefined' && !visibilityHandler) {
      // Do not hold a socket open for a background tab.
      visibilityHandler = () => {
        if (document.hidden) pause(FEED_STATUS.PAUSED);
        else resume();
      };
      document.addEventListener('visibilitychange', visibilityHandler);
    }
    if (typeof document !== 'undefined' && document.hidden) {
      setStatus(FEED_STATUS.PAUSED);
      return;
    }
    resume();
  }

  function stop() {
    if (typeof document !== 'undefined' && visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    pause(FEED_STATUS.STOPPED);
  }

  return { start, stop, getStatus: () => status };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Start every live feed for a loaded snapshot.
 *
 * @param {object} options
 * @param {object} options.snapshot normalised snapshot from snapshotService
 * @param {(tick:object) => void} options.onPrice crypto tick
 * @param {(fx:object) => void} options.onFx USD/SGD result (live or snapshot fallback)
 * @param {(feed:'crypto'|'fx', status:string, detail?:string) => void} [options.onStatus]
 * @returns {{ stop: () => void }}
 */
export function startLiveFeeds({ snapshot, onPrice, onFx, onStatus = () => {}, fetchImpl, WebSocketImpl, config = {} }) {
  const settings = { ...DEFAULTS, ...config };
  let stopped = false;

  const cryptoSymbols = snapshot.assets
    .filter((asset) => asset.assetClass === 'crypto' && asset.binanceSymbol)
    .map((asset) => ({ ticker: asset.ticker, binanceSymbol: asset.binanceSymbol }));
  const cryptoFeed = createCryptoFeed({
    symbols: cryptoSymbols,
    onTick: onPrice,
    onStatus: (status, detail) => onStatus('crypto', status, detail),
    fetchImpl,
    WebSocketImpl,
    config,
  });
  cryptoFeed.start();

  async function refreshFx() {
    onStatus('fx', FEED_STATUS.CONNECTING);
    const result = await fetchUsdSgd({ fallback: snapshot.fx, timeoutMs: settings.requestTimeoutMs, fetchImpl });
    if (stopped) return;
    if (isNum(result.rate)) onFx(result);
    onStatus('fx', result.live ? FEED_STATUS.LIVE : FEED_STATUS.OFFLINE, result.source);
  }
  refreshFx();
  const fxTimer = setInterval(refreshFx, settings.fxRefreshMs);

  return {
    stop() {
      stopped = true;
      clearInterval(fxTimer);
      cryptoFeed.stop();
    },
  };
}
