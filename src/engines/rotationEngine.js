/**
 * rotationEngine.js: which parts of the watchlist have been leading and which lagging (V3.3).
 *
 * Every tradable asset (indices are left out) gets two relative strengths, both from
 * factorEngine's relativeStrength over calendar days:
 *
 *   x  RS 3M  = (1 + asset return) ÷ (1 + benchmark return) − 1 over 91 days
 *   y  RS 1M  = the same over 30 days
 *
 * and falls in one of four quadrants:
 *
 *   Leading    RS 3M ≥ 0 and RS 1M ≥ 0    ahead over both spans
 *   Weakening  RS 3M ≥ 0 and RS 1M < 0    ahead over three months, behind over the last one
 *   Lagging    RS 3M < 0 and RS 1M < 0    behind over both spans
 *   Improving  RS 3M < 0 and RS 1M ≥ 0    behind over three months, ahead over the last one
 *
 * Benchmark, two ways:
 *   spx  (default) the S&P 500 in USD for every asset, so the whole watchlist sits on one
 *        scale. SGD prices are converted at each day's USD/SGD rate, so a stronger or
 *        weaker Singapore dollar is part of an SGX asset's result, as it is for a USD investor.
 *   own  each asset against its own market, exactly as the factor engine measures it: the
 *        S&P 500 for US and London listings, the STI for SGX, Bitcoin for crypto. Bitcoin
 *        has no benchmark of its own in this mode.
 *
 * Groups are a fixed map of the watchlist into eleven themes; a ticker that is not in the
 * map falls back to its Yahoo sector. Each group's position is the median of its members.
 *
 * A description of the past one and three months, not a signal: over 2022–2026 momentum
 * did not predict the next month on this watchlist (see the leaderboard's track record).
 */

import { isNum } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';
import { relativeStrength, benchmarkFor, FACTOR_CONFIG } from './factorEngine.js';

export const ROTATION_BENCHMARK = '^GSPC';
export const ROTATION_MODES = Object.freeze(['spx', 'own']);
export const ROTATION_GROUP_PREFIX = 'rotationGroup:';
export const QUADRANTS = Object.freeze(['Leading', 'Weakening', 'Lagging', 'Improving']);
const QUADRANT_TONES = Object.freeze({ Leading: 'healthy', Weakening: 'caution', Lagging: 'risky', Improving: 'neutral' });
const DAYS = Object.freeze({ m1: FACTOR_CONFIG.strengthDays.relativeStrength1m, m3: FACTOR_CONFIG.strengthDays.relativeStrength3m });
const BENCHMARK_NAMES = Object.freeze({ '^GSPC': 'the S&P 500', '^STI': 'the Straits Times Index', 'BTC-USD': 'Bitcoin' });

export const ROTATION_GROUPS = Object.freeze([
  Object.freeze({ id: 'tech', name: 'Tech & semis', tickers: Object.freeze(['SNDK', 'MU', 'AMD', 'ORCL', 'TSLA']) }),
  Object.freeze({ id: 'broad-us', name: 'Broad US', tickers: Object.freeze(['VOO', 'CSPX.L']) }),
  Object.freeze({ id: 'financials', name: 'Financials', tickers: Object.freeze(['BLK', 'BRK-B']) }),
  Object.freeze({ id: 'energy', name: 'Energy & uranium', tickers: Object.freeze(['XOM', 'CCJ']) }),
  Object.freeze({ id: 'metals', name: 'Gold & metals', tickers: Object.freeze(['NEM', 'WPM', 'BHP']) }),
  Object.freeze({ id: 'defensives', name: 'Defensives', tickers: Object.freeze(['WMT', 'LLY']) }),
  Object.freeze({ id: 'industrials', name: 'Industrials', tickers: Object.freeze(['CAT']) }),
  Object.freeze({ id: 'sg-banks', name: 'SG banks', tickers: Object.freeze(['D05.SI', 'U11.SI']) }),
  Object.freeze({ id: 'sg-reits', name: 'SG REITs', tickers: Object.freeze(['AJBU.SI', 'A17U.SI', 'J69U.SI']) }),
  Object.freeze({ id: 'sg-other', name: 'SG other', tickers: Object.freeze(['C6L.SI']) }),
  Object.freeze({ id: 'crypto', name: 'Crypto', tickers: Object.freeze(['BTC-USD', 'ETH-USD', 'AVAX-USD']) }),
]);

