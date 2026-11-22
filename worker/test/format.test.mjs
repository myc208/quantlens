/** Numbers, dates, times in New York and Singapore, MarkdownV2 escaping, and message splitting. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixed, pct, sig, price, compact, longDate, dayLabel, clockIn, bothClocks, ordinal, escapeMarkdown, bold, renderLine, groupLines, chunk, TELEGRAM_LIMIT } from '../src/format.js';
import { markdownProblem } from './helpers.mjs';

test('numbers use a real minus sign and never print "−0.0"', () => {
  assert.equal(fixed(1.1, 2), '1.10');
  assert.equal(fixed(-1.74, 1, { signed: true }), '−1.7');
  assert.equal(fixed(1.74, 1, { signed: true }), '+1.7');
  assert.equal(fixed(-0.04, 1, { signed: true }), '0.0');
  assert.equal(fixed(0, 2, { signed: true }), '0.00');
  assert.equal(fixed(null), 'N/A');
  assert.equal(fixed(Number.NaN), 'N/A');
  assert.equal(fixed('3'), 'N/A');
});

test('percentages take fractions', () => {
  assert.equal(pct(0.0208), '2.1%');
  assert.equal(pct(-0.0213, 1, { signed: true }), '−2.1%');
  assert.equal(pct(0.006, 1, { signed: true }), '+0.6%');
  assert.equal(pct(-0.0001, 1, { signed: true }), '0.0%');
  assert.equal(pct(0.00015, 3), '0.015%');
  assert.equal(pct(undefined), 'N/A');
  assert.equal(pct(Infinity), 'N/A');
});

test('significant figures, prices and compact sizes', () => {
  assert.equal(sig(0.00646248, 2), '0.0065');
  assert.equal(sig(0.24, 2), '0.24');
  assert.equal(sig(12.3, 2), '12');
  assert.equal(sig(-0.0123, 2), '−0.012');
  assert.equal(sig(0), '0');
  assert.equal(price(58799), '58,799.00');
  assert.equal(price(1234.5), '1,234.50');
  assert.equal(price(66.11), '66.11');
  assert.equal(price(0.54321), '0.5432');
  assert.equal(price(null), 'N/A');
  assert.equal(compact(428657629), '428.7M');
  assert.equal(compact(31302559605), '31.3B');
  assert.equal(compact(1.5e12), '1.5T');
  assert.equal(compact(1500), '1.5K');
  assert.equal(compact(950), '950');
});

test('dates', () => {
  assert.equal(longDate('2026-11-20'), '20 Nov 2026');
  assert.equal(longDate('2026-11-22T02:32:27Z'), '22 Nov 2026');
  assert.equal(dayLabel('2026-12-09'), 'Wed 9 Dec');
  assert.equal(dayLabel('2027-01-01'), 'Fri 1 Jan');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
});

test('event times in New York and Singapore, either side of both 2026 clock changes', () => {
  // The snapshot's FOMC and CPI times, written with their New York offset.
  assert.equal(bothClocks('2026-12-09T14:00:00-05:00'), 'Wed 9 Dec 2:00 PM ET · Thu 3:00 AM SGT');
  assert.equal(bothClocks('2026-12-10T08:30:00-05:00'), 'Thu 10 Dec 8:30 AM ET · Thu 9:30 PM SGT');
  // US clocks go forward on 8 Mar 2026 and back on 1 Nov 2026; Singapore never changes.
  assert.equal(bothClocks('2026-03-06T13:30:00Z'), 'Fri 6 Mar 8:30 AM ET · Fri 9:30 PM SGT');
  assert.equal(bothClocks('2026-03-11T12:30:00Z'), 'Wed 11 Mar 8:30 AM ET · Wed 8:30 PM SGT');
  assert.equal(bothClocks('2026-10-28T18:00:00Z'), 'Wed 28 Oct 2:00 PM ET · Thu 2:00 AM SGT');
  assert.equal(bothClocks('2026-11-04T19:00:00Z'), 'Wed 4 Nov 2:00 PM ET · Thu 3:00 AM SGT');
  // The New York day is used even when the UTC day has already moved on.
  assert.equal(bothClocks('2026-12-10T01:00:00Z'), 'Wed 9 Dec 8:00 PM ET · Thu 9:00 AM SGT');
  assert.deepEqual(clockIn('2026-11-27T13:00:00-05:00', 'America/New_York'), { time: '1:00 PM', weekday: 'Fri', day: 'Fri 27 Nov' });
  assert.equal(clockIn('2026-11-27T13:00:00-05:00', 'Asia/Singapore').time, '2:00 AM');
});

test('every MarkdownV2 special character is escaped', () => {
  const special = '_*[]()~`>#+-=|{}.!\\';
  const escaped = escapeMarkdown(special);
  assert.equal(escaped, [...special].map((char) => `\\${char}`).join(''));
  assert.equal(escapeMarkdown('RS 1M −2.1% · 1.10'), 'RS 1M −2\\.1% · 1\\.10');
  assert.equal(escapeMarkdown('plain words'), 'plain words');
  assert.equal(markdownProblem(escapeMarkdown('a_b*c [x](y) ~`>#+-=|{}.!\\ end')), null);
});

test('lines render bold parts as MarkdownV2 or as plain text', () => {
  const line = [bold('D05.SI · DBS'), ' close (SGD) 66.11'];
  assert.equal(renderLine(line, true), '*D05\\.SI · DBS* close \\(SGD\\) 66\\.11');
  assert.equal(renderLine(line, false), 'D05.SI · DBS close (SGD) 66.11');
  assert.equal(renderLine('1.5%', true), '1\\.5%');
  assert.equal(renderLine('', true), '');
});

test('a long reply is split between lines, each message under the limit', () => {
  const lines = Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? [bold(`Heading ${i}.`)] : `Line ${i}: ${'a.b-c '.repeat(6)}`));
  const groups = groupLines(lines);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flat(), lines, 'every line once, in order');
  for (const message of chunk(lines)) {
    assert.ok(message.length <= TELEGRAM_LIMIT, `${message.length} characters`);
    assert.equal(markdownProblem(message), null);
  }
  for (const message of chunk(lines, { markdown: false })) assert.ok(message.length <= TELEGRAM_LIMIT);
});

test('a single line longer than a message is cut into plain pieces', () => {
  const long = `${'1.5% (up) '.repeat(1200)}end`;
  const messages = chunk([[bold('Title')], long, 'after']);
  assert.ok(messages.length >= 3);
  for (const message of messages) {
    assert.ok(message.length <= TELEGRAM_LIMIT);
    assert.equal(markdownProblem(message), null);
  }
  const plain = chunk([long], { markdown: false }).join('\n').replace(/\n/g, '');
  assert.equal(plain, long);
});

test('a small limit still splits correctly', () => {
  const messages = chunk(['aaaa', 'bbbb', 'cccc'], { limit: 9 });
  assert.deepEqual(messages, ['aaaa\nbbbb', 'cccc']);
  assert.deepEqual(chunk(['one']), ['one']);
});
