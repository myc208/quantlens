/**
 * screenerPanel.js: filters plus the list of assets to compare.
 *
 * The user never types market data. They narrow the watchlist with four
 * filters and tick up to three assets. Filters and the selection live in the
 * store, which mirrors them to the URL, so any view can be shared as a link.
 *
 * Desktop: a sticky panel on the left. Below 1024px: a collapsible panel
 * above the matrix ("Filters · 3 selected").
 */

import { MAX_SELECTED, FILTER_OPTIONS, filterAssets, hasActiveFilters } from '../core/store.js';
import { valueOf } from '../core/derivationTracer.js';

const CLASS_LABELS = Object.freeze({ all: 'All classes', equity: 'Stocks and REITs', etf: 'ETFs', index: 'Indices', crypto: 'Crypto' });
const MARKET_LABELS = Object.freeze({ all: 'All markets', US: 'United States', SG: 'Singapore', UK: 'United Kingdom', CRYPTO: 'Crypto' });
const TREND_LABELS = Object.freeze({ all: 'Any trend', uptrend: 'Uptrend', extended: 'Extended', pullback: 'Pullback', recovering: 'Recovering', downtrend: 'Downtrend' });

export function mountScreenerPanel(root, app) {
  const { store, actions, h } = app;
  let open = false; // collapsed by default on tablet and mobile

  root.dataset.open = 'false';
  root.innerHTML = `
    <button type="button" class="screener__toggle" aria-expanded="false" aria-controls="screener-body">
      <span>Filters and assets</span>
      <span class="screener__toggle-meta" data-role="toggle-meta"></span>
    </button>
    <div class="screener__body" id="screener-body">
      <div class="screener__head">
        <h2 class="panel-title" id="screener-title">Screener</h2>
        <button type="button" class="btn btn--ghost btn--sm" data-action="reset" hidden>Reset filters</button>
      </div>
      <form class="filters" aria-labelledby="screener-title" data-role="filters"></form>
      <p class="screener__count" data-role="count" aria-live="polite"></p>
      <ul class="asset-list" data-role="list" aria-label="Assets. Select up to ${MAX_SELECTED} to compare."></ul>
    </div>`;

  const toggle = root.querySelector('.screener__toggle');
  const toggleMeta = root.querySelector('[data-role="toggle-meta"]');
  const filtersForm = root.querySelector('[data-role="filters"]');
  const resetButton = root.querySelector('[data-action="reset"]');
  const count = root.querySelector('[data-role="count"]');
  const list = root.querySelector('[data-role="list"]');

  function option(value, label, current) {
    return `<option value="${h.esc(value)}"${value === current ? ' selected' : ''}>${h.esc(label)}</option>`;
  }

  /** Built once per snapshot: the sector list depends on the data. */
  function renderFilters() {
    const state = store.getState();
    const sectors = state.snapshot ? state.snapshot.sectors : [];
    const { filters } = state;
    filtersForm.innerHTML = `
      <label class="field">
        <span class="field__label">Asset class</span>
        <select class="select" name="assetClass">
          ${FILTER_OPTIONS.assetClass.map((value) => option(value, CLASS_LABELS[value], filters.assetClass)).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Market</span>
        <select class="select" name="market">
          ${FILTER_OPTIONS.market.map((value) => option(value, MARKET_LABELS[value], filters.market)).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Sector</span>
        <select class="select" name="sector">
          ${option('all', 'All sectors', filters.sector)}
          ${sectors.map((sector) => option(sector, sector, filters.sector)).join('')}
        </select>
      </label>
      <label class="field">
        <span class="field__label">Trend regime</span>
        <select class="select" name="trend">
          ${FILTER_OPTIONS.trend.map((value) => option(value, TREND_LABELS[value], filters.trend)).join('')}
        </select>
      </label>`;
    syncFilters();
  }

  /** Reflect store values into the existing controls without rebuilding them (keeps keyboard focus). */
  function syncFilters() {
    const { filters } = store.getState();
    for (const select of filtersForm.querySelectorAll('select')) {
      const value = filters[select.name];
      if (select.value !== value) select.value = value;
      select.dataset.active = value !== 'all' ? 'true' : 'false';
    }
    resetButton.hidden = !hasActiveFilters(filters);
  }

  function trendBadge(regime) {
    if (!regime || regime.status !== 'ok') return '<span class="badge badge--na">N/A</span>';
    return `<span class="badge badge--trend badge--${regime.tone}">${h.toneMark(regime.tone)}${h.esc(regime.value)}</span>`;
  }

  function assetRow(asset, state) {
    const analysis = app.analysis(asset.ticker);
    const regime = analysis ? analysis.technical.metrics.trendRegime : null;
    const trend = regime && regime.status === 'ok' ? regime.value : null;
    const score = analysis ? valueOf(analysis.technical.metrics.technicalScore) : null;
    const selected = state.selected.includes(asset.ticker);
    const full = !selected && state.selected.length >= MAX_SELECTED;
    const scoreText = score === null ? 'no score' : `Technical ${h.formatNumber(score, 0)}`;
    const labelParts = [
      asset.ticker, asset.name,
      trend ? `trend ${trend}` : 'no trend regime', score === null ? 'no Technical score' : `Technical score ${h.formatNumber(score, 0)}`,
      selected ? 'selected' : full ? `not selected, ${MAX_SELECTED} already chosen` : 'not selected',
    ];
    return `
      <li>
        <button type="button" class="asset" data-action="toggle" data-ticker="${h.esc(asset.ticker)}"
          aria-pressed="${selected}"${full ? ' aria-disabled="true"' : ''} aria-label="${h.esc(labelParts.join(', '))}">
          <span class="asset__check" aria-hidden="true"></span>
          <span class="asset__id">
            <span class="asset__ticker">${h.esc(asset.ticker)}<span class="chip">${h.esc(asset.market === 'CRYPTO' ? 'Crypto' : asset.market)}</span></span>
            <span class="asset__name">${h.esc(asset.name)}${asset.sector ? ` · ${h.esc(asset.sector)}` : ''}</span>
          </span>
          <span class="asset__signal">
            ${trendBadge(regime)}
            <span class="asset__score">${h.esc(scoreText)}</span>
          </span>
        </button>
      </li>`;
  }

  function renderList() {
    const state = store.getState();
    if (!state.snapshot) {
      list.innerHTML = '';
      count.textContent = '';
      toggleMeta.textContent = '';
      return;
    }
    const total = state.snapshot.assets.length;
    const visible = filterAssets(state.snapshot.assets, state.filters, app.trends());
    const hiddenSelected = state.selected.filter((ticker) => !visible.some((asset) => asset.ticker === ticker));

    // Keep keyboard focus on the same asset across re-renders.
    const active = document.activeElement;
    const focusedTicker = active && list.contains(active) ? active.dataset.ticker : null;

    list.innerHTML = visible.length
      ? visible.map((asset) => assetRow(asset, state)).join('')
      : '<li class="empty-note">No assets match these filters. Reset the filters to see the whole watchlist.</li>';

    if (focusedTicker) {
      const again = list.querySelector(`[data-ticker="${CSS.escape(focusedTicker)}"]`);
      if (again) again.focus();
    }

    const parts = [`Showing ${visible.length} of ${total}`, `${state.selected.length} of ${MAX_SELECTED} selected`];
    if (hiddenSelected.length) parts.push(`${hiddenSelected.join(', ')} selected but hidden by the filters`);
    count.textContent = `${parts.join(' · ')}.`;
    toggleMeta.textContent = `${state.selected.length} selected${hasActiveFilters(state.filters) ? ' · filtered' : ''}`;
  }

  /* ---------------- events ---------------- */

  toggle.addEventListener('click', () => {
    open = !open;
    root.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  filtersForm.addEventListener('change', (event) => {
    const select = event.target;
    if (select instanceof HTMLSelectElement) store.dispatch(actions.setFilter(select.name, select.value));
  });

  filtersForm.addEventListener('submit', (event) => event.preventDefault());

  root.addEventListener('click', (event) => {
    const reset = event.target.closest('[data-action="reset"]');
    if (reset) {
      store.dispatch(actions.resetFilters());
      const first = filtersForm.querySelector('select');
      if (first) first.focus();
      return;
    }
    const button = event.target.closest('[data-action="toggle"]');
    if (button) store.dispatch(actions.toggleTicker(button.dataset.ticker));
  });

  store.subscribe((next, previous) => {
    if (next.snapshot !== previous.snapshot) renderFilters();
    else if (next.filters !== previous.filters) syncFilters();
    if (next.snapshot !== previous.snapshot || next.filters !== previous.filters || next.selected !== previous.selected) renderList();
  });

  renderFilters();
  renderList();

  return { destroy() {} };
}