const GROUP_BY_TICKER = new Map(ROTATION_GROUPS.flatMap((group) => group.tickers.map((ticker) => [ticker, group])));

/** The quadrant of a pair of relative strengths, or null when either is missing. */
export function quadrantOf(rs1m, rs3m) {
  if (!isNum(rs1m) || !isNum(rs3m)) return null;
  if (rs3m >= 0) return rs1m >= 0 ? 'Leading' : 'Weakening';
  return rs1m >= 0 ? 'Improving' : 'Lagging';
}

/** Median of the numbers in a list (non-numbers ignored), or null. */
export function median(values) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The group of an asset: the fixed map first, then its Yahoo sector (with SG prefixed). */
export function groupFor(asset) {
  const mapped = GROUP_BY_TICKER.get(asset.ticker);
  if (mapped) return { id: mapped.id, name: mapped.name, source: 'map' };
  if (asset.assetClass === 'crypto') return { id: 'crypto', name: 'Crypto', source: 'class' };
  if (asset.assetClass === 'etf') return { id: 'funds', name: 'Funds', source: 'class' };
  const sector = asset.sector || 'Other';
  const name = asset.market === 'SG' ? `SG ${sector}` : sector;
  return { id: `sector-${slug(name)}`, name, source: 'sector' };
}

/** The USD/SGD rate on or before a date: the stored history, else today's rate. */
function fxOn(fx, iso) {
  const series = fx && fx.series;
  if (series && series.dates.length) {
    let low = 0;
    let high = series.dates.length - 1;
    if (iso <= series.dates[0]) return series.rates[0];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (series.dates[middle] <= iso) low = middle;
      else high = middle - 1;
    }
    return series.rates[low];
  }
  return fx && isNum(fx.rate) ? fx.rate : null;
}

/** An SGD price series in USD, at each day's rate (USD series are returned as they are). */
export function inUsd(asset, fx) {
  if (asset.currency === 'USD') return { series: asset.series, converted: false };
  if (asset.currency !== 'SGD') return null;
  const close = asset.series.dates.map((iso, i) => {
    const rate = fxOn(fx, iso);
    return isNum(rate) && rate > 0 ? asset.series.close[i] / rate : null;
  });
  if (close.some((value) => !isNum(value))) return null;
  return { series: { dates: asset.series.dates, close }, converted: true };
}

/**
 * One asset's rotation point against a benchmark.
 * @returns {{ ok:true, rs1m:object, rs3m:object, quadrant:string, benchmark:string, converted:boolean } | { ok:false, reason:string }}
 */
export function rotationPoint(asset, { mode, byTicker, fx }) {
  if (mode === 'own') {
    const ticker = benchmarkFor(asset);
    const bench = ticker ? byTicker[ticker] : null;
    if (!ticker) return { ok: false, reason: `${asset.ticker} is the benchmark of its own market, so it has no relative strength in this mode.` };
    if (!bench) return { ok: false, reason: `${ticker}, the benchmark for ${asset.ticker}, is not in the snapshot.` };
    const rs1m = relativeStrength(asset.series, bench.series, DAYS.m1);
    const rs3m = relativeStrength(asset.series, bench.series, DAYS.m3);
    if (!rs1m || !rs3m) return { ok: false, reason: `${asset.ticker} or ${ticker} has no close ${DAYS.m3} days before the latest one.` };
    return { ok: true, rs1m, rs3m, quadrant: quadrantOf(rs1m.value, rs3m.value), benchmark: ticker, converted: false, currency: asset.currency, benchCurrency: bench.currency };
  }
  const spx = byTicker[ROTATION_BENCHMARK];
  if (!spx) return { ok: false, reason: 'The S&P 500 is not in the snapshot.' };
  const usd = inUsd(asset, fx);
  if (!usd) return { ok: false, reason: `${asset.ticker} trades in ${asset.currency} and no USD/SGD rate is available to convert it.` };
  const rs1m = relativeStrength(usd.series, spx.series, DAYS.m1);
  const rs3m = relativeStrength(usd.series, spx.series, DAYS.m3);
  if (!rs1m || !rs3m) return { ok: false, reason: `${asset.ticker} or the S&P 500 has no close ${DAYS.m3} days before the latest one.` };
  return { ok: true, rs1m, rs3m, quadrant: quadrantOf(rs1m.value, rs3m.value), benchmark: ROTATION_BENCHMARK, converted: usd.converted, currency: 'USD', benchCurrency: 'USD' };
}

