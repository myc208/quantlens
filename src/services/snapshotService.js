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
// v2 added news, forecasts and macro data; v3 adds five years of closes, dividends and an event calendar.
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);
export const SUPPORTED_SCHEMA_VERSION = 3;
export const MIN_CANDLES = 200;
export const CANDLE_FIELDS = Object.freeze(['date', 'open', 'high', 'low', 'close', 'volume']);
export const HISTORY_FIELDS = Object.freeze(['date', 'close']);
export const MAX_HISTORY_ROWS = 2000;
export const SPLICE_MAX_GAP_DAYS = 10;
export const MAX_DIVIDEND_ROWS = 300;
export const MAX_PAST_EARNINGS = 30;
export const EARNINGS_TIMINGS = Object.freeze(['before-open', 'during-session', 'after-close', 'unknown']);
export const FORECAST_FIELDS = Object.freeze(['date', 'yhat', 'lower', 'upper']);
export const FUNDAMENTAL_KEYS = Object.freeze([
  'marketCap', 'enterpriseValue', 'ebit', 'ebitda', 'operatingIncome', 'totalRevenue', 'netIncome',
  'freeCashFlow', 'totalDebt', 'totalCash', 'totalEquity', 'totalAssets', 'trailingPE', 'forwardPE',
  'priceToBook', 'returnOnEquity', 'dividendYieldTTM',
]);
export const MAX_NEWS_CLUSTERS = 3;
export const RISK_FREE_CURRENCIES = Object.freeze(['USD', 'SGD']);
// V3.1: macro.regime, the VIX term structure, with five years of daily closes.
export const REGIME_HISTORY_FIELDS = Object.freeze(['date', 'vix9d', 'vix', 'vix3m']);
export const MAX_REGIME_ROWS = 1400;
const REGIME_STATES = ['normal', 'elevated', 'stressed'];
const REGIME_RULE_KEYS = ['elevatedLevel', 'elevatedRatio', 'invertedRatio'];
const REGIME_LEVEL_BOUNDS = Object.freeze({ min: 1, max: 200 });
// V3.2: macro.calendar, the hand-kept FOMC / CPI / market-holiday calendar.
export const CALENDAR_TYPES = Object.freeze(['fomc-decision', 'fomc-meeting', 'fomc-minutes', 'cpi', 'market-holiday', 'market-early-close']);
const TIMED_CALENDAR_TYPES = ['fomc-decision', 'fomc-minutes', 'cpi', 'market-early-close'];
const OFFSET_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
// V5.0: macro.stress, the three-pillar macro regime (volatility, credit, rates) written by the
// pipeline's --stress step, and `benchmarks`, total-return benchmarks outside the watchlist.
export const STRESS_PILLARS = Object.freeze(['volatility', 'credit', 'rates']);
export const STRESS_STATES = Object.freeze(['Calm', 'Cautious', 'Stressed']);
const STRESS_STATUSES = ['fresh', 'partial', 'vix-only', 'unavailable'];
const STRESS_RULE_KEYS = ['volRatio', 'creditLevel', 'creditWidening', 'ratesInverted', 'ratesSteepening', 'window'];
export const MAX_BENCHMARK_ROWS = 400;

const ASSET_CLASSES = ['equity', 'etf', 'index', 'crypto'];
const MARKETS = ['US', 'SG', 'UK', 'CRYPTO'];
const PROFILES = ['CORPORATE', 'FINANCIAL', 'REIT', 'ETF', 'INDEX', 'CRYPTO'];
const EQUITY_PROFILES = ['CORPORATE', 'FINANCIAL', 'REIT'];
// Asset classes with no company accounts: each has exactly one profile, with no fundamental score.
const CLASS_PROFILES = Object.freeze({ crypto: 'CRYPTO', etf: 'ETF', index: 'INDEX' });
const STATUSES = ['fresh', 'stale'];
const SECTION_STATUSES = ['fresh', 'stale', 'unavailable'];
const RISK_FREE_STATUSES = ['fresh', 'stale', 'proxy', 'unavailable'];
const SENTIMENT_LABELS = ['positive', 'neutral', 'negative'];
const YIELD_BOUNDS = Object.freeze({ min: -0.02, max: 0.25 });
const TITLE_LIMIT = 300;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Yahoo symbols: AMD, BRK-B, D05.SI, CSPX.L, BTC-USD, and indices with a leading caret (^GSPC).
const TICKER_PATTERN = /^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$/;

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
  const required = CLASS_PROFILES[asset.assetClass];
  if (required && asset.scoringProfile !== required) errors.push(`${asset.assetClass} assets must use the ${required} profile`);
  if (asset.assetClass === 'equity' && !EQUITY_PROFILES.includes(asset.scoringProfile)) errors.push(`equities must use one of ${EQUITY_PROFILES.join(', ')}`);
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

