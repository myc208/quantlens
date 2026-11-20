/**
 * positionSizerEngine.js: turn a verdict into a risk-controlled stake size.
 *
 * Inputs: account equity A, risk per trade r, entry price E, ATR multiple m.
 *
 *   1. Stop            = E − m × ATR(14)
 *   2. Risk per unit R = E − Stop
 *   3. Risk budget B   = A × r            (converted to the asset's currency)
 *   4. Raw units       = B ÷ R
 *   5. Correlation haircut = 1 ÷ √(1 + (n − 1) × max(0, ρ̄))
 *        n = number of compared assets, ρ̄ = this asset's mean correlation with the others
 *   6. Verdict multiplier: BUY 1.0 · HOLD 0.5 · SELL 0
 *   7. Units = raw × haircut × multiplier, rounded DOWN to the lot size
 *   8. Cap: position value ≤ max position % of the account
 *   9. Outputs: units, position value, amount at risk, 2R target
 *
 * Why the haircut has that shape: n equally sized positions with average
 * pairwise correlation ρ̄ have combined risk proportional to √(n + n(n−1)ρ̄).
 * Scaling each by 1 ÷ √(1 + (n−1)ρ̄) brings that back to √n, the risk of n
 * independent positions. Three assets at ρ̄ = 0.8 are each cut to 62%.
 *
 * Account size and risk settings are held in memory only and never leave the page.
 */

import { isNum, safeDiv, floorToStep, convertCurrency } from '../core/precisionMath.js';
import {
  traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct,
} from '../core/derivationTracer.js';

export const SIZER_CONFIG = Object.freeze({
  verdictMultiplier: Object.freeze({ BUY: 1, HOLD: 0.5, SELL: 0 }),
  targetMultiple: 2,
  heat: Object.freeze({ healthy: 0.03, caution: 0.06 }),
});

/**
 * Size reduction that keeps the combined risk of correlated positions equal
 * to that of independent ones. Negative mean correlation is floored at zero:
 * the sizer never increases a position because of a hedge.
 */
export function correlationHaircut(comparedCount, meanCorrelation) {
  const n = Number.isInteger(comparedCount) && comparedCount >= 1 ? comparedCount : 1;
  const rho = isNum(meanCorrelation) ? Math.min(1, Math.max(0, meanCorrelation)) : 0;
  return { n, rho, factor: 1 / Math.sqrt(1 + (n - 1) * rho) };
}

const METRIC_SPECS = Object.freeze({
  riskBudget: { label: 'Risk budget', unit: 'currency', formula: 'Risk budget = Account equity × Risk per trade' },
  stopLoss: { label: 'Stop-loss level', unit: 'currency', formula: 'Stop = Entry − ATR multiple × ATR(14)' },
  riskPerUnit: { label: 'Risk per unit', unit: 'currency', formula: 'Risk per unit = Entry − Stop' },
  correlationHaircut: { label: 'Correlation haircut', unit: 'pct', formula: 'Haircut = 1 ÷ √(1 + (n − 1) × max(0, ρ̄))' },
  positionSize: { label: 'Suggested position size', unit: 'shares', formula: 'Units = (Risk budget ÷ Risk per unit) × Correlation haircut × Verdict multiplier, rounded down to the lot size and capped by the maximum position size' },
  positionValue: { label: 'Position value', unit: 'currency', formula: 'Position value = Units × Entry' },
  amountAtRisk: { label: 'Amount at risk', unit: 'currency', formula: 'Amount at risk = Units × Risk per unit' },
  target2R: { label: '2R target', unit: 'currency', formula: 'Target = Entry + 2 × Risk per unit' },
});

function unavailable(asset, reason) {
  const metrics = {};
  for (const [id, spec] of Object.entries(METRIC_SPECS)) {
    metrics[id] = notAvailable({ id, label: spec.label, unit: spec.unit, formula: spec.formula, reason });
  }
  return { ticker: asset.ticker, ok: false, metrics, summary: null };
}

