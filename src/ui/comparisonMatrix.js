/**
 * comparisonMatrix.js: the side-by-side comparison of up to three assets.
 *
 * Layout: one table with a sticky metric-label column and one column per
 * asset, in sections (Verdict, Price, Technical, Fundamental), then the
 * correlation card, then the position-sizing table.
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
    id: 'verdict',
    title: 'Verdict',
    note: 'Rule-based signal for learning, not advice',
    rows: [
      { id: 'verdict', lead: true },
      { id: 'compositeScore', meter: 'score' },
      { id: 'confidence' },
    ],
  },
  {
    id: 'price',
    title: 'Price',
    note: 'Crypto is live; stocks are the last daily close',
    rows: [
      { id: 'price', lead: true },
      { id: 'chart', kind: 'chart', label: 'One-year price' },
    ],
  },
  {
    id: 'technical',
    title: 'Technical',
    note: 'Price behaviour, from completed daily candles',
    rows: [
      { id: 'technicalScore', lead: true, meter: 'score' },
      { id: 'rsi14', meter: 'score' },
      { id: 'macd' },
      { id: 'ema20' },
      { id: 'ema50' },
      { id: 'sma200' },
      { id: 'atrPct' },
      { id: 'volatility' },
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
    { id: 'riskBudget', pro: true },
    { id: 'riskPerUnit', pro: true },
  ],
});

const VERDICT_TONES = Object.freeze({ BUY: 'healthy', HOLD: 'neutral', SELL: 'risky' });
const PROFILE_CHIPS = Object.freeze({ CORPORATE: 'Corporate', FINANCIAL: 'Bank', REIT: 'REIT', CRYPTO: 'Crypto' });
const PROFILE_NAMES = Object.freeze({ CORPORATE: 'corporates', FINANCIAL: 'banks', REIT: 'REITs', CRYPTO: 'crypto' });

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
    return row.label ?? app.explain(row.id).term;
  }

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
      case 'verdict':
        return meta.capped ? sub('Held back from BUY by a safety rule') : '';
      case 'compositeScore': {
        if (meta.technicalOnly) return sub('Technical only');
        const [technical, fundamental] = metric.trace.rawInputs;
        return sub(`Technical ${whole(technical.value)} · Fundamental ${whole(fundamental.value)}`);
      }
      case 'confidence':
        return isNum(meta.gap) ? sub(`Scores are ${whole(meta.gap)} points apart`) : sub('One source of evidence');
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
    if (metric.id === 'verdict') {
      const tone = VERDICT_TONES[metric.value] ?? 'neutral';
      return `<span class="badge badge--verdict badge--${tone}">${h.toneMark(tone)}${esc(metric.value)}</span>`;
    }
    const unit = metric.id === 'positionSize' && metric.meta.unitName
      ? ` <span class="cell__unit">${esc(metric.meta.unitName)}</span>` : '';
    return `${h.toneMark(metric.tone)}<span class="cell__value">${esc(h.formatMetric(metric))}${unit}</span>`;
  }

  function metricCell(section, row, asset, state, comparison) {
    const metric = app.trace(asset.ticker, row.id);
    if (!metric) {
      return '<td><div class="cell cell--static cell--na"><span class="cell__value">–</span></div></td>';
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
  /* Sparkline (one series: the row title names it, so there is no legend) */
  /* ------------------------------------------------------------------ */

  function sparkCell(asset) {
    const { close, dates } = asset.series;
    const count = close.length;
    let low = Infinity;
    let high = -Infinity;
    for (const price of close) {
      if (price < low) low = price;
      if (price > high) high = price;
    }
    const span = high - low || 1;
    const x = (index) => (index / (count - 1)) * 100;
    const y = (price) => 4 + (1 - (price - low) / span) * 32;
    let line = '';
    for (let i = 0; i < count; i += 1) line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(close[i]).toFixed(2)}`;
    const area = `${line}L100,40L0,40Z`;
    const change = safeDiv(close[count - 1] - close[0], close[0]);
    const shownLow = h.money(low, asset.currency);
    const shownHigh = h.money(high, asset.currency);
    const summary = `One-year price for ${asset.ticker}, ${dates[0]} to ${dates[count - 1]}: ${change >= 0 ? 'up' : 'down'} ${h.formatPercent(Math.abs(change ?? 0), 1)}. Low ${shownLow.currency} ${h.formatAmount(shownLow.value)}, high ${shownHigh.currency} ${h.formatAmount(shownHigh.value)}.`;
    return `
      <td>
        <div class="spark" data-spark="${esc(asset.ticker)}">
          <div class="spark__plot" role="img" aria-label="${esc(summary)}">
            <svg class="spark__svg" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <path class="spark__area" d="${area}"></path>
              <path class="spark__line" d="${line}"></path>
            </svg>
            <span class="spark__dot" style="left:100%;top:${(y(close[count - 1]) / 40 * 100).toFixed(2)}%"></span>
            <span class="spark__cursor" hidden></span>
          </div>
          <div class="spark__readout">
            <span data-role="spark-label">1 year</span>
            <span data-role="spark-value">${deltaMarkup(change)}</span>
          </div>
        </div>
      </td>`;
  }

  function sparkDefaults(asset) {
    const { close } = asset.series;
    return { label: '1 year', value: deltaMarkup(safeDiv(close[close.length - 1] - close[0], close[0])) };
  }

  /* ------------------------------------------------------------------ */
  /* Rows                                                                */
  /* ------------------------------------------------------------------ */

  function metricRow(section, row, assets, state, comparison) {
    const key = `${section.id}:${row.id}`;
    const label = rowLabel(row);
    if (row.kind === 'chart') {
      return `
        <tr class="metric-row" data-rowkey="${esc(key)}">
          <th scope="row"><div class="metric-label"><span class="metric-term">${esc(label)}</span></div></th>
          ${assets.map((asset) => sparkCell(asset)).join('')}
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
    if (row.kind === 'chart') return '';
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
            <span class="section-row__title">${esc(section.title)}</span><span class="section-row__note">${esc(section.note)}</span>
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
          <span class="section-row__note">How much the compared assets overlap, from one year of daily returns</span>
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
          <p class="matrix__sub">Amounts in ${esc(state.currency)}${fxText}. Select any value to see exactly how it was calculated.</p>
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
        <p>Tick assets in the screener. Each one gets a column with its verdict, indicators, fundamentals and a suggested position size.</p>
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

  function render() {
    const state = store.getState();
    if (!state.snapshot) {
      root.innerHTML = '';
      return;
    }
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

  // Sparkline hover: a vertical hairline snaps to the nearest day and the readout shows its date and price.
  root.addEventListener('pointermove', (event) => {
    const plot = event.target.closest ? event.target.closest('.spark__plot') : null;
    if (!plot) return;
    const holder = plot.closest('[data-spark]');
    const analysis = app.analysis(holder.dataset.spark);
    if (!analysis) return;
    const { close, dates } = analysis.asset.series;
    const box = plot.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const index = Math.round(fraction * (close.length - 1));
    const cursor = plot.querySelector('.spark__cursor');
    cursor.hidden = false;
    cursor.style.left = `${(index / (close.length - 1)) * 100}%`;
    const shown = h.money(close[index], analysis.asset.currency);
    holder.querySelector('[data-role="spark-label"]').textContent = h.shortDate(dates[index], true);
    const value = holder.querySelector('[data-role="spark-value"]');
    value.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = `${shown.currency} ${h.formatAmount(shown.value)}`;
    value.append(strong);
  });

  root.addEventListener('pointerout', (event) => {
    const plot = event.target.closest ? event.target.closest('.spark__plot') : null;
    if (!plot || (event.relatedTarget && plot.contains(event.relatedTarget))) return;
    const holder = plot.closest('[data-spark]');
    const analysis = app.analysis(holder.dataset.spark);
    plot.querySelector('.spark__cursor').hidden = true;
    if (!analysis) return;
    const defaults = sparkDefaults(analysis.asset);
    holder.querySelector('[data-role="spark-label"]').textContent = defaults.label;
    holder.querySelector('[data-role="spark-value"]').innerHTML = defaults.value;
  });

  store.subscribe((next, previous) => {
    const structural = next.snapshot !== previous.snapshot || next.selected !== previous.selected
      || next.currency !== previous.currency || next.mode !== previous.mode
      || next.account !== previous.account || next.live.fx !== previous.live.fx
      || next.warnings !== previous.warnings;
    if (structural) {
      render();
      return;
    }
    if (next.drawer !== previous.drawer) markCurrent();
    if (next.live.prices !== previous.live.prices && next.selected.some((ticker) => next.live.prices[ticker] !== previous.live.prices[ticker])) {
      scheduleLive();
    }
  });

  render();

  return {
    destroy() {
      clearTimeout(liveTimer);
    },
  };
}