function unavailableRegime(note) {
  return Object.freeze({
    status: 'unavailable', asOf: null, source: null,
    levels: Object.freeze({ vix9d: null, vix: null, vix3m: null }),
    slope: null, ratio: null, frontRatio: null, state: null, inverted: null, invertedStreak: null, rules: null,
    history: Object.freeze({ dates: Object.freeze([]), vix9d: Object.freeze([]), vix: Object.freeze([]), vix3m: Object.freeze([]) }),
    note,
  });
}

/**
 * The market regime block (V3.1). Never throws: a missing block (a snapshot written
 * before V3.1) or a malformed one becomes "unavailable" with a reason, and the
 * regime metrics report N/A. History arrives as [date, vix9d|null, vix, vix3m] rows
 * and is returned column-wise.
 * @returns {{ regime: object, problem: string|null }}
 */
export function normaliseRegime(raw) {
  if (raw === undefined || raw === null) {
    return { regime: unavailableRegime('This snapshot was written before the market regime was added.'), problem: null };
  }
  if (!isPlainObject(raw) || !SECTION_STATUSES.includes(raw.status)) {
    return { regime: unavailableRegime('The market regime block is malformed.'), problem: 'the market regime block is malformed' };
  }
  if (raw.status === 'unavailable') {
    return { regime: unavailableRegime(textOrNull(raw.note) ?? 'The VIX curve could not be read.'), problem: null };
  }
  const fail = (why) => ({ regime: unavailableRegime(`The market regime block is unusable: ${why}.`), problem: `the market regime block is unusable: ${why}` });
  const level = (value) => isNum(value) && value >= REGIME_LEVEL_BOUNDS.min && value <= REGIME_LEVEL_BOUNDS.max;
  const { levels, rules } = raw;
  if (!isPlainObject(levels) || !level(levels.vix) || !level(levels.vix3m) || !(levels.vix9d === null || level(levels.vix9d))) {
    return fail('the VIX levels are missing or implausible');
  }
  if (!isIsoDate(raw.asOf)) return fail('it has no reading date');
  if (!isPlainObject(rules) || !REGIME_RULE_KEYS.every((key) => isNum(rules[key]) && rules[key] > 0)) return fail('its thresholds are missing');
  if (!REGIME_STATES.includes(raw.state)) return fail('its state is not normal, elevated or stressed');
  if (!Array.isArray(raw.historyFields) || raw.historyFields.join(',') !== REGIME_HISTORY_FIELDS.join(',')) return fail('its historyFields are not the documented ones');
  if (!Array.isArray(raw.history) || raw.history.length === 0 || raw.history.length > MAX_REGIME_ROWS) return fail('its history is missing or too long');
  const history = { dates: [], vix9d: [], vix: [], vix3m: [] };
  let previous = '';
  for (const row of raw.history) {
    if (!Array.isArray(row) || row.length !== 4 || !isIsoDate(row[0]) || row[0] <= previous
      || !level(row[2]) || !level(row[3]) || !(row[1] === null || level(row[1]))) {
      return fail('a history row is malformed or out of order');
    }
    previous = row[0];
    history.dates.push(row[0]);
    history.vix9d.push(row[1]);
    history.vix.push(row[2]);
    history.vix3m.push(row[3]);
  }
  const last = history.dates.length - 1;
  if (history.dates[last] !== raw.asOf || history.vix[last] !== levels.vix || history.vix3m[last] !== levels.vix3m || history.vix9d[last] !== levels.vix9d) {
    return fail('its history does not end with the reported levels');
  }
  return {
    problem: null,
    regime: Object.freeze({
      status: raw.status,
      asOf: raw.asOf,
      source: textOrNull(raw.source),
      levels: Object.freeze({ vix9d: levels.vix9d, vix: levels.vix, vix3m: levels.vix3m }),
      slope: isNum(raw.slope) ? raw.slope : null,
      ratio: isNum(raw.ratio) ? raw.ratio : null,
      frontRatio: isNum(raw.frontRatio) ? raw.frontRatio : null,
      state: raw.state,
      inverted: raw.inverted === true,
      invertedStreak: Number.isInteger(raw.invertedStreak) && raw.invertedStreak >= 0 ? raw.invertedStreak : null,
      rules: Object.freeze({ elevatedLevel: rules.elevatedLevel, elevatedRatio: rules.elevatedRatio, invertedRatio: rules.invertedRatio }),
      history: Object.freeze({
        dates: Object.freeze(history.dates), vix9d: Object.freeze(history.vix9d),
        vix: Object.freeze(history.vix), vix3m: Object.freeze(history.vix3m),
      }),
      note: textOrNull(raw.note),
    }),
  };
}

