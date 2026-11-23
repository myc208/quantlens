#!/usr/bin/env node
/**
 * bot_context.mjs: the engine half of data/bot_context.json (V3.4).
 *
 * A compact, pre-computed summary of the snapshot for a future question-answering bot, so
 * that every number it quotes is a QuantLens number that can be audited on the site. The
 * same engines as the site run over the same snapshot; nothing is re-implemented here.
 *
 * Per asset: trend regime, Technical and Fundamental scores, 1M and 3M relative strength
 * against its own benchmark, its rotation quadrant against the S&P 500 in USD, beta, EWMA
 * volatility and one-day 95% VaR over the last year, the latest session's move in σ, the
 * tick-floor spread, Amihud illiquidity, average traded value, and the next earnings and
 * ex-dividend dates. A value is { "v": ... } or { "na": "<the engine's own reason>" }.
 * Plus the market regime (without its five-year history) and the rotation group medians.
 *
 * V5.0 adds the three-pillar macro regime (`stress`: volatility, credit and rates, with the
 * multiplier that widens every stop) and, per tradable asset, the Decision Radar (`radar`): its
 * health tier and score on total return, the dividend-trap check, two-stage stops for three
 * horizons as fractions and tick-rounded prices at the last close, and ex-dividend and
 * earnings-gap warnings. Indices carry { "na": reason } instead.
 *
 * fetch_fundamentals.py --bot-context adds the triggers (the same rules as the Telegram
 * briefing) and the next 30 days of events, checks the size, and writes the file.
 *
 *   node scripts/bot_context.mjs [data/market_snapshot.json]
 *
 * Prints one JSON document to stdout and exits 0, or prints a reason to stderr and exits 1.
 */

import { readFile } from 'node:fs/promises';
import { normaliseSnapshot } from '../src/services/snapshotService.js';
import { analyzeTechnicals } from '../src/engines/technicalEngine.js';
import { analyzeFundamentals } from '../src/engines/fundamentalEngine.js';
import { analyzeFactors, benchmarkFor } from '../src/engines/factorEngine.js';
import { analyzeRisk, latestShock } from '../src/engines/riskEngine.js';
import { analyzeLiquidity } from '../src/engines/liquidityEngine.js';
import { analyzeEvents } from '../src/engines/eventEngine.js';
import { holidaysFor } from '../src/engines/macroCalendarEngine.js';
import { analyzeRotation } from '../src/engines/rotationEngine.js';
import { analyzeStress } from '../src/engines/stressEngine.js';
import { analyzeRadar, radarBenchmark, RADAR_CONFIG, RADAR_HORIZONS } from '../src/engines/radarEngine.js';

/** Rounded for size: about seven significant figures is far beyond what the inputs support. */
function round(value, digits = 6) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, Math.min(10, digits - 1 - magnitude));
  return Number(value.toFixed(decimals));
}

/** A traced metric as { v } or { na: reason }: the value, never the derivation. */
export function cell(metric) {
  if (!metric) return { na: 'Not computed for this asset.' };
  if (metric.status !== 'ok') return { na: metric.naReason };
  return { v: typeof metric.value === 'number' ? round(metric.value) : metric.value };
}

/** The three-pillar macro regime, as the engine counted it (the VIX pillar alone without FRED data). */
export function stressCell(stress) {
  const pillars = {};
  for (const [name, pillar] of Object.entries(stress.pillars)) {
    pillars[name] = pillar.status === 'unavailable'
      ? { status: 'unavailable', note: pillar.note }
      : { status: pillar.status, flag: pillar.flag, value: round(pillar.value), change: round(pillar.change), from: pillar.from,
        twoYearChange: round(pillar.twoYearChange), asOf: pillar.asOf, series: pillar.series };
  }
  return {
    state: stress.state, multiplier: stress.multiplier, flags: stress.flags, active: stress.active, status: stress.status,
    pillars, rules: stress.rules, note: stress.note,
  };
}

/** One asset's Decision Radar: values and reference prices, never the derivation. */
export function radarCell(radar) {
  const { metrics } = radar;
  if (metrics.healthTier.status !== 'ok') return { na: metrics.healthTier.naReason };
  const score = metrics.healthScore.meta;
  const stops = {};
  for (const horizon of RADAR_HORIZONS) {
    const metric = metrics[RADAR_CONFIG.horizons[horizon].id];
    stops[horizon] = metric.status !== 'ok' ? { na: metric.naReason } : {
      init: round(metric.meta.initPct, 4), breakeven: round(metric.meta.breakevenPct, 4), trail: round(metric.meta.trailPct, 4),
      initPrice: metric.meta.initPrice, breakevenPrice: metric.meta.breakevenPrice, trailPrice: metric.meta.trailPrice,
    };
  }
  const priced = metrics.stopMedium.status === 'ok' ? metrics.stopMedium.meta : null;
  return {
    tier: metrics.healthTier.value, score: metrics.healthScore.value, scores: radar.scores, held: metrics.healthTier.meta.held,
    points: score.points, vs: radar.benchmark, vsTotalReturn: radar.benchmark ? !radar.benchmarkFallback : null,
    dividendYield: round(metrics.dividendYield.value, 4), dividendTrap: metrics.dividendTrap.meta.trap === true,
    drawdown: round(score.drawdown, 4), sigmaDaily: priced ? round(priced.sigmaDaily, 4) : null,
    tick: priced ? priced.tick : null, stops,
    warnings: radar.warnings.map((warning) => Object.fromEntries(Object.entries(warning).map(([key, value]) => [key, typeof value === 'number' ? round(value, 4) : value]))),
  };
}

