/**
 * portfolioSandbox.js: a multi-asset allocation and what it would have done.
 *
 * Left: the allocation. Up to eight assets, each with a slider and a
 * percentage box. By default it is the compared assets at equal weights; the
 * moment a weight is changed the allocation becomes its own thing and is
 * written to the URL (?p=AAPL:40,D05.SI:35,BTC-USD:25) so it can be shared.
 * Weights are percentages only: no amount of money is entered, stored or sent.
 *
 * Right: Modern Portfolio Theory statistics for the selected time range, in
 * the display currency: annualised return, volatility, Sharpe ratio against
 * the 10-year government yield, and the diversification ratio. Below them,
 * who carries the risk, and a seeded sample of 2,000 alternative mixes showing
 * where this allocation sits.
 *
 * None of the maths runs here. main.js sends the inputs to the Web Worker and
 * this module renders whatever is in state.compute.portfolio. While a newer
 * calculation is running the previous result stays on screen, dimmed.
 *
 * Every statistic is a button that opens its derivation in the drawer.
 *
 * V3.3 adds crash replays: the same weights bought at four S&P 500 highs and held to the
 * lows that followed, in the display currency, against the S&P 500 replayed the same way.
 * They come from app.crashReplays() (computed on the main thread and cached), not the worker.
 */

import { MAX_PORTFOLIO_ASSETS, hasCustomPortfolio } from '../core/store.js';
import { isNum } from '../core/precisionMath.js';
import { valueOf } from '../core/derivationTracer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Turn fractional weights into whole percentages that total exactly 100
 * (largest-remainder rounding), ready to be applied as an allocation.
 *
 * @param {{ ticker:string, weight:number }[]} allocation weights as fractions of 1
 * @returns {{ ticker:string, weight:number }[]} weights as whole percentages
 */
export function roundAllocation(allocation) {
  const list = (Array.isArray(allocation) ? allocation : []).filter((entry) => entry && isNum(entry.weight) && entry.weight >= 0);
  const total = list.reduce((sum, entry) => sum + entry.weight, 0);
  if (list.length === 0 || !(total > 0)) return [];
  const exact = list.map((entry) => (entry.weight / total) * 100);
  const whole = exact.map(Math.floor);
  let remaining = 100 - whole.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    whole[index] += 1;
    remaining -= 1;
  }
  return list.map((entry, index) => ({ ticker: entry.ticker, weight: whole[index] }));
}

/** A "nice" axis step (1, 2 or 5 times a power of ten) for about `count` ticks. */
function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  let nice = 10;
  if (normalised < 1.5) nice = 1;
  else if (normalised < 3) nice = 2;
  else if (normalised < 7) nice = 5;
  return nice * magnitude;
}

