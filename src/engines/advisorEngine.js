/**
 * advisorEngine.js: composite score, Buy / Hold / Sell verdict and confidence.
 *
 * Composite
 *   Stocks   0.5 × Technical + 0.5 × Fundamental
 *   Crypto, or a stock with no Fundamental score: Technical only
 *
 * Verdict bands    ≥ 65 BUY · 45 to < 65 HOLD · < 45 SELL
 *
 * Guardrails (each caps a BUY at HOLD and is shown as a step)
 *   1. Downtrend      close < SMA200 and MACD line < signal line
 *   2. Overheated     RSI > 80
 *   3. Weak business  Fundamental score < 30
 *
 * Confidence
 *   High    |Technical − Fundamental| ≤ 20 and data coverage ≥ 80%
 *   Medium  gap ≤ 35
 *   Low     anything else, or a Technical-only verdict
 *
 * The verdict is a rule-based educational signal. It is not financial advice.
 */

import { isNum, scoreTone } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, valueOf, fmtN, fmtPct,
} from '../core/derivationTracer.js';

// Asset classes that never have a Fundamental score, and how the trace explains it.
const NO_ACCOUNTS_REASON = Object.freeze({
  crypto: { subject: 'Crypto has', because: 'crypto has no earnings or balance sheet to assess', plural: 'crypto' },
  etf: { subject: 'An ETF has', because: 'an ETF is a basket of companies with no accounts of its own', plural: 'ETFs' },
  index: { subject: 'An index has', because: 'an index is a calculated level with no accounts', plural: 'indices' },
});

export const ADVISOR_CONFIG = Object.freeze({
  weights: Object.freeze({ technical: 0.5, fundamental: 0.5 }),
  bands: Object.freeze({ buy: 65, hold: 45 }),
  guardrails: Object.freeze({ rsiOverheated: 80, weakFundamentals: 30 }),
  confidence: Object.freeze({ highGap: 20, mediumGap: 35, highCoverage: 0.8 }),
});

export const VERDICTS = Object.freeze({ BUY: 'BUY', HOLD: 'HOLD', SELL: 'SELL' });
const DISCLAIMER = 'A rule-based educational signal, not financial advice. Use it as a starting point for your own research.';

/** Map a composite score to a verdict label. */
export function verdictForScore(score) {
  if (!isNum(score)) return null;
  if (score >= ADVISOR_CONFIG.bands.buy) return VERDICTS.BUY;
  if (score >= ADVISOR_CONFIG.bands.hold) return VERDICTS.HOLD;
  return VERDICTS.SELL;
}

function verdictTone(verdict) {
  if (verdict === VERDICTS.BUY) return 'healthy';
  if (verdict === VERDICTS.SELL) return 'risky';
  return 'neutral';
}

