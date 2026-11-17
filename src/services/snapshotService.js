/**
 * snapshotService.js: loads, validates and normalises ./data/market_snapshot.json.
 *
 * The snapshot is produced by scripts/fetch_fundamentals.py in GitHub Actions.
 * The browser never trusts it blindly: the schema rules are re-checked here and
 * the age of the data is reported, so staleness is always visible.
 *
 * Schema versions
 *   v1  candles, fundamentals, USD/SGD rate
 *   v2  adds macro risk-free rates, one year of USD/SGD closes, and per-asset
 *       news (de-duplicated headlines with sentiment) and a price forecast
 * Both are accepted. A v1 file is normalised to the v2 shape with the new
 * sections marked "unavailable", so the rest of the app has one shape to handle.
 *
 * Failure is graded, never all-or-nothing:
 *   - a malformed news, forecast or macro block is replaced by "unavailable"
 *     and the asset keeps its prices and fundamentals;
 *   - an asset with bad candles or fundamentals is dropped, with a warning;
 *   - only a document that is unusable as a whole raises a SnapshotError.
 */

import { isNum } from '../core/precisionMath.js';

export const SNAPSHOT_URL = './data/market_snapshot.json';
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const SUPPORTED_SCHEMA_VERSION = 2;
export const MIN_CANDLES = 200;
export const CANDLE_FIELDS = Object.freeze(['date', 'open', 'high', 'low', 'close', 'volume']);
export const FORECAST_FIELDS = Object.freeze(['date', 'yhat', 'lower', 'upper']);
export const FUNDAMENTAL_KEYS = Object.freeze([
  'marketCap', 'enterpriseValue', 'ebit', 'ebitda', 'operatingIncome', 'totalRevenue', 'netIncome',
  'freeCashFlow', 'totalDebt', 'totalCash', 'totalEquity', 'totalAssets', 'trailingPE', 'forwardPE',
  'priceToBook', 'returnOnEquity', 'dividendYieldTTM',
]);
export const MAX_NEWS_CLUSTERS = 3;
export const RISK_FREE_CURRENCIES = Object.freeze(['USD', 'SGD']);

const ASSET_CLASSES = ['equity', 'crypto'];
const MARKETS = ['US', 'SG', 'CRYPTO'];
const PROFILES = ['CORPORATE', 'FINANCIAL', 'REIT', 'CRYPTO'];
const STATUSES = ['fresh', 'stale'];
const SECTION_STATUSES = ['fresh', 'stale', 'unavailable'];
const RISK_FREE_STATUSES = ['fresh', 'stale', 'proxy', 'unavailable'];
const SENTIMENT_LABELS = ['positive', 'neutral', 'negative'];
const YIELD_BOUNDS = Object.freeze({ min: -0.02, max: 0.25 });
const TITLE_LIMIT = 300;
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
/* Small validators                                                    */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isSecureUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('https://')) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function textOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

/* ------------------------------------------------------------------ */
/* Core asset validation (prices and fundamentals)                      */
/* ------------------------------------------------------------------ */

/** Returns the list of schema violations for one asset's core data (empty when valid). */
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

/* ------------------------------------------------------------------ */
/* v2 sections: news, forecast, macro, FX history                       */
/* ------------------------------------------------------------------ */

function unavailableNews(note) {
  return Object.freeze({
    status: 'unavailable', fetchedAt: null, headlineCount: 0, clusterCount: 0, newestAt: null,
    sentiment: null, clusters: Object.freeze([]), note: note ?? null,
  });
}

function unavailableForecast(note) {
  return Object.freeze({
    status: 'unavailable', model: null, modelVersion: null, config: null, trainedOn: null,
    horizon: null, backtest: null, note: note ?? null,
    series: Object.freeze({ dates: Object.freeze([]), yhat: Object.freeze([]), lower: Object.freeze([]), upper: Object.freeze([]) }),
  });
}

function unavailableRate(name) {
  return Object.freeze({ name, symbol: null, yield: null, asOf: null, source: null, status: 'unavailable' });
}