/**
 * The three-pillar macro stress block (V5.0). Never throws: a missing block (a snapshot written
 * before V5.0, or a run whose --stress step did not finish) is null, and the stress engine then
 * reads the VIX pillar from the regime alone; a malformed one is null with a problem.
 * @returns {{ stress: object|null, problem: string|null }}
 */
export function normaliseStress(raw) {
  if (raw === undefined || raw === null) return { stress: null, problem: null };
  const fail = (why) => ({ stress: null, problem: `the macro stress block is unusable: ${why}` });
  if (!isPlainObject(raw) || !STRESS_STATUSES.includes(raw.status)) return fail('it is malformed');
  if (!isPlainObject(raw.rules) || !STRESS_RULE_KEYS.every((key) => isNum(raw.rules[key]))) return fail('its thresholds are missing');
  if (!isPlainObject(raw.multipliers) || !STRESS_STATES.every((state) => isNum(raw.multipliers[state]) && raw.multipliers[state] >= 1)) {
    return fail('its multipliers are missing');
  }
  if (!isPlainObject(raw.pillars)) return fail('it has no pillars');
  const pillars = {};
  for (const name of STRESS_PILLARS) {
    const pillar = raw.pillars[name];
    if (!isPlainObject(pillar) || !SECTION_STATUSES.includes(pillar.status)) return fail(`the ${name} pillar is malformed`);
    const read = pillar.status !== 'unavailable';
    if (read && (typeof pillar.flag !== 'boolean' || !isNum(pillar.value) || !isIsoDate(pillar.asOf))) return fail(`the ${name} pillar has no reading`);
    const numberOrNull = (value) => (isNum(value) ? value : null);
    pillars[name] = Object.freeze({
      name, status: pillar.status, flag: read ? pillar.flag : null, asOf: read ? pillar.asOf : null,
      source: textOrNull(pillar.source), series: textOrNull(pillar.series), value: read ? pillar.value : null,
      change: numberOrNull(pillar.change), from: isIsoDate(pillar.from) ? pillar.from : null,
      twoYearChange: numberOrNull(pillar.twoYearChange), note: textOrNull(pillar.note),
    });
  }
  return {
    problem: null,
    stress: Object.freeze({
      status: raw.status, asOf: isIsoDate(raw.asOf) ? raw.asOf : null,
      state: STRESS_STATES.includes(raw.state) ? raw.state : null,
      flags: Number.isInteger(raw.flags) ? raw.flags : null, active: Number.isInteger(raw.active) ? raw.active : null,
      multiplier: isNum(raw.multiplier) ? raw.multiplier : null,
      pillars: Object.freeze(pillars), rules: Object.freeze({ ...raw.rules }), multipliers: Object.freeze({ ...raw.multipliers }),
      note: textOrNull(raw.note),
    }),
  };
}

/**
 * Total-return benchmarks outside the watchlist (V5.0), by ticker. A malformed or unavailable
 * entry is left out, so the radar falls back to the price index.
 * @returns {{ benchmarks: Record<string, object>, problems: string[] }}
 */
