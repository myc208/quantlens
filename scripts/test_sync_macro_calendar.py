#!/usr/bin/env python3
"""Unit tests for scripts/sync_macro_calendar.py (V3.4). No network: every source is a fixture
shaped like the real response (the Fed's calendar page, data.gov.sg rows, FRED JSON).

    python -m unittest discover -s scripts -p "test_*.py"
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from datetime import date
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_fundamentals as ff  # noqa: E402
import sync_macro_calendar as sync  # noqa: E402

TODAY = date(2026, 11, 22)
COMMITTED = ff.load_json(ff.DEFAULT_CALENDAR)
HAS_EXCHANGE_CALENDARS = importlib.util.find_spec("exchange_calendars") is not None


def row(month: str, days: str, extra: str = "") -> str:
    """One meeting row, in the Fed page's own markup."""
    return (f'<div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong>{month}</strong></div>'
            f'<div class="fomc-meeting__date col-xs-4">{days}</div><div class="col-lg-2">{extra}</div>'
            f'<div class="col-lg-4 fomc-meeting__minutes">{""}</div></div>')


def panel(year: int, rows: list[str], footer: str = "") -> str:
    return (f'<div class="panel panel-default"><div class="panel-heading"><h4><a id="{year}">{year} FOMC Meetings</a></h4></div>'
            f'{"".join(rows)}<div class="panel-footer">{footer}</div></div>')


FED_FIXTURE = "".join([
    panel(2026, [
        row("October", "27-28", "Minutes: PDF | HTML (Released November 18, 2026)"),
        row("November", "9 (notation vote)"),
        row("December", "8-9*"),
    ], "* Meeting associated with a Summary of Economic Projections."),
    panel(2024, [row("Apr/May", "30-1*")]),
    panel(2027, [
        row("January", "26-27"), row("March", "16-17"), row("April", "27-28"), row("June", "8-9"),
        row("July", "27-28"), row("September", "14-15"), row("October", "26-27", "Monetary Policy Strategy Meeting"),
        row("November", "16-17"),
    ], "Note: A two-day meeting is scheduled for January 25-26, 2028."),
])


def fed_page_from(calendar: dict) -> str:
    """A Fed page that lists exactly the committed decisions, the strategy meeting and the one
    released set of minutes (October 2026): what the real page showed on 22 November 2026."""
    by_year: dict[int, list[str]] = {}
    month_name = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    for event in calendar["events"]:
        if event["type"] not in {"fomc-decision", "fomc-meeting"}:
            continue
        first = date.fromisoformat(event["meeting"][:10])
        second = date.fromisoformat(event["date"])
        days = f"{first.day}-{second.day}{'*' if event.get('projections') else ''}"
        extra = "Monetary Policy Strategy Meeting" if event["type"] == "fomc-meeting" else ""
        by_year.setdefault(first.year, []).append(row(month_name[first.month - 1], days, extra))
    by_year.setdefault(2026, []).insert(0, row("October", "27-28", "Minutes: PDF | HTML (Released November 18, 2026)"))
    return "".join(panel(year, rows) for year, rows in sorted(by_year.items()))


