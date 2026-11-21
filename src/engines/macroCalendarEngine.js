/**
 * macroCalendarEngine.js: scheduled macro events from the hand-kept calendar (V3.2).
 *
 *   fomc-decision        FOMC rate decision, 2:00 p.m. New York (with projections at four meetings)
 *   fomc-minutes         minutes of a meeting, three weeks after its decision
 *   fomc-meeting         a meeting without a policy decision (the October 2027 strategy meeting)
 *   cpi                  US Consumer Price Index release, 8:30 a.m. New York
 *   market-holiday       a weekday when the US market or SGX is closed
 *   market-early-close   a US half day (1:00 p.m. close)
 *
 * "Market-moving" means an FOMC decision or a CPI release: those are what the 48-hour
 * trigger and the next-event countdown look at. Times carry their own UTC offset, so no
 * daylight-saving arithmetic happens here.
 *
 * Context only: no score, verdict or position size uses the calendar. It does make the
 * trading-day counts of the event layer skip market holidays (see holidaysFor).
 */

import { traced, notAvailable, input, step, threshold, interpretation } from '../core/derivationTracer.js';

export const MACRO_CONFIG = Object.freeze({
  triggerHours: 48,
  weekDays: 7,
  monthDays: 30,
  sizingHorizon: 21,
  marketMoving: Object.freeze(['fomc-decision', 'cpi']),
});

export const MACRO_METRIC_IDS = Object.freeze(['nextMacroEvent']);

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MONTHS = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
const SHORT_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

