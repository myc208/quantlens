/**
 * fundamentalEngine.js: sector-aware fundamental ratios and the Fundamental score.
 *
 * One size does not fit all. A bank's "debt" is its raw material and it has
 * no EBITDA; a REIT is valued on its property book and its payout. Each asset
 * is therefore scored with the profile that matches its business:
 *
 *   CORPORATE  EV/EBITDA 25 · Operating margin 20 · FCF yield 20 ·
 *              Debt/Equity 15 · ROE 10 · Forward P/E 10
 *   FINANCIAL  ROE 35 · Price-to-Book 30 · Net margin 20 · Trailing P/E 15
 *   REIT       Price-to-Book 35 · Dividend yield 30 · Gearing 25 · Operating margin 10
 *   CRYPTO     no fundamentals, no score
 *
 * Each metric maps to a 0..100 sub-score by straight-line interpolation
 * between anchor points. A metric that cannot be computed is dropped and the
 * remaining weights are renormalised; below 50% coverage the score is N/A.
 * A zero or negative denominator always yields N/A with a reason, never a score.
 *
 * Units: marketCap and enterpriseValue are in the trading currency; statement
 * items are in the reporting currency. Ratios that mix the two are converted
 * (USD/SGD only) or reported as N/A.
 */

import {
  isNum, safeDiv, convertCurrency, interpolateAnchors, weightedScore, scoreTone,
} from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct,
} from '../core/derivationTracer.js';

const CRYPTO_REASON = 'Crypto assets have no earnings, balance sheet or cash flow, so this measure does not exist.';

export const PROFILES = Object.freeze({
  CORPORATE: Object.freeze({
    label: 'Corporate',
    scoring: Object.freeze([
      Object.freeze({ id: 'evEbitda', weight: 25, anchors: [[8, 100], [15, 60], [25, 25], [40, 0]] }),
      Object.freeze({ id: 'operatingMargin', weight: 20, anchors: [[0, 0], [0.10, 50], [0.30, 100]] }),
      Object.freeze({ id: 'fcfYield', weight: 20, anchors: [[0, 0], [0.02, 40], [0.05, 80], [0.08, 100]] }),
      Object.freeze({ id: 'debtToEquity', weight: 15, anchors: [[0.3, 100], [1.0, 60], [2.0, 20], [3.0, 0]] }),
      Object.freeze({ id: 'roe', weight: 10, anchors: [[0, 0], [0.10, 50], [0.25, 100]] }),
      Object.freeze({ id: 'forwardPE', weight: 10, anchors: [[12, 100], [20, 60], [35, 20], [50, 0]] }),
    ]),
    notApplicable: Object.freeze({}),
    allNotApplicable: null,
  }),
  FINANCIAL: Object.freeze({
    label: 'Bank / financial',
    scoring: Object.freeze([
      Object.freeze({ id: 'roe', weight: 35, anchors: [[0.05, 0], [0.10, 50], [0.16, 100]] }),
      Object.freeze({ id: 'priceToBook', weight: 30, anchors: [[0.8, 100], [1.5, 60], [2.5, 20], [3.5, 0]] }),
      Object.freeze({ id: 'netMargin', weight: 20, anchors: [[0.10, 0], [0.20, 50], [0.35, 100]] }),
      Object.freeze({ id: 'trailingPE', weight: 15, anchors: [[8, 100], [12, 70], [18, 30], [25, 0]] }),
    ]),
    notApplicable: Object.freeze({
      evEbitda: 'Not meaningful for banks: interest is their core business, so "earnings before interest" (EBITDA) is not reported.',
      operatingMargin: 'Not meaningful for banks: they do not report a conventional operating income line. Net margin is used instead.',
      fcfYield: 'Not meaningful for banks: deposit and loan flows dominate cash flow, so free cash flow does not measure owner earnings.',
      debtToEquity: 'Not meaningful for banks: deposits and borrowings are a bank\'s raw material, not a sign of stress. Regulators use capital ratios instead.',
      gearing: 'Not meaningful for banks: almost all of a bank\'s assets are funded by deposits and borrowings by design.',
      ebit: 'Banks do not report EBIT: interest is their core business, not a financing cost.',
      ebitda: 'Banks do not report EBITDA: interest income and expense are their core business.',
      operatingIncome: 'Banks do not report a conventional operating income line.',
      freeCashFlow: 'Not meaningful for banks: loan and deposit flows swamp the figure, so it says little about owner earnings.',
    }),
    allNotApplicable: null,
  }),
  REIT: Object.freeze({
    label: 'REIT',
    scoring: Object.freeze([
      Object.freeze({ id: 'priceToBook', weight: 35, anchors: [[0.8, 100], [1.0, 70], [1.3, 30], [1.6, 0]] }),
      Object.freeze({ id: 'dividendYield', weight: 30, anchors: [[0.02, 0], [0.04, 50], [0.06, 100]] }),
      Object.freeze({ id: 'gearing', weight: 25, anchors: [[0.30, 100], [0.40, 50], [0.50, 0]] }),
      Object.freeze({ id: 'operatingMargin', weight: 10, anchors: [[0.30, 0], [0.65, 100]] }),
    ]),
    notApplicable: Object.freeze({}),
    allNotApplicable: null,
  }),
  CRYPTO: Object.freeze({
    label: 'Crypto',
    scoring: Object.freeze([]),
    notApplicable: Object.freeze({}),
    allNotApplicable: CRYPTO_REASON,
  }),
});

