/**
 * precisionMath.js: guarded numeric primitives for every engine.
 *
 * Contract: every function returns a finite number (or a plain object of
 * finite numbers) or `null`. Nothing here ever returns NaN or Infinity, and
 * nothing throws on bad numeric input. Engines treat `null` as "not
 * available" and turn it into an N/A badge with an explanation.
 */

/** Denominators smaller than this are treated as zero. */
export const EPSILON = 1e-12;

/** True only for finite numbers (rejects NaN, Infinity, strings, null). */
export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Coerce to a finite number, or null. Numeric strings are accepted. */
export function toNum(value) {
  if (isNum(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finiteOrNull(value) {
  return isNum(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Guarded arithmetic                                                  */
/* ------------------------------------------------------------------ */

export function safeAdd(...values) {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (!isNum(value)) return null;
    total += value;
  }
  return finiteOrNull(total);
}

export function safeSub(a, b) {
  if (!isNum(a) || !isNum(b)) return null;
  return finiteOrNull(a - b);
}

export function safeMul(...values) {
  if (values.length === 0) return null;
  let product = 1;
  for (const value of values) {
    if (!isNum(value)) return null;
    product *= value;
  }
  return finiteOrNull(product);
}

/** a ÷ b, or null when either side is missing or b is (effectively) zero. */
export function safeDiv(a, b) {
  if (!isNum(a) || !isNum(b) || Math.abs(b) < EPSILON) return null;
  return finiteOrNull(a / b);
}

export function safeSqrt(value) {
  if (!isNum(value) || value < 0) return null;
  return finiteOrNull(Math.sqrt(value));
}

/** Natural log; null for zero or negative input. */
export function safeLn(value) {
  if (!isNum(value) || value <= 0) return null;
  return finiteOrNull(Math.log(value));
}

export function safeExp(value) {
  if (!isNum(value)) return null;
  return finiteOrNull(Math.exp(value));
}

export function clamp(value, low, high) {
  if (!isNum(value) || !isNum(low) || !isNum(high) || low > high) return null;
  return Math.min(high, Math.max(low, value));
}

/** Round half away from zero to `decimals` places, without binary drift (1.005 -> 1.01). */
export function roundTo(value, decimals = 2) {
  if (!isNum(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 12) return null;
  const factor = 10 ** decimals;
  const nudged = value * (1 + Number.EPSILON);
  const rounded = Math.sign(nudged) * Math.round(Math.abs(nudged) * factor) / factor;
  return finiteOrNull(rounded === 0 ? 0 : rounded);
}

/** Number of decimals needed to express a step size (100 -> 0, 0.000001 -> 6). */
export function decimalsOf(step) {
  if (!isNum(step) || step <= 0) return 0;
  let scaled = step;
  let decimals = 0;
  while (decimals < 12 && Math.abs(Math.round(scaled) - scaled) > 1e-9) {
    scaled *= 10;
    decimals += 1;
  }
  return decimals;
}

/** Round DOWN to a multiple of `step` (board lots, crypto precision). */
export function floorToStep(value, step) {
  if (!isNum(value) || !isNum(step) || step <= 0) return null;
  if (value <= 0) return 0;
  const lots = Math.floor(value / step + 1e-9);
  return roundTo(lots * step, decimalsOf(step));
}

/* ------------------------------------------------------------------ */
/* Array statistics (null when empty or any element is not finite)      */
/* ------------------------------------------------------------------ */

function allFinite(values) {
  return Array.isArray(values) && values.length > 0 && values.every(isNum);
}

export function sum(values) {
  if (!allFinite(values)) return null;
  let total = 0;
  for (const value of values) total += value;
  return finiteOrNull(total);
}

export function mean(values) {
  const total = sum(values);
  return total === null ? null : finiteOrNull(total / values.length);
}

/** Sample variance (n - 1 denominator). Needs at least two values. */
export function variance(values) {
  if (!allFinite(values) || values.length < 2) return null;
  const average = mean(values);
  let squares = 0;
  for (const value of values) squares += (value - average) ** 2;
  return finiteOrNull(squares / (values.length - 1));
}

/** Sample standard deviation. */
export function stdev(values) {
  return safeSqrt(variance(values));
}

export function minOf(values) {
  if (!allFinite(values)) return null;
  let lowest = values[0];
  for (const value of values) if (value < lowest) lowest = value;
  return lowest;
}

export function maxOf(values) {
  if (!allFinite(values)) return null;
  let highest = values[0];
  for (const value of values) if (value > highest) highest = value;
  return highest;
}

/** Daily log returns ln(Cₜ / Cₜ₋₁). Null if any price is missing or not positive. */
export function logReturns(prices) {
  if (!allFinite(prices) || prices.length < 2 || prices.some((price) => price <= 0)) return null;
  const returns = new Array(prices.length - 1);
  for (let i = 1; i < prices.length; i += 1) returns[i - 1] = Math.log(prices[i] / prices[i - 1]);
  return returns.every(isNum) ? returns : null;
}

/**
 * Pearson correlation with its intermediate values, for tracing.
 * Returns null when the inputs differ in length, have fewer than 3 points,
 * or either series has zero variance.
 */
export function pearson(xs, ys) {
  if (!allFinite(xs) || !allFinite(ys) || xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let cross = 0;
  let squaresX = 0;
  let squaresY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cross += dx * dy;
    squaresX += dx * dx;
    squaresY += dy * dy;
  }
  const covariance = cross / (n - 1);
  const sdX = Math.sqrt(squaresX / (n - 1));
  const sdY = Math.sqrt(squaresY / (n - 1));
  const r = safeDiv(covariance, sdX * sdY);
  if (r === null) return null;
  return { r: clamp(r, -1, 1), n, meanX, meanY, covariance, sdX, sdY };
}

/** Percentile (0..1) of an ASCENDING-sorted array, linear interpolation. */
export function percentile(sortedValues, p) {
  if (!allFinite(sortedValues) || !isNum(p) || p < 0 || p > 1) return null;
  const position = (sortedValues.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return finiteOrNull(sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower));
}

/* ------------------------------------------------------------------ */
/* Scoring helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Piecewise-linear score through anchor points [[x, score], ...] sorted by
 * ascending x. Clamped to the first/last anchor outside the range.
 * Returns { score, position, lower, upper } where lower/upper are the anchors
 * used, so the caller can show the interpolation in a trace.
 */
export function interpolateAnchors(x, anchors) {
  if (!isNum(x) || !Array.isArray(anchors) || anchors.length < 2) return null;
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    if (!Array.isArray(anchor) || !isNum(anchor[0]) || !isNum(anchor[1])) return null;
    if (i > 0 && anchor[0] <= anchors[i - 1][0]) return null;
  }
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (x <= first[0]) return { score: first[1], position: 'below', lower: first, upper: first };
  if (x >= last[0]) return { score: last[1], position: 'above', lower: last, upper: last };
  for (let i = 1; i < anchors.length; i += 1) {
    const lower = anchors[i - 1];
    const upper = anchors[i];
    if (x <= upper[0]) {
      const fraction = (x - lower[0]) / (upper[0] - lower[0]);
      const score = lower[1] + (upper[1] - lower[1]) * fraction;
      return isNum(score) ? { score, position: 'between', lower, upper } : null;
    }
  }
  return null;
}

/**
 * Weighted average of sub-scores. Components whose score is null are dropped
 * and the remaining weights are renormalised. If less than `minCoverage` of
 * the total weight is available the overall score is null.
 *
 * @param {{id:string,label:string,weight:number,score:number|null}[]} components
 */
export function weightedScore(components, minCoverage = 0.5) {
  const valid = Array.isArray(components)
    ? components.filter((c) => c && isNum(c.weight) && c.weight > 0)
    : [];
  const totalWeight = valid.reduce((total, c) => total + c.weight, 0);
  const available = valid.filter((c) => isNum(c.score));
  const usedWeight = available.reduce((total, c) => total + c.weight, 0);
  const coverage = safeDiv(usedWeight, totalWeight) ?? 0;
  const missing = valid.filter((c) => !isNum(c.score)).map((c) => c.id);
  const parts = available.map((c) => {
    const normalisedWeight = c.weight / usedWeight;
    return {
      id: c.id,
      label: c.label,
      weight: c.weight,
      score: c.score,
      normalisedWeight,
      contribution: c.score * normalisedWeight,
    };
  });
  const enough = usedWeight > 0 && coverage + 1e-9 >= minCoverage;
  const raw = enough ? parts.reduce((total, p) => total + p.contribution, 0) : null;
  return {
    score: raw === null ? null : clamp(raw, 0, 100),
    coverage,
    usedWeight,
    totalWeight,
    parts,
    missing,
  };
}

/** Tone for any 0..100 score, shared by every engine. */
export function scoreTone(score) {
  if (!isNum(score)) return null;
  if (score >= 65) return 'healthy';
  if (score >= 45) return 'neutral';
  if (score >= 30) return 'caution';
  return 'risky';
}

/* ------------------------------------------------------------------ */
/* Currency                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert between USD and SGD using the USD->SGD rate. Any other currency
 * pair returns null (the caller shows N/A rather than guessing).
 */
export function convertCurrency(amount, from, to, usdSgdRate) {
  if (!isNum(amount) || typeof from !== 'string' || typeof to !== 'string') return null;
  if (from === to) return amount;
  if (!isNum(usdSgdRate) || usdSgdRate <= 0) return null;
  if (from === 'USD' && to === 'SGD') return finiteOrNull(amount * usdSgdRate);
  if (from === 'SGD' && to === 'USD') return finiteOrNull(amount / usdSgdRate);
  return null;
}

/* ------------------------------------------------------------------ */
/* Display formatting ("N/A" for anything that is not a finite number)  */
/* ------------------------------------------------------------------ */

export const NA_TEXT = 'N/A';

export function formatNumber(value, decimals = 2) {
  if (!isNum(value)) return NA_TEXT;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Format a decimal fraction as a percentage: 0.171 -> "17.1%". */
export function formatPercent(fraction, decimals = 1) {
  if (!isNum(fraction)) return NA_TEXT;
  return `${formatNumber(fraction * 100, decimals)}%`;
}

/** Compact magnitude: 1234567890 -> "1.23B". */
export function formatCompact(value, decimals = 2) {
  if (!isNum(value)) return NA_TEXT;
  const magnitude = Math.abs(value);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (magnitude >= size) return `${formatNumber(value / size, decimals)}${suffix}`;
  }
  return formatNumber(value, decimals);
}

/** Decimals that suit a price of this size. */
export function priceDecimals(value) {
  if (!isNum(value)) return 2;
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return 2;
  if (magnitude >= 1) return 2;
  if (magnitude >= 0.01) return 4;
  return 8;
}

export function formatCurrency(value, currency, decimals) {
  if (!isNum(value)) return NA_TEXT;
  const places = Number.isInteger(decimals) ? decimals : priceDecimals(value);
  const code = typeof currency === 'string' && currency ? `${currency} ` : '';
  return `${code}${formatNumber(value, places)}`;
}

export function formatSigned(value, decimals = 2) {
  if (!isNum(value)) return NA_TEXT;
  const text = formatNumber(Math.abs(value), decimals);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}