/** "Wed 9 Dec" for an ISO date. */
export function shortDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]}`;
}

/** The moment an event happens (ms since epoch): its `at`, or noon UTC of its date for date-only events. */
export function eventTime(event) {
  return event.at ? Date.parse(event.at) : Date.parse(`${event.date}T12:00:00Z`);
}

/** A plain-language name for a calendar event. */
export function eventTitle(event) {
  switch (event.type) {
    case 'fomc-decision': return `FOMC rate decision${event.projections ? ' and projections' : ''}`;
    case 'fomc-meeting': return 'FOMC strategy meeting (no policy decision)';
    case 'fomc-minutes': {
      const first = event.meeting ? event.meeting.slice(0, 10) : null;
      return first ? `FOMC minutes (${Number(first.slice(8, 10))}–${Number(event.meeting.slice(11))} ${SHORT_MONTHS[Number(first.slice(5, 7)) - 1]} meeting)` : 'FOMC minutes';
    }
    case 'cpi': return `US CPI for ${MONTHS[Number(event.period.slice(5, 7)) - 1]}`;
    case 'market-holiday': return `${event.market === 'US' ? 'US markets' : 'SGX'} closed: ${event.name}`;
    case 'market-early-close': return `US markets close at 1:00 p.m. (${event.name})`;
    default: return event.type;
  }
}

/** The local clock time of a timed event in New York and Singapore, e.g. "2:00 p.m. New York (3:00 a.m. Thu Singapore)". */
export function eventClock(event) {
  if (!event.at) return null;
  const moment = new Date(eventTime(event));
  // Assembled from parts, so the wording does not depend on the locale's ordering.
  const clock = (timeZone, withDay) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short',
    }).formatToParts(moment).map((part) => [part.type, part.value]));
    const time = `${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase() === 'AM' ? 'a.m.' : 'p.m.'}`;
    return withDay ? `${time} ${parts.weekday}` : time;
  };
  return `${clock('America/New_York', false)} New York (${clock('Asia/Singapore', true)} Singapore)`;
}

/** ISO dates on which a market is closed on a weekday, from the calendar. */
export function holidaysFor(calendar, market) {
  if (!calendar || calendar.status !== 'fresh') return new Set();
  return new Set(calendar.events.filter((event) => event.type === 'market-holiday' && event.market === market).map((event) => event.date));
}

/** Events from now on, within `days` calendar days (by date) and optionally only of some types. */
export function upcomingEvents(calendar, now, { days = MACRO_CONFIG.monthDays, types = null } = {}) {
  if (!calendar || calendar.status !== 'fresh') return [];
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  return calendar.events.filter((event) => {
    if (types && !types.includes(event.type)) return false;
    if (event.date > limit) return false;
    return event.at ? eventTime(event) > nowMs : event.date >= today;
  });
}

/** Weekday sessions after `fromIso` up to and including `toIso`, skipping the given holidays. */
function usTradingDays(fromIso, toIso, holidays) {
  let count = 0;
  let time = Date.parse(`${fromIso}T00:00:00Z`);
  const end = Date.parse(`${toIso}T00:00:00Z`);
  while (time < end) {
    time += DAY_MS;
    const day = new Date(time);
    const iso = day.toISOString().slice(0, 10);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !holidays.has(iso)) count += 1;
  }
  return count;
}

/**
 * The next market-moving event and what else is coming.
 * @param {object|null} calendar the normalised macro.calendar block
 * @param {{ now?: Date }} [options]
 */
export function analyzeMacro(calendar, { now = new Date() } = {}) {
  const id = 'nextMacroEvent';
  const label = 'Next FOMC decision or CPI release';
  const formula = 'Days to the next FOMC rate decision or US CPI release in the macro calendar; flagged within 48 hours';
  const empty = (reason) => ({ status: calendar ? calendar.status : 'unavailable', next: null, within48h: [], next7: [], next30: [], metrics: { [id]: notAvailable({ id, label, unit: 'days', formula, reason }) } });
  if (!calendar || calendar.status !== 'fresh') {
    return empty(calendar && calendar.note ? calendar.note : 'This snapshot has no macro calendar.');
  }
  const moving = upcomingEvents(calendar, now, { days: 400, types: MACRO_CONFIG.marketMoving });
  const next7 = upcomingEvents(calendar, now, { days: MACRO_CONFIG.weekDays });
  const next30 = upcomingEvents(calendar, now, { days: MACRO_CONFIG.monthDays });
  if (!moving.length) {
    return { ...empty(`The macro calendar lists no FOMC decision or CPI release after today (it covers to ${calendar.coverage.to}). Add the next year's dates to scripts/macro_calendar.json.`), next7, next30 };
  }
  const next = moving[0];
  const hours = (eventTime(next) - now.getTime()) / HOUR_MS;
  const within48h = moving.filter((event) => (eventTime(event) - now.getTime()) / HOUR_MS <= MACRO_CONFIG.triggerHours);
  const today = now.toISOString().slice(0, 10);
  const calendarDays = Math.round((Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  const usHolidays = holidaysFor(calendar, 'US');
  const tradingDays = usTradingDays(today, next.date, usHolidays);
  const insideSizing = tradingDays <= MACRO_CONFIG.sizingHorizon;
  const soon = hours <= MACRO_CONFIG.triggerHours;
  const title = eventTitle(next);
  const clock = eventClock(next);
  const listed = (events) => events.map((event) => ({ type: event.type, date: event.date, at: event.at ?? null, market: event.market ?? null, title: eventTitle(event) }));
  const others = next7.filter((event) => event !== next);
  const staleNote = calendar.note ? ` ${calendar.note}` : '';
  const metric = traced({
    id, label, value: calendarDays, unit: 'days', tone: soon ? 'caution' : 'neutral',
    meta: {
      type: next.type, date: next.date, at: next.at, title, clock, hours, within48h: soon, calendarDays, tradingDays, insideSizing,
      projections: next.projections === true, next7: listed(next7), next30: listed(next30), coverageTo: calendar.coverage.to, updated: calendar.updated, stale: Boolean(calendar.note),
    },
    formula,
    rawInputs: [
      input(title, next.at, '', `scripts/macro_calendar.json (updated ${calendar.updated}), copied into the snapshot`, next.date),
      input('Now', now.toISOString(), '', 'browser clock'),
    ],
    steps: [
      step('Next FOMC decision or CPI release', `${shortDay(next.date)}, ${clock}`, title),
      step('Hours from now', `${next.at} − now`, `${Math.round(hours)} hours`),
      step('Calendar days', `${next.date} − ${today}`, calendarDays),
      step('US trading days until then (weekdays, less US market holidays from the calendar)', `sessions after ${today}`, tradingDays),
      step(`Inside the ${MACRO_CONFIG.sizingHorizon}-day sizing horizon?`, `${tradingDays} ≤ ${MACRO_CONFIG.sizingHorizon}`, insideSizing ? 'yes' : 'no'),
      step(`Within ${MACRO_CONFIG.triggerHours} hours?`, `${Math.round(hours)} ≤ ${MACRO_CONFIG.triggerHours}`, soon ? 'yes' : 'no'),
      ...(others.length ? [step(`Also in the next ${MACRO_CONFIG.weekDays} days`, others.map((event) => `${shortDay(event.date)}: ${eventTitle(event)}`).join('; '), others.length)] : []),
    ],
    interpretation: interpretation(
      `${title} on ${shortDay(next.date)} at ${clock}, ${calendarDays === 0 ? 'today' : calendarDays === 1 ? 'tomorrow' : `in ${calendarDays} days`}${insideSizing ? `, inside the ${MACRO_CONFIG.sizingHorizon}-day sizing horizon` : ''}.`,
      [threshold(`Within ${MACRO_CONFIG.triggerHours} hours`, 'Imminent: every asset can move at once', 'caution'), threshold('Further out', 'On the calendar', 'neutral')],
      `Context only: no score, verdict or position size uses it. A scheduled announcement can move every asset at once, and a stop cannot protect against a gap at the open. Dates come from the Fed and BLS calendars as copied on ${calendar.updated}; FOMC dates are tentative until confirmed at the meeting before.${staleNote}`,
    ),
  });
  return { status: 'fresh', next, within48h, next7, next30, metrics: { [id]: metric } };
}

/** Plain-language pieces for the telemetry pill. */
export function describeMacro(analysis) {
  if (!analysis || !analysis.next) return { label: 'N/A', soon: false, pill: 'No macro calendar', title: null };
  const meta = analysis.metrics.nextMacroEvent.meta;
  const short = analysis.next.type === 'cpi' ? 'CPI' : 'FOMC';
  const when = meta.calendarDays === 0 ? 'today' : meta.calendarDays === 1 ? 'tomorrow' : `in ${meta.calendarDays} days`;
  return { label: `${short} ${shortDay(analysis.next.date)}`, soon: meta.within48h, pill: when, title: meta.title };
}
