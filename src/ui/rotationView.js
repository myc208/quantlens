/**
 * rotationView.js: the Rotation tab (V3.3). Who has led and who has lagged.
 *
 *   x  relative strength over 3 months      y  relative strength over the last month
 *
 * One quadrant chart (Leading top right, Weakening bottom right, Lagging bottom left,
 * Improving top left) with either the eleven groups (their median member) or the 26
 * tradable assets, and two tables that say the same in words: the groups, and every asset
 * with its quadrant and trend regime. The chart is a picture for the mouse; the tables are
 * the accessible twin, and every value in them opens its working in the drawer.
 *
 * Benchmark: the S&P 500 in USD by default (one scale for the whole watchlist, SGD prices
 * converted at each day's rate), or each asset's own market. The choice is in the URL
 * (?rs=own); the groups/assets switch is a per-visit convenience and is not.
 *
 * The screener filters apply to the assets shown; a group's position is always the median
 * of all its members. The time range does not apply: the spans are fixed at 30 and 91 days.
 */

import { filterAssets, hasActiveFilters, ROTATION_BENCHMARKS } from '../core/store.js';
import { isNum } from '../core/precisionMath.js';
import { QUADRANTS } from '../engines/rotationEngine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BENCHMARK_LABELS = Object.freeze({ spx: 'S&P 500 (USD)', own: 'Own market' });
const PLOT_LABELS = Object.freeze({ groups: 'Groups', assets: 'Assets' });
// Where each quadrant sits: x sign, y sign.
const CORNERS = Object.freeze({ Leading: [1, 1], Weakening: [1, -1], Lagging: [-1, -1], Improving: [-1, 1] });

/** A "nice" axis step (1, 2 or 5 times a power of ten) for about `count` ticks. */
export function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  if (!(raw > 0)) return 0.01;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  let nice = 10;
  if (normalised < 1.5) nice = 1;
  else if (normalised < 3) nice = 2;
  else if (normalised < 7) nice = 5;
  return nice * magnitude;
}

/** Points to plot: the visible assets, or the groups with at least one visible member. */
export function plotPoints(analysis, visible, plot) {
  if (plot === 'groups') {
    return analysis.groups
      .filter((entry) => entry.members.some((ticker) => visible.has(ticker)) && entry.metric.status === 'ok')
      .map((entry) => ({
        key: entry.group.id, label: entry.group.name, x: entry.metric.meta.median3m, y: entry.metric.meta.median1m,
        quadrant: entry.metric.value, ticker: '', trace: entry.metric.id,
      }));
  }
  return Object.values(analysis.byTicker)
    .filter((entry) => visible.has(entry.asset.ticker) && entry.point.ok)
    .map((entry) => ({
      key: entry.asset.ticker, label: entry.asset.ticker, x: entry.point.rs3m.value, y: entry.point.rs1m.value,
      quadrant: entry.point.quadrant, ticker: entry.asset.ticker, trace: 'rotation',
    }));
}