const QUADRANT_THRESHOLDS = [
  threshold('RS 3M ≥ 0, RS 1M ≥ 0', 'Leading: ahead over both spans', 'healthy'),
  threshold('RS 3M ≥ 0, RS 1M < 0', 'Weakening: ahead, but behind lately', 'caution'),
  threshold('RS 3M < 0, RS 1M ≥ 0', 'Improving: behind, but ahead lately', 'neutral'),
  threshold('RS 3M < 0, RS 1M < 0', 'Lagging: behind over both spans', 'risky'),
];
const CAVEAT = 'A description of the past one and three months, not a signal: over 2022–2026 momentum did not predict the next month on this watchlist. The one-month span sits inside the three-month one, so the two are not independent.';
const FORMULA = 'RS = (1 + asset return) ÷ (1 + benchmark return) − 1 over 30 days (RS 1M) and 91 days (RS 3M); quadrant from the signs of RS 3M and RS 1M';

function modeLabel(mode) {
  return mode === 'own' ? 'its own market' : 'the S&P 500 in USD';
}

/** One asset's rotation as a traced metric (id "rotation"). */
export function rotationMetric(asset, point, { mode, fx, group }) {
  const id = 'rotation';
  const label = `Rotation quadrant (vs ${modeLabel(mode)})`;
  if (!point.ok) return notAvailable({ id, label, unit: 'label', formula: FORMULA, reason: point.reason, meta: { mode, group } });
  const { rs1m, rs3m, benchmark, converted } = point;
  const benchName = BENCHMARK_NAMES[benchmark] ?? benchmark;
  const priceCurrency = converted ? 'USD' : asset.currency;
  const rawInputs = [
    input(`${asset.ticker} close${converted ? ' (in USD)' : ''}`, rs3m.start.close, priceCurrency, converted ? 'snapshot candles ÷ that day\'s USD/SGD' : 'snapshot candles', rs3m.start.date),
    input(`${asset.ticker} close${converted ? ' (in USD)' : ''}`, rs1m.start.close, priceCurrency, converted ? 'snapshot candles ÷ that day\'s USD/SGD' : 'snapshot candles', rs1m.start.date),
    input(`${asset.ticker} close${converted ? ' (in USD)' : ''}`, rs3m.end.close, priceCurrency, converted ? 'snapshot candles ÷ that day\'s USD/SGD' : 'snapshot candles', rs3m.end.date),
    input(`${benchmark} close`, rs3m.benchmarkStart.close, point.benchCurrency, 'snapshot candles', rs3m.benchmarkStart.date),
    input(`${benchmark} close`, rs1m.benchmarkStart.close, point.benchCurrency, 'snapshot candles', rs1m.benchmarkStart.date),
    input(`${benchmark} close`, rs3m.benchmarkEnd.close, point.benchCurrency, 'snapshot candles', rs3m.benchmarkEnd.date),
  ];
  if (converted) {
    rawInputs.push(input('USD/SGD at the 3-month start', fxOn(fx, rs3m.start.date), 'SGD per USD', 'snapshot FX history', rs3m.start.date));
    rawInputs.push(input('USD/SGD at the end', fxOn(fx, rs3m.end.date), 'SGD per USD', 'snapshot FX history', rs3m.end.date));
  }
  const steps = [];
  if (converted) steps.push(step(`Convert ${asset.ticker}'s SGD closes to USD at each day's rate`, 'USD close = SGD close ÷ USD/SGD', `${fmtN(rs3m.start.close)} → ${fmtN(rs3m.end.close)} USD over 3 months`));
  for (const [name, rs] of [['3 months', rs3m], ['1 month', rs1m]]) {
    steps.push(step(`${name}: ${asset.ticker} ${fmtPct(rs.assetReturn, 2)}, ${benchmark} ${fmtPct(rs.benchmarkReturn, 2)} (from ${rs.from})`,
      `(1 + ${fmtPct(rs.assetReturn, 2)}) ÷ (1 + ${fmtPct(rs.benchmarkReturn, 2)}) − 1`, fmtPct(rs.value, 2)));
  }
  steps.push(step('Quadrant from the signs of RS 3M and RS 1M', `RS 3M ${rs3m.value >= 0 ? '≥' : '<'} 0, RS 1M ${rs1m.value >= 0 ? '≥' : '<'} 0`, point.quadrant));
  const where = { Leading: 'ahead of', Weakening: 'ahead of', Lagging: 'behind', Improving: 'behind' }[point.quadrant];
  const lately = rs1m.value >= 0 ? 'ahead' : 'behind';
  return traced({
    id, label, value: point.quadrant, unit: 'label', tone: QUADRANT_TONES[point.quadrant],
    meta: { mode, quadrant: point.quadrant, rs1m: rs1m.value, rs3m: rs3m.value, benchmark, converted, group, asOf: rs3m.to },
    formula: FORMULA,
    rawInputs,
    steps,
    interpretation: interpretation(
      `${point.quadrant}: over three months ${asset.ticker} is ${where} ${benchName}${converted ? ' in USD' : ''} by ${fmtPct(Math.abs(rs3m.value), 1)}, and over the last month it is ${lately} by ${fmtPct(Math.abs(rs1m.value), 1)}.`,
      QUADRANT_THRESHOLDS,
      `${CAVEAT}${converted ? ' Converted at each day\'s USD/SGD rate, so the Singapore dollar\'s move is part of the result.' : ''}`,
    ),
    dependsOn: [],
  });
}

