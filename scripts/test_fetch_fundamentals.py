#!/usr/bin/env python3
"""Unit tests for the data pipeline's own logic (no network).

    python -m unittest discover -s scripts -p "test_*.py" -v

The browser suite (tests/engines.test.html) verifies the maths that runs in the
page. This file verifies what happens before the data gets there: number
sanitisation, trailing-twelve-month guards, headline de-duplication, sentiment
labelling, the MAS table parser, the risk-free fallback chain, deadlines and
schema validation.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import importlib.util
import json
import math
import random
import shutil
import sys
import time
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_fundamentals as ff  # noqa: E402 - path set up above

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)
SNAPSHOT_PATH = ff.DEFAULT_OUTPUT


def headline(title: str, hours_ago: float, link: str | None = "https://example.com/story") -> dict:
    return {"title": title, "link": link, "published": NOW - timedelta(hours=hours_ago)}


class FakeAnalyzer:
    """Deterministic stand-in for VADER: the score is looked up by a keyword."""

    SCORES = {"surge": 0.6, "plunge": -0.7, "flat": 0.0, "edge": 0.05}

    def polarity_scores(self, text: str) -> dict:
        compound = next((score for word, score in self.SCORES.items() if word in text.lower()), 0.0)
        return {"compound": compound, "pos": max(compound, 0), "neu": 1 - abs(compound), "neg": max(-compound, 0)}


def settings(**overrides) -> argparse.Namespace:
    base = ff.parse_args([])
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


class NumberSanitisation(unittest.TestCase):
    def test_non_finite_and_non_numeric_values_become_none(self):
        for bad in (None, float("nan"), float("inf"), float("-inf"), "abc", True, [], {}):
            self.assertIsNone(ff.clean_number(bad), bad)

    def test_finite_values_survive_and_negative_zero_is_normalised(self):
        self.assertEqual(ff.clean_number("12.5"), 12.5)
        self.assertEqual(ff.clean_number(1.23456, digits=2), 1.23)
        self.assertEqual(str(ff.clean_number(-0.0)), "0")
        self.assertIsInstance(ff.clean_number(5_000_000.0), int)

    def test_json_encoding_refuses_nan(self):
        with self.assertRaises(ValueError):
            json.dumps({"x": float("nan")}, allow_nan=False)


class TrailingTwelveMonths(unittest.TestCase):
    @staticmethod
    def frame(dates: list[str], values: list[float | None]) -> pd.DataFrame:
        return pd.DataFrame({pd.Timestamp(d): [v] for d, v in zip(dates, values)}, index=["Total Revenue"])

    def test_four_contiguous_quarters_are_summed(self):
        frame = self.frame(["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"], [4, 3, 2, 1, 9])
        window = ff.trailing_columns(frame)
        self.assertEqual(len(window), 4)
        self.assertEqual(ff.sum_over(frame, ["Total Revenue"], window), 10)

    def test_a_missing_quarter_is_never_summed_across(self):
        # 2026-06-30 is absent, so the "four most recent" would span fifteen months.
        frame = self.frame(["2026-09-30", "2026-03-31", "2025-12-31", "2025-09-30"], [4, 2, 1, 9])
        self.assertIsNone(ff.trailing_columns(frame))

    def test_semi_annual_reporters_use_two_halves(self):
        frame = self.frame(["2026-06-30", "2025-12-31", "2025-06-30"], [6, 5, 4])
        self.assertEqual(len(ff.trailing_columns(frame)), 2)

    def test_an_implausible_trailing_figure_is_rejected_in_favour_of_the_fiscal_year(self):
        # Only two columns survive, six months apart: indistinguishable from a semi-annual
        # reporter by dates alone. The sum (20) is far below the fiscal year (100), so the
        # second guard rejects it.
        quarterly = self.frame(["2026-09-30", "2026-03-31"], [12, 8])
        annual = self.frame(["2025-12-31"], [100])
        values, period = ff.income_items(quarterly, annual)
        self.assertEqual((period, values["totalRevenue"]), ("FY2025", 100))

    def test_a_plausible_trailing_figure_is_preferred_over_the_fiscal_year(self):
        quarterly = self.frame(["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31"], [30, 28, 26, 24])
        annual = self.frame(["2025-12-31"], [100])
        values, period = ff.income_items(quarterly, annual)
        self.assertEqual((period, values["totalRevenue"]), ("TTM", 108))

    def test_a_quarter_with_a_missing_value_falls_back_to_the_fiscal_year(self):
        quarterly = self.frame(["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31"], [4, None, 2, 1])
        annual = self.frame(["2025-12-31", "2024-12-31"], [100, 90])
        values, period = ff.income_items(quarterly, annual)
        self.assertEqual(period, "FY2025")
        self.assertEqual(values["totalRevenue"], 100)


class HeadlineDeduplication(unittest.TestCase):
    def test_threshold_and_window_are_the_agreed_values(self):
        self.assertEqual(ff.NEWS_SIMILARITY, 0.85)
        self.assertEqual(ff.NEWS_WINDOW, timedelta(hours=24))
        self.assertEqual(ff.NEWS_MAX_HEADLINES, 15)
        self.assertEqual(ff.NEWS_SCORED_CLUSTERS, 3)

    def test_titles_are_normalised_before_comparison(self):
        self.assertEqual(ff.normalise_title("  Apple's Q4: Profit UP 12%!  "), "apple s q4 profit up 12")

    def test_syndicated_copies_within_24_hours_collapse_into_one_story(self):
        clusters = ff.cluster_headlines([
            headline("Apple shares surge after record iPhone sales", 10),
            headline("Apple shares surge after record iPhone sales - Reuters", 8),
            headline("Apple Shares Surge After Record iPhone Sales!", 3),
        ])
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]["members"]), 3)
        self.assertEqual(clusters[0]["first"]["title"], "Apple shares surge after record iPhone sales")

    def test_similarity_just_below_85_percent_stays_separate(self):
        first = "Bank raises dividend after strong quarterly profit"
        second = "Bank raises dividend after weak quarterly outlook"
        ratio = difflib.SequenceMatcher(None, ff.normalise_title(first), ff.normalise_title(second), autojunk=False).ratio()
        self.assertLess(ratio, 0.85)
        self.assertGreater(ratio, 0.70)  # close, but a different story
        self.assertEqual(len(ff.cluster_headlines([headline(first, 5), headline(second, 4)])), 2)

    def test_the_same_headline_more_than_24_hours_later_is_a_new_story(self):
        title = "Regulator opens probe into exchange"
        clusters = ff.cluster_headlines([headline(title, 30), headline(title, 2)])
        self.assertEqual(len(clusters), 2)

    def test_exactly_24_hours_apart_is_outside_the_window(self):
        title = "Regulator opens probe into exchange"
        self.assertEqual(len(ff.cluster_headlines([headline(title, 24), headline(title, 0)])), 2)
        self.assertEqual(len(ff.cluster_headlines([headline(title, 23.99), headline(title, 0)])), 1)

    def test_the_window_rolls_with_the_latest_copy(self):
        # 40h -> 20h -> 1h: each copy is within 24h of the one before, so it is one escalating story.
        title = "Chipmaker cuts forecast as demand slows"
        clusters = ff.cluster_headlines([headline(title, 40), headline(title, 20), headline(title, 1)])
        self.assertEqual(len(clusters), 1)
        self.assertEqual(clusters[0]["latest"], NOW - timedelta(hours=1))

    def test_unrelated_headlines_never_merge(self):
        clusters = ff.cluster_headlines([
            headline("Oil prices climb on supply fears", 5),
            headline("Central bank holds rates steady", 4),
            headline("Retailer reports record holiday sales", 3),
        ])
        self.assertEqual(len(clusters), 3)


class NewsBlock(unittest.TestCase):
    def test_the_three_most_recent_unique_stories_are_stored_and_scored(self):
        items = [
            headline("Stock set to surge on upgrade", 1),
            headline("Stock set to surge on upgrade - Wire", 2),   # duplicate of the newest story
            headline("Shares plunge after warning", 5),
            headline("Trading flat ahead of results", 9),
            headline("An older story that should not be stored", 20),
        ]
        news = ff.build_news(items, FakeAnalyzer(), NOW)
        self.assertEqual(news["status"], "fresh")
        self.assertEqual(news["headlineCount"], 5)
        self.assertEqual(news["clusterCount"], 4)
        self.assertEqual([c["label"] for c in news["clusters"]], ["positive", "negative", "neutral"])
        self.assertEqual(news["clusters"][0]["duplicates"], 1)
        self.assertEqual(news["clusters"][0]["publishedAt"], "2026-11-16T11:00:00Z")
        self.assertEqual(news["clusters"][0]["firstSeenAt"], "2026-11-16T10:00:00Z")
        self.assertEqual(news["sentiment"], {"compound": round((0.6 - 0.7 + 0.0) / 3, 4), "label": "neutral", "basis": 3})
        self.assertEqual(ff.validate_news(news), [])

    def test_only_the_fifteen_most_recent_headlines_are_considered(self):
        items = [headline(f"Distinct headline number {index} about topic {index * 7}", index) for index in range(25)]
        news = ff.build_news(items, FakeAnalyzer(), NOW)
        self.assertEqual(news["headlineCount"], 15)

    def test_old_news_is_flagged_stale(self):
        news = ff.build_news([headline("Quiet week for the trust", 24 * 8)], FakeAnalyzer(), NOW)
        self.assertEqual(news["status"], "stale")
        self.assertIn("7 days", news["note"])

    def test_no_headlines_gives_an_unavailable_block(self):
        news = ff.build_news([], FakeAnalyzer(), NOW)
        self.assertEqual(news["status"], "unavailable")
        self.assertEqual(news["clusters"], [])
        self.assertEqual(ff.validate_news(news), [])

    def test_without_the_sentiment_package_headlines_are_kept_unscored(self):
        news = ff.build_news([headline("Stock set to surge", 1)], None, NOW)
        self.assertIsNone(news["sentiment"])
        self.assertIsNone(news["clusters"][0]["scores"])
        self.assertIsNone(news["clusters"][0]["label"])
        self.assertEqual(ff.validate_news(news), [])

    def test_sentiment_labels_use_the_conventional_cut_offs(self):
        self.assertEqual(ff.sentiment_label(0.05), "positive")
        self.assertEqual(ff.sentiment_label(0.0499), "neutral")
        self.assertEqual(ff.sentiment_label(-0.0499), "neutral")
        self.assertEqual(ff.sentiment_label(-0.05), "negative")

    @unittest.skipIf(ff.SentimentIntensityAnalyzer is None, "vaderSentiment is not installed")
    def test_the_real_lexicon_separates_clearly_good_from_clearly_bad(self):
        analyzer = ff.SentimentIntensityAnalyzer()
        good = ff.score_title(analyzer, "Company wins award for excellent, outstanding results")
        bad = ff.score_title(analyzer, "Company collapses in terrible fraud scandal")
        self.assertGreater(good["compound"], 0.05)
        self.assertLess(bad["compound"], -0.05)
        self.assertEqual(sorted(good), ["compound", "neg", "neu", "pos"])


class RssParsing(unittest.TestCase):
    FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Feed</title>
      <item><title>Profits &amp;amp; margins   rise</title><link>https://example.com/a</link>
            <pubDate>Mon, 16 Nov 2026 10:00:00 +0000</pubDate></item>
      <item><title>Insecure link story</title><link>http://example.com/b</link>
            <pubDate>Mon, 16 Nov 2026 09:00:00 +0800</pubDate></item>
      <item><title>No date story</title><link>https://example.com/c</link></item>
      <item><title></title><link>https://example.com/d</link><pubDate>Mon, 16 Nov 2026 08:00:00 +0000</pubDate></item>
      <item><title>Profits &amp;amp; margins   rise</title><link>https://example.com/a</link>
            <pubDate>Mon, 16 Nov 2026 10:00:00 +0000</pubDate></item>
    </channel></rss>"""

    def test_items_are_cleaned_and_bad_ones_dropped(self):
        items = ff.parse_rss(self.FEED)
        self.assertEqual(len(items), 2)  # no date, empty title and the exact duplicate are dropped
        self.assertEqual(items[0]["title"], "Profits & margins rise")
        self.assertEqual(items[0]["published"], datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc))
        self.assertIsNone(items[1]["link"])  # http links are not stored
        self.assertEqual(items[1]["published"], datetime(2026, 11, 16, 1, 0, tzinfo=timezone.utc))

    def test_documents_with_a_doctype_or_entities_are_rejected(self):
        hostile = b'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "y">]><rss><channel/></rss>'
        with self.assertRaises(ValueError):
            ff.parse_rss(hostile)

    def test_malformed_xml_raises_instead_of_returning_garbage(self):
        with self.assertRaises(Exception):
            ff.parse_rss(b"<rss><channel><item>")


