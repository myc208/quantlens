/**
 * snapshotService.js: loads, validates and normalises ./data/market_snapshot.json.
 *
 * The snapshot is produced by scripts/fetch_fundamentals.py in GitHub Actions.
 * The browser never trusts it blindly: the same schema rules are re-checked
 * here, an invalid asset is dropped with a warning instead of breaking the
 * page, and the age of the data is reported so staleness is always visible.
 */

import { isNum } from '../core/precisionMath.js';

export const SNAPSHOT_URL = './data/market_snapshot.json';
export const SUPPORTED_SCHEMA_VERSION = 1;
export const MIN_CANDLES = 200;
export const CANDLE_FIELDS = Object.freeze(['date', 'open', 'high', 'low', 'close', 'volume']);
export const FUNDAMENTAL_KEYS = Object.freeze([
  'marketCap', 'enterpriseValue', 'ebit', 'ebitda', 'operatingIncome', 'totalRevenue', 'netIncome',
  'freeCashFlow', 'totalDebt', 'totalCash', 'totalEquity', 'totalAssets', 'trailingPE', 'forwardPE',
  'priceToBook', 'returnOnEquity', 'dividendYieldTTM',
]);

const ASSET_CLASSES = ['equity', 'crypto'];
const MARKETS = ['US', 'SG', 'CRYPTO'];
const PROFILES = ['CORPORATE', 'FINANCIAL', 'REIT', 'CRYPTO'];
const STATUSES = ['fresh', 'stale'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/;

export class SnapshotError extends Error {
  /**
   * @param {string} message plain-English message safe to show to the user
   * @param {{ code?: string, details?: string[] }} [info]
   */
  constructor(message, { code = 'SNAPSHOT_ERROR', details = [] } = {}) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Returns the list of schema violations for one asset (empty when valid). */
export function validateAsset(asset) {
  if (!isPlainObject(asset)) return ['asset is not an object'];
  const errors = [];

  if (typeof asset.ticker !== 'string' || !TICKER_PATTERN.test(asset.ticker)) errors.push('ticker must be an upper-case symbol');
  if (typeof asset.name !== 'string' || !asset.name.trim()) errors.push('name must be a non-empty string');
  if (!ASSET_CLASSES.includes(asset.assetClass)) errors.push(`assetClass must be one of ${ASSET_CLASSES.join(', ')}`);
  if (!MARKETS.includes(asset.market)) errors.push(`market must be one of ${MARKETS.join(', ')}`);
  for (const key of ['currency', 'financialCurrency']) {
    if (typeof asset[key] !== 'string' || !CURRENCY_PATTERN.test(asset[key])) errors.push(`${key} must be a 3-letter ISO code`);
  }
  if (!PROFILES.includes(asset.scoringProfile)) errors.push(`scoringProfile must be one of ${PROFILES.join(', ')}`);
  if (asset.assetClass === 'crypto' && asset.scoringProfile !== 'CRYPTO') errors.push('crypto assets must use the CRYPTO profile');
  if (asset.assetClass !== 'crypto' && asset.scoringProfile === 'CRYPTO') errors.push('only crypto assets may use the CRYPTO profile');
  for (const key of ['sector', 'industry', 'statusNote', 'fundamentalsPeriod', 'binanceSymbol']) {
    if (asset[key] !== null && asset[key] !== undefined && typeof asset[key] !== 'string') errors.push(`${key} must be a string or null`);
  }
  if (!isNum(asset.lotSize) || asset.lotSize <= 0) errors.push('lotSize must be a positive number');
  if (!STATUSES.includes(asset.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);

  if (!isPlainObject(asset.fundamentals)) {
    errors.push('fundamentals must be an object');
  } else {
    for (const key of FUNDAMENTAL_KEYS) {
      const value = asset.fundamentals[key];
      if (value === undefined) errors.push(`fundamentals.${key} is missing`);
      else if (value !== null && !isNum(value)) errors.push(`fundamentals.${key} must be a finite number or null`);
    }
  }

  const candles = asset.candles;
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    errors.push(`needs at least ${MIN_CANDLES} candles (has ${Array.isArray(candles) ? candles.length : 0})`);
    return errors;
  }
  let previousDate = '';
  for (let i = 0; i < candles.length; i += 1) {
    const row = candles[i];
    if (!Array.isArray(row) || row.length !== CANDLE_FIELDS.length) {
      errors.push(`candle ${i} must have ${CANDLE_FIELDS.length} fields`);
      break;
    }
    const [date, open, high, low, close, volume] = row;
    if (!isIsoDate(date)) {
      errors.push(`candle ${i} has an invalid date`);
      break;
    }
    if (date <= previousDate) {
      errors.push(`candles must be strictly ascending by date (at ${date})`);
      break;
    }
    previousDate = date;
    if (![open, high, low, close].every((price) => isNum(price) && price > 0)) {
      errors.push(`candle ${date} has a non-positive or non-finite price`);
      break;
    }
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      errors.push(`candle ${date} violates high >= max(open, close) or low <= min(open, close)`);
      break;
    }
    if (!isNum(volume) || volume < 0) {
      errors.push(`candle ${date} has an invalid volume`);
      break;
    }
  }

  const quote = asset.quote;
  if (!isPlainObject(quote) || !isNum(quote.lastClose) || !isNum(quote.previousClose) || !isIsoDate(quote.asOf)) {
    errors.push('quote must contain lastClose, previousClose and asOf');
  } else if (errors.length === 0) {
    const last = candles[candles.length - 1];
    if (quote.asOf !== last[0] || quote.lastClose !== last[4]) errors.push('quote does not match the last candle');
  }
  return errors;
}

/**
 * Validate the whole document.
 * @returns {{ fatal: string[], assetErrors: Record<string, string[]> }}
 *   `fatal` problems make the snapshot unusable; `assetErrors` only remove single assets.
 */
export function validateSnapshot(raw) {
  const fatal = [];
  const assetErrors = {};
  if (!isPlainObject(raw)) return { fatal: ['the file is not a JSON object'], assetErrors };

  if (raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fatal.push(`schemaVersion ${JSON.stringify(raw.schemaVersion)} is not supported (expected ${SUPPORTED_SCHEMA_VERSION})`);
  }
  if (typeof raw.generatedAt !== 'string' || !Number.isFinite(Date.parse(raw.generatedAt))) {
    fatal.push('generatedAt must be an ISO-8601 timestamp');
  }
  if (!Array.isArray(raw.candleFields) || raw.candleFields.join(',') !== CANDLE_FIELDS.join(',')) {
    fatal.push(`candleFields must be [${CANDLE_FIELDS.join(', ')}]`);
  }
  const fx = raw.fx;
  if (!isPlainObject(fx) || fx.base !== 'USD' || fx.quote !== 'SGD' || !isNum(fx.rate) || fx.rate < 0.5 || fx.rate > 3 || !isIsoDate(fx.asOf)) {
    fatal.push('fx must be a plausible USD/SGD rate with an asOf date');
  }
  if (!Array.isArray(raw.assets) || raw.assets.length === 0) {
    fatal.push('assets must be a non-empty list');
    return { fatal, assetErrors };
  }

  const seen = new Set();
  raw.assets.forEach((asset, index) => {
    const label = isPlainObject(asset) && typeof asset.ticker === 'string' ? asset.ticker : `asset #${index + 1}`;
    const errors = validateAsset(asset);
    if (seen.has(label)) errors.push('duplicate ticker');
    seen.add(label);
    if (errors.length) assetErrors[label] = errors;
  });
  if (Object.keys(assetErrors).length === raw.assets.length) fatal.push('no asset passed validation');
  return { fatal, assetErrors };
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function toSeries(candles) {
  const length = candles.length;
  const series = {
    dates: new Array(length), open: new Array(length), high: new Array(length),
    low: new Array(length), close: new Array(length), volume: new Array(length),
  };
  for (let i = 0; i < length; i += 1) {
    const row = candles[i];
    series.dates[i] = row[0];
    series.open[i] = row[1];
    series.high[i] = row[2];
    series.low[i] = row[3];
    series.close[i] = row[4];
    series.volume[i] = row[5];
  }
  return series;
}

function normaliseAsset(asset) {
  const fundamentals = {};
  for (const key of FUNDAMENTAL_KEYS) fundamentals[key] = isNum(asset.fundamentals[key]) ? asset.fundamentals[key] : null;
  return Object.freeze({
    ticker: asset.ticker,
    name: asset.name.trim(),
    assetClass: asset.assetClass,
    market: asset.market,
    currency: asset.currency,
    financialCurrency: asset.financialCurrency,
    sector: asset.sector ?? null,
    industry: asset.industry ?? null,
    scoringProfile: asset.scoringProfile,
    lotSize: asset.lotSize,
    binanceSymbol: asset.binanceSymbol ?? null,
    status: asset.status,
    statusNote: asset.statusNote ?? null,
    fundamentalsPeriod: asset.fundamentalsPeriod ?? null,
    quote: Object.freeze({ lastClose: asset.quote.lastClose, previousClose: asset.quote.previousClose, asOf: asset.quote.asOf }),
    fundamentals: Object.freeze(fundamentals),
    series: toSeries(asset.candles),
    candleCount: asset.candles.length,
  });
}

/**
 * How old the snapshot is. The pipeline runs daily, so:
 *   fresh  <= 36 hours,  aging  <= 4 days,  stale  beyond that.
 */
export function describeAge(generatedAt, now = new Date()) {
  const generated = Date.parse(generatedAt);
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(generated) || !Number.isFinite(current)) return { ageHours: null, ageDays: null, freshness: 'unknown' };
  const ageHours = Math.max(0, (current - generated) / 3600000);
  const ageDays = ageHours / 24;
  let freshness = 'stale';
  if (ageHours <= 36) freshness = 'fresh';
  else if (ageDays <= 4) freshness = 'aging';
  return { ageHours, ageDays, freshness };
}

/**
 * Validate and convert the raw document into the shape the engines use.
 * Throws SnapshotError when the document as a whole is unusable.
 */
export function normaliseSnapshot(raw, now = new Date()) {
  const { fatal, assetErrors } = validateSnapshot(raw);
  if (fatal.length) {
    throw new SnapshotError('The market snapshot failed validation, so nothing can be shown safely.', { code: 'INVALID_SNAPSHOT', details: fatal });
  }
  const warnings = [];
  for (const [label, errors] of Object.entries(assetErrors)) {
    warnings.push(`${label} was skipped because its data failed validation: ${errors[0]}`);
  }

  const assets = [];
  raw.assets.forEach((asset, index) => {
    const label = isPlainObject(asset) && typeof asset.ticker === 'string' ? asset.ticker : `asset #${index + 1}`;
    if (!assetErrors[label]) assets.push(normaliseAsset(asset));
  });

  const byTicker = {};
  for (const asset of assets) byTicker[asset.ticker] = asset;
  const sectors = [...new Set(assets.map((asset) => asset.sector).filter(Boolean))].sort();
  const staleTickers = assets.filter((asset) => asset.status === 'stale').map((asset) => asset.ticker);
  if (staleTickers.length) warnings.push(`Using older data for ${staleTickers.join(', ')}: the last refresh could not reach the data source.`);

  const age = describeAge(raw.generatedAt, now);
  if (age.freshness === 'stale') warnings.push(`The snapshot is ${Math.floor(age.ageDays)} days old. The daily refresh may be failing.`);

  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    generatedAt: raw.generatedAt,
    ...age,
    fx: Object.freeze({ base: raw.fx.base, quote: raw.fx.quote, rate: raw.fx.rate, asOf: raw.fx.asOf }),
    assets: Object.freeze(assets),
    byTicker: Object.freeze(byTicker),
    sectors: Object.freeze(sectors),
    staleTickers: Object.freeze(staleTickers),
    warnings: Object.freeze(warnings),
  });
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fetch, validate and normalise the snapshot.
 *
 * @param {{ url?: string, timeoutMs?: number, fetchImpl?: typeof fetch, now?: Date }} [options]
 * @returns {Promise<object>} the normalised snapshot (see normaliseSnapshot)
 * @throws {SnapshotError} with a message that is safe to show to the user
 */
export async function loadSnapshot({ url = SNAPSHOT_URL, timeoutMs = 10000, fetchImpl, now = new Date() } = {}) {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new SnapshotError('This browser cannot load data (fetch is unavailable).', { code: 'NO_FETCH' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    // "no-store" bypasses the browser cache so every visit sees the latest daily file.
    response = await doFetch(url, { cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    throw new SnapshotError(
      timedOut
        ? `The market snapshot did not load within ${Math.round(timeoutMs / 1000)} seconds. Check your connection and reload.`
        : 'The market snapshot could not be downloaded. If you opened index.html directly from disk, serve the folder over http instead.',
      { code: timedOut ? 'TIMEOUT' : 'NETWORK', details: [String(error && error.message ? error.message : error)] },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new SnapshotError(`The market snapshot returned HTTP ${response.status}.`, { code: 'HTTP', details: [`${response.status} ${response.statusText || ''}`.trim()] });
  }

  let raw;
  try {
    raw = await response.json();
  } catch (error) {
    throw new SnapshotError('The market snapshot is not valid JSON.', { code: 'PARSE', details: [String(error && error.message ? error.message : error)] });
  }
  return normaliseSnapshot(raw, now);
}
