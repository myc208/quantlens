/**
 * numbers.js: the number check on a model answer.
 *
 * Every figure with a decimal point or a % sign in the answer must also be written somewhere in
 * the facts digest (or in the question being answered). One that is not was invented or
 * calculated, so it is listed under the answer as not in the snapshot. Whole numbers are not
 * checked: they are mostly counts, dates and days. Signs, thousands separators and trailing
 * zeros are ignored, so "fell 1.8%" matches "−1.8%" and "1.1" matches "1.10"; a percentage
 * matches only a percentage.
 */

const NUMBER = /[−+-]?\d[\d,]*(?:\.\d+)?%?/g;

// A percentage only matches a percentage: "45%" is not backed by a score of 45.
const key = (token) => `${Number(token.replace(/[−+\-,%]/g, ''))}${token.endsWith('%') ? '%' : ''}`;

/** Every number written in the texts, as comparison keys. */
export function numberKeys(...texts) {
  const keys = new Set();
  for (const text of texts) for (const token of String(text ?? '').match(NUMBER) ?? []) keys.add(key(token));
  return keys;
}

/** The decimal and percentage figures in `answer` that none of the sources contains. */
export function unsupportedNumbers(answer, ...sources) {
  const known = numberKeys(...sources);
  const flagged = [];
  for (const token of String(answer ?? '').match(NUMBER) ?? []) {
    const shown = token.replace(/,$/, '');
    if (!shown.includes('.') && !shown.includes('%')) continue;
    if (!known.has(key(shown)) && !flagged.includes(shown)) flagged.push(shown);
  }
  return flagged;
}