/** A group's median position as a traced metric (id "rotationGroup:<group id>"). */
function groupMetric(group, members, mode) {
  const id = `${ROTATION_GROUP_PREFIX}${group.id}`;
  const label = `Rotation: ${group.name}`;
  const usable = members.filter((member) => member.point.ok);
  const m1 = median(usable.map((member) => member.point.rs1m.value));
  const m3 = median(usable.map((member) => member.point.rs3m.value));
  const quadrant = quadrantOf(m1, m3);
  const meta = { mode, group, members: members.map((member) => ({ ticker: member.asset.ticker, quadrant: member.point.ok ? member.point.quadrant : null, rs1m: member.point.ok ? member.point.rs1m.value : null, rs3m: member.point.ok ? member.point.rs3m.value : null })), median1m: m1, median3m: m3, quadrant };
  if (!quadrant) {
    return notAvailable({ id, label, unit: 'label', formula: 'Group position = median RS 1M and median RS 3M of its members', meta,
      reason: `None of ${members.map((member) => member.asset.ticker).join(', ')} has a relative strength against ${modeLabel(mode)}.` });
  }
  const left = members.filter((member) => !member.point.ok).map((member) => member.asset.ticker);
  return traced({
    id, label, value: quadrant, unit: 'label', tone: QUADRANT_TONES[quadrant], meta,
    formula: 'Group position = median RS 1M and median RS 3M of its members; quadrant from their signs',
    rawInputs: usable.map((member) => input(`${member.asset.ticker} RS 3M · RS 1M`, `${fmtPct(member.point.rs3m.value, 1)} · ${fmtPct(member.point.rs1m.value, 1)}`, '', 'rotation (this view)', member.point.rs3m.to)),
    steps: [
      ...usable.map((member) => step(member.asset.ticker, `RS 3M ${fmtPct(member.point.rs3m.value, 2)} · RS 1M ${fmtPct(member.point.rs1m.value, 2)}`, member.point.quadrant)),
      step(`Median of ${usable.length} RS 3M values`, usable.map((member) => fmtPct(member.point.rs3m.value, 1)).join(', '), fmtPct(m3, 2)),
      step(`Median of ${usable.length} RS 1M values`, usable.map((member) => fmtPct(member.point.rs1m.value, 1)).join(', '), fmtPct(m1, 2)),
      step('Quadrant from the signs of the medians', `RS 3M ${m3 >= 0 ? '≥' : '<'} 0, RS 1M ${m1 >= 0 ? '≥' : '<'} 0`, quadrant),
    ],
    interpretation: interpretation(
      `${group.name} is ${quadrant.toLowerCase()} against ${modeLabel(mode)}: its typical member is ${fmtPct(Math.abs(m3), 1)} ${m3 >= 0 ? 'ahead' : 'behind'} over three months and ${fmtPct(Math.abs(m1), 1)} ${m1 >= 0 ? 'ahead' : 'behind'} over the last month.`,
      QUADRANT_THRESHOLDS,
      `${usable.length === 1 ? 'A group of one is just that asset. ' : ''}The median is the middle member, so one outlier cannot drag the group.${left.length ? ` Left out, with no relative strength: ${left.join(', ')}.` : ''} ${CAVEAT}`,
    ),
    dependsOn: [],
  });
}

