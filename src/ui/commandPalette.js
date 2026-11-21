/**
 * commandPalette.js: the Ctrl/Cmd + K overlay.
 *
 * One text box finds any asset on the watchlist and every command in the
 * app: switch view, change the time range, currency or explanation level,
 * open the risk sandbox, copy the share link.
 *
 * Accessibility
 *   - A native modal <dialog>: the browser traps focus, closes on Escape and
 *     returns focus to whatever was focused before.
 *   - The WAI-ARIA combobox pattern with a listbox popup. Focus never leaves
 *     the text box; the highlighted option is announced through
 *     aria-activedescendant, so a screen reader reads each option as the
 *     arrow keys move.
 *   - The number of results is announced in a polite live region.
 *   - Options are plain rows, not buttons: there is exactly one tab stop.
 *
 * Ranking is a pure function (rankCommands) so it can be unit-tested.
 */

import {
  VIEWS, RANGES, CURRENCIES, MODES, selectPortfolioWeights, hasActiveFilters, hasCustomPortfolio,
} from '../core/store.js';

/* ------------------------------------------------------------------ */
/* Ranking (pure)                                                      */
/* ------------------------------------------------------------------ */

const WORD_BREAK = /[\s\-_.\/()]+/;

function normalise(text) {
  return String(text ?? '').toLowerCase().trim();
}

/** True when every character of `needle` appears in `haystack` in order ("lbd" in "leaderboard"). */
function isSubsequence(needle, haystack) {
  let position = 0;
  for (const character of haystack) {
    if (character === needle[position]) position += 1;
    if (position === needle.length) return true;
  }
  return needle.length === 0;
}

function scoreToken(token, title, words, keywords) {
  if (title === token) return 100;
  if (title.startsWith(token)) return 80;
  if (words.some((word) => word.startsWith(token))) return 60;
  if (title.includes(token)) return 45;
  if (keywords.some((keyword) => keyword === token)) return 40;
  if (keywords.some((keyword) => keyword.startsWith(token))) return 30;
  if (keywords.some((keyword) => keyword.includes(token))) return 20;
  // Typo-tolerant last resort, only for tokens long enough to mean something.
  if (token.length >= 3 && isSubsequence(token, title)) return 8;
  return 0;
}

/**
 * How well a command matches a query: 0 means "no match". Every word of the
 * query must match somewhere (the title or the keywords), so "btc port"
 * narrows instead of widening.
 *
 * @param {{ title:string, keywords?:string[] }} command
 * @param {string} query
 * @returns {number}
 */