const RATE_NAMES = Object.freeze({ USD: 'US 10-year Treasury yield', SGD: 'Singapore 10-year SGS benchmark yield' });

function validScores(scores) {
  return isPlainObject(scores) && isNum(scores.compound) && scores.compound >= -1 && scores.compound <= 1
    && ['pos', 'neu', 'neg'].every((key) => isNum(scores[key]) && scores[key] >= 0 && scores[key] <= 1);
}

/**
 * Validate and normalise an asset's news block.
 * @returns {{ news: object, problem: string|null }} `problem` is set when the stored block was rejected
 */
export function normaliseNews(raw) {
  if (raw === undefined || raw === null) return { news: unavailableNews('This snapshot predates news.'), problem: null };
  const reject = (problem) => ({ news: unavailableNews('The stored headlines were malformed and have been ignored.'), problem });
  if (!isPlainObject(raw) || !SECTION_STATUSES.includes(raw.status)) return reject('news has no valid status');
  if (!Array.isArray(raw.clusters) || raw.clusters.length > MAX_NEWS_CLUSTERS) return reject(`news must hold at most ${MAX_NEWS_CLUSTERS} stories`);
  if (raw.status === 'unavailable') {
    return raw.clusters.length ? reject('an unavailable news block carries stories') : { news: unavailableNews(textOrNull(raw.note)), problem: null };
  }

  const clusters = [];
  for (const item of raw.clusters) {
    if (!isPlainObject(item)) return reject('a story is not an object');
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > TITLE_LIMIT) return reject('a story has no valid title');
    if (item.link !== null && !isSecureUrl(item.link)) return reject('a story link is not an https URL');
    if (!isTimestamp(item.publishedAt) || !isTimestamp(item.firstSeenAt)) return reject('a story has no valid timestamps');
    if (!isCount(item.duplicates)) return reject('a story has an invalid duplicate count');
    if (item.scores !== null && !validScores(item.scores)) return reject('a story has sentiment scores out of range');
    if (item.scores !== null && !SENTIMENT_LABELS.includes(item.label)) return reject('a story has an invalid sentiment label');
    clusters.push(Object.freeze({
      title: item.title.trim(),
      link: item.link,
      publishedAt: item.publishedAt,
      firstSeenAt: item.firstSeenAt,
      duplicates: item.duplicates,
      scores: item.scores === null ? null : Object.freeze({ compound: item.scores.compound, pos: item.scores.pos, neu: item.scores.neu, neg: item.scores.neg }),
      label: item.scores === null ? null : item.label,
    }));
  }

  let sentiment = null;
  if (raw.sentiment !== null && raw.sentiment !== undefined) {
    const s = raw.sentiment;
    const valid = isPlainObject(s) && isNum(s.compound) && s.compound >= -1 && s.compound <= 1
      && SENTIMENT_LABELS.includes(s.label) && Number.isInteger(s.basis) && s.basis >= 1 && s.basis <= MAX_NEWS_CLUSTERS;
    if (!valid) return reject('the aggregate sentiment is invalid');
    sentiment = Object.freeze({ compound: s.compound, label: s.label, basis: s.basis });
  }

  return {
    problem: null,
    news: Object.freeze({
      status: raw.status,
      fetchedAt: isTimestamp(raw.fetchedAt) ? raw.fetchedAt : null,
      headlineCount: isCount(raw.headlineCount) ? raw.headlineCount : clusters.length,
      clusterCount: isCount(raw.clusterCount) ? raw.clusterCount : clusters.length,
      newestAt: isTimestamp(raw.newestAt) ? raw.newestAt : null,
      sentiment,
      clusters: Object.freeze(clusters),
      note: textOrNull(raw.note),
    }),
  };
}

function plainNumbers(value, depth = 0) {
  // Keep only JSON-safe leaves from a descriptive block (config, backtest, ...).
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === 'number') return isNum(value) ? value : null;
  if (typeof value === 'string') return value.length <= 200 ? value : value.slice(0, 200);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => plainNumbers(item, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).slice(0, 50)) out[key] = plainNumbers(value[key], depth + 1);
    return Object.freeze(out);
  }
  return null;
}

