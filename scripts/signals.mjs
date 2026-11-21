#!/usr/bin/env node
/**
 * signals.mjs: every asset's verdict, computed by the site's own engines.
 *
 * The daily Telegram briefing (fetch_fundamentals.py --notify) runs this so that
 * the signals in the message are exactly the ones the site shows: the same
 * technical, fundamental and advisor engines over the same snapshot, with no
 * second implementation in Python to drift out of step.
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
import { advise } from '../src/engines/advisorEngine.js';
import { valueOf } from '../src/core/derivationTracer.js';
import { analyzeEvents } from '../src/engines/eventEngine.js';

async function main() {
  const path = process.argv[2] ?? 'data/market_snapshot.json';
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const snapshot = normaliseSnapshot(raw, new Date(raw.generatedAt));
  const assets = snapshot.assets.map((asset) => {
    // Exactly what main.js does for each asset when the page loads.
    const technical = analyzeTechnicals(asset);
    const fundamental = analyzeFundamentals(asset, { fxRate: snapshot.fx.rate });
    const advice = advise({ asset, technical, fundamental });
    const confidence = advice.metrics.confidence;
    // Days are counted from the snapshot's own date, so the message matches the data it describes.
    const events = analyzeEvents(asset, { now: new Date(raw.generatedAt) }).metrics;
    const next = events.nextEarnings;
    const move = events.earningsMove;
    return {
      ticker: asset.ticker,
      name: asset.name,
      assetClass: asset.assetClass,
      verdict: advice.verdict ?? null,
      composite: valueOf(advice.metrics.compositeScore),
      technical: valueOf(technical.metrics.technicalScore),
      fundamental: valueOf(fundamental.metrics.fundamentalScore),
      confidence: confidence.status === 'ok' ? confidence.value : null,
      nextEarnings: next.status === 'ok' ? { date: next.meta.date, days: next.value, tradingDays: next.meta.tradingDays } : null,
      typicalMove: move.status === 'ok' ? move.value : null,
      worstMove: move.status === 'ok' ? move.meta.worst : null,
    };
  });
  process.stdout.write(`${JSON.stringify({ generatedAt: raw.generatedAt, warnings: snapshot.warnings, assets })}\n`);
}

main().catch((error) => {
  process.stderr.write(`signals: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
