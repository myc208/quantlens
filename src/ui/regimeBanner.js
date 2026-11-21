/**
 * regimeBanner.js: a banner above every view while the VIX curve is inverted.
 *
 * It appears only in the stressed regime, explains what an inverted curve means and
 * opens the derivation. "Hide for this visit" lasts until the page is reloaded:
 * nothing is stored, so the banner returns on the next visit if the market is still
 * stressed. Context only: the regime changes no score, verdict or position size.
 */

export function mountRegimeBanner(root, app) {
  if (!root) return { destroy() {} };
  const { store, actions, h } = app;
  let dismissed = false;

  function render() {
    const state = store.getState();
    const regime = state.snapshot ? app.describeRegime() : null;
    if (!regime || !regime.banner || dismissed) {
      root.hidden = true;
      root.innerHTML = '';
      return;
    }
    root.hidden = false;
    root.innerHTML = `
      <div class="banner banner--danger" role="note" aria-label="Market regime">
        ${h.toneMark('risky')}
        <div>
          <p class="banner__title">Market regime: stressed. ${h.esc(regime.headline)}.</p>
          <p>Options traders are paying more for protection over the next month than over the next three. VaR and volatility here are measured from past days and catch up with a lag; EWMA volatility reacts fastest. This is context: it changes no score, verdict or position size.</p>
          <p class="regime-banner__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="trace" data-key="banner:marketRegime">How this is read</button>
            <button type="button" class="btn btn--ghost btn--sm" data-action="dismiss">Hide for this visit</button>
          </p>
        </div>
      </div>`;
  }

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (!control || !root.contains(control)) return;
    if (control.dataset.action === 'trace') {
      app.rememberTrigger(control.dataset.key);
      store.dispatch(actions.openTrace(null, 'marketRegime'));
    } else if (control.dataset.action === 'dismiss') {
      dismissed = true;
      render();
    }
  });

  store.subscribe((next, previous) => {
    if (next.snapshot !== previous.snapshot) render();
  });
  render();

  return { destroy() {} };
}