/**
 * Validate and normalise an asset's forecast block.
 * @returns {{ forecast: object, problem: string|null }}
 */
export function normaliseForecast(raw) {
  if (raw === undefined || raw === null) return { forecast: unavailableForecast('This snapshot predates forecasts.'), problem: null };
  const reject = (problem) => ({ forecast: unavailableForecast('The stored forecast was malformed and has been ignored.'), problem });
  if (!isPlainObject(raw) || !SECTION_STATUSES.includes(raw.status)) return reject('forecast has no valid status');
  if (!Array.isArray(raw.points)) return reject('forecast points are not a list');
  if (raw.status === 'unavailable') {
    return raw.points.length ? reject('an unavailable forecast carries points') : { forecast: unavailableForecast(textOrNull(raw.note)), problem: null };
  }
  if (raw.points.length === 0) return reject('an available forecast has no points');
  if (typeof raw.model !== 'string' || !raw.model) return reject('forecast has no model name');

  const series = { dates: [], yhat: [], lower: [], upper: [] };
  let previousDate = '';
  for (const row of raw.points) {
    if (!Array.isArray(row) || row.length !== FORECAST_FIELDS.length) return reject('a forecast point has the wrong shape');
    const [date, yhat, lower, upper] = row;
    if (!isIsoDate(date) || date <= previousDate) return reject('forecast points are not ascending by date');
    previousDate = date;
    if (![yhat, lower, upper].every((value) => isNum(value) && value > 0) || lower > yhat || yhat > upper) {
      return reject(`forecast point ${date} breaks 0 < lower <= estimate <= upper`);
    }
    series.dates.push(date);
    series.yhat.push(yhat);
    series.lower.push(lower);
    series.upper.push(upper);
  }
  return {
    problem: null,
    forecast: Object.freeze({
      status: raw.status,
      model: raw.model,
      modelVersion: textOrNull(raw.modelVersion),
      config: plainNumbers(raw.config),
      trainedOn: plainNumbers(raw.trainedOn),
      horizon: plainNumbers(raw.horizon),
      backtest: plainNumbers(raw.backtest),
      note: textOrNull(raw.note),
      series: Object.freeze({
        dates: Object.freeze(series.dates), yhat: Object.freeze(series.yhat),
        lower: Object.freeze(series.lower), upper: Object.freeze(series.upper),
      }),
    }),
  };
}

function normaliseRate(raw, currency) {
  const fallback = unavailableRate(RATE_NAMES[currency]);
  if (!isPlainObject(raw) || !RISK_FREE_STATUSES.includes(raw.status)) return { rate: fallback, problem: raw === undefined ? null : `the ${currency} risk-free rate is malformed` };
  if (raw.status === 'unavailable') return { rate: Object.freeze({ ...fallback, name: textOrNull(raw.name) ?? fallback.name }), problem: null };
  const plausible = isNum(raw.yield) && raw.yield >= YIELD_BOUNDS.min && raw.yield <= YIELD_BOUNDS.max;
  if (!plausible || !isIsoDate(raw.asOf)) return { rate: fallback, problem: `the ${currency} risk-free rate is implausible` };
  return {
    problem: null,
    rate: Object.freeze({
      name: textOrNull(raw.name) ?? fallback.name,
      symbol: textOrNull(raw.symbol),
      yield: raw.yield,
      asOf: raw.asOf,
      source: textOrNull(raw.source),
      status: raw.status,
    }),
  };
}

/**
 * Validate and normalise the macro block. Never throws: a missing or malformed
 * rate becomes "unavailable", and anything that needs it (the Sharpe ratio)
 * reports N/A with that reason.
 * @returns {{ macro: object, problems: string[] }}
 */
export function normaliseMacro(raw) {
  const rates = isPlainObject(raw) && isPlainObject(raw.riskFree) ? raw.riskFree : {};
  const problems = [];
  const riskFree = {};
  for (const currency of RISK_FREE_CURRENCIES) {
    const { rate, problem } = normaliseRate(rates[currency], currency);
    riskFree[currency] = rate;
    if (problem) problems.push(problem);
  }
  return { macro: Object.freeze({ riskFree: Object.freeze(riskFree) }), problems };
}

