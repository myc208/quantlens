/**
 * workerService.js: the only code that talks to the math worker.
 *
 * Two layers:
 *
 * 1. createWorkerService()  a promise-based request/response client.
 *    - Starts the module worker lazily and waits for its "ready" message.
 *    - If the worker cannot start (old browser, blocked script, load error) or
 *      crashes later, the same job function is imported and run on the main
 *      thread instead. Results are identical; only responsiveness differs.
 *    - A request that exceeds its timeout rejects, and the stuck worker is
 *      terminated so the next request gets a fresh one.
 *
 * 2. createJobRunner()  the bridge to the store, implementing "latest wins".
 *
 *      submit(job, key, type, payload)
 *        -> dispatch computeStarted(job, key)        the store now expects `key`
 *        -> service.request(type, payload)
 *        -> dispatch computeFinished(job, key, ...)  the reducer keeps the result
 *                                                    only if `key` is still current
 *
 *    The key is derived from the job's inputs. A reply for inputs that have
 *    since changed is dropped by the reducer, so a slow answer can never
 *    overwrite a newer one. While a job is running, newer submissions are
 *    coalesced: only the most recent waits, so dragging a slider queues one
 *    follow-up run, not fifty.
 *
 * Neither layer imports the store: the runner is handed `store` and `actions`.
 */

const DEFAULTS = Object.freeze({ readyTimeoutMs: 5000, requestTimeoutMs: 30000 });

function defaultWorkerFactory() {
  return new Worker(new URL('../workers/mathWorker.js', import.meta.url), { type: 'module', name: 'quantlens-math' });
}

function defaultFallbackLoader() {
  return import('../workers/mathWorker.js');
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {object} [options]
 * @param {() => Worker} [options.createWorker] injected in tests
 * @param {() => Promise<{handleRequest: Function}>} [options.loadFallback] injected in tests
 * @param {number} [options.readyTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @returns {{ request: Function, getMode: () => string, terminate: () => void }}
 */
export function createWorkerService({
  createWorker = defaultWorkerFactory,
  loadFallback = defaultFallbackLoader,
  readyTimeoutMs = DEFAULTS.readyTimeoutMs,
  requestTimeoutMs = DEFAULTS.requestTimeoutMs,
} = {}) {
  let mode = 'idle'; // idle | starting | worker | main
  let worker = null;
  let starting = null;
  let sequence = 0;
  let fallbackModule = null;
  const pending = new Map(); // id -> { type, payload, resolve, reject, timer }

  async function runOnMainThread(type, payload) {
    if (!fallbackModule) fallbackModule = await loadFallback();
    await nextTask(); // let the page paint its "calculating" state before the thread is busy
    const started = performance.now();
    const result = fallbackModule.handleRequest(type, payload);
    return { result, ms: performance.now() - started, mode: 'main' };
  }

  function dropWorker() {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch (error) { /* already gone */ }
    }
    worker = null;
  }

  /** The worker died or never started: answer everything still waiting from the main thread. */
  function failOver() {
    dropWorker();
    mode = 'main';
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      runOnMainThread(entry.type, entry.payload).then(entry.resolve, entry.reject);
    }
  }

  function onMessage(event) {
    const message = event.data;
    if (!message || typeof message !== 'object' || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve({ result: message.result, ms: message.ms, mode: 'worker' });
    else entry.reject(new Error(message.error || 'The calculation failed.'));
  }

  function start() {
    if (mode === 'worker' || mode === 'main') return Promise.resolve(mode);
    if (starting) return starting;
    mode = 'starting';
    starting = new Promise((resolve) => {
      let settled = false;
      const settle = (next) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        starting = null;
        if (next === 'main') dropWorker();
        mode = next;
        resolve(next);
      };
      const timer = setTimeout(() => settle('main'), readyTimeoutMs);
      try {
        if (typeof Worker !== 'function' && createWorker === defaultWorkerFactory) throw new Error('Web Workers are not available');
        worker = createWorker();
        worker.onmessage = (event) => {
          if (event.data && event.data.ready === true) {
            worker.onmessage = onMessage;
            worker.onerror = () => failOver();
            settle('worker');
          }
        };
        worker.onerror = () => settle('main');
      } catch (error) {
        settle('main');
      }
    });
    return starting;
  }

  /**
   * Run one job.
   * @param {string} type a job type understood by mathWorker.js
   * @param {object} payload structured-cloneable arguments
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ result: any, ms: number, mode: 'worker'|'main' }>}
   */
  async function request(type, payload, { timeoutMs = requestTimeoutMs } = {}) {
    const current = await start();
    if (current !== 'worker' || !worker) return runOnMainThread(type, payload);
    return new Promise((resolve, reject) => {
      sequence += 1;
      const id = sequence;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`The calculation did not finish within ${Math.round(timeoutMs / 1000)} seconds.`));
        // A worker that is still busy after the timeout is stuck. Replace it; other
        // waiting requests are re-run on the main thread rather than lost.
        failOver();
        mode = 'idle';
      }, timeoutMs);
      pending.set(id, { type, payload, resolve, reject, timer });
      try {
        worker.postMessage({ id, type, payload });
      } catch (error) {
        // The payload could not be cloned (for example it held a function).
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function terminate() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The calculation was cancelled.'));
    }
    pending.clear();
    dropWorker();
    starting = null;
    mode = 'idle';
  }

  return { request, getMode: () => mode, terminate };
}

/** A stable key for a set of job inputs. Equal inputs give equal keys. */
export function jobKey(...parts) {
  return JSON.stringify(parts);
}

/**
 * Connect a worker service to the store with latest-wins semantics.
 *
 * @param {object} args
 * @param {{ request: Function }} args.service from createWorkerService
 * @param {{ getState: Function, dispatch: Function }} args.store
 * @param {{ computeStarted: Function, computeFinished: Function, computeFailed: Function }} args.actions
 * @returns {{ submit: (job:string, key:string, type:string, payload:object) => boolean, isBusy: (job:string) => boolean }}
 */
export function createJobRunner({ service, store, actions }) {
  const slots = new Map(); // job -> { running: boolean, queued: { key, type, payload } | null }

  function slotFor(job) {
    if (!slots.has(job)) slots.set(job, { running: false, queued: null });
    return slots.get(job);
  }

  async function run(job, key, type, payload) {
    const slot = slotFor(job);
    slot.running = true;
    try {
      const { result, ms, mode } = await service.request(type, payload);
      store.dispatch(actions.computeFinished(job, key, result, ms, mode));
    } catch (error) {
      store.dispatch(actions.computeFailed(job, key, error && error.message ? error.message : String(error)));
    } finally {
      slot.running = false;
      const next = slot.queued;
      slot.queued = null;
      if (next) run(job, next.key, next.type, next.payload);
    }
  }

  /**
   * Ask for a job to be computed. Returns false when these exact inputs are
   * already running or already answered, so callers can call it on every render.
   */
  function submit(job, key, type, payload) {
    const state = store.getState().compute[job];
    if (!state) throw new Error(`Unknown compute job: ${job}`);
    if (state.key === key && (state.status === 'running' || state.status === 'done')) return false;
    store.dispatch(actions.computeStarted(job, key)); // from now on only `key` is acceptable
    const slot = slotFor(job);
    if (slot.running) slot.queued = { key, type, payload }; // replaces any older queued run
    else run(job, key, type, payload);
    return true;
  }

  return { submit, isBusy: (job) => slotFor(job).running };
}
