/**
 * telemetryBar.js: the sticky bar at the top of the page.
 *
 *   [brand] [BTC live] [ETH live] [feed status] [regime] [next macro] [USD/SGD] [US 10Y] [SG 10Y] [data age]   [USD|SGD] [Guided|Pro]
 *
 * It tells the user, at all times, where every number is coming from: which
 * feed is live, which has fallen back, how old the daily snapshot is and which
 * reference rate is in use. On mobile the readings become one horizontally
 * scrolling strip and the two switches sit on a second row.
 */

import { CURRENCIES, MODES, selectFx, selectPrice } from '../core/store.js';
import { isNum, safeDiv, formatNumber, formatPercent } from '../core/precisionMath.js';

const FEED_LABELS = Object.freeze({
  idle: 'Starting',
  connecting: 'Connecting',
  live: 'Live · Binance',
  polling: 'Delayed · Binance REST',
  offline: 'Offline · showing last close',
  paused: 'Paused',
  stopped: 'Stopped',
});

const FEED_TITLES = Object.freeze({
  live: 'Prices are streaming from the Binance public WebSocket.',
  polling: 'The live stream is unavailable. Prices are refreshed every 20 seconds over REST.',
  offline: 'Binance cannot be reached. Crypto prices are the last daily close from the snapshot.',
  connecting: 'Connecting to the Binance public market-data stream.',
  paused: 'The feed pauses while this tab is in the background.',
});

const MODE_LABELS = Object.freeze({ guided: 'Guided', pro: 'Pro' });

