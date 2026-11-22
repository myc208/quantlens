/**
 * tickers.js: from what someone types ("d05", "BTC", "S&P 500", "uob") to a watchlist ticker.
 *
 * Only assets in the snapshot can be found: a name the watchlist does not hold is reported as
 * not tracked, never guessed from outside knowledge. Order of tries:
 *
 *   1. the exact ticker, ignoring case, a leading "$" and an index's "^"   (d05.si, $tsla, gspc)
 *   2. the ticker's short code, before ".", "-" or "="                     (D05 → D05.SI, BTC → BTC-USD)
 *   3. a hand-kept alias, used only if its ticker is in the snapshot       (UOB, SIA, SPX, DOW, BRK.B)
 *   4. the first word of the asset's name                                  (Micron, Walmart, Cameco)
 * A near miss (one letter wrong) is offered as a suggestion, not silently used.
 */

export const ALIASES = Object.freeze({
  // Singapore
  DBS: 'D05.SI', UOB: 'U11.SI', SIA: 'C6L.SI', SINGAPOREAIRLINES: 'C6L.SI',
  KEPPEL: 'AJBU.SI', KDC: 'AJBU.SI', KEPPELDC: 'AJBU.SI', KDCREIT: 'AJBU.SI',
  ASCENDAS: 'A17U.SI', CLAR: 'A17U.SI', CAPITALAND: 'A17U.SI', FRASERS: 'J69U.SI', FCT: 'J69U.SI',
  // Indices and funds
  SPX: '^GSPC', SP500: '^GSPC', 'S&P': '^GSPC', 'S&P500': '^GSPC', GSPC: '^GSPC',
  STI: '^STI', STRAITSTIMES: '^STI', DOW: '^DJI', DJIA: '^DJI', DOWJONES: '^DJI',
  NASDAQ: '^IXIC', COMP: '^IXIC', CSPX: 'CSPX.L',
  // US names people abbreviate
  BRK: 'BRK-B', BRKB: 'BRK-B', 'BRK.B': 'BRK-B', 'BRK/B': 'BRK-B', BERKSHIRE: 'BRK-B',
  LILLY: 'LLY', EXXON: 'XOM', EXXONMOBIL: 'XOM', SANDISK: 'SNDK',
  // Crypto
  BITCOIN: 'BTC-USD', XBT: 'BTC-USD', ETHER: 'ETH-USD', ETHEREUM: 'ETH-USD', AVALANCHE: 'AVAX-USD',
});

const normal = (text) => String(text ?? '').trim().replace(/^\$/, '').toUpperCase();
const squeezed = (text) => normal(text).replace(/\s+/g, '');
const bare = (ticker) => ticker.replace(/^\^/, '').toUpperCase();
const shortCode = (ticker) => bare(ticker).split(/[.\-=]/)[0];
const firstWord = (name) => String(name ?? '').split(/[\s,]+/)[0].replace(/[^A-Za-z0-9&]/g, '').toUpperCase();

/** One-edit distance check (insert, delete or replace one character). */
function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Find an asset of the snapshot.
 * @returns {{ asset:object } | { missing:true, query:string, suggestion:object|null }}
 */
export function resolveTicker(query, assets) {
  const wanted = squeezed(query);
  const list = Array.isArray(assets) ? assets : [];
  if (!wanted) return { missing: true, query: '', suggestion: null };
  const byTicker = new Map(list.map((asset) => [bare(asset.ticker), asset]));
  const exact = byTicker.get(wanted.replace(/^\^/, ''));
  if (exact) return { asset: exact };
  const byCode = list.filter((asset) => shortCode(asset.ticker) === wanted);
  if (byCode.length === 1) return { asset: byCode[0] };
  const alias = ALIASES[wanted] ?? ALIASES[normal(query)];
  if (alias && byTicker.get(bare(alias))) return { asset: byTicker.get(bare(alias)) };
  const byName = list.filter((asset) => firstWord(asset.name) === wanted);
  if (byName.length === 1) return { asset: byName[0] };
  // Not found: offer the one asset that is a single letter away, if there is exactly one.
  const near = new Set();
  if (wanted.length >= 3) {
    for (const asset of list) {
      if ([bare(asset.ticker), shortCode(asset.ticker), firstWord(asset.name)].some((key) => key.length >= 2 && oneEditApart(key, wanted))) near.add(asset);
    }
    for (const [key, target] of Object.entries(ALIASES)) {
      if (oneEditApart(key, wanted) && byTicker.get(bare(target))) near.add(byTicker.get(bare(target)));
    }
  }
  return { missing: true, query: normal(query), suggestion: near.size === 1 ? [...near][0] : null };
}

/** The watchlist as one line per market, for "not tracked" replies. */
export function watchlistLines(assets) {
  const groups = [['US', (a) => a.market === 'US' && a.class !== 'index'], ['SGX', (a) => a.market === 'SG' && a.class !== 'index'],
    ['London', (a) => a.market === 'UK'], ['Crypto', (a) => a.market === 'CRYPTO'], ['Indices', (a) => a.class === 'index']];
  return groups.map(([name, test]) => [name, (assets || []).filter(test).map((asset) => asset.ticker)])
    .filter(([, tickers]) => tickers.length).map(([name, tickers]) => `${name}: ${tickers.join(' ')}`);
}
