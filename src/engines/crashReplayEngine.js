/**
 * crashReplayEngine.js: what the current mix would have done in past sell-offs (V3.3).
 *
 * Four windows, each from an S&P 500 closing high to its closing low, picked from the
 * index's own five-year history:
 *
 *   2022 rate-hike bear market   3 Jan 2022 → 12 Oct 2022   −25.4%
 *   Aug 2024 yen carry unwind    16 Jul 2024 → 5 Aug 2024    −8.5%
 *   2025 tariff shock            19 Feb 2025 → 8 Apr 2025   −18.9%
 *   Autumn 2026 sell-off         6 Oct 2026 → latest close   (ongoing)
 *
 * An open window (no end date) caps itself (V3.4): once the S&P 500 closes above the window's
 * opening high, the window ends at the lowest close between that high and the recovery, and
 * stops changing. Until then it runs to the latest close and is marked ongoing.
 *
 * Replay, for each window
 *   1. Buy the mix at the close on the first day, at the exact weights, and hold it:
 *      no rebalancing, no fees. Closes are dividend-adjusted.
 *   2. Every price is converted into the base currency at that day's USD/SGD rate, so the
 *      currency move is part of the result, as it is for the investor.
 *   3. The replay steps through every date on which any holding (or the S&P 500) traded;
 *      a holding that did not trade that day keeps its last close.
 *   4. Value_t = Σ wᵢ × Pᵢ,t ÷ Pᵢ,start;  return = Value_end − 1;  contribution of a
 *      holding = wᵢ × (Pᵢ,end ÷ Pᵢ,start − 1), and the contributions add up to the return.
 *   5. Maximum drawdown and the worst single step of that value path, and the S&P 500
 *      (^GSPC) replayed the same way in the same currency.
 *
 * Missing history is handled out loud: a holding with no price at the start of a window
 * (SNDK only trades from 13 Feb 2025) is left out of that window, the other weights are
 * scaled up in proportion to add to 100%, and the trace and the card say so.
 *
 * Pure functions with no DOM or network access. The work is small (at most 8 holdings ×
 * 4 windows × ~200 dates), so it runs on the main thread and main.js caches the result.
 */

import { isNum } from '../core/precisionMath.js';
import { traced, notAvailable, input, step, threshold, interpretation, fmtN, fmtPct } from '../core/derivationTracer.js';

export const REPLAY_BENCHMARK = '^GSPC';
export const REPLAY_PREFIX = 'replay:';

export const CRASH_WINDOWS = Object.freeze([
  Object.freeze({
    id: 'bear2022', name: '2022 rate-hike bear market', short: '2022 bear market', from: '2022-01-03', to: '2022-10-12', ongoing: false,
    context: 'The Fed raised rates from near zero to 3.00–3.25% between March and September to fight inflation that peaked at 9.1%. Bonds and growth stocks fell together.',
  }),
  Object.freeze({
    id: 'yen2024', name: 'Aug 2024 yen carry unwind', short: 'Aug 2024 yen unwind', from: '2024-07-16', to: '2024-08-05', ongoing: false,
    context: 'A Bank of Japan rate rise and a weak US jobs report forced traders who had borrowed cheaply in yen to sell. Japan\'s Nikkei fell 12% on 5 August, its worst day since 1987.',
  }),
  Object.freeze({
    id: 'tariff2025', name: '2025 tariff shock', short: '2025 tariff shock', from: '2025-02-19', to: '2025-04-08', ongoing: false,
    context: 'Tariff threats, then the 2 April tariff announcement, took the S&P 500 to the edge of a bear market before the 90-day pause on 9 April.',
  }),
  Object.freeze({
    id: 'autumn2026', name: 'Autumn 2026 sell-off', short: 'Autumn 2026', from: '2026-10-06', to: null, ongoing: true,
    context: 'The fall from the S&P 500\'s high of 6 October 2026.',
  }),
]);

export const REPLAY_METRIC_IDS = Object.freeze(CRASH_WINDOWS.map((window) => `${REPLAY_PREFIX}${window.id}`));

