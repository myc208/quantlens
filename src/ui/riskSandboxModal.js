/**
 * riskSandboxModal.js: a safe place to change account and risk settings.
 *
 * Left: the four personal inputs (account size, risk per trade, stop distance,
 * maximum position size). Right: the resulting position for one of the
 * compared assets and a Monte Carlo fan of where its price could go, with the
 * stop and the 2R target drawn on it.
 *
 * The simulation itself runs in the Web Worker. This module asks for it
 * (app.requestSimulation) whenever an input changes and renders whatever is in
 * state.compute.monteCarlo: the previous fan stays on screen, dimmed, until the
 * new one arrives, and a late reply for older inputs is discarded by the store.
 * Its volatility is estimated from the selected time range.
 *
 * Privacy: the inputs live in the in-memory store only. They are never written
 * to the URL, to browser storage or to any network request.
 *
 * Built on the native <dialog> element, so focus trapping, Escape and focus
 * return are handled by the browser.
 */

import { ACCOUNT_LIMITS, DEFAULT_ACCOUNT } from '../core/store.js';
import { isNum, safeDiv } from '../core/precisionMath.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VERDICT_SIZE_NOTES = Object.freeze({
  BUY: 'BUY verdict: full size',
  HOLD: 'HOLD verdict: half size',
  SELL: 'SELL verdict: no new position',
});

/** A "nice" axis step (1, 2 or 5 times a power of ten) for about `count` ticks. */
function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  let nice = 10;
  if (normalised < 1.5) nice = 1;
  else if (normalised < 3) nice = 2;
  else if (normalised < 7) nice = 5;
  return nice * magnitude;
}

