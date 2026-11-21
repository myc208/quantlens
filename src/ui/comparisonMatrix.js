/**
 * comparisonMatrix.js: the side-by-side comparison of up to three assets.
 *
 * Layout: one table with a sticky metric-label column and one column per
 * asset, in sections (Trend, Price, Period, Technical, Fundamental, News and
 * forecast), then the correlation card, then the position-sizing table.
 *
 * Time range: the price chart, the Period rows and the correlation card use
 * the series sliced to the selected range (1M / 3M / 6M / 1Y). The trend regime,
 * the Technical rows and the Fundamental rows never change with it.
 *
 * News and forecast are context only. Up to three recent, de-duplicated
 * headlines are listed with the tone of their wording; the 30-day Prophet
 * projection is drawn on the price chart as a dotted line inside its 80% band
 * and is always shown next to its own track record (how far it missed in its
 * last 30-day test, against simply assuming no change).
 *
 * Every value is a button. Clicking it dispatches openTrace(ticker, metricId),
 * and the derivation drawer shows that metric's formula, raw inputs and
 * step-by-step arithmetic, with its `dependsOn` children as drill-down links.
 * The matrix and the drawer never reference each other: they share only the
 * store and the traced metrics.
 *
 * Guided mode adds an explainer row under each metric (what it measures, why
 * it matters, healthy and risky readings). On phones explainers start
 * collapsed and open with the "i" button, as a full-width row.
 */

import { MAX_SELECTED, selectFx } from '../core/store.js';
import { isNum, safeDiv } from '../core/precisionMath.js';
import { pairId } from '../engines/correlationEngine.js';

const SECTIONS = Object.freeze([
  {
    id: 'trend',
    title: 'Trend',
    note: 'A description of the trend, with what followed it: not a forecast or advice',
    rows: [
      { id: 'trendRegime', lead: true },
      { id: 'regimeRecord', label: 'What followed (backtest)' },
      { id: 'scoreBacktest', label: 'Technical score track record', pro: true },
    ],
  },
  {
    id: 'price',
    title: 'Price',
    note: 'Crypto is live; stocks are the last daily close',
    rows: [
      { id: 'price', lead: true },
      { id: 'chart', kind: 'chart' },
    ],
  },
  {
    id: 'period',
    title: 'Period',
    note: (range) => `The last ${range.label} · follows the time range, unlike the scores below`,
    rows: [
      { id: 'periodReturn' },
      { id: 'periodVolatility' },
      { id: 'maxDrawdown' },
      { id: 'periodRange', meter: 'fraction' },
    ],
  },
  {
    id: 'risk',
    title: 'Risk',
    note: (range) => `From the actual returns of the last ${range.label}: no bell-curve assumption`,
    rows: [
      { id: 'ewmaVolatility' },
      { id: 'var95' },
      { id: 'cvar95' },
      { id: 'var99' },
      { id: 'cvar99', pro: true },
      { id: 'var95x10', pro: true },
      { id: 'cvar95x10', pro: true },
    ],
  },
  {
    id: 'market',
    title: 'Market sensitivity',
    note: 'Against each asset\'s benchmark: ^GSPC for US and London, ^STI for Singapore, BTC-USD for other coins',
    rows: [
      { id: 'beta' },
      { id: 'rSquared' },
      { id: 'idioVolatility' },
      { id: 'relativeStrength1m' },
      { id: 'relativeStrength3m' },
    ],
  },
  {
    id: 'liquidity',
    title: 'Liquidity',
    note: 'The last 20 sessions, whatever the time range',
    rows: [
      { id: 'dollarVolume' },
      { id: 'averageVolume' },
      { id: 'spreadEstimate' },
      { id: 'amihud', pro: true },
      { id: 'rangeSpread', pro: true },
    ],
  },
  {
    id: 'events',
    title: 'Events',
    note: 'Scheduled releases that can gap the price past a stop',
    rows: [
      { id: 'nextEarnings' },
      { id: 'earningsMove' },
      { id: 'nextExDividend' },
      { id: 'nextMacroEvent' },
    ],
  },
  {
    id: 'technical',
    title: 'Technical',
    note: 'Price behaviour, from a full year of completed daily candles',
    rows: [
      { id: 'technicalScore', lead: true, meter: 'score' },
      { id: 'rsi14', meter: 'score' },
      { id: 'macd' },
      { id: 'ema20' },
      { id: 'ema50' },
      { id: 'sma200' },
      { id: 'atrPct' },
      { id: 'range52w', meter: 'fraction' },
      { id: 'trendScore', pro: true, meter: 'score' },
      { id: 'macdScore', pro: true, meter: 'score' },
      { id: 'rsiScore', pro: true, meter: 'score' },
      { id: 'rangeScore', pro: true, meter: 'score' },
      { id: 'sma50', pro: true },
      { id: 'ema12', pro: true },
      { id: 'ema26', pro: true },
      { id: 'atr14', pro: true },
    ],
  },
  {
    id: 'fundamental',
    title: 'Fundamental',
    note: 'Business quality and valuation, scored by sector',
    rows: [
      { id: 'fundamentalScore', lead: true, meter: 'score' },
      { id: 'evEbitda' },
      { id: 'operatingMargin' },
      { id: 'netMargin' },
      { id: 'fcfYield' },
      { id: 'debtToEquity' },
      { id: 'gearing' },
      { id: 'roe' },
      { id: 'priceToBook' },
      { id: 'trailingPE' },
      { id: 'forwardPE' },
      { id: 'dividendYield' },
      { id: 'marketCap' },
      { id: 'enterpriseValue', pro: true },
      { id: 'ebitda', pro: true },
      { id: 'ebit', pro: true },
      { id: 'operatingIncome', pro: true },
      { id: 'totalDebt', pro: true },
      { id: 'freeCashFlow', pro: true },
    ],
  },
  {
    id: 'context',
    title: 'News and forecast',
    note: 'Context only: neither moves the trend regime or a score',
    rows: [
      { id: 'headlineTone' },
      { id: 'news', kind: 'news', label: 'Recent headlines' },
      { id: 'forecast30d' },
      { id: 'forecastBacktest', label: 'Forecast miss rate (30-day test)' },
    ],
  },
]);