export function normaliseBenchmarks(raw) {
  const benchmarks = {};
  const problems = [];
  if (raw === undefined || raw === null) return { benchmarks: Object.freeze(benchmarks), problems };
  if (!isPlainObject(raw)) return { benchmarks: Object.freeze(benchmarks), problems: ['the benchmarks block is malformed'] };
  for (const [ticker, block] of Object.entries(raw)) {
    if (!TICKER_PATTERN.test(ticker) || !isPlainObject(block) || !SECTION_STATUSES.includes(block.status)) {
      problems.push(`benchmark ${ticker} is malformed`);
      continue;
    }
    if (block.status === 'unavailable') continue;
    const rows = Array.isArray(block.series) ? block.series : null;
    const dates = [];
    const close = [];
    let ok = rows !== null && rows.length > 0 && rows.length <= MAX_BENCHMARK_ROWS;
    for (const row of ok ? rows : []) {
      if (!Array.isArray(row) || row.length !== 2 || !isIsoDate(row[0]) || (dates.length && row[0] <= dates[dates.length - 1]) || !isNum(row[1]) || row[1] <= 0) {
        ok = false;
        break;
      }
      dates.push(row[0]);
      close.push(row[1]);
    }
    if (!ok) {
      problems.push(`benchmark ${ticker} has malformed closes`);
      continue;
    }
    benchmarks[ticker] = Object.freeze({
      ticker, name: textOrNull(block.name) ?? ticker, market: MARKETS.includes(block.market) ? block.market : null,
      currency: CURRENCY_PATTERN.test(block.currency) ? block.currency : null, status: block.status,
      asOf: dates[dates.length - 1], note: textOrNull(block.note),
      series: Object.freeze({ dates: Object.freeze(dates), close: Object.freeze(close) }),
    });
  }
  return { benchmarks: Object.freeze(benchmarks), problems };
}

function unavailableCalendar(note) {
  return Object.freeze({ status: 'unavailable', updated: null, coverage: null, events: Object.freeze([]), note });
}

/**
 * The macro calendar block (V3.2). Never throws: a missing block (a snapshot written before
 * V3.2) or a malformed one becomes "unavailable" with a reason.
 * @returns {{ calendar: object, problem: string|null }}
 */
export function normaliseCalendar(raw) {
  if (raw === undefined || raw === null) {
    return { calendar: unavailableCalendar('This snapshot was written before the macro calendar was added.'), problem: null };
  }
  if (!isPlainObject(raw) || !['fresh', 'unavailable'].includes(raw.status)) {
    return { calendar: unavailableCalendar('The macro calendar block is malformed.'), problem: 'the macro calendar block is malformed' };
  }
  if (raw.status === 'unavailable') return { calendar: unavailableCalendar(textOrNull(raw.note) ?? 'The macro calendar could not be read.'), problem: null };
  const fail = (why) => ({ calendar: unavailableCalendar(`The macro calendar is unusable: ${why}.`), problem: `the macro calendar is unusable: ${why}` });
  const coverage = raw.coverage;
  if (!isPlainObject(coverage) || !isIsoDate(coverage.from) || !isIsoDate(coverage.to) || !isIsoDate(raw.updated)) return fail('its dates are missing');
  if (!Array.isArray(raw.events)) return fail('it has no event list');
  const events = [];
  let previous = '';
  for (const event of raw.events) {
    if (!isPlainObject(event) || !CALENDAR_TYPES.includes(event.type) || !isIsoDate(event.date) || event.date < previous) {
      return fail('an event is malformed or out of order');
    }
    if (TIMED_CALENDAR_TYPES.includes(event.type) && !(typeof event.at === 'string' && OFFSET_TIME_PATTERN.test(event.at) && event.at.slice(0, 10) === event.date)) {
      return fail(`the ${event.type} on ${event.date} has no valid time`);
    }
    previous = event.date;
    events.push(Object.freeze({ ...event }));
  }
  return {
    problem: null,
    calendar: Object.freeze({
      status: 'fresh', updated: raw.updated, coverage: Object.freeze({ from: coverage.from, to: coverage.to }),
      events: Object.freeze(events), note: textOrNull(raw.note),
    }),
  };
}

