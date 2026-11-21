/**
 * mathWorker.js: heavy calculations off the main thread.
 *
 * A module worker that runs the Monte Carlo simulation and the portfolio
 * analysis (with its random-portfolio cloud), so dragging a slider never
 * makes the page stutter.
 *
 * Protocol (plain structured-clone messages, no shared state)
 *   worker -> page   { ready: true }                          once, after the modules load
 *   page -> worker   { id, type, payload }
 *   worker -> page   { id, ok: true,  result, ms }
 *                    { id, ok: false, error, ms }
 *
 * The worker is stateless and knows nothing about the store. It imports the
 * same pure engine modules the test page imports, and `handleRequest` is
 * exported so that workerService can run a job on the main thread when a
 * module worker cannot be started. One code path, three places to run it.
 */

import { runMonteCarlo } from '../engines/monteCarloEngine.js';
import { analyzePortfolio, sampleFrontier } from '../engines/portfolioEngine.js';
import { backtestWatchlist } from '../engines/backtestEngine.js';

export const JOB_TYPES = Object.freeze(['monteCarlo', 'portfolio', 'backtest', 'ping']);

/**
 * Run one job synchronously.
 *
 * monteCarlo  payload: the arguments of runMonteCarlo
 * portfolio   payload: the arguments of analyzePortfolio, plus optional
 *             { frontierSamples, frontierSeed }; returns { analysis, frontier }
 * ping        returns { pong: true } (used by tests and health checks)
 */
export function handleRequest(type, payload) {
  switch (type) {
    case 'monteCarlo':
      return runMonteCarlo(payload);
    case 'backtest':
      return backtestWatchlist(payload);
    case 'portfolio': {
      const analysis = analyzePortfolio(payload);
      const riskFree = payload.riskFree && typeof payload.riskFree.yield === 'number' ? payload.riskFree.yield : null;
      const frontier = analysis.ok
        ? sampleFrontier({
          means: analysis.stats.means,
          covariance: analysis.stats.covariance,
          tickers: analysis.tickers,
          riskFree,
          count: payload.frontierSamples,
          seed: payload.frontierSeed,
        })
        : null;
      return { analysis, frontier };
    }
    case 'ping':
      return { pong: true };
    default:
      throw new Error(`Unknown job type: ${String(type)}`);
  }
}

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

if (inWorker) {
  self.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || !('id' in message)) return;
    const started = performance.now();
    try {
      const result = handleRequest(message.type, message.payload);
      self.postMessage({ id: message.id, ok: true, result, ms: performance.now() - started });
    } catch (error) {
      self.postMessage({ id: message.id, ok: false, error: error && error.message ? error.message : String(error), ms: performance.now() - started });
    }
  });
  // Tell the page the module graph loaded; until this arrives the service assumes nothing.
  self.postMessage({ ready: true });
}
