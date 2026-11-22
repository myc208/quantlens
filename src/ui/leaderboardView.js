/**
 * leaderboardView.js: the whole watchlist in one sortable table.
 *
 * Default order: trend regime (Uptrend first, Downtrend last), then 3-month relative
 * strength, strongest first. Every column header sorts; the
 * current order is exposed through aria-sort. Assets with no value for the
 * sorted column always sink to the bottom, whichever direction is chosen, so
 * "N/A" never masquerades as the best or the worst.
 *
 * The table respects the screener filters, so "banks in Singapore, ranked by
 * fundamentals" is two clicks. The period columns (return, volatility,
 * drawdown) follow the time range; the trend regime and the scores never do.
 *
 * Every value is a button that opens its derivation, exactly as in the
 * comparison matrix. The table shows as many columns as its own width allows
 * (CSS container queries, three tiers); the rest fold into a details row
 * opened with the "+" button, so nothing is ever cut off or scrolled sideways.
 *
 * sortRows is a pure function so the ordering rules can be unit-tested.
 */

import { MAX_SELECTED, filterAssets, hasActiveFilters } from '../core/store.js';
import { isNum } from '../core/precisionMath.js';
import { valueOf } from '../core/derivationTracer.js';

// Sort order of the trend regimes, strongest trend first. Extended sits below Uptrend:
// stretched, not stronger.
export const TREND_RANK = Object.freeze({ Uptrend: 5, Extended: 4, Pullback: 3, Recovering: 2, Downtrend: 1 });

/**
 * Column definitions. `first` is the direction of the first click: the one a
 * reader most often wants (highest score first, lowest volatility first).
 * `tier` decides when the column is shown: a = always, b = from a medium
 * table width, c = only on a wide table. `then` breaks ties, strongest first.
 */
export const BOARD_COLUMNS = Object.freeze([
  { id: 'ticker', label: 'Asset', tier: 'a', first: 'ascending' },
  { id: 'trendRegime', label: 'Trend', metric: 'trendRegime', tier: 'a', first: 'descending', then: 'relativeStrength3m' },
  { id: 'relativeStrength3m', label: 'RS 3M', metric: 'relativeStrength3m', tier: 'a', first: 'descending' },
  { id: 'technicalScore', label: 'Technical', metric: 'technicalScore', tier: 'b', first: 'descending' },
  { id: 'fundamentalScore', label: 'Fundamental', metric: 'fundamentalScore', tier: 'b', first: 'descending' },
  { id: 'price', label: 'Price', metric: 'price', tier: 'b', first: 'descending' },
  { id: 'periodReturn', label: 'Return', metric: 'periodReturn', tier: 'a', first: 'descending', ranged: true },
  { id: 'periodVolatility', label: 'Volatility', metric: 'periodVolatility', tier: 'b', first: 'ascending', ranged: true },
  { id: 'maxDrawdown', label: 'Drawdown', metric: 'maxDrawdown', tier: 'c', first: 'descending', ranged: true },
  { id: 'beta', label: 'Beta', metric: 'beta', tier: 'c', first: 'descending', ranged: true },
  { id: 'dollarVolume', label: 'Traded value', metric: 'dollarVolume', tier: 'c', first: 'descending' },
  { id: 'headlineTone', label: 'News tone', metric: 'headlineTone', tier: 'c', first: 'descending' },
  { id: 'forecast30d', label: '30d projection', metric: 'forecast30d', tier: 'c', first: 'descending' },
].map((column) => Object.freeze(column)));

export const DEFAULT_SORT = Object.freeze({ key: 'trendRegime', direction: 'descending' });

/**
 * Order rows by one column.
 *
 * @param {{ ticker:string, values:Record<string, number|string|null> }[]} rows
 * @param {string} key a column id
 * @param {'ascending'|'descending'} direction
 * @param {string|null} [then] a second column that breaks ties, highest first, missing last
 * @returns {object[]} a new array: missing values last, ties broken by `then`, then by ticker A–Z
 */
export function sortRows(rows, key, direction = 'descending', then = null) {
  const sign = direction === 'ascending' ? 1 : -1;
  const missing = (value) => value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value));
  const compare = (a, b, column, columnSign) => {
    const left = a.values[column];
    const right = b.values[column];
    const leftMissing = missing(left);
    const rightMissing = missing(right);
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1; // regardless of direction
    if (leftMissing) return 0;
    const order = typeof left === 'string' || typeof right === 'string'
      ? String(left).localeCompare(String(right))
      : left - right;
    return order * columnSign;
  };
  return [...rows].sort((a, b) => compare(a, b, key, sign)
    || (then && then !== key ? compare(a, b, then, -1) : 0)
    || a.ticker.localeCompare(b.ticker));
}