/**
 * Validate and normalise the macro block. Never throws: a missing or malformed
 * rate becomes "unavailable", and anything that needs it (the Sharpe ratio)
 * reports N/A with that reason. The same holds for the market regime and the calendar.
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
  const { regime, problem } = normaliseRegime(isPlainObject(raw) ? raw.regime : undefined);
  if (problem) problems.push(problem);
  const { calendar, problem: calendarProblem } = normaliseCalendar(isPlainObject(raw) ? raw.calendar : undefined);
  if (calendarProblem) problems.push(calendarProblem);
  const { stress, problem: stressProblem } = normaliseStress(isPlainObject(raw) ? raw.stress : undefined);
  if (stressProblem) problems.push(stressProblem);
  return { macro: Object.freeze({ riskFree: Object.freeze(riskFree), regime, calendar, stress }), problems };
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
    sectionProblems.push(...normaliseBenchmarks(raw.benchmarks).problems);
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
    if (raw.schemaVersion >= 3) {
      const sections = [
        ['history', normaliseHistory(asset.history, asset.candles[0][0]).problem],
        ['dividends', normaliseDividends(asset.dividends).problem],
        ['events', normaliseEvents(asset.events).problem],
      ];
      for (const [name, problem] of sections) {
        if (asset[name] === undefined) sectionProblems.push(`${label}: the ${name} block is missing`);
        else if (problem) sectionProblems.push(`${label}: ${problem}`);
      }
    }
  });
  if (Object.keys(assetErrors).length === raw.assets.length) fatal.push('no asset passed validation');
  return { fatal, assetErrors, sectionProblems };
}

/* ------------------------------------------------------------------ */
/* Schema v3 sections: older closes, dividends, events                 */
/* ------------------------------------------------------------------ */

const DAY_MS = 86400000;
const emptyHistory = () => ({ dates: [], close: [] });
const emptyDividends = () => ({ dates: [], amounts: [] });

/**
 * Closes older than the first candle. Malformed history is dropped (the asset
 * keeps its year of candles), never the asset itself.
 * @returns {{ history:{dates:string[], close:number[]}, problem:string|null }}
 */
export function normaliseHistory(raw, firstCandleDate) {
  if (raw === undefined || raw === null) return { history: emptyHistory(), problem: null };
  const reject = (problem) => ({ history: emptyHistory(), problem });
  if (!Array.isArray(raw)) return reject('history is not a list');
  if (raw.length > MAX_HISTORY_ROWS) return reject(`history has more than ${MAX_HISTORY_ROWS} rows`);
  const history = emptyHistory();
  let previousDate = '';
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== HISTORY_FIELDS.length || !isIsoDate(row[0]) || row[0] <= previousDate || !isNum(row[1]) || row[1] <= 0) {
      return reject('history rows must be [date, close], strictly ascending, with positive closes');
    }
    previousDate = row[0];
    history.dates.push(row[0]);
    history.close.push(row[1]);
  }
  if (previousDate && isIsoDate(firstCandleDate)) {
    if (previousDate >= firstCandleDate) return reject('history overlaps the candles');
    const gap = (Date.parse(`${firstCandleDate}T00:00:00Z`) - Date.parse(`${previousDate}T00:00:00Z`)) / DAY_MS;
    if (gap > SPLICE_MAX_GAP_DAYS) return reject(`history ends ${gap} days before the first candle`);
  }
  return { history, problem: null };
}

/** @returns {{ dividends:{dates:string[], amounts:number[]}, problem:string|null }} */
export function normaliseDividends(raw) {
  if (raw === undefined || raw === null) return { dividends: emptyDividends(), problem: null };
  const reject = (problem) => ({ dividends: emptyDividends(), problem });
  if (!Array.isArray(raw) || raw.length > MAX_DIVIDEND_ROWS) return reject(`dividends must be a list of at most ${MAX_DIVIDEND_ROWS} rows`);
  const dividends = emptyDividends();
  let previousDate = '';
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== 2 || !isIsoDate(row[0]) || row[0] <= previousDate || !isNum(row[1]) || row[1] <= 0) {
      return reject('dividend rows must be [ex-date, amount], strictly ascending, with positive amounts');
    }
    previousDate = row[0];
    dividends.dates.push(row[0]);
    dividends.amounts.push(row[1]);
  }
  return { dividends, problem: null };
}

function unavailableEvents(note) {
  return Object.freeze({ status: 'unavailable', fetchedAt: null, nextEarnings: null, nextExDividend: null, earnings: Object.freeze([]), note: note ?? null });
}

/**
 * The event calendar: next earnings (with a second date when sources disagree),
 * next ex-dividend date, and past earnings dates with their timing.
 * @returns {{ events:object, problem:string|null }}
 */