const SIZING_SECTION = Object.freeze({
  id: 'sizing',
  rows: [
    { id: 'price', label: 'Entry price' },
    { id: 'stopLoss' },
    { id: 'target2R' },
    { id: 'correlationHaircut' },
    { id: 'positionSize', lead: true },
    { id: 'positionValue' },
    { id: 'amountAtRisk' },
    { id: 'positionVar95' },
    { id: 'positionCvar95', pro: true },
    { id: 'gapRisk' },
    { id: 'volumeShare' },
    { id: 'spreadCost' },
    { id: 'riskBudget', pro: true },
    { id: 'riskPerUnit', pro: true },
  ],
});

const PROFILE_CHIPS = Object.freeze({ CORPORATE: 'Corporate', FINANCIAL: 'Financial', REIT: 'REIT', ETF: 'ETF', INDEX: 'Index', CRYPTO: 'Crypto' });
const PROFILE_NAMES = Object.freeze({ CORPORATE: 'corporates', FINANCIAL: 'financial companies', REIT: 'REITs', ETF: 'ETFs', INDEX: 'indices', CRYPTO: 'crypto' });
const STORY_TONES = Object.freeze({ positive: 'healthy', neutral: 'neutral', negative: 'caution' });
const DAY_MS = 86400000;
const dayOf = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`);

export function mountComparisonMatrix(root, app) {
  const { store, actions, h } = app;
  const { esc } = h;

  // Explainers default to open on desktop and collapsed on phones (tap "i" to open one).
  const explainers = {
    defaultOpen: window.matchMedia('(min-width: 768px)').matches,
    overrides: new Map(),
  };

  /* ------------------------------------------------------------------ */
  /* Small builders                                                      */
  /* ------------------------------------------------------------------ */

  const whole = (value) => h.formatNumber(value, 0);
  const sub = (text) => `<span class="cell__sub">${esc(text)}</span>`;
  const domId = (key) => `exp-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`;

  function rowLabel(row) {
    if (row.kind === 'chart') return `Price, last ${h.rangeInfo().label}`;
    return row.label ?? app.explain(row.id).term;
  }

  function sectionNote(section, state) {
    return typeof section.note === 'function' ? section.note(h.rangeInfo(state.range)) : section.note;
  }

  const amount = (value, currency) => {
    const shown = h.money(value, currency);
    return `${shown.currency} ${h.formatAmount(shown.value)}`;
  };

  function visibleRows(section, state) {
    return section.rows.filter((row) => !row.pro || state.mode === 'pro');
  }

  function explainerOpen(key, state) {
    if (state.mode !== 'guided') return false;
    return explainers.overrides.has(key) ? explainers.overrides.get(key) : explainers.defaultOpen;
  }

  function meter(value, tone) {
    if (!isNum(value)) return '';
    const width = Math.min(100, Math.max(0, value));
    const modifier = tone && tone !== 'neutral' ? ` meter--${tone}` : '';
    return `<span class="meter${modifier}" aria-hidden="true"><span class="meter__fill" style="width:${width.toFixed(1)}%"></span></span>`;
  }

  function deltaMarkup(changePct) {
    if (!isNum(changePct)) return '';
    const direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
    const arrow = changePct > 0 ? '▲' : changePct < 0 ? '▼' : '■';
    const word = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'unchanged';
    return `<span class="delta delta--${direction}"><span aria-hidden="true">${arrow}</span><span class="sr-only">${word}</span> ${h.formatPercent(Math.abs(changePct), 2)}</span>`;
  }

  /** The secondary line under a value: context that makes the number readable at a glance. */
  function subLine(asset, metric, state, comparison) {
    if (metric.status !== 'ok') {
      // Guided mode spells the reason out in the cell. Pro keeps the badge only: the reason
      // is in the tooltip and in the drawer.
      return state.mode === 'guided' ? `<span class="cell__sub cell__sub--reason">${esc(metric.naReason)}</span>` : '';
    }
    const meta = metric.meta ?? {};
    const sizing = comparison.sizings[asset.ticker];
    const summary = sizing && sizing.ok ? sizing.summary : null;
    switch (metric.id) {
      case 'trendRegime': {
        const side = meta.above200 ? 'above' : 'below';
        return sub(`${h.formatPercent(Math.abs(meta.distance200), 1)} ${side} the 200-day average${isNum(meta.rsi) ? ` · RSI ${h.formatNumber(meta.rsi, 0)}` : ''}`);
      }
      case 'regimeRecord': {
        const own = meta.byLabel[meta.label];
        return sub(`After ${own.count} ${meta.label} days, ${meta.horizon} sessions ahead · ${h.signedPercent(meta.base.mean, 1)} on all ${meta.base.count} days`);
      }
      case 'price':
        return `<span class="cell__sub">${deltaMarkup(meta.changePct)} ${meta.live ? 'live' : `close ${esc(h.shortDate(asset.quote.asOf))}`}</span>`;
      case 'fundamentalScore':
        return sub(`${meta.profileLabel} profile${meta.period ? ` · ${meta.period}` : ''}`);
      case 'macd':
        return sub(`Line ${meta.line > meta.signal ? 'above' : 'below'} signal`);
      case 'roe':
        if (meta.scored && isNum(meta.subScore)) return scoreSub(meta, state, meta.origin === 'computed' ? ' · calculated' : '');
        return meta.origin === 'computed' ? sub('Calculated from statements') : '';
      case 'positionSize':
        if (meta.zeroReason) return `<span class="cell__sub cell__sub--reason">${esc(meta.zeroReason)}</span>`;
        return meta.capBinding ? sub('Limited by your position cap') : '';
      case 'positionValue':
      case 'amountAtRisk':
        return isNum(meta.pctOfAccount) ? sub(`${h.formatPercent(meta.pctOfAccount, 2)} of account`) : '';
      case 'stopLoss':
        return summary ? sub(`${h.formatPercent(safeDiv(summary.stop - summary.entryPrice, summary.entryPrice), 1)} from entry`) : '';
      case 'target2R':
        return summary ? sub(`+${h.formatPercent(safeDiv(summary.target - summary.entryPrice, summary.entryPrice), 1)} from entry`) : '';
      case 'correlationHaircut':
        return isNum(meta.meanCorrelation) ? sub(`Mean correlation ${h.formatNumber(meta.meanCorrelation, 2)}`) : sub('No overlap to adjust for');
      case 'riskBudget':
        return sub(`${h.formatNumber(state.account.riskPct, 2)}% of account`);
      case 'periodReturn':
        return meta.from ? sub(`${h.shortDate(meta.from, true)} to ${h.shortDate(meta.to)}`) : '';
      case 'periodVolatility':
        return isNum(meta.returns) ? sub(`From ${meta.returns} daily returns${meta.returns < 40 ? ' · rough' : ''}`) : '';
      case 'maxDrawdown':
        return metric.value < 0 ? sub(`${h.shortDate(meta.peakDate)} to ${h.shortDate(meta.troughDate)}`) : sub('No fall from a high');
      case 'nextMacroEvent':
        return `<span class="cell__sub${meta.within48h ? ' cell__sub--reason' : ''}">${meta.within48h ? '⚠ ' : ''}${esc(meta.title)} · ${esc(h.shortDate(meta.date))}${meta.insideSizing && !meta.within48h ? ' · inside the sizing horizon' : ''}</span>`;
      case 'averageVolume':
        return sub(`${meta.unitName} a day${meta.thin ? ` · ${meta.zeroDays} days without trades` : ''}`);
      case 'dollarVolume':
        return isNum(meta.usd) ? sub(`≈ US$${h.formatCompact(meta.usd)} a day`) : sub('a day');
      case 'spreadEstimate':
        return sub(`One tick of ${h.formatNumber(meta.tick, meta.tick < 0.01 ? 3 : 2)} ${meta.currency}`);
      case 'amihud':
        return sub('bps of price move per US$1M traded');
      case 'rangeSpread':
        return sub(isNum(meta.multipleOfTick) ? `${h.formatNumber(meta.multipleOfTick, meta.multipleOfTick < 10 ? 1 : 0)}× the one-tick floor · not used for costs` : 'Not used for costs');
      case 'volumeShare':
        return sub(meta.liquidityBinding ? `Capped at ${h.formatPercent(meta.capShare, 0)} of daily volume` : meta.flagged ? 'May move the price' : 'of an average day');
      case 'spreadCost':
        return isNum(meta.ofRisk) ? sub(`${h.formatPercent(meta.ofRisk, 1)} of the amount at risk`) : '';
      case 'beta':
        return sub(`${h.formatNumber(meta.low, 2)} to ${h.formatNumber(meta.high, 2)} · ${meta.observations} ${meta.frequency} returns${meta.rough ? ' · rough' : ''}`);
      case 'rSquared':
        return sub(`Correlation ${h.formatNumber(meta.correlation, 2)} with ${meta.benchmark}`);
      case 'idioVolatility':
        return sub(`Total ${h.formatPercent(meta.total, 0)} · ${h.formatPercent(meta.systematic, 0)} from ${meta.benchmark}`);
      case 'relativeStrength1m':
      case 'relativeStrength3m':
        return sub(`${h.signedPercent(meta.assetReturn, 1)} vs ${h.signedPercent(meta.benchmarkReturn, 1)} for ${meta.benchmark}`);
      case 'ewmaVolatility':
        return sub(`Equal-weighted ${h.formatPercent(meta.flat, 0)} · half-life ${h.formatNumber(meta.halfLifeDays, 0)} days`);
      case 'var95':
      case 'var99':
      case 'cvar95':
      case 'cvar99':
      case 'var95x10':
      case 'cvar95x10':
        return sub(`Loss · ${meta.tail} worst of ${meta.observations} ${meta.horizon === 1 ? 'days' : '10-day windows'}`);
      case 'positionVar95':
      case 'positionCvar95':
        return sub(`${h.formatPercent(meta.fraction, 1)} of the position · stop risks ${h.formatAmount(meta.amountAtRisk)}`);
      case 'periodRange':
        return sub(`Low ${h.formatAmount(h.money(meta.low, meta.currency).value)} · High ${h.formatAmount(h.money(meta.high, meta.currency).value)}`);
      case 'headlineTone':
        return sub(`${metric.value > 0 ? '+' : ''}${h.formatNumber(metric.value, 2)} on a −1 to +1 scale · ${meta.basis} stor${meta.basis === 1 ? 'y' : 'ies'}${meta.stale ? ' · old headlines' : ''}`);
      case 'forecast30d': {
        const earnings = app.trace(asset.ticker, 'nextEarnings');
        const warning = earnings && earnings.status === 'ok' && earnings.meta.insideForecast
          ? `<span class="cell__sub cell__sub--reason">⚠ Earnings ~${esc(h.shortDate(earnings.meta.date))} fall inside this window: the projection knows nothing about them</span>` : '';
        return sub(`≈ ${amount(meta.endPrice, meta.currency)} by ${h.shortDate(meta.endDate)} · 80% band ${h.signedPercent(meta.lowerChange, 0)} to ${h.signedPercent(meta.upperChange, 0)}${meta.stale ? ' · older run' : ''}`) + warning;
      }
      case 'nextEarnings': {
        const when = `~${h.shortDate(meta.date)}${meta.dateTo ? ` or ${h.shortDate(meta.dateTo)}` : ''}`;
        const timing = { 'before-open': 'before the open', 'during-session': 'in session', 'after-close': 'after the close', unknown: 'time unknown' }[meta.timing] ?? '';
        const scope = meta.insideSizing ? '⚠ inside the sizing horizon' : meta.insideForecast ? 'inside the 30-day projection' : `${meta.tradingDays} trading days away`;
        return sub(`${when} · ${timing} · ${scope}`);
      }
      case 'earningsMove':
        return sub(`Worst ${h.signedPercent(meta.worst, 1)} · ${h.formatNumber(meta.ratio, 1)}× a normal day · ${meta.count} releases`);
      case 'scoreBacktest': {
        const word = meta.meaningful ? (metric.value > 0 ? 'a modest edge' : 'pointed the wrong way') : 'no reliable edge';
        return sub(`Top third ${h.signedPercent(meta.top.mean, 1)} · bottom third ${h.signedPercent(meta.bottom.mean, 1)} (${meta.horizon} sessions) · ${word} · ${meta.n} days`);
      }
      case 'nextExDividend':
        return sub(`${h.shortDate(meta.date)}${meta.estimated ? ' (estimated)' : ''}${isNum(meta.dropFraction) ? ` · price drop ≈ ${h.formatPercent(meta.dropFraction, 2)}` : ''}`);
      case 'gapRisk':
        return sub(`Worst earnings fall ${h.formatPercent(-meta.worstFall, 1)} · stop risks ${h.formatAmount(meta.amountAtRisk)}${meta.inside ? ' · ⚠ earnings inside the horizon' : ''}`);
      case 'forecastBacktest':
        return sub(`Assuming no change missed by ${h.formatPercent(meta.naiveMape, 1)}${meta.beatsNaive ? ' · model was closer' : ' · the model added nothing'}`);
      default:
        return meta.scored && isNum(meta.subScore) ? scoreSub(meta, state, '') : '';
    }
  }

  function scoreSub(meta, state, suffix) {
    const weight = state.mode === 'pro' ? ` · weight ${meta.weight}%` : '';
    return sub(`${whole(meta.subScore)} / 100${weight}${suffix}`);
  }

  function mainValue(metric) {
    if (metric.status !== 'ok') return '<span class="badge badge--na">N/A</span>';
    if (metric.id === 'trendRegime') {
      return `<span class="badge badge--trend badge--${metric.tone}">${h.toneMark(metric.tone)}${esc(metric.value)}</span>`;
    }
    if (metric.id === 'headlineTone') {
      const word = String(metric.meta.label ?? '');
      return `${h.toneMark(metric.tone)}<span class="cell__value">${esc(word.charAt(0).toUpperCase() + word.slice(1))}</span>`;
    }
    const unit = metric.id === 'positionSize' && metric.meta.unitName
      ? ` <span class="cell__unit">${esc(metric.meta.unitName)}</span>` : '';
    return `${h.toneMark(metric.tone)}<span class="cell__value">${esc(h.formatMetric(metric))}${unit}</span>`;
  }

  function metricCell(section, row, asset, state, comparison) {
    const metric = app.trace(asset.ticker, row.id);
    if (!metric) {
      const pending = (row.id === 'regimeRecord' || row.id === 'scoreBacktest') && app.backtest().status !== 'error';
      return `<td><div class="cell cell--static cell--na"><span class="cell__value">${pending ? '<span class="cell__sub">Replaying past days in the background…</span>' : '–'}</span></div></td>`;
    }
    const label = rowLabel(row);
    let bar = '';
    if (metric.status === 'ok' && row.meter === 'score') bar = meter(metric.value, metric.tone);
    if (metric.status === 'ok' && row.meter === 'fraction') bar = meter(metric.value * 100, metric.tone);
    return `
      <td>
        <button type="button" class="cell${metric.status === 'ok' ? '' : ' cell--na'}"
          data-action="trace" data-ticker="${esc(asset.ticker)}" data-trace="${esc(row.id)}"
          data-key="${esc(`${section.id}|${asset.ticker}|${row.id}`)}"${metric.status === 'ok' ? '' : ` title="${esc(metric.naReason)}"`}
          aria-label="${esc(`${label} for ${asset.ticker}: ${h.describeMetric(metric)}. Show how it is calculated.`)}">
          <span class="cell__main">${mainValue(metric)}</span>
          ${bar}
          ${subLine(asset, metric, state, comparison)}
        </button>
      </td>`;
  }

  /* ------------------------------------------------------------------ */
  /* Price chart: the selected range, plus the dotted 30-day projection   */
  /* ------------------------------------------------------------------ */

  const charts = new Map(); // ticker -> the model of the chart on screen, for hover

  /**
   * Geometry and data of one asset's chart. The x axis is calendar time, so the
   * 30 projected days take up their true share of the width; the y axis covers
   * the closes and the whole projection band.
   */
  function chartModel(asset) {
    const view = app.window(asset.ticker);
    const { forecast } = app.analysis(asset.ticker);
    const { close, dates } = view.series;
    const points = dates.map((date, index) => ({ time: dayOf(date), date, price: close[index], projected: false }));
    const usable = forecast.status !== 'unavailable' && forecast.aligned !== false && forecast.series.dates.length > 0 && points.length > 1;
    const projection = usable ? forecast.series : null;
    if (projection) {
      projection.dates.forEach((date, index) => points.push({
        time: dayOf(date), date, price: projection.yhat[index], lower: projection.lower[index], upper: projection.upper[index], projected: true,
      }));
    }
    const history = close.length;
    const start = points.length ? points[0].time : 0;
    const today = history ? points[history - 1].time : start;
    const span = Math.max(DAY_MS, (points.length ? points[points.length - 1].time : start) - start);
    let low = Infinity;
    let high = -Infinity;
    for (const price of close) {
      if (price < low) low = price;
      if (price > high) high = price;
    }
    const windowLow = low;
    const windowHigh = high;
    if (projection) {
      low = Math.min(low, ...projection.lower);
      high = Math.max(high, ...projection.upper);
    }
    const height = high - low || Math.abs(high) * 0.01 || 1;
    return {
      asset, view, forecast, projection, points, history, start, span, windowLow, windowHigh,
      x: (time) => ((time - start) / span) * 100,
      y: (price) => 4 + (1 - (price - low) / height) * 32,
      todayX: ((today - start) / span) * 100,
      change: history >= 2 ? safeDiv(close[history - 1] - close[0], close[0]) : null,
    };
  }

  function sparkDefaults(model) {
    const projected = model.projection ? app.trace(model.asset.ticker, 'forecast30d') : null;
    return {
      label: `${esc(model.view.info.title)} ${deltaMarkup(model.change)}`,
      value: projected && projected.status === 'ok' ? `Projection ${esc(h.signedPercent(projected.value, 1))}` : '',
    };
  }

  function sparkCell(asset) {
    const model = chartModel(asset);
    charts.set(asset.ticker, model);
    const { points, history, projection, x, y } = model;
    if (history < 2) {
      return '<td><div class="cell cell--static cell--na"><span class="cell__sub">Not enough price history in this range to draw a chart.</span></div></td>';
    }
    const at = (point, price = point.price) => `${x(point.time).toFixed(2)},${y(price).toFixed(2)}`;
    let line = '';
    for (let i = 0; i < history; i += 1) line += `${i === 0 ? 'M' : 'L'}${at(points[i])}`;
    const last = points[history - 1];
    const area = `${line}L${model.todayX.toFixed(2)},40L0,40Z`;

    let band = '';
    let dotted = '';
    if (projection) {
      const future = points.slice(history);
      dotted = `M${at(last)}${future.map((point) => `L${at(point)}`).join('')}`;
      band = `M${at(last)}${future.map((point) => `L${at(point, point.upper)}`).join('')}`
        + `${[...future].reverse().map((point) => `L${at(point, point.lower)}`).join('')}Z`;
    }

    const { ticker, currency } = asset;
    const change = model.change ?? 0;
    let summary = `Price of ${ticker} over the last ${model.view.info.label}, ${points[0].date} to ${last.date}: ${change >= 0 ? 'up' : 'down'} ${h.formatPercent(Math.abs(change), 1)}. `
      + `Low ${amount(model.windowLow, currency)}, high ${amount(model.windowHigh, currency)}.`;
    if (projection) {
      const end = points[points.length - 1];
      summary += ` A trend model projects ${amount(end.price, currency)} by ${end.date}, with an 80% band from ${amount(end.lower, currency)} to ${amount(end.upper, currency)}. The projection is context only and moves no score.`;
    }
    const defaults = sparkDefaults(model);
    return `
      <td>
        <div class="spark" data-spark="${esc(ticker)}">
          <div class="spark__plot" role="img" aria-label="${esc(summary)}">
            <svg class="spark__svg" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              ${band ? `<path class="spark__band" d="${band}"></path>` : ''}
              <path class="spark__area" d="${area}"></path>
              <path class="spark__line" d="${line}"></path>
              ${dotted ? `<path class="spark__forecast" d="${dotted}"></path>` : ''}
            </svg>
            ${projection ? `<span class="spark__today" style="left:${model.todayX.toFixed(2)}%"></span>` : ''}
            <span class="spark__dot" style="left:${model.todayX.toFixed(2)}%;top:${(y(last.price) / 40 * 100).toFixed(2)}%"></span>
            <span class="spark__cursor" hidden></span>
          </div>
          <div class="spark__readout">
            <span data-role="spark-label">${defaults.label}</span>
            <span data-role="spark-value">${defaults.value}</span>
          </div>
        </div>
      </td>`;
  }

  /* ------------------------------------------------------------------ */
  /* Recent headlines                                                    */
  /* ------------------------------------------------------------------ */

  function newsCell(asset) {
    const { sentiment } = app.analysis(asset.ticker);
    const stories = sentiment.stories.slice(0, 3);
    if (stories.length === 0) {
      return `<td><p class="news-empty">${esc(sentiment.note || 'No recent headlines are available for this asset.')}</p></td>`;
    }
    const items = stories.map((story) => {
      const label = typeof story.label === 'string' ? story.label : null;
      // Only http(s) links from the feed become links; anything else is shown as plain text.
      const safe = typeof story.link === 'string' && /^https?:\/\//i.test(story.link);
      const title = safe
        ? `<a href="${esc(story.link)}" target="_blank" rel="noopener noreferrer">${esc(story.title)}</a>`
        : `<span>${esc(story.title)}</span>`;
      const meta = [
        h.relativeAge(story.ageHours),
        label ? `${label} wording` : 'not scored',
        story.duplicates ? `${story.duplicates} syndicated cop${story.duplicates === 1 ? 'y' : 'ies'} folded in` : '',
      ].filter(Boolean).join(' · ');
      return `
        <li class="news-item">
          ${h.toneMark(STORY_TONES[label] ?? null)}
          <span>${title}<span class="news-item__meta">${esc(meta)}</span></span>
        </li>`;
    }).join('');
    return `<td><ul class="news-list" aria-label="${esc(`Recent headlines for ${asset.ticker}`)}">${items}</ul></td>`;
  }

  /* ------------------------------------------------------------------ */
  /* Rows                                                                */
  /* ------------------------------------------------------------------ */

  function metricRow(section, row, assets, state, comparison) {
    const key = `${section.id}:${row.id}`;
    const label = rowLabel(row);
    if (row.kind === 'chart') {
      const cells = assets.map((asset) => sparkCell(asset)).join('');
      // Two series (price and projection) need a legend; it sits once, in the label column.
      const projected = assets.some((asset) => charts.get(asset.ticker) && charts.get(asset.ticker).projection);
      return `
        <tr class="metric-row" data-rowkey="${esc(key)}">
          <th scope="row">
            <div class="metric-label"><span class="metric-term">${esc(label)}</span></div>
            ${projected ? `
              <div class="spark__legend" aria-hidden="true">
                <span><span class="spark__key"></span>Price</span>
                <span><span class="spark__key spark__key--forecast"></span>30-day projection</span>
                <span><span class="spark__key spark__key--band"></span>80% band</span>
              </div>` : ''}
          </th>
          ${cells}
        </tr>`;
    }
    if (row.kind === 'news') {
      return `
        <tr class="metric-row" data-rowkey="${esc(key)}">
          <th scope="row"><div class="metric-label"><span class="metric-term">${esc(label)}</span></div></th>
          ${assets.map((asset) => newsCell(asset)).join('')}
        </tr>`;
    }
    const open = explainerOpen(key, state);
    return `
      <tr class="metric-row${row.lead ? ' metric-row--lead' : ''}" data-rowkey="${esc(key)}">
        <th scope="row">
          <div class="metric-label">
            <span class="metric-term">${esc(label)}</span>
            <button type="button" class="info-btn" data-action="explain" data-explain="${esc(key)}" data-key="${esc(`info|${key}`)}"
              aria-expanded="${open}" aria-controls="${domId(key)}" aria-label="${esc(`${open ? 'Hide' : 'Show'} the explanation of ${label}`)}">i</button>
          </div>
        </th>
        ${assets.map((asset) => metricCell(section, row, asset, state, comparison)).join('')}
      </tr>`;
  }

  function explainerRow(section, row, assets, state, span) {
    if (row.kind) return ''; // charts and headline lists explain themselves
    const key = `${section.id}:${row.id}`;
    const base = app.explain(row.id);
    const notes = new Map(); // note text -> tickers it applies to
    for (const asset of assets) {
      const { note } = app.explain(row.id, asset.scoringProfile);
      if (!note) continue;
      if (!notes.has(note)) notes.set(note, { profile: asset.scoringProfile, tickers: [] });
      notes.get(note).tickers.push(asset.ticker);
    }
    const part = (title, text, tone) => (text ? `
      <div class="explainer__part">
        <div class="explainer__label">${tone ? h.toneMark(tone) : ''}${esc(title)}</div>
        <div class="explainer__text">${esc(text)}</div>
      </div>` : '');
    const noteMarkup = notes.size ? `
      <div class="explainer__notes">
        ${[...notes.entries()].map(([note, info]) => `<p><strong>For ${esc(PROFILE_NAMES[info.profile] ?? 'this asset')} (${esc(info.tickers.join(', '))}):</strong> ${esc(note)}</p>`).join('')}
      </div>` : '';
    return `
      <tr class="explainer-row guided-only" id="${domId(key)}" data-explainer="${esc(key)}"${explainerOpen(key, state) ? '' : ' hidden'}>
        <td colspan="${span}">
          <div class="explainer">
            ${part('What it measures', base.what)}
            ${part('Why it matters', base.why)}
            ${part('Healthy', base.healthy, 'healthy')}
            ${part('Risky', base.risky, 'risky')}
            ${noteMarkup}
          </div>
        </td>
      </tr>`;
  }

  function sectionBody(section, assets, state, comparison, span) {
    const rows = visibleRows(section, state);
    return `
      <tbody data-section="${esc(section.id)}">
        <tr class="section-row">
          <th colspan="${span}" scope="rowgroup">
            <span class="section-row__title">${esc(section.title)}</span><span class="section-row__note">${esc(sectionNote(section, state))}</span>
          </th>
        </tr>
        ${rows.map((row) => metricRow(section, row, assets, state, comparison) + explainerRow(section, row, assets, state, span)).join('')}
      </tbody>`;
  }

  function headCell(asset) {
    const stale = asset.status === 'stale';
    return `
      <th scope="col">
        <div class="asset-head">
          <div class="asset-head__id">
            <span class="asset-head__ticker">${esc(asset.ticker)}</span>
            <span class="asset-head__name" title="${esc(asset.name)}">${esc(asset.name)}</span>
            <span class="asset-head__meta">
              <span class="chip">${esc(asset.market === 'CRYPTO' ? 'Crypto' : asset.market)}</span>
              ${asset.assetClass === 'crypto' ? '' : `<span class="chip" title="Scoring profile used for the Fundamental score">${esc(PROFILE_CHIPS[asset.scoringProfile] ?? asset.scoringProfile)}</span>`}
              ${stale ? `<span class="chip" title="${esc(asset.statusNote ?? 'The last refresh could not update this asset.')}">Older data</span>` : ''}
            </span>
          </div>
          <button type="button" class="icon-btn" data-action="remove" data-ticker="${esc(asset.ticker)}" data-key="${esc(`remove|${asset.ticker}`)}"
            aria-label="${esc(`Remove ${asset.ticker} from the comparison`)}">×</button>
        </div>
      </th>`;
  }

  function colgroup(assets) {
    return `<colgroup><col class="col-label">${assets.map(() => '<col>').join('')}</colgroup>`;
  }

  /* ------------------------------------------------------------------ */
  /* Correlation card                                                    */
  /* ------------------------------------------------------------------ */

  function heatCell(correlation, row, column) {
    const { tickers, matrix, pairs } = correlation;
    if (row === column) return '<td><div class="heat heat--self" aria-label="Same asset">–</div></td>';
    const a = Math.min(row, column);
    const b = Math.max(row, column);
    const id = pairId(tickers[a], tickers[b]);
    const metric = pairs[id];
    const rho = matrix[row][column];
    const label = `Correlation between ${tickers[row]} and ${tickers[column]}: ${metric ? h.describeMetric(metric) : 'not available'}. Show how it is calculated.`;
    if (!isNum(rho)) {
      return `<td><button type="button" class="heat heat--na" data-action="trace" data-ticker="" data-trace="${esc(id)}" data-key="${esc(`heat|${row}|${column}`)}" aria-label="${esc(label)}">N/A</button></td>`;
    }
    const classes = ['heat'];
    if (rho < 0) classes.push('heat--negative');
    if (Math.abs(rho) >= 0.8) classes.push('heat--strong');
    return `
      <td>
        <button type="button" class="${classes.join(' ')}" style="--magnitude:${Math.abs(rho).toFixed(3)}"
          data-action="trace" data-ticker="" data-trace="${esc(id)}" data-key="${esc(`heat|${row}|${column}`)}" aria-label="${esc(label)}">
          ${h.formatNumber(rho, 2)}
        </button>
      </td>`;
  }

  function correlationCard(comparison, state) {
    const { correlation } = comparison;
    const { tickers, alerts, overall } = correlation;
    const tone = { danger: 'risky', elevated: 'caution', ok: 'healthy', unknown: 'neutral' }[overall.level];
    const banner = `
      <div class="banner banner--${esc(overall.level)}" role="${overall.level === 'danger' ? 'alert' : 'note'}">
        ${h.toneMark(tone)}
        <div>
          <p class="banner__title">${esc(overall.headline)}</p>
          ${alerts.length ? `<ul class="banner__list">${alerts.map((alert) => `<li>${esc(alert.message)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>`;
    const table = tickers.length >= 2 ? `
      <div>
        <table class="heat-table">
          <caption class="sr-only">Correlation of daily returns between the compared assets</caption>
          <thead>
            <tr><td></td>${tickers.map((ticker) => `<th scope="col">${esc(ticker)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${tickers.map((ticker, row) => `<tr><th scope="row">${esc(ticker)}</th>${tickers.map((_, column) => heatCell(correlation, row, column)).join('')}</tr>`).join('')}
          </tbody>
        </table>
        <div class="heat-key" aria-hidden="true">
          <span>−1 opposite</span><span class="heat-key__ramp"></span><span>+1 identical</span>
        </div>
      </div>` : '';
    const explainer = app.explain('correlation');
    const guide = state.mode === 'guided' ? `
      <div class="guide-note guided-only">
        <span class="guide-note__badge">Guide</span>
        <span>${esc(explainer.what)} ${esc(explainer.why)} When assets overlap, each suggested position below is cut so that your total risk stays where you set it.</span>
      </div>` : '';
    return `
      <section class="card correlation" aria-labelledby="correlation-title">
        <div class="correlation__head">
          <h2 class="correlation__title" id="correlation-title">Correlation</h2>
          <span class="section-row__note">How much the compared assets overlap, from the last ${esc(h.rangeInfo(state.range).label)} of daily returns. Position sizes below use it.</span>
        </div>
        <div class="correlation__grid">
          ${table}
          <div>
            ${banner}
            ${guide}
          </div>
        </div>
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Position sizing table                                               */
  /* ------------------------------------------------------------------ */

  function sizingTable(state, comparison) {
    const { assets, heat } = comparison;
    const span = assets.length + 1;
    const { account, currency } = state;
    const rows = visibleRows(SIZING_SECTION, state);
    const heatLabel = app.explain('portfolioHeat').term;
    const heatKey = 'sizing:portfolioHeat';
    const heatOpen = explainerOpen(heatKey, state);
    return `
      <table class="matrix-table matrix-table--sizing" data-role="sizing">
        <caption class="sr-only">Suggested position size for each compared asset</caption>
        ${colgroup(assets)}
        <thead>
          <tr>
            <th scope="col" class="corner">Position sizing</th>
            ${assets.map((asset) => `<th scope="col"><span class="asset-head__ticker">${esc(asset.ticker)}</span></th>`).join('')}
          </tr>
        </thead>
        <tbody data-section="sizing">
          <tr class="section-row">
            <th colspan="${span}" scope="rowgroup">
              <div class="section-row__inner">
                <div class="sizing-summary">
                  <span>Account <strong>${esc(currency)} ${h.formatNumber(account.equity, 0)}</strong></span>
                  <span>Risk per trade <strong>${h.formatNumber(account.riskPct, 2)}%</strong></span>
                  <span>Stop <strong>${h.formatNumber(account.atrMultiple, 1)} × ATR</strong></span>
                  <span>Max position <strong>${h.formatNumber(account.maxPositionPct, 0)}%</strong></span>
                </div>
                <button type="button" class="btn btn--sm" data-action="sandbox" data-key="sandbox|section">Adjust in the risk sandbox</button>
              </div>
            </th>
          </tr>
          ${rows.map((row) => metricRow(SIZING_SECTION, row, assets, state, comparison) + explainerRow(SIZING_SECTION, row, assets, state, span)).join('')}
          <tr class="metric-row" data-rowkey="${heatKey}">
            <th scope="row">
              <div class="metric-label">
                <span class="metric-term">${esc(heatLabel)}</span>
                <button type="button" class="info-btn" data-action="explain" data-explain="${heatKey}" data-key="info|${heatKey}"
                  aria-expanded="${heatOpen}" aria-controls="${domId(heatKey)}" aria-label="${esc(`${heatOpen ? 'Hide' : 'Show'} the explanation of ${heatLabel}`)}">i</button>
              </div>
            </th>
            <td colspan="${assets.length}">
              <button type="button" class="cell${heat.status === 'ok' ? '' : ' cell--na'}" data-action="trace" data-ticker="" data-trace="portfolioHeat" data-key="sizing||portfolioHeat"
                aria-label="${esc(`${heatLabel}: ${h.describeMetric(heat)}. Show how it is calculated.`)}">
                <span class="cell__main">${mainValue(heat)}</span>
                ${heat.status === 'ok'
    ? sub(`${currency} ${h.formatAmount(heat.meta.total)} at risk across ${heat.meta.positions} position${heat.meta.positions === 1 ? '' : 's'} if every stop is hit`)
    : `<span class="cell__sub cell__sub--reason">${esc(heat.naReason)}</span>`}
              </button>
            </td>
          </tr>
          ${explainerRow(SIZING_SECTION, { id: 'portfolioHeat' }, [], state, span)}
          <tr class="metric-row span-row">
            <th scope="row"><div class="metric-label"><span class="metric-term">Simulate outcomes</span></div></th>
            ${assets.map((asset) => `
              <td>
                <div class="cell cell--static">
                  <button type="button" class="btn btn--sm" data-action="sandbox" data-ticker="${esc(asset.ticker)}" data-key="${esc(`sandbox|${asset.ticker}`)}"
                    aria-label="${esc(`Open the risk sandbox for ${asset.ticker}`)}">Simulate</button>
                </div>
              </td>`).join('')}
          </tr>
        </tbody>
      </table>`;
  }

  /* ------------------------------------------------------------------ */
  /* Whole-matrix render                                                 */
  /* ------------------------------------------------------------------ */

  function toolbar(state, comparison) {
    const fx = selectFx(state);
    const count = comparison.assets.length;
    const fxText = fx ? ` · USD/SGD ${h.formatNumber(fx.rate, 4)}` : '';
    const allOpen = explainers.defaultOpen && ![...explainers.overrides.values()].includes(false);
    return `
      <header class="matrix__toolbar">
        <div>
          <h1 class="matrix__title" id="matrix-title">${count ? esc(comparison.tickers.join(' vs ')) : 'Comparison'}</h1>
          <p class="matrix__sub">Amounts in ${esc(state.currency)}${fxText} · chart, Period rows and correlation cover the last ${esc(h.rangeInfo(state.range).label)}. Select any value to see exactly how it was calculated.</p>
        </div>
        <div class="toolbar-actions">
          ${count ? `<button type="button" class="btn guided-only" data-action="toggle-explainers" data-key="toolbar|explainers" aria-pressed="${allOpen}">${allOpen ? 'Hide explanations' : 'Show explanations'}</button>` : ''}
          <button type="button" class="btn" data-action="copy-link" data-key="toolbar|copy">Copy share link</button>
          ${count ? '<button type="button" class="btn btn--primary" data-action="sandbox" data-key="toolbar|sandbox">Risk sandbox</button>' : ''}
        </div>
      </header>`;
  }

  function warningBanner(state) {
    if (!state.warnings.length) return '';
    return `
      <div class="banner banner--warning" role="note">
        ${h.toneMark('caution')}
        <div>
          <p class="banner__title">Data notice</p>
          <ul class="banner__list">${state.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>
        </div>
      </div>`;
  }

  function emptyState() {
    return `
      <div class="empty-matrix">
        <p class="empty-matrix__title">Pick up to ${MAX_SELECTED} assets to compare</p>
        <p>Tick assets in the screener. Each one gets a column with its trend regime, indicators, fundamentals and a suggested position size.</p>
      </div>`;
  }

  function mainTable(state, comparison) {
    const { assets } = comparison;
    const span = assets.length + 1;
    return `
      <table class="matrix-table" data-role="main">
        <caption class="sr-only">Comparison of ${esc(comparison.tickers.join(', '))}. Each value opens its step-by-step derivation.</caption>
        ${colgroup(assets)}
        <thead>
          <tr>
            <th scope="col" class="corner">Metric</th>
            ${assets.map((asset) => headCell(asset)).join('')}
          </tr>
        </thead>
        ${SECTIONS.map((section) => sectionBody(section, assets, state, comparison, span)).join('')}
      </table>`;
  }

  function withFocus(update) {
    const active = document.activeElement;
    const key = active && root.contains(active) ? active.dataset.key : null;
    update();
    if (key) {
      const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function markCurrent() {
    const { drawer } = store.getState();
    for (const cell of root.querySelectorAll('[aria-current="true"]')) cell.removeAttribute('aria-current');
    if (!drawer.open || !drawer.trail.length) return;
    const ticker = drawer.ticker ?? '';
    const selector = `[data-action="trace"][data-ticker="${CSS.escape(ticker)}"][data-trace="${CSS.escape(drawer.trail[0])}"]`;
    for (const cell of root.querySelectorAll(selector)) cell.setAttribute('aria-current', 'true');
  }

  let dirty = true;

  function render() {
    const state = store.getState();
    if (!state.snapshot) {
      root.innerHTML = '';
      return;
    }
    dirty = false;
    charts.clear();
    const comparison = app.comparison();
    const hasAssets = comparison.assets.length > 0;
    withFocus(() => {
      root.innerHTML = [
        toolbar(state, comparison),
        warningBanner(state),
        hasAssets && state.mode === 'guided' ? `
          <div class="guide-note guided-only">
            <span class="guide-note__badge">Guided</span>
            <span>Each row explains what the number means and what a healthy or risky reading looks like. Select a value to open its working, then follow the links to the numbers it is built from. Switch to Pro for a denser view.</span>
          </div>` : '',
        hasAssets ? mainTable(state, comparison) : emptyState(),
        hasAssets ? correlationCard(comparison, state) : '',
        hasAssets ? sizingTable(state, comparison) : '',
      ].join('');
    });
    markCurrent();
  }

  /** A live tick only touches the price row and the sizing table, never the whole matrix. */
  function refreshLive() {
    const state = store.getState();
    const comparison = app.comparison();
    if (!comparison.assets.length) return;
    const priceSection = SECTIONS.find((section) => section.id === 'price');
    withFocus(() => {
      const priceRow = root.querySelector('tr[data-rowkey="price:price"]');
      if (priceRow) priceRow.outerHTML = metricRow(priceSection, priceSection.rows[0], comparison.assets, state, comparison);
      const sizing = root.querySelector('[data-role="sizing"]');
      if (sizing) sizing.outerHTML = sizingTable(state, comparison);
    });
    markCurrent();
  }

  let liveTimer = null;
  function scheduleLive() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      refreshLive();
    }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  async function copyLink() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      store.dispatch(actions.notify('Link copied. It opens this exact comparison, currency and mode.'));
    } catch (error) {
      store.dispatch(actions.notify('Copying is blocked here. Copy the address from the address bar instead: it already contains this view.'));
    }
  }

  function toggleExplainer(button) {
    const key = button.dataset.explain;
    const state = store.getState();
    const open = !explainerOpen(key, state);
    explainers.overrides.set(key, open);
    const row = root.querySelector(`[data-explainer="${CSS.escape(key)}"]`);
    if (row) row.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', button.getAttribute('aria-label').replace(/^(Show|Hide)/, open ? 'Hide' : 'Show'));
    const allButton = root.querySelector('[data-action="toggle-explainers"]');
    if (allButton) {
      const allOpen = explainers.defaultOpen && ![...explainers.overrides.values()].includes(false);
      allButton.setAttribute('aria-pressed', String(allOpen));
      allButton.textContent = allOpen ? 'Hide explanations' : 'Show explanations';
    }
  }

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (!control || !root.contains(control)) return;
    const { action, ticker } = control.dataset;
    switch (action) {
      case 'trace':
        app.rememberTrigger(control.dataset.key);
        store.dispatch(actions.openTrace(ticker || null, control.dataset.trace));
        break;
      case 'explain':
        toggleExplainer(control);
        break;
      case 'remove':
        store.dispatch(actions.removeTicker(ticker));
        break;
      case 'sandbox':
        store.dispatch(actions.openSandbox(ticker || store.getState().selected[0] || null));
        break;
      case 'copy-link':
        copyLink();
        break;
      case 'toggle-explainers': {
        const allOpen = explainers.defaultOpen && ![...explainers.overrides.values()].includes(false);
        explainers.defaultOpen = !allOpen;
        explainers.overrides.clear();
        render();
        break;
      }
      default:
        break;
    }
  });

  // Chart hover: a vertical hairline snaps to the nearest day and the readout shows its date and
  // price. Past the "today" line it reads the projection and its 80% band instead.
  root.addEventListener('pointermove', (event) => {
    const plot = event.target.closest ? event.target.closest('.spark__plot') : null;
    if (!plot) return;
    const holder = plot.closest('[data-spark]');
    const model = charts.get(holder.dataset.spark);
    if (!model || model.points.length === 0) return;
    const box = plot.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const time = model.start + fraction * model.span;
    let nearest = model.points[0];
    for (const point of model.points) {
      if (Math.abs(point.time - time) < Math.abs(nearest.time - time)) nearest = point;
    }
    const cursor = plot.querySelector('.spark__cursor');
    cursor.hidden = false;
    cursor.style.left = `${model.x(nearest.time)}%`;
    const { currency } = model.asset;
    holder.querySelector('[data-role="spark-label"]').textContent = `${h.shortDate(nearest.date, true)}${nearest.projected ? ' · projected' : ''}`;
    const value = holder.querySelector('[data-role="spark-value"]');
    value.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = amount(nearest.price, currency);
    value.append(strong);
    if (nearest.projected) {
      value.append(` (${h.formatAmount(h.money(nearest.lower, currency).value)} – ${h.formatAmount(h.money(nearest.upper, currency).value)})`);
    }
  });

  root.addEventListener('pointerout', (event) => {
    const plot = event.target.closest ? event.target.closest('.spark__plot') : null;
    if (!plot || (event.relatedTarget && plot.contains(event.relatedTarget))) return;
    const holder = plot.closest('[data-spark]');
    const model = charts.get(holder.dataset.spark);
    plot.querySelector('.spark__cursor').hidden = true;
    if (!model) return;
    const defaults = sparkDefaults(model);
    holder.querySelector('[data-role="spark-label"]').innerHTML = defaults.label;
    holder.querySelector('[data-role="spark-value"]').innerHTML = defaults.value;
  });

  store.subscribe((next, previous) => {
    const structural = next.snapshot !== previous.snapshot || next.selected !== previous.selected
      || next.currency !== previous.currency || next.mode !== previous.mode
      || next.account !== previous.account || next.live.fx !== previous.live.fx
      || next.warnings !== previous.warnings || next.range !== previous.range
      || next.compute.backtest !== previous.compute.backtest;
    // The matrix is only rebuilt while it is the visible view; otherwise it is marked stale
    // and rebuilt once when the user comes back to it.
    if (next.view !== 'compare') {
      if (structural) dirty = true;
      return;
    }
    if (structural || (next.view !== previous.view && dirty)) {
      render();
      return;
    }
    if (next.drawer !== previous.drawer) markCurrent();
    if (next.live.prices !== previous.live.prices && next.selected.some((ticker) => next.live.prices[ticker] !== previous.live.prices[ticker])) {
      scheduleLive();
    }
  });

  if (store.getState().view === 'compare') render();

  return {
    destroy() {
      clearTimeout(liveTimer);
    },
  };
}
