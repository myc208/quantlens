/**
 * stressEngine.js: the three-pillar macro regime (V5.0).
 *
 *   volatility  VIX ÷ VIX3M at or above 1.00: the VIX curve is inverted
 *   credit      the US high-yield option-adjusted spread at or above 4.50%, or at least
 *               0.50 points wider than 20 sessions before
 *   rates       the 10-year minus 2-year Treasury spread below zero, or a bull steepening:
 *               at least 0.35 points steeper over 20 sessions while the 2-year yield fell
 *
 * Flags are counted over the pillars that could be read: 0 is Calm, 1 Cautious, 2 or 3
 * Stressed. The state's multiplier (1.00, 1.15, 1.35) widens every stop of the Decision Radar,
 * so that the ordinary noise of a stressed market is less likely to reach them. It changes no
 * score and no tier.
 *
 * The pipeline reads the pillars (FRED for credit and rates) and writes macro.stress; this
 * engine counts them again from their flags and rules, so the site, the bot and a test can
 * check the pipeline's state. A snapshot without the block (written before V5.0, or a run whose
 * FRED step did not finish) falls back to the volatility pillar alone, read from macro.regime.
 */

import { isNum } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN } from '../core/derivationTracer.js';

export const STRESS_CONFIG = Object.freeze({
  rules: Object.freeze({ volRatio: 1, creditLevel: 0.045, creditWidening: 0.005, ratesInverted: 0, ratesSteepening: 0.0035, window: 20 }),
  multipliers: Object.freeze({ Calm: 1, Cautious: 1.15, Stressed: 1.35 }),
  pillars: Object.freeze(['volatility', 'credit', 'rates']),
});

export const STRESS_PILLAR_LABELS = Object.freeze({
  volatility: 'Volatility (VIX ÷ VIX3M)',
  credit: 'Credit (US high-yield spread)',
  rates: 'Rates (10-year − 2-year Treasury)',
});

const STATE_TONES = Object.freeze({ Calm: 'healthy', Cautious: 'caution', Stressed: 'risky' });

const pct = (fraction, decimals = 2) => `${(fraction * 100).toFixed(decimals)}%`;
const signedPct = (fraction, decimals = 2) => `${fraction < 0 ? '−' : '+'}${(Math.abs(fraction) * 100).toFixed(decimals)}%`;
const points = (fraction) => `${fraction < 0 ? '−' : '+'}${(Math.abs(fraction) * 100).toFixed(2)} points`;

/** 0 flags → Calm, 1 → Cautious, 2 or 3 → Stressed. */
export function stressState(flags) {
  if (!Number.isInteger(flags) || flags < 0) return null;
  return flags === 0 ? 'Calm' : flags === 1 ? 'Cautious' : 'Stressed';
}

function unreadPillar(name, series, note) {
  return Object.freeze({ name, status: 'unavailable', flag: null, asOf: null, source: name === 'volatility' ? 'yahoo' : 'fred', series, value: null, change: null, from: null, twoYearChange: null, note });
}

/** The volatility pillar from the VIX regime block: the fallback when there is no stress block. */
export function volatilityFromRegime(regime, rules = STRESS_CONFIG.rules) {
  if (!regime || regime.status === 'unavailable' || !isNum(regime.ratio)) return unreadPillar('volatility', '^VIX / ^VIX3M', 'The VIX curve could not be read.');
  return Object.freeze({
    name: 'volatility', status: regime.status, flag: regime.ratio >= rules.volRatio, asOf: regime.asOf, source: 'yahoo',
    series: '^VIX / ^VIX3M', value: regime.ratio, change: null, from: null, twoYearChange: null, note: null,
  });
}

/** The count, the state and its multiplier, over the pillars that could be read. */
export function composeStress(pillars, multipliers = STRESS_CONFIG.multipliers) {
  const read = STRESS_CONFIG.pillars.filter((name) => pillars[name] && pillars[name].status !== 'unavailable');
  const flags = read.filter((name) => pillars[name].flag === true).length;
  const state = read.length ? stressState(flags) : null;
  let status = 'unavailable';
  if (read.length === 1 && read[0] === 'volatility') status = 'vix-only';
  else if (read.length === STRESS_CONFIG.pillars.length && read.every((name) => pillars[name].status === 'fresh')) status = 'fresh';
  else if (read.length) status = 'partial';
  return { state, flags, active: read.length, multiplier: state ? multipliers[state] : 1, status };
}