export function normaliseEvents(raw) {
  if (raw === undefined || raw === null) return { events: unavailableEvents('This snapshot predates event calendars.'), problem: null };
  const reject = (problem) => ({ events: unavailableEvents('The stored event calendar was malformed and has been ignored.'), problem });
  if (!isPlainObject(raw) || !SECTION_STATUSES.includes(raw.status)) return reject('events have no valid status');
  const earningsRaw = Array.isArray(raw.earnings) ? raw.earnings : null;
  if (!earningsRaw || earningsRaw.length > MAX_PAST_EARNINGS) return reject(`events.earnings must be a list of at most ${MAX_PAST_EARNINGS} entries`);
  if (raw.status === 'unavailable') {
    return raw.nextEarnings || raw.nextExDividend || earningsRaw.length
      ? reject('an unavailable event calendar carries dates')
      : { events: unavailableEvents(textOrNull(raw.note)), problem: null };
  }

  let nextEarnings = null;
  if (raw.nextEarnings !== null && raw.nextEarnings !== undefined) {
    const item = raw.nextEarnings;
    const dateTo = isPlainObject(item) ? item.dateTo ?? null : null;
    if (!isPlainObject(item) || !isIsoDate(item.date) || !EARNINGS_TIMINGS.includes(item.timing)
      || (dateTo !== null && (!isIsoDate(dateTo) || dateTo <= item.date))) {
      return reject('events.nextEarnings is malformed');
    }
    nextEarnings = Object.freeze({ date: item.date, dateTo, timing: item.timing });
  }
  let nextExDividend = null;
  if (raw.nextExDividend !== null && raw.nextExDividend !== undefined) {
    if (!isPlainObject(raw.nextExDividend) || !isIsoDate(raw.nextExDividend.date)) return reject('events.nextExDividend is malformed');
    nextExDividend = Object.freeze({ date: raw.nextExDividend.date });
  }
  const earnings = [];
  let previousDate = '9999-12-31';
  for (const item of earningsRaw) {
    if (!isPlainObject(item) || !isIsoDate(item.date) || item.date >= previousDate || !EARNINGS_TIMINGS.includes(item.timing)) {
      return reject('events.earnings must be {date, timing} entries, newest first, without repeats');
    }
    previousDate = item.date;
    earnings.push(Object.freeze({ date: item.date, timing: item.timing }));
  }
  return {
    events: Object.freeze({
      status: raw.status,
      fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
      nextEarnings,
      nextExDividend,
      earnings: Object.freeze(earnings),
      note: textOrNull(raw.note),
    }),
    problem: null,
  };
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
  const series = toSeries(asset.candles);
  const { history } = normaliseHistory(asset.history, series.dates[0]);
  const { dividends } = normaliseDividends(asset.dividends);
  const { events } = normaliseEvents(asset.events);
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
    series,
    candleCount: asset.candles.length,
    // Up to five years of closes: the older history followed by the candles' closes.
    // Indicators and the trend regime keep using `series` (the last year, with highs and lows).
    longSeries: { dates: [...history.dates, ...series.dates], close: [...history.close, ...series.close] },
    historyCount: history.dates.length,
    dividends,
    news,
    forecast,
    events,
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
 *     macro: { riskFree: { USD, SGD }, regime, calendar, stress },
 *     benchmarks: { [ticker]: { series: { dates, close }, ... } },
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
    benchmarks: normaliseBenchmarks(isV2 ? raw.benchmarks : undefined).benchmarks,
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

/**
 * Calendar days covered by each time-slicer option; null means "the whole series given".
 * `1y` is applied to an asset's `series` (its year of candles) and `5y` to its
 * `longSeries` (up to five years of closes), so both are "everything".
 */
export const RANGE_DAYS = Object.freeze({ '1m': 30, '3m': 91, '6m': 182, '1y': null, '5y': null });

/**
 * The trailing part of a candle series for a time range, measured in calendar
 * days back from the last candle so that stocks and crypto cover the same span.
 *
 * Used for charts, period return, volatility, correlation, simulations and
 * portfolio statistics. Indicators that need a warm-up (moving averages, MACD,
 * RSI, ATR) and the trend regime are always computed on the full history: a 1-month
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
