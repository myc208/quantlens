/** From what someone types to a watchlist ticker, and only to one the snapshot holds. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTicker, watchlistLines, ALIASES } from '../src/tickers.js';
import { FIXTURE, COMMITTED } from './helpers.mjs';

const assets = FIXTURE.assets;
const found = (query) => resolveTicker(query, assets).asset?.ticker ?? null;

test('tickers, short codes, aliases and names resolve to the watchlist', () => {
  const cases = {
    // exact tickers, any case, with $ or ^
    'D05.SI': 'D05.SI', 'd05.si': 'D05.SI', TSLA: 'TSLA', '$tsla': 'TSLA', ' voo ': 'VOO', 'brk-b': 'BRK-B',
    '^GSPC': '^GSPC', gspc: '^GSPC', '^sti': '^STI', STI: '^STI', ixic: '^IXIC', 'CSPX.L': 'CSPX.L',
    // short codes
    d05: 'D05.SI', U11: 'U11.SI', c6l: 'C6L.SI', a17u: 'A17U.SI', btc: 'BTC-USD', '$BTC': 'BTC-USD', eth: 'ETH-USD', avax: 'AVAX-USD',
    BRK: 'BRK-B', cspx: 'CSPX.L',
    // aliases
    DBS: 'D05.SI', dbs: 'D05.SI', UOB: 'U11.SI', SIA: 'C6L.SI', 'Singapore Airlines': 'C6L.SI', KDC: 'AJBU.SI', keppel: 'AJBU.SI',
    CLAR: 'A17U.SI', Ascendas: 'A17U.SI', FCT: 'J69U.SI', Frasers: 'J69U.SI', SPX: '^GSPC', 'S&P 500': '^GSPC', 'S&P': '^GSPC',
    sp500: '^GSPC', Dow: '^DJI', 'Dow Jones': '^DJI', DJIA: '^DJI', Nasdaq: '^IXIC', 'Straits Times': '^STI', 'brk.b': 'BRK-B',
    'BRK/B': 'BRK-B', Berkshire: 'BRK-B', lilly: 'LLY', Exxon: 'XOM', 'Exxon Mobil': 'XOM', sandisk: 'SNDK', bitcoin: 'BTC-USD',
    XBT: 'BTC-USD', ether: 'ETH-USD', Ethereum: 'ETH-USD', Avalanche: 'AVAX-USD',
    // the first word of the name
    Micron: 'MU', walmart: 'WMT', Cameco: 'CCJ', Caterpillar: 'CAT', Newmont: 'NEM', Oracle: 'ORCL', Tesla: 'TSLA',
    BlackRock: 'BLK', Wheaton: 'WPM',
  };
  for (const [query, ticker] of Object.entries(cases)) assert.equal(found(query), ticker, `"${query}"`);
});

test('a name the watchlist does not hold is not tracked, never guessed', () => {
  for (const query of ['AAPL', 'NVDA', 'Microsoft', 'gold', 'SOL', 'OCBC', '1234', 'what']) {
    const result = resolveTicker(query, assets);
    assert.equal(result.missing, true, query);
    assert.equal(result.asset, undefined);
  }
  assert.deepEqual(resolveTicker('', assets), { missing: true, query: '', suggestion: null });
  assert.equal(resolveTicker('   ', assets).query, '');
  assert.equal(resolveTicker('$nvda', assets).query, 'NVDA');
});

test('a one-letter slip is offered as a suggestion, not used', () => {
  const amdd = resolveTicker('AMDD', assets);
  assert.equal(amdd.missing, true);
  assert.equal(amdd.suggestion.ticker, 'AMD');
  assert.equal(resolveTicker('TSAL', assets).suggestion, null, 'a swap is two edits');
  assert.equal(resolveTicker('TSLAA', assets).suggestion.ticker, 'TSLA');
  assert.equal(resolveTicker('walmrt', assets).suggestion.ticker, 'WMT');
  assert.equal(resolveTicker('DBSS', assets).suggestion.ticker, 'D05.SI', 'aliases count as near misses');
  assert.equal(resolveTicker('AM', assets).suggestion, null, 'too short to guess');
});

test('an alias only works when its ticker is in the snapshot', () => {
  const withoutDbs = assets.filter((asset) => asset.ticker !== 'D05.SI');
  assert.equal(resolveTicker('DBS', withoutDbs).missing, true);
  assert.equal(resolveTicker('D05', withoutDbs).missing, true);
  for (const target of new Set(Object.values(ALIASES))) assert.ok(assets.some((asset) => asset.ticker === target), `${target} is in the fixture`);
});

test('a short code shared by two assets is not resolved by code', () => {
  const twins = [{ ticker: 'ABC.SI', name: 'Alpha Holdings' }, { ticker: 'ABC-USD', name: 'Alpha Coin' }];
  assert.equal(resolveTicker('ABC', twins).missing, true);
  assert.equal(resolveTicker('abc.si', twins).asset.ticker, 'ABC.SI');
  assert.equal(resolveTicker('Alpha', twins).missing, true, 'two names share the first word');
});

test('nothing breaks on odd input', () => {
  for (const query of [null, undefined, 42, '????', '/check', 'D05 please', '💹']) assert.doesNotThrow(() => resolveTicker(query, assets));
  assert.equal(resolveTicker('D05', null).missing, true);
});

test('the watchlist lines name every asset once, by market', () => {
  for (const list of [FIXTURE.assets, COMMITTED.assets]) {
    const lines = watchlistLines(list);
    const named = lines.flatMap((line) => line.split(': ')[1].split(' '));
    assert.deepEqual([...named].sort(), list.map((asset) => asset.ticker).sort());
  }
  assert.deepEqual(watchlistLines(FIXTURE.assets).map((line) => line.split(':')[0]), ['US', 'SGX', 'London', 'Crypto', 'Indices']);
  assert.equal(watchlistLines(FIXTURE.assets)[4], 'Indices: ^IXIC ^GSPC ^DJI ^STI');
  assert.deepEqual(watchlistLines([]), []);
});

test('every committed ticker resolves to itself', () => {
  for (const asset of COMMITTED.assets) assert.equal(resolveTicker(asset.ticker, COMMITTED.assets).asset.ticker, asset.ticker);
});