function normaliseFxSeries(raw) {
  const dates = [];
  const rates = [];
  let problem = null;
  if (Array.isArray(raw)) {
    let previousDate = '';
    for (const row of raw) {
      const ok = Array.isArray(row) && row.length === 2 && isIsoDate(row[0]) && row[0] > previousDate
        && isNum(row[1]) && row[1] >= 0.5 && row[1] <= 3;
      if (!ok) {
        problem = 'the USD/SGD history is malformed';
        dates.length = 0;
        rates.length = 0;
        break;
      }
      previousDate = row[0];
      dates.push(row[0]);
      rates.push(row[1]);
    }
  } else if (raw !== undefined) {
    problem = 'the USD/SGD history is malformed';
  }
  return { series: Object.freeze({ dates: Object.freeze(dates), rates: Object.freeze(rates) }), problem };
}

/* ------------------------------------------------------------------ */
/* Whole-document validation                                           */
/* ------------------------------------------------------------------ */

/**
 * Validate the whole document.
 * @returns {{ fatal: string[], assetErrors: Record<string, string[]>, sectionProblems: string[] }}
 *   `fatal` problems make the snapshot unusable; `assetErrors` remove single
 *   assets; `sectionProblems` only blank out a news, forecast or macro block.
 */
export function validateSnapshot(raw) {
  const fatal = [];
  const assetErrors = {};
  const sectionProblems = [];
  if (!isPlainObject(raw)) return { fatal: ['the file is not a JSON object'], assetErrors, sectionProblems };

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw.schemaVersion)) {
    fatal.push(`schemaVersion ${JSON.stringify(raw.schemaVersion)} is not supported (expected ${SUPPORTED_SCHEMA_VERSIONS.join(' or ')})`);
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
    return { fatal, assetErrors, sectionProblems };
  }

  if (raw.schemaVersion >= 2) {
    if (!Array.isArray(raw.forecastFields) || raw.forecastFields.join(',') !== FORECAST_FIELDS.join(',')) {
      sectionProblems.push(`forecastFields must be [${FORECAST_FIELDS.join(', ')}]`);
    }
    sectionProblems.push(...normaliseMacro(raw.macro).problems);
    const fxSeries = normaliseFxSeries(isPlainObject(fx) ? fx.series : undefined);
    if (fxSeries.problem) sectionProblems.push(fxSeries.problem);
  }

  const seen = new Set();
  raw.assets.forEach((asset, index) => {
    const label = isPlainObject(asset) && typeof asset.ticker === 'string' ? asset.ticker : `asset #${index + 1}`;
    const errors = validateAsset(asset);
    if (seen.has(label)) errors.push('duplicate ticker');
    seen.add(label);
    if (errors.length) {
      assetErrors[label] = errors;
      return;
    }
    if (raw.schemaVersion >= 2) {
      const news = normaliseNews(asset.news === undefined ? null : asset.news);
      const forecast = normaliseForecast(asset.forecast === undefined ? null : asset.forecast);
      if (asset.news === undefined) sectionProblems.push(`${label}: the news block is missing`);
      else if (news.problem) sectionProblems.push(`${label}: ${news.problem}`);
      if (asset.forecast === undefined) sectionProblems.push(`${label}: the forecast block is missing`);
      else if (forecast.problem) sectionProblems.push(`${label}: ${forecast.problem}`);
    }
  });
  if (Object.keys(assetErrors).length === raw.assets.length) fatal.push('no asset passed validation');
  return { fatal, assetErrors, sectionProblems };
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

