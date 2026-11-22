#!/usr/bin/env python3
"""sync_macro_calendar.py: refresh scripts/macro_calendar.json from public sources (V3.4).

Run once a month by .github/workflows/sync-macro-calendar.yml, which then runs both test
gates and opens (or updates) a pull request for a person to review. The daily pipeline never
calls any of this: it keeps reading the committed file, with no requests of its own.

  US closures and half days  exchange_calendars (XNYS), rule-based, through the window
  SG closures                data.gov.sg: MOM's gazetted public holidays, one dataset per year
  SGX half days              by rule: the eves of Chinese New Year, Christmas and New Year when
                             they fall on a trading day, closing at 12:00 noon Singapore
  FOMC                       the Fed's FOMC calendar page: rate decisions (a * marks projections),
                             strategy meetings with no decision, released minutes; minutes not
                             yet listed are derived (decision + 21 days) and marked "derived"
  CPI                        FRED's release dates for release 10 (needs FRED_API_KEY). Without a
                             key, or if the request fails, the CPI dates already in the file stay

Every source can fail on its own: a failed source keeps its existing entries and the summary
says so. A source that succeeds but reaches less far than the file (FRED lists next year's CPI
dates only once BLS publishes them) replaces the file's entries up to its own horizon and keeps
the file's later ones, so coverage never shrinks because a source is behind (v3.4.1). The merged file must pass validate_macro_calendar, the same check the daily pipeline
applies, or nothing is written and the script exits 1.

  python scripts/sync_macro_calendar.py [--calendar PATH] [--summary PATH] [--today YYYY-MM-DD] [--dry-run]

The FRED key travels in a query string, so no URL with a query is ever logged or reported.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_fundamentals as ff  # noqa: E402  (the pipeline's own validator and time helpers)

USER_AGENT = "Mozilla/5.0 (compatible; quantlens-calendar-sync)"
TIMEOUT = 20.0
ATTEMPTS = 2
RATE_LIMITED_ATTEMPTS = 4        # data.gov.sg answers 429 when asked too quickly without a key
MAX_WAIT = 30.0                  # the longest Retry-After honoured
PAUSE = 2.0                      # between requests to the same host
HORIZON_MONTHS = 18              # how far ahead the window reaches (sources may stop sooner)

FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
SG_COLLECTION_URL = "https://api-production.data.gov.sg/v2/public/api/collections/691/metadata"
SG_DATASET_URL = "https://data.gov.sg/api/action/datastore_search"
FRED_URL = "https://api.stlouisfed.org/fred/release/dates"
FRED_CPI_RELEASE = 10            # FRED's release id for the Consumer Price Index

SOURCES = {
    "fomc": FED_URL,
    "cpi": "https://www.bls.gov/schedule/news_release/cpi.htm",
    "fred": "https://fred.stlouisfed.org/releases/calendar?rid=10",
    "us": "https://www.nyse.com/markets/hours-calendars",
    "xnys": "https://github.com/gerrymanoim/exchange_calendars",
    "sg": "https://www.mom.gov.sg/employment-practices/public-holidays",
    "sgdata": "https://data.gov.sg/collections/691/view",
    "sgx": "https://rulebook.sgx.com/node/9371",
}
SYNC_NOTE = ("Refreshed monthly by scripts/sync_macro_calendar.py: FOMC from the Fed's calendar page, CPI from FRED "
             "(kept as it was when no FRED key is set), US closures and half days from exchange_calendars, Singapore "
             "holidays from data.gov.sg, and SGX half days by rule. Each refresh arrives as a pull request to review.")

FAMILIES = ("fomc", "cpi", "us", "sg")
TYPE_RANK = {"cpi": 0, "fomc-decision": 1, "fomc-meeting": 1, "fomc-minutes": 2, "market-holiday": 3, "market-early-close": 4}
KEY_ORDER = ("type", "date", "at", "meeting", "period", "market", "name", "projections", "derived", "decision")
MONTHS = {name: index for index, name in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], start=1)}

# exchange_calendars' holiday names, in the wording the file uses. Fixed-date holidays that move
# to a weekday are marked "(observed)".
US_NAMES = {
    "Thanksgiving": "Thanksgiving Day", "Christmas": "Christmas Day", "New Year's Day": "New Year's Day",
    "Dr. Martin Luther King Jr. Day": "Martin Luther King, Jr. Day", "President's Day": "Washington's Birthday",
    "Juneteenth National Independence Day": "Juneteenth", "July 4th": "Independence Day",
    "Good Friday": "Good Friday", "Memorial Day": "Memorial Day", "Labor Day": "Labor Day",
}
US_FIXED_DAYS = {"Christmas Day": (12, 25), "New Year's Day": (1, 1), "Juneteenth": (6, 19), "Independence Day": (7, 4)}
US_EARLY_NAMES = {11: "Day after Thanksgiving", 12: "Christmas Eve", 7: "Day before Independence Day"}


class SyncError(Exception):
    """A source could not be read or understood."""


@dataclass
class SourceResult:
    family: str
    ok: bool
    events: list[dict[str, Any]] = field(default_factory=list)
    horizon: date | None = None
    note: str = ""


@dataclass(frozen=True)
class Window:
    start: date
    end: date

    def holds(self, day: str) -> bool:
        return self.start.isoformat() <= day <= self.end.isoformat()


# ---------------------------------------------------------------- dates and the window

def add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def window_for(today: date) -> Window:
    """From the first day of last month (so the pipeline's 30-day look-back is always covered)
    to the last day of the month 18 months ahead."""
    return Window(add_months(today, -1), add_months(today, HORIZON_MONTHS + 1) - timedelta(days=1))


def year_end(year: int) -> date:
    return date(year, 12, 31)


def new_york(day: str, clock: str) -> str:
    return f"{day}T{clock}:00{ff.new_york_offset(day, clock)}"


# ---------------------------------------------------------------- network

def scrub(text: str) -> str:
    """Remove anything that could carry a key: query strings, and the key itself if set."""
    text = re.sub(r"\?[^\s'\"]*", "?…", str(text))
    key = os.environ.get("FRED_API_KEY", "").strip()
    return text.replace(key, "***") if key else text


def http_get(url: str, params: dict[str, Any] | None = None) -> str:
    """GET with a timeout and one retry. Errors name the host and path only, never the query."""
    full = f"{url}?{urllib.parse.urlencode(params)}" if params else url
    request = urllib.request.Request(full, headers={"User-Agent": USER_AGENT, "Accept": "application/json, text/html;q=0.9"})
    last = "no attempt"
    attempt = 0
    while True:
        wait = 1.0
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310 (fixed https URLs)
                return response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in {401, 403, 404}:
                break
            if exc.code == 429:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                wait = min(MAX_WAIT, float(retry_after)) if retry_after and retry_after.strip().isdigit() else 5.0 * (attempt + 1)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = type(exc).__name__
        attempt += 1
        if attempt >= (RATE_LIMITED_ATTEMPTS if last == "HTTP 429" else ATTEMPTS):
            break
        time.sleep(wait)
    raise SyncError(scrub(f"{urllib.parse.urlsplit(url).netloc}{urllib.parse.urlsplit(url).path}: {last}"))


# ---------------------------------------------------------------- FOMC (the Fed's calendar page)

def _clean(fragment: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", fragment)).replace("&nbsp;", " ").strip()


def _month(name: str) -> int:
    key = name.strip().lower().rstrip(".")
    for full, number in MONTHS.items():
        if full == key or full[:3] == key[:3]:
            return number
    raise SyncError(f"unknown month {name!r} on the FOMC page")


def parse_fomc_page(html: str) -> tuple[list[dict[str, Any]], list[int]]:
    """Meetings on the Fed's calendar page, and the years it has a panel for.

    Each meeting: first and second day, projections (a * after the dates), decision (False for
    a strategy meeting), and the minutes release date when the page lists one. Notation votes and
    unscheduled meetings are left out. A closing note such as "A two-day meeting is scheduled for
    January 25-26, 2028." adds that meeting too.
    """
    headings = [(m.start(), int(m.group(1))) for m in re.finditer(r"(\d{4}) FOMC Meetings", html)]
    if not headings:
        raise SyncError("the FOMC page has no year panels")
    meetings: list[dict[str, Any]] = []
    for index, (start, year) in enumerate(headings):
        end = headings[index + 1][0] if index + 1 < len(headings) else len(html)
        panel = html[start:end]
        cells = list(re.finditer(r'fomc-meeting__month[^>]*>(.*?)</div>', panel, re.S))
        for position, cell in enumerate(cells):
            row_end = cells[position + 1].start() if position + 1 < len(cells) else len(panel)
            row = panel[cell.start():row_end]
            date_cell = re.search(r'fomc-meeting__date[^>]*>(.*?)</div>', row, re.S)
            if not date_cell:
                continue
            months = _clean(cell.group(1))
            days = _clean(date_cell.group(1))
            text = _clean(row)
            if re.search(r"notation vote|unscheduled", text, re.I):
                continue
            match = re.match(r"^(\d{1,2})\s*-\s*(\d{1,2})\s*(\*?)", days)
            if not match:
                continue
            first_month, _, second_month = months.partition("/")
            m1 = _month(first_month)
            m2 = _month(second_month) if second_month else m1
            first = date(year, m1, int(match.group(1)))
            second = date(year + (1 if m2 < m1 else 0), m2, int(match.group(2)))
            released = re.search(r"Released ([A-Za-z]+ \d{1,2}, \d{4})", text)
            meetings.append({
                "first": first, "second": second, "projections": match.group(3) == "*",
                "decision": not re.search(r"strategy meeting", text, re.I),
                "minutes": datetime.strptime(released.group(1), "%B %d, %Y").date() if released else None,
            })
    for note in re.finditer(r"two-day meeting is scheduled for ([A-Za-z]+) (\d{1,2})\s*-\s*(\d{1,2}), (\d{4})", _clean(html)):
        month, d1, d2, year = _month(note.group(1)), int(note.group(2)), int(note.group(3)), int(note.group(4))
        first = date(year, month, d1)
        if not any(meeting["first"] == first for meeting in meetings):
            meetings.append({"first": first, "second": date(year, month, d2), "projections": False, "decision": True, "minutes": None})
    return sorted(meetings, key=lambda meeting: meeting["first"]), sorted({year for _, year in headings})


def meeting_key(meeting: dict[str, Any]) -> str:
    return f"{meeting['first'].isoformat()}/{meeting['second'].day:02d}"


def fomc_events(meetings: list[dict[str, Any]], previous: list[dict[str, Any]], window: Window) -> list[dict[str, Any]]:
    """Decisions (or decision-less meetings) and minutes. Minutes come from the page when it lists
    them, else from a confirmed (not derived) date already in the file, else decision + 21 days."""
    confirmed = {event["meeting"]: event["date"] for event in previous
                 if event.get("type") == "fomc-minutes" and not event.get("derived")}
    events: list[dict[str, Any]] = []
    for meeting in meetings:
        key = meeting_key(meeting)
        day = meeting["second"].isoformat()
        if not meeting["decision"]:
            events.append({"type": "fomc-meeting", "date": day, "meeting": key, "decision": False})
            continue
        decision = {"type": "fomc-decision", "date": day, "at": new_york(day, "14:00"), "meeting": key}
        if meeting["projections"]:
            decision["projections"] = True
        events.append(decision)
        if meeting["minutes"] is not None:
            minutes_day, derived = meeting["minutes"].isoformat(), False
        elif key in confirmed:
            minutes_day, derived = confirmed[key], False
        else:
            minutes_day, derived = (meeting["second"] + timedelta(days=ff.CALENDAR_MINUTES_LAG)).isoformat(), True
        minutes = {"type": "fomc-minutes", "date": minutes_day, "at": new_york(minutes_day, "14:00"), "meeting": key}
        if derived:
            minutes["derived"] = True
        events.append(minutes)
    return [event for event in events if window.holds(event["date"])]


def fomc_source(previous: list[dict[str, Any]], window: Window, fetch: Callable[[], str] | None = None) -> SourceResult:
    html = (fetch or (lambda: http_get(FED_URL)))()
    meetings, years = parse_fomc_page(html)
    scheduled = [meeting for meeting in meetings if meeting["first"].year == years[-1]]
    if len(scheduled) < 4:
        raise SyncError(f"the FOMC page lists only {len(scheduled)} meetings for {years[-1]}; expected about eight")
    events = fomc_events(meetings, previous, window)
    return SourceResult("fomc", True, events, year_end(years[-1]), f"{len(meetings)} meetings on the page, {years[0]} to {years[-1]}")


# ---------------------------------------------------------------- Singapore holidays and SGX half days

def normalise_sg_name(name: str) -> str:
    return re.sub(r"\(Observed\)", "(observed)", name.replace("’", "'").strip())


def parse_sg_records(records: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """(ISO date, name) for every holiday row, weekend or not."""
    holidays = []
    for record in records:
        day = str(record.get("date", ""))[:10]
        name = record.get("holiday")
        if ff.is_iso_date(day) and isinstance(name, str) and name.strip():
            holidays.append((day, normalise_sg_name(name)))
    return sorted(set(holidays))


def sgx_half_days(holidays: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The eves of Chinese New Year, Christmas and New Year, for every year with holiday data,
    when they fall on a weekday that is not itself a holiday."""
    closed = {day for day, _ in holidays}
    years = sorted({int(day[:4]) for day, _ in holidays})
    half: list[tuple[str, str]] = []
    for year in years:
        new_year = sorted(day for day, name in holidays if day.startswith(f"{year}-") and name.startswith("Chinese New Year")
                          and "observed" not in name)
        candidates = [(date(year, 12, 24), "Christmas Eve"), (date(year, 12, 31), "New Year's Eve")]
        if new_year:
            candidates.append((date.fromisoformat(new_year[0]) - timedelta(days=1), "Chinese New Year's Eve"))
        for day, name in candidates:
            if day.weekday() < 5 and day.isoformat() not in closed:
                half.append((day.isoformat(), name))
    return sorted(half)


def sg_events(holidays: list[tuple[str, str]], window: Window) -> list[dict[str, Any]]:
    events = [{"type": "market-holiday", "date": day, "market": "SG", "name": name}
              for day, name in holidays if date.fromisoformat(day).weekday() < 5]
    events += [{"type": "market-early-close", "date": day, "at": ff.early_close_at("SG", day), "market": "SG", "name": name}
               for day, name in sgx_half_days(holidays)]
    return [event for event in events if window.holds(event["date"])]


def fetch_sg_records() -> list[dict[str, Any]]:
    metadata = json.loads(http_get(SG_COLLECTION_URL))
    data = metadata.get("data", {}) if isinstance(metadata, dict) else {}
    collection = data.get("collectionMetadata", data)
    children = collection.get("childDatasets") if isinstance(collection, dict) else None
    if not isinstance(children, list) or not children:
        raise SyncError("data.gov.sg listed no holiday datasets")
    records: list[dict[str, Any]] = []
    for dataset in children:
        time.sleep(PAUSE)
        payload = json.loads(http_get(SG_DATASET_URL, {"resource_id": dataset, "limit": 100}))
        rows = payload.get("result", {}).get("records") if isinstance(payload, dict) else None
        if isinstance(rows, list):
            records.extend(rows)
    return records


def sg_source(previous: list[dict[str, Any]], window: Window, fetch: Callable[[], list[dict[str, Any]]] | None = None) -> SourceResult:
    holidays = parse_sg_records((fetch or fetch_sg_records)())
    if not holidays:
        raise SyncError("data.gov.sg returned no holidays")
    last_year = max(int(day[:4]) for day, _ in holidays)
    if sum(1 for day, _ in holidays if day.startswith(f"{last_year}-")) < 8:
        raise SyncError(f"data.gov.sg has only a partial list for {last_year}")
    events = sg_events(holidays, window)
    return SourceResult("sg", True, events, year_end(last_year), f"holidays to {last_year}, {sum(1 for e in events if e['type'] == 'market-early-close')} SGX half days")


# ---------------------------------------------------------------- US (exchange_calendars)

def us_name(raw: str, day: str) -> str:
    name = US_NAMES.get(raw, raw)
    fixed = US_FIXED_DAYS.get(name)
    if fixed and (int(day[5:7]), int(day[8:10])) != fixed:
        name = f"{name} (observed)"
    return name


def xnys_sessions(start: date, end: date) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Weekday closures and half days from exchange_calendars' NYSE calendar: [(date, raw name)]."""
    try:
        import exchange_calendars as xc
        import pandas as pd
    except ImportError as exc:
        raise SyncError("exchange_calendars is not installed (pip install -r scripts/requirements-calendar.txt)") from exc
    calendar = xc.get_calendar("XNYS", start=start.isoformat(), end=end.isoformat())
    named = calendar.regular_holidays.holidays(pd.Timestamp(start), pd.Timestamp(end), return_name=True)
    names = {stamp.date().isoformat(): str(name) for stamp, name in named.items()}
    closures = [(day.date().isoformat(), names.get(day.date().isoformat(), "Market closed"))
                for day in pd.bdate_range(start, end) if not calendar.is_session(day)]
    sessions = calendar.sessions_in_range(start.isoformat(), end.isoformat())
    regular = max(calendar.session_close(session).tz_convert(calendar.tz).time() for session in sessions[:20])
    half = [(session.date().isoformat(), "") for session in sessions
            if calendar.session_close(session).tz_convert(calendar.tz).time() < regular]
    return closures, half


def us_events(closures: list[tuple[str, str]], half: list[tuple[str, str]], window: Window) -> list[dict[str, Any]]:
    events = [{"type": "market-holiday", "date": day, "market": "US", "name": us_name(raw, day)} for day, raw in closures]
    events += [{"type": "market-early-close", "date": day, "at": ff.early_close_at("US", day), "market": "US",
                "name": US_EARLY_NAMES.get(int(day[5:7]), "Early close")} for day, _ in half]
    return [event for event in events if window.holds(event["date"])]


def us_source(previous: list[dict[str, Any]], window: Window,
              fetch: Callable[[date, date], tuple[list, list]] | None = None) -> SourceResult:
    closures, half = (fetch or xnys_sessions)(window.start, window.end)
    events = us_events(closures, half, window)
    return SourceResult("us", True, events, window.end, f"{len(closures)} closures and {len(half)} half days")


# ---------------------------------------------------------------- CPI (FRED)

def parse_fred_dates(payload: dict[str, Any]) -> list[str]:
    rows = payload.get("release_dates") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise SyncError("FRED returned no release_dates")
    return sorted({row["date"] for row in rows if isinstance(row, dict) and ff.is_iso_date(row.get("date"))})


def cpi_events(release_days: list[str], previous: list[dict[str, Any]], window: Window) -> list[dict[str, Any]]:
    """CPI releases at 8:30 a.m. New York. Each covers the month before it, unless the file
    already says otherwise for that date (a delayed release keeps its recorded period)."""
    periods = {event["date"]: event["period"] for event in previous if event.get("type") == "cpi"}
    events = []
    for day in release_days:
        if not window.holds(day) or date.fromisoformat(day).weekday() >= 5:
            continue
        month_before = add_months(date.fromisoformat(day), -1).isoformat()[:7]
        events.append({"type": "cpi", "date": day, "at": new_york(day, "08:30"), "period": periods.get(day, month_before)})
    return events


def fetch_fred(window: Window) -> dict[str, Any]:
    key = os.environ.get("FRED_API_KEY", "").strip()
    if not key:
        raise SyncError("FRED_API_KEY is not set, so the CPI dates in the file are kept as they are")
    return json.loads(http_get(FRED_URL, {
        "release_id": FRED_CPI_RELEASE, "api_key": key, "file_type": "json", "include_release_dates_with_no_data": "true",
        "realtime_start": window.start.isoformat(), "realtime_end": "9999-12-31", "sort_order": "asc", "limit": 1000}))


def cpi_source(previous: list[dict[str, Any]], window: Window, fetch: Callable[[Window], dict[str, Any]] | None = None) -> SourceResult:
    release_days = parse_fred_dates((fetch or fetch_fred)(window))
    events = cpi_events(release_days, previous, window)
    if not events:
        raise SyncError("FRED listed no CPI releases in the window")
    last = date.fromisoformat(events[-1]["date"])
    # A December release means the agency's whole year is out; otherwise the list stops at the last date.
    horizon = year_end(last.year) if last.month == 12 else last
    return SourceResult("cpi", True, events, horizon, f"{len(events)} releases to {last.isoformat()}")


# ---------------------------------------------------------------- merge, write, report

def family_of(event: dict[str, Any]) -> str:
    kind = event.get("type", "")
    if kind == "cpi":
        return "cpi"
    if kind.startswith("fomc"):
        return "fomc"
    return "us" if event.get("market") == "US" else "sg"


def event_key(event: dict[str, Any]) -> tuple[str, str, str, str]:
    return (event["date"], event["type"], event.get("market", ""), event.get("meeting", ""))


def sort_key(event: dict[str, Any]) -> tuple[str, int, str]:
    return (event["date"], TYPE_RANK.get(event["type"], 9), event.get("market", ""))


def ordered(event: dict[str, Any]) -> dict[str, Any]:
    return {key: event[key] for key in KEY_ORDER if key in event} | {key: value for key, value in event.items() if key not in KEY_ORDER}


def merge(previous: dict[str, Any], results: dict[str, SourceResult], today: date, window: Window) -> dict[str, Any]:
    """The new calendar. A failed source keeps its previous entries and horizon. A source that
    reaches less far than the file replaces entries only up to its own horizon and keeps the
    file's later ones, so its horizon is never shorter than the file's. Names already in the file
    are kept for the same date; everything is clipped to the common horizon."""
    old_events = previous.get("events", [])
    old_names = {event_key(event): event["name"] for event in old_events if "name" in event}
    old_to = date.fromisoformat(previous["coverage"]["to"])
    events: list[dict[str, Any]] = []
    horizons: dict[str, date] = {}
    for family in FAMILIES:
        result = results.get(family)
        if result is not None and result.ok:
            reach = result.horizon or old_to
            short = reach < old_to
            for event in result.events:
                if short and event["date"] > reach.isoformat():
                    continue
                if "name" in event and event_key(event) in old_names:
                    event = {**event, "name": old_names[event_key(event)]}
                events.append(event)
            if short:
                # The source has not published that far yet: keep what the file already holds.
                events.extend(event for event in old_events if family_of(event) == family
                              and event["date"] > reach.isoformat() and window.holds(event["date"]))
            horizons[family] = max(reach, old_to)
        else:
            events.extend(event for event in old_events if family_of(event) == family and window.holds(event["date"]))
            horizons[family] = old_to
    to = min(min(horizons.values()), window.end)
    # A failed source was not refreshed for the new early months, so coverage starts where it did.
    every_source = all(results.get(family) is not None and results[family].ok for family in FAMILIES)
    start = window.start.isoformat() if every_source else max(window.start.isoformat(), previous["coverage"]["from"])
    kept = sorted((ordered(event) for event in events if start <= event["date"] <= to.isoformat()), key=sort_key)
    notes = [note for note in previous.get("notes", []) if not note.startswith("Refreshed monthly by")] + [SYNC_NOTE]
    sources = {**previous.get("sources", {}), **SOURCES}
    return {"updated": today.isoformat(), "coverage": {"from": start, "to": to.isoformat()},
            "sources": sources, "notes": notes, "events": kept}


def format_calendar(calendar: dict[str, Any]) -> str:
    """The file's own layout: one event per line, so a pull request shows one line per change."""
    dump = lambda value: json.dumps(value, ensure_ascii=False)  # noqa: E731
    obj = lambda mapping: "{ " + ", ".join(f"{dump(key)}: {dump(value)}" for key, value in mapping.items()) + " }"  # noqa: E731
    lines = ["{", f'  "updated": {dump(calendar["updated"])},', f'  "coverage": {obj(calendar["coverage"])},', '  "sources": {']
    sources = list(calendar["sources"].items())
    lines += [f"    {dump(key)}: {dump(value)}{',' if index + 1 < len(sources) else ''}" for index, (key, value) in enumerate(sources)]
    lines += ["  },", '  "notes": [']
    lines += [f"    {dump(note)}{',' if index + 1 < len(calendar['notes']) else ''}" for index, note in enumerate(calendar["notes"])]
    lines += ["  ],", '  "events": [']
    lines += [f"    {obj(event)}{',' if index + 1 < len(calendar['events']) else ''}" for index, event in enumerate(calendar["events"])]
    lines += ["  ]", "}"]
    return "\n".join(lines) + "\n"


def material(calendar: dict[str, Any], today: date) -> tuple[Any, ...]:
    """What a reviewer cares about: everything from today on. Past events ageing out of the window
    and the date stamp alone are not worth a pull request."""
    upcoming = [ordered(event) for event in calendar["events"] if event["date"] >= today.isoformat()]
    return (calendar["coverage"]["to"], json.dumps(upcoming, sort_keys=True), json.dumps(calendar["sources"], sort_keys=True), tuple(calendar["notes"]))


def describe(event: dict[str, Any]) -> str:
    detail = event.get("name") or event.get("meeting") or event.get("period") or ""
    flags = " (projections)" if event.get("projections") else " (derived)" if event.get("derived") else ""
    return f"{event['date']} {event['type']}{' ' + event['market'] if 'market' in event else ''}{': ' + detail if detail else ''}{flags}"


def report(previous: dict[str, Any], merged: dict[str, Any], results: dict[str, SourceResult], errors: list[str]) -> str:
    """Markdown for the pull request and the step summary: what each source did, and every change."""
    lines = ["## Macro calendar sync", ""]
    lines.append(f"Coverage **{merged['coverage']['from']} to {merged['coverage']['to']}** "
                 f"(was {previous['coverage']['from']} to {previous['coverage']['to']}), {len(merged['events'])} events.")
    lines += ["", "| Source | Result | Reaches |", "|---|---|---|"]
    for family in FAMILIES:
        result = results.get(family)
        if result is not None and result.ok:
            reach = result.horizon.isoformat() if result.horizon else "—"
            if result.horizon and reach < previous["coverage"]["to"]:
                lines.append(f"| {family} | ✅ {result.note}; kept the existing entries after {reach}, "
                             f"which the source does not list yet | {previous['coverage']['to']} |")
            else:
                lines.append(f"| {family} | ✅ {result.note} | {reach} |")
        else:
            why = result.note if result is not None else "not run"
            lines.append(f"| {family} | ⚠️ kept the existing entries: {why} | {previous['coverage']['to']} |")
    # Changes inside the stretch both versions cover.
    start = max(previous["coverage"]["from"], merged["coverage"]["from"])
    end = min(previous["coverage"]["to"], merged["coverage"]["to"])
    before = {event_key(e): e for e in previous["events"] if start <= e["date"] <= end}
    after = {event_key(e): e for e in merged["events"] if start <= e["date"] <= end}
    added = [after[key] for key in sorted(set(after) - set(before))]
    removed = [before[key] for key in sorted(set(before) - set(after))]
    changed = [(before[key], after[key]) for key in sorted(set(before) & set(after)) if ordered(before[key]) != ordered(after[key])]
    beyond = [e for e in merged["events"] if e["date"] > previous["coverage"]["to"]]
    lines += ["", f"Within {start} to {end}: {len(added)} added, {len(removed)} removed, {len(changed)} changed; "
                  f"{len(beyond)} new events beyond the old coverage."]
    for title, items in (("Added", added), ("Removed", removed)):
        if items:
            lines += ["", f"**{title}**", ""] + [f"- {describe(event)}" for event in items]
    if changed:
        lines += ["", "**Changed**", ""] + [f"- {describe(old)} → {describe(new)}" for old, new in changed]
    if errors:
        lines += ["", "**Validation failed; nothing was written:**", ""] + [f"- {error}" for error in errors[:20]]
    return "\n".join(lines) + "\n"


SOURCE_RUNNERS: dict[str, Callable[..., SourceResult]] = {"fomc": fomc_source, "cpi": cpi_source, "us": us_source, "sg": sg_source}


def run_sync(previous: dict[str, Any], today: date, fetchers: dict[str, Callable] | None = None) -> tuple[dict[str, Any], dict[str, SourceResult], list[str]]:
    """Run every source (with optional injected fetchers for tests), merge and validate."""
    window = window_for(today)
    results: dict[str, SourceResult] = {}
    for family, runner in SOURCE_RUNNERS.items():
        try:
            results[family] = runner(previous.get("events", []), window, (fetchers or {}).get(family))
        except (SyncError, ValueError, KeyError, json.JSONDecodeError) as exc:
            results[family] = SourceResult(family, False, note=scrub(str(exc)) or type(exc).__name__)
        except Exception as exc:  # noqa: BLE001 (one broken source must never stop the others)
            results[family] = SourceResult(family, False, note=f"unexpected {type(exc).__name__}: {scrub(str(exc))[:200]}")
    merged = merge(previous, results, today, window)
    return merged, results, ff.validate_macro_calendar(merged)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh scripts/macro_calendar.json from public sources.")
    parser.add_argument("--calendar", type=Path, default=ff.DEFAULT_CALENDAR)
    parser.add_argument("--summary", type=Path, default=None, help="also write the markdown summary here")
    parser.add_argument("--today", type=date.fromisoformat, default=None, help="pretend today is this date (UTC)")
    parser.add_argument("--dry-run", action="store_true", help="report, but do not write the calendar")
    args = parser.parse_args(argv)
    today = args.today or datetime.now(timezone.utc).date()
    previous = ff.load_json(args.calendar)
    merged, results, errors = run_sync(previous, today)
    text = report(previous, merged, results, errors)
    print(text)
    for path in [args.summary, Path(os.environ["GITHUB_STEP_SUMMARY"]) if os.environ.get("GITHUB_STEP_SUMMARY") else None]:
        if path is not None:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(text)
    if errors:
        return 1
    rendered = format_calendar(merged)
    if args.dry_run:
        return 0
    if material(previous, today) == material(merged, today):
        print("No calendar changes from today on.")
        return 0
    args.calendar.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"Wrote {args.calendar}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
