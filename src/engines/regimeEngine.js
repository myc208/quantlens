/**
 * regimeEngine.js: the market regime, read from the VIX term structure.
 *
 *   VIX     the market's 30-day implied volatility of the S&P 500 (Cboe), in points
 *   VIX9D   the same over 9 days
 *   VIX3M   the same over 3 months
 *
 * Normally the curve slopes up (contango): more time, more uncertainty. When the
 * 30-day level reaches the 3-month one, the curve is inverted: options traders pay
 * more for protection now than later, which is what stress looks like in prices.
 *
 *   stressed  VIX ÷ VIX3M ≥ invertedRatio (1.00)
 *   normal    VIX < elevatedLevel (20) and VIX ÷ VIX3M < elevatedRatio (0.95)
 *   elevated  anything in between
 *
 * The thresholds travel with the data (macro.regime.rules). The pipeline applies the
 * same rules to the same stored levels for the Telegram briefing, and a test checks
 * that the two agree on the committed snapshot.
 *
 * Context only: the regime is not an input to any score, verdict or position size.
 */

import { isNum, safeDiv } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';

export const REGIME_CONFIG = Object.freeze({
  defaultRules: Object.freeze({ elevatedLevel: 20, elevatedRatio: 0.95, invertedRatio: 1 }),
  lookbackSessions: 252,          // "the last year", for percentiles and counts
  tradingDays: 252,               // VIX is annualised over trading days
});

export const REGIME_STATES = Object.freeze(['normal', 'elevated', 'stressed']);
export const REGIME_METRIC_IDS = Object.freeze(['marketRegime', 'vixLevel', 'vixTermRatio', 'vixFrontRatio']);

const STATE_LABELS = Object.freeze({ normal: 'Normal', elevated: 'Elevated', stressed: 'Stressed' });
const STATE_TONES = Object.freeze({ normal: 'healthy', elevated: 'caution', stressed: 'risky' });
const LABELS = Object.freeze({
  marketRegime: 'Market regime',
  vixLevel: 'VIX (30-day implied volatility)',
  vixTermRatio: 'VIX ÷ VIX3M (term structure)',
  vixFrontRatio: 'VIX9D ÷ VIX (front of the curve)',
});
const UNITS = Object.freeze({ marketRegime: 'label', vixLevel: 'index', vixTermRatio: 'ratio', vixFrontRatio: 'ratio' });
const FORMULAS = Object.freeze({
  marketRegime: 'stressed if VIX ÷ VIX3M ≥ 1.00 (inverted curve); normal if VIX < 20 and VIX ÷ VIX3M < 0.95; elevated otherwise',
  vixLevel: 'Latest completed close of the Cboe VIX index; implied daily move ≈ VIX ÷ √252',
  vixTermRatio: 'VIX ÷ VIX3M: below 1 the curve slopes up (contango), at or above 1 it is inverted',
  vixFrontRatio: 'VIX9D ÷ VIX: above 1, the next nine days are priced as riskier than the next month',
});
const CONTEXT = 'Context only: the regime is not an input to any score, verdict or position size.';

/**
 * The regime's state from the VIX and VIX3M levels, or null if they are unusable.
 * Exactly the pipeline's rule (classify_regime in fetch_fundamentals.py).
 */
export function classifyRegime(vix, vix3m, rules = REGIME_CONFIG.defaultRules) {
  if (!isNum(vix) || !isNum(vix3m) || vix <= 0 || vix3m <= 0) return null;
  const ratio = vix / vix3m;
  if (ratio >= rules.invertedRatio) return 'stressed';
  if (vix < rules.elevatedLevel && ratio < rules.elevatedRatio) return 'normal';
  return 'elevated';
}

/** Share of `values` at or below `value` (0 to 1), or null for an empty list. */
export function percentileRank(values, value) {
  const list = (Array.isArray(values) ? values : []).filter(isNum);
  if (!list.length || !isNum(value)) return null;
  return list.filter((entry) => entry <= value).length / list.length;
}

/** Sessions, counting back from the latest, on which VIX ÷ VIX3M reached the inverted ratio. */
export function invertedRun(history, invertedRatio = REGIME_CONFIG.defaultRules.invertedRatio) {
  let run = 0;
  for (let i = history.vix.length - 1; i >= 0; i -= 1) {
    if (!(history.vix[i] / history.vix3m[i] >= invertedRatio)) break;
    run += 1;
  }
  return run;
}

/** How many sessions in the window were inverted. */
function invertedCount(history, from, invertedRatio) {
  let count = 0;
  for (let i = from; i < history.vix.length; i += 1) if (history.vix[i] / history.vix3m[i] >= invertedRatio) count += 1;
  return count;
}