// The replay against the S&P 500, in percentage points of return.
const REPLAY_BANDS = Object.freeze({ better: 0.02, worse: -0.02, muchWorse: -0.1 });
const FORMULA = 'Value_t = Σ wᵢ × Pᵢ,t ÷ Pᵢ,start (prices in the base currency, last close carried forward); return = Value_end − 1';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Jan 2022" */
export function longDate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

const signed = (value, digits = 1) => (isNum(value) ? `${value >= 0 ? '+' : '−'}${fmtPct(Math.abs(value), digits)}` : 'N/A');
const points = (value) => `${fmtN(Math.abs(value) * 100, 1)} pts`;

/** Index of the last date on or before `iso`, or −1. */
function indexOnOrBefore(dates, iso) {
  if (!dates.length || iso < dates[0]) return -1;
  let low = 0;
  let high = dates.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (dates[middle] <= iso) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The USD/SGD rate on or before a date: the stored history, or today's rate when there is none. */
function fxOn(fx, iso) {
  if (fx.series) {
    const index = indexOnOrBefore(fx.series.dates, iso);
    return fx.series.rates[Math.max(0, index)];
  }
  return fx.rate;
}

function convertible(currency, baseCurrency) {
  return currency === baseCurrency || (['USD', 'SGD'].includes(currency) && ['USD', 'SGD'].includes(baseCurrency));
}

/** A close converted into the base currency on a date (USD → SGD multiplies by USD/SGD; SGD → USD divides). */
function toBase(close, currency, baseCurrency, fx, iso) {
  if (currency === baseCurrency) return close;
  const rate = fxOn(fx, iso);
  return currency === 'USD' ? close * rate : close / rate;
}

function seriesOf(asset) {
  return asset.longSeries && Array.isArray(asset.longSeries.dates) && asset.longSeries.dates.length ? asset.longSeries : asset.series;
}

/**
 * A window with its end date settled. A fixed window is returned as it is. An open one ends at
 * the lowest S&P 500 close between its high and the first close above that high, once there is
 * one (recovered), or runs to the latest close (ongoing).
 * @returns {{ to:string|null, ongoing:boolean, recovered:string|null }} merged into the window
 */
export function resolveWindow(window, benchmark) {
  if (window.to) return { ...window, ongoing: false, recovered: null };
  const series = benchmark ? seriesOf(benchmark) : null;
  const start = series ? indexOnOrBefore(series.dates, window.from) : -1;
  if (start < 0) return { ...window, to: null, ongoing: true, recovered: null };
  const peak = series.close[start];
  let trough = start;
  for (let i = start + 1; i < series.close.length; i += 1) {
    if (series.close[i] > peak) {
      return { ...window, to: series.dates[trough], ongoing: false, recovered: series.dates[i] };
    }
    if (series.close[i] < series.close[trough]) trough = i;
  }
  return { ...window, to: series.dates[series.dates.length - 1], ongoing: true, recovered: null };
}

/** The sentence an open window adds to its context: still falling, or recovered and capped. */
export function windowStatus(window) {
  if (window.recovered) return ` The S&P 500 closed above that high again on ${longDate(window.recovered)}, so the window ends at its lowest close before then, ${longDate(window.to)}.`;
  if (window.ongoing) return ' It has not ended, so it is replayed to the latest close and its figures change every day.';
  return '';
}

/** Return, maximum drawdown and worst step of a value path that starts at 1. */
export function pathStatistics(dates, values) {
  let peak = values[0];
  let peakDate = dates[0];
  let maxDrawdown = 0;
  let drawdown = { peak: dates[0], trough: dates[0] };
  let worst = null;
  for (let t = 1; t < values.length; t += 1) {
    const change = values[t] / values[t - 1] - 1;
    if (worst === null || change < worst.value) worst = { date: dates[t], value: change };
    if (values[t] > peak) {
      peak = values[t];
      peakDate = dates[t];
    }
    const fall = values[t] / peak - 1;
    if (fall < maxDrawdown) {
      maxDrawdown = fall;
      drawdown = { peak: peakDate, trough: dates[t] };
    }
  }
  return { totalReturn: values[values.length - 1] - 1, maxDrawdown, drawdown, worstDay: worst };
}

/**
 * Buy-and-hold replay of weighted holdings over one window.
 *
 * @param {object} args
 * @param {{ticker:string, weight:number, asset:object}[]} args.holdings weights as fractions (any positive scale works)
 * @param {object|null} args.benchmark the S&P 500 asset, or null
 * @param {'USD'|'SGD'} args.baseCurrency
 * @param {{ series:{dates:string[], rates:number[]}|null, rate:number|null }} args.fx USD/SGD
 * @param {{id:string, name:string, from:string, to:string|null, ongoing:boolean}} args.window
 */
export function replayWindow({ holdings, benchmark = null, baseCurrency, fx, window }) {
  const list = (Array.isArray(holdings) ? holdings : []).filter((entry) => entry && entry.asset && isNum(entry.weight) && entry.weight > 0);
  const total = list.reduce((sum, entry) => sum + entry.weight, 0);
  if (!list.length || !(total > 0)) return { ok: false, reason: 'Give at least one holding a weight above zero.' };
  const benchSeries = benchmark ? seriesOf(benchmark) : null;
  const lastDates = [...list.map((entry) => seriesOf(entry.asset).dates.at(-1)), ...(benchSeries ? [benchSeries.dates.at(-1)] : [])];
  const resolved = resolveWindow(window, benchmark);
  const to = resolved.to ?? lastDates.sort().at(-1);
  const from = window.from;
  if (!to || to <= from) return { ok: false, reason: `The stored history does not reach past ${longDate(from)}.` };
  const fxReady = Boolean(fx) && ((fx.series && fx.series.dates.length) || (isNum(fx.rate) && fx.rate > 0));

  // Which holdings have a price at the start, in a currency that can be converted.
  const included = [];
  const excluded = [];
  for (const entry of list) {
    const series = seriesOf(entry.asset);
    const { ticker, currency } = entry.asset;
    if (!convertible(currency, baseCurrency) || (currency !== baseCurrency && !fxReady)) {
      excluded.push({ ticker, weight: entry.weight / total, reason: 'currency', currency });
    } else if (indexOnOrBefore(series.dates, from) < 0) {
      excluded.push({ ticker, weight: entry.weight / total, reason: 'history', firstDate: series.dates[0] ?? null });
    } else {
      included.push({ ...entry, series });
    }
  }
  if (!included.length) {
    const why = excluded.map((item) => (item.reason === 'history' ? `${item.ticker} has no prices before ${longDate(item.firstDate)}` : `${item.ticker} trades in ${item.currency}`));
    return { ok: false, reason: `None of the holdings can be replayed from ${longDate(from)}: ${why.join('; ')}.`, excluded };
  }
  const coveredWeight = included.reduce((sum, entry) => sum + entry.weight, 0);
  const scale = total / coveredWeight; // > 1 when something was left out

  // The replay calendar: the start, then every date on which a holding or the benchmark traded.
  const calendar = new Set([from]);
  for (const series of [...included.map((entry) => entry.series), ...(benchSeries ? [benchSeries] : [])]) {
    for (let i = Math.max(0, indexOnOrBefore(series.dates, from)); i < series.dates.length && series.dates[i] <= to; i += 1) {
      if (series.dates[i] > from) calendar.add(series.dates[i]);
    }
  }
  const dates = [...calendar].sort();

  const pricePath = (asset, series) => dates.map((iso) => {
    const index = indexOnOrBefore(series.dates, iso);
    return index < 0 ? null : toBase(series.close[index], asset.currency, baseCurrency, fx, iso);
  });
  const rows = included.map((entry) => {
    const prices = pricePath(entry.asset, entry.series);
    const weight = entry.weight / coveredWeight; // scaled to 100% of what can be replayed
    const startIndex = indexOnOrBefore(entry.series.dates, from);
    const endIndex = indexOnOrBefore(entry.series.dates, to);
    const ownReturn = prices[prices.length - 1] / prices[0] - 1;
    return {
      ticker: entry.asset.ticker, currency: entry.asset.currency, weight, originalWeight: entry.weight / total, prices, ownReturn,
      contribution: weight * ownReturn,
      start: { date: entry.series.dates[startIndex], close: entry.series.close[startIndex] },
      end: { date: entry.series.dates[endIndex], close: entry.series.close[endIndex] },
    };
  });
  if (rows.some((row) => row.prices.some((price) => !isNum(price) || price <= 0))) {
    return { ok: false, reason: 'A price could not be converted into the base currency.' };
  }
  const values = dates.map((_, t) => rows.reduce((sum, row) => sum + row.weight * (row.prices[t] / row.prices[0]), 0));
  const stats = pathStatistics(dates, values);

  let bench = null;
  if (benchSeries && indexOnOrBefore(benchSeries.dates, from) >= 0 && convertible(benchmark.currency, baseCurrency)
    && (benchmark.currency === baseCurrency || fxReady)) {
    const prices = pricePath(benchmark, benchSeries);
    const path = prices.map((price) => price / prices[0]);
    bench = { ticker: benchmark.ticker, values: path, ...pathStatistics(dates, path) };
  }

  return {
    ok: true,
    window: { ...resolved, to },
    baseCurrency,
    fxMode: rows.some((row) => row.currency !== baseCurrency) || (bench && benchmark.currency !== baseCurrency) ? (fx.series ? 'history' : 'constant') : 'none',
    fx: fx && (fx.series || isNum(fx.rate)) ? { start: fxOn(fx, from), end: fxOn(fx, to) } : null,
    dates,
    values,
    rows,
    excluded,
    scale,
    ...stats,
    benchmark: bench,
    excess: bench ? stats.totalReturn - bench.totalReturn : null,
  };
}

/** The sentence that says what was left out and how the rest was rescaled. */
export function rescaleNote(replay) {
  if (!replay.excluded || !replay.excluded.length) return '';
  const names = replay.excluded.map((item) => (item.reason === 'history'
    ? `${item.ticker} (${fmtPct(item.weight, 0)}) has no prices before ${longDate(item.firstDate)}`
    : `${item.ticker} (${fmtPct(item.weight, 0)}) trades in ${item.currency}, which cannot be converted`));
  return `${names.join('; ')}, so it is left out of this window and the other weights are scaled up ×${fmtN(replay.scale, 2)} to add to 100%.`;
}

function toneFor(excess) {
  if (!isNum(excess)) return 'neutral';
  if (excess >= REPLAY_BANDS.better) return 'healthy';
  if (excess > REPLAY_BANDS.worse) return 'neutral';
  return excess > REPLAY_BANDS.muchWorse ? 'caution' : 'risky';
}

/** One window's replay as a traced metric. */
export function replayMetric(replay, window, baseCurrency) {
  const id = `${REPLAY_PREFIX}${window.id}`;
  const label = `Crash replay: ${window.name}`;
  if (!replay.ok) return notAvailable({ id, label, unit: 'pct', formula: FORMULA, reason: replay.reason, meta: { window } });
  const end = replay.window.to;
  const { ongoing } = replay.window;
  const bench = replay.benchmark;
  const fxNote = replay.fxMode === 'history'
    ? ` Prices are converted to ${baseCurrency} at each day's USD/SGD rate (${fmtN(replay.fx.start)} at the start, ${fmtN(replay.fx.end)} at the end), so the currency move is included.`
    : replay.fxMode === 'constant' ? ` No USD/SGD history is stored, so today's rate converts every day and the currency move is not included.` : '';
  const rescale = rescaleNote(replay);
  const comparison = bench
    ? ` against ${signed(bench.totalReturn)} for the S&P 500 in ${baseCurrency}: ${points(replay.excess)} ${replay.excess >= 0 ? 'better' : 'worse'}`
    : ', with no S&P 500 history to compare against';

  const rawInputs = [
    input('Window start (S&P 500 closing high)', window.from, 'date', 'crashReplayEngine: CRASH_WINDOWS'),
    input(ongoing ? 'Window end (latest close, ongoing)' : 'Window end (S&P 500 closing low)', end, 'date',
      replay.window.recovered ? `the lowest close before the S&P 500 recovered its high on ${replay.window.recovered}` : 'crashReplayEngine: CRASH_WINDOWS'),
  ];
  for (const row of replay.rows) {
    rawInputs.push(input(`${row.ticker} weight in the replay`, row.weight, 'fraction', replay.excluded.length ? `your allocation, scaled ×${fmtN(replay.scale, 2)}` : 'your allocation'));
    rawInputs.push(input(`${row.ticker} close at the start`, row.start.close, row.currency, 'snapshot daily closes (5 years)', row.start.date));
    rawInputs.push(input(`${row.ticker} close at the end`, row.end.close, row.currency, 'snapshot daily closes (5 years)', row.end.date));
  }
  for (const item of replay.excluded) {
    rawInputs.push(input(`${item.ticker} weight (left out)`, item.weight, 'fraction', item.reason === 'history' ? `no prices before ${item.firstDate}` : `trades in ${item.currency}`));
  }
  if (replay.fxMode !== 'none' && replay.fx) {
    rawInputs.push(input('USD/SGD at the start', replay.fx.start, 'SGD per USD', replay.fxMode === 'history' ? 'snapshot FX history' : 'today\'s rate', window.from));
    rawInputs.push(input('USD/SGD at the end', replay.fx.end, 'SGD per USD', replay.fxMode === 'history' ? 'snapshot FX history' : 'today\'s rate', end));
  }

  const steps = [
    step('Window: from the S&P 500\'s closing high to its closing low', `${window.from} → ${end}${ongoing ? ' (latest close: the fall is ongoing)' : replay.window.recovered ? ` (capped: recovered on ${replay.window.recovered})` : ''}`, `${replay.dates.length - 1} trading dates replayed`),
  ];
  if (replay.excluded.length) {
    steps.push(step('Leave out holdings with no price at the start, and scale the rest to 100%',
      replay.excluded.map((item) => `${item.ticker} ${fmtPct(item.weight, 0)}`).join(', '), `×${fmtN(replay.scale, 4)}`));
  }
  for (const row of replay.rows) {
    const startBase = row.prices[0];
    const endBase = row.prices[row.prices.length - 1];
    steps.push(step(`${row.ticker}: ${baseCurrency} ${fmtN(startBase)} → ${fmtN(endBase)}, ${signed(row.ownReturn, 2)}, at weight ${fmtPct(row.weight, 1)}`,
      `${fmtPct(row.weight, 2)} × ${signed(row.ownReturn, 2)}`, signed(row.contribution, 2)));
  }
  steps.push(step('Add the contributions: the return of the mix', replay.rows.map((row) => signed(row.contribution, 2)).join(' '), signed(replay.totalReturn, 2)));
  steps.push(step('Deepest fall from a high along the way (maximum drawdown)', `high ${replay.drawdown.peak} → low ${replay.drawdown.trough}`, signed(replay.maxDrawdown, 2)));
  if (replay.worstDay) steps.push(step('Worst single trading date', replay.worstDay.date, signed(replay.worstDay.value, 2)));
  if (bench) {
    steps.push(step(`S&P 500 replayed the same way, in ${baseCurrency}`, `drawdown ${signed(bench.maxDrawdown, 2)} · worst date ${bench.worstDay ? `${bench.worstDay.date} ${signed(bench.worstDay.value, 2)}` : 'N/A'}`, signed(bench.totalReturn, 2)));
    steps.push(step('This mix against the S&P 500', `${signed(replay.totalReturn, 2)} − (${signed(bench.totalReturn, 2)})`, `${replay.excess >= 0 ? '+' : '−'}${points(replay.excess)}`));
  }

  return traced({
    id, label, value: replay.totalReturn, unit: 'pct', tone: toneFor(replay.excess),
    meta: {
      window: replay.window, baseCurrency, totalReturn: replay.totalReturn, maxDrawdown: replay.maxDrawdown, drawdown: replay.drawdown,
      worstDay: replay.worstDay, excess: replay.excess, scale: replay.scale, excluded: replay.excluded, fxMode: replay.fxMode,
      benchmark: bench ? { totalReturn: bench.totalReturn, maxDrawdown: bench.maxDrawdown, worstDay: bench.worstDay, drawdown: bench.drawdown } : null,
      holdings: replay.rows.map((row) => ({ ticker: row.ticker, weight: row.weight, originalWeight: row.originalWeight, ownReturn: row.ownReturn, contribution: row.contribution })),
      path: { dates: replay.dates, portfolio: replay.values, benchmark: bench ? bench.values : null },
      rescaleNote: rescale,
    },
    formula: FORMULA,
    rawInputs,
    steps,
    interpretation: interpretation(
      `Bought at the close on ${longDate(window.from)} and held to ${ongoing ? `the latest close (${longDate(end)})` : longDate(end)}, this mix returned ${signed(replay.totalReturn)} in ${baseCurrency}${comparison}. At its worst it was ${fmtPct(-replay.maxDrawdown, 1)} below its high${replay.worstDay ? `, and its worst day was ${signed(replay.worstDay.value)} on ${longDate(replay.worstDay.date)}` : ''}.${rescale ? ` ${rescale}` : ''}`,
      [
        threshold(`${points(REPLAY_BANDS.better)} or more better than the S&P 500`, 'Held up better than the market', 'healthy'),
        threshold(`Within ${points(REPLAY_BANDS.better)}`, 'Fell about as much as the market', 'neutral'),
        threshold(`${points(REPLAY_BANDS.worse)} to ${points(REPLAY_BANDS.muchWorse)} worse`, 'Fell more than the market', 'caution'),
        threshold(`More than ${points(REPLAY_BANDS.muchWorse)} worse`, 'Fell much more than the market', 'risky'),
      ],
      `${window.context}${windowStatus(replay.window)} Buy and hold at today's weights, with no rebalancing, fees or taxes; closes are dividend-adjusted. The windows were picked after the fact from the S&P 500's own highs and lows, so this shows how the mix behaved in those falls, not how it will behave in the next one. Markets close at different times: a holding that did not trade on a date keeps its last close, which can move the worst day by a session.${fxNote}`,
    ),
    dependsOn: [],
  });
}

/**
 * Every crash window for one allocation.
 *
 * @param {object} args
 * @param {{ticker:string, weight:number}[]} args.weights percentages or fractions
 * @param {Record<string, object>} args.byTicker normalised assets by ticker (with longSeries)
 * @param {'USD'|'SGD'} args.baseCurrency
 * @param {{ series:{dates:string[], rates:number[]}|null, rate:number|null }} args.fx USD/SGD
 * @returns {{ ok:boolean, reason?:string, replays:object[], metrics:Record<string, object> }}
 */
export function analyzeCrashReplays({ weights, byTicker, baseCurrency, fx }) {
  const holdings = (Array.isArray(weights) ? weights : [])
    .filter((entry) => entry && byTicker && byTicker[entry.ticker] && isNum(entry.weight) && entry.weight > 0)
    .map((entry) => ({ ticker: entry.ticker, weight: entry.weight, asset: byTicker[entry.ticker] }));
  const benchmark = byTicker ? byTicker[REPLAY_BENCHMARK] ?? null : null;
  const fxArgs = { series: fx && fx.series && Array.isArray(fx.series.dates) && fx.series.dates.length ? fx.series : null, rate: fx && isNum(fx.rate) ? fx.rate : null };
  const replays = [];
  const metrics = {};
  for (const window of CRASH_WINDOWS) {
    const replay = holdings.length
      ? replayWindow({ holdings, benchmark, baseCurrency, fx: fxArgs, window })
      : { ok: false, reason: 'Add at least one asset with a weight above zero.' };
    replays.push({ window, ...replay });
    metrics[`${REPLAY_PREFIX}${window.id}`] = replayMetric(replay, window, baseCurrency);
  }
  const reason = holdings.length ? null : 'Add at least one asset with a weight above zero.';
  return { ok: holdings.length > 0, reason, replays, metrics };
}

/** Total portfolio weight left out of a window, as a fraction (0 when everything was replayed). */
export function excludedShare(replay) {
  return replay && Array.isArray(replay.excluded) ? replay.excluded.reduce((sum, item) => sum + item.weight, 0) : 0;
}

