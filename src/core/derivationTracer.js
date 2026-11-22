/**
 * derivationTracer.js: the "show your working" contract.
 *
 * Every number an engine produces is wrapped in a TracedMetric:
 *
 *   {
 *     id, label,
 *     value,            // number | string (labels such as a trend regime) | null
 *     unit,             // index | ratio | pct | currency | score | shares | label | days
 *     status,           // "ok" | "na"
 *     naReason,         // why the value is unavailable (null when ok)
 *     tone,             // healthy | neutral | caution | risky | null
 *     meta,             // optional extras (currency code, weights, sub-values)
 *     trace: {
 *       formula,        // the formula in words and symbols
 *       rawInputs,      // [{ name, value, unit, source, asOf }]
 *       steps,          // [{ n, description, expression, result }]
 *       interpretation, // { summary, thresholds: [{ range, label, tone }], caveat }
 *       dependsOn       // ids of child metrics, for drill-down in the drawer
 *     }
 *   }
 *
 * The drawer renders this object directly, so a signal can always be checked
 * by hand. `value` is guaranteed to be finite or null: a non-finite number is
 * converted into an N/A metric automatically.
 */

import { isNum } from './precisionMath.js';

export const UNITS = Object.freeze(['index', 'ratio', 'pct', 'currency', 'score', 'shares', 'label', 'days']);
export const TONES = Object.freeze(['healthy', 'neutral', 'caution', 'risky']);

const NON_FINITE_REASON = 'The calculation did not produce a finite number.';

function cleanValue(value) {
  if (isNum(value)) return value;
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

/** One raw input to a calculation. */
export function input(name, value, unit = '', source = '', asOf = null) {
  return {
    name: cleanText(name),
    value: cleanValue(value),
    unit: cleanText(unit),
    source: cleanText(source),
    asOf: typeof asOf === 'string' ? asOf : null,
  };
}

/** One arithmetic step. Steps are numbered when the trace is assembled. */
export function step(description, expression, result) {
  return {
    description: cleanText(description),
    expression: cleanText(expression),
    result: cleanValue(result),
  };
}

/** One row of the "how to read this" table. */
export function threshold(range, label, tone = 'neutral') {
  return {
    range: cleanText(range),
    label: cleanText(label),
    tone: TONES.includes(tone) ? tone : 'neutral',
  };
}

export function interpretation(summary, thresholds = [], caveat = null) {
  return {
    summary: cleanText(summary),
    thresholds: Array.isArray(thresholds) ? thresholds : [],
    caveat: typeof caveat === 'string' && caveat ? caveat : null,
  };
}

function assembleTrace({ formula, rawInputs, steps, interpretation: reading, dependsOn }) {
  const numberedSteps = (Array.isArray(steps) ? steps : [])
    .filter(Boolean)
    .map((item, index) => ({
      n: index + 1,
      description: cleanText(item.description),
      expression: cleanText(item.expression),
      result: cleanValue(item.result),
    }));
  return {
    formula: cleanText(formula),
    rawInputs: (Array.isArray(rawInputs) ? rawInputs : []).filter(Boolean),
    steps: numberedSteps,
    interpretation: reading && typeof reading === 'object' ? reading : interpretation(''),
    dependsOn: [...new Set((Array.isArray(dependsOn) ? dependsOn : []).filter((id) => typeof id === 'string' && id))],
  };
}

/**
 * Build a metric that has a value. If `value` turns out to be missing or not
 * finite the result is an N/A metric instead, so bad arithmetic can never
 * reach the screen as "NaN".
 */
export function traced(spec) {
  const value = cleanValue(spec.value);
  if (value === null) {
    // Drop the steps and reading written for a real value: they would describe a number that does not exist.
    return notAvailable({ ...spec, steps: [], interpretation: null, reason: spec.reason || NON_FINITE_REASON });
  }
  return {
    id: String(spec.id),
    label: cleanText(spec.label, String(spec.id)),
    value,
    unit: UNITS.includes(spec.unit) ? spec.unit : 'ratio',
    status: 'ok',
    naReason: null,
    tone: TONES.includes(spec.tone) ? spec.tone : null,
    meta: spec.meta && typeof spec.meta === 'object' ? { ...spec.meta } : {},
    trace: assembleTrace(spec),
  };
}

/** Build an N/A metric with a plain-English reason. */
export function notAvailable(spec) {
  const reason = cleanText(spec.reason, 'Not available.');
  const reading = spec.interpretation && spec.interpretation.summary
    ? spec.interpretation
    : interpretation(reason, [], null);
  return {
    id: String(spec.id),
    label: cleanText(spec.label, String(spec.id)),
    value: null,
    unit: UNITS.includes(spec.unit) ? spec.unit : 'ratio',
    status: 'na',
    naReason: reason,
    tone: null,
    meta: spec.meta && typeof spec.meta === 'object' ? { ...spec.meta } : {},
    trace: assembleTrace({ ...spec, interpretation: reading }),
  };
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

export function isTraced(metric) {
  return Boolean(metric) && typeof metric === 'object' && typeof metric.id === 'string'
    && (metric.status === 'ok' || metric.status === 'na') && metric.trace && typeof metric.trace === 'object';
}

/** The numeric value of a metric, or null when it is N/A or not numeric. */
export function valueOf(metric) {
  return isTraced(metric) && metric.status === 'ok' && isNum(metric.value) ? metric.value : null;
}

/** The label value of a metric (e.g. "Uptrend"), or null. */
export function labelOf(metric) {
  return isTraced(metric) && metric.status === 'ok' && typeof metric.value === 'string' ? metric.value : null;
}

/**
 * Format a number for use inside a step expression: enough decimals to
 * re-check by hand, thousands separators, no trailing zeros.
 */
export function fmtN(value, decimals = 4) {
  if (typeof value === 'string') return value;
  if (!isNum(value)) return 'N/A';
  const magnitude = Math.abs(value);
  let places = decimals;
  if (magnitude >= 1e6) places = 0;
  else if (magnitude >= 1000) places = Math.min(decimals, 2);
  else if (magnitude > 0 && magnitude < 0.001) places = Math.max(decimals, 8);
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: places });
}