function normaliseAsset(asset, forecastsUsable) {
  const fundamentals = {};
  for (const key of FUNDAMENTAL_KEYS) fundamentals[key] = isNum(asset.fundamentals[key]) ? asset.fundamentals[key] : null;
  const { news } = normaliseNews(asset.news);
  const { forecast } = forecastsUsable
    ? normaliseForecast(asset.forecast)
    : { forecast: unavailableForecast('The forecast layout in this snapshot is not recognised.') };
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
    news,
    forecast,
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
 *
 * The result always has the v2 shape:
 *   { schemaVersion, generatedAt, ageHours, ageDays, freshness,
 *     fx: { base, quote, rate, asOf, series: { dates, rates } },
 *     macro: { riskFree: { USD, SGD } },
 *     assets: [{ ...core, news, forecast }], byTicker, sectors, staleTickers, warnings }
 */
export function normaliseSnapshot(raw, now = new Date()) {
  const { fatal, assetErrors, sectionProblems } = validateSnapshot(raw);
  if (fatal.length) {
    throw new SnapshotError('The market snapshot failed validation, so nothing can be shown safely.', { code: 'INVALID_SNAPSHOT', details: fatal });
  }
  const warnings = [];
  for (const [label, errors] of Object.entries(assetErrors)) {
    warnings.push(`${label} was skipped because its data failed validation: ${errors[0]}`);
  }
  if (sectionProblems.length) {
    const more = sectionProblems.length > 1 ? ` (and ${sectionProblems.length - 1} more)` : '';
    warnings.push(`Some supplementary data was ignored because it was malformed: ${sectionProblems[0]}${more}.`);
  }

  const isV2 = raw.schemaVersion >= 2;
  const forecastsUsable = isV2 && Array.isArray(raw.forecastFields) && raw.forecastFields.join(',') === FORECAST_FIELDS.join(',');
  const assets = [];
  raw.assets.forEach((asset, index) => {
    const label = isPlainObject(asset) && typeof asset.ticker === 'string' ? asset.ticker : `asset #${index + 1}`;
    if (!assetErrors[label]) assets.push(normaliseAsset(asset, forecastsUsable));
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
    fx: Object.freeze({
      base: raw.fx.base, quote: raw.fx.quote, rate: raw.fx.rate, asOf: raw.fx.asOf,
      series: normaliseFxSeries(isV2 ? raw.fx.series : undefined).series,
    }),
    macro: normaliseMacro(isV2 ? raw.macro : undefined).macro,
    assets: Object.freeze(assets),
    byTicker: Object.freeze(byTicker),
    sectors: Object.freeze(sectors),
    staleTickers: Object.freeze(staleTickers),
    warnings: Object.freeze(warnings),
  });
}

/* ------------------------------------------------------------------ */
/* Time ranges                                                         */
/* ------------------------------------------------------------------ */

/** Calendar days covered by each time-slicer option; null means "everything in the snapshot". */
export const RANGE_DAYS = Object.freeze({ '1m': 30, '3m': 91, '6m': 182, '1y': null });

/**
 * The trailing part of a candle series for a time range, measured in calendar
 * days back from the last candle so that stocks and crypto cover the same span.
 *
 * Used for charts, period return, volatility, correlation, simulations and
 * portfolio statistics. Indicators that need a warm-up (moving averages, MACD,
 * RSI, ATR) and the verdict are always computed on the full history: a 1-month
 * slice has about 21 candles, which is not enough to form them at all.
 *
 * @param {{dates:string[]} & Record<string, any[]>} series parallel arrays, as produced by normaliseSnapshot
 * @param {string} range a key of RANGE_DAYS; anything else returns the series unchanged
 * @returns {object} a new series object (the input is never mutated)
 */
export function sliceSeries(series, range) {
  const days = RANGE_DAYS[range];
  if (!series || !Array.isArray(series.dates) || series.dates.length === 0 || !days) return series;
  const lastTime = Date.parse(`${series.dates[series.dates.length - 1]}T00:00:00Z`);
  const cutoff = new Date(lastTime - days * 86400000).toISOString().slice(0, 10);
  let start = series.dates.findIndex((date) => date >= cutoff);
  if (start < 0) start = 0;
  const sliced = {};
  for (const [key, values] of Object.entries(series)) sliced[key] = Array.isArray(values) ? values.slice(start) : values;
  return sliced;
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