function ordinal(number) {
  const tens = number % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] ?? 'th');
  return `${number}${suffix}`;
}

function unavailable(reason) {
  const metrics = {};
  for (const id of REGIME_METRIC_IDS) metrics[id] = notAvailable({ id, label: LABELS[id], unit: UNITS[id], formula: FORMULAS[id], reason });
  return { state: null, status: 'unavailable', asOf: null, metrics };
}

/**
 * Traced metrics for the market regime.
 * @param {object|null} regime the normalised macro.regime block (snapshotService.normaliseRegime)
 * @returns {{ state:string|null, status:string, asOf:string|null, levels?:object, streak?:number, metrics:object }}
 */
export function analyzeRegime(regime) {
  const usable = regime && (regime.status === 'fresh' || regime.status === 'stale')
    && regime.levels && isNum(regime.levels.vix) && isNum(regime.levels.vix3m) && regime.history && regime.history.vix.length > 0;
  if (!usable) return unavailable(regime && regime.note ? regime.note : 'This snapshot has no reading of the VIX curve.');

  const rules = regime.rules ?? REGIME_CONFIG.defaultRules;
  const { vix9d, vix, vix3m } = regime.levels;
  const { asOf, history } = regime;
  const ratio = vix / vix3m;
  const slope = vix3m - vix;
  const state = classifyRegime(vix, vix3m, rules);
  const inverted = ratio >= rules.invertedRatio;
  const streak = invertedRun(history, rules.invertedRatio);
  const sessions = history.vix.length;
  const yearStart = Math.max(0, sessions - REGIME_CONFIG.lookbackSessions);
  const yearSessions = sessions - yearStart;
  const invertedYear = invertedCount(history, yearStart, rules.invertedRatio);
  const invertedAll = invertedCount(history, 0, rules.invertedRatio);
  const yearRank = percentileRank(history.vix.slice(yearStart), vix);
  const allRank = percentileRank(history.vix, vix);
  const spanYears = Math.round(sessions / REGIME_CONFIG.lookbackSessions);
  const spanText = spanYears >= 2 ? `${spanYears} years` : `${sessions} sessions`;
  const staleText = regime.status === 'stale' ? ` This is the reading of ${asOf}: the latest one could not be fetched.` : '';
  const source = (symbol) => `${symbol} close (Yahoo Finance)`;
  const vixInput = input('VIX', vix, 'points', source('^VIX'), asOf);
  const vix3mInput = input('VIX3M', vix3m, 'points', source('^VIX3M'), asOf);

  const metrics = {};
  const label = STATE_LABELS[state];
  const runText = streak > 1 ? `, for the ${ordinal(streak)} session in a row` : streak === 1 ? ', for the first session' : '';
  const summaries = {
    stressed: `The VIX curve is inverted (VIX ${fmtN(vix, 2)} above VIX3M ${fmtN(vix3m, 2)})${runText}: protection over the next month costs more than over the next three. That happened on ${invertedYear} of the last ${yearSessions} sessions.`,
    elevated: `Not inverted, but not calm: ${vix >= rules.elevatedLevel ? `VIX is ${fmtN(vix, 2)}, at or above ${fmtN(rules.elevatedLevel, 0)}` : `VIX ÷ VIX3M is ${fmtN(ratio, 3)}, a flat curve`}.`,
    normal: `Calm: VIX ${fmtN(vix, 2)}, with the curve sloping up (VIX ÷ VIX3M ${fmtN(ratio, 3)}).`,
  };
  const stateSteps = [
    step('Divide VIX by VIX3M', `${fmtN(vix, 2)} ÷ ${fmtN(vix3m, 2)}`, fmtN(ratio, 3)),
    step(`Is the curve inverted? (ratio at or above ${fmtN(rules.invertedRatio, 2)})`, `${fmtN(ratio, 3)} ≥ ${fmtN(rules.invertedRatio, 2)}`, inverted ? 'yes: stressed' : 'no'),
  ];
  if (!inverted) {
    const calm = vix < rules.elevatedLevel && ratio < rules.elevatedRatio;
    stateSteps.push(step(`Is it calm? (VIX below ${fmtN(rules.elevatedLevel, 0)} and ratio below ${fmtN(rules.elevatedRatio, 2)})`,
      `${fmtN(vix, 2)} < ${fmtN(rules.elevatedLevel, 0)} and ${fmtN(ratio, 3)} < ${fmtN(rules.elevatedRatio, 2)}`, calm ? 'yes: normal' : 'no: elevated'));
  }
  metrics.marketRegime = traced({
    id: 'marketRegime', label: LABELS.marketRegime, value: label, unit: 'label', tone: STATE_TONES[state],
    meta: { state, inverted, streak, asOf, status: regime.status, ratio, slope, vix, vix3m, vix9d, rules: { ...rules }, invertedYear, yearSessions, pipelineState: regime.state, agreesWithPipeline: regime.state === state },
    formula: FORMULAS.marketRegime,
    rawInputs: [
      vixInput, vix3mInput,
      input('Inverted at a ratio of', rules.invertedRatio, 'ratio', 'macro.regime.rules'),
      input('Elevated from a VIX of', rules.elevatedLevel, 'points', 'macro.regime.rules'),
      input('Or from a ratio of', rules.elevatedRatio, 'ratio', 'macro.regime.rules'),
    ],
    steps: [...stateSteps, step('Regime', state, label)],
    interpretation: interpretation(summaries[state], [
      threshold(`VIX < ${fmtN(rules.elevatedLevel, 0)} and VIX ÷ VIX3M < ${fmtN(rules.elevatedRatio, 2)}`, 'Normal', 'healthy'),
      threshold(`Otherwise, VIX ÷ VIX3M below ${fmtN(rules.invertedRatio, 2)}`, 'Elevated', 'caution'),
      threshold(`VIX ÷ VIX3M ≥ ${fmtN(rules.invertedRatio, 2)}: inverted`, 'Stressed', 'risky'),
    ], `${CONTEXT} VIX is priced from S&P 500 options, so it is a gauge of the US market; Singapore stocks and crypto can move differently. It describes what protection costs today, not what happens next.${staleText}`),
    dependsOn: ['vixLevel', 'vixTermRatio'],
  });

  const dailyMove = vix / Math.sqrt(REGIME_CONFIG.tradingDays);
  metrics.vixLevel = traced({
    id: 'vixLevel', label: LABELS.vixLevel, value: vix, unit: 'index',
    tone: vix < rules.elevatedLevel ? 'healthy' : vix < 30 ? 'caution' : 'risky',
    meta: { asOf, dailyMove, yearRank, allRank, yearSessions, sessions, yearHigh: Math.max(...history.vix.slice(yearStart)), yearLow: Math.min(...history.vix.slice(yearStart)) },
    formula: FORMULAS.vixLevel,
    rawInputs: [vixInput, input('Closes on record', sessions, 'sessions', `macro.regime.history, ${history.dates[0]} to ${asOf}`)],
    steps: [
      step('Latest completed VIX close', asOf, fmtN(vix, 2)),
      step('Implied daily move of the S&P 500 (VIX ÷ √252)', `${fmtN(vix, 2)} ÷ ${fmtN(Math.sqrt(REGIME_CONFIG.tradingDays), 2)}`, `${fmtN(dailyMove, 2)}%`),
      step(`Share of the last ${yearSessions} sessions at or below this level`, `${Math.round(yearRank * yearSessions)} of ${yearSessions}`, fmtPct(yearRank, 0)),
      step(`Share of all ${sessions} sessions (${spanText})`, `${Math.round(allRank * sessions)} of ${sessions}`, fmtPct(allRank, 0)),
    ],
    interpretation: interpretation(
      `Options price the S&P 500 to move about ${fmtN(dailyMove, 1)}% a day. ${yearRank === 1 ? 'This is the highest VIX close of the last year.' : `VIX closed higher than this on ${fmtPct(1 - yearRank, 0)} of the last year's sessions.`}`,
      [threshold(`Below ${fmtN(rules.elevatedLevel, 0)}`, 'Calm', 'healthy'), threshold(`${fmtN(rules.elevatedLevel, 0)} – 30`, 'Elevated', 'caution'), threshold('30 and above', 'High', 'risky')],
      `VIX is an annualised volatility in percentage points, priced from options; it is the market's expectation plus a premium for insurance, not a forecast. ${CONTEXT}${staleText}`),
  });

  metrics.vixTermRatio = traced({
    id: 'vixTermRatio', label: LABELS.vixTermRatio, value: ratio, unit: 'ratio',
    tone: ratio < rules.elevatedRatio ? 'healthy' : ratio < rules.invertedRatio ? 'caution' : 'risky',
    meta: { asOf, slope, streak, invertedYear, yearSessions, invertedAll, sessions },
    formula: FORMULAS.vixTermRatio,
    rawInputs: [vixInput, vix3mInput],
    steps: [
      step('Divide VIX by VIX3M', `${fmtN(vix, 2)} ÷ ${fmtN(vix3m, 2)}`, fmtN(ratio, 3)),
      step('Slope of the curve: VIX3M − VIX', `${fmtN(vix3m, 2)} − ${fmtN(vix, 2)}`, `${fmtN(slope, 2)} points`),
      step('Inverted sessions in a row, ending on the latest', `${streak}`, `${streak}`),
      step(`Inverted sessions in the last ${yearSessions}`, `${invertedYear} of ${yearSessions}`, fmtPct(safeDiv(invertedYear, yearSessions), 1)),
      step(`Inverted sessions in all ${sessions} (${spanText})`, `${invertedAll} of ${sessions}`, fmtPct(safeDiv(invertedAll, sessions), 1)),
    ],
    interpretation: interpretation(
      inverted ? `Inverted: the next month is priced as riskier than the next three${runText}.`
        : ratio >= rules.elevatedRatio ? 'Flat: the next month is priced almost as risky as the next three.'
          : 'Contango: the usual upward slope, with more uncertainty priced further out.',
      [threshold(`Below ${fmtN(rules.elevatedRatio, 2)}`, 'Contango', 'healthy'), threshold(`${fmtN(rules.elevatedRatio, 2)} – ${fmtN(rules.invertedRatio, 2)}`, 'Flat', 'caution'), threshold(`${fmtN(rules.invertedRatio, 2)} and above`, 'Inverted', 'risky')],
      `The curve has been inverted on ${fmtPct(safeDiv(invertedAll, sessions), 1)} of sessions over ${spanText}: rare, and usually brief. ${CONTEXT}${staleText}`),
  });

  if (!isNum(vix9d)) {
    metrics.vixFrontRatio = notAvailable({ id: 'vixFrontRatio', label: LABELS.vixFrontRatio, unit: 'ratio', formula: FORMULAS.vixFrontRatio,
      reason: regime.note ?? 'VIX9D has no close for the latest session.' });
  } else {
    const front = vix9d / vix;
    metrics.vixFrontRatio = traced({
      id: 'vixFrontRatio', label: LABELS.vixFrontRatio, value: front, unit: 'ratio', tone: front >= 1 ? 'caution' : 'neutral',
      meta: { asOf, vix9d, vix },
      formula: FORMULAS.vixFrontRatio,
      rawInputs: [input('VIX9D', vix9d, 'points', source('^VIX9D'), asOf), vixInput],
      steps: [step('Divide VIX9D by VIX', `${fmtN(vix9d, 2)} ÷ ${fmtN(vix, 2)}`, fmtN(front, 3))],
      interpretation: interpretation(
        front >= 1 ? 'The next nine days are priced as riskier than the next month: stress is concentrated in the near term.'
          : 'The next nine days are priced as calmer than the next month.',
        [threshold('Below 1.00', 'Near term calmer', 'neutral'), threshold('1.00 and above', 'Near-term stress', 'caution')],
        `Shown for context; the regime itself is decided by VIX and VIX3M. ${CONTEXT}${staleText}`),
    });
  }

  return { state, status: regime.status, asOf, levels: { vix9d, vix, vix3m }, ratio, streak, metrics };
}

