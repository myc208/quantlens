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
    ['How to read the figures:', ...GLOSSARY],
    ['== Market regime ==', ...text(regimeLines(context))],
    ['== Triggers ==', ...text(triggerLines(context))],
    ['== Rotation ==', ...text(rotationLines(context)).filter((line) => line !== '')],
    ['== Next 30 days ==', ...text(upcomingLines(context)).slice(1)],
    ['== Rankings ==', ...rankingLines(context.assets)],
    ['== Assets ==', ...context.assets.flatMap((asset) => ['', ...text(assetCard(asset, context, {}))])],
  ];
  return sections.map((lines) => lines.join('\n')).join('\n\n');
}