export function mountTelemetryBar(root, app) {
  const { store, actions, h } = app;

  root.innerHTML = `
    <div class="telemetry__brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">QuantLens</span>
    </div>
    <div class="telemetry__strip" id="telemetry-strip" role="group" aria-label="Live market data and data sources" tabindex="0">
      <span class="tick tick--placeholder">Loading market data…</span>
    </div>
    <div class="telemetry__controls">
      <fieldset class="segmented" data-control="currency">
        <legend class="sr-only">Display currency</legend>
        ${CURRENCIES.map((currency) => `
          <label>
            <input type="radio" name="display-currency" value="${currency}">
            <span>${currency}</span>
          </label>`).join('')}
      </fieldset>
      <fieldset class="segmented" data-control="mode">
        <legend class="sr-only">Explanation level</legend>
        ${MODES.map((mode) => `
          <label title="${mode === 'guided' ? 'Every metric is explained in plain language' : 'Denser view with extra rows and no explainers'}">
            <input type="radio" name="display-mode" value="${mode}">
            <span>${MODE_LABELS[mode]}</span>
          </label>`).join('')}
      </fieldset>
    </div>`;

  const strip = root.querySelector('#telemetry-strip');

  /* ---------------- switches ---------------- */

  function syncControls(state) {
    for (const radio of root.querySelectorAll('input[name="display-currency"]')) radio.checked = radio.value === state.currency;
    for (const radio of root.querySelectorAll('input[name="display-mode"]')) radio.checked = radio.value === state.mode;
  }

  root.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.checked) return;
    if (target.name === 'display-currency') store.dispatch(actions.setCurrency(target.value));
    if (target.name === 'display-mode') store.dispatch(actions.setMode(target.value));
  });

  /* ---------------- readings ---------------- */

  function cryptoAssets(state) {
    return state.snapshot ? state.snapshot.assets.filter((asset) => asset.assetClass === 'crypto') : [];
  }

  function changeMarkup(changePct) {
    if (!isNum(changePct)) return '';
    const direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
    const arrow = changePct > 0 ? '▲' : changePct < 0 ? '▼' : '■';
    const word = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'unchanged';
    return `<span class="delta delta--${direction}"><span aria-hidden="true">${arrow}</span><span class="sr-only">${word}</span> ${formatPercent(Math.abs(changePct), 2)}</span>`;
  }

  function cryptoTick(state, asset) {
    const quote = selectPrice(state, asset.ticker);
    const shown = h.money(quote.price, asset.currency);
    const changePct = quote.live ? safeDiv(quote.price - asset.quote.lastClose, asset.quote.lastClose)
      : safeDiv(asset.quote.lastClose - asset.quote.previousClose, asset.quote.previousClose);
    const symbol = asset.ticker.split('-')[0];
    const reference = quote.live ? 'since the last daily close' : 'last daily close against the one before';
    return `
      <span class="tick" data-tick="${h.esc(asset.ticker)}" title="${h.esc(asset.name)}: ${quote.live ? 'live price' : 'last daily close'}, change ${reference}">
        <span class="tick__label">${h.esc(symbol)}</span>
        <span class="tick__price">${h.esc(shown.currency)} ${formatNumber(shown.value, shown.value >= 100 ? 0 : 2)}</span>
        ${changeMarkup(changePct)}
      </span>`;
  }

  function feedMarkup(state) {
    const status = state.live.feeds.crypto;
    const label = FEED_LABELS[status] ?? status;
    return `
      <span class="feed" data-status="${h.esc(status)}" title="${h.esc(FEED_TITLES[status] ?? '')}">
        <span class="feed__dot" aria-hidden="true"></span>
        <span>${h.esc(label)}</span>
      </span>`;
  }

  function fxTick(state) {
    const fx = selectFx(state);
    if (!fx) return '';
    const origin = fx.live ? 'ECB reference' : 'snapshot';
    const title = fx.live
      ? 'European Central Bank daily reference rate via Frankfurter. It is published once per working day and is not a live quote.'
      : 'The reference-rate service could not be reached, so the rate stored in the daily snapshot is used.';
    return `
      <span class="tick" title="${h.esc(title)}">
        <span class="tick__label">USD/SGD</span>
        <span class="tick__price">${formatNumber(fx.rate, 4)}</span>
        <span class="tick__meta">${origin}${fx.asOf ? ` · ${h.esc(h.shortDate(fx.asOf))}` : ''}</span>
      </span>`;
  }

  /** The 10-year government yields used as the risk-free rate in the Sharpe ratio. */
  function yieldTicks(state) {
    const rates = state.snapshot.macro ? state.snapshot.macro.riskFree : null;
    if (!rates) return '';
    const labels = { USD: 'US 10Y', SGD: 'SG 10Y' };
    const notes = {
      fresh: 'Used as the risk-free rate for portfolios measured in this currency.',
      stale: 'The latest reading could not be fetched, so an older one is shown and used.',
      proxy: 'No reading was available for this currency, so the US 10-year yield stands in for it.',
    };
    return Object.entries(labels).map(([currency, label]) => {
      const rate = rates[currency];
      if (!rate || !isNum(rate.yield)) {
        return `
          <span class="tick" title="${h.esc(`No ${label} yield is available. The Sharpe ratio in ${currency} will show N/A.`)}">
            <span class="tick__label">${label}</span>
            <span class="tick__price">N/A</span>
          </span>`;
      }
      const meta = [rate.status === 'proxy' ? 'US proxy' : rate.status === 'stale' ? 'older' : '', rate.asOf ? h.shortDate(rate.asOf) : ''].filter(Boolean).join(' · ');
      return `
        <span class="tick"${rate.status === 'fresh' ? '' : ' data-freshness="aging"'} title="${h.esc(`${rate.name ?? label}. ${notes[rate.status] ?? ''}`)}">
          <span class="tick__label">${label}</span>
          <span class="tick__price">${formatPercent(rate.yield, 2)}</span>
          ${meta ? `<span class="tick__meta">${h.esc(meta)}</span>` : ''}
        </span>`;
    }).join('');
  }

  /** The market regime from the VIX curve. A button: it opens the derivation. */
  function regimeTick() {
    const regime = app.describeRegime();
    const analysis = app.regime();
    if (!regime.state) {
      const reason = analysis.metrics.marketRegime.naReason ?? 'The VIX curve is not available.';
      return `
        <span class="tick" title="${h.esc(reason)}">
          <span class="tick__label">Regime</span>
          <span class="tick__price">N/A</span>
        </span>`;
    }
    const title = `Market regime: ${regime.label.toLowerCase()}. ${regime.headline}. Context only: it changes no score, verdict or position size. Select to see how it is read.`;
    return `
      <button type="button" class="tick tick--button" data-trace="marketRegime" data-key="telemetry:marketRegime" data-regime="${regime.state}"
        aria-label="${h.esc(title)}" title="${h.esc(title)}">
        ${h.toneMark(regime.tone)}
        <span class="tick__label">Regime</span>
        <span class="tick__price">${h.esc(regime.label)}</span>
        <span class="tick__meta">${h.esc(regime.pill)}</span>
      </button>`;
  }

  /** The next FOMC decision or CPI release, amber within 48 hours. A button: it opens the derivation. */
  function macroTick() {
    const macro = app.describeMacro();
    if (!macro.title) return '';
    const metric = app.macro().metrics.nextMacroEvent;
    const title = `${macro.title}: ${h.shortDate(metric.meta.date)}, ${metric.meta.clock}. Context only. Select to see the next 7 and 30 days.`;
    return `
      <button type="button" class="tick tick--button" data-trace="nextMacroEvent" data-key="telemetry:nextMacroEvent" data-macro="${macro.soon ? 'soon' : 'later'}"
        aria-label="${h.esc(title)}" title="${h.esc(title)}">
        ${h.toneMark(macro.soon ? 'caution' : 'neutral')}
        <span class="tick__label">Next macro</span>
        <span class="tick__price">${h.esc(macro.label)}</span>
        <span class="tick__meta">${h.esc(macro.pill)}</span>
      </button>`;
  }

  function dataTick(state) {
    const { snapshot } = state;
    const generated = Date.parse(snapshot.generatedAt);
    const ageHours = Number.isFinite(generated) ? Math.max(0, (Date.now() - generated) / 3600000) : null;
    let freshness = 'stale';
    if (ageHours === null) freshness = 'unknown';
    else if (ageHours <= 36) freshness = 'fresh';
    else if (ageHours <= 96) freshness = 'aging';
    const stale = snapshot.staleTickers.length;
    const titles = {
      fresh: 'The daily snapshot is up to date.',
      aging: 'The daily snapshot is more than a day and a half old. The refresh job may have missed a run.',
      stale: 'The daily snapshot is several days old. The refresh job is probably failing.',
      unknown: '',
    };
    return `
      <span class="tick" data-freshness="${freshness}" title="${h.esc(`${titles[freshness]} Generated ${snapshot.generatedAt}.`)}">
        <span class="tick__label">Daily data</span>
        <span class="tick__price">${h.esc(h.shortDate(snapshot.generatedAt.slice(0, 10)))}</span>
        <span class="tick__meta">${h.esc(h.relativeAge(ageHours))}${stale ? ` · ${stale} asset${stale > 1 ? 's' : ''} older` : ''}</span>
      </span>`;
  }

  function renderStrip() {
    const state = store.getState();
    if (state.status === 'error') {
      strip.innerHTML = '<span class="tick tick--placeholder">Market data unavailable</span>';
      return;
    }
    if (!state.snapshot) {
      strip.innerHTML = '<span class="tick tick--placeholder">Loading market data…</span>';
      return;
    }
    const crypto = cryptoAssets(state);
    strip.innerHTML = [
      ...crypto.map((asset) => cryptoTick(state, asset)),
      crypto.length ? feedMarkup(state) : '',
      regimeTick(),
      macroTick(),
      fxTick(state),
      yieldTicks(state),
      dataTick(state),
    ].join('');
  }

  /** Live ticks replace only the affected reading, so the strip never loses its scroll position. */
  function patchPrices(next, previous) {
    for (const asset of cryptoAssets(next)) {
      if (next.live.prices[asset.ticker] === previous.live.prices[asset.ticker]) continue;
      const node = strip.querySelector(`[data-tick="${CSS.escape(asset.ticker)}"]`);
      if (!node) continue;
      const template = document.createElement('template');
      template.innerHTML = cryptoTick(next, asset).trim();
      node.replaceWith(template.content.firstElementChild);
    }
  }

  /* ---------------- wiring ---------------- */

  strip.addEventListener('click', (event) => {
    const control = event.target.closest('[data-trace]');
    if (!control || !strip.contains(control)) return;
    app.rememberTrigger(control.dataset.key);
    store.dispatch(actions.openTrace(null, control.dataset.trace));
  });

  store.subscribe((next, previous) => {
    if (next.currency !== previous.currency || next.mode !== previous.mode) syncControls(next);
    const structural = next.snapshot !== previous.snapshot || next.status !== previous.status
      || next.currency !== previous.currency || next.live.fx !== previous.live.fx
      || next.live.feeds !== previous.live.feeds;
    if (structural) renderStrip();
    else if (next.live.prices !== previous.live.prices) patchPrices(next, previous);
  });

  // The age label ("3 h ago") should keep moving even when nothing else changes.
  const ageTimer = setInterval(() => {
    if (store.getState().snapshot && !document.hidden) renderStrip();
  }, 60000);

  // Publish the bar's real height so sticky table headers and the drawer sit exactly below it.
  const publishHeight = () => {
    document.documentElement.style.setProperty('--telemetry-h', `${Math.round(root.getBoundingClientRect().height)}px`);
  };
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(publishHeight);
    observer.observe(root);
  } else {
    window.addEventListener('resize', publishHeight);
  }
  publishHeight();

  syncControls(store.getState());
  renderStrip();

  return {
    destroy() {
      clearInterval(ageTimer);
      if (observer) observer.disconnect();
    },
  };
}