SG_2026 = [
    {"date": "2026-02-17", "holiday": "Chinese New Year"}, {"date": "2026-02-18", "holiday": "Chinese New Year"},
    {"date": "2026-11-08", "holiday": "Deepavali"}, {"date": "2026-11-09", "holiday": "Deepavali (Observed)"},
    {"date": "2026-12-25", "holiday": "Christmas Day"},
    {"date": "2026-01-01", "holiday": "New Year’s Day"}, {"date": "2026-04-03", "holiday": "Good Friday"},
    {"date": "2026-05-01", "holiday": "Labour Day"}, {"date": "2026-08-09", "holiday": "National Day"},
    {"date": "2026-08-10", "holiday": "National Day (Observed)"},
]
SG_2027 = [  # data.gov.sg, d_0ba69fc6d56717ff0bf8083c6af3bb84, as returned on 22 November 2026
    {"date": "2027-01-01", "holiday": "New Year’s Day"}, {"date": "2027-02-06", "holiday": "Chinese New Year"},
    {"date": "2027-02-07", "holiday": "Chinese New Year"}, {"date": "2027-02-08", "holiday": "Chinese New Year (Observed)"},
    {"date": "2027-03-10", "holiday": "Hari Raya Puasa"}, {"date": "2027-03-26", "holiday": "Good Friday"},
    {"date": "2027-05-01", "holiday": "Labour Day"}, {"date": "2027-05-17", "holiday": "Hari Raya Haji"},
    {"date": "2027-05-20", "holiday": "Vesak Day"}, {"date": "2027-08-09", "holiday": "National Day"},
    {"date": "2027-10-28", "holiday": "Deepavali"}, {"date": "2027-12-25", "holiday": "Christmas Day"},
]


def fred_payload(days: list[str]) -> dict:
    return {"realtime_start": "2026-10-01", "release_dates": [{"release_id": 10, "date": day} for day in days]}


def committed_fetchers(calendar: dict = COMMITTED) -> dict:
    """Fake sources that return exactly what the committed calendar says."""
    us_closures = [(e["date"], e["name"]) for e in calendar["events"] if e["type"] == "market-holiday" and e["market"] == "US"]
    us_half = [(e["date"], "") for e in calendar["events"] if e["type"] == "market-early-close" and e["market"] == "US"]
    cpi_days = [e["date"] for e in calendar["events"] if e["type"] == "cpi"]
    return {
        "fomc": lambda: fed_page_from(calendar),
        "sg": lambda: SG_2026 + SG_2027,
        "us": lambda start, end: (us_closures, us_half),
        "cpi": lambda window: fred_payload(cpi_days),
    }


def failing(message: str):
    def fetch(*_args):
        raise sync.SyncError(message)
    return fetch


class Window(unittest.TestCase):
    def test_from_last_month_to_eighteen_months_ahead(self):
        self.assertEqual(sync.window_for(TODAY), sync.Window(date(2026, 10, 1), date(2028, 5, 31)))
        self.assertEqual(sync.window_for(date(2027, 1, 15)), sync.Window(date(2026, 12, 1), date(2028, 7, 31)))