export function scoreCommand(command, query) {
  const tokens = normalise(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  const title = normalise(command.title);
  const words = title.split(WORD_BREAK).filter(Boolean);
  const keywords = (command.keywords ?? []).map(normalise).filter(Boolean);
  let total = 0;
  for (const token of tokens) {
    const score = scoreToken(token, title, words, keywords);
    if (score === 0) return 0;
    total += score;
  }
  return total / tokens.length;
}

/**
 * Filter and order commands for a query. Best match first; equal scores keep
 * their original order, so the list is stable while the user types. An empty
 * query returns everything in its original order.
 *
 * @param {object[]} commands
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {object[]}
 */
export function rankCommands(commands, query, { limit = 50 } = {}) {
  const list = Array.isArray(commands) ? commands : [];
  if (!normalise(query)) return list.slice(0, limit);
  return list
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.command);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const VIEW_LABELS = Object.freeze({ compare: 'Compare', leaderboard: 'Leaderboard', portfolio: 'Portfolio' });
const VIEW_KEYWORDS = Object.freeze({
  compare: ['matrix', 'side by side', 'comparison', 'view', 'tab'],
  leaderboard: ['ranking', 'rank', 'table', 'watchlist', 'scores', 'view', 'tab'],
  portfolio: ['allocation', 'weights', 'sharpe', 'mpt', 'frontier', 'view', 'tab'],
});
const MODE_LABELS = Object.freeze({ guided: 'Guided', pro: 'Pro' });
const GROUP_ORDER = Object.freeze(['Go to', 'Assets', 'Time range', 'Settings', 'Actions']);

export function mountCommandPalette(dialog, app) {
  const { store, actions, h } = app;
  const { esc } = h;
  let commands = [];
  let results = [];
  let activeIndex = 0;

  dialog.innerHTML = `
    <div class="palette__input-row">
      <span class="palette__icon" aria-hidden="true"></span>
      <input class="palette__input" id="palette-input" type="text" role="combobox" aria-expanded="true"
        aria-controls="palette-list" aria-autocomplete="list" aria-label="Search assets and commands"
        placeholder="Search assets and commands…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
      <kbd aria-hidden="true">Esc</kbd>
    </div>
    <div class="palette__list" id="palette-list" role="listbox" aria-label="Assets and commands"></div>
    <div class="sr-only" role="status" aria-live="polite" data-role="count"></div>
    <div class="palette__footer" aria-hidden="true">
      <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
      <span><kbd>Enter</kbd> run</span>
      <span><kbd>Esc</kbd> close</span>
    </div>`;

  const inputBox = dialog.querySelector('#palette-input');
  const list = dialog.querySelector('#palette-list');
  const count = dialog.querySelector('[data-role="count"]');

  /* ---------------- commands ---------------- */

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      store.dispatch(actions.notify('Link copied. It opens this exact view, time range, currency and mode.'));
    } catch (error) {
      store.dispatch(actions.notify('Copying is blocked here. Copy the address from the address bar instead: it already contains this view.'));
    }
  }

  function assetCommand(asset, state) {
    const analysis = app.analysis(asset.ticker);
    const regime = analysis ? analysis.technical.metrics.trendRegime : null;
    const trend = regime && regime.status === 'ok' ? regime.value : null;
    const market = asset.market === 'CRYPTO' ? 'Crypto' : asset.market;
    const base = {
      group: 'Assets',
      title: asset.ticker,
      hint: `${asset.name} · ${market}${trend ? ` · ${trend}` : ''}`,
      keywords: [asset.name, asset.sector, market, asset.assetClass, trend, 'asset', 'ticker'].filter(Boolean),
    };
    // In the Portfolio view an asset is added to (or removed from) the allocation;
    // everywhere else it is added to (or removed from) the comparison.
    if (state.view === 'portfolio') {
      const held = selectPortfolioWeights(state).some((entry) => entry.ticker === asset.ticker);
      return {
        ...base,
        id: `asset:${asset.ticker}`,
        meta: held ? 'Remove from portfolio' : 'Add to portfolio',
        run: () => store.dispatch(held ? actions.removePortfolioAsset(asset.ticker) : actions.addPortfolioAsset(asset.ticker)),
      };
    }
    const selected = state.selected.includes(asset.ticker);
    return {
      ...base,
      id: `asset:${asset.ticker}`,
      meta: selected ? 'Remove from comparison' : 'Add to comparison',
      run: () => store.dispatch(actions.toggleTicker(asset.ticker)),
    };
  }

  function buildCommands() {
    const state = store.getState();
    const built = [];
    for (const view of VIEWS) {
      built.push({
        id: `view:${view}`, group: 'Go to', title: VIEW_LABELS[view],
        hint: view === state.view ? 'You are here' : '', keywords: VIEW_KEYWORDS[view],
        meta: 'View', run: () => store.dispatch(actions.setView(view)),
      });
    }
    if (state.snapshot) {
      for (const asset of state.snapshot.assets) built.push(assetCommand(asset, state));
    }
    for (const range of RANGES) {
      const info = h.rangeInfo(range);
      built.push({
        id: `range:${range}`, group: 'Time range', title: `Time range: ${info.title}`,
        hint: range === state.range ? 'Current' : '', keywords: [info.short, range, 'slicer', 'period', 'window', 'chart'],
        meta: info.short, run: () => store.dispatch(actions.setRange(range)),
      });
    }
    for (const currency of CURRENCIES) {
      built.push({
        id: `currency:${currency}`, group: 'Settings', title: `Show amounts in ${currency}`,
        hint: currency === state.currency ? 'Current' : '', keywords: ['currency', 'fx', currency === 'SGD' ? 'singapore dollar' : 'us dollar'],
        meta: 'Currency', run: () => store.dispatch(actions.setCurrency(currency)),
      });
    }
    for (const mode of MODES) {
      built.push({
        id: `mode:${mode}`, group: 'Settings', title: `${MODE_LABELS[mode]} mode`,
        hint: mode === state.mode ? 'Current' : mode === 'guided' ? 'Every metric explained in plain language' : 'Denser view with extra rows',
        keywords: ['mode', 'explanations', 'explainers', mode === 'pro' ? 'dense advanced expert' : 'beginner learn help'],
        meta: 'Mode', run: () => store.dispatch(actions.setMode(mode)),
      });
    }
    if (state.selected.length) {
      built.push({
        id: 'action:sandbox', group: 'Actions', title: 'Open the risk sandbox',
        hint: 'Position size and simulated outcomes', keywords: ['monte carlo', 'simulate', 'simulation', 'position size', 'account', 'stop'],
        meta: 'Action', run: () => store.dispatch(actions.openSandbox(store.getState().selected[0] ?? null)),
      });
    }
    built.push({
      id: 'action:copy', group: 'Actions', title: 'Copy share link',
      hint: 'The address already holds this exact view', keywords: ['url', 'share', 'link', 'clipboard'],
      meta: 'Action', run: copyLink,
    });
    if (hasActiveFilters(state.filters)) {
      built.push({
        id: 'action:filters', group: 'Actions', title: 'Reset screener filters',
        hint: '', keywords: ['filter', 'clear', 'screener'], meta: 'Action', run: () => store.dispatch(actions.resetFilters()),
      });
    }
    if (hasCustomPortfolio(state)) {
      built.push({
        id: 'action:portfolio-reset', group: 'Actions', title: 'Reset the portfolio',
        hint: 'Back to the compared assets at equal weights', keywords: ['portfolio', 'weights', 'allocation', 'clear'],
        meta: 'Action', run: () => store.dispatch(actions.resetPortfolio()),
      });
    }
    built.push({
      id: 'action:reload', group: 'Actions', title: 'Reload market data',
      hint: 'Fetch the daily snapshot again', keywords: ['refresh', 'snapshot', 'update', 'data'],
      meta: 'Action', run: () => app.reload(),
    });
    return built;
  }

  /* ---------------- rendering ---------------- */

  function optionMarkup(command, index) {
    const active = index === activeIndex;
    return `
      <div class="palette__option" role="option" id="palette-option-${index}" data-index="${index}" aria-selected="${active}">
        <span class="palette__option-main">
          <span class="palette__option-title">${esc(command.title)}</span>
          ${command.hint ? `<span class="palette__option-hint">${esc(command.hint)}</span>` : ''}
        </span>
        <span class="palette__option-meta">${esc(command.meta ?? '')}</span>
      </div>`;
  }

  function renderList() {
    const query = inputBox.value;
    results = rankCommands(commands, query, { limit: 60 });
    if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);

    if (results.length === 0) {
      list.innerHTML = `<div class="palette__empty">Nothing matches “${esc(query.trim())}”. Try a ticker, a company name or a command such as “portfolio”.</div>`;
    } else if (query.trim()) {
      // While searching, the best match comes first regardless of its group.
      list.innerHTML = results.map((command, index) => optionMarkup(command, index)).join('');
    } else {
      // With no query the list is grouped, so it doubles as a menu of everything available.
      const ordered = [];
      for (const group of GROUP_ORDER) ordered.push(...results.filter((command) => command.group === group));
      results = ordered;
      let index = 0;
      list.innerHTML = GROUP_ORDER.map((group, position) => {
        const members = results.filter((command) => command.group === group);
        if (members.length === 0) return '';
        const markup = members.map((command) => {
          const html = optionMarkup(command, index);
          index += 1;
          return html;
        }).join('');
        return `<div role="group" aria-labelledby="palette-group-${position}"><div class="palette__group-label" id="palette-group-${position}">${esc(group)}</div>${markup}</div>`;
      }).join('');
    }
    count.textContent = results.length === 0 ? 'No results.' : `${results.length} result${results.length === 1 ? '' : 's'}.`;
    syncActive(false);
  }

  function syncActive(scroll = true) {
    for (const option of list.querySelectorAll('[role="option"]')) {
      option.setAttribute('aria-selected', String(Number(option.dataset.index) === activeIndex));
    }
    const active = list.querySelector(`#palette-option-${activeIndex}`);
    if (active) {
      inputBox.setAttribute('aria-activedescendant', active.id);
      if (scroll) active.scrollIntoView({ block: 'nearest' });
    } else {
      inputBox.removeAttribute('aria-activedescendant');
    }
  }

  function move(delta) {
    if (results.length === 0) return;
    activeIndex = (activeIndex + delta + results.length) % results.length;
    syncActive();
  }

  /* ---------------- open, close, run ---------------- */

  function open() {
    if (dialog.open) return;
    commands = buildCommands();
    inputBox.value = '';
    activeIndex = 0;
    renderList();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    list.scrollTop = 0;
    inputBox.focus();
  }

  function close() {
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function run(index) {
    const command = results[index];
    if (!command) return;
    // Close first: the browser then returns focus to where it was, and a command
    // that opens another dialog (the risk sandbox) starts from a clean state.
    close();
    command.run();
  }

  /* ---------------- events ---------------- */

  inputBox.addEventListener('input', () => {
    activeIndex = 0;
    renderList();
    list.scrollTop = 0;
  });

  inputBox.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        if (results.length) { activeIndex = Math.min(results.length - 1, activeIndex + 8); syncActive(); }
        break;
      case 'PageUp':
        event.preventDefault();
        if (results.length) { activeIndex = Math.max(0, activeIndex - 8); syncActive(); }
        break;
      case 'Enter':
        event.preventDefault();
        run(activeIndex);
        break;
      default:
        break;
    }
  });

  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (option) run(Number(option.dataset.index));
  });

  // The pointer highlights without scrolling the list under it.
  list.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[role="option"]');
    if (!option) return;
    const index = Number(option.dataset.index);
    if (index !== activeIndex) {
      activeIndex = index;
      syncActive(false);
    }
  });

  // A click on the backdrop (the dialog element itself) closes the palette.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  // Ctrl+K on Windows and Linux, Cmd+K on macOS. Pressing it again closes the palette.
  document.addEventListener('keydown', (event) => {
    if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (dialog.open) close();
    else open();
  });

  return { open, close, isOpen: () => dialog.open };
}