export const MIN_COVERAGE = 0.5;

/** Anchors used only to colour a metric that is shown for context but not scored in its profile. */
const REFERENCE_ANCHORS = Object.freeze({
  trailingPE: [[10, 100], [20, 60], [35, 20], [50, 0]],
  forwardPE: [[12, 100], [20, 60], [35, 20], [50, 0]],
  netMargin: [[0, 0], [0.10, 50], [0.25, 100]],
  operatingMargin: [[0, 0], [0.10, 50], [0.30, 100]],
  roe: [[0, 0], [0.10, 50], [0.25, 100]],
  fcfYield: [[0, 0], [0.02, 40], [0.05, 80], [0.08, 100]],
  debtToEquity: [[0.3, 100], [1.0, 60], [2.0, 20], [3.0, 0]],
  evEbitda: [[8, 100], [15, 60], [25, 25], [40, 0]],
});

const SCORE_THRESHOLDS = [
  threshold('65 – 100', 'Strong', 'healthy'),
  threshold('45 – 65', 'Average', 'neutral'),
  threshold('30 – 45', 'Weak', 'caution'),
  threshold('0 – 30', 'Poor', 'risky'),
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatByUnit(value, unit) {
  return unit === 'pct' ? fmtPct(value) : fmtN(value, 2);
}

function scoringRule(profileKey, id) {
  return PROFILES[profileKey].scoring.find((rule) => rule.id === id) ?? null;
}

function profileBlock(ctx, id) {
  const profile = PROFILES[ctx.profile];
  if (profile.allNotApplicable && id !== 'marketCap') return profile.allNotApplicable;
  return profile.notApplicable[id] ?? null;
}

function anchorThresholds(anchors, unit) {
  return anchors.map(([x, score], index) => {
    let prefix = '';
    if (index === 0) prefix = '≤ ';
    else if (index === anchors.length - 1) prefix = '≥ ';
    return threshold(`${prefix}${formatByUnit(x, unit)}`, `${score} points`, scoreTone(score));
  });
}

/**
 * Turn a metric value into a sub-score for its profile.
 * Returns the extra trace steps, the meta block, tone and the sentence to append.
 */
function scoreMetric(ctx, id, value, unit) {
  const rule = scoringRule(ctx.profile, id);
  const profileLabel = PROFILES[ctx.profile].label;
  if (!rule) {
    const reference = REFERENCE_ANCHORS[id] ? interpolateAnchors(value, REFERENCE_ANCHORS[id]) : null;
    return {
      steps: [],
      meta: { scored: false, weight: 0, subScore: null },
      tone: reference ? scoreTone(reference.score) : null,
      sentence: `Shown for context: it is not part of the ${profileLabel} score.`,
      thresholds: REFERENCE_ANCHORS[id] ? anchorThresholds(REFERENCE_ANCHORS[id], unit) : [],
    };
  }
  const result = interpolateAnchors(value, rule.anchors);
  if (!result) {
    return { steps: [], meta: { scored: true, weight: rule.weight, subScore: null }, tone: null, sentence: '', thresholds: [] };
  }
  const { lower, upper, score, position } = result;
  const expression = position === 'between'
    ? `${lower[1]} + (${formatByUnit(value, unit)} − ${formatByUnit(lower[0], unit)}) ÷ (${formatByUnit(upper[0], unit)} − ${formatByUnit(lower[0], unit)}) × (${upper[1]} − ${lower[1]})`
    : `${formatByUnit(value, unit)} is ${position === 'below' ? 'at or below' : 'at or above'} the ${position === 'below' ? 'first' : 'last'} anchor (${formatByUnit(lower[0], unit)})`;
  return {
    steps: [
      step(
        `Score for the ${profileLabel} profile: interpolate between the anchors ${formatByUnit(lower[0], unit)} → ${lower[1]} and ${formatByUnit(upper[0], unit)} → ${upper[1]}`,
        expression,
        score,
      ),
    ],
    meta: { scored: true, weight: rule.weight, subScore: score, anchors: rule.anchors },
    tone: scoreTone(score),
    sentence: `That earns ${fmtN(score, 0)} out of 100 and carries ${rule.weight}% of the ${profileLabel} fundamental score.`,
    thresholds: anchorThresholds(rule.anchors, unit),
  };
}

function sourceOf(ctx, key) {
  return `snapshot.fundamentals.${key} (Yahoo Finance${ctx.period ? `, ${ctx.period}` : ''})`;
}

function currencyOf(ctx, basis) {
  return basis === 'market' ? ctx.currency : ctx.financialCurrency;
}

/* ------------------------------------------------------------------ */
/* Reported figures                                                    */
/* ------------------------------------------------------------------ */

const REPORTED_AMOUNTS = Object.freeze([
  { id: 'marketCap', key: 'marketCap', label: 'Market capitalisation', basis: 'market', usedIn: 'FCF yield' },
  { id: 'enterpriseValue', key: 'enterpriseValue', label: 'Enterprise value', basis: 'market', usedIn: 'EV / EBITDA' },
  { id: 'ebit', key: 'ebit', label: 'EBIT', basis: 'statement', usedIn: null },
  { id: 'ebitda', key: 'ebitda', label: 'EBITDA', basis: 'statement', usedIn: 'EV / EBITDA' },
  { id: 'operatingIncome', key: 'operatingIncome', label: 'Operating income', basis: 'statement', usedIn: 'Operating margin' },
  { id: 'totalDebt', key: 'totalDebt', label: 'Total debt', basis: 'statement', usedIn: 'Debt / Equity and gearing' },
  { id: 'freeCashFlow', key: 'freeCashFlow', label: 'Free cash flow', basis: 'statement', usedIn: 'FCF yield' },
]);

function buildReportedAmount(ctx, def) {
  const { id, key, label, basis } = def;
  const currency = currencyOf(ctx, basis);
  const formula = 'Reported figure (no calculation)';
  const blocked = profileBlock(ctx, id);
  if (blocked) return notAvailable({ id, label, unit: 'currency', meta: { currency }, formula, reason: blocked });
  const value = ctx.fundamentals[key];
  if (!isNum(value)) {
    return notAvailable({ id, label, unit: 'currency', meta: { currency }, formula, reason: `${label} is not reported by the company or the data provider.` });
  }
  const periodText = ctx.period ? ` for ${ctx.period === 'TTM' ? 'the trailing twelve months' : ctx.period}` : '';
  const isFlow = ['ebit', 'ebitda', 'operatingIncome', 'freeCashFlow'].includes(id);
  return traced({
    id, label, value, unit: 'currency', tone: isFlow && value < 0 ? 'risky' : null, meta: { currency, period: ctx.period, basis },
    formula,
    rawInputs: [input(label, value, currency, sourceOf(ctx, key), ctx.asOf)],
    steps: [step('Read the reported figure from the daily snapshot', `fundamentals.${key}`, value)],
    interpretation: interpretation(
      `${label} is ${fmtN(value)} ${currency}${isFlow ? periodText : ''}.${def.usedIn ? ` It feeds into: ${def.usedIn}.` : ''}`,
      [],
      basis === 'market'
        ? 'Market-based figures are in the trading currency and move with the share price.'
        : 'Statement figures are in the company\'s reporting currency and change only when new results are filed.',
    ),
  });
}

function buildReportedMultiple(ctx, def) {
  const { id, key, label, formula, nullReason, nonPositiveReason, caveat } = def;
  const blocked = profileBlock(ctx, id);
  if (blocked) return notAvailable({ id, label, unit: 'ratio', formula, reason: blocked });
  const value = ctx.fundamentals[key];
  if (!isNum(value)) return notAvailable({ id, label, unit: 'ratio', formula, reason: nullReason });
  if (value <= 0) {
    return notAvailable({
      id, label, unit: 'ratio', formula, reason: nonPositiveReason,
      rawInputs: [input(label, value, 'ratio', sourceOf(ctx, key), ctx.asOf)],
    });
  }
  const scoring = scoreMetric(ctx, id, value, 'ratio');
  return traced({
    id, label, value, unit: 'ratio', tone: scoring.tone, meta: scoring.meta,
    formula,
    rawInputs: [
      input(label, value, 'ratio', sourceOf(ctx, key), ctx.asOf),
      input('Latest close', ctx.price, ctx.currency, 'last candle', ctx.asOf),
    ],
    steps: [
      step('Read the multiple reported by the data provider', `fundamentals.${key}`, value),
      step(def.impliedLabel, `${fmtN(ctx.price)} ÷ ${fmtN(value, 2)}`, safeDiv(ctx.price, value)),
      ...scoring.steps,
    ],
    interpretation: interpretation(`${label} is ${fmtN(value, 2)}. ${scoring.sentence}`.trim(), scoring.thresholds, caveat),
  });
}

const REPORTED_MULTIPLES = Object.freeze([
  {
    id: 'trailingPE', key: 'trailingPE', label: 'Trailing P/E',
    formula: 'Trailing P/E = Price ÷ earnings per share over the last twelve months',
    impliedLabel: 'Implied earnings per share (price ÷ P/E)',
    nullReason: 'No trailing P/E is reported, usually because earnings over the last twelve months were negative.',
    nonPositiveReason: 'Earnings are negative, so a P/E ratio is not meaningful.',
    caveat: 'One-off gains or losses can distort trailing earnings.',
  },
  {
    id: 'forwardPE', key: 'forwardPE', label: 'Forward P/E',
    formula: 'Forward P/E = Price ÷ analysts\' forecast earnings per share for the next twelve months',
    impliedLabel: 'Implied forecast earnings per share (price ÷ P/E)',
    nullReason: 'No forward P/E is available: there is no analyst earnings forecast for this company.',
    nonPositiveReason: 'Analysts forecast a loss, so a forward P/E is not meaningful.',
    caveat: 'Forecasts are opinions and are often revised.',
  },
  {
    id: 'priceToBook', key: 'priceToBook', label: 'Price-to-Book',
    formula: 'P/B = Price ÷ book value per share',
    impliedLabel: 'Implied book value per share (price ÷ P/B)',
    nullReason: 'Price-to-Book is not reported for this company.',
    nonPositiveReason: 'Book value is negative (liabilities exceed assets), so Price-to-Book is not meaningful.',
    caveat: 'Book value is an accounting figure. It understates businesses built on software, brands or people.',
  },
]);

/* ------------------------------------------------------------------ */
/* Derived ratios                                                      */
/* ------------------------------------------------------------------ */

const RATIOS = Object.freeze([
  {
    id: 'evEbitda', label: 'EV / EBITDA', unit: 'ratio',
    formula: 'EV / EBITDA = Enterprise value ÷ EBITDA',
    numerator: { key: 'enterpriseValue', name: 'Enterprise value', basis: 'market' },
    denominator: { key: 'ebitda', name: 'EBITDA', basis: 'statement' },
    numeratorMustBePositive: 'Enterprise value is zero or negative (cash exceeds market value plus debt), so the multiple is not meaningful.',
    denominatorReason: 'EBITDA is zero or negative, so the multiple is not meaningful.',
    caveat: 'Thresholds are absolute and lean towards value: fast-growing companies often trade well above 25.',
    dependsOn: ['enterpriseValue', 'ebitda'],
  },
  {
    id: 'operatingMargin', label: 'Operating margin', unit: 'pct',
    formula: 'Operating margin = Operating income ÷ Revenue',
    numerator: { key: 'operatingIncome', name: 'Operating income', basis: 'statement' },
    denominator: { key: 'totalRevenue', name: 'Revenue', basis: 'statement' },
    denominatorReason: 'Revenue is zero or negative, so a margin cannot be calculated.',
    caveat: 'Margins differ widely by industry; compare with similar businesses.',
    dependsOn: ['operatingIncome'],
  },
  {
    id: 'netMargin', label: 'Net margin', unit: 'pct',
    formula: 'Net margin = Net income ÷ Revenue',
    numerator: { key: 'netIncome', name: 'Net income', basis: 'statement' },
    denominator: { key: 'totalRevenue', name: 'Revenue', basis: 'statement' },
    denominatorReason: 'Revenue is zero or negative, so a margin cannot be calculated.',
    caveat: 'Net income includes one-off items such as asset sales or write-downs.',
    dependsOn: [],
  },
  {
    id: 'fcfYield', label: 'FCF yield', unit: 'pct',
    formula: 'FCF yield = Free cash flow ÷ Market capitalisation',
    numerator: { key: 'freeCashFlow', name: 'Free cash flow', basis: 'statement' },
    denominator: { key: 'marketCap', name: 'Market capitalisation', basis: 'market' },
    denominatorReason: 'Market capitalisation is not positive, so a yield cannot be calculated.',
    caveat: 'Heavy investment years depress free cash flow; look at several years before judging.',
    dependsOn: ['freeCashFlow', 'marketCap'],
  },
  {
    id: 'debtToEquity', label: 'Debt / Equity', unit: 'ratio',
    formula: 'Debt / Equity = Total debt ÷ Shareholders\' equity',
    numerator: { key: 'totalDebt', name: 'Total debt', basis: 'statement' },
    denominator: { key: 'totalEquity', name: 'Shareholders\' equity', basis: 'statement' },
    denominatorReason: 'Shareholders\' equity is zero or negative, so the ratio is not meaningful. Negative equity is itself a warning sign.',
    caveat: 'Large share buybacks shrink equity and can make a healthy company look heavily indebted.',
    dependsOn: ['totalDebt'],
  },
  {
    id: 'gearing', label: 'Gearing (debt / assets)', unit: 'pct',
    formula: 'Gearing = Total debt ÷ Total assets',
    numerator: { key: 'totalDebt', name: 'Total debt', basis: 'statement' },
    denominator: { key: 'totalAssets', name: 'Total assets', basis: 'statement' },
    denominatorReason: 'Total assets are not positive, so gearing cannot be calculated.',
    caveat: 'For Singapore REITs the regulator (MAS) caps aggregate leverage at 50%. This simple ratio approximates the official figure.',
    dependsOn: ['totalDebt'],
  },
]);

function buildRatio(ctx, def) {
  const { id, label, unit, formula, numerator, denominator } = def;
  const base = { id, label, unit, formula, dependsOn: def.dependsOn };
  const blocked = profileBlock(ctx, id);
  if (blocked) return notAvailable({ ...base, reason: blocked });

  const top = ctx.fundamentals[numerator.key];
  const bottom = ctx.fundamentals[denominator.key];
  const topCurrency = currencyOf(ctx, numerator.basis);
  const bottomCurrency = currencyOf(ctx, denominator.basis);
  const rawInputs = [
    input(numerator.name, top, topCurrency, sourceOf(ctx, numerator.key), ctx.asOf),
    input(denominator.name, bottom, bottomCurrency, sourceOf(ctx, denominator.key), ctx.asOf),
  ];
  const missing = [];
  if (!isNum(top)) missing.push(numerator.name);
  if (!isNum(bottom)) missing.push(denominator.name);
  if (missing.length) {
    return notAvailable({ ...base, rawInputs, reason: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not reported, so ${label} cannot be calculated.` });
  }
  if (def.numeratorMustBePositive && top <= 0) return notAvailable({ ...base, rawInputs, reason: def.numeratorMustBePositive });
  if (bottom <= 0) return notAvailable({ ...base, rawInputs, reason: def.denominatorReason });

  // Bring the numerator into the denominator's currency when they differ.
  const steps = [];
  let comparableTop = top;
  if (topCurrency !== bottomCurrency) {
    comparableTop = convertCurrency(top, topCurrency, bottomCurrency, ctx.fxRate);
    if (comparableTop === null) {
      return notAvailable({
        ...base, rawInputs,
        reason: `${numerator.name} is in ${topCurrency} but ${denominator.name} is in ${bottomCurrency}, and only USD/SGD conversion is supported.`,
      });
    }
    rawInputs.push(input('USD/SGD rate', ctx.fxRate, 'SGD per USD', 'snapshot or live reference rate'));
    steps.push(step(`Convert ${numerator.name} from ${topCurrency} to ${bottomCurrency}`, `${fmtN(top)} ${topCurrency} at ${fmtN(ctx.fxRate)}`, comparableTop));
  }

  const value = safeDiv(comparableTop, bottom);
  if (value === null) return notAvailable({ ...base, rawInputs, reason: def.denominatorReason });
  steps.push(step(`Divide ${numerator.name} by ${denominator.name}`, `${fmtN(comparableTop)} ÷ ${fmtN(bottom)}`, unit === 'pct' ? fmtPct(value) : value));

  const scoring = scoreMetric(ctx, id, value, unit);
  return traced({
    ...base, value, tone: scoring.tone, meta: scoring.meta, rawInputs,
    steps: [...steps, ...scoring.steps],
    interpretation: interpretation(`${label} is ${formatByUnit(value, unit)}. ${scoring.sentence}`.trim(), scoring.thresholds, def.caveat),
  });
}

function buildRoe(ctx) {
  const id = 'roe';
  const label = 'Return on Equity';
  const formula = 'ROE = Net income ÷ Shareholders\' equity';
  const base = { id, label, unit: 'pct', formula };
  const blocked = profileBlock(ctx, id);
  if (blocked) return notAvailable({ ...base, reason: blocked });

  const reported = ctx.fundamentals.returnOnEquity;
  const netIncome = ctx.fundamentals.netIncome;
  const equity = ctx.fundamentals.totalEquity;
  const currency = ctx.financialCurrency;
  const rawInputs = [
    input('ROE reported by the data provider', reported, 'fraction', sourceOf(ctx, 'returnOnEquity'), ctx.asOf),
    input('Net income', netIncome, currency, sourceOf(ctx, 'netIncome'), ctx.asOf),
    input('Shareholders\' equity (latest balance sheet)', equity, currency, sourceOf(ctx, 'totalEquity'), ctx.asOf),
  ];
  if (isNum(equity) && equity <= 0) {
    return notAvailable({ ...base, rawInputs, reason: 'Shareholders\' equity is zero or negative, so ROE is not meaningful. Negative equity is itself a warning sign.' });
  }
  const computed = isNum(netIncome) && isNum(equity) ? safeDiv(netIncome, equity) : null;
  let value;
  let steps;
  let origin;
  if (isNum(reported)) {
    value = reported;
    origin = 'reported';
    steps = [step('Read the ROE reported by the data provider (net income ÷ average equity)', 'fundamentals.returnOnEquity', fmtPct(reported))];
    if (computed !== null) {
      steps.push(step('Cross-check: net income ÷ latest equity', `${fmtN(netIncome)} ÷ ${fmtN(equity)}`, fmtPct(computed)));
    }
  } else if (computed !== null) {
    value = computed;
    origin = 'computed';
    steps = [
      step('The data provider reports no ROE, so it is calculated from the statements', 'fundamentals.returnOnEquity is empty', 'Calculate'),
      step('Net income ÷ shareholders\' equity', `${fmtN(netIncome)} ÷ ${fmtN(equity)}`, fmtPct(computed)),
    ];
  } else {
    return notAvailable({ ...base, rawInputs, reason: 'ROE is not reported and cannot be calculated because net income or equity is missing.' });
  }
  const scoring = scoreMetric(ctx, id, value, 'pct');
  return traced({
    ...base, value, tone: scoring.tone, meta: { ...scoring.meta, origin }, rawInputs,
    steps: [...steps, ...scoring.steps],
    interpretation: interpretation(
      `Each ${currency} 1 of shareholders' capital earned about ${fmtN(value, 2)} of profit (${fmtPct(value)}). ${scoring.sentence}`.trim(),
      scoring.thresholds,
      origin === 'computed'
        ? 'Calculated with the latest equity rather than the yearly average, so it can differ slightly from published figures.'
        : 'A very high ROE can come from heavy debt or buybacks shrinking equity rather than from a better business.',
    ),
  });
}

function buildDividendYield(ctx) {
  const id = 'dividendYield';
  const label = 'Dividend yield (TTM)';
  const formula = 'Dividend yield = Dividends per share paid in the last twelve months ÷ Latest close';
  const base = { id, label, unit: 'pct', formula };
  const blocked = profileBlock(ctx, id);
  if (blocked) return notAvailable({ ...base, reason: blocked });
  const value = ctx.fundamentals.dividendYieldTTM;
  if (!isNum(value) || value < 0) {
    return notAvailable({ ...base, reason: 'Dividend history is not available for this asset.' });
  }
  const perShare = value * ctx.price;
  const scoring = scoreMetric(ctx, id, value, 'pct');
  return traced({
    ...base, value, tone: scoring.tone, meta: scoring.meta,
    rawInputs: [
      input('Trailing twelve-month yield', value, 'fraction', 'snapshot.fundamentals.dividendYieldTTM (computed by the data pipeline from Yahoo dividend history)', ctx.asOf),
      input('Latest close', ctx.price, ctx.currency, 'last candle', ctx.asOf),
    ],
    steps: [
      step('Dividends per share paid over the last twelve months (yield × price)', `${fmtPct(value, 3)} × ${fmtN(ctx.price)}`, perShare),
      step('Divide by the latest close', `${fmtN(perShare)} ÷ ${fmtN(ctx.price)}`, fmtPct(value)),
      ...scoring.steps,
    ],
    interpretation: interpretation(
      value === 0
        ? `No dividends were paid in the last twelve months. ${scoring.sentence}`.trim()
        : `Holding for the past year paid about ${fmtPct(value)} of today's price in dividends. ${scoring.sentence}`.trim(),
      scoring.thresholds,
      'Past dividends are not guaranteed. A very high yield often signals that the market expects a cut.',
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Fundamental score                                                   */
/* ------------------------------------------------------------------ */

function buildFundamentalScore(ctx, metrics) {
  const profile = PROFILES[ctx.profile];
  const id = 'fundamentalScore';
  const label = 'Fundamental score';
  if (profile.scoring.length === 0) {
    return notAvailable({
      id, label, unit: 'score', meta: { profile: ctx.profile, coverage: 0 },
      formula: 'No fundamental score for this asset class',
      reason: 'Crypto assets have no earnings, balance sheet or cash flow to score. The verdict uses price behaviour only.',
    });
  }
  const components = profile.scoring.map((rule) => ({
    id: rule.id,
    label: metrics[rule.id].label,
    weight: rule.weight,
    score: metrics[rule.id].status === 'ok' ? metrics[rule.id].meta.subScore : null,
  }));
  const dependsOn = components.map((component) => component.id);
  const formula = `${profile.label} score = ${components.map((component) => `${component.label} × ${component.weight}%`).join(' + ')} (missing parts are dropped and the rest re-weighted)`;
  const rawInputs = components.map((component) => input(`${component.label} sub-score (weight ${component.weight}%)`, component.score, 'score', `fundamentalEngine: ${component.id}`, ctx.asOf));
  const result = weightedScore(components, MIN_COVERAGE);
  if (result.score === null) {
    return notAvailable({
      id, label, unit: 'score', formula, rawInputs, dependsOn, meta: { profile: ctx.profile, coverage: result.coverage, missing: result.missing },
      reason: `Only ${fmtPct(result.coverage, 0)} of the ${profile.label} score's inputs are available (${result.missing.join(', ')} missing); at least ${fmtPct(MIN_COVERAGE, 0)} is required.`,
    });
  }
  const strongest = [...result.parts].sort((a, b) => b.score - a.score)[0];
  const weakest = [...result.parts].sort((a, b) => a.score - b.score)[0];
  return traced({
    id, label, value: result.score, unit: 'score', tone: scoreTone(result.score),
    meta: { profile: ctx.profile, profileLabel: profile.label, coverage: result.coverage, parts: result.parts, missing: result.missing, period: ctx.period },
    formula, rawInputs,
    steps: [
      ...result.parts.map((part) => step(`${part.label}: sub-score × weight`, `${fmtN(part.score, 2)} × ${fmtPct(part.normalisedWeight, 1)}`, part.contribution)),
      step('Add the contributions', result.parts.map((part) => fmtN(part.contribution, 2)).join(' + '), result.score),
    ],
    interpretation: interpretation(
      `Scored as a ${profile.label.toLowerCase()} business. Strongest: ${strongest.label} (${fmtN(strongest.score, 0)}). Weakest: ${weakest.label} (${fmtN(weakest.score, 0)}).`,
      SCORE_THRESHOLDS,
      result.missing.length
        ? `Not available and left out: ${result.missing.join(', ')}. The remaining weights were scaled up to total 100%.`
        : 'Thresholds are absolute and lean towards value. A fast-growing company can score low on valuation and still be a good business.',
    ),
    dependsOn,
  });
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute every fundamental metric and the profile-specific score for one asset.
 *
 * @param {object} asset normalised asset from snapshotService
 * @param {{ fxRate?: number|null }} [options] USD->SGD rate, used only when the trading and reporting currencies differ
 * @returns {{ ticker:string, profile:string, profileLabel:string, period:string|null, metrics:Record<string, object>, scoredIds:string[] }}
 */
export function analyzeFundamentals(asset, { fxRate = null } = {}) {
  const profileKey = PROFILES[asset.scoringProfile] ? asset.scoringProfile : 'CORPORATE';
  const ctx = {
    profile: profileKey,
    fundamentals: asset.fundamentals,
    currency: asset.currency,
    financialCurrency: asset.financialCurrency,
    period: asset.fundamentalsPeriod,
    price: asset.quote.lastClose,
    asOf: asset.quote.asOf,
    fxRate,
  };

  const metrics = {};
  for (const def of REPORTED_AMOUNTS) metrics[def.id] = buildReportedAmount(ctx, def);
  for (const def of REPORTED_MULTIPLES) metrics[def.id] = buildReportedMultiple(ctx, def);
  for (const def of RATIOS) metrics[def.id] = buildRatio(ctx, def);
  metrics.roe = buildRoe(ctx);
  metrics.dividendYield = buildDividendYield(ctx);
  metrics.fundamentalScore = buildFundamentalScore(ctx, metrics);

  return {
    ticker: asset.ticker,
    profile: profileKey,
    profileLabel: PROFILES[profileKey].label,
    period: asset.fundamentalsPeriod,
    metrics,
    scoredIds: PROFILES[profileKey].scoring.map((rule) => rule.id),
  };
}