class FomcPage(unittest.TestCase):
    def test_rows_projections_strategy_minutes_cross_month_and_the_closing_note(self):
        meetings, years = sync.parse_fomc_page(FED_FIXTURE)
        self.assertEqual(years, [2024, 2026, 2027])
        by_first = {meeting["first"].isoformat(): meeting for meeting in meetings}
        self.assertNotIn("2026-11-09", by_first)                                     # notation vote left out
        self.assertEqual(by_first["2026-10-27"]["minutes"], date(2026, 11, 18))
        self.assertTrue(by_first["2026-12-08"]["projections"])
        self.assertFalse(by_first["2027-01-26"]["projections"])
        self.assertFalse(by_first["2027-10-26"]["decision"])                         # the strategy meeting
        self.assertEqual(by_first["2024-04-30"]["second"], date(2024, 5, 1))          # Apr/May 30-1
        self.assertEqual(sync.meeting_key(by_first["2024-04-30"]), "2024-04-30/01")
        self.assertEqual(by_first["2028-01-25"]["second"], date(2028, 1, 26))         # from the closing note
        self.assertEqual(len([m for m in meetings if m["first"].year == 2027]), 8)

    def test_minutes_come_from_the_page_then_the_file_then_the_rule(self):
        meetings, _ = sync.parse_fomc_page(FED_FIXTURE)
        previous = [{"type": "fomc-minutes", "date": "2026-12-30", "at": "2026-12-30T14:00:00-05:00", "meeting": "2026-12-08/09"}]
        events = sync.fomc_events(meetings, previous, sync.window_for(TODAY))
        minutes = {event["meeting"]: event for event in events if event["type"] == "fomc-minutes"}
        self.assertEqual(minutes["2026-10-27/28"]["date"], "2026-11-18")
        self.assertNotIn("derived", minutes["2026-10-27/28"])                        # listed on the page
        self.assertEqual(minutes["2026-12-08/09"]["date"], "2026-12-30")
        self.assertNotIn("derived", minutes["2026-12-08/09"])                        # confirmed in the file
        self.assertEqual(minutes["2027-01-26/27"], {"type": "fomc-minutes", "date": "2027-02-17", "at": "2027-02-17T14:00:00-05:00",
                                                    "meeting": "2027-01-26/27", "derived": True})
        self.assertNotIn("2027-10-26/27", minutes)                                   # no decision, no minutes listed
        strategy = [event for event in events if event["type"] == "fomc-meeting"]
        self.assertEqual(strategy, [{"type": "fomc-meeting", "date": "2027-10-27", "meeting": "2027-10-26/27", "decision": False}])
        decision = next(event for event in events if event["type"] == "fomc-decision" and event["date"] == "2027-06-09")
        self.assertEqual(decision["at"], "2027-06-09T14:00:00-04:00")                # daylight saving in June
        self.assertFalse(any(event["date"].startswith("2024") for event in events))   # outside the window
        for event in events:
            self.assertEqual(ff.validate_calendar_event(event, event["date"]), [])

    def test_a_page_that_lost_its_meetings_fails_rather_than_emptying_the_calendar(self):
        with self.assertRaises(sync.SyncError):
            sync.fomc_source([], sync.window_for(TODAY), lambda: panel(2027, [row("January", "26-27")]))
        with self.assertRaises(sync.SyncError):
            sync.parse_fomc_page("<html>maintenance</html>")


class Singapore(unittest.TestCase):
    def test_names_are_normalised_and_weekend_holidays_dropped(self):
        holidays = sync.parse_sg_records(SG_2027)
        self.assertIn(("2027-01-01", "New Year's Day"), holidays)                     # curly apostrophe straightened
        self.assertIn(("2027-02-08", "Chinese New Year (observed)"), holidays)
        events = sync.sg_events(holidays, sync.window_for(TODAY))
        closed = [event["date"] for event in events if event["type"] == "market-holiday"]
        self.assertNotIn("2027-02-06", closed)                                       # a Saturday needs no entry
        self.assertIn("2027-02-08", closed)

    def test_sgx_half_days_are_the_eves_that_fall_on_trading_days(self):
        half = sync.sgx_half_days(sync.parse_sg_records(SG_2026 + SG_2027))
        self.assertEqual(half, [("2026-02-16", "Chinese New Year's Eve"), ("2026-12-24", "Christmas Eve"), ("2026-12-31", "New Year's Eve"),
                                ("2027-02-05", "Chinese New Year's Eve"), ("2027-12-24", "Christmas Eve"), ("2027-12-31", "New Year's Eve")])
        # 2028: Chinese New Year on Wednesday 26 January; Christmas Eve and New Year's Eve are weekends.
        later = sync.sgx_half_days([("2028-01-26", "Chinese New Year"), ("2028-01-27", "Chinese New Year")])
        self.assertEqual(later, [("2028-01-25", "Chinese New Year's Eve")])
        # An eve on a Sunday is no half day.
        self.assertEqual(sync.sgx_half_days([("2029-02-12", "Chinese New Year")]), [("2029-12-24", "Christmas Eve"), ("2029-12-31", "New Year's Eve")])
        early = sync.sg_events(sync.parse_sg_records(SG_2027), sync.window_for(TODAY))
        friday = next(event for event in early if event["date"] == "2027-02-05")
        self.assertEqual(friday["at"], "2027-02-05T12:00:00+08:00")

    def test_singapore_reproduces_the_committed_calendar(self):
        result = sync.sg_source(COMMITTED["events"], sync.window_for(TODAY), lambda: SG_2026 + SG_2027)
        made = {(e["type"], e["date"], e.get("at")) for e in result.events if e["date"] >= "2026-11-01"}
        kept = {(e["type"], e["date"], e.get("at")) for e in COMMITTED["events"] if e.get("market") == "SG"}
        self.assertEqual(made, kept)
        self.assertEqual(result.horizon, date(2027, 12, 31))

    def test_a_partial_year_is_refused(self):
        with self.assertRaises(sync.SyncError):
            sync.sg_source([], sync.window_for(TODAY), lambda: SG_2026 + SG_2027[:3])