export function mountRiskSandboxModal(dialog, app) {
  const { store, actions, h } = app;
  const { esc } = h;
  let useHistoricalDrift = false;
  let resultsTimer = null;
  let fan = null; // geometry and data of the chart currently on screen
  let resizeObserver = null;

  /* ------------------------------------------------------------------ */
  /* Shell and inputs                                                    */
  /* ------------------------------------------------------------------ */

  function riskLimits(mode) {
    return mode === 'pro' ? ACCOUNT_LIMITS.riskPct.pro : ACCOUNT_LIMITS.riskPct.guided;
  }

  function renderShell() {
    const state = store.getState();
    const risk = riskLimits(state.mode);
    dialog.innerHTML = `
      <header class="modal__header">
        <div>
          <h2 class="modal__title" id="sandbox-title">Risk sandbox</h2>
          <p class="modal__sub">Change your own numbers and watch the suggested position and the range of outcomes respond.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close" aria-label="Close the risk sandbox">×</button>
      </header>
      <div class="modal__body">
        <div class="sandbox">
          <form class="sandbox__inputs" data-role="inputs" novalidate>
            <div class="field">
              <label class="field__label" for="sandbox-equity">Account size</label>
              <div class="input-group">
                <span class="input-group__prefix" data-role="currency">${esc(state.currency)}</span>
                <input class="input" id="sandbox-equity" name="equity" type="number" inputmode="decimal"
                  min="${ACCOUNT_LIMITS.equity.min}" max="${ACCOUNT_LIMITS.equity.max}" step="100" aria-describedby="sandbox-equity-hint">
              </div>
              <span class="field__hint" id="sandbox-equity-hint">The total you trade with, in your display currency.</span>
            </div>

            <div class="field range-field">
              <div class="range-field__top">
                <label class="field__label" for="sandbox-risk">Risk per trade</label>
                <span class="range-field__value" data-value="riskPct"></span>
              </div>
              <input class="range" id="sandbox-risk" name="riskPct" type="range" min="${risk.min}" max="${risk.max}" step="0.25" aria-describedby="sandbox-risk-hint">
              <span class="field__hint" id="sandbox-risk-hint">${state.mode === 'pro'
    ? 'The share of the account you accept losing if the stop is hit. Above 2% is aggressive.'
    : 'The share of the account you accept losing if the stop is hit. Guided mode caps this at 2%; 1% is a common choice.'}</span>
            </div>

            <div class="field range-field">
              <div class="range-field__top">
                <label class="field__label" for="sandbox-atr">Stop distance</label>
                <span class="range-field__value" data-value="atrMultiple"></span>
              </div>
              <input class="range" id="sandbox-atr" name="atrMultiple" type="range" min="${ACCOUNT_LIMITS.atrMultiple.min}" max="${ACCOUNT_LIMITS.atrMultiple.max}" step="0.5" aria-describedby="sandbox-atr-hint">
              <span class="field__hint" id="sandbox-atr-hint">How many typical days of movement (ATR) below your entry the stop sits. Wider stops mean smaller positions.</span>
            </div>

            <div class="field range-field">
              <div class="range-field__top">
                <label class="field__label" for="sandbox-cap">Maximum position size</label>
                <span class="range-field__value" data-value="maxPositionPct"></span>
              </div>
              <input class="range" id="sandbox-cap" name="maxPositionPct" type="range" min="${ACCOUNT_LIMITS.maxPositionPct.min}" max="${ACCOUNT_LIMITS.maxPositionPct.max}" step="5" aria-describedby="sandbox-cap-hint">
              <span class="field__hint" id="sandbox-cap-hint">The most of your account one position may use, however tight its stop.</span>
            </div>

            <label class="checkbox pro-only">
              <input type="checkbox" name="historicalDrift"${useHistoricalDrift ? ' checked' : ''}>
              <span>Assume last year's average return continues</span>
            </label>

            <p class="sandbox__privacy">These numbers stay in this tab's memory. They are not saved, not added to the share link and not sent anywhere.</p>
            <div class="sandbox__actions">
              <button type="button" class="btn btn--sm" data-action="reset">Reset to defaults</button>
            </div>
          </form>
          <div class="sandbox__results" data-role="results"></div>
        </div>
      </div>`;
    syncInputs(true);
  }

  function syncInputs(force = false) {
    const state = store.getState();
    const form = dialog.querySelector('[data-role="inputs"]');
    if (!form) return;
    const risk = riskLimits(state.mode);
    const riskInput = form.elements.riskPct;
    riskInput.min = String(risk.min);
    riskInput.max = String(risk.max);
    for (const name of Object.keys(DEFAULT_ACCOUNT)) {
      const control = form.elements[name];
      if (control && (force || document.activeElement !== control)) control.value = String(state.account[name]);
    }
    const labels = {
      riskPct: `${h.formatNumber(state.account.riskPct, 2)}%`,
      atrMultiple: `${h.formatNumber(state.account.atrMultiple, 1)} × ATR`,
      maxPositionPct: `${h.formatNumber(state.account.maxPositionPct, 0)}% of account`,
    };
    for (const [name, text] of Object.entries(labels)) {
      const output = form.querySelector(`[data-value="${name}"]`);
      if (output) output.textContent = text;
      const control = form.elements[name];
      if (control) control.setAttribute('aria-valuetext', text);
    }
    const prefix = form.querySelector('[data-role="currency"]');
    if (prefix) prefix.textContent = state.currency;
  }

  /* ------------------------------------------------------------------ */
  /* Results: sizing tiles                                               */
  /* ------------------------------------------------------------------ */

  function activeTicker(state, comparison) {
    if (comparison.tickers.includes(state.sandbox.ticker)) return state.sandbox.ticker;
    return comparison.tickers[0] ?? null;
  }

  function stat(label, value, note, lead = false) {
    return `
      <div class="stat${lead ? ' stat--lead' : ''}">
        <div class="stat__label">${esc(label)}</div>
        <div class="stat__value">${esc(value)}</div>
        ${note ? `<div class="stat__note">${esc(note)}</div>` : ''}
      </div>`;
  }

  function sizingBlock(state, comparison, ticker) {
    const sizing = comparison.sizings[ticker];
    const { heat } = comparison;
    if (!sizing || !sizing.ok) {
      const reason = sizing ? sizing.metrics.positionSize.naReason : 'This asset is not in the comparison.';
      return `<div class="guide-note"><span class="guide-note__badge">Note</span><span>${esc(reason)}</span></div>`;
    }
    const s = sizing.summary;
    const verdict = sizing.metrics.positionSize.meta.verdict;
    const pct = (value, digits = 2) => h.formatPercent(value, digits);
    const stopMove = safeDiv(s.stop - s.entryPrice, s.entryPrice);
    const targetMove = safeDiv(s.target - s.entryPrice, s.entryPrice);
    const tiles = [
      stat('Suggested size', `${h.formatUnits(s.units)} ${s.unitName}`, VERDICT_SIZE_NOTES[verdict] ?? 'No verdict: no new position', true),
      stat('Position value', `${s.accountCurrency} ${h.formatAmount(s.positionValue)}`, `${pct(s.pctOfAccount)} of account${s.capBinding ? ' · at your cap' : ''}`),
      stat('Amount at risk', `${s.accountCurrency} ${h.formatAmount(s.amountAtRisk)}`, `${pct(s.riskPctActual)} of account`),
      stat('Entry price', `${s.assetCurrency} ${h.formatAmount(s.entryPrice)}`, sizing.metrics.stopLoss.trace.rawInputs[0].source),
      stat('Stop-loss', `${s.assetCurrency} ${h.formatAmount(s.stop)}`, `${pct(stopMove, 1)} · ${h.formatNumber(state.account.atrMultiple, 1)} × ATR`),
      stat('2R target', `${s.assetCurrency} ${h.formatAmount(s.target)}`, `+${pct(targetMove, 1)}`),
      stat('Correlation haircut', pct(s.haircut, 0), s.haircut < 0.999 ? 'Size cut for overlap with the other assets' : 'No overlap to adjust for'),
      stat('Total risk, all positions', heat.status === 'ok' ? pct(heat.value) : 'N/A', heat.status === 'ok' ? `${state.currency} ${h.formatAmount(heat.meta.total)} if every stop is hit` : ''),
    ];
    const zero = s.zeroReason ? `<div class="guide-note"><span class="guide-note__badge">Why zero</span><span>${esc(s.zeroReason)}</span></div>` : '';
    return `${zero}<div class="stat-grid">${tiles.join('')}</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Results: Monte Carlo block                                          */
  /* ------------------------------------------------------------------ */

  function priceText(value) {
    return h.formatAmount(value);
  }

  function simulationBlock(state, comparison, ticker) {
    const asset = state.snapshot.byTicker[ticker];
    const job = app.simulation(ticker);
    const simulation = job.result;
    const note = (badge, text) => `<div class="guide-note"><span class="guide-note__badge">${esc(badge)}</span><span>${esc(text)}</span></div>`;
    if (!simulation) {
      if (job.status === 'error') return { html: note('Error', job.error ?? 'The simulation failed.'), simulation: null };
      return {
        html: `<div class="sim-status" role="status"><span class="spinner" aria-hidden="true"></span><span>Simulating ${esc(ticker)} off the main thread…</span></div>`,
        simulation: null,
      };
    }
    if (!simulation.ok) return { html: note('Note', simulation.metrics.monteCarlo.naReason), simulation: null };
    const { params, horizons, outcomes } = simulation;
    const range = h.rangeInfo(state.range);
    const stale = job.status === 'running';
    let timing = '';
    if (stale) timing = 'Recalculating…';
    else if (isNum(job.ms)) timing = `Simulated ${job.mode === 'worker' ? 'in a Web Worker' : 'on the main thread'} in ${job.ms < 1 ? 'under 1' : h.formatNumber(job.ms, 0)} ms`;
    const start = horizons.length ? simulation.fan.p50[0] : null;
    const longest = horizons[horizons.length - 1];
    const move = (value) => {
      const change = safeDiv(value - start, start);
      return isNum(change) ? `${change >= 0 ? '+' : ''}${h.formatPercent(change, 1)}` : '';
    };
    const summary = `Simulated price range for ${ticker} over ${params.days} trading days. In 90% of ${h.formatNumber(params.paths, 0)} paths the final price is between ${asset.currency} ${priceText(longest.p05)} and ${asset.currency} ${priceText(longest.p95)}; the median is ${asset.currency} ${priceText(longest.p50)}. The table below lists every horizon.`;

    const horizonTable = `
      <table class="data-table">
        <caption class="sr-only">Simulated price of ${esc(ticker)} at each horizon</caption>
        <thead>
          <tr><th scope="col">Horizon</th><th scope="col">5th percentile</th><th scope="col">Median</th><th scope="col">95th percentile</th></tr>
        </thead>
        <tbody>
          ${horizons.map((row) => `
            <tr>
              <th scope="row">${row.days} trading days</th>
              <td>${esc(priceText(row.p05))} <span class="stat__note">${esc(move(row.p05))}</span></td>
              <td>${esc(priceText(row.p50))} <span class="stat__note">${esc(move(row.p50))}</span></td>
              <td>${esc(priceText(row.p95))} <span class="stat__note">${esc(move(row.p95))}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    let outcomeBlock = '';
    if (outcomes) {
      const parts = [
        { id: 'stop', name: 'Stop reached first', count: outcomes.stopFirst },
        { id: 'target', name: 'Target reached first', count: outcomes.targetFirst },
        { id: 'neither', name: 'Neither reached', count: outcomes.neither },
      ];
      const share = (count) => h.formatPercent(count / outcomes.paths, 0);
      outcomeBlock = `
        <div>
          <div class="sandbox__block-title">
            <h3>Which level is reached first?</h3>
            <span class="field__hint">Within ${params.days} trading days, checked on daily closes</span>
          </div>
          <div class="outcome-bar" role="img" aria-label="${esc(parts.map((part) => `${part.name}: ${share(part.count)}`).join('. '))}">
            ${parts.filter((part) => part.count > 0).map((part) => `<span class="outcome-bar__part outcome-bar__part--${part.id}" style="flex:${part.count} 1 0" title="${esc(`${part.name}: ${share(part.count)}`)}"></span>`).join('')}
          </div>
          <div class="outcome-legend">
            ${parts.map((part) => `<span class="outcome-legend__item"><span class="legend__key outcome-bar__part--${part.id}" aria-hidden="true"></span>${esc(part.name)} <strong>${share(part.count)}</strong></span>`).join('')}
          </div>
        </div>`;
    }

    const explainer = app.explain('probStopFirst');
    const guide = `
      <div class="guide-note guided-only">
        <span class="guide-note__badge">Guide</span>
        <span>${esc(app.explain('monteCarlo').what)} The model assumes no trend at all: a year of returns is too little to predict the next. How widely the paths spread comes from the volatility of the selected time range. ${outcomes ? esc(explainer.healthy) : ''}</span>
      </div>`;

    const html = `
      <div class="${stale ? 'is-stale' : ''}" data-role="simulation">
      <div>
        <div class="sandbox__block-title">
          <h3>Range of outcomes for ${esc(ticker)}</h3>
          <span class="field__hint">${h.formatNumber(params.paths, 0)} simulated paths · prices in ${esc(asset.currency)} · volatility ${h.formatPercent(params.sigmaAnnual, 0)} a year, from the last ${esc(range.label)} · ${params.driftMode === 'zero' ? 'no trend assumed' : `the last ${esc(range.label)}'s trend assumed`}</span>
        </div>
        <div class="chart">
          <div class="chart__plot" data-role="fan" tabindex="0" role="img" aria-label="${esc(summary)}"></div>
          <div class="legend" aria-hidden="true">
            <span class="legend__item"><span class="legend__key legend__key--median"></span>Median path</span>
            <span class="legend__item"><span class="legend__key legend__key--inner"></span>Middle 50% of paths</span>
            <span class="legend__item"><span class="legend__key legend__key--outer"></span>90% of paths</span>
            ${outcomes ? '<span class="legend__item"><span class="legend__key legend__key--target"></span>2R target</span><span class="legend__item"><span class="legend__key legend__key--stop"></span>Stop-loss</span>' : ''}
          </div>
        </div>
      </div>
      ${horizonTable}
      ${outcomeBlock}
      <p class="field__hint" role="status">${esc(timing)}</p>
      </div>
      ${guide}`;
    return { html, simulation };
  }

  /* ------------------------------------------------------------------ */
  /* Fan chart                                                           */
  /* ------------------------------------------------------------------ */

  function svg(name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function drawFan(plot, simulation, levels) {
    const width = Math.max(260, Math.floor(plot.clientWidth));
    const height = Math.round(Math.min(320, Math.max(210, width * 0.44)));
    const labelsInside = width < 480;
    const margin = { top: 16, right: levels.length && !labelsInside ? 96 : 14, bottom: 28, left: 52 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const data = simulation.fan;
    const maxDay = data.days[data.days.length - 1];

    let low = Math.min(...data.p05, ...levels.map((level) => level.value));
    let high = Math.max(...data.p95, ...levels.map((level) => level.value));
    const padding = (high - low) * 0.05 || high * 0.05;
    low -= padding;
    high += padding;

    const step = niceStep(high - low, 5);
    const ticks = [];
    for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-9; value += step) ticks.push(value);
    const tickText = (value) => {
      if (high >= 10000) return h.formatCompact(value, step < 1000 ? 1 : 0);
      if (step >= 1) return h.formatNumber(value, 0);
      return h.formatNumber(value, step >= 0.1 ? 1 : 2);
    };

    const x = (day) => margin.left + (day / maxDay) * plotWidth;
    const y = (value) => margin.top + (1 - (value - low) / (high - low)) * plotHeight;
    const line = (values) => values.map((value, day) => `${day === 0 ? 'M' : 'L'}${x(day).toFixed(1)},${y(value).toFixed(1)}`).join('');
    const band = (upper, lower) => {
      let path = line(upper);
      for (let day = lower.length - 1; day >= 0; day -= 1) path += `L${x(day).toFixed(1)},${y(lower[day]).toFixed(1)}`;
      return `${path}Z`;
    };

    const root = svg('svg', { class: 'chart__svg', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false' });

    for (const tick of ticks) {
      root.append(svg('line', { class: 'chart__grid', x1: margin.left, x2: margin.left + plotWidth, y1: y(tick), y2: y(tick) }));
      const label = svg('text', { class: 'chart__tick', x: margin.left - 8, y: y(tick), 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = tickText(tick);
      root.append(label);
    }
    root.append(svg('line', { class: 'chart__axis', x1: margin.left, x2: margin.left + plotWidth, y1: margin.top + plotHeight, y2: margin.top + plotHeight }));

    const horizonDays = [0, ...simulation.horizons.map((row) => row.days)];
    horizonDays.forEach((day, position) => {
      let anchor = 'middle';
      if (position === 0) anchor = 'start';
      else if (position === horizonDays.length - 1) anchor = 'end';
      const label = svg('text', { class: 'chart__tick', x: x(day), y: height - 8, 'text-anchor': anchor });
      // On a narrow chart "Today" and "21 days" would collide, so both shorten.
      if (labelsInside) label.textContent = day === 0 ? 'Now' : `${day}d`;
      else label.textContent = day === 0 ? 'Today' : `${day} days`;
      root.append(label);
    });

    root.append(svg('path', { class: 'chart__band-outer', d: band(data.p95, data.p05) }));
    root.append(svg('path', { class: 'chart__band-inner', d: band(data.p75, data.p25) }));
    root.append(svg('path', { class: 'chart__median', d: line(data.p50) }));

    for (const level of levels) {
      const levelY = y(level.value);
      root.append(svg('line', { class: `chart__level chart__level--${level.id}`, x1: margin.left, x2: margin.left + plotWidth, y1: levelY, y2: levelY }));
      const label = labelsInside
        ? svg('text', { class: 'chart__level-label', x: margin.left + plotWidth - 4, y: levelY + (level.id === 'stop' ? 13 : -5), 'text-anchor': 'end' })
        : svg('text', { class: 'chart__level-label', x: margin.left + plotWidth + 6, y: levelY, 'dominant-baseline': 'middle' });
      label.textContent = `${level.label} ${priceText(level.value)}`;
      root.append(label);
    }

    const cursor = svg('line', { class: 'chart__cursor', x1: 0, x2: 0, y1: margin.top, y2: margin.top + plotHeight, visibility: 'hidden' });
    root.append(cursor);
    root.append(svg('circle', { class: 'chart__start', cx: x(0), cy: y(data.p50[0]), r: 4.5 }));

    const tip = document.createElement('div');
    tip.className = 'chart__tip';
    tip.hidden = true;

    plot.replaceChildren(root, tip);
    fan = { plot, cursor, tip, data, maxDay, x, margin, plotWidth, width, day: null };
  }

  function showTip(day) {
    if (!fan) return;
    const clamped = Math.min(fan.maxDay, Math.max(0, Math.round(day)));
    fan.day = clamped;
    const position = fan.x(clamped);
    fan.cursor.setAttribute('x1', position);
    fan.cursor.setAttribute('x2', position);
    fan.cursor.setAttribute('visibility', 'visible');

    const { data, tip } = fan;
    tip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'chart__tip-title';
    title.textContent = clamped === 0 ? 'Today' : `After ${clamped} trading day${clamped === 1 ? '' : 's'}`;
    tip.append(title);
    const rows = [
      ['95th percentile', data.p95[clamped]],
      ['75th percentile', data.p75[clamped]],
      ['Median', data.p50[clamped]],
      ['25th percentile', data.p25[clamped]],
      ['5th percentile', data.p05[clamped]],
    ];
    for (const [name, value] of rows) {
      const row = document.createElement('div');
      row.className = 'chart__tip-row';
      const label = document.createElement('span');
      label.textContent = name;
      const number = document.createElement('strong');
      number.textContent = priceText(value);
      row.append(label, number);
      tip.append(row);
    }
    tip.hidden = false;
    // Keep the tooltip inside the plot: flip to the left of the cursor when it would overflow.
    const scale = fan.plot.clientWidth / fan.width;
    const cursorPx = position * scale;
    const tipWidth = tip.offsetWidth;
    const left = cursorPx + 12 + tipWidth > fan.plot.clientWidth ? Math.max(4, cursorPx - 12 - tipWidth) : cursorPx + 12;
    tip.style.left = `${left}px`;
  }

  function hideTip() {
    if (!fan) return;
    fan.cursor.setAttribute('visibility', 'hidden');
    fan.tip.hidden = true;
    fan.day = null;
  }

  /* ------------------------------------------------------------------ */
  /* Results render                                                      */
  /* ------------------------------------------------------------------ */

  let lastSimulation = null;
  let lastLevels = [];

  function renderResults() {
    const container = dialog.querySelector('[data-role="results"]');
    if (!container || !dialog.open) return;
    const state = store.getState();
    const comparison = app.comparison();
    fan = null;
    if (!comparison.assets.length) {
      container.innerHTML = '<p class="empty-note">Select at least one asset in the screener to size a position and simulate outcomes.</p>';
      return;
    }
    const ticker = activeTicker(state, comparison);
    const active = document.activeElement;
    const focusedTab = active && container.contains(active) && active.dataset.action === 'tab' ? active.dataset.ticker : null;

    const { html, simulation } = simulationBlock(state, comparison, ticker);
    const sizing = comparison.sizings[ticker];
    container.innerHTML = `
      <div class="tabs" role="tablist" aria-label="Asset to size and simulate">
        ${comparison.tickers.map((item) => `<button type="button" class="tab" role="tab" data-action="tab" data-ticker="${esc(item)}" aria-selected="${item === ticker}" tabindex="${item === ticker ? '0' : '-1'}">${esc(item)}</button>`).join('')}
      </div>
      ${sizingBlock(state, comparison, ticker)}
      <div class="sandbox__actions">
        ${sizing && sizing.ok ? `<button type="button" class="btn btn--sm" data-action="show-trace" data-ticker="${esc(ticker)}" data-trace="positionSize">Show the sizing arithmetic</button>` : ''}
        ${simulation ? `<button type="button" class="btn btn--sm" data-action="show-trace" data-ticker="${esc(ticker)}" data-trace="monteCarlo">Show the simulation arithmetic</button>` : ''}
      </div>
      ${html}`;

    if (focusedTab) {
      const again = container.querySelector(`[data-action="tab"][data-ticker="${CSS.escape(ticker)}"]`);
      if (again) again.focus();
    }

    lastSimulation = simulation;
    lastLevels = sizing && sizing.ok
      ? [{ id: 'target', label: 'Target', value: sizing.summary.target }, { id: 'stop', label: 'Stop', value: sizing.summary.stop }]
      : [];
    const plot = container.querySelector('[data-role="fan"]');
    if (plot && simulation) drawFan(plot, simulation, lastLevels);
  }

  /** Ask the worker for the simulation that matches the current inputs. Identical inputs are not rerun. */
  function requestSimulation() {
    const state = store.getState();
    const comparison = app.comparison();
    const ticker = activeTicker(state, comparison);
    if (ticker) app.requestSimulation(ticker, { useHistoricalDrift });
  }

  /** An input changed: recompute the tiles now and ask for a new simulation. */
  function refresh() {
    requestSimulation();
    renderResults();
  }

  function scheduleResults() {
    clearTimeout(resultsTimer);
    resultsTimer = setTimeout(refresh, 90);
  }

  /* ------------------------------------------------------------------ */
  /* Open and close                                                      */
  /* ------------------------------------------------------------------ */

  function open() {
    if (dialog.open) return;
    if (store.getState().mode !== 'pro') useHistoricalDrift = false;
    renderShell();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    refresh();
    if (typeof ResizeObserver === 'function' && !resizeObserver) {
      let lastWidth = 0;
      resizeObserver = new ResizeObserver((entries) => {
        const width = Math.round(entries[0].contentRect.width);
        if (width === lastWidth || !fan || !lastSimulation) return;
        lastWidth = width;
        drawFan(fan.plot, lastSimulation, lastLevels);
      });
      const results = dialog.querySelector('[data-role="results"]');
      if (results) resizeObserver.observe(results);
    }
  }

  function close() {
    clearTimeout(resultsTimer);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    fan = null;
    if (dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  // Fired by Escape, by dialog.close() and by the browser's own dismissal.
  dialog.addEventListener('close', () => {
    if (store.getState().sandbox.open) store.dispatch(actions.closeSandbox());
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) { // a click on the backdrop
      store.dispatch(actions.closeSandbox());
      return;
    }
    const control = event.target.closest('[data-action]');
    if (!control) return;
    switch (control.dataset.action) {
      case 'close':
        store.dispatch(actions.closeSandbox());
        break;
      case 'tab':
        store.dispatch(actions.openSandbox(control.dataset.ticker));
        break;
      case 'reset':
        for (const [key, value] of Object.entries(DEFAULT_ACCOUNT)) store.dispatch(actions.setAccount(key, value));
        syncInputs(true);
        break;
      case 'show-trace': {
        // The drawer lives outside the modal, so close the modal first and then open the working.
        const { ticker, trace } = control.dataset;
        store.dispatch(actions.closeSandbox());
        app.rememberTrigger('toolbar|sandbox');
        store.dispatch(actions.openTrace(ticker, trace));
        break;
      }
      default:
        break;
    }
  });

  dialog.addEventListener('input', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement)) return;
    if (control.type === 'range') store.dispatch(actions.setAccount(control.name, Number(control.value)));
  });

  dialog.addEventListener('change', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement)) return;
    if (control.name === 'historicalDrift') {
      useHistoricalDrift = control.checked;
      scheduleResults();
      return;
    }
    if (control.type === 'number') {
      const value = Number(control.value);
      if (control.value !== '' && Number.isFinite(value)) store.dispatch(actions.setAccount(control.name, value));
      control.value = String(store.getState().account[control.name]); // show the clamped value
    }
  });

  dialog.addEventListener('submit', (event) => event.preventDefault());

  // Arrow keys move between asset tabs.
  dialog.addEventListener('keydown', (event) => {
    const tab = event.target.closest ? event.target.closest('[role="tab"]') : null;
    if (tab && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const tabs = [...dialog.querySelectorAll('[role="tab"]')];
      const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      if (next) {
        event.preventDefault();
        next.focus();
        store.dispatch(actions.openSandbox(next.dataset.ticker));
      }
      return;
    }
    // Keyboard reading of the chart: the same tooltip as hover.
    if (fan && event.target === fan.plot) {
      const current = fan.day ?? fan.maxDay;
      const jump = event.shiftKey ? 5 : 1;
      if (event.key === 'ArrowRight') showTip(current + jump);
      else if (event.key === 'ArrowLeft') showTip(current - jump);
      else if (event.key === 'Home') showTip(0);
      else if (event.key === 'End') showTip(fan.maxDay);
      else return;
      event.preventDefault();
    }
  });

  dialog.addEventListener('pointermove', (event) => {
    if (!fan || !fan.plot.contains(event.target)) return;
    const box = fan.plot.getBoundingClientRect();
    const scale = fan.width / box.width;
    const position = (event.clientX - box.left) * scale;
    showTip(((position - fan.margin.left) / fan.plotWidth) * fan.maxDay);
  });

  dialog.addEventListener('pointerout', (event) => {
    if (!fan || !fan.plot.contains(event.target)) return;
    if (event.relatedTarget && fan.plot.contains(event.relatedTarget)) return;
    if (document.activeElement !== fan.plot) hideTip();
  });

  dialog.addEventListener('focusin', (event) => {
    if (fan && event.target === fan.plot && fan.day === null) showTip(fan.maxDay);
  });

  dialog.addEventListener('focusout', (event) => {
    if (fan && event.target === fan.plot) hideTip();
  });

  store.subscribe((next, previous) => {
    if (next.sandbox.open !== previous.sandbox.open) {
      if (next.sandbox.open) open();
      else close();
      return;
    }
    if (!next.sandbox.open) return;
    if (next.account !== previous.account || next.mode !== previous.mode || next.currency !== previous.currency) syncInputs();
    if (next.account !== previous.account || next.sandbox !== previous.sandbox || next.selected !== previous.selected
      || next.currency !== previous.currency || next.live.fx !== previous.live.fx || next.range !== previous.range) {
      scheduleResults();
    } else if (next.compute.monteCarlo !== previous.compute.monteCarlo) {
      // The worker answered (or started): redraw without asking again.
      renderResults();
    }
  });

  return {
    destroy() {
      close();
    },
  };
}