export function buildEngineContext(raw) {
  const now = new Date(raw.generatedAt);
  const snapshot = normaliseSnapshot(raw, now);
  const calendar = snapshot.macro ? snapshot.macro.calendar : null;
  const holidays = { US: holidaysFor(calendar, 'US'), SG: holidaysFor(calendar, 'SG') };
  const rotation = analyzeRotation({ assets: snapshot.assets, byTicker: snapshot.byTicker, mode: 'spx', fx: { series: snapshot.fx.series, rate: snapshot.fx.rate } });
  const stress = analyzeStress(snapshot.macro);

  const assets = snapshot.assets.map((asset) => {
    const technical = analyzeTechnicals(asset).metrics;
    const fundamental = analyzeFundamentals(asset, { fxRate: snapshot.fx.rate }).metrics;
    const benchmark = snapshot.byTicker[benchmarkFor(asset)] ?? null;
    const factors = analyzeFactors({ asset, series: asset.series, benchmark, benchmarkSeries: benchmark ? benchmark.series : null }).metrics;
    const risk = analyzeRisk(asset, asset.series).metrics;
    const liquidity = analyzeLiquidity(asset, { fxRate: snapshot.fx.rate }).metrics;
    const events = analyzeEvents(asset, { now, holidays: holidays[asset.market] ?? null }).metrics;
    const shock = latestShock(asset.longSeries.close, asset.longSeries.dates);
    const rotated = rotation.byTicker[asset.ticker];
    const traded = cell(liquidity.dollarVolume);
    const radar = analyzeRadar(asset, { benchmark: radarBenchmark(asset, snapshot), stress, events });
    return {
      ticker: asset.ticker, name: asset.name, class: asset.assetClass, market: asset.market, ccy: asset.currency,
      status: asset.status, close: round(asset.quote.lastClose), asOf: asset.quote.asOf,
      trend: cell(technical.trendRegime), technical: cell(technical.technicalScore), fundamental: cell(fundamental.fundamentalScore),
      rs1m: { ...cell(factors.relativeStrength1m), vs: benchmark ? benchmark.ticker : null }, rs3m: cell(factors.relativeStrength3m),
      rotation: rotated ? cell(rotated.metrics.rotation) : { na: 'Indices are not in the rotation view: they cannot be bought.' },
      group: rotated ? rotated.group.name : null,
      beta: cell(factors.beta), ewmaVol: cell(risk.ewmaVolatility), var95: cell(risk.var95),
      shock: shock ? { ret: round(shock.dailyReturn), z: round(shock.z, 3), date: shock.date } : { na: 'Too few returns to measure a move in σ.' },
      spread: cell(liquidity.spreadEstimate), amihud: cell(liquidity.amihud),
      adv: 'v' in traded ? { ...traded, ccy: liquidity.dollarVolume.meta?.currency ?? asset.currency } : traded,
      nextEarnings: events.nextEarnings && events.nextEarnings.status === 'ok'
        ? { date: events.nextEarnings.meta.date, tradingDays: events.nextEarnings.meta.tradingDays, timing: events.nextEarnings.meta.timing ?? null }
        : { na: events.nextEarnings ? events.nextEarnings.naReason : 'No event calendar.' },
      nextExDividend: events.nextExDividend && events.nextExDividend.status === 'ok'
        ? { date: events.nextExDividend.meta.date, estimated: Boolean(events.nextExDividend.meta.estimated) }
        : { na: events.nextExDividend ? events.nextExDividend.naReason : 'No dividend history.' },
      radar: radarCell(radar),
    };
  });

  const block = raw.macro && raw.macro.regime ? raw.macro.regime : null;
  const regime = block ? Object.fromEntries(Object.entries(block).filter(([key]) => !['history', 'historyFields'].includes(key))) : null;
  return {
    asOf: raw.generatedAt,
    regime,
    stress: stressCell(stress),
    rotation: {
      benchmark: 'the S&P 500 in USD (SGD prices converted at each day\'s USD/SGD rate)',
      asOf: rotation.asOf,
      groups: rotation.groups.map((entry) => ({
        group: entry.group.name, quadrant: entry.metric.status === 'ok' ? entry.metric.value : null,
        rs1m: round(entry.metric.meta.median1m), rs3m: round(entry.metric.meta.median3m), members: entry.members,
      })),
    },
    assets,
  };
}

async function main() {
  const path = process.argv[2] ?? 'data/market_snapshot.json';
  const raw = JSON.parse(await readFile(path, 'utf8'));
  process.stdout.write(`${JSON.stringify(buildEngineContext(raw))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bot_context.mjs')) {
  main().catch((error) => {
    process.stderr.write(`bot_context: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