function buildComposite(asset, technicalScore, fundamentalScore) {
  const id = 'compositeScore';
  const label = 'Composite score';
  const { technical: wT, fundamental: wF } = ADVISOR_CONFIG.weights;
  const tech = valueOf(technicalScore);
  const fund = valueOf(fundamentalScore);
  const asOf = asset.quote.asOf;
  const rawInputs = [
    input('Technical score', tech, 'score', 'technicalEngine: technicalScore', asOf),
    input('Fundamental score', fund, 'score', 'fundamentalEngine: fundamentalScore', asOf),
  ];
  const dependsOn = ['technicalScore', 'fundamentalScore'];
  if (tech === null) {
    return notAvailable({
      id, label, unit: 'score', rawInputs, dependsOn, meta: { technicalOnly: false },
      formula: `Composite = ${wT} × Technical + ${wF} × Fundamental`,
      reason: 'The Technical score is not available, so no composite score or verdict can be formed.',
    });
  }
  if (fund === null) {
    const why = NO_ACCOUNTS_REASON[asset.assetClass] ?? null;
    return traced({
      id, label, value: tech, unit: 'score', tone: scoreTone(tech), meta: { technicalOnly: true }, rawInputs, dependsOn,
      formula: 'Composite = Technical score (no Fundamental score is available)',
      steps: [
        step(why ? `${why.subject} no fundamentals, so the composite is the Technical score alone` : 'The Fundamental score is unavailable, so the composite is the Technical score alone', 'Composite = Technical', tech),
      ],
      interpretation: interpretation(
        `The composite rests on price behaviour only${why ? `, because ${why.because}` : ''}.`,
        [threshold('65 – 100', 'BUY zone', 'healthy'), threshold('45 – 65', 'HOLD zone', 'neutral'), threshold('0 – 45', 'SELL zone', 'risky')],
        'With one source of evidence instead of two, confidence is always Low.',
      ),
    });
  }
  const value = wT * tech + wF * fund;
  return traced({
    id, label, value, unit: 'score', tone: scoreTone(value), meta: { technicalOnly: false }, rawInputs, dependsOn,
    formula: `Composite = ${wT} × Technical + ${wF} × Fundamental`,
    steps: [
      step('Technical half', `${wT} × ${fmtN(tech, 2)}`, wT * tech),
      step('Fundamental half', `${wF} × ${fmtN(fund, 2)}`, wF * fund),
      step('Add the halves', `${fmtN(wT * tech, 2)} + ${fmtN(wF * fund, 2)}`, value),
    ],
    interpretation: interpretation(
      `Price behaviour scores ${fmtN(tech, 0)} and the business scores ${fmtN(fund, 0)}, for a combined ${fmtN(value, 0)} out of 100.`,
      [threshold('65 – 100', 'BUY zone', 'healthy'), threshold('45 – 65', 'HOLD zone', 'neutral'), threshold('0 – 45', 'SELL zone', 'risky')],
      'Equal weights are a deliberate, simple choice: neither a great business in a falling market nor a hot chart on a weak business scores well.',
    ),
  });
}

function evaluateGuardrails(asset, technical, fundamental) {
  const metrics = technical.metrics;
  const close = asset.series.close[asset.series.close.length - 1];
  const sma200 = valueOf(metrics.sma200);
  const macd = metrics.macd.status === 'ok' ? metrics.macd.meta : null;
  const rsi = valueOf(metrics.rsi14);
  const fundScore = valueOf(fundamental.metrics.fundamentalScore);
  const { rsiOverheated, weakFundamentals } = ADVISOR_CONFIG.guardrails;

  const downtrendKnown = sma200 !== null && macd !== null;
  return [
    {
      id: 'downtrend',
      label: 'Downtrend guard',
      question: 'Is the close below the 200-day SMA while the MACD line is below its signal line?',
      expression: downtrendKnown ? `${fmtN(close)} < ${fmtN(sma200)} and ${fmtN(macd.line)} < ${fmtN(macd.signal)}` : 'SMA 200 or MACD is not available',
      evaluated: downtrendKnown,
      triggered: downtrendKnown && close < sma200 && macd.line < macd.signal,
      reason: 'the long-term trend is down and momentum is still falling',
    },
    {
      id: 'overheated',
      label: 'Overheated guard',
      question: `Is RSI above ${rsiOverheated}?`,
      expression: rsi !== null ? `${fmtN(rsi, 2)} > ${rsiOverheated}` : 'RSI is not available',
      evaluated: rsi !== null,
      triggered: rsi !== null && rsi > rsiOverheated,
      reason: 'the price is extremely overbought and prone to a pullback',
    },
    {
      id: 'weakFundamentals',
      label: 'Weak-business guard',
      question: `Is the Fundamental score below ${weakFundamentals}?`,
      expression: fundScore !== null ? `${fmtN(fundScore, 2)} < ${weakFundamentals}` : 'no Fundamental score for this asset',
      evaluated: fundScore !== null,
      triggered: fundScore !== null && fundScore < weakFundamentals,
      reason: 'the business scores poorly on quality and valuation',
    },
  ];
}

