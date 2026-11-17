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
import sys
import time
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
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
        self.assertEqual(ff.stable_seed("AAPL"), ff.stable_seed("AAPL"))
        self.assertNotEqual(ff.stable_seed("AAPL"), ff.stable_seed("NVDA"))
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
        self.assertEqual(self.snapshot["schemaVersion"], 2)

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
        old = copy.deepcopy(self.snapshot["assets"][0])
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