export function mountPortfolioSandbox(root, app) {
  const { store, actions, h } = app;
  const { esc } = h;
  let renderedTickers = '';
  let scatter = null; // geometry of the chart on screen, for hover
  let resizeObserver = null;

  root.innerHTML = `
    <header class="view-toolbar" data-role="toolbar"></header>
    <div class="portfolio">
      <section class="card portfolio__panel" aria-labelledby="alloc-title" data-role="allocation"></section>
      <div class="portfolio__results" data-role="results" aria-live="off"></div>
    </div>`;

  const toolbar = root.querySelector('[data-role="toolbar"]');
  const allocation = root.querySelector('[data-role="allocation"]');
  const results = root.querySelector('[data-role="results"]');

  const pct = (value, digits = 1) => h.formatPercent(value, digits);
  const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  const weightText = (value) => `${h.formatNumber(value, Number.isInteger(value) ? 0 : 2)}%`;

  /* ------------------------------------------------------------------ */
  /* Toolbar                                                             */
  /* ------------------------------------------------------------------ */

  function renderToolbar(state) {
    const range = h.rangeInfo(state.range);
    toolbar.innerHTML = `
      <div>
        <h1 class="matrix__title" id="portfolio-title">Portfolio sandbox</h1>
        <p class="matrix__sub">What this mix would have done over the last ${esc(range.label)}, in ${esc(state.currency)}. Weights are percentages only: no amount of money is entered, stored or shared.</p>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Allocation panel                                                    */
  /* ------------------------------------------------------------------ */

  function totalBlock(weights) {
    const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
    const balanced = Math.abs(total - 100) < 0.005;
    let note = 'The weights total 100%.';
    if (total <= 0) note = 'Give at least one asset a weight above zero.';
    else if (!balanced) note = `The weights total ${weightText(Math.round(total * 100) / 100)}. The statistics scale them to 100%, keeping their proportions; “Scale to 100%” does the same to the boxes.`;
    return { total, balanced, note };
  }

  function allocationRow(entry, state) {
    const asset = state.snapshot.byTicker[entry.ticker];
    const id = entry.ticker.replace(/[^a-zA-Z0-9]+/g, '-');
    return `
      <div class="alloc__row" data-ticker="${esc(entry.ticker)}">
        <label class="alloc__id" for="alloc-slider-${id}">
          <span class="alloc__ticker">${esc(entry.ticker)}</span>
          <span class="alloc__name">${esc(asset ? asset.name : '')}</span>
        </label>
        <div class="input-group alloc__weight">
          <input class="input" type="number" inputmode="decimal" min="0" max="100" step="1" value="${entry.weight}"
            data-role="weight-box" data-ticker="${esc(entry.ticker)}" data-key="${esc(`alloc|box|${entry.ticker}`)}" aria-label="${esc(`Weight of ${entry.ticker}, percent`)}">
          <span class="input-group__prefix" aria-hidden="true">%</span>
        </div>
        <button type="button" class="icon-btn alloc__remove" data-action="remove" data-ticker="${esc(entry.ticker)}" data-key="${esc(`alloc|remove|${entry.ticker}`)}"
          aria-label="${esc(`Remove ${entry.ticker} from the portfolio`)}">×</button>
        <input class="range alloc__slider" id="alloc-slider-${id}" type="range" min="0" max="100" step="1" value="${entry.weight}"
          data-role="weight-slider" data-ticker="${esc(entry.ticker)}" data-key="${esc(`alloc|slider|${entry.ticker}`)}" aria-valuetext="${esc(weightText(entry.weight))}">
      </div>`;
  }

  function renderAllocation(state) {
    const { weights } = app.portfolio();
    const held = new Set(weights.map((entry) => entry.ticker));
    const candidates = state.snapshot.assets.filter((asset) => !held.has(asset.ticker));
    const custom = hasCustomPortfolio(state);
    const { total, balanced, note } = totalBlock(weights);
    const full = weights.length >= MAX_PORTFOLIO_ASSETS;
    renderedTickers = weights.map((entry) => entry.ticker).join(',');

    const active = document.activeElement;
    const focusKey = active && allocation.contains(active) ? active.dataset.key : null;

    allocation.innerHTML = `
      <div class="portfolio__panel-title">
        <h2 class="panel-title" id="alloc-title">Allocation</h2>
        <span class="pill-note">${weights.length} of ${MAX_PORTFOLIO_ASSETS} assets${custom ? '' : ' · following the comparison'}</span>
      </div>
      ${weights.length ? `
        <div data-role="rows">${weights.map((entry) => allocationRow(entry, state)).join('')}</div>
        <div class="alloc__total"><span>Total</span><span data-role="total">${esc(weightText(Math.round(total * 100) / 100))}</span></div>
        <p class="alloc__note" data-role="total-note" aria-live="polite">${esc(note)}</p>
        <div class="alloc__actions">
          <button type="button" class="btn btn--sm" data-action="equalise" data-key="alloc|equal">Equal weights</button>
          <button type="button" class="btn btn--sm" data-action="normalise" data-key="alloc|normalise"${balanced || total <= 0 ? ' disabled' : ''}>Scale to 100%</button>
          <button type="button" class="btn btn--sm btn--ghost" data-action="reset" data-key="alloc|reset"${custom ? '' : ' hidden'}>Reset</button>
        </div>` : `
        <p class="empty-note">The portfolio is empty. Add an asset below, or tick assets in the screener and select Reset.</p>
        <div class="alloc__actions">
          <button type="button" class="btn btn--sm" data-action="reset" data-key="alloc|reset"${custom ? '' : ' hidden'}>Use the compared assets</button>
        </div>`}
      <form class="alloc__add" data-role="add" novalidate>
        <label class="sr-only" for="alloc-add-select">Asset to add</label>
        <select class="select" id="alloc-add-select" name="ticker" data-key="alloc|add-select"${full || candidates.length === 0 ? ' disabled' : ''}>
          ${candidates.length
    ? candidates.map((asset) => `<option value="${esc(asset.ticker)}">${esc(`${asset.ticker} · ${asset.name}`)}</option>`).join('')
    : '<option value="">Every asset is already held</option>'}
        </select>
        <button type="submit" class="btn btn--sm" data-key="alloc|add"${full || candidates.length === 0 ? ' disabled' : ''}>Add</button>
      </form>
      <p class="alloc__note">${full ? `A portfolio holds up to ${MAX_PORTFOLIO_ASSETS} assets here. Remove one to add another. ` : 'A new asset starts at 0%, so adding it never changes the mix you already set. '}The address bar holds this allocation as percentages, so the link reproduces it exactly.</p>`;

    if (focusKey) {
      const again = allocation.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  /** While a slider is being dragged the rows must not be rebuilt: only the numbers move. */
  function patchAllocation() {
    const { weights } = app.portfolio();
    const active = document.activeElement;
    for (const entry of weights) {
      const selector = `[data-ticker="${CSS.escape(entry.ticker)}"]`;
      const slider = allocation.querySelector(`[data-role="weight-slider"]${selector}`);
      const box = allocation.querySelector(`[data-role="weight-box"]${selector}`);
      if (slider) {
        if (slider !== active) slider.value = String(entry.weight);
        slider.setAttribute('aria-valuetext', weightText(entry.weight));
      }
      if (box && box !== active) box.value = String(entry.weight);
    }
    const { total, balanced, note } = totalBlock(weights);
    const totalNode = allocation.querySelector('[data-role="total"]');
    if (totalNode) totalNode.textContent = weightText(Math.round(total * 100) / 100);
    const noteNode = allocation.querySelector('[data-role="total-note"]');
    if (noteNode && noteNode.textContent !== note) noteNode.textContent = note;
    const normalise = allocation.querySelector('[data-action="normalise"]');
    if (normalise) normalise.disabled = balanced || total <= 0;
    const reset = allocation.querySelector('[data-action="reset"]');
    if (reset) reset.hidden = !hasCustomPortfolio(store.getState());
    const badge = allocation.querySelector('.portfolio__panel-title .pill-note');
    if (badge) badge.textContent = `${weights.length} of ${MAX_PORTFOLIO_ASSETS} assets${hasCustomPortfolio(store.getState()) ? '' : ' · following the comparison'}`;
  }

  function syncAllocation(state) {
    const tickers = app.portfolio().weights.map((entry) => entry.ticker).join(',');
    if (tickers !== renderedTickers || !allocation.firstElementChild) renderAllocation(state);
    else patchAllocation();
  }

  /* ------------------------------------------------------------------ */
  /* Results: statistic tiles                                            */
  /* ------------------------------------------------------------------ */

  function tile(metric, note, { lead = false } = {}) {
    const label = app.explain(metric.id).term || metric.label;
    const value = metric.status === 'ok'
      ? `${h.toneMark(metric.tone)}<span>${esc(h.formatMetric(metric))}</span>`
      : '<span class="badge badge--na">N/A</span>';
    return `
      <button type="button" class="stat stat--button${lead ? ' stat--lead' : ''}" data-action="trace" data-trace="${esc(metric.id)}" data-key="${esc(`pf|${metric.id}`)}"
        ${metric.status === 'ok' ? '' : `title="${esc(metric.naReason)}"`} aria-label="${esc(`${label}: ${h.describeMetric(metric)}. Show how it is calculated.`)}">
        <span class="stat__label">${esc(label)}</span>
        <span class="stat__value stat__value-row">${value}</span>
        <span class="stat__note">${esc(metric.status === 'ok' ? note : metric.naReason)}</span>
      </button>`;
  }

  function tiles(analysis, state) {
    const { metrics } = analysis;
    const rate = metrics.riskFreeRate;
    const rateMeta = rate.meta ?? {};
    const rateName = rateMeta.name ?? `${state.currency} 10-year yield`;
    let rateNote = rateName;
    if (rateMeta.status === 'proxy') rateNote = `${rateName} · used as a stand-in`;
    else if (rateMeta.status === 'stale') rateNote = `${rateName} · older reading`;
    if (rateMeta.asOf) rateNote += ` · ${h.shortDate(rateMeta.asOf)}`;
    const unit = analysis.frequency === 'weekly' ? 'weekly' : 'daily';
    const periods = analysis.periodsPerYear ? `× ${analysis.periodsPerYear} ${unit === 'weekly' ? 'weeks' : 'days'} a year` : 'annualised';
    const beta = metrics.portfolioBeta;
    const betaNote = beta && beta.status === 'ok'
      ? `Beta-adjusted exposure ${pct(beta.value, 0)} of capital · ${beta.meta.frequency}` : '';
    const concentration = metrics.concentration;
    let concentrationNote = '';
    if (concentration && concentration.status === 'ok') {
      const meta = concentration.meta;
      if (meta.crowded) concentrationNote = `${listNames(meta.crowd)} move as one`;
      else if (meta.dominant) concentrationNote = `Mostly ${meta.dominant} on its own`;
      else concentrationNote = 'No dominant common driver';
    }
    const bets = metrics.effectiveBets;
    return `
      <div class="stat-grid">
        ${tile(metrics.sharpeRatio, 'Return above the risk-free rate, per unit of risk', { lead: true })}
        ${tile(metrics.portfolioReturn, `Average ${unit} return ${periods}`)}
        ${tile(metrics.portfolioVolatility, `From ${analysis.observations} ${unit} returns`)}
        ${tile(metrics.diversificationRatio, '1.00 means no benefit from mixing')}
        ${beta ? tile(beta, betaNote) : ''}
        ${concentration ? tile(concentration, concentrationNote) : ''}
        ${bets && state.mode === 'pro' ? tile(bets, bets.status === 'ok' ? `From ${bets.meta.holdings} holdings` : '') : ''}
        ${tile(rate, rateNote)}
      </div>`;
  }

  /** A plain warning when several holdings are one bet in disguise. */
  function crowdBanner(analysis) {
    const metric = analysis.metrics.concentration;
    if (!metric || metric.status !== 'ok' || !metric.meta.crowded) return '';
    const bets = analysis.metrics.effectiveBets;
    const betsText = bets && bets.status === 'ok' ? ` The portfolio behaves like about ${h.formatNumber(bets.value, 1)} independent bets.` : '';
    return `
      <div class="banner banner--danger" role="note">
        ${h.toneMark('risky')}
        <div>
          <p class="banner__title">One crowded bet: ${esc(listNames(metric.meta.crowd))}</p>
          <p>${esc(metric.trace.interpretation.summary)}${esc(betsText)} When one of them falls, the others have tended to fall with it.</p>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Results: who carries the risk                                       */
  /* ------------------------------------------------------------------ */

  function riskBlock(analysis, state) {
    const rows = analysis.contributions.filter((row) => row.weight > 0);
    const widest = Math.max(0.0001, ...rows.map((row) => Math.max(row.weight, Math.abs(row.riskShare ?? 0))));
    const width = (value) => `${Math.max(0.5, (Math.abs(value) / widest) * 100).toFixed(1)}%`;
    const heaviest = rows.reduce((top, row) => (isNum(row.riskShare) && (!top || row.riskShare > top.riskShare) ? row : top), null);
    const summary = heaviest
      ? `${heaviest.ticker} is ${pct(heaviest.weight, 0)} of the money and ${pct(heaviest.riskShare, 0)} of the risk.`
      : 'Risk shares are not available because the portfolio showed no volatility.';
    const bars = rows.map((row) => `
      <div class="share-row" role="listitem">
        <span class="share-row__label">${esc(row.ticker)}</span>
        <span class="share-row__bars" aria-hidden="true">
          <span class="share-bar share-bar--weight" style="width:${width(row.weight)}"></span>
          ${isNum(row.riskShare) ? `<span class="share-bar ${row.riskShare < 0 ? 'share-bar--negative' : 'share-bar--risk'}" style="width:${width(row.riskShare)}"></span>` : ''}
        </span>
        <span class="share-row__values">${esc(pct(row.weight, 0))} → ${isNum(row.riskShare) ? esc(pct(row.riskShare, 0)) : 'N/A'}<span class="sr-only"> of the risk</span></span>
      </div>`).join('');
    const table = `
      <table class="data-table pro-only">
        <caption class="sr-only">Each asset's weight, annualised return and volatility, its share of the portfolio's return and risk, its beta to the S&amp;P 500, and its correlation with the portfolio's largest common driver</caption>
        <thead>
          <tr><th scope="col">Asset</th><th scope="col">Weight</th><th scope="col">Return</th><th scope="col">Volatility</th><th scope="col">Adds to return</th><th scope="col">Share of risk</th><th scope="col">Beta</th><th scope="col">Moves with the driver</th></tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <th scope="row">${esc(row.ticker)}</th>
              <td>${esc(pct(row.weight, 1))}</td>
              <td>${esc(h.signedPercent(row.annualReturn, 1))}</td>
              <td>${esc(pct(row.annualVolatility, 1))}</td>
              <td>${esc(h.signedPercent(row.returnContribution, 2))}</td>
              <td>${isNum(row.riskShare) ? esc(pct(row.riskShare, 1)) : 'N/A'}</td>
              <td>${isNum(row.beta) ? esc(h.formatNumber(row.beta, 2)) : 'N/A'}</td>
              <td>${isNum(row.driverCorrelation) ? esc(h.formatNumber(row.driverCorrelation, 2)) : 'N/A'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    return `
      <section class="card portfolio__panel" aria-labelledby="risk-share-title">
        <div class="sandbox__block-title">
          <h2 class="panel-title" id="risk-share-title">Who carries the risk</h2>
          <span class="field__hint">${esc(summary)}</span>
        </div>
        <div class="share-list" role="list" aria-label="Weight and share of risk for each asset">${bars}</div>
        <div class="legend" aria-hidden="true">
          <span class="legend__item"><span class="legend__key legend__key--weight"></span>Share of the money (weight)</span>
          <span class="legend__item"><span class="legend__key legend__key--risk"></span>Share of the risk</span>
        </div>
        ${table}
        ${state.mode === 'guided' ? `
          <div class="guide-note guided-only">
            <span class="guide-note__badge">Guide</span>
            <span>A volatile asset takes up more of the risk than of the money. If one bar on the blue row dwarfs the others, the portfolio's ups and downs are really that one asset's, whatever the weights say.</span>
          </div>` : ''}
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Results: crash replays (V3.3)                                        */
  /* ------------------------------------------------------------------ */

  /** The mix (solid) and the S&P 500 (dashed) through one window, both starting at 0%. */
  function replaySpark(path) {
    const series = [path.portfolio, ...(path.benchmark ? [path.benchmark] : [])];
    const all = series.flat();
    const low = Math.min(...all, 1);
    const high = Math.max(...all, 1);
    const span = high - low || 1;
    const last = path.portfolio.length - 1 || 1;
    const y = (value) => (2 + (1 - (value - low) / span) * 32).toFixed(2);
    const line = (values) => values.map((value, i) => `${i ? 'L' : 'M'}${((i / last) * 100).toFixed(2)} ${y(value)}`).join(' ');
    return `
      <svg class="replay__spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line class="replay__zero" x1="0" x2="100" y1="${y(1)}" y2="${y(1)}"></line>
        ${path.benchmark ? `<path class="replay__bench" d="${line(path.benchmark)}"></path>` : ''}
        <path class="replay__line" d="${line(path.portfolio)}"></path>
      </svg>`;
  }

  function replayCard(metric) {
    const window = metric.meta.window;
    const key = `pf|${metric.id}`;
    const title = `${window.name}${window.ongoing ? ' (ongoing)' : ''}`;
    if (metric.status !== 'ok') {
      return `
        <button type="button" class="replay" data-action="trace" data-trace="${esc(metric.id)}" data-key="${esc(key)}"
          aria-label="${esc(`${title}: not available. ${metric.naReason} Show how it is calculated.`)}">
          <span class="replay__name">${esc(title)}</span>
          <span class="replay__dates">${esc(h.shortDate(window.from, true))} →</span>
          <span class="badge badge--na">N/A</span>
          <span class="replay__note">${esc(metric.naReason)}</span>
        </button>`;
    }
    const m = metric.meta;
    const bench = m.benchmark;
    const end = m.window.to;
    const versus = bench ? `${h.formatNumber(Math.abs(m.excess) * 100, 1)} pts ${m.excess >= 0 ? 'better' : 'worse'} than the S&P 500` : 'No S&P 500 history to compare';
    const worst = m.worstDay ? `worst day ${h.signedPercent(m.worstDay.value, 1)} (${h.shortDate(m.worstDay.date, true)})` : '';
    const label = `${title}, ${h.shortDate(window.from, true)} to ${h.shortDate(end, true)}: this mix ${h.signedPercent(m.totalReturn, 1)}`
      + `${bench ? `, S&P 500 ${h.signedPercent(bench.totalReturn, 1)}, ${versus}` : ''}. Maximum drawdown ${h.signedPercent(m.maxDrawdown, 1)}${worst ? `, ${worst}` : ''}.`
      + `${m.rescaleNote ? ` ${m.rescaleNote}` : ''} Show how it is calculated.`;
    return `
      <button type="button" class="replay" data-action="trace" data-trace="${esc(metric.id)}" data-key="${esc(key)}" aria-label="${esc(label)}">
        <span class="replay__name">${esc(title)}</span>
        <span class="replay__dates">${esc(h.shortDate(window.from, true))} → ${esc(h.shortDate(end, true))}${window.ongoing ? ' · latest close' : window.recovered ? ` · recovered ${esc(h.shortDate(window.recovered, true))}` : ''}</span>
        <span class="replay__figures">
          <span class="replay__figure"><span class="replay__label"><span class="replay__key replay__key--mix"></span>This mix</span>
            <span class="replay__value">${h.toneMark(metric.tone)}${esc(h.signedPercent(m.totalReturn, 1))}</span></span>
          ${bench ? `<span class="replay__figure"><span class="replay__label"><span class="replay__key replay__key--bench"></span>S&amp;P 500</span>
            <span class="replay__value">${esc(h.signedPercent(bench.totalReturn, 1))}</span></span>` : ''}
        </span>
        <span class="replay__vs">${esc(versus)}</span>
        ${replaySpark(m.path)}
        <span class="replay__meta">Max drawdown ${esc(h.signedPercent(m.maxDrawdown, 1))}${worst ? ` · ${esc(worst)}` : ''}</span>
        ${m.rescaleNote ? `<span class="replay__note">⚠ ${esc(m.rescaleNote)}</span>` : ''}
      </button>`;
  }

  /** Pro: what each holding added to each replay, in percentage points of the mix's return. */
  function replayTable(metrics, weights) {
    const ok = metrics.filter((metric) => metric.status === 'ok');
    if (!ok.length) return '';
    const tickers = weights.filter((entry) => entry.weight > 0).map((entry) => entry.ticker);
    const cell = (metric, ticker) => {
      const row = metric.meta.holdings.find((item) => item.ticker === ticker);
      if (!row) return '<td><span class="cell__sub">left out</span></td>';
      return `<td>${esc(h.signedPercent(row.contribution, 1))}<span class="cell__sub"> own ${esc(h.signedPercent(row.ownReturn, 1))}</span></td>`;
    };
    return `
      <table class="data-table pro-only">
        <caption class="sr-only">What each holding added to each crash replay, with its own return over the window</caption>
        <thead><tr><th scope="col">Asset</th>${ok.map((metric) => `<th scope="col">${esc(metric.meta.window.short)}</th>`).join('')}</tr></thead>
        <tbody>
          ${tickers.map((ticker) => `<tr><th scope="row">${esc(ticker)}</th>${ok.map((metric) => cell(metric, ticker)).join('')}</tr>`).join('')}
          <tr><th scope="row">Mix</th>${ok.map((metric) => `<td><strong>${esc(h.signedPercent(metric.meta.totalReturn, 1))}</strong></td>`).join('')}</tr>
        </tbody>
      </table>`;
  }

  function crashBlock(state) {
    const replays = app.crashReplays();
    if (!replays || !replays.ok) return '';
    const metrics = Object.values(replays.metrics);
    return `
      <section class="card portfolio__panel" aria-labelledby="crash-title">
        <div class="sandbox__block-title">
          <h2 class="panel-title" id="crash-title">Crash replays</h2>
          <span class="field__hint">This mix bought at four S&amp;P 500 highs and held to the lows that followed, in ${esc(state.currency)}, at the weights you set. Unlike the statistics above, it ignores the time range.</span>
        </div>
        <div class="replay-grid">${metrics.map(replayCard).join('')}</div>
        <div class="legend" aria-hidden="true">
          <span class="legend__item"><span class="legend__key replay__key--mix"></span>This mix</span>
          <span class="legend__item"><span class="legend__key replay__key--bench"></span>S&amp;P 500, same currency</span>
        </div>
        ${replayTable(metrics, app.portfolio().weights)}
        ${state.mode === 'guided' ? `
          <div class="guide-note guided-only">
            <span class="guide-note__badge">Guided</span>
            <span>${esc(app.explain('crashReplay').why)} The windows were picked after the fact from the S&amp;P 500's own highs and lows, so this is how the mix behaved in those falls, not a forecast of the next one. Select a card for the day-by-day arithmetic.</span>
          </div>` : ''}
      </section>`;
  }

  /* ------------------------------------------------------------------ */
  /* Results: sample of alternative mixes                                */
  /* ------------------------------------------------------------------ */

  function mixText(candidate) {
    return roundAllocation(candidate.allocation).filter((entry) => entry.weight > 0)
      .map((entry) => `${entry.ticker} ${entry.weight}%`).join(' · ');
  }

  function suggestion(kind, title, candidate, analysis) {
    if (!candidate) return '';
    const stats = [`return ${h.signedPercent(candidate.ret, 1)}`, `volatility ${pct(candidate.risk, 1)}`];
    if (isNum(candidate.sharpe)) stats.push(`Sharpe ${h.formatNumber(candidate.sharpe, 2)}`);
    return `
      <div class="suggest">
        <span class="suggest__text"><strong>${esc(title)}:</strong> ${esc(mixText(candidate))} <span class="field__hint">(${esc(stats.join(', '))})</span></span>
        <button type="button" class="btn btn--sm" data-action="apply" data-mix="${esc(kind)}" data-key="${esc(`pf|apply|${kind}`)}"
          aria-label="${esc(`Apply the ${title.toLowerCase()} mix to the allocation`)}"${analysis.tickers.length < 2 ? ' disabled' : ''}>Apply</button>
      </div>`;
  }

  function frontierBlock(analysis, frontier, state) {
    if (!frontier || analysis.tickers.length < 2) {
      return `
        <section class="card portfolio__panel">
          <h2 class="panel-title">Alternative mixes</h2>
          <p class="empty-note">Add a second asset to see how other mixes of the same assets would have compared.</p>
        </section>`;
    }
    const range = h.rangeInfo(state.range);
    const yours = { ret: valueOf(analysis.metrics.portfolioReturn), risk: valueOf(analysis.metrics.portfolioVolatility) };
    const summary = `Risk and return of ${h.formatNumber(frontier.count, 0)} random mixes of ${analysis.tickers.join(', ')} over the last ${range.label}. `
      + `Your mix: volatility ${pct(yours.risk, 1)}, return ${h.signedPercent(yours.ret, 1)}. `
      + (frontier.maxSharpe ? `Highest Sharpe in the sample: volatility ${pct(frontier.maxSharpe.risk, 1)}, return ${h.signedPercent(frontier.maxSharpe.ret, 1)}. ` : '')
      + (frontier.minVariance ? `Lowest risk in the sample: volatility ${pct(frontier.minVariance.risk, 1)}, return ${h.signedPercent(frontier.minVariance.ret, 1)}.` : '');
    return `
      <section class="card portfolio__panel" aria-labelledby="frontier-title">
        <div class="sandbox__block-title">
          <h2 class="panel-title" id="frontier-title">Alternative mixes of the same assets</h2>
          <span class="field__hint">${h.formatNumber(frontier.count, 0)} random long-only mixes · last ${esc(range.label)} · ${esc(state.currency)}</span>
        </div>
        <div class="chart">
          <div class="chart__plot" data-role="scatter" role="img" aria-label="${esc(summary)}"></div>
          <div class="legend" aria-hidden="true">
            <span class="legend__item"><span class="legend__key legend__key--cloud"></span>Random mix</span>
            <span class="legend__item"><span class="legend__key legend__key--you"></span>Your mix</span>
            ${frontier.maxSharpe ? '<span class="legend__item"><span class="legend__key legend__key--best"></span>Highest Sharpe</span>' : ''}
            <span class="legend__item"><span class="legend__key legend__key--safe"></span>Lowest risk</span>
          </div>
        </div>
        ${suggestion('maxSharpe', 'Highest Sharpe in the sample', frontier.maxSharpe, analysis)}
        ${suggestion('minVariance', 'Lowest risk in the sample', frontier.minVariance, analysis)}
        <div class="banner banner--warning" role="note">
          ${h.toneMark('caution')}
          <div>
            <p class="banner__title">These are the best mixes in hindsight, not a recommendation</p>
            <p>The “highest Sharpe” mix is whichever random mix happened to do best over the last ${esc(range.label)}. It leans on whatever rose most, and past winners are not reliably next period's winners. Change the time range and it usually changes with it.</p>
          </div>
        </div>
      </section>`;
  }

  function svg(name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  function drawScatter(plot, analysis, frontier) {
    const width = Math.max(280, Math.floor(plot.clientWidth));
    const height = Math.round(Math.min(340, Math.max(220, width * 0.5)));
    const margin = { top: 14, right: 16, bottom: 40, left: 54 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const yours = { ret: valueOf(analysis.metrics.portfolioReturn), risk: valueOf(analysis.metrics.portfolioVolatility) };

    const risks = [...frontier.risk];
    const returns = [...frontier.ret];
    if (isNum(yours.risk) && isNum(yours.ret)) {
      risks.push(yours.risk);
      returns.push(yours.ret);
    }
    let minX = Math.min(...risks);
    let maxX = Math.max(...risks);
    let minY = Math.min(...returns);
    let maxY = Math.max(...returns);
    const padX = (maxX - minX) * 0.06 || 0.01;
    const padY = (maxY - minY) * 0.08 || 0.01;
    minX = Math.max(0, minX - padX);
    maxX += padX;
    minY -= padY;
    maxY += padY;

    const x = (risk) => margin.left + ((risk - minX) / (maxX - minX)) * plotWidth;
    const y = (ret) => margin.top + (1 - (ret - minY) / (maxY - minY)) * plotHeight;
    const axisPct = (value, stepSize) => `${(value * 100).toFixed(stepSize * 100 < 1 ? 1 : 0)}%`;

    const node = svg('svg', { class: 'chart__svg', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false' });

    const stepY = niceStep(maxY - minY, 5);
    for (let value = Math.ceil(minY / stepY) * stepY; value <= maxY + stepY * 1e-9; value += stepY) {
      const zero = Math.abs(value) < stepY * 1e-6;
      node.append(svg('line', { class: zero ? 'chart__axis' : 'chart__grid', x1: margin.left, x2: margin.left + plotWidth, y1: y(value), y2: y(value) }));
      const label = svg('text', { class: 'chart__tick', x: margin.left - 8, y: y(value), 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      label.textContent = axisPct(zero ? 0 : value, stepY);
      node.append(label);
    }
    const stepX = niceStep(maxX - minX, width < 480 ? 4 : 6);
    for (let value = Math.ceil(minX / stepX) * stepX; value <= maxX + stepX * 1e-9; value += stepX) {
      const label = svg('text', { class: 'chart__tick', x: x(value), y: margin.top + plotHeight + 16, 'text-anchor': 'middle' });
      label.textContent = axisPct(value, stepX);
      node.append(label);
    }
    node.append(svg('line', { class: 'chart__axis', x1: margin.left, x2: margin.left + plotWidth, y1: margin.top + plotHeight, y2: margin.top + plotHeight }));
    const xTitle = svg('text', { class: 'scatter__axis-title', x: margin.left + plotWidth / 2, y: height - 6, 'text-anchor': 'middle' });
    xTitle.textContent = 'Volatility (annualised) →';
    node.append(xTitle);
    const yTitle = svg('text', { class: 'scatter__axis-title', x: 12, y: margin.top + plotHeight / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${margin.top + plotHeight / 2})` });
    yTitle.textContent = 'Return (annualised) →';
    node.append(yTitle);

    // The whole cloud is one path of zero-length round-capped strokes: 2,000 dots, one DOM node.
    let cloud = '';
    for (let i = 0; i < frontier.risk.length; i += 1) cloud += `M${x(frontier.risk[i]).toFixed(1)},${y(frontier.ret[i]).toFixed(1)}h0`;
    node.append(svg('path', { class: 'scatter__cloud', d: cloud }));

    const marks = [];
    if (frontier.minVariance) {
      const cx = x(frontier.minVariance.risk);
      const cy = y(frontier.minVariance.ret);
      node.append(svg('rect', { class: 'scatter__mark', x: cx - 5.5, y: cy - 5.5, width: 11, height: 11 }));
      marks.push({ name: 'Lowest risk in the sample', ...frontier.minVariance, cx, cy });
    }
    if (frontier.maxSharpe) {
      const cx = x(frontier.maxSharpe.risk);
      const cy = y(frontier.maxSharpe.ret);
      node.append(svg('path', { class: 'scatter__mark', d: `M${cx},${cy - 8}L${cx + 7.5},${cy + 5.5}L${cx - 7.5},${cy + 5.5}Z` }));
      marks.push({ name: 'Highest Sharpe in the sample', ...frontier.maxSharpe, cx, cy });
    }
    if (isNum(yours.risk) && isNum(yours.ret)) {
      const cx = x(yours.risk);
      const cy = y(yours.ret);
      node.append(svg('circle', { class: 'scatter__you', cx, cy, r: 6.5 }));
      marks.push({ name: 'Your mix', ret: yours.ret, risk: yours.risk, sharpe: valueOf(analysis.metrics.sharpeRatio), cx, cy, own: true });
    }
    const ring = svg('circle', { class: 'scatter__hover', r: 6, visibility: 'hidden' });
    node.append(ring);

    const tip = document.createElement('div');
    tip.className = 'chart__tip';
    tip.hidden = true;
    plot.replaceChildren(node, tip);
    scatter = { plot, tip, ring, marks, frontier, x, y, width, tickers: analysis.tickers };
  }

  function tipRow(tip, name, value) {
    const row = document.createElement('div');
    row.className = 'chart__tip-row';
    const label = document.createElement('span');
    label.textContent = name;
    const number = document.createElement('strong');
    number.textContent = value;
    row.append(label, number);
    tip.append(row);
  }

  function showScatterTip(event) {
    if (!scatter) return;
    const box = scatter.plot.getBoundingClientRect();
    const scale = scatter.width / box.width;
    const px = (event.clientX - box.left) * scale;
    const py = (event.clientY - box.top) * scale;
    const distance = (cx, cy) => (cx - px) ** 2 + (cy - py) ** 2;

    // A named marker wins when the pointer is near it; otherwise the nearest random mix.
    let target = null;
    let best = 18 ** 2;
    for (const mark of scatter.marks) {
      const d = distance(mark.cx, mark.cy);
      if (d <= best) {
        best = d;
        target = mark;
      }
    }
    if (!target) {
      const { frontier } = scatter;
      let nearest = -1;
      let nearestDistance = 30 ** 2;
      for (let i = 0; i < frontier.risk.length; i += 1) {
        const d = distance(scatter.x(frontier.risk[i]), scatter.y(frontier.ret[i]));
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = i;
        }
      }
      if (nearest >= 0) {
        target = { name: 'Random mix', risk: frontier.risk[nearest], ret: frontier.ret[nearest], cx: scatter.x(frontier.risk[nearest]), cy: scatter.y(frontier.ret[nearest]) };
      }
    }
    if (!target) {
      hideScatterTip();
      return;
    }
    scatter.ring.setAttribute('cx', target.cx);
    scatter.ring.setAttribute('cy', target.cy);
    scatter.ring.setAttribute('r', target.name === 'Random mix' ? 5 : 10);
    scatter.ring.setAttribute('visibility', 'visible');

    const { tip } = scatter;
    tip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'chart__tip-title';
    title.textContent = target.name;
    tip.append(title);
    tipRow(tip, 'Return', h.signedPercent(target.ret, 1));
    tipRow(tip, 'Volatility', pct(target.risk, 1));
    if (isNum(target.sharpe)) tipRow(tip, 'Sharpe', h.formatNumber(target.sharpe, 2));
    if (target.allocation) {
      for (const entry of roundAllocation(target.allocation)) {
        if (entry.weight > 0) tipRow(tip, entry.ticker, `${entry.weight}%`);
      }
    }
    tip.hidden = false;
    const cursorPx = target.cx / scale;
    const tipWidth = tip.offsetWidth;
    const left = cursorPx + 14 + tipWidth > scatter.plot.clientWidth ? Math.max(4, cursorPx - 14 - tipWidth) : cursorPx + 14;
    tip.style.left = `${left}px`;
  }

  function hideScatterTip() {
    if (!scatter) return;
    scatter.tip.hidden = true;
    scatter.ring.setAttribute('visibility', 'hidden');
  }

  /* ------------------------------------------------------------------ */
  /* Results render                                                      */
  /* ------------------------------------------------------------------ */

  function statusLine(job) {
    if (job.status === 'running') return 'Recalculating…';
    if (!isNum(job.ms)) return '';
    const where = job.mode === 'worker' ? 'in a Web Worker' : 'on the main thread (no worker available)';
    return `Calculated ${where} in ${job.ms < 1 ? 'under 1' : h.formatNumber(job.ms, 0)} ms`;
  }

  function renderResults(state) {
    const job = app.portfolio();
    scatter = null;
    results.classList.toggle('is-stale', job.status === 'running' && Boolean(job.result));
    results.setAttribute('aria-busy', String(job.status === 'running'));

    if (job.weights.length === 0) {
      results.innerHTML = `
        <div class="empty-matrix">
          <p class="empty-matrix__title">Build a portfolio of up to ${MAX_PORTFOLIO_ASSETS} assets</p>
          <p>Add assets on the left and set their weights. Return, volatility and the Sharpe ratio appear here, each with its full working.</p>
        </div>`;
      return;
    }
    if (job.status === 'error') {
      results.innerHTML = `
        <div class="banner banner--warning" role="alert">
          ${h.toneMark('caution')}
          <div><p class="banner__title">The portfolio could not be calculated</p><p>${esc(job.error ?? 'The calculation failed.')}</p></div>
        </div>`;
      return;
    }
    if (!job.result) {
      results.innerHTML = `
        <div class="status-card">
          <span class="spinner" aria-hidden="true"></span>
          <p class="status-card__title">Calculating the portfolio…</p>
          <p class="status-card__text">The covariance matrix and 2,000 alternative mixes are computed off the main thread.</p>
        </div>`;
      return;
    }

    const { analysis, frontier } = job.result;
    if (!analysis.ok) {
      results.innerHTML = `
        <div class="banner banner--warning" role="note">
          ${h.toneMark('caution')}
          <div><p class="banner__title">Not enough to measure this portfolio</p><p>${esc(analysis.reason)}</p></div>
        </div>
        ${tiles(analysis, state)}
        ${crashBlock(state)}`;
      return;
    }

    const active = document.activeElement;
    const focusKey = active && results.contains(active) ? active.dataset.key : null;
    const fxNote = analysis.fxMode === 'constant'
      ? `No USD/SGD history is available, so today's rate was applied to every day: currency moves are not in these figures.`
      : analysis.fxMode === 'history' ? `Prices were converted to ${analysis.baseCurrency} at each day's USD/SGD rate, so currency moves are included.` : '';

    results.innerHTML = `
      <div>
        <div class="sandbox__block-title">
          <h2 class="panel-title">Historical statistics</h2>
          <span class="field__hint">${analysis.observations} ${analysis.frequency === 'weekly' ? 'weekly returns (markets close at different times)' : 'daily returns'} on ${analysis.frequency === 'weekly' ? 'weeks' : 'dates'} every asset traded · ${esc(h.shortDate(analysis.period.from, true))} to ${esc(h.shortDate(analysis.period.to, true))}${analysis.tickers.length > 2 ? ` · covariance shrunk ${esc(h.formatPercent(analysis.shrinkage.delta, 0))} toward equal correlations` : ''}</span>
          ${analysis.asynchronous ? '<p class="alloc__note">These markets close at different times, and this range is too short for weekly returns, so daily closes are used: correlations are understated and diversification looks better than it is. Choose 6M or longer.</p>' : ''}
        </div>
        ${tiles(analysis, state)}
        ${crowdBanner(analysis)}
        <p class="alloc__note"><span data-role="status-line">${esc(statusLine(job))}</span>${fxNote ? ` · ${esc(fxNote)}` : ''}</p>
      </div>
      ${state.mode === 'guided' ? `
        <div class="guide-note guided-only">
          <span class="guide-note__badge">Guided</span>
          <span>${esc(app.explain('sharpeRatio').what)} ${esc(app.explain('portfolioVolatility').why)} These figures describe the past window only. Select any tile to see its arithmetic.</span>
        </div>` : ''}
      ${crashBlock(state)}
      ${riskBlock(analysis, state)}
      ${frontierBlock(analysis, frontier, state)}`;

    if (focusKey) {
      const again = results.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
    const plot = results.querySelector('[data-role="scatter"]');
    if (plot && frontier) drawScatter(plot, analysis, frontier);
    markCurrent();
  }

  function markCurrent() {
    const { drawer } = store.getState();
    for (const cell of results.querySelectorAll('[aria-current="true"]')) cell.removeAttribute('aria-current');
    if (!drawer.open || drawer.ticker || !drawer.trail.length) return;
    const cell = results.querySelector(`[data-action="trace"][data-trace="${CSS.escape(drawer.trail[0])}"]`);
    if (cell) cell.setAttribute('aria-current', 'true');
  }

  function render() {
    const state = store.getState();
    if (!state.snapshot) return;
    renderToolbar(state);
    syncAllocation(state);
    renderResults(state);
    if (typeof ResizeObserver === 'function' && !resizeObserver) {
      let lastWidth = 0;
      resizeObserver = new ResizeObserver((entries) => {
        const width = Math.round(entries[0].contentRect.width);
        if (width === lastWidth || width === 0) return;
        lastWidth = width;
        const job = app.portfolio();
        if (scatter && job.result && job.result.frontier && job.result.analysis.ok) drawScatter(scatter.plot, job.result.analysis, job.result.frontier);
      });
      resizeObserver.observe(results);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  function setWeight(ticker, raw) {
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) return;
    store.dispatch(actions.setPortfolioWeight(ticker, Math.min(100, Math.max(0, value))));
  }

  root.addEventListener('input', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement)) return;
    if (control.dataset.role === 'weight-slider' || control.dataset.role === 'weight-box') setWeight(control.dataset.ticker, control.value);
  });

  // On blur or Enter the box shows the stored (clamped, rounded) value.
  root.addEventListener('change', (event) => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || control.dataset.role !== 'weight-box') return;
    const entry = app.portfolio().weights.find((item) => item.ticker === control.dataset.ticker);
    if (entry) control.value = String(entry.weight);
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target.closest('[data-role="add"]');
    if (!form) return;
    const ticker = form.elements.ticker.value;
    if (ticker) store.dispatch(actions.addPortfolioAsset(ticker));
  });

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (!control || !root.contains(control)) return;
    switch (control.dataset.action) {
      case 'trace':
        app.rememberTrigger(control.dataset.key);
        store.dispatch(actions.openTrace(null, control.dataset.trace));
        break;
      case 'remove':
        store.dispatch(actions.removePortfolioAsset(control.dataset.ticker));
        break;
      case 'equalise':
        store.dispatch(actions.equalisePortfolio());
        break;
      case 'normalise':
        store.dispatch(actions.normalisePortfolio());
        break;
      case 'reset':
        store.dispatch(actions.resetPortfolio());
        break;
      case 'apply': {
        const job = app.portfolio();
        const candidate = job.result && job.result.frontier ? job.result.frontier[control.dataset.mix] : null;
        const mix = candidate ? roundAllocation(candidate.allocation) : [];
        if (mix.length) {
          store.dispatch(actions.setPortfolioWeights(mix));
          store.dispatch(actions.notify('Applied. This is the mix that did best in hindsight over this window, not a forecast.'));
        }
        break;
      }
      default:
        break;
    }
  });

  root.addEventListener('pointermove', (event) => {
    if (scatter && scatter.plot.contains(event.target)) showScatterTip(event);
  });

  root.addEventListener('pointerout', (event) => {
    if (!scatter || !scatter.plot.contains(event.target)) return;
    if (event.relatedTarget && scatter.plot.contains(event.relatedTarget)) return;
    hideScatterTip();
  });

  store.subscribe((next, previous) => {
    // Nothing is rendered while another view is showing; entering the view renders everything.
    if (next.view !== 'portfolio') return;
    if (next.view !== previous.view || next.snapshot !== previous.snapshot) {
      render();
      return;
    }
    if (next.currency !== previous.currency || next.range !== previous.range) renderToolbar(next);
    if (next.portfolio !== previous.portfolio || next.selected !== previous.selected) syncAllocation(next);
    if (next.compute.portfolio !== previous.compute.portfolio || next.mode !== previous.mode
      || (next.portfolio !== previous.portfolio && app.portfolio().weights.length === 0)) {
      renderResults(next);
    } else if (next.drawer !== previous.drawer) {
      markCurrent();
    }
  });

  if (store.getState().view === 'portfolio') render();

  return {
    destroy() {
      if (resizeObserver) resizeObserver.disconnect();
    },
  };
}