class MasYieldTable(unittest.TestCase):
    PAGE = """<html><body><table>
      <tr><th>End of Period</th><th>10-Year Bond Yield</th></tr>
      <tr><td>2026</td><td>Oct</td><td>30</td><td>2.49</td></tr>
      <tr><td></td><td></td><td>31</td><td>2.45</td></tr>
      <tr><td></td><td>Nov</td><td>13</td><td>2.33</td></tr>
      <tr><td></td><td></td><td>16</td><td>2.34</td></tr>
      <tr><td></td><td></td><td>17</td><td>-</td></tr>
    </table></body></html>"""

    def test_the_latest_numeric_row_is_returned_with_carried_year_and_month(self):
        value, as_of = ff.parse_mas_table(self.PAGE)
        self.assertAlmostEqual(value, 0.0234)
        self.assertEqual(as_of, "2026-11-16")

    def test_a_page_without_a_table_or_without_yields_raises(self):
        with self.assertRaises(ValueError):
            ff.parse_mas_table("<html><body>Service unavailable</body></html>")
        with self.assertRaises(ValueError):
            ff.parse_mas_table("<table><tr><th>End of Period</th><th>Yield</th></tr></table>")


class RiskFreeFallbackChain(unittest.TestCase):
    US = ff.risk_free_entry("US 10-year Treasury yield", "^TNX", 0.05, "2026-11-16", "yahoo", "fresh")
    SG = ff.risk_free_entry("Singapore 10-year SGS benchmark yield", None, 0.0234, "2026-11-16", "mas", "fresh")

    def setUp(self):
        self._us, self._sg = ff.fetch_us_10y, ff.fetch_sg_10y

    def tearDown(self):
        ff.fetch_us_10y, ff.fetch_sg_10y = self._us, self._sg

    @staticmethod
    def failing(*_args, **_kwargs):
        raise ff.FetchError("source down")

    def previous(self, sg_as_of: str) -> dict:
        return {"macro": {"riskFree": {"USD": dict(self.US, **{"yield": 0.048}), "SGD": dict(self.SG, asOf=sg_as_of)}}}

    def test_both_sources_up(self):
        ff.fetch_us_10y = lambda *_: dict(self.US)
        ff.fetch_sg_10y = lambda *_: dict(self.SG)
        macro = ff.build_macro(None, settings(), NOW)
        self.assertEqual(macro["riskFree"]["SGD"]["status"], "fresh")
        self.assertEqual(ff.validate_macro(macro), [])

    def test_mas_down_with_a_recent_previous_value_keeps_it_as_stale(self):
        ff.fetch_us_10y = lambda *_: dict(self.US)
        ff.fetch_sg_10y = self.failing
        macro = ff.build_macro(self.previous("2026-11-12"), settings(), NOW)
        self.assertEqual(macro["riskFree"]["SGD"]["status"], "stale")
        self.assertEqual(macro["riskFree"]["SGD"]["yield"], 0.0234)

    def test_mas_down_for_too_long_switches_to_the_us_proxy(self):
        ff.fetch_us_10y = lambda *_: dict(self.US)
        ff.fetch_sg_10y = self.failing
        macro = ff.build_macro(self.previous("2026-10-20"), settings(), NOW)
        sgd = macro["riskFree"]["SGD"]
        self.assertEqual((sgd["status"], sgd["yield"], sgd["symbol"]), ("proxy", 0.05, "^TNX"))
        self.assertIn("proxy", sgd["name"])
        self.assertEqual(ff.validate_macro(macro), [])

    def test_mas_down_on_a_first_run_uses_the_proxy(self):
        ff.fetch_us_10y = lambda *_: dict(self.US)
        ff.fetch_sg_10y = self.failing
        self.assertEqual(ff.build_macro(None, settings(), NOW)["riskFree"]["SGD"]["status"], "proxy")

    def test_everything_down_with_no_history_is_unavailable_but_still_valid(self):
        ff.fetch_us_10y = self.failing
        ff.fetch_sg_10y = self.failing
        macro = ff.build_macro(None, settings(), NOW)
        self.assertEqual(macro["riskFree"]["USD"]["status"], "unavailable")
        self.assertEqual(macro["riskFree"]["SGD"]["status"], "unavailable")
        self.assertIsNone(macro["riskFree"]["SGD"]["yield"])
        self.assertEqual(ff.validate_macro(macro), [])

    def test_us_down_keeps_its_previous_value_as_stale(self):
        ff.fetch_us_10y = self.failing
        ff.fetch_sg_10y = lambda *_: dict(self.SG)
        macro = ff.build_macro(self.previous("2026-11-12"), settings(), NOW)
        self.assertEqual((macro["riskFree"]["USD"]["status"], macro["riskFree"]["USD"]["yield"]), ("stale", 0.048))