/**
 * Size one position.
 *
 * @param {object} args
 * @param {object} args.asset normalised asset (ticker, currency, lotSize, assetClass, market, quote)
 * @param {number} args.entryPrice price in the asset's currency (live tick or last close)
 * @param {string} [args.entrySource] where the entry price came from, for the trace
 * @param {number|null} args.atr ATR(14) in the asset's currency
 * @param {string|null} args.verdict BUY | HOLD | SELL | null
 * @param {{equity:number, riskPct:number, atrMultiple:number, maxPositionPct:number}} args.account
 * @param {string} args.accountCurrency USD | SGD (the display currency)
 * @param {number|null} args.fxRate USD->SGD
 * @param {number} [args.comparedCount] number of assets being compared (1..3)
 * @param {number|null} [args.meanCorrelation] mean correlation of this asset with the others
 * @param {string[]} [args.correlationIds] ids of the pair metrics behind the mean, for drill-down
 */
export function sizePosition({
  asset, entryPrice, entrySource = 'last daily close', atr, verdict, account, accountCurrency, fxRate,
  comparedCount = 1, meanCorrelation = null, correlationIds = [],
}) {
  const assetCurrency = asset.currency;
  const unitName = asset.assetClass === 'crypto' ? 'coins' : 'shares';

  if (asset.assetClass === 'index') {
    return unavailable(asset, 'An index cannot be bought directly, so there is no position to size. To act on it, size a position in a fund that tracks it, such as an ETF.');
  }
  const lot = asset.lotSize;
  const asOf = asset.quote.asOf;

  if (!account || !isNum(account.equity) || account.equity <= 0 || !isNum(account.riskPct) || account.riskPct <= 0
    || !isNum(account.atrMultiple) || account.atrMultiple <= 0 || !isNum(account.maxPositionPct) || account.maxPositionPct <= 0) {
    return unavailable(asset, 'Enter an account size, risk per trade, ATR multiple and maximum position size to get a suggestion.');
  }
  if (!isNum(entryPrice) || entryPrice <= 0) return unavailable(asset, 'No valid entry price is available.');
  if (!isNum(atr) || atr <= 0) return unavailable(asset, 'ATR is not available, so a volatility-based stop cannot be placed.');
  if (!isNum(lot) || lot <= 0) return unavailable(asset, 'The lot size for this asset is not defined.');

  const equity = account.equity;
  const riskFraction = account.riskPct / 100;
  const multiple = account.atrMultiple;
  const capFraction = account.maxPositionPct / 100;

  const equityInAsset = convertCurrency(equity, accountCurrency, assetCurrency, fxRate);
  if (equityInAsset === null) {
    return unavailable(asset, `Your account is in ${accountCurrency} and ${asset.ticker} trades in ${assetCurrency}, but no exchange rate is available to convert between them.`);
  }
  const toAccount = (amount) => convertCurrency(amount, assetCurrency, accountCurrency, fxRate);
  const needsFx = accountCurrency !== assetCurrency;

  // Steps 1 and 2: stop and risk per unit.
  const stop = entryPrice - multiple * atr;
  if (stop <= 0) {
    return unavailable(asset, `A stop ${fmtN(multiple, 2)} ATR below the entry would be at or below zero. Reduce the ATR multiple for this asset.`);
  }
  const riskPerUnit = entryPrice - stop;

  // Step 3: risk budget.
  const budgetAccount = equity * riskFraction;
  const budgetAsset = equityInAsset * riskFraction;

  // Step 4: raw units.
  const rawUnits = safeDiv(budgetAsset, riskPerUnit);
  if (rawUnits === null) return unavailable(asset, 'Risk per unit is too small to size a position.');

  // Step 5: correlation haircut.
  const haircut = correlationHaircut(comparedCount, meanCorrelation);

  // Step 6: verdict multiplier.
  const hasVerdict = typeof verdict === 'string' && verdict in SIZER_CONFIG.verdictMultiplier;
  const multiplier = hasVerdict ? SIZER_CONFIG.verdictMultiplier[verdict] : 0;

  // Step 7: adjust and round down to a tradable lot.
  const adjustedUnits = rawUnits * haircut.factor * multiplier;
  const roundedUnits = floorToStep(adjustedUnits, lot);

  // Step 8: concentration cap.
  const capValue = equityInAsset * capFraction;
  const capUnits = floorToStep(capValue / entryPrice, lot);
  const capBinding = roundedUnits > capUnits;
  const units = capBinding ? capUnits : roundedUnits;

  // Step 9: outputs.
  const positionValueAsset = units * entryPrice;
  const positionValue = toAccount(positionValueAsset);
  const pctOfAccount = safeDiv(positionValue, equity);
  const amountAtRiskAsset = units * riskPerUnit;
  const amountAtRisk = toAccount(amountAtRiskAsset);
  const riskPctActual = safeDiv(amountAtRisk, equity);
  const target = entryPrice + SIZER_CONFIG.targetMultiple * riskPerUnit;

  let zeroReason = null;
  if (units === 0) {
    if (!hasVerdict) zeroReason = 'There is no verdict for this asset, so no new position is suggested.';
    else if (multiplier === 0) zeroReason = 'The verdict is SELL, so no new position is suggested.';
    else if (capUnits === 0) zeroReason = `One lot of ${fmtN(lot, 6)} ${unitName} costs ${fmtN(lot * entryPrice, 2)} ${assetCurrency}, which is more than your ${fmtN(account.maxPositionPct, 0)}% position limit (${fmtN(capValue, 2)} ${assetCurrency}).`;
    else zeroReason = `Your risk budget covers ${fmtN(adjustedUnits, 2)} ${unitName}, which is less than one tradable lot of ${fmtN(lot, 6)}.`;
  }

  const fxInput = needsFx ? [input('USD/SGD rate', fxRate, 'SGD per USD', 'live reference rate or snapshot')] : [];
  const fxNote = needsFx ? ` (${fmtN(budgetAccount, 2)} ${accountCurrency} at ${fmtN(fxRate)})` : '';

  /* ---------------- traced metrics ---------------- */

  const riskBudget = traced({
    id: 'riskBudget', ...METRIC_SPECS.riskBudget, value: budgetAccount,
    tone: account.riskPct <= 1 ? 'healthy' : account.riskPct <= 2 ? 'neutral' : 'caution',
    meta: { currency: accountCurrency, inAssetCurrency: budgetAsset, assetCurrency },
    rawInputs: [
      input('Account equity', equity, accountCurrency, 'your input (kept in memory only)'),
      input('Risk per trade', riskFraction, 'fraction', 'your input'),
      ...fxInput,
    ],
    steps: [
      step('Multiply the account by the risk percentage', `${fmtN(equity, 2)} × ${fmtPct(riskFraction)}`, budgetAccount),
      ...(needsFx ? [step(`Convert to ${assetCurrency}, the currency ${asset.ticker} trades in`, `${fmtN(budgetAccount, 2)} ${accountCurrency} at ${fmtN(fxRate)}`, budgetAsset)] : []),
    ],
    interpretation: interpretation(
      `If the stop is hit you intend to lose no more than about ${fmtN(budgetAccount, 2)} ${accountCurrency} (${fmtPct(riskFraction)} of the account).`,
      [threshold('Up to 1%', 'Conservative', 'healthy'), threshold('1% – 2%', 'Standard', 'neutral'), threshold('Above 2%', 'Aggressive', 'caution')],
      'At 1% per trade, ten losing trades in a row cost about 10% of the account. At 5% they cost about 40%.',
    ),
  });

  const stopLoss = traced({
    id: 'stopLoss', ...METRIC_SPECS.stopLoss, value: stop, tone: 'neutral', meta: { currency: assetCurrency },
    rawInputs: [
      input('Entry price', entryPrice, assetCurrency, entrySource, asOf),
      input('ATR (14)', atr, assetCurrency, 'technicalEngine: atr14', asOf),
      input('ATR multiple', multiple, '×', 'your input'),
    ],
    steps: [
      step('Stop distance: ATR multiple × ATR', `${fmtN(multiple, 2)} × ${fmtN(atr)}`, multiple * atr),
      step('Subtract it from the entry price', `${fmtN(entryPrice)} − ${fmtN(multiple * atr)}`, stop),
      step('Stop distance as a percentage of the entry', `${fmtN(multiple * atr)} ÷ ${fmtN(entryPrice)}`, fmtPct(safeDiv(multiple * atr, entryPrice))),
    ],
    interpretation: interpretation(
      `The stop sits ${fmtPct(safeDiv(riskPerUnit, entryPrice))} below the entry, about ${fmtN(multiple, 1)} typical days of movement away.`,
      [threshold('Below 1 ATR', 'Too tight: noise will hit it', 'risky'), threshold('1.5 – 3 ATR', 'Typical swing-trade range', 'healthy'), threshold('Above 3 ATR', 'Wide: small position, slow exit', 'caution')],
      'A stop is a plan, not a guarantee: prices can gap through it on news.',
    ),
    dependsOn: ['atr14'],
  });

  const riskPerUnitMetric = traced({
    id: 'riskPerUnit', ...METRIC_SPECS.riskPerUnit, value: riskPerUnit, tone: 'neutral', meta: { currency: assetCurrency },
    rawInputs: [input('Entry price', entryPrice, assetCurrency, entrySource, asOf), input('Stop-loss level', stop, assetCurrency, 'positionSizerEngine: stopLoss')],
    steps: [step('Entry minus stop', `${fmtN(entryPrice)} − ${fmtN(stop)}`, riskPerUnit)],
    interpretation: interpretation(`Each unit loses ${fmtN(riskPerUnit)} ${assetCurrency} if the stop is hit. This is "1R", the unit of risk for this trade.`, []),
    dependsOn: ['stopLoss'],
  });

  const haircutMetric = traced({
    id: 'correlationHaircut', ...METRIC_SPECS.correlationHaircut, value: haircut.factor,
    tone: haircut.factor >= 0.95 ? 'healthy' : haircut.factor >= 0.75 ? 'caution' : 'risky',
    meta: { n: haircut.n, meanCorrelation: isNum(meanCorrelation) ? meanCorrelation : null },
    rawInputs: [
      input('Assets being compared (n)', haircut.n, 'assets', 'your selection'),
      input(`Mean correlation of ${asset.ticker} with the others (ρ̄)`, isNum(meanCorrelation) ? meanCorrelation : null, 'ratio', 'correlationEngine'),
    ],
    steps: [
      step('Floor the mean correlation at zero (a hedge never increases size)', `max(0, ${fmtN(meanCorrelation)})`, haircut.rho),
      step('Variance multiplier of n correlated positions', `1 + (${haircut.n} − 1) × ${fmtN(haircut.rho)}`, 1 + (haircut.n - 1) * haircut.rho),
      step('Haircut: one over its square root', `1 ÷ √${fmtN(1 + (haircut.n - 1) * haircut.rho)}`, fmtPct(haircut.factor)),
    ],
    interpretation: interpretation(
      haircut.n <= 1 || !isNum(meanCorrelation)
        ? 'No reduction: there are no other compared assets with a measurable correlation.'
        : `Each position is sized at ${fmtPct(haircut.factor, 0)} of its stand-alone size, so that the ${haircut.n} positions together carry the risk of ${haircut.n} independent ones.`,
      [threshold('95% – 100%', 'Little or no overlap', 'healthy'), threshold('75% – 95%', 'Some overlap', 'caution'), threshold('Below 75%', 'Heavy overlap', 'risky')],
      'Correlations rise in sell-offs, so real overlap in a crisis is usually worse than the past year suggests.',
    ),
    dependsOn: correlationIds,
  });

  const positionSize = traced({
    id: 'positionSize', ...METRIC_SPECS.positionSize, value: units,
    tone: units === 0 ? 'caution' : verdict === 'BUY' ? 'healthy' : 'neutral',
    meta: { unitName, lotSize: lot, capBinding, rawUnits, adjustedUnits, verdict: hasVerdict ? verdict : null, zeroReason },
    rawInputs: [
      input('Account equity', equity, accountCurrency, 'your input (kept in memory only)'),
      input('Risk per trade', riskFraction, 'fraction', 'your input'),
      input('Entry price', entryPrice, assetCurrency, entrySource, asOf),
      input('ATR (14)', atr, assetCurrency, 'technicalEngine: atr14', asOf),
      input('ATR multiple', multiple, '×', 'your input'),
      input('Verdict', hasVerdict ? verdict : null, '', 'advisorEngine: verdict'),
      input('Lot size', lot, unitName, 'watchlist'),
      input('Maximum position size', capFraction, 'fraction of account', 'your input'),
      ...fxInput,
    ],
    steps: [
      step('1. Stop: entry minus ATR multiple × ATR', `${fmtN(entryPrice)} − ${fmtN(multiple, 2)} × ${fmtN(atr)}`, stop),
      step('2. Risk per unit: entry minus stop', `${fmtN(entryPrice)} − ${fmtN(stop)}`, riskPerUnit),
      step(`3. Risk budget in ${assetCurrency}: account × risk %`, `${fmtN(equity, 2)} × ${fmtPct(riskFraction)}${fxNote}`, budgetAsset),
      step('4. Raw units: risk budget ÷ risk per unit', `${fmtN(budgetAsset, 2)} ÷ ${fmtN(riskPerUnit)}`, rawUnits),
      step('5. Correlation haircut', `1 ÷ √(1 + (${haircut.n} − 1) × ${fmtN(haircut.rho)})`, fmtPct(haircut.factor)),
      step('6. Verdict multiplier (BUY 1, HOLD 0.5, SELL 0)', hasVerdict ? verdict : 'no verdict', multiplier),
      step(`7. Adjust, then round down to a lot of ${fmtN(lot, 6)}`, `${fmtN(rawUnits)} × ${fmtN(haircut.factor)} × ${multiplier} = ${fmtN(adjustedUnits)}`, roundedUnits),
      step(`8. Cap: position value at most ${fmtPct(capFraction, 0)} of the account`, `${fmtN(capValue, 2)} ÷ ${fmtN(entryPrice)} = at most ${fmtN(capUnits, 6)} ${unitName}`, capBinding ? `Cap applies: ${fmtN(capUnits, 6)}` : 'Within the cap'),
      step(`9. Suggested size in ${unitName}`, capBinding ? `min(${fmtN(roundedUnits, 6)}, ${fmtN(capUnits, 6)})` : fmtN(roundedUnits, 6), units),
    ],
    interpretation: interpretation(
      units === 0
        ? zeroReason
        : `${fmtN(units, 6)} ${unitName} costs about ${fmtN(positionValue, 2)} ${accountCurrency} (${fmtPct(pctOfAccount)} of the account) and would lose about ${fmtN(amountAtRisk, 2)} ${accountCurrency} (${fmtPct(riskPctActual)}) if the stop at ${fmtN(stop)} ${assetCurrency} is hit.${capBinding ? ' The size is limited by your maximum position cap, not by the stop distance.' : ''}`,
      [
        threshold('BUY', 'Full size', 'healthy'),
        threshold('HOLD', 'Half size', 'neutral'),
        threshold('SELL', 'No new position', 'risky'),
      ],
      asset.market === 'SG'
        ? 'SGX shares trade in board lots of 100. Some brokers also offer odd lots, usually with wider spreads. Fees and slippage are not included.'
        : 'Fees, slippage and taxes are not included. This is a sizing aid, not a recommendation to trade.',
    ),
    dependsOn: ['riskBudget', 'stopLoss', 'riskPerUnit', 'correlationHaircut', 'verdict', 'atr14'],
  });

  const positionValueMetric = traced({
    id: 'positionValue', ...METRIC_SPECS.positionValue, value: positionValue,
    tone: capBinding ? 'caution' : 'neutral',
    meta: { currency: accountCurrency, inAssetCurrency: positionValueAsset, assetCurrency, pctOfAccount, capBinding },
    rawInputs: [input('Units', units, unitName, 'positionSizerEngine: positionSize'), input('Entry price', entryPrice, assetCurrency, entrySource, asOf), ...fxInput],
    steps: [
      step('Units × entry price', `${fmtN(units, 6)} × ${fmtN(entryPrice)}`, positionValueAsset),
      ...(needsFx ? [step(`Convert to ${accountCurrency}`, `${fmtN(positionValueAsset, 2)} ${assetCurrency} at ${fmtN(fxRate)}`, positionValue)] : []),
      step('Share of the account', `${fmtN(positionValue, 2)} ÷ ${fmtN(equity, 2)}`, fmtPct(pctOfAccount)),
    ],
    interpretation: interpretation(
      `This position would use ${fmtPct(pctOfAccount)} of the account.`,
      [threshold(`Up to ${fmtPct(capFraction, 0)}`, 'Within your concentration limit', 'healthy')],
      capBinding ? 'The cap is binding: without it the stop distance alone would have allowed a larger position.' : null,
    ),
    dependsOn: ['positionSize'],
  });

  const amountAtRiskMetric = traced({
    id: 'amountAtRisk', ...METRIC_SPECS.amountAtRisk, value: amountAtRisk,
    tone: isNum(riskPctActual) && riskPctActual <= riskFraction + 1e-9 ? 'healthy' : 'caution',
    meta: { currency: accountCurrency, inAssetCurrency: amountAtRiskAsset, assetCurrency, pctOfAccount: riskPctActual },
    rawInputs: [input('Units', units, unitName, 'positionSizerEngine: positionSize'), input('Risk per unit', riskPerUnit, assetCurrency, 'positionSizerEngine: riskPerUnit'), ...fxInput],
    steps: [
      step('Units × risk per unit', `${fmtN(units, 6)} × ${fmtN(riskPerUnit)}`, amountAtRiskAsset),
      ...(needsFx ? [step(`Convert to ${accountCurrency}`, `${fmtN(amountAtRiskAsset, 2)} ${assetCurrency} at ${fmtN(fxRate)}`, amountAtRisk)] : []),
      step('Share of the account', `${fmtN(amountAtRisk, 2)} ÷ ${fmtN(equity, 2)}`, fmtPct(riskPctActual)),
    ],
    interpretation: interpretation(
      `If the stop is hit, the loss is about ${fmtN(amountAtRisk, 2)} ${accountCurrency}, or ${fmtPct(riskPctActual)} of the account (budget ${fmtPct(riskFraction)}).`,
      [threshold('At or below the budget', 'As planned', 'healthy')],
      'It is usually below the budget because of the haircut, the verdict multiplier and rounding down to whole lots.',
    ),
    dependsOn: ['positionSize', 'riskPerUnit'],
  });

  const target2R = traced({
    id: 'target2R', ...METRIC_SPECS.target2R, value: target, tone: 'neutral', meta: { currency: assetCurrency },
    rawInputs: [input('Entry price', entryPrice, assetCurrency, entrySource, asOf), input('Risk per unit (1R)', riskPerUnit, assetCurrency, 'positionSizerEngine: riskPerUnit')],
    steps: [
      step('Twice the risk per unit', `${SIZER_CONFIG.targetMultiple} × ${fmtN(riskPerUnit)}`, SIZER_CONFIG.targetMultiple * riskPerUnit),
      step('Add it to the entry price', `${fmtN(entryPrice)} + ${fmtN(SIZER_CONFIG.targetMultiple * riskPerUnit)}`, target),
    ],
    interpretation: interpretation(
      `A move to ${fmtN(target)} ${assetCurrency} (${fmtPct(safeDiv(target - entryPrice, entryPrice))} above entry) would gain twice what the stop risks.`,
      [],
      'With winners twice the size of losers, a strategy breaks even at a win rate of one in three, before costs.',
    ),
    dependsOn: ['riskPerUnit'],
  });

  return {
    ticker: asset.ticker,
    ok: true,
    metrics: {
      riskBudget, stopLoss, riskPerUnit: riskPerUnitMetric, correlationHaircut: haircutMetric,
      positionSize, positionValue: positionValueMetric, amountAtRisk: amountAtRiskMetric, target2R,
    },
    summary: {
      units, unitName, entryPrice, stop, target, riskPerUnit, assetCurrency, accountCurrency,
      positionValue, positionValueAsset, pctOfAccount, amountAtRisk, amountAtRiskAsset, riskPctActual,
      haircut: haircut.factor, multiplier, capBinding, zeroReason,
    },
  };
}

