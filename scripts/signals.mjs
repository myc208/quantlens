#!/usr/bin/env node
/**
 * signals.mjs: every asset's trend regime and scores, computed by the site's own engines.
 *
 * The daily Telegram briefing (fetch_fundamentals.py --notify) runs this so that
 * the signals in the message are exactly the ones the site shows: the same
 * technical and fundamental engines over the same snapshot, with no
 * second implementation in Python to drift out of step.
 *
 * V3.2 adds what the risk-first briefing needs and only the engines can compute:
 * each asset's bucket, the latest session's move in σ (the bootstrap's own filtered
 * residual), 3-month relative strength, the next ex-dividend date and the timing of
 * the next earnings release. Macro events and the regime come straight from the
 * snapshot, which Python already reads.
 *
 * V3.4: each asset's trend state over its last three sessions (trendHistory), so the briefing
 * can report a flip across the 200-day average or the 20/50-day EMA cross once it has held for
 * a second close.
 *
 * V3.3: the trend regime (Uptrend, Extended, Pullback, Recovering, Downtrend) replaces
 * the BUY / HOLD / SELL verdict, and the Composite and Confidence are gone; the Technical
 * and Fundamental scores are reported separately.
 *
 *   node scripts/signals.mjs [data/market_snapshot.json]
 *
 * Prints one JSON document to stdout and exits 0, or prints a reason to stderr
 * and exits 1. Needs Node.js 22 (or 20.19+), which loads the site's ES modules
 * without a package.json.
 */

import { readFile } from 'node:fs/promises';
import { normaliseSnapshot } from '../src/services/snapshotService.js';
import { analyzeTechnicals } from '../src/engines/technicalEngine.js';
import { analyzeFundamentals } from '../src/engines/fundamentalEngine.js';
import { valueOf } from '../src/core/derivationTracer.js';
import { analyzeEvents } from '../src/engines/eventEngine.js';
import { holidaysFor } from '../src/engines/macroCalendarEngine.js';
import { latestShock } from '../src/engines/riskEngine.js';
import { analyzeFactors, benchmarkFor } from '../src/engines/factorEngine.js';
import { recentTrendStates } from '../src/engines/backtestEngine.js';

/** US / Global (US and London listings), SGX, or Crypto (24/7). */
function bucketOf(asset) {
  if (asset.market === 'CRYPTO') return 'crypto';
  if (asset.market === 'SG') return 'sgx';
  return 'global';
}

async function main() {
  const path = process.argv[2] ?? 'data/market_snapshot.json';
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const snapshot = normaliseSnapshot(raw, new Date(raw.generatedAt));
  const calendar = snapshot.macro ? snapshot.macro.calendar : null;
  const holidays = { US: holidaysFor(calendar, 'US'), SG: holidaysFor(calendar, 'SG') };
  const assets = snapshot.assets.map((asset) => {
    // Exactly what main.js does for each asset when the page loads.
    const technical = analyzeTechnicals(asset);
    const fundamental = analyzeFundamentals(asset, { fxRate: snapshot.fx.rate });
    const regime = technical.metrics.trendRegime;
    // Days are counted from the snapshot's own date, so the message matches the data it describes;
    // trading days skip the market's holidays from the macro calendar.
    const events = analyzeEvents(asset, { now: new Date(raw.generatedAt), holidays: holidays[asset.market] ?? null }).metrics;
    const next = events.nextEarnings;
    const move = events.earningsMove;
    const exDividend = events.nextExDividend;
    const shock = latestShock(asset.longSeries.close, asset.longSeries.dates);
    const benchmark = snapshot.byTicker[benchmarkFor(asset)] ?? null;
    const strength = analyzeFactors({ asset, series: asset.series, benchmark, benchmarkSeries: benchmark ? benchmark.series : null }).metrics.relativeStrength3m;
    return {
      ticker: asset.ticker,
      name: asset.name,
      assetClass: asset.assetClass,
      market: asset.market,
      bucket: bucketOf(asset),
      tradable: asset.assetClass !== 'index',
      quoteAsOf: asset.quote.asOf,
      trend: regime && regime.status === 'ok' ? regime.value : null,
      trendHistory: recentTrendStates(asset, 3),
      technical: valueOf(technical.metrics.technicalScore),
      fundamental: valueOf(fundamental.metrics.fundamentalScore),
      nextEarnings: next.status === 'ok'
        ? { date: next.meta.date, dateTo: next.meta.dateTo ?? null, timing: next.meta.timing ?? null, days: next.value, tradingDays: next.meta.tradingDays }
        : null,
      typicalMove: move.status === 'ok' ? move.value : null,
      worstMove: move.status === 'ok' ? move.meta.worst : null,
      nextExDividend: exDividend.status === 'ok'
        ? { date: exDividend.meta.date, estimated: Boolean(exDividend.meta.estimated), days: exDividend.value }
        : null,
      dailyReturn: shock ? shock.dailyReturn : null,
      zScore: shock ? shock.z : null,
      relativeStrength3m: strength.status === 'ok' ? strength.value : null,
      benchmark: strength.status === 'ok' ? strength.meta.benchmark : null,
    };
  });
  process.stdout.write(`${JSON.stringify({ generatedAt: raw.generatedAt, warnings: snapshot.warnings, assets })}\n`);
}

main().catch((error) => {
  process.stderr.write(`signals: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