function buildVerdict(asset, composite, guardrails) {
  const id = 'verdict';
  const label = 'Verdict';
  const { buy, hold } = ADVISOR_CONFIG.bands;
  const formula = `Composite ≥ ${buy}: BUY; ${hold} to < ${buy}: HOLD; < ${hold}: SELL. Any triggered guardrail caps a BUY at HOLD.`;
  const dependsOn = ['compositeScore', 'sma200', 'macd', 'rsi14', 'fundamentalScore'];
  const score = valueOf(composite);
  if (score === null) {
    return notAvailable({ id, label, unit: 'label', formula, dependsOn, meta: { rawVerdict: null, capped: false }, reason: composite.naReason || 'No composite score is available.' });
  }
  const rawVerdict = verdictForScore(score);
  const triggered = guardrails.filter((guard) => guard.triggered);
  const capped = rawVerdict === VERDICTS.BUY && triggered.length > 0;
  const finalVerdict = capped ? VERDICTS.HOLD : rawVerdict;

  const guardSteps = guardrails.map((guard) => {
    let result;
    if (!guard.evaluated) result = 'Not evaluated';
    else if (!guard.triggered) result = 'No: passes';
    else if (rawVerdict === VERDICTS.BUY) result = 'Yes: BUY is capped at HOLD';
    else result = `Yes: triggered (no effect on a ${rawVerdict})`;
    return step(`${guard.label}. ${guard.question}`, guard.expression, result);
  });

  let summary;
  if (capped) {
    summary = `The score of ${fmtN(score, 0)} would be a BUY, but it is held back to HOLD because ${triggered.map((guard) => guard.reason).join(' and ')}.`;
  } else if (finalVerdict === VERDICTS.BUY) {
    summary = `A composite score of ${fmtN(score, 0)} clears the BUY threshold of ${buy} and no safety rule objects.`;
  } else if (finalVerdict === VERDICTS.HOLD) {
    summary = `A composite score of ${fmtN(score, 0)} is in the HOLD range (${hold} to ${buy}): not weak enough to exit, not strong enough to add.`;
  } else {
    summary = `A composite score of ${fmtN(score, 0)} is below ${hold}: the rules see more reasons to stay out than to be in.`;
  }

  return traced({
    id, label, value: finalVerdict, unit: 'label', tone: verdictTone(finalVerdict),
    meta: { rawVerdict, capped, triggered: triggered.map((guard) => guard.id), compositeScore: score },
    formula,
    rawInputs: [input('Composite score', score, 'score', 'advisorEngine: compositeScore', asset.quote.asOf)],
    steps: [
      step('Place the composite score in a band', `${fmtN(score, 2)} against ${hold} and ${buy}`, rawVerdict),
      ...guardSteps,
      step('Final verdict', capped ? `${rawVerdict} capped by ${triggered.map((guard) => guard.label.toLowerCase()).join(', ')}` : 'no cap applied', finalVerdict),
    ],
    interpretation: interpretation(
      summary,
      [
        threshold(`${buy} – 100`, 'BUY: new positions are sized in full', 'healthy'),
        threshold(`${hold} – ${buy}`, 'HOLD: new positions are sized at half', 'neutral'),
        threshold(`0 – ${hold}`, 'SELL: no new position is suggested', 'risky'),
      ],
      DISCLAIMER,
    ),
    dependsOn,
  });
}