class UnitedStates(unittest.TestCase):
    def test_library_names_in_the_files_wording(self):
        self.assertEqual(sync.us_name("Christmas", "2027-12-24"), "Christmas Day (observed)")
        self.assertEqual(sync.us_name("July 4th", "2027-07-05"), "Independence Day (observed)")
        self.assertEqual(sync.us_name("Juneteenth National Independence Day", "2027-06-18"), "Juneteenth (observed)")
        self.assertEqual(sync.us_name("Thanksgiving", "2026-11-26"), "Thanksgiving Day")
        self.assertEqual(sync.us_name("National Day of Mourning", "2027-01-05"), "National Day of Mourning")

    def test_closures_and_half_days_become_events(self):
        events = sync.us_events([("2026-11-26", "Thanksgiving")], [("2026-11-27", "")], sync.window_for(TODAY))
        self.assertEqual(events, [
            {"type": "market-holiday", "date": "2026-11-26", "market": "US", "name": "Thanksgiving Day"},
            {"type": "market-early-close", "date": "2026-11-27", "at": "2026-11-27T13:00:00-05:00", "market": "US", "name": "Day after Thanksgiving"},
        ])

    @unittest.skipUnless(HAS_EXCHANGE_CALENDARS, "exchange_calendars is not installed (scripts/requirements-calendar.txt)")
    def test_exchange_calendars_agrees_with_the_committed_calendar(self):
        result = sync.us_source([], sync.window_for(TODAY))
        made = {(e["type"], e["date"], e.get("at")) for e in result.events if "2026-11-01" <= e["date"] <= COMMITTED["coverage"]["to"]}
        kept = {(e["type"], e["date"], e.get("at")) for e in COMMITTED["events"] if e.get("market") == "US"}
        self.assertEqual(made, kept)


