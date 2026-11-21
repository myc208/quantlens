/**
 * derivationDrawer.js: the "show your working" inspector.
 *
 * It renders one TracedMetric at a time: result, plain-language reading,
 * formula, raw inputs, numbered arithmetic steps, thresholds, and the metrics
 * it is built from. Each `dependsOn` entry is a link that drills into the
 * child metric; the breadcrumb records the path (Trend regime > RSI) and jumps
 * back to any level.
 *
 * Desktop: a 420px panel on the right (it pushes the matrix on wide screens).
 * Phone: a bottom sheet covering 85% of the screen, dismissed by the close
 * button, Escape, the scrim or by dragging the handle down.
 *
 * The drawer knows nothing about the matrix. It reads store.drawer
 * ({ open, ticker, traceId, trail }) and asks the app for the trace index.
 */

const PROFILE_NAMES = Object.freeze({ CORPORATE: 'corporates', FINANCIAL: 'financial companies', REIT: 'REITs', ETF: 'ETFs', INDEX: 'indices', CRYPTO: 'crypto' });

// Metrics that belong to the portfolio as a whole rather than to one asset or one pair.
const PORTFOLIO_METRICS = new Set(['portfolioReturn', 'portfolioVolatility', 'sharpeRatio', 'diversificationRatio', 'riskFreeRate', 'portfolioBeta', 'concentration', 'effectiveBets']);
// Readings of the market as a whole: the VIX curve (V3.1) and the macro calendar (V3.2).
const MARKET_METRICS = new Map([
  ['marketRegime', 'Whole market · VIX curve'], ['vixLevel', 'Whole market · VIX curve'],
  ['vixTermRatio', 'Whole market · VIX curve'], ['vixFrontRatio', 'Whole market · VIX curve'],
  ['nextMacroEvent', 'Whole market · macro calendar'],
]);