export function mountRotationView(root, app) {
  const { store, actions, h } = app;
  const { esc } = h;
  let plot = 'groups';
  let dirty = true;
  let lastWidth = 0;
  let observer = null;

  const pct = (value, digits = 1) => (isNum(value) ? h.signedPercent(value, digits) : 'N/A');

  function svg(name, attributes = {}, text = null) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== null) node.textContent = text;
    return node;
  }

  function visibleTickers(state, analysis) {
    const shown = filterAssets(state.snapshot.assets, state.filters, app.trends()).map((asset) => asset.ticker);
    return new Set(shown.filter((ticker) => analysis.byTicker[ticker]));
  }

  /* ---------------- chart ---------------- */

  function drawChart(container, points) {
    container.textContent = '';
    if (!points.length) return;
    const width = Math.max(280, Math.floor(container.clientWidth));
    const height = Math.round(Math.min(460, Math.max(260, width * 0.62)));
    const compact = width < 480;
    const margin = { top: 14, right: 14, bottom: 34, left: compact ? 40 : 48 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const xMax = Math.max(0.02, ...points.map((point) => Math.abs(point.x))) * 1.15;
    const yMax = Math.max(0.02, ...points.map((point) => Math.abs(point.y))) * 1.15;
    const x = (value) => margin.left + ((value + xMax) / (2 * xMax)) * innerWidth;
    const y = (value) => margin.top + (1 - (value + yMax) / (2 * yMax)) * innerHeight;
    const node = svg('svg', { class: 'chart__svg rot-chart', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false' });

    // Quadrant fields and their names in the outer corners.
    for (const quadrant of QUADRANTS) {
      const [sx, sy] = CORNERS[quadrant];
      const left = sx > 0 ? x(0) : margin.left;
      const top = sy > 0 ? margin.top : y(0);
      node.appendChild(svg('rect', { class: `rot-field rot-field--${quadrant.toLowerCase()}`, x: left, y: top, width: innerWidth / 2, height: innerHeight / 2 }));
      node.appendChild(svg('text', {
        class: 'rot-qlabel', x: sx > 0 ? margin.left + innerWidth - 6 : margin.left + 6, y: sy > 0 ? margin.top + 14 : margin.top + innerHeight - 7,
        'text-anchor': sx > 0 ? 'end' : 'start',
      }, quadrant));
    }
    // Grid and ticks.
    const axisPct = (raw, stepSize) => {
      const value = Math.abs(raw) < 1e-12 ? 0 : raw; // a tick stepped to zero is not "−0%"
      return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(stepSize * 100 < 1 ? 1 : 0)}%`;
    };
    const xStep = niceStep(2 * xMax, compact ? 4 : 6);
    for (let value = Math.ceil(-xMax / xStep) * xStep; value <= xMax + 1e-12; value += xStep) {
      const at = x(value);
      node.appendChild(svg('line', { class: Math.abs(value) < 1e-12 ? 'chart__axis' : 'chart__grid', x1: at, x2: at, y1: margin.top, y2: margin.top + innerHeight }));
      node.appendChild(svg('text', { class: 'chart__tick', x: at, y: height - 18, 'text-anchor': 'middle' }, axisPct(value, xStep)));
    }
    const yStep = niceStep(2 * yMax, compact ? 4 : 6);
    for (let value = Math.ceil(-yMax / yStep) * yStep; value <= yMax + 1e-12; value += yStep) {
      const at = y(value);
      node.appendChild(svg('line', { class: Math.abs(value) < 1e-12 ? 'chart__axis' : 'chart__grid', x1: margin.left, x2: margin.left + innerWidth, y1: at, y2: at }));
      node.appendChild(svg('text', { class: 'chart__tick', x: margin.left - 6, y: at + 4, 'text-anchor': 'end' }, axisPct(value, yStep)));
    }
    node.appendChild(svg('text', { class: 'chart__tick rot-axis-title', x: margin.left + innerWidth / 2, y: height - 3, 'text-anchor': 'middle' }, 'Relative strength, 3 months →'));
    node.appendChild(svg('text', { class: 'chart__tick rot-axis-title', x: 11, y: margin.top + innerHeight / 2, 'text-anchor': 'middle', transform: `rotate(-90 11 ${margin.top + innerHeight / 2})` }, '1 month →'));

    // Points first, then labels placed greedily (right, left, above, below of the dot);
    // a label that would cover another label or a dot is left off, and the dot keeps its tooltip.
    const radius = plot === 'groups' ? 6 : 4.5;
    const placed = points.map((point) => ({ point, cx: x(point.x), cy: y(point.y) }));
    const boxes = placed.map(({ cx, cy }) => ({ left: cx - radius, right: cx + radius, top: cy - radius, bottom: cy + radius }));
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const inside = (box) => box.left >= margin.left && box.right <= margin.left + innerWidth && box.top >= margin.top && box.bottom <= margin.top + innerHeight;
    const hidden = [];
    // Points far from the centre are labelled first: they are the ones a reader looks for.
    const order = [...placed.keys()].sort((a, b) => (Math.abs(placed[b].point.x) / xMax + Math.abs(placed[b].point.y) / yMax)
      - (Math.abs(placed[a].point.x) / xMax + Math.abs(placed[a].point.y) / yMax));
    const labels = new Array(placed.length).fill(null);
    for (const index of order) {
      const { point, cx, cy } = placed[index];
      const width = point.label.length * 6.2 + 2;
      const candidates = [
        { x: cx + radius + 3, y: cy + 4, anchor: 'start', box: { left: cx + radius + 2, right: cx + radius + 3 + width, top: cy - 7, bottom: cy + 6 } },
        { x: cx - radius - 3, y: cy + 4, anchor: 'end', box: { left: cx - radius - 3 - width, right: cx - radius - 2, top: cy - 7, bottom: cy + 6 } },
        { x: cx, y: cy - radius - 4, anchor: 'middle', box: { left: cx - width / 2, right: cx + width / 2, top: cy - radius - 15, bottom: cy - radius - 2 } },
        { x: cx, y: cy + radius + 12, anchor: 'middle', box: { left: cx - width / 2, right: cx + width / 2, top: cy + radius + 1, bottom: cy + radius + 14 } },
      ];
      const spot = candidates.find((candidate) => inside(candidate.box) && !boxes.some((box) => overlaps(candidate.box, box)));
      if (spot) {
        labels[index] = spot;
        boxes.push(spot.box);
      } else {
        hidden.push(point.label);
      }
    }
    placed.forEach(({ point, cx, cy }, index) => {
      const group = svg('g', { class: `rot-point rot-point--${point.quadrant.toLowerCase()}`, 'data-action': 'trace', 'data-ticker': point.ticker, 'data-trace': point.trace });
      group.appendChild(svg('title', {}, `${point.label}: 3 months ${pct(point.x)}, 1 month ${pct(point.y)} (${point.quadrant})`));
      group.appendChild(svg('circle', { cx, cy, r: radius }));
      const spot = labels[index];
      if (spot) group.appendChild(svg('text', { class: 'rot-label', x: spot.x, y: spot.y, 'text-anchor': spot.anchor }, point.label));
      node.appendChild(group);
    });
    container.appendChild(node);
    const note = container.parentElement ? container.parentElement.querySelector('[data-role="hidden-labels"]') : null;
    if (note) note.textContent = hidden.length ? `Labels left off where the dots crowd: ${hidden.sort().join(', ')}. Hover a dot, or see the table.` : '';
  }

  /* ---------------- tables ---------------- */

  function quadrantButton(metric, ticker, scope) {
    const key = `rot|${scope}|${ticker || metric.id}`;
    if (!metric || metric.status !== 'ok') {
      return `<button type="button" class="cell cell--na" data-action="trace" data-ticker="${esc(ticker)}" data-trace="${esc(metric.id)}" data-key="${esc(key)}"
        title="${esc(metric.naReason)}" aria-label="${esc(`${ticker || metric.label}: not available. ${metric.naReason}`)}"><span class="badge badge--na">N/A</span></button>`;
    }
    return `<button type="button" class="cell" data-action="trace" data-ticker="${esc(ticker)}" data-trace="${esc(metric.id)}" data-key="${esc(key)}"
      aria-label="${esc(`${ticker || metric.meta.group.name}: ${metric.value}. Show how it is calculated.`)}">
      <span class="badge badge--trend badge--${metric.tone}">${h.toneMark(metric.tone)}${esc(metric.value)}</span></button>`;
  }

  function groupsTable(analysis, visible) {
    const rows = analysis.groups.filter((entry) => entry.members.some((ticker) => visible.has(ticker)));
    if (!rows.length) return '';
    return `
      <table class="data-table rot-table">
        <caption class="sr-only">Each group's median relative strength over 3 months and 1 month, its quadrant, and its members</caption>
        <thead><tr><th scope="col">Group</th><th scope="col">Quadrant</th><th scope="col">3 months</th><th scope="col">1 month</th><th scope="col">Members</th></tr></thead>
        <tbody>
          ${rows.map((entry) => {
    const meta = entry.metric.meta;
    return `
            <tr>
              <th scope="row">${esc(entry.group.name)}</th>
              <td>${quadrantButton(entry.metric, '', 'group')}</td>
              <td class="num">${esc(pct(meta.median3m))}</td>
              <td class="num">${esc(pct(meta.median1m))}</td>
              <td class="rot-members">${meta.members.map((member) => `<span class="rot-member${visible.has(member.ticker) ? '' : ' rot-member--hidden'}">${esc(member.ticker)}</span>`).join(' ')}</td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>`;
  }

  function assetsTable(analysis, visible) {
    const order = new Map(analysis.groups.map((entry, index) => [entry.group.id, index]));
    const rows = Object.values(analysis.byTicker).filter((entry) => visible.has(entry.asset.ticker))
      .sort((a, b) => (order.get(a.group.id) - order.get(b.group.id))
        || ((b.point.ok ? b.point.rs3m.value : -Infinity) - (a.point.ok ? a.point.rs3m.value : -Infinity))
        || a.asset.ticker.localeCompare(b.asset.ticker));
    if (!rows.length) return '<p class="empty-note">No assets match these filters. Reset the filters to see the whole watchlist.</p>';
    return `
      <table class="data-table rot-table">
        <caption class="sr-only">Every asset's relative strength over 3 months and 1 month, its quadrant and its trend regime</caption>
        <thead><tr><th scope="col">Asset</th><th scope="col">Group</th><th scope="col">Quadrant</th><th scope="col">3 months</th><th scope="col">1 month</th><th scope="col">Trend</th></tr></thead>
        <tbody>
          ${rows.map((entry) => {
    const { ticker } = entry.asset;
    const regime = app.trace(ticker, 'trendRegime');
    const regimeCell = regime && regime.status === 'ok'
      ? `<button type="button" class="cell" data-action="trace" data-ticker="${esc(ticker)}" data-trace="trendRegime" data-key="${esc(`rot|trend|${ticker}`)}"
          aria-label="${esc(`${ticker} trend regime: ${regime.value}. Show how it is calculated.`)}"><span class="badge badge--trend badge--${regime.tone}">${h.toneMark(regime.tone)}${esc(regime.value)}</span></button>`
      : '<span class="badge badge--na">N/A</span>';
    return `
            <tr>
              <th scope="row">${esc(ticker)}</th>
              <td>${esc(entry.group.name)}</td>
              <td>${quadrantButton(entry.metrics.rotation, ticker, 'asset')}</td>
              <td class="num">${esc(entry.point.ok ? pct(entry.point.rs3m.value) : 'N/A')}</td>
              <td class="num">${esc(entry.point.ok ? pct(entry.point.rs1m.value) : 'N/A')}</td>
              <td>${regimeCell}</td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>`;
  }

  /* ---------------- render ---------------- */

  function segmented(name, options, labels, current, legend) {
    return `
      <fieldset class="segmented" data-control="${esc(name)}">
        <legend class="sr-only">${esc(legend)}</legend>
        ${options.map((value) => `
          <label><input type="radio" name="${esc(name)}" value="${esc(value)}"${value === current ? ' checked' : ''}><span>${esc(labels[value])}</span></label>`).join('')}
      </fieldset>`;
  }

  function withFocus(update) {
    const active = document.activeElement;
    const key = active && root.contains(active) ? active.dataset.key || (active.name ? `input|${active.name}|${active.value}` : null) : null;
    update();
    if (!key) return;
    const again = key.startsWith('input|')
      ? root.querySelector(`input[name="${CSS.escape(key.split('|')[1])}"][value="${CSS.escape(key.split('|')[2])}"]`)
      : root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  function render() {
    const state = store.getState();
    if (!state.snapshot) {
      root.innerHTML = '';
      return;
    }
    dirty = false;
    const analysis = app.rotation();
    const visible = visibleTickers(state, analysis);
    const tradables = Object.keys(analysis.byTicker).length;
    const counts = QUADRANTS.map((quadrant) => [quadrant, [...visible].filter((ticker) => analysis.byTicker[ticker].point.ok && analysis.byTicker[ticker].point.quadrant === quadrant).length]);
    const missing = [...visible].filter((ticker) => !analysis.byTicker[ticker].point.ok);
    const against = analysis.mode === 'spx'
      ? 'the S&P 500 in USD (SGD prices converted at each day\'s USD/SGD rate)'
      : 'each asset\'s own market: the S&P 500 for US and London listings, the STI for SGX, Bitcoin for crypto';
    const points = plotPoints(analysis, visible, plot);
    const summary = `${PLOT_LABELS[plot]} plotted by relative strength over 3 months (across) and 1 month (up) against ${analysis.mode === 'spx' ? 'the S&P 500 in USD' : 'their own markets'}: `
      + counts.map(([quadrant, count]) => `${count} ${quadrant}`).join(', ') + ' assets. The tables below list every value.';

    withFocus(() => {
      root.innerHTML = `
        <header class="view-toolbar">
          <div>
            <h1 class="matrix__title" id="rotation-title">Rotation</h1>
            <p class="matrix__sub">${visible.size} of ${tradables} tradable assets${hasActiveFilters(state.filters) ? ' (filtered)' : ''} · relative strength against ${esc(against)} · 1 month = 30 days, 3 months = 91 days${analysis.asOf ? `, to ${esc(h.shortDate(analysis.asOf, true))}` : ''} · indices left out; the time range does not apply</p>
            <p class="matrix__sub">${counts.map(([quadrant, count]) => `${esc(quadrant)} ${count}`).join(' · ')}${missing.length ? ` · no reading: ${esc(missing.join(', '))}` : ''}</p>
          </div>
          <div class="toolbar-actions rot-controls">
            ${segmented('rotation-benchmark', ROTATION_BENCHMARKS, BENCHMARK_LABELS, state.rotation, 'Benchmark for relative strength')}
            ${segmented('rotation-plot', ['groups', 'assets'], PLOT_LABELS, plot, 'What the chart shows')}
          </div>
        </header>
        ${state.mode === 'guided' ? `
          <div class="guide-note guided-only">
            <span class="guide-note__badge">Guided</span>
            <span>Right of the centre line an asset has beaten the benchmark over 3 months; above it, over the last month. Leading (top right) is ahead on both, Weakening (bottom right) is ahead but slipping, Improving (top left) is behind but catching up, Lagging (bottom left) is behind on both. This describes the past: over 2022–2026 momentum did not predict the next month on this watchlist. Select a value in the tables to see its arithmetic.</span>
          </div>` : ''}
        <section class="card rot-card" aria-labelledby="rotation-chart-title">
          <div class="sandbox__block-title">
            <h2 class="panel-title" id="rotation-chart-title">${plot === 'groups' ? 'Groups (median member)' : 'Assets'}</h2>
            <span class="field__hint">${plot === 'groups' ? 'Each group sits at the median of all its members, whatever the filters.' : 'Select a dot, or a row below, to see its working.'}</span>
          </div>
          <div class="chart__plot rot-plot" data-role="chart" role="img" aria-label="${esc(summary)}"></div>
          <p class="field__hint" data-role="hidden-labels" aria-hidden="true"></p>
          ${points.length ? '' : '<p class="empty-note">Nothing to plot: no visible asset has a relative strength against this benchmark.</p>'}
        </section>
        <section class="card rot-card" aria-labelledby="rotation-groups-title">
          <div class="sandbox__block-title"><h2 class="panel-title" id="rotation-groups-title">Groups</h2></div>
          ${groupsTable(analysis, visible)}
        </section>
        <section class="card rot-card" aria-labelledby="rotation-assets-title">
          <div class="sandbox__block-title"><h2 class="panel-title" id="rotation-assets-title">Assets</h2></div>
          ${assetsTable(analysis, visible)}
        </section>`;
    });
    const chart = root.querySelector('[data-role="chart"]');
    lastWidth = Math.round(chart.clientWidth);
    drawChart(chart, points);
    markCurrent();
    if (typeof ResizeObserver === 'function' && !observer) {
      observer = new ResizeObserver(() => {
        const current = root.querySelector('[data-role="chart"]');
        if (!current || store.getState().view !== 'rotation') return;
        const width = Math.round(current.clientWidth);
        if (width === lastWidth || width === 0) return;
        lastWidth = width;
        const now = store.getState();
        const latest = app.rotation();
        drawChart(current, plotPoints(latest, visibleTickers(now, latest), plot));
      });
      observer.observe(root);
    }
  }

  function markCurrent() {
    const { drawer } = store.getState();
    for (const cell of root.querySelectorAll('[aria-current="true"]')) cell.removeAttribute('aria-current');
    if (!drawer.open || !drawer.trail.length) return;
    const selector = `button[data-action="trace"][data-trace="${CSS.escape(drawer.trail[0])}"][data-ticker="${CSS.escape(drawer.ticker ?? '')}"]`;
    for (const cell of root.querySelectorAll(selector)) cell.setAttribute('aria-current', 'true');
  }

  function renderIfVisible() {
    if (store.getState().view === 'rotation') render();
    else dirty = true;
  }

  /* ---------------- events ---------------- */

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action="trace"]');
    if (!control || !root.contains(control)) return;
    if (control.dataset.key) app.rememberTrigger(control.dataset.key);
    store.dispatch(actions.openTrace(control.dataset.ticker || null, control.dataset.trace));
  });

  root.addEventListener('change', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || control.type !== 'radio' || !control.checked) return;
    if (control.name === 'rotation-benchmark') store.dispatch(actions.setRotationBenchmark(control.value));
    else if (control.name === 'rotation-plot') {
      plot = control.value === 'assets' ? 'assets' : 'groups';
      render();
    }
  });

  store.subscribe((next, previous) => {
    const structural = next.snapshot !== previous.snapshot || next.filters !== previous.filters
      || next.rotation !== previous.rotation || next.mode !== previous.mode;
    if (next.view !== previous.view) {
      if (next.view === 'rotation' && (dirty || structural)) render();
      else if (structural) dirty = true;
      return;
    }
    if (structural) {
      renderIfVisible();
      return;
    }
    if (next.view === 'rotation' && next.drawer !== previous.drawer) markCurrent();
  });

  renderIfVisible();

  return {
    destroy() {
      if (observer) observer.disconnect();
    },
  };
}
