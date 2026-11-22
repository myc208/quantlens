/**
 * appTabs.js: the bar under the telemetry strip.
 *
 *   [Compare] [Leaderboard] [Portfolio] [Rotation]     Range [1M|3M|6M|1Y|5Y]   [Search  Ctrl K]
 *
 * View tabs: a WAI-ARIA tablist with automatic activation. The arrow keys,
 * Home and End move between tabs; each tab controls one tab panel in the
 * workspace. The active view is part of the URL (?view=).
 *
 * Time range: one radio group. It dispatches setRange, and everything that
 * depends on the window (charts, period statistics, correlation, the
 * simulation's volatility, the portfolio maths) recomputes from the sliced
 * series. It never changes RSI, MACD, the moving averages or the trend regime,
 * which need a full year to warm up. The range is part of the URL (?range=).
 *
 * The bar publishes its height as --tabs-h so sticky table headers and the
 * drawer sit exactly below it. On phones the bar is not sticky, so it
 * publishes 0.
 */

import { VIEWS, RANGES } from '../core/store.js';

const VIEW_LABELS = Object.freeze({ compare: 'Compare', leaderboard: 'Leaderboard', portfolio: 'Portfolio', rotation: 'Rotation' });
const VIEW_PANELS = Object.freeze({ compare: 'comparison-matrix', leaderboard: 'leaderboard', portfolio: 'portfolio', rotation: 'rotation' });
const VIEW_HINTS = Object.freeze({
  compare: 'Up to three assets side by side',
  leaderboard: 'The whole watchlist, ranked',
  portfolio: 'Allocation, return, risk and Sharpe ratio',
  rotation: 'Who has led and lagged over 1 and 3 months',
});

export function mountAppTabs(root, app) {
  const { store, actions, h } = app;
  const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const shortcut = isApple ? '⌘K' : 'Ctrl K';

  root.innerHTML = `
    <div class="app-tabs__tabs" role="tablist" aria-label="Views">
      ${VIEWS.map((view) => `
        <button type="button" class="app-tab" role="tab" id="tab-${view}" data-view="${view}"
          aria-controls="${VIEW_PANELS[view]}" aria-selected="false" tabindex="-1" title="${h.esc(VIEW_HINTS[view])}">${h.esc(VIEW_LABELS[view])}</button>`).join('')}
    </div>
    <span class="app-tabs__spacer"></span>
    <div class="app-tabs__range">
      <span class="app-tabs__range-label" aria-hidden="true">Range</span>
      <fieldset class="segmented" data-control="range">
        <legend class="sr-only">Time range for charts, period statistics, correlation and portfolio maths. The trend regime and the scores always use the full year.</legend>
        ${RANGES.map((range) => {
    const info = h.rangeInfo(range);
    return `
          <label title="${h.esc(`Last ${info.label}`)}">
            <input type="radio" name="time-range" value="${range}" aria-label="${h.esc(info.title)}">
            <span>${h.esc(info.short)}</span>
          </label>`;
  }).join('')}
      </fieldset>
    </div>
    <button type="button" class="btn btn--sm app-tabs__search" data-action="palette" aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K" aria-label="Search assets and commands">
      <span>Search</span><kbd aria-hidden="true">${h.esc(shortcut)}</kbd>
    </button>`;

  const tabs = [...root.querySelectorAll('[role="tab"]')];

  function sync(state) {
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const radio of root.querySelectorAll('input[name="time-range"]')) radio.checked = radio.value === state.range;
  }

  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) {
      store.dispatch(actions.setView(tab.dataset.view));
      return;
    }
    if (event.target.closest('[data-action="palette"]')) app.openPalette();
  });

  root.addEventListener('keydown', (event) => {
    const tab = event.target.closest ? event.target.closest('[role="tab"]') : null;
    if (!tab) return;
    const index = tabs.indexOf(tab);
    let next = null;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
    store.dispatch(actions.setView(next.dataset.view));
  });

  root.addEventListener('change', (event) => {
    const control = event.target;
    if (control instanceof HTMLInputElement && control.name === 'time-range' && control.checked) {
      store.dispatch(actions.setRange(control.value));
    }
  });

  store.subscribe((next, previous) => {
    if (next.view !== previous.view || next.range !== previous.range) sync(next);
  });

  // Sticky elements sit below this bar only while it is sticky itself (tablet and up).
  const phone = window.matchMedia('(max-width: 767px)');
  const publishHeight = () => {
    const height = phone.matches ? 0 : Math.round(root.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--tabs-h', `${height}px`);
  };
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(publishHeight);
    observer.observe(root);
  } else {
    window.addEventListener('resize', publishHeight);
  }
  if (typeof phone.addEventListener === 'function') phone.addEventListener('change', publishHeight);
  publishHeight();

  sync(store.getState());

  return {
    destroy() {
      if (observer) observer.disconnect();
    },
  };
}