export function mountDerivationDrawer(root, app, scrim) {
  const { store, actions, h } = app;
  const { esc } = h;
  let wasOpen = false;
  let lastRenderedId = null;

  /* ------------------------------------------------------------------ */
  /* Sections                                                            */
  /* ------------------------------------------------------------------ */

  function resultBlock(metric, asset) {
    if (metric.status !== 'ok') {
      return `
        <div class="result result--na">
          <span class="badge badge--na">N/A</span>
          <span class="result__value">Not available</span>
        </div>`;
    }
    const tone = h.toneWord(metric.tone);
    const native = h.formatMetric(metric, { withCurrency: true, native: true });
    let converted = '';
    if (metric.unit === 'currency' && metric.meta && metric.meta.currency) {
      const shown = h.money(metric.value, metric.meta.currency);
      if (shown.converted) converted = `<span class="result__unit">about ${esc(shown.currency)} ${esc(h.formatAmount(shown.value))} at today's reference rate</span>`;
    }
    const unitName = metric.unit === 'shares' && metric.meta && metric.meta.unitName ? ` <span class="result__unit">${esc(metric.meta.unitName)}</span>` : '';
    const scale = metric.unit === 'score' ? ' <span class="result__unit">out of 100</span>' : '';
    return `
      <div class="result">
        <span class="result__value">${esc(native)}${unitName}${scale}</span>
        ${tone ? `<span class="badge badge--${esc(metric.tone)}">${h.toneMark(metric.tone)}${esc(tone.charAt(0).toUpperCase() + tone.slice(1))}</span>` : ''}
        ${converted}
        ${asset && asset.status === 'stale' ? '<span class="chip">Older data</span>' : ''}
      </div>`;
  }

  function readingSection(metric) {
    const reading = metric.trace.interpretation;
    return `
      <section class="drawer__section">
        <h3>${metric.status === 'ok' ? 'What this tells you' : 'Why there is no value'}</h3>
        <p class="reading">${esc(metric.status === 'ok' ? reading.summary : metric.naReason)}</p>
        ${reading.caveat ? `<p class="caveat">${esc(reading.caveat)}</p>` : ''}
      </section>`;
  }

  function glossarySection(metric, asset) {
    const explainer = app.explain(metric.id, asset ? asset.scoringProfile : undefined);
    if (explainer.term === 'Metric') return '';
    const row = (title, text, tone) => (text ? `<dt>${tone ? h.toneMark(tone) : ''}${esc(title)}</dt><dd>${esc(text)}</dd>` : '');
    return `
      <section class="drawer__section guided-only">
        <h3>In plain language</h3>
        <dl class="glossary">
          ${row('What it measures', explainer.what)}
          ${row('Why it matters', explainer.why)}
          ${row('Healthy', explainer.healthy, 'healthy')}
          ${row('Risky', explainer.risky, 'risky')}
          ${explainer.note ? `<dd class="glossary__note"><strong>For ${esc(PROFILE_NAMES[asset.scoringProfile] ?? 'this asset')}:</strong> ${esc(explainer.note)}</dd>` : ''}
        </dl>
      </section>`;
  }

  function formulaSection(metric) {
    if (!metric.trace.formula) return '';
    return `
      <section class="drawer__section">
        <h3>Formula</h3>
        <p class="formula">${esc(metric.trace.formula)}</p>
      </section>`;
  }

  function inputsSection(metric) {
    const inputs = metric.trace.rawInputs;
    if (!inputs.length) return '';
    return `
      <section class="drawer__section">
        <h3>Raw inputs</h3>
        <table class="kv-table">
          <tbody>
            ${inputs.map((raw) => `
              <tr>
                <th scope="row">
                  ${esc(raw.name)}
                  <span class="kv-table__source">${esc([raw.source, raw.asOf ? `as of ${h.shortDate(raw.asOf, true)}` : ''].filter(Boolean).join(' · '))}</span>
                </th>
                <td>${esc(h.formatRaw(raw.value, raw.unit))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </section>`;
  }

  function stepsSection(metric) {
    const { steps } = metric.trace;
    if (!steps.length) return '';
    return `
      <section class="drawer__section">
        <h3>Step by step</h3>
        <ol class="steps">
          ${steps.map((item) => `
            <li>
              <span class="step__text">${esc(item.description)}</span>
              <span class="step__math">
                ${item.expression ? `<span class="step__expr">${esc(item.expression)}</span>` : ''}
                <span class="step__result">${esc(h.formatRaw(item.result))}</span>
              </span>
            </li>`).join('')}
        </ol>
      </section>`;
  }

  function thresholdsSection(metric) {
    const { thresholds } = metric.trace.interpretation;
    if (!thresholds.length) return '';
    return `
      <section class="drawer__section">
        <h3>How to read it</h3>
        <ul class="threshold-list">
          ${thresholds.map((item) => `
            <li>
              ${h.toneMark(item.tone)}
              <span class="threshold-list__range">${esc(item.range)}</span>
              <span class="threshold-list__label">${esc(item.label)}<span class="sr-only"> (${esc(h.toneWord(item.tone))})</span></span>
            </li>`).join('')}
        </ul>
      </section>`;
  }

  function dependenciesSection(metric, index) {
    const ids = metric.trace.dependsOn;
    if (!ids.length) return '';
    const items = ids.map((id) => {
      const child = index.get(id);
      if (!child) {
        return `<div class="dep dep--missing"><span class="dep__label">${esc(app.explain(id).term === 'Metric' ? id : app.explain(id).term)}</span><span>not in this view</span></div>`;
      }
      const value = child.status === 'ok' ? h.formatMetric(child, { withCurrency: true, native: true }) : 'N/A';
      return `
        <button type="button" class="dep" data-action="drill" data-trace="${esc(child.id)}"
          aria-label="${esc(`${child.label}: ${child.status === 'ok' ? value : 'not available'}. Show how it is calculated.`)}">
          <span class="dep__label">${h.toneMark(child.status === 'ok' ? child.tone : null)}${esc(child.label)}</span>
          <span class="dep__value">${esc(value)}</span>
        </button>`;
    });
    return `
      <section class="drawer__section">
        <h3>Built from</h3>
        <div class="dep-list">${items.join('')}</div>
      </section>`;
  }

  function breadcrumb(trail, index) {
    if (trail.length <= 1) return '';
    const items = trail.map((id, position) => {
      const metric = index.get(id);
      const label = metric ? metric.label : id;
      if (position === trail.length - 1) return `<li><span aria-current="step">${esc(label)}</span></li>`;
      return `<li><button type="button" data-action="jump" data-index="${position}">${esc(label)}</button></li>`;
    });
    return `<nav class="breadcrumb" aria-label="Derivation path"><ol>${items.join('')}</ol></nav>`;
  }

  function footnote(metric, asset) {
    const parts = [];
    if (asset) {
      parts.push(`Figures are in ${asset.currency}, the currency ${asset.ticker} trades in, and use completed daily candles up to ${h.shortDate(asset.quote.asOf, true)}.`);
      if (asset.financialCurrency !== asset.currency) parts.push(`Financial statements are reported in ${asset.financialCurrency}.`);
      if (asset.fundamentalsPeriod) parts.push(`Fundamentals cover ${asset.fundamentalsPeriod === 'TTM' ? 'the trailing twelve months' : asset.fundamentalsPeriod}.`);
    } else {
      parts.push('This figure covers all compared assets together.');
    }
    return `<p class="drawer__note">${esc(parts.join(' '))}</p>`;
  }

  /* ------------------------------------------------------------------ */
  /* Open, close, render                                                 */
  /* ------------------------------------------------------------------ */

  function setOpen(open) {
    root.dataset.open = String(open);
    root.setAttribute('aria-hidden', String(!open));
    if (open) root.removeAttribute('inert');
    else root.setAttribute('inert', '');
    if (scrim) scrim.hidden = !open;
  }

  function restoreFocus() {
    const key = app.takeTrigger();
    if (!key) return;
    const trigger = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (trigger) trigger.focus({ preventScroll: true });
  }

  function render() {
    const state = store.getState();
    const { drawer } = state;
    if (!drawer.open) {
      if (wasOpen) {
        setOpen(false);
        wasOpen = false;
        lastRenderedId = null;
        restoreFocus();
      }
      return;
    }

    const index = app.traceIndex(drawer.ticker);
    const metric = index.get(drawer.traceId);
    if (!metric) {
      // The asset or metric left the view (for example it was removed from the comparison).
      store.dispatch(actions.closeTrace());
      return;
    }
    const asset = drawer.ticker && state.snapshot ? state.snapshot.byTicker[drawer.ticker] : null;
    let eyebrow = 'All compared assets';
    if (asset) eyebrow = `${asset.ticker} · ${asset.name}`;
    else if (PORTFOLIO_METRICS.has(drawer.trail[0])) eyebrow = 'Your portfolio';
    else if (MARKET_METRICS.has(drawer.trail[0])) eyebrow = MARKET_METRICS.get(drawer.trail[0]);
    const scrollTop = lastRenderedId === metric.id ? (root.querySelector('.drawer__body') || {}).scrollTop : 0;

    root.innerHTML = `
      <button type="button" class="drawer__handle" data-action="close" aria-label="Close the derivation"></button>
      <header class="drawer__header">
        <div>
          <p class="drawer__eyebrow">${esc(eyebrow)}</p>
          <h2 class="drawer__title" id="drawer-title" tabindex="-1">${esc(metric.label)}</h2>
        </div>
        <button type="button" class="icon-btn" data-action="close" aria-label="Close the derivation">×</button>
      </header>
      ${breadcrumb(drawer.trail, index)}
      <div class="drawer__body">
        ${resultBlock(metric, asset)}
        ${readingSection(metric)}
        ${glossarySection(metric, asset)}
        ${formulaSection(metric)}
        ${inputsSection(metric)}
        ${stepsSection(metric)}
        ${thresholdsSection(metric)}
        ${dependenciesSection(metric, index)}
        <section class="drawer__section">${footnote(metric, asset)}</section>
      </div>`;

    const body = root.querySelector('.drawer__body');
    if (body && scrollTop) body.scrollTop = scrollTop;

    const opening = !wasOpen;
    const changedMetric = lastRenderedId !== metric.id;
    if (opening) setOpen(true);
    wasOpen = true;
    lastRenderedId = metric.id;
    if (opening || changedMetric) {
      const title = root.querySelector('#drawer-title');
      if (title) title.focus({ preventScroll: true });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    switch (control.dataset.action) {
      case 'close':
        store.dispatch(actions.closeTrace());
        break;
      case 'drill':
        store.dispatch(actions.drillTrace(control.dataset.trace));
        break;
      case 'jump':
        store.dispatch(actions.jumpTrace(Number(control.dataset.index)));
        break;
      default:
        break;
    }
  });

  if (scrim) scrim.addEventListener('click', () => store.dispatch(actions.closeTrace()));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !store.getState().drawer.open) return;
    if (document.querySelector('dialog[open]')) return; // the modal handles its own Escape
    event.preventDefault();
    store.dispatch(actions.closeTrace());
  });

  // Bottom sheet: drag the handle down to dismiss.
  let drag = null;
  root.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.drawer__handle');
    if (!handle) return;
    drag = { startY: event.clientY, moved: 0 };
    handle.setPointerCapture(event.pointerId);
    root.style.transition = 'none';
  });
  root.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.moved = Math.max(0, event.clientY - drag.startY);
    root.style.transform = `translateY(${drag.moved}px)`;
  });
  const endDrag = (event) => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    root.style.transition = '';
    root.style.transform = '';
    if (moved > 90) {
      event.preventDefault();
      store.dispatch(actions.closeTrace());
    }
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  store.subscribe((next, previous) => {
    const drawerChanged = next.drawer !== previous.drawer;
    const contextChanged = next.drawer.open && (
      next.selected !== previous.selected || next.account !== previous.account
      || next.currency !== previous.currency || next.mode !== previous.mode
      || next.live.fx !== previous.live.fx || next.snapshot !== previous.snapshot
      // Time-range statistics, the simulation and the portfolio maths all change what a trace shows.
      || next.range !== previous.range || next.compute !== previous.compute
    );
    if (drawerChanged || contextChanged) render();
  });

  setOpen(false);

  return { destroy() {} };
}