export function mountLeaderboardView(root, app) {
  const { store, actions, h } = app;
  const { esc } = h;
  let sort = { ...DEFAULT_SORT };
  const expanded = new Set(); // tickers whose details row is open
  const tierClass = (column) => (column.tier === 'a' ? '' : ` class="col-${column.tier}"`);
  let dirty = true;
  let liveTimer = null;

  /* ---------------- data ---------------- */

  function rowFor(asset) {
    const metrics = {};
    const values = { ticker: asset.ticker };
    for (const column of BOARD_COLUMNS) {
      if (!column.metric) continue;
      const metric = app.trace(asset.ticker, column.metric);
      metrics[column.id] = metric;
      if (column.id === 'trendRegime') values.trendRegime = metric && metric.status === 'ok' ? TREND_RANK[metric.value] ?? null : null;
      // Prices are compared in the display currency, so SGD and USD assets sort on one scale.
      else if (column.id === 'price') values.price = metric && metric.status === 'ok' ? h.money(metric.value, asset.currency).value : null;
      // Traded value is compared in one currency too.
      else if (column.id === 'dollarVolume') values.dollarVolume = metric && metric.status === 'ok' ? h.money(metric.value, metric.meta.currency).value : null;
      else values[column.id] = valueOf(metric);
    }
    return { ticker: asset.ticker, asset, metrics, values };
  }

  /* ---------------- cells ---------------- */

  function valueMarkup(column, metric) {
    if (!metric || metric.status !== 'ok') return '<span class="badge badge--na">N/A</span>';
    if (column.id === 'trendRegime') {
      return `<span class="badge badge--trend badge--${metric.tone}">${h.toneMark(metric.tone)}${esc(metric.value)}</span>`;
    }
    if (column.id === 'headlineTone') {
      const word = String(metric.meta.label ?? '');
      return `${h.toneMark(metric.tone)}<span class="cell__value">${esc(word.charAt(0).toUpperCase() + word.slice(1))}</span>`;
    }
    return `${h.toneMark(metric.tone)}<span class="cell__value">${esc(h.formatMetric(metric))}</span>`;
  }

  function cellButton(column, row, scope) {
    const metric = row.metrics[column.id];
    if (!metric) return '<div class="cell cell--static cell--na"><span class="cell__value">–</span></div>';
    const label = `${column.label} for ${row.ticker}: ${h.describeMetric(metric)}. Show how it is calculated.`;
    return `
      <button type="button" class="cell${metric.status === 'ok' ? '' : ' cell--na'}" data-action="trace"
        data-ticker="${esc(row.ticker)}" data-trace="${esc(column.metric)}" data-key="${esc(`board|${scope}|${row.ticker}|${column.id}`)}"
        ${metric.status === 'ok' ? '' : `title="${esc(metric.naReason)}"`} aria-label="${esc(label)}">
        <span class="cell__main">${valueMarkup(column, metric)}</span>
      </button>`;
  }

  function headCell(column, rangeShort) {
    const active = sort.key === column.id;
    const label = column.ranged ? `${column.label} · ${rangeShort}` : column.label;
    return `
      <th scope="col"${tierClass(column)}${active ? ` aria-sort="${sort.direction}"` : ''}>
        <button type="button" class="board__sort" data-action="sort" data-sort="${esc(column.id)}" data-key="${esc(`board|sort|${column.id}`)}">${esc(label)}</button>
      </th>`;
  }

  function assetCell(row) {
    const { asset } = row;
    const market = asset.market === 'CRYPTO' ? 'Crypto' : asset.market;
    const earnings = app.trace(asset.ticker, 'nextEarnings');
    const soon = earnings && earnings.status === 'ok' && earnings.meta.insideForecast
      ? `<span class="chip chip--event" title="${esc(`Earnings around ${earnings.meta.date}: ${earnings.meta.tradingDays} trading days away`)}">Earnings ${esc(h.formatNumber(earnings.value, 0))}d</span>` : '';
    return `
      <th scope="row">
        <div class="board__asset">
          <span class="board__ticker">${esc(asset.ticker)}<span class="chip">${esc(market)}</span>${soon}</span>
          <span class="board__name" title="${esc(asset.name)}">${esc(asset.name)}</span>
        </div>
      </th>`;
  }

  function toggleButton(row, state, scope) {
    const selected = state.selected.includes(row.ticker);
    const full = !selected && state.selected.length >= MAX_SELECTED;
    const label = selected ? `Remove ${row.ticker} from the comparison` : `Add ${row.ticker} to the comparison${full ? ` (${MAX_SELECTED} already chosen)` : ''}`;
    if (scope === 'details') {
      return `<button type="button" class="btn btn--sm" data-action="toggle" data-ticker="${esc(row.ticker)}" data-key="${esc(`board|toggle-d|${row.ticker}`)}" aria-pressed="${selected}">${selected ? 'In comparison · remove' : 'Add to comparison'}</button>`;
    }
    return `
      <button type="button" class="board__toggle" data-action="toggle" data-ticker="${esc(row.ticker)}" data-key="${esc(`board|toggle|${row.ticker}`)}"
        aria-pressed="${selected}"${full ? ' aria-disabled="true"' : ''} aria-label="${esc(label)}" title="${esc(label)}">
        <span class="asset__check" aria-hidden="true"></span>
      </button>`;
  }

  function detailsRow(row, state, span, rangeShort) {
    const open = expanded.has(row.ticker);
    const items = BOARD_COLUMNS.filter((column) => column.tier !== 'a').map((column) => `
      <div class="det-${column.tier}">
        <div class="board__details-label">${esc(column.ranged ? `${column.label} · ${rangeShort}` : column.label)}</div>
        ${cellButton(column, row, 'details')}
      </div>`).join('');
    return `
      <tr class="board__details" id="board-details-${esc(row.ticker.replace(/[^a-zA-Z0-9]+/g, '-'))}"${open ? '' : ' hidden'}>
        <td colspan="${span}">
          <div class="board__details-grid">${items}</div>
          <div class="toolbar-actions det-b">${toggleButton(row, state, 'details')}</div>
        </td>
      </tr>`;
  }

  function bodyRow(row, position, state, span, rangeShort) {
    const open = expanded.has(row.ticker);
    const detailsId = `board-details-${row.ticker.replace(/[^a-zA-Z0-9]+/g, '-')}`;
    return `
      <tr data-ticker="${esc(row.ticker)}" data-selected="${state.selected.includes(row.ticker)}">
        <td class="board__rank col-b">${position + 1}</td>
        ${assetCell(row)}
        ${BOARD_COLUMNS.filter((column) => column.metric).map((column) => `<td${tierClass(column)}>${cellButton(column, row, 'row')}</td>`).join('')}
        <td class="col-x">
          <button type="button" class="icon-btn board__expand" data-action="expand" data-ticker="${esc(row.ticker)}" data-key="${esc(`board|expand|${row.ticker}`)}"
            aria-expanded="${open}" aria-controls="${esc(detailsId)}" aria-label="${esc(`${open ? 'Hide' : 'Show'} more columns for ${row.ticker}`)}">${open ? '−' : '+'}</button>
        </td>
        <td class="col-b">${toggleButton(row, state, 'row')}</td>
      </tr>
      ${detailsRow(row, state, span, rangeShort)}`;
  }

  /* ---------------- render ---------------- */

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
    if (!drawer.open || !drawer.trail.length || !drawer.ticker) return;
    const selector = `[data-action="trace"][data-ticker="${CSS.escape(drawer.ticker)}"][data-trace="${CSS.escape(drawer.trail[0])}"]`;
    for (const cell of root.querySelectorAll(selector)) cell.setAttribute('aria-current', 'true');
  }

  /** One line on what followed each trend regime across the whole watchlist, once the worker has replayed it. */
  function backtestLine() {
    const job = app.backtest();
    if (!job.result) return job.status === 'running' ? '<p class="matrix__sub">Replaying the trend regimes over five years in the background…</p>' : '';
    const s = job.result.summary;
    if (!s.assets) return '';
    const pct = (value) => esc(h.signedPercent(value, 2));
    const labels = Object.keys(TREND_RANK).filter((label) => s.labels[label] && s.labels[label].count)
      .map((label) => `${label} ${pct(s.labels[label].mean)}`).join(', ');
    const month = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const span = s.span ? `, ${esc(month(s.span.from))} to ${esc(month(s.span.to))}` : '';
    const ic = String(h.formatNumber(s.meanIc, 2)).replace('-', '−');
    return `<p class="matrix__sub"><strong>Regime track record</strong> (average return over the next ${s.horizon} sessions${span}, ${s.assets} assets): ${labels}, against ${pct(s.all.mean)} on all days. The Technical score's mean rank IC was ${esc(ic)} (positive for ${s.positiveIc} of ${s.assets}): no label or score predicted the next month.</p>`;
  }

  function render() {
    const state = store.getState();
    if (!state.snapshot) {
      root.innerHTML = '';
      return;
    }
    dirty = false;
    const range = h.rangeInfo(state.range);
    const total = state.snapshot.assets.length;
    const visible = filterAssets(state.snapshot.assets, state.filters, app.trends());
    const sortedBy = BOARD_COLUMNS.find((column) => column.id === sort.key) ?? BOARD_COLUMNS[1];
    const rows = sortRows(visible.map(rowFor), sort.key, sort.direction, sortedBy.then ?? null);
    const thenBy = sortedBy.then ? BOARD_COLUMNS.find((column) => column.id === sortedBy.then) : null;
    const sortedText = `${sortedBy.label}${thenBy ? `, then ${thenBy.label}` : ''}`;
    const span = BOARD_COLUMNS.length + 3;
    const filtered = hasActiveFilters(state.filters);

    const table = rows.length ? `
      <table class="board">
        <caption class="sr-only">Watchlist ranked by ${esc(sortedText)}, ${sort.direction}. Column headers sort the table; each value opens its derivation.</caption>
        <thead>
          <tr>
            <th scope="col" class="col-b"><span class="board__heading" title="Position in the current order">#</span></th>
            ${BOARD_COLUMNS.map((column) => headCell(column, range.short)).join('')}
            <th scope="col" class="col-x"><span class="sr-only">More columns</span></th>
            <th scope="col" class="col-b"><span class="sr-only">In the comparison</span></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, position) => bodyRow(row, position, state, span, range.short)).join('')}
        </tbody>
      </table>` : `
      <div class="empty-matrix">
        <p class="empty-matrix__title">No assets match these filters</p>
        <p>Reset the screener filters to rank the whole watchlist.</p>
        <p><button type="button" class="btn btn--sm" data-action="reset-filters" data-key="board|reset">Reset filters</button></p>
      </div>`;

    withFocus(() => {
      root.innerHTML = `
        <header class="view-toolbar">
          <div>
            <h1 class="matrix__title" id="leaderboard-title">Leaderboard</h1>
            <p class="matrix__sub">${rows.length} of ${total} assets${filtered ? ' (filtered)' : ''} · sorted by ${esc(sortedText)} · amounts in ${esc(state.currency)} · period columns cover the last ${esc(range.label)}</p>
            ${backtestLine()}
          </div>
          <div class="toolbar-actions">
            ${sort.key !== DEFAULT_SORT.key || sort.direction !== DEFAULT_SORT.direction ? '<button type="button" class="btn btn--sm" data-action="reset-sort" data-key="board|reset-sort">Default order</button>' : ''}
            <span class="pill-note">${state.selected.length} of ${MAX_SELECTED} in the comparison</span>
          </div>
        </header>
        ${state.mode === 'guided' ? `
          <div class="guide-note guided-only">
            <span class="guide-note__badge">Guided</span>
            <span>The trend regime says where each price stands against its own averages: a description, not a forecast, and the header above shows what followed each one. The Technical and Fundamental scores are separate readouts, never blended into one rating. Select a column heading to rank by it, and any value to see its working. Return, volatility and drawdown follow the time range; regimes and scores always use the full year. News tone and the 30-day projection are context only.</span>
          </div>` : ''}
        ${table}`;
    });
    markCurrent();
  }

  function renderIfVisible() {
    if (store.getState().view === 'leaderboard') render();
    else dirty = true;
  }

  /* ---------------- events ---------------- */

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (!control || !root.contains(control)) return;
    const { action, ticker } = control.dataset;
    switch (action) {
      case 'sort': {
        const column = BOARD_COLUMNS.find((item) => item.id === control.dataset.sort);
        if (!column) break;
        if (sort.key === column.id) sort = { key: column.id, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' };
        else sort = { key: column.id, direction: column.first };
        render();
        break;
      }
      case 'reset-sort':
        sort = { ...DEFAULT_SORT };
        render();
        break;
      case 'trace':
        app.rememberTrigger(control.dataset.key);
        store.dispatch(actions.openTrace(ticker, control.dataset.trace));
        break;
      case 'toggle':
        store.dispatch(actions.toggleTicker(ticker));
        break;
      case 'expand':
        if (expanded.has(ticker)) expanded.delete(ticker);
        else expanded.add(ticker);
        render();
        break;
      case 'reset-filters':
        store.dispatch(actions.resetFilters());
        break;
      default:
        break;
    }
  });

  store.subscribe((next, previous) => {
    const structural = next.snapshot !== previous.snapshot || next.filters !== previous.filters
      || next.selected !== previous.selected || next.currency !== previous.currency
      || next.range !== previous.range || next.mode !== previous.mode || next.live.fx !== previous.live.fx
      || next.compute.backtest !== previous.compute.backtest;
    if (next.view !== previous.view) {
      if (next.view === 'leaderboard' && (dirty || structural)) render();
      else if (structural) dirty = true;
      return;
    }
    if (structural) {
      renderIfVisible();
      return;
    }
    if (next.view !== 'leaderboard') return;
    if (next.drawer !== previous.drawer) markCurrent();
    // Live crypto ticks move the Price column: refresh at most every two seconds.
    if (next.live.prices !== previous.live.prices && !liveTimer) {
      liveTimer = setTimeout(() => {
        liveTimer = null;
        renderIfVisible();
      }, 2000);
    }
  });

  renderIfVisible();

  return {
    destroy() {
      clearTimeout(liveTimer);
    },
  };
}
