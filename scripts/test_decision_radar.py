#!/usr/bin/env python3
"""Unit tests for the pipeline side of V5.0's Decision Radar (Gate 1, standard library only).

    python -m unittest discover -s scripts -p "test_*.py"

The macro stress pillars (FRED parsing, the three rules at their boundaries, the count, the
fallbacks, and the FRED key kept out of every message), the ES3.SI total-return benchmark, and
the agent context's new contract. No test touches the network: FRED and Yahoo are faked. The
radar's own arithmetic (scores, tiers, stops) lives in the site's engines and is tested in Gate 2.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_fundamentals as ff  # noqa: E402 - path set up above

NOW = datetime(2026, 11, 23, 3, 0, tzinfo=timezone.utc)
SNAPSHOT_PATH = ff.DEFAULT_OUTPUT
KEY = "test-fred-key-0123456789abcdef"
SETTINGS = argparse.Namespace(macro_timeout=5.0, request_timeout=5.0, max_retries=1, retry_delay=0.0)
REGIME_CALM = {"status": "fresh", "asOf": "2026-11-20", "ratio": 0.85, "note": None}
REGIME_INVERTED = {"status": "fresh", "asOf": "2026-11-20", "ratio": 1.15999, "note": None}


def business_days(count: int, end: str = "2026-11-20") -> list[str]:
    days: list[str] = []
    day = date.fromisoformat(end)
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day.isoformat())
        day -= timedelta(days=1)
    return days[::-1]


def fred_payload(percent_values: list[float | None], end: str = "2026-11-20") -> bytes:
    """A FRED observations response: percent strings, "." for a missing day."""
    dates = business_days(len(percent_values), end)
    rows = [{"date": day, "value": "." if value is None else f"{value:.2f}"} for day, value in zip(dates, percent_values)]
    return json.dumps({"count": len(rows), "observations": rows}).encode("utf-8")


def observations(percent_values: list[float | None], end: str = "2026-11-20") -> list[tuple[str, float]]:
    return ff.parse_fred_observations(fred_payload(percent_values, end), "TEST")


def flat_then(start: float, end_value: float, count: int = 30) -> list[float]:
    """`count` observations at `start`, the last one at `end_value`: a change of end - start over the window."""
    return [start] * (count - 1) + [end_value]


def regime_snapshot(regime: dict) -> dict:
    return {"macro": {"regime": regime}}


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def read(self, size: int = -1) -> bytes:
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    def __init__(self, body: bytes | None = None, error: BaseException | None = None):
        self.body, self.error, self.urls = body, error, []

    def open(self, request, timeout=None):
        self.urls.append(request.full_url)
        if self.error is not None:
            raise self.error
        return FakeResponse(self.body)


class FredParsing(unittest.TestCase):
    def test_percent_values_become_fractions_and_missing_days_are_skipped(self):
        parsed = observations([3.10, None, 3.25, -0.40])
        self.assertEqual([value for _, value in parsed], [0.031, 0.0325, -0.004])
        self.assertEqual(len(parsed), 3)
        self.assertTrue(all(ff.is_iso_date(day) for day, _ in parsed))

    def test_unusable_responses_are_errors(self):
        for body in (b"not json", b"{}", json.dumps({"observations": [{"date": "2026-11-20", "value": "."}]}).encode(),
                     json.dumps({"observations": [{"date": "2026-11-20", "value": "999"}]}).encode()):
            with self.assertRaises(ff.FetchError):
                ff.parse_fred_observations(body, "TEST")
        descending = json.dumps({"observations": [{"date": "2026-11-20", "value": "1"}, {"date": "2026-11-19", "value": "1"}]}).encode()
        with self.assertRaises(ff.FetchError):
            ff.parse_fred_observations(descending, "TEST")

    def test_the_request_names_the_series_and_carries_the_key_in_the_query(self):
        opener = FakeOpener(fred_payload([3.0, 3.1]))
        parsed = ff.fred_observations("BAMLH0A0HYM2", KEY, "2026-07-26", 5, opener)
        self.assertEqual(len(parsed), 2)
        url = opener.urls[0]
        self.assertTrue(url.startswith(ff.FRED_OBSERVATIONS_URL + "?"))
        for part in ("series_id=BAMLH0A0HYM2", f"api_key={KEY}", "file_type=json", "observation_start=2026-07-26"):
            self.assertIn(part, url)

    def test_a_failed_request_never_shows_the_key_or_the_url(self):
        failures = [urllib.error.HTTPError(f"{ff.FRED_OBSERVATIONS_URL}?api_key={KEY}", 400, f"Bad Request api_key={KEY}", None, None),
                    urllib.error.URLError(f"no route to {ff.FRED_OBSERVATIONS_URL}?api_key={KEY}"), TimeoutError(KEY)]
        for error in failures:
            with self.assertRaises(ff.FetchError) as caught:
                ff.fred_observations("T10Y2Y", KEY, "2026-07-26", 5, FakeOpener(error=error))
            text = str(caught.exception)
            self.assertNotIn(KEY, text)
            self.assertNotIn("stlouisfed", text)
            self.assertIn("T10Y2Y", text)
        with self.assertRaises(ff.FetchError) as caught:
            ff.fred_observations("T10Y2Y", KEY, "2026-07-26", 5, FakeOpener(error=urllib.error.HTTPError("u", 429, "Too Many", None, None)))
        self.assertTrue(caught.exception.rate_limited)


class StressPillars(unittest.TestCase):
    def test_the_window_change_needs_twenty_earlier_observations(self):
        self.assertIsNone(ff.window_change(observations([1.0] * 20), 20))
        change, start = ff.window_change(observations(flat_then(3.0, 3.5, 21)), 20)
        self.assertEqual(change, 0.005)
        self.assertEqual(start, business_days(21)[0])

    def test_volatility_flags_an_inverted_vix_curve(self):
        self.assertTrue(ff.volatility_pillar({**REGIME_CALM, "ratio": 1.0})["flag"])       # exactly 1.00 is inverted
        self.assertFalse(ff.volatility_pillar({**REGIME_CALM, "ratio": 0.9999})["flag"])
        stale = ff.volatility_pillar({**REGIME_INVERTED, "status": "stale", "note": "previous reading"})
        self.assertEqual((stale["status"], stale["flag"], stale["note"]), ("stale", True, "previous reading"))
        for regime in (None, {"status": "unavailable", "ratio": None}, {"status": "fresh", "ratio": "high"}):
            pillar = ff.volatility_pillar(regime)
            self.assertEqual((pillar["status"], pillar["flag"], pillar["value"]), ("unavailable", None, None))

    def test_credit_flags_a_wide_or_widening_high_yield_spread(self):
        self.assertTrue(ff.credit_pillar(observations([4.50] * 30))["flag"])           # at the level
        self.assertFalse(ff.credit_pillar(observations([4.49] * 30))["flag"])
        widened = ff.credit_pillar(observations(flat_then(3.50, 4.00)))              # +0.50 points in 20 sessions
        self.assertEqual((widened["flag"], widened["change"], widened["value"]), (True, 0.005, 0.04))
        self.assertFalse(ff.credit_pillar(observations(flat_then(3.50, 3.99)))["flag"])
        short = ff.credit_pillar(observations([3.5] * 10))
        self.assertFalse(short["flag"])
        self.assertIsNone(short["change"])
        self.assertIn("not judged", short["note"])

    def test_rates_flag_an_inverted_curve_or_a_bull_steepening(self):
        two_down, two_up = observations(flat_then(4.00, 3.60)), observations(flat_then(4.00, 4.20))
        self.assertTrue(ff.rates_pillar(observations([-0.01] * 30), two_up)["flag"])     # inverted
        self.assertFalse(ff.rates_pillar(observations([0.00] * 30), two_up)["flag"])     # flat is not inverted
        bull = ff.rates_pillar(observations(flat_then(0.20, 0.55)), two_down)            # +0.35 with the 2Y lower
        self.assertEqual((bull["flag"], bull["change"], bull["twoYearChange"]), (True, 0.0035, -0.004))
        self.assertFalse(ff.rates_pillar(observations(flat_then(0.20, 0.54)), two_down)["flag"])
        self.assertFalse(ff.rates_pillar(observations(flat_then(0.20, 0.60)), two_up)["flag"])   # bear steepening
        blind = ff.rates_pillar(observations(flat_then(0.20, 0.60)), None)
        self.assertFalse(blind["flag"])
        self.assertIn("DGS2", blind["note"])
        self.assertTrue(ff.rates_pillar(observations([-0.30] * 30), None)["flag"])       # inversion needs no 2Y


class StressComposite(unittest.TestCase):
    @staticmethod
    def pillars(volatility, credit, rates):
        def pillar(flag, status="fresh"):
            if flag is None:
                return ff.stress_pillar("unavailable", None, None, "fred", "X", note="not read")
            return ff.stress_pillar(status, flag, "2026-11-20", "fred", "X", 0.01)
        return {"volatility": pillar(volatility), "credit": pillar(credit), "rates": pillar(rates)}

    def test_flags_count_into_a_state_and_a_multiplier(self):
        for flags, (state, multiplier) in enumerate([("Calm", 1.0), ("Cautious", 1.15), ("Stressed", 1.35), ("Stressed", 1.35)]):
            block = ff.stress_block(self.pillars(flags >= 1, flags >= 2, flags >= 3))
            self.assertEqual((block["state"], block["multiplier"], block["flags"], block["active"], block["status"]),
                             (state, multiplier, flags, 3, "fresh"), flags)
            self.assertEqual(ff.validate_stress(block), [])

    def test_the_status_says_which_pillars_were_read(self):
        vix_only = ff.stress_block(self.pillars(True, None, None))
        self.assertEqual((vix_only["status"], vix_only["state"], vix_only["multiplier"]), ("vix-only", "Cautious", 1.15))
        partial = ff.stress_block(self.pillars(True, True, None))
        self.assertEqual((partial["status"], partial["state"], partial["active"]), ("partial", "Stressed", 2))
        stale = self.pillars(False, False, False)
        stale["credit"]["status"] = "stale"
        self.assertEqual(ff.stress_block(stale)["status"], "partial")
        nothing = ff.stress_block(self.pillars(None, None, None))
        self.assertEqual((nothing["status"], nothing["state"], nothing["multiplier"], nothing["asOf"]), ("unavailable", None, 1.0, None))
        self.assertEqual(ff.validate_stress(nothing), [])

    def test_validation_recounts_the_pillars(self):
        block = ff.stress_block(self.pillars(True, True, False))
        self.assertEqual(ff.validate_stress(block), [])
        for change in (lambda b: b.update(state="Calm"), lambda b: b.update(multiplier=1.0), lambda b: b.update(flags=0),
                       lambda b: b["rules"].update(creditLevel=0.06), lambda b: b["pillars"]["credit"].update(flag="yes"),
                       lambda b: b["pillars"].pop("rates"), lambda b: b.update(status="fresh-ish"), lambda b: b.pop("note")):
            broken = json.loads(json.dumps(block))
            change(broken)
            self.assertTrue(ff.validate_stress(broken), change)


class BuildStress(unittest.TestCase):
    @staticmethod
    def fred(credit=None, spread=None, two_year=None, failing=()):
        data = {"BAMLH0A0HYM2": credit or [3.20] * 30, "T10Y2Y": spread or [0.50] * 30, "DGS2": two_year or [3.90] * 30}
        calls = []

        def fetch(series_id):
            calls.append(series_id)
            if series_id in failing:
                raise ff.FetchError(f"FRED {series_id}: HTTP 500 with key {KEY}")
            return observations(data[series_id])
        fetch.calls = calls
        return fetch

    def build(self, regime=REGIME_INVERTED, env=None, previous=None, fetcher=None):
        return ff.build_stress(regime_snapshot(regime), previous, {"FRED_API_KEY": KEY} if env is None else env, SETTINGS, NOW, fetcher)

    def test_without_a_key_nothing_is_requested_and_the_vix_pillar_decides(self):
        fetcher = self.fred()
        block = self.build(env={}, fetcher=fetcher)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual((block["status"], block["state"], block["multiplier"], block["active"]), ("vix-only", "Cautious", 1.15, 1))
        self.assertIn("FRED_API_KEY", block["note"])
        self.assertEqual(self.build(regime=REGIME_CALM, env={"FRED_API_KEY": "  "}, fetcher=fetcher)["state"], "Calm")
        self.assertEqual(ff.validate_stress(block), [])

    def test_all_three_pillars_from_fred(self):
        fetcher = self.fred(credit=[4.80] * 30, spread=[-0.10] * 30)
        block = self.build(fetcher=fetcher)
        self.assertEqual(fetcher.calls, ["BAMLH0A0HYM2", "T10Y2Y", "DGS2"])
        self.assertEqual((block["status"], block["state"], block["flags"], block["multiplier"]), ("fresh", "Stressed", 3, 1.35))
        self.assertEqual(block["pillars"]["credit"]["value"], 0.048)
        self.assertIsNone(block["note"])
        self.assertEqual(ff.validate_stress(block), [])
        calm = self.build(regime=REGIME_CALM, fetcher=self.fred())
        self.assertEqual((calm["state"], calm["multiplier"]), ("Calm", 1.0))

    def test_a_failed_pillar_is_carried_over_for_five_days_then_left_out(self):
        fresh = self.build(fetcher=self.fred(credit=[4.80] * 30))
        previous = {"macro": {"stress": fresh}}
        with self.assertLogs(ff.LOG, level="WARNING") as logs:
            carried = self.build(previous=previous, fetcher=self.fred(failing=("BAMLH0A0HYM2",)))
        self.assertEqual(carried["pillars"]["credit"]["status"], "stale")
        self.assertTrue(carried["pillars"]["credit"]["flag"])
        self.assertEqual((carried["status"], carried["state"]), ("partial", "Stressed"))
        self.assertIn("credit", carried["note"])
        self.assertTrue(all(KEY not in line for line in logs.output), "the key never reaches a log")
        old = json.loads(json.dumps(fresh))
        old["pillars"]["credit"]["asOf"] = "2026-11-10"
        with self.assertLogs(ff.LOG, level="WARNING"):
            dropped = self.build(previous={"macro": {"stress": old}}, fetcher=self.fred(failing=("BAMLH0A0HYM2",)))
        self.assertEqual(dropped["pillars"]["credit"]["status"], "unavailable")
        self.assertEqual(ff.validate_stress(carried), [])
        self.assertEqual(ff.validate_stress(dropped), [])

    def test_without_the_two_year_yield_only_inversion_is_judged(self):
        with self.assertLogs(ff.LOG, level="WARNING") as logs:
            block = self.build(fetcher=self.fred(spread=flat_then(0.20, 0.80), failing=("DGS2",)))
        rates = block["pillars"]["rates"]
        self.assertEqual((rates["status"], rates["flag"]), ("fresh", False))
        self.assertIn("DGS2", rates["note"])
        self.assertTrue(all(KEY not in line for line in logs.output))

    def test_an_unexpected_error_never_escapes(self):
        def broken(series_id):
            raise RuntimeError(f"surprise {KEY}")
        with self.assertLogs(ff.LOG, level="WARNING") as logs:
            block = self.build(fetcher=broken)
        self.assertEqual(block["status"], "vix-only")
        self.assertTrue(all(KEY not in line for line in logs.output))


class RunStressStep(unittest.TestCase):
    """--stress on a copy of the committed snapshot: adds the block, keeps everything else, exits 0."""

    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.path = Path(self.folder) / "snapshot.json"
        shutil.copyfile(SNAPSHOT_PATH, self.path)
        self.settings = argparse.Namespace(output=self.path, previous=None, **vars(SETTINGS))

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def test_the_block_is_added_and_the_rest_is_untouched(self):
        before = ff.load_json(self.path)
        before["macro"].pop("stress", None)
        fake = BuildStress.fred(credit=[4.80] * 30)
        with mock.patch.dict(os.environ, {"FRED_API_KEY": KEY}), \
                mock.patch.object(ff, "fred_observations", lambda series_id, *args, **kwargs: fake(series_id)):
            self.assertEqual(ff.run_stress(self.settings), 0)
        after = ff.load_json(self.path)
        stress = after["macro"].pop("stress")
        self.assertEqual(stress["pillars"]["credit"]["status"], "fresh")
        self.assertIn(stress["state"], {"Cautious", "Stressed"})
        self.assertEqual(after, before)
        self.assertNotIn(KEY, self.path.read_text(encoding="utf-8"))

    def test_without_a_key_the_vix_pillar_is_written(self):
        with mock.patch.dict(os.environ, {"FRED_API_KEY": ""}):
            self.assertEqual(ff.run_stress(self.settings), 0)
        stress = ff.load_json(self.path)["macro"]["stress"]
        self.assertEqual(stress["status"], "vix-only")
        self.assertEqual(ff.validate_snapshot(ff.load_json(self.path)), [])

    def test_an_unreadable_snapshot_is_a_warning_and_exit_0(self):
        self.path.write_text("{ broken", encoding="utf-8")
        with mock.patch.dict(os.environ, {"FRED_API_KEY": KEY}), self.assertLogs(ff.LOG, level="WARNING") as logs:
            self.assertEqual(ff.run_stress(self.settings), 0)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{ broken")
        self.assertTrue(all(KEY not in line for line in logs.output))

    def test_a_snapshot_with_a_broken_stress_block_fails_validation(self):
        snapshot = ff.load_json(self.path)
        snapshot["macro"]["stress"] = {"state": "Calm"}
        self.assertTrue(any("macro.stress" in error for error in ff.validate_snapshot(snapshot)))


def benchmark_block(rows: int = 250, end: str = "2026-11-21", status: str = "fresh") -> dict:
    days = business_days(rows, end)
    return {"name": "SPDR Straits Times Index ETF", "market": "SG", "currency": "SGD", "status": status, "asOf": days[-1],
            "source": "yahoo", "note": None, "series": [[day, round(4.0 + index * 0.004, 4)] for index, day in enumerate(days)]}


class Benchmarks(unittest.TestCase):
    def test_a_fresh_benchmark_is_kept_and_validated(self):
        blocks = ff.build_benchmarks(None, SETTINGS, NOW, fetcher=lambda *args: benchmark_block())
        self.assertEqual(list(blocks), ["ES3.SI"])
        self.assertEqual(blocks["ES3.SI"]["status"], "fresh")
        self.assertEqual(ff.validate_benchmarks(blocks), [])

    def test_a_failed_download_falls_back_to_yesterday_then_to_nothing(self):
        def failing(*args):
            raise ff.FetchError("Yahoo is down")
        previous = {"benchmarks": {"ES3.SI": benchmark_block(end="2026-11-20")}}
        with self.assertLogs(ff.LOG, level="WARNING"):
            stale = ff.build_benchmarks(previous, SETTINGS, NOW, fetcher=failing)["ES3.SI"]
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["series"], previous["benchmarks"]["ES3.SI"]["series"])
        old = {"benchmarks": {"ES3.SI": benchmark_block(end="2026-11-10")}}
        with self.assertLogs(ff.LOG, level="WARNING"):
            gone = ff.build_benchmarks(old, SETTINGS, NOW, fetcher=failing)["ES3.SI"]
        self.assertEqual((gone["status"], gone["series"], gone["asOf"]), ("unavailable", [], None))
        self.assertEqual(ff.validate_benchmarks({"ES3.SI": stale, "X": gone}), [])
        with self.assertLogs(ff.LOG, level="WARNING"):
            short = ff.build_benchmarks(None, SETTINGS, NOW, fetcher=lambda *args: benchmark_block(rows=50))["ES3.SI"]
        self.assertEqual(short["status"], "unavailable")

    def test_validation_rejects_bad_closes(self):
        for change in (lambda b: b["series"].reverse(), lambda b: b["series"][3].__setitem__(1, -1), lambda b: b.update(asOf="2026-01-01"),
                       lambda b: b.update(status="maybe"), lambda b: b.pop("note"), lambda b: b.update(status="unavailable")):
            block = benchmark_block()
            change(block)
            self.assertTrue(ff.validate_benchmark("ES3.SI", block), change)

    def test_the_download_keeps_completed_adjusted_closes(self):
        index = pd.DatetimeIndex(business_days(150, "2026-11-23"), tz="Asia/Singapore")
        closes = [5.0 + i * 0.001 for i in range(150)]
        frame = pd.DataFrame({"Open": closes, "High": closes, "Low": closes, "Close": closes, "Volume": [1000] * 150, "Dividends": [0.0] * 150}, index=index)
        during = datetime(2026, 11, 23, 3, 0, tzinfo=timezone.utc)          # 11:00 in Singapore: the session is open
        with mock.patch.object(ff, "fetch_history", return_value=frame):
            block = ff.fetch_benchmark("ES3.SI", ff.BENCHMARK_SYMBOLS["ES3.SI"], SETTINGS, during)
        self.assertEqual(block["asOf"], "2026-11-20")
        self.assertEqual(len(block["series"]), 149)
        self.assertEqual(block["series"][0], [index[0].strftime("%Y-%m-%d"), 5.0])
        self.assertEqual(ff.validate_benchmark("ES3.SI", block), [])
        with mock.patch.object(ff, "fetch_history", return_value=frame.iloc[:60]), self.assertRaises(ff.FetchError):
            ff.fetch_benchmark("ES3.SI", ff.BENCHMARK_SYMBOLS["ES3.SI"], SETTINGS, during)

    def test_the_snapshot_writes_one_row_per_line_and_round_trips(self):
        snapshot = ff.load_json(SNAPSHOT_PATH)
        snapshot["benchmarks"] = {"ES3.SI": benchmark_block()}
        self.assertEqual(ff.validate_snapshot(snapshot), [])
        text = ff.render_snapshot(snapshot)
        self.assertIn('\n        ["2025-', text)
        self.assertEqual(json.loads(text), json.loads(json.dumps(snapshot)))
        snapshot["benchmarks"]["ES3.SI"]["series"][5][1] = 0
        self.assertTrue(any("benchmarks.ES3.SI" in error for error in ff.validate_snapshot(snapshot)))


RADAR = {
    "tier": "Neutral", "score": 2, "scores": [2, 2, 2], "held": False,
    "points": {"trend": False, "strength": True, "momentum": True, "drawdown": False}, "vs": "ES3.SI", "vsTotalReturn": True,
    "dividendYield": 0.049, "dividendTrap": True, "drawdown": -0.1497, "sigmaDaily": 0.01158, "tick": 0.01,
    "stops": {
        "short": {"init": -0.05955, "breakeven": 0.07444, "trail": -0.05955, "initPrice": 62.17, "breakevenPrice": 71.04, "trailPrice": 62.17},
        "medium": {"init": -0.122, "breakeven": 0.1526, "trail": -0.1403, "initPrice": 58.04, "breakevenPrice": 76.2, "trailPrice": 56.83},
        "long": {"init": -0.1526, "breakeven": 0.2288, "trail": -0.1907, "initPrice": 56.02, "breakevenPrice": 81.24, "trailPrice": 53.5},
    },
    "warnings": [],
}


class RadarContract(unittest.TestCase):
    def test_a_radar_or_a_reason(self):
        self.assertEqual(ff.validate_radar_cell(RADAR, "D05.SI"), [])
        self.assertEqual(ff.validate_radar_cell({"na": "Indices are not in the radar: they cannot be bought."}, "^STI"), [])
        self.assertEqual(ff.validate_radar_cell({**RADAR, "stops": {**RADAR["stops"], "long": {"na": "Too short."}}}, "X"), [])
        broken = [
            {"na": " "}, None, {"tier": "Strong Buy"}, {**RADAR, "score": 5}, {**RADAR, "score": 2.5}, {**RADAR, "dividendTrap": "no"},
            {**RADAR, "stops": {"short": RADAR["stops"]["short"], "medium": RADAR["stops"]["medium"]}},
            {**RADAR, "stops": {**RADAR["stops"], "short": {**RADAR["stops"]["short"], "init": 0.05}}},                  # a stop above the close
            {**RADAR, "stops": {**RADAR["stops"], "long": {**RADAR["stops"]["long"], "init": -0.30}}},                   # beyond the cap
            {**RADAR, "stops": {**RADAR["stops"], "medium": {**RADAR["stops"]["medium"], "initPrice": 90.0}}},          # trigger below the stop
            {**RADAR, "stops": {**RADAR["stops"], "medium": {"init": -0.1}}}, {**RADAR, "warnings": None},
        ]
        for radar in broken:
            self.assertTrue(ff.validate_radar_cell(radar, "X"), radar)

    def test_a_file_from_before_v5_is_still_valid_but_a_new_one_needs_both_parts(self):
        context = {"schema": ff.BOT_CONTEXT_SCHEMA, "asOf": "2026-11-21T22:00:00Z", "builtAt": "x", "source": "x", "notes": [], "units": {},
                   "regime": {"state": "normal"}, "events": [], "triggers": [], "rotation": {"groups": []},
                   "assets": [{"ticker": "AAA", **{key: {"v": 1} for key in ff.BOT_CONTEXT_CELLS}}]}
        self.assertEqual(ff.validate_bot_context(context), [])
        current = dict(context)
        current = {**{key: context[key] for key in list(context)[:7]}, "stress": None, **{key: context[key] for key in list(context)[7:]}}
        self.assertTrue(ff.validate_bot_context(current))                       # V5.0: stress and radar are required together
        current["stress"] = {"state": "Calm", "multiplier": 1.0, "pillars": {"volatility": {}, "credit": {}, "rates": {}}}
        self.assertTrue(ff.validate_bot_context(current))                       # the asset still lacks its radar
        current["assets"][0] = {**current["assets"][0], "radar": RADAR}
        self.assertEqual(ff.validate_bot_context(current), [])

    def test_tick_rounded_prices_keep_every_digit(self):
        rounded = ff._rounded({"stops": {"medium": {"init": -0.123456789, "initPrice": 51716.14, "breakevenPrice": 100234.57}}, "tick": 0.005})
        self.assertEqual(rounded, {"stops": {"medium": {"init": -0.123457, "initPrice": 51716.14, "breakevenPrice": 100234.57}}, "tick": 0.005})

    @unittest.skipIf(shutil.which("node") is None, "Node.js is not installed")
    def test_the_real_snapshot_carries_a_radar_for_every_tradable_asset(self):
        snapshot = ff.load_json(SNAPSHOT_PATH)
        context = ff.build_bot_context(SNAPSHOT_PATH, None, NOW, signals=ff.compute_signals(SNAPSHOT_PATH))
        self.assertEqual(ff.validate_bot_context(context, snapshot), [])
        self.assertLess(len(json.dumps(context, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), ff.BOT_CONTEXT_MAX_BYTES)
        for asset in context["assets"]:
            if asset["class"] == "index":
                self.assertEqual(asset["radar"], {"na": "Indices are not in the radar: they cannot be bought."})
            else:
                self.assertIn(asset["radar"]["tier"], ff.BOT_CONTEXT_TIERS, asset["ticker"])
                for stop in asset["radar"]["stops"].values():
                    self.assertGreaterEqual(stop["init"], -0.25)

    @unittest.skipIf(shutil.which("node") is None, "Node.js is not installed")
    def test_the_engine_counts_the_same_state_as_the_pipeline(self):
        """The site recounts macro.stress from its pillars; it must agree with the pipeline, with or without FRED."""
        snapshot = ff.load_json(SNAPSHOT_PATH)
        cases = [{}, {"FRED_API_KEY": KEY}]
        fetchers = [None, BuildStress.fred(credit=[4.80] * 30, spread=flat_then(0.20, 0.60), two_year=flat_then(4.0, 3.5))]
        for env, fetcher in zip(cases, fetchers):
            block = ff.build_stress(snapshot, None, env, SETTINGS, NOW, fetcher)
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "snapshot.json"
                copy = json.loads(json.dumps(snapshot))
                copy["macro"]["stress"] = block
                path.write_text(json.dumps(copy), encoding="utf-8")
                engine = ff.run_node_json(ff.BOT_CONTEXT_SCRIPT, path, "agent context", "no agent context is built")
            self.assertEqual((engine["stress"]["state"], engine["stress"]["multiplier"], engine["stress"]["flags"], engine["stress"]["status"]),
                             (block["state"], block["multiplier"], block["flags"], block["status"]), env)


if __name__ == "__main__":
    unittest.main(verbosity=2)
