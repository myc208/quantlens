/**
 * digest.js: the facts Gemini may use, written out in display units.
 *
 * Gemini never sees raw JSON. It reads the lines the commands print, built by the same code,
 * so every figure in an answer can be traced to a /check card or a command, and the number
 * check (numbers.js) can compare an answer against this text. The Rankings section orders the
 * main figures in advance, so "which is the most volatile?" needs no arithmetic.
 */

import { assetCard, footer, regimeLines, triggerLines, rotationLines, upcomingLines } from './commands.js';
import { renderLine, longDate, fixed, pct } from './format.js';
import { watchlistLines } from './tickers.js';
import { radarLines, stopLines, hasRadar } from './radar.js';

const GLOSSARY = [
  'Trend: the trend regime label (Uptrend, Extended, Pullback, Recovering or Downtrend).',
  'Technical and Fundamental: scores from 0 to 100.',
  'RS 1M and RS 3M: return relative to the benchmark after "vs", over 30 and 91 days.',
  'Rotation: the quadrant against the S&P 500 in USD (Leading, Weakening, Lagging, Improving), and the asset\'s group.',
  'Beta: against the asset\'s own benchmark, last year. EWMA vol: annualised volatility, last year. 1-day VaR 95%: one-day 95% historical value at risk, last year.',
  'Last move: the latest session\'s return, and in brackets the same move in units of the volatility known the day before (σ).',
  'Spread: one price tick as a share of the price, the least a round trip costs. Amihud: basis points of price move per US$1 million traded, last 20 sessions. Traded: average daily traded value, last 20 sessions.',
  'A "~" date is expected, not confirmed. "N/A" figures carry the reason they are missing.',
];

// V5.0: read only when the summary carries the Decision Radar.
const RADAR_GLOSSARY = [
  'Macro regime (three pillars): volatility (VIX ÷ VIX3M), credit (US high-yield spread) and rates (10Y − 2Y Treasury spread); 0 flags Calm ×1.00, 1 Cautious ×1.15, 2-3 Stressed ×1.35. The multiplier widens every Decision Radar stop.',
  'Decision Radar: a health score of 0-4 on total return (one point each for trend, strength against the benchmark over 3 months, momentum, and a drawdown under 12%). Healthy = 3-4; Neutral = 2, or 0-1 not yet on three sessions ("held"); Weakest · Dead Money = 0-1 on three sessions running. It describes the last year; it is not a forecast or a sell list.',
  'Dividend trap: a yield of 3% or more with a drawdown deeper than 2.5 × the yield, or a losing year.',
  'Stops by horizon: short = 2 weeks to 1 month, medium = 3 to 6 months, long = 1 year or more. Each has an initial stop below the last close, a breakeven trigger above it (then the stop is raised to the entry) and a trail below the highest close. Percentages are of the last close; prices are in the asset\'s currency, rounded to its tick. They are volatility-sized risk boundaries, not advice.',
];

const value = (cell) => (cell && typeof cell === 'object' && typeof cell.v === 'number' ? cell.v : null);

const RANKINGS = [
  ['Technical score', (asset) => value(asset.technical), (v) => fixed(v, 0)],
  ['Fundamental score', (asset) => value(asset.fundamental), (v) => fixed(v, 0)],
  ['EWMA vol', (asset) => value(asset.ewmaVol), (v) => pct(v, 1)],
  ['1-day VaR 95%', (asset) => value(asset.var95), (v) => pct(v, 1)],
  ['Last move', (asset) => (asset.shock && typeof asset.shock.ret === 'number' ? asset.shock.ret : null), (v) => pct(v, 1, { signed: true })],
];

/** One line per figure: every asset that has it, highest first. */
export function rankingLines(assets) {
  return RANKINGS.map(([label, read, show]) => {
    const ranked = assets.map((asset) => [asset.ticker, read(asset)]).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1]);
    return `${label}, highest first: ${ranked.map(([ticker, v]) => `${ticker} ${show(v)}`).join(' · ')}`;
  });
}

/** The snapshot as text for the model. */
export function factsDigest(context) {
  const end = footer(context);
  const text = (lines) => lines.map((line) => renderLine(line, false)).filter((line) => line !== end);
  const closes = [...new Set(context.assets.map((asset) => asset.asOf).filter(Boolean))].sort();
  const latest = closes.length ? longDate(closes.at(-1)) : longDate(context.asOf);
  const sections = [
    [
      `QuantLens snapshot of ${longDate(context.asOf)} (asOf ${context.asOf}). Closes are the last completed daily closes (latest ${latest}); nothing here is a live price.`,
      `The watchlist has ${context.assets.length} assets. Anything not listed here is not tracked:`,
      ...watchlistLines(context.assets),
    ],
    ['How to read the figures:', ...GLOSSARY, ...(hasRadar(context) ? RADAR_GLOSSARY : [])],
    ['== Market regime ==', ...text(regimeLines(context))],
    ...(hasRadar(context) ? [
      ['== Decision Radar ==', ...text(radarLines(context)).slice(1).filter((line) => line !== '')],
      ['== Stops by horizon ==', ...stopLines(context)],
    ] : []),
    ['== Triggers ==', ...text(triggerLines(context))],
    ['== Rotation ==', ...text(rotationLines(context)).filter((line) => line !== '')],
    ['== Next 30 days ==', ...text(upcomingLines(context)).slice(1)],
    ['== Rankings ==', ...rankingLines(context.assets)],
    ['== Assets ==', ...context.assets.flatMap((asset) => ['', ...text(assetCard(asset, context, {}))])],
  ];
  return sections.map((lines) => lines.join('\n')).join('\n\n');
}