function buildConfidence(asset, composite, technicalScore, fundamentalScore) {
  const id = 'confidence';
  const label = 'Confidence';
  const { highGap, mediumGap, highCoverage } = ADVISOR_CONFIG.confidence;
  const formula = `High: |Technical − Fundamental| ≤ ${highGap} and coverage ≥ ${fmtPct(highCoverage, 0)}; Medium: gap ≤ ${mediumGap}; otherwise Low. A Technical-only verdict is always Low.`;
  const dependsOn = ['technicalScore', 'fundamentalScore'];
  if (composite.status !== 'ok') {
    return notAvailable({ id, label, unit: 'label', formula, dependsOn, reason: 'There is no verdict to rate.' });
  }
  const tech = valueOf(technicalScore);
  const fund = valueOf(fundamentalScore);
  const techCoverage = isNum(technicalScore.meta.coverage) ? technicalScore.meta.coverage : 0;
  const thresholds = [
    threshold('High', 'Price and business agree, data complete', 'healthy'),
    threshold('Medium', 'Some disagreement or missing data', 'neutral'),
    threshold('Low', 'Evidence conflicts or is one-sided', 'caution'),
  ];
  const rawInputs = [
    input('Technical score', tech, 'score', 'technicalEngine: technicalScore', asset.quote.asOf),
    input('Fundamental score', fund, 'score', 'fundamentalEngine: fundamentalScore', asset.quote.asOf),
  ];

  if (fund === null) {
    return traced({
      id, label, value: 'Low', unit: 'label', tone: 'caution', meta: { gap: null, coverage: techCoverage, technicalOnly: true },
      formula, rawInputs, dependsOn,
      steps: [step('Is a Fundamental score available to confirm the Technical score?', 'Fundamental score is N/A', 'No: confidence is Low')],
      interpretation: interpretation(
        'The verdict rests on price behaviour alone, with nothing to confirm or contradict it.',
        thresholds,
        NO_ACCOUNTS_REASON[asset.assetClass] ? `This is always the case for ${NO_ACCOUNTS_REASON[asset.assetClass].plural}. Size positions accordingly.` : null,
      ),
    });
  }

  const fundCoverage = isNum(fundamentalScore.meta.coverage) ? fundamentalScore.meta.coverage : 0;
  const coverage = Math.min(techCoverage, fundCoverage);
  const gap = Math.abs(tech - fund);
  let value = 'Low';
  if (gap <= highGap && coverage >= highCoverage) value = 'High';
  else if (gap <= mediumGap) value = 'Medium';
  const tones = { High: 'healthy', Medium: 'neutral', Low: 'caution' };
  rawInputs.push(
    input('Technical data coverage', techCoverage, 'fraction', 'share of Technical inputs available'),
    input('Fundamental data coverage', fundCoverage, 'fraction', 'share of Fundamental inputs available'),
  );
  let summary;
  if (value === 'High') summary = 'Price behaviour and business quality tell the same story, and the data is complete.';
  else if (value === 'Medium') summary = gap <= highGap ? 'The two scores agree, but some inputs are missing.' : 'The two scores point the same general way but differ noticeably.';
  else summary = `Price behaviour and business quality disagree by ${fmtN(gap, 0)} points. One of them is likely to be wrong.`;
  return traced({
    id, label, value, unit: 'label', tone: tones[value], meta: { gap, coverage, technicalOnly: false },
    formula, rawInputs, dependsOn,
    steps: [
      step('Gap between the two scores', `|${fmtN(tech, 2)} − ${fmtN(fund, 2)}|`, gap),
      step('Data coverage: the lower of the two', `min(${fmtPct(techCoverage, 0)}, ${fmtPct(fundCoverage, 0)})`, fmtPct(coverage, 0)),
      step(`High needs a gap ≤ ${highGap} and coverage ≥ ${fmtPct(highCoverage, 0)}`, `${fmtN(gap, 2)} ≤ ${highGap} and ${fmtPct(coverage, 0)} ≥ ${fmtPct(highCoverage, 0)}`, gap <= highGap && coverage >= highCoverage ? 'Yes' : 'No'),
      step(`Medium needs a gap ≤ ${mediumGap}`, `${fmtN(gap, 2)} ≤ ${mediumGap}`, gap <= mediumGap ? 'Yes' : 'No'),
      step('Result', 'first rule that passes', value),
    ],
    interpretation: interpretation(summary, thresholds, 'Confidence describes how much the evidence agrees, not how likely the trade is to make money.'),
  });
}

/**
 * Combine the technical and fundamental analysis of one asset into a verdict.
 *
 * @param {object} args
 * @param {object} args.asset normalised asset
 * @param {object} args.technical result of analyzeTechnicals(asset)
 * @param {object} args.fundamental result of analyzeFundamentals(asset)
 * @returns {{ ticker:string, metrics:{compositeScore:object, verdict:object, confidence:object}, guardrails:object[], verdict:string|null }}
 */
export function advise({ asset, technical, fundamental }) {
  const technicalScore = technical.metrics.technicalScore;
  const fundamentalScore = fundamental.metrics.fundamentalScore;
  const compositeScore = buildComposite(asset, technicalScore, fundamentalScore);
  const guardrails = evaluateGuardrails(asset, technical, fundamental);
  const verdict = buildVerdict(asset, compositeScore, guardrails);
  const confidence = buildConfidence(asset, compositeScore, technicalScore, fundamentalScore);
  return {
    ticker: asset.ticker,
    metrics: { compositeScore, verdict, confidence },
    guardrails: guardrails.map(({ id, label, evaluated, triggered, reason }) => ({ id, label, evaluated, triggered, reason })),
    verdict: verdict.status === 'ok' ? verdict.value : null,
  };
}