/**
 * Plain-language pieces for the telemetry pill and the banner.
 * @param {ReturnType<typeof analyzeRegime>} analysis
 */
export function describeRegime(analysis) {
  if (!analysis || !analysis.state) {
    return { state: null, label: 'N/A', tone: null, pill: 'VIX curve unavailable', headline: null, banner: false };
  }
  const { state, levels, ratio, streak, status, asOf } = analysis;
  const curve = ratio >= REGIME_CONFIG.defaultRules.invertedRatio ? 'inverted' : ratio >= REGIME_CONFIG.defaultRules.elevatedRatio ? 'flat' : 'contango';
  const run = streak > 1 ? `, ${ordinal(streak)} session in a row` : streak === 1 ? ', first inverted session' : '';
  const headline = state === 'stressed'
    ? `VIX curve inverted (VIX ${fmtN(levels.vix, 1)} above VIX3M ${fmtN(levels.vix3m, 1)})${run}`
    : `VIX ${fmtN(levels.vix, 1)}, curve ${curve === 'contango' ? 'in contango' : curve} (VIX3M ${fmtN(levels.vix3m, 1)})`;
  return {
    state,
    label: STATE_LABELS[state],
    tone: STATE_TONES[state],
    pill: `VIX ${fmtN(levels.vix, 1)} · ${curve}${status === 'stale' ? ` · ${asOf}` : ''}`,
    headline,
    banner: state === 'stressed',
  };
}