/**
 * Every tradable asset and every group, against one benchmark.
 *
 * @param {object} args
 * @param {object[]} args.assets normalised assets (indices are skipped)
 * @param {Record<string, object>} args.byTicker
 * @param {'spx'|'own'} [args.mode]
 * @param {{ series:{dates:string[], rates:number[]}|null, rate:number|null }} [args.fx]
 */
export function analyzeRotation({ assets, byTicker, mode = 'spx', fx = null }) {
  const chosen = ROTATION_MODES.includes(mode) ? mode : 'spx';
  const tradables = (Array.isArray(assets) ? assets : []).filter((asset) => asset.assetClass !== 'index');
  const byTickerOut = {};
  const groupMembers = new Map();
  for (const asset of tradables) {
    const group = groupFor(asset);
    const point = rotationPoint(asset, { mode: chosen, byTicker, fx });
    const metric = rotationMetric(asset, point, { mode: chosen, fx, group });
    byTickerOut[asset.ticker] = { asset, group, point, metrics: { rotation: metric } };
    if (!groupMembers.has(group.id)) groupMembers.set(group.id, { group, members: [] });
    groupMembers.get(group.id).members.push({ asset, point });
  }
  // Groups in the map's order, then any sector fallbacks alphabetically.
  const order = new Map(ROTATION_GROUPS.map((group, index) => [group.id, index]));
  const groups = [...groupMembers.values()]
    .sort((a, b) => (order.get(a.group.id) ?? 99) - (order.get(b.group.id) ?? 99) || a.group.name.localeCompare(b.group.name))
    .map(({ group, members }) => ({ group, members: members.map((member) => member.asset.ticker), metric: groupMetric(group, members, chosen) }));
  const metrics = Object.fromEntries(groups.map((entry) => [entry.metric.id, entry.metric]));
  const asOf = Object.values(byTickerOut).map((entry) => (entry.point.ok ? entry.point.rs3m.to : null)).filter(Boolean).sort().at(-1) ?? null;
  return { mode: chosen, byTicker: byTickerOut, groups, metrics, asOf, benchmark: chosen === 'spx' ? ROTATION_BENCHMARK : null };
}