class DeadlinesAndRetries(unittest.TestCase):
    def test_a_call_that_overruns_its_deadline_is_abandoned(self):
        started = time.monotonic()
        with self.assertRaises(ff.FetchError) as caught:
            ff.run_with_deadline("slow", lambda: time.sleep(2), 0.2)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertIn("deadline", str(caught.exception))

    def test_results_and_errors_pass_through_the_deadline_wrapper(self):
        self.assertEqual(ff.run_with_deadline("fast", lambda: 42, 1), 42)
        with self.assertRaises(KeyError):
            ff.run_with_deadline("broken", lambda: {}["missing"], 1)

    def test_retry_succeeds_after_transient_failures(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise ConnectionError("temporary")
            return "ok"

        self.assertEqual(ff.with_retry("flaky", flaky, attempts=3, base_delay=0.01), "ok")
        self.assertEqual(len(calls), 3)

    def test_retry_gives_up_rather_than_sleeping_past_the_deadline(self):
        calls = []

        def always_fails():
            calls.append(1)
            raise ConnectionError("down")

        with self.assertRaises(ff.FetchError):
            ff.with_retry("down", always_fails, attempts=5, base_delay=10, deadline=time.monotonic() + 0.5)
        self.assertEqual(len(calls), 1)  # the 10s backoff would overrun, so no second attempt

    def test_rate_limits_are_recognised_and_reported(self):
        self.assertTrue(ff.is_rate_limit(RuntimeError("429 Too Many Requests")))
        self.assertTrue(ff.is_rate_limit(urllib.error.HTTPError("u", 429, "Too Many Requests", None, None)))
        self.assertFalse(ff.is_rate_limit(ConnectionError("connection reset")))

        def limited():
            raise RuntimeError("Too Many Requests. Rate limited.")

        with self.assertRaises(ff.FetchError) as caught:
            ff.with_retry("limited", limited, attempts=1, base_delay=0.01)
        self.assertTrue(caught.exception.rate_limited)


class ForecastHelpers(unittest.TestCase):
    def test_the_horizon_is_30_calendar_days_for_every_asset_class(self):
        self.assertEqual(ff.FORECAST_HORIZON_DAYS, 30)
        crypto = ff.future_dates("2026-11-13", 30, weekdays_only=False)
        self.assertEqual(len(crypto), 30)
        self.assertEqual((crypto[0], crypto[-1]), ("2026-11-14", "2026-12-13"))

    def test_stocks_get_the_weekdays_inside_the_same_30_days(self):
        stock = ff.future_dates("2026-11-13", 30, weekdays_only=True)  # the 13th is a Friday
        self.assertEqual(stock[0], "2026-11-16")  # the following Monday
        self.assertEqual(len(stock), 20)  # four full weeks of weekdays
        self.assertTrue(all(datetime.strptime(day, "%Y-%m-%d").weekday() < 5 for day in stock))
        self.assertLessEqual(stock[-1], "2026-12-13")

    def test_the_seed_depends_only_on_the_ticker(self):
        self.assertEqual(ff.stable_seed("AMD"), ff.stable_seed("AMD"))
        self.assertNotEqual(ff.stable_seed("AMD"), ff.stable_seed("MU"))
        self.assertGreaterEqual(ff.stable_seed("BTC-USD"), 0)

    def test_backtest_metrics_match_a_hand_calculation(self):
        actual = [100.0, 110.0, 120.0]
        rows = [["d1", 105.0, 95.0, 115.0], ["d2", 105.0, 100.0, 108.0], ["d3", 126.0, 110.0, 130.0]]
        metrics = ff.backtest_metrics(actual, rows, anchor=100.0)
        self.assertAlmostEqual(metrics["mape"], (5 / 100 + 5 / 110 + 6 / 120) / 3, places=6)        # 4.85%
        self.assertAlmostEqual(metrics["naiveMape"], (0 / 100 + 10 / 110 + 20 / 120) / 3, places=6)  # 8.59%
        self.assertAlmostEqual(metrics["endError"], 6 / 120, places=6)
        self.assertTrue(metrics["directionCorrect"])  # projected up, went up
        self.assertAlmostEqual(metrics["coverage"], 2 / 3, places=4)  # 110 fell outside its 100-108 band
        self.assertEqual((metrics["holdoutDays"], metrics["holdoutPoints"]), (30, 3))

    def test_direction_is_wrong_when_the_signs_differ_and_unknown_when_nothing_moved(self):
        rows = [["d1", 90.0, 85.0, 95.0]]
        self.assertFalse(ff.backtest_metrics([110.0], rows, anchor=100.0)["directionCorrect"])
        self.assertIsNone(ff.backtest_metrics([100.0], rows, anchor=100.0)["directionCorrect"])

    def test_a_forecast_longer_than_the_horizon_or_with_a_negative_error_is_rejected(self):
        block = {**ff.empty_forecast(None), "status": "fresh", "model": "prophet", "modelVersion": "1.5.0",
                 "config": {}, "trainedOn": {}, "horizon": {}, "backtest": {"mape": 0.05, "naiveMape": 0.04, "coverage": 0.8},
                 "points": [[f"2026-12-{day:02d}", 100.0, 90.0, 110.0] for day in range(1, 31)]}
        self.assertEqual(ff.validate_forecast(block), [])
        too_long = {**block, "points": block["points"] + [["2026-12-31", 100.0, 90.0, 110.0]]}
        self.assertTrue(any("horizon" in error for error in ff.validate_forecast(too_long)))
        negative = {**block, "backtest": {"mape": -0.1}}
        self.assertTrue(any("backtest.mape" in error for error in ff.validate_forecast(negative)))

    def test_a_failed_fit_falls_back_to_the_previous_projection_marked_stale(self):
        previous = {**ff.empty_forecast(None), "status": "fresh", "model": "prophet", "modelVersion": "1.5.0",
                    "config": {}, "trainedOn": {}, "horizon": {}, "backtest": {},
                    "points": [["2026-12-01", 100.0, 90.0, 110.0]]}
        kept = ff.fallback_forecast(previous, "The forecast model ran out of time.")
        self.assertEqual(kept["status"], "stale")
        self.assertEqual(kept["points"], previous["points"])
        self.assertIn("earlier run", kept["note"])
        self.assertEqual(previous["status"], "fresh")  # the original is not mutated
        fresh_start = ff.fallback_forecast(None, "The forecast model ran out of time.")
        self.assertEqual((fresh_start["status"], fresh_start["points"]), ("unavailable", []))
        self.assertEqual(ff.validate_forecast(fresh_start), [])

    def test_skipping_forecasts_never_starts_a_process(self):
        asset = {"ticker": "AAA", "assetClass": "equity", "candles": []}
        result = ff.run_forecasts([asset], {}, settings(skip_forecast=True))
        self.assertEqual(result["AAA"]["status"], "unavailable")
        self.assertEqual(ff.run_forecasts([], {}, settings()), {})


@unittest.skipUnless(importlib.util.find_spec("prophet"), "prophet is not installed")
class ProphetProjection(unittest.TestCase):
    """Fits the real model on synthetic prices with a known upward trend."""

    @classmethod
    def setUpClass(cls):
        ff.forecast_worker_init()
        rng = random.Random(11)
        start = datetime(2025, 9, 1)
        cls.dates, cls.closes = [], []
        price = 100.0
        for offset in range(430):
            day = start + timedelta(days=offset)
            if day.weekday() >= 5:
                continue
            # A steady climb with very little noise. This tests the plumbing (fit, anchor, backtest)
            # on a case with an unmistakable answer: over 21 trading days the drift is about 2.5%
            # and the noise about 0.2%, so the trend, not luck, decides every result.
            price *= math.exp(0.0012 + rng.gauss(0, 0.0005))
            cls.dates.append(day.strftime("%Y-%m-%d"))
            cls.closes.append(round(price, 4))
        cls.block = ff.forecast_series("TEST", "equity", cls.dates, cls.closes)

    def test_the_block_has_the_schema_shape_and_validates(self):
        self.assertEqual(sorted(self.block), sorted(ff.FORECAST_KEYS))
        self.assertEqual(ff.validate_forecast(self.block), [])
        self.assertEqual((self.block["status"], self.block["model"]), ("fresh", "prophet"))
        self.assertEqual(self.block["trainedOn"], {"from": self.dates[0], "to": self.dates[-1], "observations": len(self.dates)})

    def test_the_model_is_the_lightweight_one_that_was_specified(self):
        config = self.block["config"]
        self.assertEqual(config["target"], "log(close)")
        self.assertTrue(config["weeklySeasonality"])
        self.assertFalse(config["yearlySeasonality"])
        self.assertFalse(config["dailySeasonality"])
        self.assertEqual(config["mcmcSamples"], 0)
        self.assertEqual(config["anchor"], "last close")

    def test_points_cover_the_weekdays_of_the_next_30_calendar_days(self):
        expected = ff.future_dates(self.dates[-1], 30, weekdays_only=True)
        self.assertEqual([row[0] for row in self.block["points"]], expected)
        self.assertEqual(self.block["horizon"], {"calendarDays": 30, "points": len(expected), "weekdaysOnly": True})

    def test_the_projection_starts_at_the_last_close_and_follows_the_trend(self):
        first, last = self.block["points"][0], self.block["points"][-1]
        self.assertLess(abs(first[1] / self.closes[-1] - 1), 0.03)  # anchored: no jump on day one
        self.assertGreater(last[1], self.closes[-1])                 # the fitted trend is upward
        for _, estimate, lower, upper in self.block["points"]:
            self.assertTrue(0 < lower <= estimate <= upper)
        self.assertGreater(last[3] - last[2], first[3] - first[2])   # uncertainty widens with time

    def test_the_backtest_reports_the_model_against_the_no_change_benchmark(self):
        backtest = self.block["backtest"]
        self.assertGreater(backtest["holdoutPoints"], 15)
        for key in ("mape", "naiveMape", "coverage"):
            self.assertGreaterEqual(backtest[key], 0)
        self.assertLessEqual(backtest["coverage"], 1)
        self.assertIn(backtest["directionCorrect"], (True, False, None))
        # On a series with a strong steady trend the model should beat "no change".
        self.assertLess(backtest["mape"], backtest["naiveMape"])

    def test_the_same_inputs_give_the_same_projection(self):
        again = ff.forecast_series("TEST", "equity", self.dates, self.closes)
        self.assertEqual(again["points"], self.block["points"])
        self.assertEqual(again["backtest"], self.block["backtest"])

    def test_crypto_gets_all_30_days(self):
        days = [(datetime(2026, 1, 1) + timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(len(self.closes))]
        block = ff.forecast_series("COIN", "crypto", days, self.closes)
        self.assertEqual(len(block["points"]), 30)
        self.assertFalse(block["horizon"]["weekdaysOnly"])

    def test_too_little_history_still_projects_but_reports_no_backtest(self):
        block = ff.forecast_series("NEW", "equity", self.dates[:100], self.closes[:100])
        self.assertEqual(ff.validate_forecast(block), [])
        self.assertIsNone(block["backtest"]["mape"])
        self.assertIn("Not enough history", block["backtest"]["note"])


@unittest.skipUnless(SNAPSHOT_PATH.exists(), "no committed snapshot to validate")
class SnapshotValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = ff.load_json(SNAPSHOT_PATH)

    def mutated(self) -> dict:
        return copy.deepcopy(self.snapshot)

    @staticmethod
    def fixture_news() -> dict:
        # Built here rather than read from the snapshot: on a day when the news feed is down the
        # committed file legitimately has no fresh stories, and this gate must still pass.
        return ff.build_news([headline("Fixture story about a surge", 2), headline("Second fixture story", 5)],
                             FakeAnalyzer(), NOW)

    def test_the_committed_snapshot_is_valid(self):
        self.assertEqual(ff.validate_snapshot(self.snapshot), [])
        self.assertEqual(self.snapshot["schemaVersion"], 3)

    def test_rendering_round_trips_exactly(self):
        self.assertEqual(json.loads(ff.render_snapshot(self.snapshot)), self.snapshot)

    def test_more_than_three_stories_is_rejected(self):
        snapshot = self.mutated()
        asset = snapshot["assets"][0]
        asset["news"] = self.fixture_news()
        asset["news"]["clusters"] = [asset["news"]["clusters"][0]] * 4
        self.assertTrue(any("at most 3" in error for error in ff.validate_snapshot(snapshot)))

    def test_an_insecure_story_link_is_rejected(self):
        snapshot = self.mutated()
        asset = snapshot["assets"][0]
        asset["news"] = self.fixture_news()
        self.assertEqual(ff.validate_snapshot(snapshot), [])  # the fixture itself is valid
        asset["news"]["clusters"][0]["link"] = "javascript:alert(1)"
        self.assertTrue(any("https" in error for error in ff.validate_snapshot(snapshot)))

    def test_an_unavailable_forecast_may_not_carry_points(self):
        snapshot = self.mutated()
        snapshot["assets"][0]["forecast"] = ff.empty_forecast(None)
        snapshot["assets"][0]["forecast"]["points"] = [["2026-12-01", 1.0, 0.9, 1.1]]
        self.assertTrue(any("must not carry points" in error for error in ff.validate_snapshot(snapshot)))

    def test_a_forecast_band_must_contain_its_estimate(self):
        forecast = {**ff.empty_forecast(None), "status": "fresh", "model": "prophet", "modelVersion": "1.5.0",
                    "config": {}, "trainedOn": {}, "horizon": {}, "backtest": {},
                    "points": [["2026-12-01", 100.0, 90.0, 110.0], ["2026-12-02", 120.0, 90.0, 110.0]]}
        self.assertTrue(any("lower <= yhat <= upper" in error for error in ff.validate_forecast(forecast)))
        forecast["points"][1][1] = 101.0
        self.assertEqual(ff.validate_forecast(forecast), [])

    def test_an_unavailable_rate_may_not_carry_a_yield(self):
        snapshot = self.mutated()
        snapshot["macro"]["riskFree"]["SGD"]["status"] = "unavailable"
        self.assertTrue(any("must be null" in error for error in ff.validate_snapshot(snapshot)))

    def test_an_implausible_yield_or_fx_series_is_rejected(self):
        snapshot = self.mutated()
        snapshot["macro"]["riskFree"]["USD"]["yield"] = 5.13  # percent instead of a decimal
        self.assertTrue(any("plausible yield" in error for error in ff.validate_snapshot(snapshot)))
        snapshot = self.mutated()
        snapshot["fx"]["series"] = [["2026-01-02", 1.3], ["2026-01-01", 1.3]]
        self.assertTrue(any("fx.series" in error for error in ff.validate_snapshot(snapshot)))

    def test_a_version_1_asset_is_upgraded_before_being_carried_over(self):
        old = copy.deepcopy(next(a for a in self.snapshot["assets"] if a["assetClass"] == "equity"))
        del old["news"], old["forecast"]
        self.assertTrue(ff.validate_asset(old))  # invalid as it stands
        upgraded = ff.upgrade_asset(old)
        self.assertEqual(ff.validate_asset(upgraded), [])
        carried = ff.carry_over(upgraded, {"lotSize": 1, "binanceSymbol": None}, "test")
        self.assertEqual(carried["status"], "stale")
        self.assertEqual(ff.validate_asset(carried), [])

    def test_carrying_over_marks_fresh_news_as_stale(self):
        asset = copy.deepcopy(self.snapshot["assets"][0])
        asset["news"] = self.fixture_news()
        self.assertEqual(asset["news"]["status"], "fresh")
        carried = ff.carry_over(asset, {"lotSize": asset["lotSize"], "binanceSymbol": asset["binanceSymbol"]}, "test")
        self.assertEqual(carried["news"]["status"], "stale")
        self.assertEqual(ff.validate_asset(carried), [])


class AssetClasses(unittest.TestCase):
    """Stocks, REITs, ETFs, indices and crypto, including the London listing."""

    @classmethod
    def setUpClass(cls):
        cls.watchlist = ff.load_json(ff.DEFAULT_WATCHLIST)
        cls.snapshot = ff.load_json(SNAPSHOT_PATH)

    def entry(self, **overrides) -> dict:
        base = {"ticker": "VOO", "assetClass": "etf", "market": "US", "currency": "USD", "lotSize": 1,
                "binanceSymbol": None, "scoringProfile": None}
        base.update(overrides)
        return base

    def watchlist_with(self, *entries) -> dict:
        clone = copy.deepcopy(self.watchlist)
        clone["assets"] = list(entries)
        return clone

    def test_the_committed_watchlist_is_valid_and_within_the_designed_size(self):
        # Rules only, never the list itself: editing the watchlist must not break this gate.
        self.assertEqual(ff.validate_watchlist(self.watchlist), [])
        self.assertLessEqual(len(self.watchlist["assets"]), 30)

    def test_index_symbols_with_a_leading_caret_are_accepted(self):
        for ticker in ("^GSPC", "^IXIC", "^DJI", "^STI", "CSPX.L", "BRK-B", "AVAX-USD", "D05.SI"):
            self.assertRegex(ticker, ff.TICKER_RE)
        for ticker in ("GS^PC", "^^GSPC", "^", "aapl", "A" * 17):
            self.assertIsNone(ff.TICKER_RE.match(ticker), ticker)

    def test_each_class_without_accounts_has_its_own_profile(self):
        for asset_class, profile in (("etf", "ETF"), ("index", "INDEX"), ("crypto", "CRYPTO")):
            entry = self.entry(assetClass=asset_class, scoringProfile=None)
            # The class decides, whatever the (missing) sector says.
            self.assertEqual(ff.resolve_profile(entry, "Financial Services"), profile)
        self.assertEqual(ff.resolve_profile(self.entry(assetClass="equity"), "Real Estate"), "REIT")
        self.assertEqual(ff.resolve_profile(self.entry(assetClass="equity"), "Energy"), "CORPORATE")

    def test_a_profile_that_contradicts_the_class_is_rejected(self):
        errors = ff.validate_watchlist(self.watchlist_with(
            self.entry(ticker="VOO", scoringProfile="CORPORATE"),
            self.entry(ticker="AMD", assetClass="equity", scoringProfile="ETF"),
            self.entry(ticker="CSPX.L", market="LSE"),
        ))
        joined = " ".join(errors)
        self.assertIn("VOO: etf assets always use the ETF profile", joined)
        self.assertIn("AMD: equities may only override to", joined)
        self.assertIn("CSPX.L: market must be one of", joined)

    def test_snapshot_assets_must_pair_class_and_profile(self):
        asset = copy.deepcopy(next(a for a in self.snapshot["assets"] if a["assetClass"] == "equity"))
        self.assertEqual(ff.validate_asset(asset), [])
        asset["assetClass"], asset["scoringProfile"] = "etf", "CORPORATE"
        self.assertTrue(any("etf assets must use the ETF scoring profile" in e for e in ff.validate_asset(asset)))
        asset["assetClass"], asset["scoringProfile"] = "equity", "INDEX"
        self.assertTrue(any("equities must use one of" in e for e in ff.validate_asset(asset)))
        asset["assetClass"], asset["scoringProfile"], asset["ticker"], asset["market"] = "index", "INDEX", "^GSPC", "US"
        self.assertEqual(ff.validate_asset(asset), [])

    def test_assets_without_accounts_carry_no_company_figures(self):
        for asset in self.snapshot["assets"]:
            if asset["assetClass"] in {"etf", "index"}:
                self.assertIsNone(asset["sector"])
                self.assertIsNone(asset["fundamentalsPeriod"])
                ignored = {"dividendYieldTTM"} if asset["assetClass"] == "etf" else set()
                self.assertTrue(all(v is None for k, v in asset["fundamentals"].items() if k not in ignored), asset["ticker"])

    def test_a_london_candle_is_kept_only_after_the_london_close(self):
        index = pd.DatetimeIndex(pd.date_range("2026-11-16", periods=3, freq="D", tz="Europe/London"))
        history = pd.DataFrame({"Open": [10.0, 11.0, 12.0], "High": [10.5, 11.5, 12.5], "Low": [9.5, 10.5, 11.5],
                                "Close": [10.2, 11.2, 12.2], "Volume": [100, 100, 100]}, index=index)
        during = datetime(2026, 11, 18, 15, 0, tzinfo=timezone.utc)   # 15:00 in London (GMT): session still open
        after = datetime(2026, 11, 18, 17, 0, tzinfo=timezone.utc)    # 17:00: closed, past the 20-minute buffer
        self.assertEqual([c[0] for c in ff.build_candles(history, "UK", during)], ["2026-11-16", "2026-11-17"])
        self.assertEqual(len(ff.build_candles(history, "UK", after)), 3)


class PriceToBookCheck(unittest.TestCase):
    def fundamentals(self, **values) -> dict:
        base = ff.empty_fundamentals()
        base.update(values)
        return base

    def test_an_implausible_reported_value_is_replaced_by_market_cap_over_equity(self):
        # Yahoo reported Berkshire Hathaway B at 0.001.
        data = self.fundamentals(priceToBook=0.0010664, marketCap=1_215_000_000_000, totalEquity=675_000_000_000)
        self.assertAlmostEqual(ff.checked_price_to_book("BRK-B", data, "USD", "USD"), 1.8, places=4)

    def test_a_plausible_reported_value_is_kept(self):
        data = self.fundamentals(priceToBook=1.9, marketCap=100.0, totalEquity=60.0)  # computed 1.67
        self.assertEqual(ff.checked_price_to_book("D05.SI", data, "SGD", "SGD"), 1.9)

    def test_no_check_without_comparable_inputs(self):
        cases = [
            (self.fundamentals(priceToBook=0.001, marketCap=100.0, totalEquity=50.0), "USD", "CAD"),  # mixed currencies
            (self.fundamentals(priceToBook=0.001, marketCap=100.0, totalEquity=None), "USD", "USD"),
            (self.fundamentals(priceToBook=0.001, marketCap=100.0, totalEquity=-5.0), "USD", "USD"),  # negative book
            (self.fundamentals(priceToBook=None, marketCap=100.0, totalEquity=50.0), "USD", "USD"),   # nothing reported
            (self.fundamentals(priceToBook=-2.0, marketCap=100.0, totalEquity=50.0), "USD", "USD"),
        ]
        for data, currency, reporting in cases:
            self.assertEqual(ff.checked_price_to_book("X", data, currency, reporting), data["priceToBook"])


class TelegramBriefing(unittest.TestCase):
    TOKEN = "123456:TEST-token-value"
    ENV = {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_CHAT_ID": "-1001234"}
    PASSED = {"QUANTLENS_FETCH": "success", "QUANTLENS_VALIDATE": "success", "QUANTLENS_GATE1": "success",
              "QUANTLENS_GATE2": "success", "QUANTLENS_COMMIT": "success"}
    SIGNALS = [
        {"ticker": "MU", "name": "Micron Technology", "verdict": "BUY", "composite": 81.4, "confidence": "High"},
        {"ticker": "D05.SI", "name": "DBS Group", "verdict": "BUY", "composite": 70.0, "confidence": "Medium"},
        {"ticker": "^GSPC", "name": "S&P 500", "verdict": "HOLD", "composite": 55.0, "confidence": "Low"},
        {"ticker": "BRK-B", "name": "Berkshire Hathaway", "verdict": "SELL", "composite": 40.2, "confidence": "Low"},
        {"ticker": "ETH-USD", "name": "Ethereum", "verdict": "SELL", "composite": 12.0, "confidence": "Low"},
    ]

    @classmethod
    def setUpClass(cls):
        cls.snapshot = ff.load_json(SNAPSHOT_PATH)

    class Response:
        def __init__(self, payload):
            self.payload = json.dumps(payload).encode()

        def read(self, *_):
            return self.payload

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def opener(self, *replies):
        """A fake urlopen that records requests and returns (or raises) the given replies in turn."""
        calls = []
        queue = list(replies)

        def fake(request, timeout=None):
            calls.append({"url": request.full_url, "body": json.loads(request.data), "timeout": timeout})
            reply = queue.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return self.Response(reply)

        return fake, calls

    @staticmethod
    def http_error(code, description):
        import io
        body = io.BytesIO(json.dumps({"ok": False, "description": description}).encode())
        return urllib.error.HTTPError("https://api.telegram.org/bot***/sendMessage", code, "error", {}, body)

    def deliver(self, env, opener, **kwargs):
        kwargs.setdefault("signals_source", lambda _path: self.SIGNALS)
        kwargs.setdefault("pause", lambda _seconds: None)
        return ff.deliver_briefing(SNAPSHOT_PATH, kwargs.pop("previous", None), env, opener=opener, now=NOW, **kwargs)

    def test_missing_credentials_skip_silently_without_any_request(self):
        fake, calls = self.opener()
        for env in ({}, {"TELEGRAM_BOT_TOKEN": self.TOKEN}, {"TELEGRAM_CHAT_ID": "1"}, {"TELEGRAM_BOT_TOKEN": " ", "TELEGRAM_CHAT_ID": "1"}):
            with self.assertNoLogs(ff.LOG, level="WARNING"):
                self.assertEqual(self.deliver(env, fake), "skipped")
        self.assertEqual(calls, [])

    def test_a_successful_send_uses_markdown_v2_and_the_bot_api(self):
        fake, calls = self.opener({"ok": True, "result": {}})
        self.assertEqual(self.deliver({**self.ENV, **self.PASSED}, fake), "sent")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["url"], f"https://api.telegram.org/bot{self.TOKEN}/sendMessage")
        self.assertEqual(calls[0]["body"]["parse_mode"], "MarkdownV2")
        self.assertEqual(calls[0]["body"]["chat_id"], "-1001234")
        self.assertTrue(calls[0]["body"]["disable_web_page_preview"])
        self.assertEqual(calls[0]["timeout"], ff.TELEGRAM_TIMEOUT)

    def test_a_rejected_markdown_message_is_resent_as_plain_text(self):
        fake, calls = self.opener(self.http_error(400, "Bad Request: can't parse entities"), {"ok": True})
        with self.assertLogs(ff.LOG, level="WARNING"):
            self.assertEqual(self.deliver({**self.ENV, **self.PASSED}, fake), "sent-plain")
        self.assertNotIn("parse_mode", calls[1]["body"])
        self.assertNotIn("\\.", calls[1]["body"]["text"])  # no Markdown escapes in the plain version

    def test_api_failures_warn_never_raise_and_never_print_the_token(self):
        scenarios = [
            (self.http_error(401, "Unauthorized"),),                                     # bad token: no retry
            (self.http_error(403, f"Forbidden: bot {self.TOKEN} was blocked"),),          # token echoed back
            (urllib.error.URLError("offline"), urllib.error.URLError("still offline")),  # network: one retry
            (self.http_error(502, "Bad Gateway"), self.http_error(502, "Bad Gateway")),
        ]
        for replies in scenarios:
            fake, calls = self.opener(*replies)
            with self.assertLogs(ff.LOG, level="WARNING") as logs:
                self.assertEqual(self.deliver({**self.ENV, **self.PASSED}, fake), "failed")
            self.assertEqual(len(calls), len(replies))
            self.assertFalse(any(self.TOKEN in line for line in logs.output))

    def test_an_unexpected_error_while_building_is_a_warning_too(self):
        def broken(_path):
            raise ValueError(f"something mentioning {self.TOKEN}")
        fake, calls = self.opener()
        with self.assertLogs(ff.LOG, level="WARNING") as logs:
            self.assertEqual(self.deliver({**self.ENV, **self.PASSED}, fake, signals_source=broken), "failed")
        self.assertEqual(calls, [])
        self.assertFalse(any(self.TOKEN in line for line in logs.output))

    def test_the_notify_command_always_exits_zero(self):
        def explode(*_args, **_kwargs):
            raise RuntimeError("boom")
        original = ff.deliver_briefing
        try:
            ff.deliver_briefing = explode
            with self.assertLogs(ff.LOG, level="WARNING"):
                self.assertEqual(ff.run_notify(settings(notify=True)), 0)
        finally:
            ff.deliver_briefing = original
        # A missing snapshot, no signals and a dead network still end normally, with a status-only attempt.
        fake, calls = self.opener(urllib.error.URLError("offline"), urllib.error.URLError("offline"))
        with self.assertLogs(ff.LOG, level="WARNING"):
            result = ff.deliver_briefing(Path("does/not/exist.json"), None, {**self.ENV, **self.PASSED},
                                         opener=fake, now=NOW, signals_source=lambda _p: None, pause=lambda _s: None)
        self.assertEqual(result, "failed")
        self.assertIn("Every check passed", calls[0]["body"]["text"].replace("\\", ""))

    def test_chat_ids_are_split_on_commas_trimmed_and_deduplicated(self):
        ids, invalid = ff.parse_chat_ids(" 123456789, -1001234567890 ,, @quant_lens_feed, 123456789, abc, 12x, ")
        self.assertEqual(ids, ["123456789", "-1001234567890", "@quant_lens_feed"])
        self.assertEqual(invalid, 2)
        self.assertEqual(ff.parse_chat_ids("-1001234"), (["-1001234"], 0))
        self.assertEqual(ff.parse_chat_ids(None), ([], 0))
        self.assertEqual(ff.parse_chat_ids(" , ,"), ([], 0))

    def test_every_recipient_gets_the_same_message_and_a_failure_does_not_stop_the_others(self):
        ids = ["111111", "-1002222222222", "333333"]
        fake, calls = self.opener({"ok": True}, self.http_error(403, "Forbidden: bot was blocked by the user"), {"ok": True})
        env = {"TELEGRAM_BOT_TOKEN": self.TOKEN, "TELEGRAM_CHAT_ID": ", ".join(ids), **self.PASSED}
        with self.assertLogs(ff.LOG, level="WARNING") as logs:
            self.assertEqual(self.deliver(env, fake), "partial")
        self.assertEqual([call["body"]["chat_id"] for call in calls], ids)
        self.assertEqual(len({call["body"]["text"] for call in calls}), 1)
        joined = "\n".join(logs.output)
        self.assertIn("recipient 2 of 3", joined)
        self.assertIn("reached 2 of 3 recipients", joined)
        for secret in [self.TOKEN, *ids]:
            self.assertNotIn(secret, joined)  # chat ids are not masked by GitHub once the secret is split

    def test_all_recipients_reached_is_a_plain_success(self):
        fake, calls = self.opener({"ok": True}, {"ok": True})
        env = {"TELEGRAM_BOT_TOKEN": self.TOKEN, "TELEGRAM_CHAT_ID": "111111,222222", **self.PASSED}
        with self.assertNoLogs(ff.LOG, level="WARNING"):
            self.assertEqual(self.deliver(env, fake), "sent")
        self.assertEqual(len(calls), 2)

    def test_the_markdown_fallback_is_decided_per_recipient(self):
        fake, calls = self.opener(self.http_error(400, "Bad Request: can't parse entities"), {"ok": True}, {"ok": True})
        env = {"TELEGRAM_BOT_TOKEN": self.TOKEN, "TELEGRAM_CHAT_ID": "111111,222222", **self.PASSED}
        with self.assertLogs(ff.LOG, level="WARNING"):
            self.assertEqual(self.deliver(env, fake), "sent-plain")
        self.assertEqual([("parse_mode" in call["body"]) for call in calls], [True, False, True])

    def test_invalid_entries_are_skipped_with_a_count_never_their_values(self):
        fake, calls = self.opener({"ok": True})
        env = {"TELEGRAM_BOT_TOKEN": self.TOKEN, "TELEGRAM_CHAT_ID": "not-an-id, 111111", **self.PASSED}
        with self.assertLogs(ff.LOG, level="WARNING") as logs:
            self.assertEqual(self.deliver(env, fake), "sent")
        self.assertEqual(len(calls), 1)
        self.assertIn("1 TELEGRAM_CHAT_ID entry was skipped", "\n".join(logs.output))
        self.assertNotIn("not-an-id", "\n".join(logs.output))
        fake, calls = self.opener()
        with self.assertLogs(ff.LOG, level="WARNING"):
            self.assertEqual(self.deliver({"TELEGRAM_BOT_TOKEN": self.TOKEN, "TELEGRAM_CHAT_ID": "nope"}, fake), "failed")
        self.assertEqual(calls, [])

    def test_pipeline_outcome_names_the_first_step_that_did_not_succeed(self):
        self.assertEqual(ff.pipeline_outcome(self.PASSED), ("passed", None))
        self.assertEqual(ff.pipeline_outcome({}), ("unknown", None))
        gate = {**self.PASSED, "QUANTLENS_GATE2": "failure", "QUANTLENS_COMMIT": "skipped"}
        self.assertEqual(ff.pipeline_outcome(gate), ("failed", "Gate 2 (browser tests)"))
        fetch = {key: "skipped" for key in self.PASSED} | {"QUANTLENS_FETCH": "failure"}
        self.assertEqual(ff.pipeline_outcome(fetch), ("failed", "data refresh"))

    def build(self, outcome="passed", failed_step=None, signals=SIGNALS, shifts=None, markdown=True, links=()):
        return ff.build_briefing(self.snapshot, signals, shifts, outcome, failed_step, NOW, list(links),
                                 ff.BriefingFormat(markdown))

    def test_signals_are_ranked_best_buy_first_and_worst_sell_first(self):
        text = self.build(markdown=False)
        self.assertLess(text.index("Top BUY signals"), text.index("1. MU"))
        self.assertLess(text.index("1. MU"), text.index("2. D05.SI"))
        self.assertLess(text.index("Top SELL signals"), text.index("1. ETH-USD"))
        self.assertLess(text.index("1. ETH-USD"), text.index("2. BRK-B"))
        self.assertIn("81/100 · High confidence", text)
        self.assertIn("All verdicts: 2 BUY · 1 HOLD · 2 SELL", text)
        self.assertNotIn("^GSPC", text)  # a HOLD is neither a top BUY nor a top SELL

    def test_markdown_escapes_every_special_character_outside_code(self):
        self.assertEqual(ff.escape_markdown_v2("D05.SI (+1.5%) [x]_*!"), r"D05\.SI \(\+1\.5%\) \[x\]\_\*\!")
        text = self.build(links=[("Open QuantLens", "https://user.github.io/quantlens/")])
        self.assertIn("`BRK-B`", text)        # tickers sit in code spans, unescaped
        self.assertIn("`^GSPC`" if "^GSPC" in text else "`MU`", text)
        self.assertIn(r"81/100 · High confidence", text)
        self.assertIn("[Open QuantLens](https://user.github.io/quantlens/)", text)
        self.assertIn(r"_Rule\-based signals for learning, not financial advice\._", text)

    def test_a_failed_gate_holds_the_signals_back(self):
        text = self.build(outcome="failed", failed_step="Gate 2 (browser tests)", signals=None, markdown=False)
        self.assertIn("Gate 2 (browser tests) failed, so today's data was NOT published", text)
        self.assertNotIn("Top BUY signals", text)
        self.assertNotIn("Signals are unavailable", text)

    def test_a_failed_refresh_reports_the_signals_of_the_last_good_snapshot(self):
        text = self.build(outcome="failed", failed_step="data refresh", markdown=False)
        self.assertIn("The data refresh failed, so nothing was committed", text)
        self.assertIn("the signals below are from it", text)
        self.assertIn("Top BUY signals", text)

    def test_earnings_within_30_days_are_listed_nearest_first(self):
        rows = [dict(row) for row in self.SIGNALS]
        rows[0].update(nextEarnings={"date": "2026-12-17", "days": 26}, typicalMove=0.058, worstMove=-0.162)
        rows[1].update(nextEarnings={"date": "2026-12-01", "days": 10}, typicalMove=None, worstMove=None)
        rows[3].update(nextEarnings={"date": "2027-02-01", "days": 72}, typicalMove=0.02, worstMove=-0.03)
        text = self.build(signals=rows, markdown=False)
        self.assertIn("Earnings in the next 30 days", text)
        first, second = text.index("D05.SI ~1 Dec (in 10 days)"), text.index("MU ~17 Dec (in 26 days)")
        self.assertLess(first, second)
        self.assertIn("typical move \u00b15.8%, worst \u221216.2%", text)
        self.assertIn("too few past releases to size the move", text)
        self.assertNotIn("in 72 days", text)
        self.assertNotIn("Earnings in the next", self.build(markdown=False))  # nothing upcoming: no section
        markdown = self.build(signals=rows)
        self.assertIn("`MU`", markdown)
        self.assertIn("\\(in 26 days\\)", markdown)

    def test_the_message_stays_inside_telegrams_limit(self):
        many = [{"ticker": f"T{i}", "name": "N" * 200, "verdict": "BUY", "composite": 90 - i % 40, "confidence": "High"} for i in range(400)]
        shifts = [{"ticker": f"S{i}", "from": "positive", "to": "negative", "before": 0.5, "after": -0.5, "delta": -1.0,
                   "headline": "H" * 400} for i in range(50)]
        text = self.build(signals=many, shifts=shifts)
        self.assertLessEqual(len(text), ff.TELEGRAM_MAX_CHARS)

    def test_sentiment_shifts_need_a_flip_or_a_large_move_in_fresh_news(self):
        def asset(ticker, label, compound, status="fresh"):
            return {"ticker": ticker, "news": {"status": status, "sentiment": {"label": label, "compound": compound},
                                               "clusters": [{"title": f"{ticker} headline"}]}}
        previous = {"assets": [asset("A", "positive", 0.06), asset("B", "neutral", 0.0), asset("C", "positive", 0.4),
                               asset("D", "positive", 0.5), asset("E", "neutral", 0.0)]}
        current = {"assets": [asset("A", "negative", -0.06),      # small, but flipped sign: notable
                              asset("B", "neutral", 0.2),          # small move, no flip: not notable
                              asset("C", "neutral", 0.0),          # moved 0.40: notable
                              asset("D", "negative", -0.5, "stale"),  # carried over: cannot have shifted
                              asset("F", "negative", -0.9)]}       # nothing to compare with
        shifts = ff.sentiment_shifts(previous, current)
        self.assertEqual([s["ticker"] for s in shifts], ["C", "A"])  # largest move first
        self.assertEqual((shifts[1]["from"], shifts[1]["to"]), ("positive", "negative"))
        self.assertEqual(shifts[0]["headline"], "C headline")
        self.assertEqual(ff.sentiment_shifts(None, current), [])

    def test_links_come_from_githubs_own_variables(self):
        env = {"GITHUB_REPOSITORY": "MyUser/quantlens", "GITHUB_SERVER_URL": "https://github.com", "GITHUB_RUN_ID": "42"}
        self.assertEqual(ff.briefing_links(env), [
            ("Open QuantLens", "https://myuser.github.io/quantlens/"),
            ("Run log", "https://github.com/MyUser/quantlens/actions/runs/42"),
        ])
        self.assertEqual(ff.briefing_links({}), [])
        self.assertEqual(ff.briefing_links({"GITHUB_REPOSITORY": "../evil"}), [])

    @unittest.skipIf(shutil.which("node") is None, "Node.js is not installed")
    def test_the_signals_bridge_runs_the_sites_engines_over_the_committed_snapshot(self):
        signals = ff.compute_signals(SNAPSHOT_PATH)
        self.assertIsNotNone(signals)
        self.assertEqual([row["ticker"] for row in signals], [asset["ticker"] for asset in self.snapshot["assets"]])
        for row in signals:
            self.assertIn(row["verdict"], {"BUY", "HOLD", "SELL"}, row["ticker"])
            self.assertTrue(0 <= row["composite"] <= 100, row["ticker"])
        by_class = {asset["ticker"]: asset["assetClass"] for asset in self.snapshot["assets"]}
        for row in signals:
            if by_class[row["ticker"]] in {"etf", "index", "crypto"}:
                self.assertEqual(row["confidence"], "Low", row["ticker"])  # technical only, by construction
        upcoming = [row for row in signals if row["nextEarnings"]]
        self.assertTrue(upcoming)  # the event layer reaches the briefing
        for row in upcoming:
            self.assertEqual(by_class[row["ticker"]], "equity")
            self.assertGreaterEqual(row["nextEarnings"]["days"], 0)


class SchemaV3History(unittest.TestCase):
    """Five years of prices: one adjusted request, split into recent candles and older closes."""

    @staticmethod
    def rows(start: str, count: int, step_days: int = 1) -> list:
        first = date.fromisoformat(start)
        return [[(first + timedelta(days=i * step_days)).isoformat(), 10.0 + i, 11.0 + i, 9.0 + i, 10.5 + i, 100]
                for i in range(count)]

    def test_the_last_year_keeps_ohlcv_and_older_sessions_keep_the_close(self):
        rows = self.rows("2021-11-20", 1827)  # five years of daily crypto sessions
        candles, history = ff.split_history(rows)
        self.assertEqual(len(candles), ff.CANDLE_WINDOW_DAYS)
        self.assertEqual(len(candles) + len(history), len(rows))
        self.assertTrue(all(len(row) == 6 for row in candles))
        self.assertTrue(all(len(row) == 2 for row in history))
        self.assertEqual(history[-1], [rows[len(history) - 1][0], rows[len(history) - 1][4]])  # the close, untouched
        self.assertLess(history[-1][0], candles[0][0])
        self.assertEqual(ff.validate_history(history, candles[0][0]), [])

    def test_a_short_listing_has_little_or_no_history(self):
        candles, history = ff.split_history(self.rows("2026-01-01", 250))
        self.assertEqual((len(candles), history), (250, []))
        self.assertEqual(ff.split_history([]), ([], []))

    def test_dividends_are_read_from_the_same_price_frame(self):
        index = pd.DatetimeIndex(["2026-01-05", "2026-04-06", "2026-07-06", "2026-10-05", "2026-11-20"], tz="America/New_York")
        frame = pd.DataFrame({"Dividends": [0.0, 0.25, 0.0, 0.26, 0.27]}, index=index)
        self.assertEqual(ff.dividend_rows(frame, "2026-11-19"), [["2026-04-06", 0.25], ["2026-10-05", 0.26]])
        self.assertEqual(ff.dividend_rows(pd.DataFrame({"Close": [1.0]}, index=index[:1])), [])

    def test_history_validation(self):
        good = [["2021-11-22", 10.0], ["2021-11-23", 10.5]]
        self.assertEqual(ff.validate_history(good, "2021-11-24"), [])
        self.assertEqual(ff.validate_history([], "2021-11-24"), [])
        cases = {
            "unsorted": ([["2021-11-23", 10.0], ["2021-11-22", 10.5]], "2021-11-24"),
            "overlapping the candles": (good, "2021-11-23"),
            "a gap at the join": (good, "2021-12-10"),
            "a zero close": ([["2021-11-22", 0.0]], "2021-11-24"),
            "a three-field row": ([["2021-11-22", 10.0, 1]], "2021-11-24"),
        }
        for label, (history, first_candle) in cases.items():
            self.assertTrue(ff.validate_history(history, first_candle), label)

    def test_dividend_validation(self):
        self.assertEqual(ff.validate_dividends([["2026-04-06", 0.25], ["2026-10-05", 0.26]]), [])
        self.assertTrue(ff.validate_dividends([["2026-10-05", 0.26], ["2026-04-06", 0.25]]))
        self.assertTrue(ff.validate_dividends([["2026-04-06", -0.25]]))


class SchemaV3Events(unittest.TestCase):
    """Earnings and ex-dividend dates, with each release placed against the exchange's session."""

    NOW = datetime(2026, 11, 21, 22, 30, tzinfo=timezone.utc)

    @staticmethod
    def stamps(*values: str) -> pd.DataFrame:
        # Like Yahoo's own frame: one New York time zone, with summer and winter offsets.
        index = pd.DatetimeIndex([pd.Timestamp(v).tz_convert("America/New_York") for v in values])
        return pd.DataFrame({"EPS Estimate": [1.0] * len(values)}, index=index)

    def test_timing_is_judged_in_the_exchanges_own_hours(self):
        cases = [
            ("2026-09-30 16:00:00-04:00", "US", ("2026-09-30", "after-close")),
            ("2026-10-31 06:00:00-04:00", "US", ("2026-10-31", "before-open")),
            ("2026-10-31 12:00:00-04:00", "US", ("2026-10-31", "during-session")),
            ("2026-08-05 00:00:00-04:00", "US", ("2026-08-05", "unknown")),        # Yahoo's date-only placeholder
            ("2026-08-05 01:00:00-04:00", "SG", ("2026-08-05", "during-session")),  # 13:00 in Singapore
            ("2026-11-04 19:00:00-05:00", "SG", ("2026-11-05", "before-open")),     # 08:00 the next morning
            ("2026-11-04 02:00:00-05:00", "UK", ("2026-11-04", "before-open")),     # 07:00 in London
        ]
        for stamp, market, expected in cases:
            self.assertEqual(ff.earnings_timing(pd.Timestamp(stamp), market), expected, (stamp, market))

    def test_next_earnings_merges_both_sources_and_keeps_the_disagreement(self):
        frame = self.stamps("2026-12-17 16:00:00-05:00", "2026-09-30 16:00:00-04:00", "2026-06-24 16:00:00-04:00",
                            "2020-06-24 16:00:00-04:00")
        calendar = {"Earnings Date": [date(2026, 12, 18)], "Ex-Dividend Date": date(2027, 1, 13)}
        events = ff.build_events(calendar, frame, "US", self.NOW, history_start="2021-11-22")
        self.assertEqual(events["status"], "fresh")
        self.assertEqual(events["nextEarnings"], {"date": "2026-12-17", "dateTo": "2026-12-18", "timing": "after-close"})
        self.assertEqual(events["nextExDividend"], {"date": "2027-01-13"})
        self.assertEqual(events["earnings"], [{"date": "2026-09-30", "timing": "after-close"},
                                              {"date": "2026-06-24", "timing": "after-close"}])  # 2020 predates the history
        self.assertIsNone(events["note"])
        self.assertEqual(ff.validate_events(events), [])

    def test_a_past_ex_dividend_date_is_not_reported_as_next(self):
        events = ff.build_events({"Ex-Dividend Date": date(2026, 10, 14)}, None, "US", self.NOW, None)
        self.assertIsNone(events["nextExDividend"])
        self.assertIsNone(events["nextEarnings"])
        self.assertEqual(events["note"], "Yahoo lists no upcoming earnings date.")
        self.assertEqual(ff.validate_events(events), [])

    def test_dates_far_apart_are_separate_events(self):
        calendar = {"Earnings Date": [date(2026, 12, 1), date(2027, 1, 20)]}
        events = ff.build_events(calendar, None, "US", self.NOW, None)
        self.assertEqual(events["nextEarnings"], {"date": "2026-12-01", "dateTo": None, "timing": "unknown"})

    def test_assets_without_earnings_cost_no_request(self):
        original = ff.yf.Ticker
        ff.yf.Ticker = lambda *_a, **_k: self.fail("no request should be made")
        try:
            for asset_class in ("crypto", "index", "etf"):
                events = ff.fetch_events({"ticker": "X", "assetClass": asset_class, "market": "US"}, None, settings(), self.NOW, None)
                self.assertEqual(events["status"], "unavailable")
                self.assertTrue(events["note"])
                self.assertEqual(ff.validate_events(events), [])
        finally:
            ff.yf.Ticker = original

    def test_a_failed_calendar_keeps_the_previous_block_marked_stale(self):
        class Broken:
            @property
            def calendar(self):
                raise urllib.error.URLError("down")

            def get_earnings_dates(self, limit=None):
                raise urllib.error.URLError("down")

        previous = ff.build_events({"Earnings Date": [date(2026, 12, 18)]}, None, "US", self.NOW, None)
        original = ff.yf.Ticker
        ff.yf.Ticker = lambda *_a, **_k: Broken()
        try:
            entry = {"ticker": "MU", "assetClass": "equity", "market": "US"}
            quick = settings(max_retries=1, retry_delay=0.0, events_timeout=2.0)
            kept = ff.fetch_events(entry, previous, quick, self.NOW, None)
            self.assertEqual(kept["status"], "stale")
            self.assertEqual(kept["nextEarnings"], previous["nextEarnings"])
            fresh_start = ff.fetch_events(entry, None, quick, self.NOW, None)
            self.assertEqual(fresh_start["status"], "unavailable")
        finally:
            ff.yf.Ticker = original

    def test_event_validation_rejects_malformed_blocks(self):
        good = ff.build_events({"Earnings Date": [date(2026, 12, 18)]}, None, "US", self.NOW, None)
        self.assertEqual(ff.validate_events(good), [])
        broken = [
            dict(good, nextEarnings={"date": "2026-12-18", "dateTo": "2026-12-17", "timing": "unknown"}),
            dict(good, nextEarnings={"date": "2026-12-18", "dateTo": None, "timing": "lunchtime"}),
            dict(good, earnings=[{"date": "2026-01-01", "timing": "unknown"}, {"date": "2026-06-01", "timing": "unknown"}]),
            dict(ff.empty_events("x"), nextExDividend={"date": "2027-01-13"}),
            dict(good, fetchedAt=None),
            {k: v for k, v in good.items() if k != "note"},
        ]
        for block in broken:
            self.assertTrue(ff.validate_events(block), block)


class SchemaV3Snapshot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = ff.load_json(SNAPSHOT_PATH)

    def test_the_committed_snapshot_is_v3_with_history_and_events(self):
        self.assertEqual(self.snapshot["historyFields"], ff.HISTORY_FIELDS)
        for asset in self.snapshot["assets"]:
            self.assertEqual(ff.validate_history(asset["history"], asset["candles"][0][0]), [], asset["ticker"])
            if asset["assetClass"] in {"crypto", "index"}:
                self.assertEqual(asset["dividends"], [], asset["ticker"])
            if asset["assetClass"] != "equity":
                self.assertEqual(asset["events"]["status"], "unavailable", asset["ticker"])
            if asset["history"]:
                # One request, one adjustment: the join is an ordinary daily step, not a jump.
                step = asset["candles"][0][4] / asset["history"][-1][1]
                self.assertTrue(0.5 < step < 2.0, asset["ticker"])

    def test_usd_sgd_history_spans_the_same_five_years(self):
        earliest = min((a["history"] or a["candles"])[0][0] for a in self.snapshot["assets"])
        first_rate = self.snapshot["fx"]["series"][0][0]
        self.assertLessEqual((date.fromisoformat(first_rate) - date.fromisoformat(earliest)).days, 10)
        self.assertEqual(ff.FX_HISTORY_PERIOD, "5y")

    def test_a_v2_asset_is_upgraded_to_v3_and_carried_over_with_its_history(self):
        old = copy.deepcopy(next(a for a in self.snapshot["assets"] if a["assetClass"] == "equity"))
        for key in ("history", "dividends", "events"):
            del old[key]
        self.assertTrue(ff.validate_asset(old))
        upgraded = ff.upgrade_asset(old)
        self.assertEqual(ff.validate_asset(upgraded), [])
        self.assertEqual((upgraded["history"], upgraded["dividends"], upgraded["events"]["status"]), ([], [], "unavailable"))

        current = copy.deepcopy(next(a for a in self.snapshot["assets"] if a["events"]["status"] == "fresh"))
        carried = ff.carry_over(current, {"lotSize": current["lotSize"], "binanceSymbol": None}, "test")
        self.assertEqual(carried["history"], current["history"])
        self.assertEqual(carried["dividends"], current["dividends"])
        self.assertEqual(carried["events"]["status"], "stale")
        self.assertEqual(ff.validate_asset(carried), [])

    def test_history_and_dividends_render_one_row_per_line(self):
        text = ff.render_snapshot(self.snapshot)
        asset = next(a for a in self.snapshot["assets"] if a["history"])
        first = json.dumps(asset["history"][0], separators=(",", ":"))
        self.assertIn("\n        " + first + ",\n", text)


class MarketRegime(unittest.TestCase):
    """macro.regime: the VIX term structure, its state, fallbacks, validation and briefing line."""

    @staticmethod
    def series(rows):
        """{role: {date: level}} from [date, vix9d, vix, vix3m] rows (None = no close that day)."""
        out = {"short": {}, "mid": {}, "long": {}}
        for day, short, mid, long_ in rows:
            for role, value in (("short", short), ("mid", mid), ("long", long_)):
                if value is not None:
                    out[role][day] = value
        return out

    ROWS = [
        ["2026-11-13", 17.82, 19.30, 20.62],
        ["2026-11-16", 23.15, 22.91, 23.02],
        ["2026-11-17", 26.70, 25.46, 24.98],
        ["2026-11-18", 23.95, 24.56, 24.29],
        ["2026-11-19", 29.26, 28.44, 27.03],
        ["2026-11-20", 40.72, 35.89, 30.94],
    ]

    def block(self, rows=None):
        return ff.regime_block(self.series(rows or self.ROWS))

    def test_the_state_follows_the_published_rules_at_their_boundaries(self):
        self.assertEqual(ff.classify_regime(25.0, 25.0), "stressed")        # VIX ÷ VIX3M exactly 1: inverted
        self.assertEqual(ff.classify_regime(24.99, 25.0), "elevated")       # just below: flat, not inverted
        self.assertEqual(ff.classify_regime(19.0, 20.0), "elevated")        # ratio exactly 0.95: flat curve
        self.assertEqual(ff.classify_regime(18.99, 20.0), "normal")
        self.assertEqual(ff.classify_regime(20.0, 25.0), "elevated")        # VIX exactly 20: elevated level
        self.assertEqual(ff.classify_regime(19.99, 25.0), "normal")
        self.assertEqual(ff.classify_regime(15.0, 20.0, {**ff.REGIME_RULES, "elevatedLevel": 14.0}), "elevated")

    def test_a_block_reports_the_latest_session_and_counts_the_inverted_run(self):
        block = self.block()
        self.assertEqual(ff.validate_regime(block), [])
        self.assertEqual(block["status"], "fresh")
        self.assertEqual(block["asOf"], "2026-11-20")
        self.assertEqual(block["levels"], {"vix9d": 40.72, "vix": 35.89, "vix3m": 30.94})
        self.assertEqual(block["slope"], -4.95)                              # VIX3M − VIX
        self.assertAlmostEqual(block["ratio"], 35.89 / 30.94, places=6)
        self.assertAlmostEqual(block["frontRatio"], 40.72 / 35.89, places=6)
        self.assertEqual(block["state"], "stressed")
        self.assertTrue(block["inverted"])
        self.assertEqual(block["invertedStreak"], 4)                         # 16 Nov was 0.995: the run starts on the 17th
        self.assertEqual(block["history"][-1], ["2026-11-20", 40.72, 35.89, 30.94])
        self.assertEqual(block["rules"], ff.REGIME_RULES)

    def test_vix9d_is_optional_and_vix_with_vix3m_must_share_dates(self):
        rows = [r[:] for r in self.ROWS]
        rows[-1][1] = None                                                   # no VIX9D close on the last day
        block = self.block(rows)
        self.assertEqual(ff.validate_regime(block), [])
        self.assertIsNone(block["levels"]["vix9d"])
        self.assertIsNone(block["frontRatio"])
        self.assertIn("VIX9D", block["note"])
        self.assertEqual(block["state"], "stressed")                         # the state never needed VIX9D
        lonely = self.series(self.ROWS)
        lonely["long"] = {"2026-01-02": 20.0}
        with self.assertRaises(ff.FetchError):
            ff.regime_block(lonely)

    def test_a_normal_day_has_no_streak(self):
        block = self.block([["2026-11-12", 13.1, 14.2, 17.1]])
        self.assertEqual((block["state"], block["inverted"], block["invertedStreak"]), ("normal", False, 0))
        self.assertEqual(ff.validate_regime(block), [])

    def test_todays_value_is_an_intraday_level_until_the_us_close(self):
        index = pd.DatetimeIndex([pd.Timestamp("2026-11-19", tz="America/Chicago"), pd.Timestamp("2026-11-20", tz="America/Chicago")])
        frame = pd.DataFrame({"Close": [28.44, 35.89]}, index=index)
        during = datetime(2026, 11, 20, 20, 0, tzinfo=timezone.utc)          # 15:00 in New York
        after = datetime(2026, 11, 20, 21, 25, tzinfo=timezone.utc)          # 16:25 in New York
        self.assertEqual(ff.regime_closes(frame, during), {"2026-11-19": 28.44})
        self.assertEqual(ff.regime_closes(frame, after), {"2026-11-19": 28.44, "2026-11-20": 35.89})
        odd = pd.DataFrame({"Close": [float("nan"), 0.0]}, index=index)
        self.assertEqual(ff.regime_closes(odd, after), {})

    def test_a_failed_vix9d_costs_only_the_front_of_the_curve_and_a_failed_vix_costs_the_reading(self):
        original = ff.fetch_history
        frame = pd.DataFrame({"Close": [24.56, 28.44]}, index=pd.DatetimeIndex([pd.Timestamp("2026-11-18"), pd.Timestamp("2026-11-19")]))

        def fake(symbol, *_args, **_kwargs):
            if symbol == broken:
                raise ValueError("empty price history")
            return frame

        try:
            ff.fetch_history = fake
            broken = "^VIX9D"
            with self.assertLogs(ff.LOG, level="WARNING"):
                block = ff.fetch_regime(settings(max_retries=1), NOW)
            self.assertEqual(ff.validate_regime(block), [])
            self.assertTrue(all(row[1] is None for row in block["history"]))
            broken = "^VIX"
            with self.assertRaises(ff.FetchError):
                ff.fetch_regime(settings(max_retries=1), NOW)
        finally:
            ff.fetch_history = original

    def test_a_failed_fetch_keeps_a_recent_reading_as_stale_then_gives_up(self):
        def down(*_args):
            raise ff.FetchError("Yahoo is down")

        recent = {"macro": {"regime": self.block()}}                         # asOf 20 Nov
        moment = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)          # 3 days later
        with self.assertLogs(ff.LOG, level="WARNING"):
            kept = ff.build_regime(recent, settings(), moment, fetcher=down)
        self.assertEqual(ff.validate_regime(kept), [])
        self.assertEqual(kept["status"], "stale")
        self.assertEqual(kept["levels"], recent["macro"]["regime"]["levels"])
        self.assertIn("previous reading", kept["note"])
        with self.assertLogs(ff.LOG, level="WARNING"):
            old = ff.build_regime(recent, settings(), moment + timedelta(days=3), fetcher=down)   # 6 days: too old
        self.assertEqual(old["status"], "unavailable")
        self.assertEqual(ff.validate_regime(old), [])
        with self.assertLogs(ff.LOG, level="WARNING"):
            self.assertEqual(ff.build_regime(None, settings(), moment, fetcher=down)["status"], "unavailable")

    def test_an_inconsistent_fetch_is_treated_as_a_failure(self):
        def wrong(*_args):
            block = self.block()
            block["state"] = "normal"
            return block

        with self.assertLogs(ff.LOG, level="WARNING"):
            self.assertEqual(ff.build_regime(None, settings(), NOW, fetcher=wrong)["status"], "unavailable")

    def test_validation_rejects_readings_that_do_not_add_up(self):
        def broken(change):
            block = copy.deepcopy(self.block())
            change(block)
            return ff.validate_regime(block)

        self.assertTrue(broken(lambda b: b.update(state="elevated")))
        self.assertTrue(broken(lambda b: b.update(ratio=0.9)))
        self.assertTrue(broken(lambda b: b.update(slope=4.95)))               # sign: VIX3M − VIX
        self.assertTrue(broken(lambda b: b.update(inverted=False)))
        self.assertTrue(broken(lambda b: b.update(invertedStreak=0)))
        self.assertTrue(broken(lambda b: b["levels"].update(vix=3500.0)))    # basis points, not a level
        self.assertTrue(broken(lambda b: b["history"].append(["2026-11-19", 1.0, 20.0, 20.0])))  # not ascending
        self.assertTrue(broken(lambda b: b["history"].pop()))                # no longer ends with the levels
        self.assertTrue(broken(lambda b: b.update(extra=1)))
        self.assertTrue(broken(lambda b: b.update(symbols={"mid": "^VIX"})))
        empty = ff.empty_regime("down")
        self.assertEqual(ff.validate_regime(empty), [])
        empty["levels"]["vix"] = 20.0
        self.assertTrue(ff.validate_regime(empty))

    def test_macro_validation_accepts_a_snapshot_without_a_regime(self):
        rates = {"USD": ff.risk_free_entry("US 10-year Treasury yield", "^TNX", 0.05, "2026-11-16", "yahoo", "fresh"),
                 "SGD": ff.risk_free_entry("Singapore 10-year SGS benchmark yield", None, 0.023, "2026-11-16", "mas", "fresh")}
        self.assertEqual(ff.validate_macro({"riskFree": rates}), [])         # written before V3.1
        self.assertEqual(ff.validate_macro({"riskFree": rates, "regime": self.block()}), [])
        self.assertTrue(ff.validate_macro({"riskFree": rates, "regime": {"status": "fresh"}}))

    def test_the_history_renders_one_session_per_line(self):
        snapshot = copy.deepcopy(ff.load_json(SNAPSHOT_PATH))
        snapshot["macro"]["regime"] = self.block()
        text = ff.render_snapshot(snapshot)
        self.assertEqual(json.loads(text), snapshot)
        self.assertIn('\n        ["2026-11-20",40.72,35.89,30.94]\n', text)

    def test_ordinals(self):
        self.assertEqual([ff.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111)],
                         ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"])

    def test_the_briefing_line_says_the_state_in_plain_words(self):
        stressed = self.block()
        self.assertEqual(ff.regime_line(stressed),
                         "🔴 Market regime: stressed · VIX curve inverted (VIX 35.9 above VIX3M 30.9), 4th session in a row")
        first = self.block(self.ROWS[:3])                                    # 17 Nov: the first inverted day
        self.assertTrue(ff.regime_line(first).endswith("first inverted session"))
        flat = self.block([["2026-11-16", 23.15, 22.91, 23.02]])
        self.assertEqual(ff.regime_line(flat), "🟡 Market regime: elevated · VIX 22.9, curve flat (VIX3M 23.0)")
        high = self.block([["2026-10-01", 21.0, 22.0, 25.0]])
        self.assertEqual(ff.regime_line(high), "🟡 Market regime: elevated · VIX 22.0, curve in contango (VIX3M 25.0)")
        calm = self.block([["2026-11-12", 13.1, 14.2, 17.1]])
        self.assertEqual(ff.regime_line(calm), "🟢 Market regime: normal · VIX 14.2, curve in contango (VIX3M 17.1)")
        self.assertTrue(ff.regime_line({**calm, "status": "stale"}).endswith("· reading of 12 Nov"))
        self.assertEqual(ff.regime_line(ff.empty_regime("down")), "⚪ Market regime unavailable: the VIX curve could not be read")
        self.assertIsNone(ff.regime_line(None))                              # a snapshot from before V3.1

    def test_the_regime_heads_the_briefing_and_is_escaped_for_markdown(self):
        snapshot = {"generatedAt": "2026-11-21T11:18:28Z", "assets": [], "macro": {"regime": self.block()}}
        signals = [{"ticker": "MU", "name": "Micron", "verdict": "BUY", "composite": 70.0, "confidence": "High"}]
        plain = ff.build_briefing(snapshot, signals, None, "passed", None, NOW, [], ff.BriefingFormat(False)).split("\n")
        self.assertTrue(plain[2].startswith("🔴 Market regime: stressed"))   # title, date, then the regime
        markdown = ff.build_briefing(snapshot, signals, None, "passed", None, NOW, [], ff.BriefingFormat(True)).split("\n")
        self.assertIn(r"\(VIX 35\.9 above VIX3M 30\.9\)", markdown[2])
        held = ff.build_briefing(snapshot, None, None, "failed", "the browser test gate (Gate 2)", NOW, [], ff.BriefingFormat(False))
        self.assertNotIn("Market regime", held)                              # unpublished data is not reported
        refresh_failed = ff.build_briefing(snapshot, signals, None, "failed", "data refresh", NOW, [], ff.BriefingFormat(False))
        self.assertIn("Market regime: stressed", refresh_failed)             # the last good snapshot's regime
        old = {"generatedAt": "2026-11-20T00:00:00Z", "assets": [], "macro": {"riskFree": {}}}
        self.assertNotIn("Market regime", ff.build_briefing(old, signals, None, "passed", None, NOW, [], ff.BriefingFormat(False)))

    def test_the_committed_snapshot_regime_is_consistent_with_its_own_rules(self):
        regime = ff.load_json(SNAPSHOT_PATH)["macro"].get("regime")
        if regime is None:
            self.skipTest("the committed snapshot predates the regime block")
        self.assertEqual(ff.validate_regime(regime), [])
        if regime["status"] != "unavailable":
            self.assertGreater(len(regime["history"]), 1000)                 # five years, not one


class MacroCalendar(unittest.TestCase):
    """scripts/macro_calendar.json and the macro.calendar block (V3.2)."""

    @classmethod
    def setUpClass(cls):
        cls.calendar = ff.load_json(ff.DEFAULT_CALENDAR)

    def mutated(self, change):
        calendar = copy.deepcopy(self.calendar)
        change(calendar)
        return ff.validate_macro_calendar(calendar)

    def event(self, kind):
        return next(event for event in self.calendar["events"] if event["type"] == kind)

    def test_the_committed_calendar_is_valid_and_spans_both_offsets(self):
        self.assertEqual(ff.validate_macro_calendar(self.calendar), [])
        offsets = {event["at"][-6:] for event in self.calendar["events"] if "at" in event}
        self.assertEqual(offsets, {"-05:00", "-04:00"})                       # winter and summer time both present
        kinds = {event["type"] for event in self.calendar["events"]}
        self.assertTrue({"fomc-decision", "fomc-minutes", "cpi", "market-holiday", "fomc-meeting"} <= kinds)

    def test_every_time_carries_new_yorks_offset_for_that_day(self):
        self.assertEqual(ff.new_york_offset("2027-03-13", "08:30"), "-05:00")   # the Saturday before the clocks change
        self.assertEqual(ff.new_york_offset("2027-03-15", "08:30"), "-04:00")
        self.assertEqual(ff.new_york_offset("2027-11-08", "14:00"), "-05:00")
        bad = dict(self.event("cpi"), date="2027-04-13", at="2027-04-13T08:30:00-05:00", period="2027-03")
        self.assertTrue(any("08:30:00-04:00" in error for error in ff.validate_calendar_event(bad, "e")))
        late = dict(self.event("cpi"), at=self.event("cpi")["at"].replace("08:30", "09:00"))
        self.assertTrue(ff.validate_calendar_event(late, "e"))               # CPI is always 08:30

    def test_fomc_rules(self):
        decision = self.event("fomc-decision")
        self.assertEqual(ff.meeting_days("2026-12-08/09"), (date(2026, 12, 8), date(2026, 12, 9)))
        self.assertEqual(ff.meeting_days("2027-04-30/01"), (date(2027, 4, 30), date(2027, 5, 1)))  # across a month end
        self.assertIsNone(ff.meeting_days("2026-12-08/10"))
        wrong_day = dict(decision, date="2026-12-08", at="2026-12-08T14:00:00-05:00")
        self.assertTrue(any("second day" in error for error in ff.validate_calendar_event(wrong_day, "e")))
        self.assertTrue(ff.validate_calendar_event(dict(decision, projections=False), "e"))
        no_decision = {"type": "fomc-meeting", "date": "2027-10-27", "meeting": "2027-10-26/27", "decision": True}
        self.assertTrue(ff.validate_calendar_event(no_decision, "e"))
        strategy = [event for event in self.calendar["events"] if event["type"] == "fomc-meeting"]
        self.assertEqual([event["date"] for event in strategy], ["2027-10-27"])   # no decision at the strategy meeting
        self.assertNotIn("at", strategy[0])

    def test_derived_minutes_are_three_weeks_after_the_decision(self):
        def shift(calendar):
            minutes = next(event for event in calendar["events"] if event["type"] == "fomc-minutes" and event.get("derived"))
            minutes["date"] = "2027-02-18"
            minutes["at"] = "2027-02-18T14:00:00-05:00"
        self.assertTrue(any("21 days" in error for error in self.mutated(shift)))

    def test_structure_order_and_duplicates(self):
        self.assertTrue(self.mutated(lambda c: c["events"].reverse()))
        self.assertTrue(self.mutated(lambda c: c["events"].append(copy.deepcopy(c["events"][-1]))))
        self.assertTrue(self.mutated(lambda c: c["events"][0].update(type="nfp")))
        self.assertTrue(self.mutated(lambda c: c["events"][0].update(extra=1)))
        self.assertTrue(self.mutated(lambda c: c.update(extra=1)))
        self.assertTrue(self.mutated(lambda c: c["sources"].update(fomc="http://insecure.example")))
        weekend = {"type": "market-holiday", "date": "2027-05-01", "market": "SG", "name": "Labour Day"}
        self.assertTrue(any("weekend" in error for error in ff.validate_calendar_event(weekend, "e")))
        old_period = dict(self.event("cpi"), period=self.event("cpi")["date"][:7])
        self.assertTrue(ff.validate_calendar_event(old_period, "e"))          # CPI reports an earlier month

    def test_coverage_is_judged_against_the_files_own_date_not_today(self):
        self.assertTrue(any("60 days" in error for error in self.mutated(lambda c: c.update(updated="2027-11-15"))))
        self.assertEqual(self.mutated(lambda c: c.update(updated="2026-01-15")), [])
        outside = self.mutated(lambda c: c["coverage"].update(to="2027-06-30"))
        self.assertTrue(any("outside the coverage" in error for error in outside))

    def test_the_snapshot_block_keeps_the_last_30_days_and_warns_when_the_calendar_runs_out(self):
        now = datetime(2026, 12, 15, 22, 30, tzinfo=timezone.utc)
        block = ff.build_calendar(ff.DEFAULT_CALENDAR, now)
        self.assertEqual(ff.validate_calendar_block(block), [])
        self.assertEqual(block["status"], "fresh")
        self.assertEqual(block["events"][0]["date"], "2026-11-18")           # 27 days back; 10 Nov is older than 30
        self.assertIsNone(block["note"])
        late = datetime(2027, 11, 15, 22, 30, tzinfo=timezone.utc)
        with self.assertLogs(ff.LOG, level="WARNING"):
            ending = ff.build_calendar(ff.DEFAULT_CALENDAR, late)
        self.assertIn("runs out on 2027-12-31", ending["note"])
        self.assertIn("NEEDS UPDATING", ff.calendar_summary(ending, late))
        self.assertEqual(ff.calendar_summary(block, now), "next FOMC 2027-01-27 · CPI 2027-01-13 (covers to 2027-12-31)")

    def test_a_broken_file_never_fails_the_run(self):
        now = datetime(2026, 11, 22, 22, 30, tzinfo=timezone.utc)
        with self.assertLogs(ff.LOG, level="WARNING"):
            missing = ff.build_calendar(Path("no/such/macro_calendar.json"), now)
        self.assertEqual(missing["status"], "unavailable")
        self.assertEqual(ff.validate_calendar_block(missing), [])
        broken = copy.deepcopy(self.calendar)
        broken["events"][0]["date"] = "not a date"
        target = Path(self.id().replace(".", "_") + ".json")
        try:
            target.write_text(json.dumps(broken), encoding="utf-8")
            with self.assertLogs(ff.LOG, level="WARNING"):
                self.assertEqual(ff.build_calendar(target, now)["status"], "unavailable")
        finally:
            target.unlink(missing_ok=True)

    def test_macro_validation_accepts_a_snapshot_without_a_calendar_and_rejects_a_bad_one(self):
        rates = {"USD": ff.risk_free_entry("US 10-year Treasury yield", "^TNX", 0.05, "2026-11-16", "yahoo", "fresh"),
                 "SGD": ff.risk_free_entry("Singapore 10-year SGS benchmark yield", None, 0.023, "2026-11-16", "mas", "fresh")}
        self.assertEqual(ff.validate_macro({"riskFree": rates}), [])
        good = ff.build_calendar(ff.DEFAULT_CALENDAR, datetime(2026, 11, 22, tzinfo=timezone.utc))
        self.assertEqual(ff.validate_macro({"riskFree": rates, "calendar": good}), [])
        bad = copy.deepcopy(good)
        bad["events"][0]["date"] = "2030-01-01"
        self.assertTrue(ff.validate_macro({"riskFree": rates, "calendar": bad}))

    def test_events_render_one_per_line(self):
        snapshot = copy.deepcopy(ff.load_json(SNAPSHOT_PATH))
        snapshot["macro"]["calendar"] = ff.build_calendar(ff.DEFAULT_CALENDAR, datetime(2026, 11, 22, tzinfo=timezone.utc))
        text = ff.render_snapshot(snapshot)
        self.assertEqual(json.loads(text), snapshot)
        self.assertIn('\n        {"type":"fomc-decision","date":"2026-12-09","at":"2026-12-09T14:00:00-05:00","meeting":"2026-12-08/09","projections":true},\n', text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