/**
 * Total risk across all sized positions ("portfolio heat").
 *
 * @param {object[]} sizings results of sizePosition
 * @param {{equity:number}} account
 * @param {string} accountCurrency
 */
export function portfolioHeat(sizings, account, accountCurrency) {
  const id = 'portfolioHeat';
  const label = 'Total risk (portfolio heat)';
  const formula = 'Portfolio heat = Sum of amounts at risk ÷ Account equity';
  const usable = (Array.isArray(sizings) ? sizings : []).filter((sizing) => sizing && sizing.ok && isNum(sizing.summary.amountAtRisk));
  if (!account || !isNum(account.equity) || account.equity <= 0 || usable.length === 0) {
    return notAvailable({ id, label, unit: 'pct', formula, reason: 'No positions could be sized, so there is no total risk to report.' });
  }
  const total = usable.reduce((running, sizing) => running + sizing.summary.amountAtRisk, 0);
  const value = safeDiv(total, account.equity);
  const { healthy, caution } = SIZER_CONFIG.heat;
  let tone = 'risky';
  if (value <= healthy) tone = 'healthy';
  else if (value <= caution) tone = 'caution';
  return traced({
    id, label, value, unit: 'pct', tone, meta: { total, currency: accountCurrency, positions: usable.length },
    formula,
    rawInputs: [
      ...usable.map((sizing) => input(`${sizing.ticker} amount at risk`, sizing.summary.amountAtRisk, accountCurrency, 'positionSizerEngine: amountAtRisk')),
      input('Account equity', account.equity, accountCurrency, 'your input (kept in memory only)'),
    ],
    steps: [
      step('Add the amounts at risk', usable.map((sizing) => fmtN(sizing.summary.amountAtRisk, 2)).join(' + '), total),
      step('Divide by the account equity', `${fmtN(total, 2)} ÷ ${fmtN(account.equity, 2)}`, fmtPct(value)),
    ],
    interpretation: interpretation(
      `If every stop were hit together you would lose about ${fmtN(total, 2)} ${accountCurrency}, or ${fmtPct(value)} of the account.`,
      [
        threshold(`Up to ${fmtPct(healthy, 0)}`, 'Comfortable', 'healthy'),
        threshold(`${fmtPct(healthy, 0)} – ${fmtPct(caution, 0)}`, 'Elevated', 'caution'),
        threshold(`Above ${fmtPct(caution, 0)}`, 'Heavy', 'risky'),
      ],
      'Stops being hit together is exactly what happens when positions are correlated, which is why the haircut exists.',
    ),
    dependsOn: [],
  });
}