/** Format a decimal fraction as a percentage for a step expression. */
export function fmtPct(fraction, decimals = 2) {
  if (!isNum(fraction)) return 'N/A';
  return `${(fraction * 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals })}%`;
}

/* ------------------------------------------------------------------ */
/* Validation and drill-down                                           */
/* ------------------------------------------------------------------ */

/** Returns a list of contract violations. Used by the test page. */
export function validateTrace(metric) {
  const errors = [];
  if (!metric || typeof metric !== 'object') return ['metric is not an object'];
  if (typeof metric.id !== 'string' || !metric.id) errors.push('id must be a non-empty string');
  if (typeof metric.label !== 'string' || !metric.label) errors.push('label must be a non-empty string');
  if (!UNITS.includes(metric.unit)) errors.push(`unit "${metric.unit}" is not one of ${UNITS.join(', ')}`);
  if (metric.status !== 'ok' && metric.status !== 'na') errors.push('status must be "ok" or "na"');
  if (metric.status === 'ok') {
    if (metric.value === null || metric.value === undefined) errors.push('an ok metric needs a value');
    if (typeof metric.value === 'number' && !Number.isFinite(metric.value)) errors.push('value must be finite');
    if (metric.naReason !== null) errors.push('an ok metric must have naReason = null');
  }
  if (metric.status === 'na') {
    if (metric.value !== null) errors.push('an N/A metric must have value = null');
    if (typeof metric.naReason !== 'string' || !metric.naReason) errors.push('an N/A metric needs a naReason');
  }
  if (metric.tone !== null && !TONES.includes(metric.tone)) errors.push(`tone "${metric.tone}" is not valid`);

  const trace = metric.trace;
  if (!trace || typeof trace !== 'object') {
    errors.push('trace is missing');
    return errors;
  }
  if (typeof trace.formula !== 'string') errors.push('trace.formula must be a string');
  if (metric.status === 'ok' && !trace.formula) errors.push('an ok metric needs a formula');
  if (!Array.isArray(trace.rawInputs)) errors.push('trace.rawInputs must be an array');
  else {
    trace.rawInputs.forEach((raw, index) => {
      if (!raw || typeof raw.name !== 'string' || !raw.name) errors.push(`rawInputs[${index}] needs a name`);
      if (raw && typeof raw.value === 'number' && !Number.isFinite(raw.value)) errors.push(`rawInputs[${index}] is not finite`);
    });
  }
  if (!Array.isArray(trace.steps)) errors.push('trace.steps must be an array');
  else {
    if (metric.status === 'ok' && trace.steps.length === 0) errors.push('an ok metric needs at least one step');
    trace.steps.forEach((item, index) => {
      if (!item || item.n !== index + 1) errors.push(`steps[${index}] must be numbered ${index + 1}`);
      if (item && typeof item.result === 'number' && !Number.isFinite(item.result)) errors.push(`steps[${index}] result is not finite`);
    });
  }
  const reading = trace.interpretation;
  if (!reading || typeof reading.summary !== 'string' || !reading.summary) errors.push('interpretation.summary is required');
  if (reading && !Array.isArray(reading.thresholds)) errors.push('interpretation.thresholds must be an array');
  if (!Array.isArray(trace.dependsOn)) errors.push('trace.dependsOn must be an array');
  return errors;
}

/**
 * Collect traced metrics from any mix of metrics, arrays and plain objects
 * into a Map keyed by id.
 */
export function buildTraceIndex(...sources) {
  const index = new Map();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (isTraced(node)) {
      index.set(node.id, node);
      return;
    }
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) visit(child, depth + 1);
  };
  for (const source of sources) visit(source, 0);
  return index;
}

/**
 * Resolve a metric and everything it depends on into a tree:
 *   { metric, children: [ { metric, children }, ... ], missing: [ids] }
 * Cycle-safe; unknown ids are reported in `missing` rather than thrown.
 */
export function dependencyTree(index, id, maxDepth = 6) {
  const walk = (currentId, path, depth) => {
    const metric = index.get(currentId);
    if (!metric) return null;
    const node = { metric, children: [], missing: [] };
    if (depth >= maxDepth) return node;
    for (const childId of metric.trace.dependsOn) {
      if (path.includes(childId)) continue;
      const child = walk(childId, [...path, childId], depth + 1);
      if (child) node.children.push(child);
      else node.missing.push(childId);
    }
    return node;
  };
  return walk(id, [id], 0);
}