/** One pillar in words: its reading and, when flagged, which rule it met. */
export function pillarText(pillar, rules = STRESS_CONFIG.rules) {
  if (!pillar || pillar.status === 'unavailable') return `Not read${pillar && pillar.note ? `: ${pillar.note}` : '.'}`;
  const window = rules.window;
  if (pillar.name === 'volatility') {
    const limit = rules.volRatio.toFixed(2);
    return `VIX ÷ VIX3M ${pillar.value.toFixed(2)}: ${pillar.flag ? `at or above ${limit}, the curve is inverted` : `below ${limit}, the curve is not inverted`}`;
  }
  if (pillar.name === 'credit') {
    const change = isNum(pillar.change) ? `, ${points(pillar.change)} over ${window} sessions` : '';
    let reason = `below ${pct(rules.creditLevel)} and not ${(rules.creditWidening * 100).toFixed(2)} points wider`;
    if (pillar.value >= rules.creditLevel) reason = `at or above ${pct(rules.creditLevel)}`;
    else if (isNum(pillar.change) && pillar.change >= rules.creditWidening) reason = `at least ${(rules.creditWidening * 100).toFixed(2)} points wider in ${window} sessions`;
    return `High-yield spread ${pct(pillar.value)}${change}: ${reason}`;
  }
  const change = isNum(pillar.change) ? `, ${points(pillar.change)} over ${window} sessions` : '';
  const twoYear = isNum(pillar.twoYearChange) ? ` (2-year yield ${points(pillar.twoYearChange)})` : '';
  let reason = 'not inverted and no bull steepening';
  if (pillar.value < rules.ratesInverted) reason = 'inverted';
  else if (pillar.flag) reason = `a bull steepening: at least ${(rules.ratesSteepening * 100).toFixed(2)} points steeper while the 2-year yield fell`;
  return `10Y − 2Y spread ${signedPct(pillar.value)}${change}${twoYear}: ${reason}`;
}

/**
 * The macro regime of a normalised snapshot's macro block.
 * @returns {{ state, multiplier, flags, active, status, fallback, pillars, rules, multipliers, note, metric }}
 */
export function analyzeStress(macro) {
  const block = macro && macro.stress ? macro.stress : null;
  const rules = block ? block.rules : STRESS_CONFIG.rules;
  const multipliers = block ? block.multipliers : STRESS_CONFIG.multipliers;
  const fallbackNote = 'This snapshot has no FRED pillars, so only the VIX pillar is used.';
  const pillars = block ? block.pillars : {
    volatility: volatilityFromRegime(macro ? macro.regime : null, rules),
    credit: unreadPillar('credit', 'BAMLH0A0HYM2', fallbackNote),
    rates: unreadPillar('rates', 'T10Y2Y', fallbackNote),
  };
  const composite = composeStress(pillars, multipliers);
  const note = block ? block.note : fallbackNote;
  const id = 'macroStress';
  const label = 'Macro regime (three pillars)';
  const formula = 'Flags = pillars that meet their rule (volatility, credit, rates); 0 = Calm (×1.00), 1 = Cautious (×1.15), 2–3 = Stressed (×1.35)';
  const thresholds = [
    threshold('0 flags', `Calm: stops at ×${fmtN(multipliers.Calm, 2)}`, 'healthy'),
    threshold('1 flag', `Cautious: stops at ×${fmtN(multipliers.Cautious, 2)}`, 'caution'),
    threshold('2 or 3 flags', `Stressed: stops at ×${fmtN(multipliers.Stressed, 2)}`, 'risky'),
  ];
  const rawInputs = STRESS_CONFIG.pillars.map((name) => {
    const pillar = pillars[name];
    return input(STRESS_PILLAR_LABELS[name], pillar.value, name === 'volatility' ? 'ratio' : 'fraction', `${pillar.source ?? 'n/a'} ${pillar.series ?? ''}`.trim(), pillar.asOf);
  });
  const shared = { id, label, unit: 'label', formula, rawInputs };
  const decorated = Object.fromEntries(STRESS_CONFIG.pillars.map((name) => [name, { ...pillars[name], label: STRESS_PILLAR_LABELS[name], text: pillarText(pillars[name], rules) }]));
  let metric;
  if (!composite.state) {
    metric = notAvailable({ ...shared, reason: 'None of the three pillars could be read, so stops use no regime multiplier (×1.00).' });
  } else {
    const flagged = STRESS_CONFIG.pillars.filter((name) => pillars[name].flag === true);
    metric = traced({
      ...shared, value: composite.state, tone: STATE_TONES[composite.state],
      meta: { ...composite, fallback: !block, flagged },
      steps: [
        ...STRESS_CONFIG.pillars.map((name) => step(STRESS_PILLAR_LABELS[name], decorated[name].text,
          pillars[name].status === 'unavailable' ? 'not read' : pillars[name].flag ? 'flag' : 'no flag')),
        step('Count the flags over the pillars read', `${composite.flags} of ${composite.active}`, composite.flags),
        step('State and stop multiplier', `${composite.flags} flag${composite.flags === 1 ? '' : 's'} → ${composite.state}`, `×${fmtN(composite.multiplier, 2)}`),
      ],
      interpretation: interpretation(
        `${composite.state}: ${composite.flags} of the ${composite.active} pillar${composite.active === 1 ? '' : 's'} read ${composite.flags === 1 ? 'is' : 'are'} flagged${flagged.length ? ` (${flagged.join(', ')})` : ''}. The Decision Radar's stops are widened ×${fmtN(composite.multiplier, 2)}.`,
        thresholds,
        `${composite.active < 3 ? `${note ?? 'Not every pillar could be read.'} With fewer pillars the count can only understate stress. ` : ''}Context for sizing risk, not a forecast: the multiplier makes room for a stressed market's larger daily swings. It changes no score and no tier.`,
      ),
    });
  }
  return { ...composite, fallback: !block, pillars: decorated, rules, multipliers, note, metric };
}