class Cpi(unittest.TestCase):
    def test_periods_times_weekends_and_a_delayed_release(self):
        previous = [{"type": "cpi", "date": "2027-01-13", "at": "2027-01-13T08:30:00-05:00", "period": "2026-11"}]   # a delayed release
        events = sync.cpi_events(["2026-09-11", "2026-12-10", "2027-01-13", "2027-03-13", "2027-04-13"], previous, sync.window_for(TODAY))
        self.assertEqual([(e["date"], e["period"]) for e in events], [("2026-12-10", "2026-11"), ("2027-01-13", "2026-11"), ("2027-04-13", "2027-03")])
        self.assertEqual(events[-1]["at"], "2027-04-13T08:30:00-04:00")
        for event in events:
            self.assertEqual(ff.validate_calendar_event(event, event["date"]), [])

    def test_horizon_reaches_the_year_end_only_with_a_december_release(self):
        window = sync.window_for(TODAY)
        full = sync.cpi_source([], window, lambda _w: fred_payload(["2027-11-10", "2027-12-10"]))
        self.assertEqual(full.horizon, date(2027, 12, 31))
        part = sync.cpi_source([], window, lambda _w: fred_payload(["2027-05-12", "2027-06-10"]))
        self.assertEqual(part.horizon, date(2027, 6, 10))
        with self.assertRaises(sync.SyncError):
            sync.parse_fred_dates({"error_code": 400})

    def test_without_a_key_the_file_keeps_its_cpi_dates(self):
        with mock.patch.dict(os.environ, {"FRED_API_KEY": ""}):
            with self.assertRaisesRegex(sync.SyncError, "kept"):
                sync.fetch_fred(sync.window_for(TODAY))

    def test_the_key_never_reaches_a_message(self):
        with mock.patch.dict(os.environ, {"FRED_API_KEY": "SECRET-KEY-123"}):
            text = sync.scrub("https://api.stlouisfed.org/fred/release/dates?api_key=SECRET-KEY-123&release_id=10 SECRET-KEY-123 failed")
            self.assertNotIn("SECRET-KEY-123", text)
            self.assertNotIn("api_key", text)
            error = urllib.error.HTTPError("https://api.stlouisfed.org/fred/release/dates?api_key=SECRET-KEY-123", 500, "boom", {}, None)
            with mock.patch("urllib.request.urlopen", side_effect=error), mock.patch("time.sleep"):
                with self.assertRaises(sync.SyncError) as caught:
                    sync.fetch_fred(sync.window_for(TODAY))
            self.assertNotIn("SECRET-KEY-123", str(caught.exception))
            self.assertEqual(str(caught.exception), "api.stlouisfed.org/fred/release/dates: HTTP 500")

    def test_rate_limits_are_waited_out_then_given_up(self):
        error = urllib.error.HTTPError("https://data.gov.sg/api/action/datastore_search", 429, "slow down", {"Retry-After": "3"}, None)
        with mock.patch("urllib.request.urlopen", side_effect=error) as opened, mock.patch("time.sleep") as slept:
            with self.assertRaises(sync.SyncError):
                sync.http_get(sync.SG_DATASET_URL, {"resource_id": "x"})
        self.assertEqual(opened.call_count, sync.RATE_LIMITED_ATTEMPTS)
        self.assertEqual(slept.call_args_list[0].args, (3.0,))


