/**
 * format.js: how the bot writes numbers, dates and times, and how a message becomes Telegram text.
 *
 * Every figure in bot_context.json is a raw number (fractions, not percentages). These helpers
 * turn them into display text in one place, so /check, the other commands and the facts digest
 * that Gemini reads (V4.0 checkpoint 2) all print a value the same way.
 */

export const MINUS = '−';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const TELEGRAM_LIMIT = 4096;
const CHUNK_LIMIT = 4000; // a margin under Telegram's limit, which counts text after entity parsing

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** A signed or unsigned number with a real minus sign; "−0.0" is written as "0.0". */
export function fixed(value, digits = 2, { signed = false } = {}) {
  if (!finite(value)) return 'N/A';
  const text = Math.abs(value).toFixed(digits);
  const zero = Number(text) === 0;
  const sign = value < 0 && !zero ? MINUS : signed && !zero ? '+' : '';
  return `${sign}${text}`;
}

/** A fraction as a percentage: 0.0208 → "2.1%", or "+2.1%" when signed. */
export function pct(fraction, digits = 1, { signed = false } = {}) {
  return finite(fraction) ? `${fixed(fraction * 100, digits, { signed })}%` : 'N/A';
}

/** A number with `count` significant figures, for small values such as Amihud (0.006). */
export function sig(value, count = 2) {
  if (!finite(value)) return 'N/A';
  if (value === 0) return '0';
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  return fixed(value, Math.max(0, count - 1 - magnitude));
}

// Intl formatters are slow to build, and a Worker has 10 ms of CPU per message: build each once.
const THOUSANDS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = (timeZone) => new Intl.DateTimeFormat('en-US', {
  timeZone, hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short', day: 'numeric', month: 'short',
});
// Built when the Worker starts (startup time is not counted against a message's CPU).
const CLOCKS = new Map(['America/New_York', 'Asia/Singapore'].map((zone) => [zone, clock(zone)]));

/** A price: thousands separators from 1,000, four decimals below 1, two otherwise. */
export function price(value) {
  if (!finite(value)) return 'N/A';
  if (Math.abs(value) >= 1000) return THOUSANDS.format(value);
  return value.toFixed(Math.abs(value) < 1 ? 4 : 2);
}

/** 428657629 → "428.7M". */
export function compact(value) {
  if (!finite(value)) return 'N/A';
  for (const [size, unit] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (Math.abs(value) >= size) return `${(value / size).toFixed(1)}${unit}`;
  }
  return value.toFixed(0);
}

function parts(iso) {
  const [year, month, day] = String(iso).slice(0, 10).split('-').map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** "20 Nov 2026" */
export function longDate(iso) {
  const { year, month, day } = parts(iso);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** "Wed 9 Dec" */
export function dayLabel(iso) {
  const { month, day, weekday } = parts(iso);
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]}`;
}

/** An instant on the clock of a time zone: { time: "2:00 PM", weekday: "Wed", day: "Wed 9 Dec" }. */
export function clockIn(at, timeZone) {
  if (!CLOCKS.has(timeZone)) CLOCKS.set(timeZone, clock(timeZone));
  const fields = Object.fromEntries(CLOCKS.get(timeZone).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return {
    time: `${fields.hour}:${fields.minute} ${fields.dayPeriod.toUpperCase()}`,
    weekday: fields.weekday,
    day: `${fields.weekday} ${fields.day} ${fields.month}`,
  };
}

/** An event time in both cities: "Wed 9 Dec 2:00 PM ET · Thu 3:00 AM SGT". */
export function bothClocks(at) {
  const et = clockIn(at, 'America/New_York');
  const sgt = clockIn(at, 'Asia/Singapore');
  return `${et.day} ${et.time} ET · ${sgt.weekday} ${sgt.time} SGT`;
}

/** 1 → "1st", 4 → "4th", 22 → "22nd". */
export function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Messages: lines of parts, rendered as MarkdownV2 or as plain text   */
/* ------------------------------------------------------------------ */

const MARKDOWN_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape text for Telegram MarkdownV2. */
export function escapeMarkdown(text) {
  return String(text).replace(MARKDOWN_SPECIAL, (char) => `\\${char}`);
}

/** Bold text inside a message line. */
export const bold = (text) => ({ bold: String(text) });

/**
 * A message is a list of lines; a line is a string or a list of strings and bold() parts.
 * Building it once and rendering it twice gives a plain-text fallback for free.
 */
export function renderLine(line, markdown) {
  const items = Array.isArray(line) ? line : [line];
  return items.map((item) => {
    if (item && typeof item === 'object') return markdown ? `*${escapeMarkdown(item.bold)}*` : item.bold;
    return markdown ? escapeMarkdown(item) : String(item);
  }).join('');
}

/**
 * Group lines into messages that each fit under the limit when rendered as MarkdownV2 (escaping
 * only adds characters, so a group also fits as plain text). Breaks only between lines; a single
 * line too long for one message is first cut into plain pieces, losing its bold.
 */
export function groupLines(lines, { limit = CHUNK_LIMIT } = {}) {
  const pieces = [];
  for (const line of lines) {
    if (renderLine(line, true).length <= limit) {
      pieces.push(line);
      continue;
    }
    const text = renderLine(line, false);
    const step = Math.floor(limit / 2);   // escaping can at most double the length
    for (let start = 0; start < text.length; start += step) pieces.push(text.slice(start, start + step));
  }
  const groups = [];
  let current = [];
  let size = 0;
  for (const piece of pieces) {
    const length = renderLine(piece, true).length;
    if (current.length && size + 1 + length > limit) {
      groups.push(current);
      current = [];
      size = 0;
    }
    size += (current.length ? 1 : 0) + length;
    current.push(piece);
  }
  if (current.length || !groups.length) groups.push(current.length ? current : [' ']);
  return groups;
}

/** The text of each message, as MarkdownV2 or plain text. */
export function chunk(lines, { markdown = true, limit = CHUNK_LIMIT } = {}) {
  return groupLines(lines, { limit }).map((group) => group.map((line) => renderLine(line, markdown)).join('\n'));
}