class Merge(unittest.TestCase):
    def test_every_source_reproduces_the_committed_calendar(self):
        merged, results, errors = sync.run_sync(copy.deepcopy(COMMITTED), TODAY, committed_fetchers())
        self.assertEqual(errors, [])
        self.assertTrue(all(result.ok for result in results.values()), {k: r.note for k, r in results.items()})
        self.assertEqual(merged["coverage"], {"from": "2026-10-01", "to": COMMITTED["coverage"]["to"]})
        self.assertEqual([e for e in merged["events"] if e["date"] >= "2026-11-01"], COMMITTED["events"])
        october = [e for e in merged["events"] if e["date"] < "2026-11-01"]
        self.assertEqual([(e["type"], e["date"]) for e in october], [("fomc-decision", "2026-10-28")])   # last month, for the look-back
        self.assertEqual(sync.material(merged, TODAY), sync.material(COMMITTED, TODAY))   # so the first monthly run opens no pull request
        self.assertIn(sync.SYNC_NOTE, merged["notes"])

    def test_a_failed_source_keeps_its_entries_and_the_old_start(self):
        fetchers = {**committed_fetchers(), "cpi": failing("FRED_API_KEY is not set, so the CPI dates in the file are kept as they are")}
        merged, results, errors = sync.run_sync(copy.deepcopy(COMMITTED), TODAY, fetchers)
        self.assertEqual(errors, [])
        self.assertFalse(results["cpi"].ok)
        self.assertEqual([e for e in merged["events"] if e["type"] == "cpi"], [e for e in COMMITTED["events"] if e["type"] == "cpi"])
        self.assertEqual(merged["coverage"]["from"], COMMITTED["coverage"]["from"])   # not refreshed for October
        text = sync.report(COMMITTED, merged, results, errors)
        self.assertIn("| cpi | ⚠️ kept the existing entries: FRED_API_KEY is not set", text)
        self.assertIn("0 added, 0 removed, 0 changed", text)

    def test_an_unexpected_crash_in_one_source_is_contained(self):
        def explode():
            raise RuntimeError("parser bug")
        merged, results, errors = sync.run_sync(copy.deepcopy(COMMITTED), TODAY, {**committed_fetchers(), "fomc": explode})
        self.assertEqual(errors, [])
        self.assertIn("unexpected RuntimeError", results["fomc"].note)
        self.assertEqual([e for e in merged["events"] if e["type"].startswith("fomc") and e["date"] >= "2026-11-01"],
                         [e for e in COMMITTED["events"] if e["type"].startswith("fomc")])

    def test_a_source_that_reaches_less_far_keeps_the_files_later_entries(self):
        # The live run of 22 Nov 2026: FRED listed CPI only to 10 Dec 2026 (it loads next year's
        # dates once BLS publishes them). Its releases replace the file's up to its horizon; the
        # file's 2027 releases stay, and coverage does not shrink. Here FRED also moves December.
        fetchers = {**committed_fetchers(), "cpi": lambda window: fred_payload(["2026-10-14", "2026-11-10", "2026-12-11"])}
        merged, results, errors = sync.run_sync(copy.deepcopy(COMMITTED), TODAY, fetchers)
        self.assertEqual(errors, [])
        self.assertTrue(results["cpi"].ok)
        self.assertEqual(results["cpi"].horizon, date(2026, 12, 31))
        self.assertEqual(merged["coverage"]["to"], COMMITTED["coverage"]["to"])          # never shrinks
        cpi = [e for e in merged["events"] if e["type"] == "cpi"]
        self.assertEqual([e["date"] for e in cpi if e["date"] <= "2026-12-31"], ["2026-10-14", "2026-11-10", "2026-12-11"])   # FRED's
        self.assertEqual([e for e in cpi if e["date"] > "2026-12-31"],
                         [e for e in COMMITTED["events"] if e["type"] == "cpi" and e["date"] > "2026-12-31"])           # the file's
        self.assertEqual(next(e for e in cpi if e["date"] == "2026-12-11")["period"], "2026-11")
        others = lambda calendar: [e for e in calendar["events"] if e["type"] != "cpi" and e["date"] >= "2026-11-01"]
        self.assertEqual(others(merged), others(COMMITTED))                                       # nothing else moves
        text = sync.report(COMMITTED, merged, results, errors)
        self.assertIn("| cpi | ✅ 3 releases to 2026-12-11; kept the existing entries after 2026-12-31, which the source does not list yet | 2027-12-31 |", text)
        self.assertIn("- 2026-12-10 cpi: 2026-11", text)                                    # reported as removed…
        self.assertIn("- 2026-12-11 cpi: 2026-11", text)                                    # …and added

    def test_coverage_grows_only_as_far_as_the_shortest_source(self):
        trimmed = copy.deepcopy(COMMITTED)
        trimmed["coverage"]["to"] = "2027-06-30"
        trimmed["events"] = [e for e in trimmed["events"] if e["date"] <= "2027-06-30"]
        merged, _, errors = sync.run_sync(copy.deepcopy(trimmed), TODAY, committed_fetchers())
        self.assertEqual(errors, [])
        self.assertEqual(merged["coverage"]["to"], "2027-12-31")                                 # every source reaches further
        short = {**committed_fetchers(), "cpi": lambda window: fred_payload(["2026-12-10", "2027-01-13", "2027-02-11", "2027-03-10"])}
        merged, _, errors = sync.run_sync(copy.deepcopy(trimmed), TODAY, short)
        self.assertEqual(errors, [])
        self.assertEqual(merged["coverage"]["to"], "2027-06-30")                                 # CPI is known only to June
        self.assertTrue(all(event["date"] <= "2027-06-30" for event in merged["events"]))
        self.assertEqual([e["date"] for e in merged["events"] if e["type"] == "cpi" and e["date"] > "2027-03-10"],
                         ["2027-04-13", "2027-05-12", "2027-06-10"])                             # kept from the file

    def test_a_calendar_that_would_run_out_is_not_written(self):
        # A file already near its end, and a source that cannot extend it: validation refuses it.
        trimmed = copy.deepcopy(COMMITTED)
        trimmed["coverage"]["to"] = "2026-12-31"
        trimmed["events"] = [e for e in trimmed["events"] if e["date"] <= "2026-12-31"]
        fetchers = {**committed_fetchers(), "cpi": lambda window: fred_payload(["2026-12-10"])}
        merged, results, errors = sync.run_sync(trimmed, TODAY, fetchers)
        self.assertTrue(any("60 days" in error for error in errors))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "macro_calendar.json"
            path.write_text(ff.DEFAULT_CALENDAR.read_text(encoding="utf-8"), encoding="utf-8")
            before = path.read_text(encoding="utf-8")
            with mock.patch.object(sync, "run_sync", return_value=(merged, results, errors)), mock.patch("builtins.print"):
                self.assertEqual(sync.main(["--calendar", str(path), "--today", TODAY.isoformat()]), 1)
            self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_only_changes_from_today_on_are_written(self):
        merged, results, errors = sync.run_sync(copy.deepcopy(COMMITTED), TODAY, committed_fetchers())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "macro_calendar.json"
            path.write_text(ff.DEFAULT_CALENDAR.read_text(encoding="utf-8"), encoding="utf-8")
            before = path.read_text(encoding="utf-8")
            with mock.patch.object(sync, "run_sync", return_value=(merged, results, errors)), mock.patch("builtins.print"):
                self.assertEqual(sync.main(["--calendar", str(path), "--today", TODAY.isoformat()]), 0)
            self.assertEqual(path.read_text(encoding="utf-8"), before)   # only October and the stamp differ
            changed = copy.deepcopy(merged)
            target = next(e for e in changed["events"] if e["type"] == "cpi" and e["date"] == "2027-03-10")
            target.update(date="2027-03-11", at="2027-03-11T08:30:00-05:00")
            changed["events"].sort(key=sync.sort_key)
            with mock.patch.object(sync, "run_sync", return_value=(changed, results, [])), mock.patch("builtins.print"):
                self.assertEqual(sync.main(["--calendar", str(path), "--today", TODAY.isoformat()]), 0)
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(ff.validate_macro_calendar(written), [])
            self.assertIn("2027-03-11", [e["date"] for e in written["events"] if e["type"] == "cpi"])

    def test_the_report_lists_every_change(self):
        changed = copy.deepcopy(COMMITTED)
        changed["events"] = [e for e in changed["events"] if e["date"] != "2027-05-20"]           # removed
        cpi = next(e for e in changed["events"] if e["date"] == "2027-03-10" and e["type"] == "cpi")
        cpi["period"] = "2027-01"                                                                # changed
        text = sync.report(COMMITTED, changed, {}, [])
        self.assertIn("1 removed, 1 changed", text)
        self.assertIn("- 2027-05-20 market-holiday SG: Vesak Day", text)
        self.assertIn("2027-03-10 cpi: 2027-02 → 2027-03-10 cpi: 2027-01", text)


class FileFormat(unittest.TestCase):
    def test_the_writer_reproduces_the_committed_file_byte_for_byte(self):
        text = ff.DEFAULT_CALENDAR.read_text(encoding="utf-8")
        self.assertEqual(sync.format_calendar(json.loads(text)), text)

    def test_the_committed_file_is_in_the_syncs_own_order(self):
        keys = [sync.sort_key(event) for event in COMMITTED["events"]]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual([list(event) for event in COMMITTED["events"]], [list(sync.ordered(event)) for event in COMMITTED["events"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
