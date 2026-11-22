#!/usr/bin/env python3
"""QuantLens market-data pipeline (snapshot schema v3).

Reads ``scripts/watchlist.json`` and writes ``data/market_snapshot.json`` with,
for every asset (stocks, REITs, ETFs, indices and crypto):

* five years of daily prices from one adjusted request: full OHLCV candles for
  the most recent year, closes only for the four years before it, and every
  dividend paid in those five years,
* fundamentals (Yahoo Finance via ``yfinance``),
* for stocks, an event calendar: the next earnings and ex-dividend dates and
  the past earnings dates, each with its timing against the exchange's session,
* the three most recent *unique* news stories with a sentiment score
  (Yahoo Finance RSS, de-duplicated with ``difflib``, scored with VADER),
* a 30-calendar-day price projection with an 80% band and a backtest of how
  the same model did over the previous 30 days (Prophet on ``log(close)``,
  weekly seasonality only, fitted by optimisation),

plus four macro inputs: the US and Singapore 10-year government yields, used as
risk-free rates; five years of daily USD/SGD closes; the market regime, read
from the VIX term structure (^VIX9D, ^VIX, ^VIX3M) with five years of history;
and the macro calendar (FOMC decisions and minutes, US CPI releases, NYSE and
SGX holidays), kept by hand in scripts/macro_calendar.json and validated here.

With ``--notify`` it instead sends a short daily briefing about the snapshot to
Telegram to one chat or several: risk first (the market regime, then a ⚡ block
that appears only when something happened: moves beyond 2.5σ, a VIX inversion
starting or ending, earnings within 5 trading days, FOMC or CPI within 48 hours,
headline tone shifts), tradable assets in three buckets, the next 30 days, and a
one-line status. Saturday and Sunday runs get a week-ahead edition instead.
TELEGRAM_CHAT_ID may hold comma-separated ids. It never fails: missing
credentials skip it silently, and an unreachable API is a warning.

Design rules
------------
* **Polite.** A randomised pause separates tickers, every request has a timeout,
  every ticker has a hard deadline, the whole run has a time budget, and
  repeated rate-limit responses open a circuit breaker instead of hammering.
* **Never NaN.** Every number is sanitised; the JSON encoder runs with
  ``allow_nan=False`` as a backstop.
* **Fail small.** News, forecast and macro data each fail on their own and can
  never cost an asset its prices. A ticker that cannot be fetched keeps its
  previous entry, marked ``stale``.
* **Fail safe.** The snapshot is validated before it is written. If validation
  fails, or more than half of the watchlist is not fresh, nothing is written and
  the exit code is 1, so the site keeps serving the previous file.

Units
-----
* ``marketCap`` and ``enterpriseValue`` are in the trading ``currency``.
* Statement items are in ``financialCurrency``.
* Ratios and yields are decimals (0.0514 means 5.14 %).
* Candles and history are split- and dividend-adjusted, completed sessions only,
  and come from the same request, so they join without a step.
* Timestamps are ISO-8601 UTC (``2026-11-17T22:31:04Z``).

Usage
-----
    pip install -r scripts/requirements.txt
    python scripts/fetch_fundamentals.py
    python scripts/fetch_fundamentals.py --validate-only
    python scripts/fetch_fundamentals.py --notify --previous old_snapshot.json
"""

from __future__ import annotations

import argparse
import difflib
import email.utils
import html
import http.cookiejar
import importlib.util
import json
import logging
import math
import multiprocessing
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import xml.etree.ElementTree as ElementTree
import zlib
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import pandas as pd
import yfinance as yf

try:  # Sentiment is optional at import time so the script still runs without it.
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
except ImportError:  # pragma: no cover - exercised only when the package is missing
    SentimentIntensityAnalyzer = None

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WATCHLIST = REPO_ROOT / "scripts" / "watchlist.json"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "market_snapshot.json"
DEFAULT_CALENDAR = REPO_ROOT / "scripts" / "macro_calendar.json"

SCHEMA_VERSION = 3
CANDLE_FIELDS = ["date", "open", "high", "low", "close", "volume"]
HISTORY_FIELDS = ["date", "close"]
FORECAST_FIELDS = ["date", "yhat", "lower", "upper"]
MIN_CANDLES = 200
CANDLE_WINDOW_DAYS = 365      # the most recent year keeps full OHLCV; older sessions keep the close only
FX_HISTORY_PERIOD = "5y"      # USD/SGD closes, as long as the asset history
HISTORY_MAX_ROWS = 2000       # five years of daily crypto closes is about 1,460 rows
SPLICE_MAX_GAP_DAYS = 10      # the last history row and the first candle are at most this far apart
DIVIDEND_MAX_ROWS = 300

FUNDAMENTAL_KEYS = [
    "marketCap", "enterpriseValue",
    "ebit", "ebitda", "operatingIncome",
    "totalRevenue", "netIncome", "freeCashFlow",
    "totalDebt", "totalCash", "totalEquity", "totalAssets",
    "trailingPE", "forwardPE", "priceToBook",
    "returnOnEquity", "dividendYieldTTM",
]
ASSET_KEYS = [
    "ticker", "name", "assetClass", "market", "currency", "financialCurrency",
    "sector", "industry", "scoringProfile", "lotSize", "binanceSymbol",
    "status", "statusNote", "fundamentalsPeriod", "quote", "fundamentals", "candles",
    "history", "dividends", "news", "forecast", "events",
]
NEWS_KEYS = ["status", "fetchedAt", "headlineCount", "clusterCount", "newestAt", "sentiment", "clusters", "note"]
CLUSTER_KEYS = ["title", "link", "publishedAt", "firstSeenAt", "duplicates", "scores", "label"]
FORECAST_KEYS = ["status", "model", "modelVersion", "config", "trainedOn", "horizon", "backtest", "points", "note"]
RISK_FREE_KEYS = ["name", "symbol", "yield", "asOf", "source", "status"]
REGIME_KEYS = ["status", "asOf", "source", "symbols", "levels", "slope", "ratio", "frontRatio", "state",
               "inverted", "invertedStreak", "rules", "historyFields", "history", "note"]
EVENTS_KEYS = ["status", "fetchedAt", "nextEarnings", "nextExDividend", "earnings", "note"]
EARNINGS_TIMINGS = {"before-open", "during-session", "after-close", "unknown"}

ASSET_CLASSES = {"equity", "crypto", "etf", "index"}
MARKETS = {"US", "SG", "UK", "CRYPTO"}
# V3.3: the trend regimes of trendRegimeEngine.js, in the order the briefing counts them.
TREND_REGIMES = ("Uptrend", "Extended", "Pullback", "Recovering", "Downtrend")
PROFILES = {"CORPORATE", "FINANCIAL", "REIT", "CRYPTO", "ETF", "INDEX"}
EQUITY_PROFILES = {"CORPORATE", "FINANCIAL", "REIT"}
# Asset classes with no company accounts of their own. Each has a fixed profile with
# no fundamental score, and no financial statements are requested for them.
CLASS_PROFILES = {"crypto": "CRYPTO", "etf": "ETF", "index": "INDEX"}
STATUSES = {"fresh", "stale"}
SECTION_STATUSES = {"fresh", "stale", "unavailable"}
RISK_FREE_STATUSES = {"fresh", "stale", "proxy", "unavailable"}
SENTIMENT_LABELS = {"positive", "neutral", "negative"}

# Local session close per market. A candle dated "today" is only kept once the
# session has closed (plus a buffer for Yahoo's delayed quotes).
SESSION_CLOSE = {"US": dtime(16, 0), "SG": dtime(17, 0), "UK": dtime(16, 30)}
SESSION_OPEN = {"US": dtime(9, 30), "SG": dtime(9, 0), "UK": dtime(8, 0)}
# Half days (the macro calendar's market-early-close entries): 1:00 p.m. New York on US half
# days; 12:00 noon Singapore on SGX half days, the eves of Chinese New Year, Christmas and New
# Year when they fall on a trading day (V3.4). The usual buffer applies after either close.
EARLY_CLOSE = {"US": dtime(13, 0), "SG": dtime(12, 0)}
MARKET_TIMEZONES = {"US": "America/New_York", "SG": "Asia/Singapore", "UK": "Europe/London"}
CLOSE_BUFFER_MINUTES = 20

SECTOR_PROFILES = {"Financial Services": "FINANCIAL", "Real Estate": "REIT"}

# Yahoo's Price-to-Book is replaced by market cap / book equity when the two differ by
# more than this factor (it has reported Berkshire Hathaway B at 0.001).
PRICE_TO_BOOK_TOLERANCE = 2.0

INCOME_ROWS = {
    "totalRevenue": ["Total Revenue", "Operating Revenue"],
    "operatingIncome": ["Operating Income", "Total Operating Income As Reported"],
    "ebit": ["EBIT"],
    "ebitda": ["EBITDA", "Normalized EBITDA"],
    "netIncome": ["Net Income Common Stockholders", "Net Income"],
}
CASHFLOW_ROWS = ["Free Cash Flow"]
BALANCE_ROWS = {
    "totalDebt": ["Total Debt"],
    "totalCash": ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"],
    "totalEquity": ["Stockholders Equity", "Common Stock Equity"],
    "totalAssets": ["Total Assets"],
}

# --- News and sentiment --------------------------------------------------------
NEWS_FEED_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
NEWS_MAX_HEADLINES = 15          # most recent headlines considered per ticker
NEWS_SCORED_CLUSTERS = 3         # unique stories that are scored and stored
NEWS_SIMILARITY = 0.85           # difflib ratio at or above which two titles are the same story
NEWS_WINDOW = timedelta(hours=24)  # ...provided they are less than this far apart
NEWS_STALE_AFTER = timedelta(days=7)
NEWS_MAX_BYTES = 2_000_000
NEWS_TITLE_LIMIT = 300
SENTIMENT_THRESHOLD = 0.05       # VADER's conventional cut-off for positive / negative

# --- Events (stocks only) ------------------------------------------------------------
EARNINGS_LOOKUP = 24             # earnings dates requested: about six years of quarterly reports
EVENTS_MAX_PAST = 30             # past earnings dates stored per asset
EARNINGS_CLUSTER_DAYS = 7        # candidate dates this close together are one event with an uncertain day
YAHOO_EVENT_TIMEZONE = "America/New_York"  # Yahoo stamps earnings in New York time, whatever the exchange

# --- Forecast --------------------------------------------------------------------
FORECAST_HORIZON_DAYS = 30           # calendar days projected, for every asset class
FORECAST_HOLDOUT_DAYS = 30           # calendar days hidden from the model for its backtest
FORECAST_INTERVAL = 0.8              # width of the projected band
FORECAST_UNCERTAINTY_SAMPLES = 300   # simulated trend paths behind the band (default is 1000)
# Share of the history in which the trend may change slope. This is Prophet's default.
# A holdout comparison of 0.8, 0.9 and 0.95 over three separate 30-day windows and twelve
# assets found no setting that wins consistently, and 0.8 marginally best on average, so
# there is no evidence for a custom value.
FORECAST_CHANGEPOINT_RANGE = 0.8
FORECAST_MIN_TRAIN = 120             # candles the backtest model must have left to learn from
FORECAST_MIN_HOLDOUT = 5

# --- Macro -----------------------------------------------------------------------
US_10Y_SYMBOL = "^TNX"
MAS_YIELD_URL = "https://eservices.mas.gov.sg/statistics/fdanet/BenchmarkPricesAndYields.aspx"
MAS_FIELD_PREFIX = "ctl00$ContentPlaceHolder1$"
MAS_STALE_LIMIT_DAYS = 10        # an older MAS value is replaced by the US proxy
YIELD_BOUNDS = (-0.02, 0.25)

# Market regime: the VIX term structure. VIX is the market's 30-day implied volatility of the
# S&P 500; VIX9D the 9-day and VIX3M the 3-month equivalent. Normally the curve slopes up
# (contango: more time, more uncertainty). When the 30-day level rises above the 3-month one
# the curve is inverted: traders pay more for protection now than later, a sign of stress.
REGIME_SYMBOLS = {"short": "^VIX9D", "mid": "^VIX", "long": "^VIX3M"}
REGIME_LEVEL_KEYS = ["vix9d", "vix", "vix3m"]
REGIME_HISTORY_FIELDS = ["date", "vix9d", "vix", "vix3m"]
REGIME_STATES = {"normal", "elevated", "stressed"}
REGIME_RULES = {
    "elevatedLevel": 20.0,   # VIX at or above this is elevated (its five-year median is about 18)
    "elevatedRatio": 0.95,   # VIX ÷ VIX3M at or above this is a flat curve
    "invertedRatio": 1.0,    # VIX ÷ VIX3M at or above this is an inverted curve: stressed
}
REGIME_HISTORY_PERIOD = "5y"
REGIME_HISTORY_MAX_ROWS = 1400   # five years of sessions is about 1,255
REGIME_STALE_LIMIT_DAYS = 5      # an older reading is not carried over
REGIME_LEVEL_BOUNDS = (1.0, 200.0)

# Macro calendar (V3.2): FOMC decisions and minutes, US CPI releases and market holidays, kept by
# hand in scripts/macro_calendar.json and copied into macro.calendar on every run.
CALENDAR_TYPES = {
    # type: (required keys beyond type/date, optional keys, New York time of `at` or None)
    "fomc-decision": ({"at", "meeting"}, {"projections"}, "14:00"),
    "fomc-meeting": ({"meeting", "decision"}, set(), None),
    "fomc-minutes": ({"at", "meeting"}, {"derived"}, "14:00"),
    "cpi": ({"at", "period"}, set(), "08:30"),
    "market-holiday": ({"market", "name"}, set(), None),
    # Its time depends on the market: see EARLY_CLOSE and early_close_at.
    "market-early-close": ({"at", "market", "name"}, set(), None),
}
CALENDAR_MARKETS = {"US", "SG"}
CALENDAR_FILE_KEYS = ["updated", "coverage", "sources", "notes", "events"]
CALENDAR_BLOCK_KEYS = ["status", "updated", "coverage", "events", "note"]
CALENDAR_LOOKBACK_DAYS = 30      # recent past events stay in the snapshot, for "since" context
CALENDAR_WARN_DAYS = 60          # warn when the calendar runs out sooner than this
CALENDAR_MINUTES_LAG = 21        # the Fed releases minutes three weeks after the decision
MEETING_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})/(\d{2})$")
PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MONTHS = {name: number for number, name in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}

USER_AGENT = "Mozilla/5.0 (compatible; quantlens-data-pipeline)"

# --- Daily briefing (Telegram) ---------------------------------------------------------
TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"
TELEGRAM_TIMEOUT = 10.0
TELEGRAM_MAX_CHARS = 3800        # Telegram's hard limit is 4096 characters
BRIEFING_MAX_SHIFTS = 5
BRIEFING_EARNINGS_DAYS = 30      # list earnings releases this many calendar days ahead
BRIEFING_MAX_EARNINGS = 5
SENTIMENT_SHIFT_MIN = 0.25       # a move in headline tone at least this large is notable
# V3.2 briefing: risk first, bucketed, signal only.
BRIEFING_MOVE_SIGMA = 2.5        # a session move beyond this many EWMA σ is a trigger
BRIEFING_MOVER_SIGMA = 1.5       # ...and beyond this, a notable mover in its bucket
BRIEFING_EARNINGS_TRIGGER = 5    # earnings within this many trading days are a trigger
BRIEFING_MACRO_HOURS = 48        # FOMC decisions and CPI releases within this many hours are a trigger
BRIEFING_MAX_MOVES = 5
BRIEFING_MAX_TONE = 3
BRIEFING_BUCKET_SIGNALS = 3      # tickers on each bucket's Uptrend and Downtrend lines
BRIEFING_BUCKET_MOVERS = 2
BRIEFING_WEEK_DAYS = 7
BRIEFING_MAX_EX_DIVIDENDS = 6
BRIEFING_BUCKETS = (("global", "US / Global", "S&P 500"), ("sgx", "SGX", "STI"), ("crypto", "Crypto (24/7)", "BTC"))
MARKET_MOVING = {"fomc-decision", "cpi"}
WEEKDAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
WEEKDAY_FULL = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
               "October", "November", "December")
SIGNALS_SCRIPT = REPO_ROOT / "scripts" / "signals.mjs"
# A Telegram chat id: a user or group number (groups and channels are negative), or a public @channel.
CHAT_ID_RE = re.compile(r"^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$")
SIGNALS_TIMEOUT = 60.0
# The refresh job's steps, in order, with the environment variable carrying each outcome.
PIPELINE_STEPS = (
    ("QUANTLENS_FETCH", "data refresh"),
    ("QUANTLENS_VALIDATE", "schema validation"),
    ("QUANTLENS_GATE1", "Gate 1 (pipeline unit tests)"),
    ("QUANTLENS_GATE2", "Gate 2 (browser tests)"),
    ("QUANTLENS_COMMIT", "commit"),
)

# Yahoo symbols: AAPL, BRK-B, D05.SI, CSPX.L, BTC-USD, and indices with a leading caret (^GSPC).
TICKER_RE = re.compile(r"^\^?[A-Z0-9][A-Z0-9.\-=]{0,14}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

LOG = logging.getLogger("quantlens.fetch")
IN_GITHUB_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"


class FetchError(RuntimeError):
    """Raised when a data source keeps failing after all retries."""

    def __init__(self, message: str, rate_limited: bool = False) -> None:
        super().__init__(message)
        self.rate_limited = rate_limited


# --------------------------------------------------------------------------- #
# Logging helpers
# --------------------------------------------------------------------------- #

def warn(message: str) -> None:
    LOG.warning(message)
    if IN_GITHUB_ACTIONS:
        print(f"::warning::{message}", flush=True)


def fail(message: str) -> None:
    LOG.error(message)
    if IN_GITHUB_ACTIONS:
        print(f"::error::{message}", flush=True)


# --------------------------------------------------------------------------- #
# Number and time sanitisation
# --------------------------------------------------------------------------- #

def clean_number(value: Any, digits: int | None = None) -> float | int | None:
    """Return a finite number or ``None``. Never NaN, never Infinity."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    if digits is not None:
        number = round(number, digits)
    if number == 0:
        return 0  # normalises -0.0
    if number.is_integer() and abs(number) >= 1000:
        return int(number)
    return number


def round_price(value: float) -> float:
    """Round a price to a precision that suits its magnitude."""
    magnitude = abs(value)
    if magnitude >= 1000:
        return round(value, 2)
    if magnitude >= 1:
        return round(value, 4)
    return round(value, 8)


def first_not_none(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def iso_timestamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Retry, deadlines and rate limits
# --------------------------------------------------------------------------- #

def is_rate_limit(error: BaseException) -> bool:
    """True when an exception looks like "you are sending too many requests"."""
    if isinstance(error, urllib.error.HTTPError) and error.code == 429:
        return True
    text = f"{type(error).__name__} {error}".lower()
    return "ratelimit" in text or "too many requests" in text or "rate limit" in text or " 429" in text


def with_retry(label: str, fn: Callable[[], Any], attempts: int, base_delay: float,
               deadline: float | None = None) -> Any:
    """Run ``fn`` with exponential backoff (x3 per attempt) and jitter.

    ``deadline`` is a ``time.monotonic()`` value. A retry that could not finish
    before it is not started, so a slow source cannot eat a whole ticker budget.
    """
    last_error: Exception | None = None
    rate_limited = False
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - yfinance raises many types
            last_error = exc
            rate_limited = rate_limited or is_rate_limit(exc)
            if attempt == attempts:
                break
            delay = base_delay * (3 ** (attempt - 1)) + random.uniform(0, base_delay)
            if rate_limited:
                delay *= 2
            if deadline is not None and time.monotonic() + delay >= deadline:
                break
            LOG.warning("%s failed (attempt %d/%d): %s. Retrying in %.1fs",
                        label, attempt, attempts, exc, delay)
            time.sleep(delay)
    raise FetchError(f"{label} failed: {last_error}", rate_limited=rate_limited) from last_error


def run_with_deadline(label: str, fn: Callable[[], Any], seconds: float) -> Any:
    """Run ``fn`` in a worker thread and give up after ``seconds``.

    Python cannot kill a thread, so an overrunning call is abandoned rather than
    stopped: it is a daemon thread and every network call inside it has its own
    timeout, so it ends on its own shortly afterwards.
    """
    outcome: dict[str, Any] = {}

    def target() -> None:
        try:
            outcome["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised in the caller's thread
            outcome["error"] = exc

    worker = threading.Thread(target=target, name=f"fetch-{label}", daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise FetchError(f"{label} exceeded its {seconds:.0f}s deadline")
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


def http_get(url: str, timeout: float, max_bytes: int = NEWS_MAX_BYTES, opener: Any = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    open_url = opener.open if opener is not None else urllib.request.urlopen
    with open_url(request, timeout=timeout) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError(f"response is larger than {max_bytes} bytes")
    return data


# --------------------------------------------------------------------------- #
# Candles
# --------------------------------------------------------------------------- #

def fetch_history(symbol: str, period: str, interval: str, timeout: float = 10) -> pd.DataFrame:
    frame = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=True,
                                      actions=True, timeout=timeout)
    if frame is None or frame.empty:
        raise ValueError(f"empty price history for {symbol}")
    missing = [c for c in ("Open", "High", "Low", "Close", "Volume") if c not in frame.columns]
    if missing:
        raise ValueError(f"price history for {symbol} lacks columns {missing}")
    return frame


def session_close(market: str, day: str, early_closes: frozenset[str] = frozenset()) -> dtime:
    """When the market's session ends on a local date: its half-day close (1:00 p.m. New York, 12:00
    noon Singapore) when the date is one of that market's half days, the usual close otherwise.
    `early_closes` holds the half days of this market only."""
    if day in early_closes and market in EARLY_CLOSE:
        return EARLY_CLOSE[market]
    return SESSION_CLOSE.get(market, dtime(23, 59))


def early_close_at(market: str, day: str) -> str:
    """The `at` stamp of a half day: 13:00 New York with its UTC offset, or 12:00 Singapore (+08:00)."""
    clock = EARLY_CLOSE[market].strftime("%H:%M")
    offset = new_york_offset(day, clock) if market == "US" else "+08:00"
    return f"{day}T{clock}:00{offset}"


def early_close_dates(calendar: Any, market: str = "US") -> frozenset[str]:
    """The half days of a market listed in the macro calendar block (empty if it is unavailable)."""
    if not isinstance(calendar, dict) or calendar.get("status") != "fresh":
        return frozenset()
    return frozenset(event["date"] for event in calendar.get("events", [])
                     if isinstance(event, dict) and event.get("type") == "market-early-close" and event.get("market") == market)


def build_candles(history: pd.DataFrame, market: str, now_utc: datetime, early_closes: frozenset[str] = frozenset()) -> list[list[Any]]:
    """Convert a yfinance history frame to ``[date, o, h, l, c, v]`` rows.

    Drops rows with missing or non-positive prices, repairs high/low so that
    ``high >= max(open, close)`` and ``low <= min(open, close)``, removes
    duplicate dates, and removes the in-progress session.
    """
    by_date: dict[str, list[Any]] = {}
    repaired = 0
    dropped = 0
    for stamp, row in history.iterrows():
        prices = [clean_number(row[c]) for c in ("Open", "High", "Low", "Close")]
        if any(p is None or p <= 0 for p in prices):
            dropped += 1
            continue
        open_, high, low, close = (round_price(float(p)) for p in prices)
        true_high = max(open_, high, low, close)
        true_low = min(open_, high, low, close)
        if true_high != high or true_low != low:
            repaired += 1
        volume = clean_number(row["Volume"])
        volume = int(volume) if volume is not None and volume > 0 else 0
        by_date[stamp.strftime("%Y-%m-%d")] = [stamp.strftime("%Y-%m-%d"), open_, true_high, true_low, close, volume]

    candles = [by_date[d] for d in sorted(by_date)]
    if repaired:
        LOG.info("  repaired high/low on %d candle(s)", repaired)
    if dropped:
        LOG.info("  dropped %d candle(s) with missing prices", dropped)
    if not candles:
        return candles

    tz = history.index.tz
    local_now = now_utc.astimezone(tz) if tz is not None else now_utc
    today_local = local_now.strftime("%Y-%m-%d")
    if market == "CRYPTO":
        # Crypto never closes: the candle for the current UTC day is always partial.
        today_utc = now_utc.strftime("%Y-%m-%d")
        candles = [c for c in candles if c[0] < today_utc]
    elif candles[-1][0] == today_local:
        close_at = session_close(market, today_local, early_closes)
        cutoff_minutes = close_at.hour * 60 + close_at.minute + CLOSE_BUFFER_MINUTES
        now_minutes = local_now.hour * 60 + local_now.minute
        if now_minutes < cutoff_minutes:
            LOG.info("  dropped in-progress session %s", today_local)
            candles = candles[:-1]
    return candles


def split_history(rows: list[list[Any]]) -> tuple[list[list[Any]], list[list[Any]]]:
    """Split five years of completed sessions into recent candles and older closes.

    The most recent CANDLE_WINDOW_DAYS keep full ``[date, o, h, l, c, v]`` rows;
    everything before keeps ``[date, close]``. Both halves come from the same
    adjusted request, so the series is continuous across the join.
    """
    if not rows:
        return [], []
    cutoff = (date.fromisoformat(rows[-1][0]) - timedelta(days=CANDLE_WINDOW_DAYS)).isoformat()
    candles = [row for row in rows if row[0] > cutoff]
    history = [[row[0], row[4]] for row in rows if row[0] <= cutoff][-HISTORY_MAX_ROWS:]
    return candles, history


def dividend_rows(history: pd.DataFrame, last_date: str | None = None) -> list[list[Any]]:
    """Every dividend in the price history as ``[ex-date, amount per share]``, oldest first."""
    if "Dividends" not in history.columns:
        return []
    by_date: dict[str, float | int] = {}
    for stamp, amount in history["Dividends"].items():
        value = clean_number(amount, digits=6)
        day = stamp.strftime("%Y-%m-%d")
        if value is not None and value > 0 and (last_date is None or day <= last_date):
            by_date[day] = value
    return [[day, by_date[day]] for day in sorted(by_date)][-DIVIDEND_MAX_ROWS:]


def trailing_dividend_yield(history: pd.DataFrame, last_close: float) -> float | int | None:
    """Dividends paid over the trailing 365 days divided by the latest close."""
    if "Dividends" not in history.columns or last_close <= 0:
        return None
    dividends = history["Dividends"]
    cutoff = history.index[-1] - pd.Timedelta(days=365)
    total = clean_number(dividends[dividends.index > cutoff].sum())
    if total is None or total < 0:
        return None
    return clean_number(total / last_close, digits=6)


# --------------------------------------------------------------------------- #
# Financial statements
# --------------------------------------------------------------------------- #

def statement_columns(frame: pd.DataFrame | None) -> list[pd.Timestamp]:
    if frame is None or frame.empty:
        return []
    return sorted((c for c in frame.columns if isinstance(c, pd.Timestamp)), reverse=True)


def cell(frame: pd.DataFrame, row: str, column: pd.Timestamp) -> float | int | None:
    if row not in frame.index:
        return None
    value = frame.loc[row, column]
    if isinstance(value, pd.Series):  # duplicated row label
        value = value.iloc[0]
    return clean_number(value)


def trailing_columns(frame: pd.DataFrame | None) -> list[pd.Timestamp] | None:
    """Columns that together cover the trailing twelve months, or ``None``.

    Handles quarterly reporters (4 contiguous quarters) and semi-annual
    reporters (2 contiguous halves). Returns ``None`` when periods are missing,
    so that a gap can never be silently summed into a wrong TTM figure.
    """
    columns = statement_columns(frame)
    if len(columns) < 2:
        return None
    gaps = [(newer - older).days for newer, older in zip(columns, columns[1:])][:4]
    gap = gaps[0]
    if 80 <= gap <= 100:
        needed, low, high = 4, 80, 100
    elif 170 <= gap <= 195:
        # A six-month gap means a semi-annual reporter ONLY if the company never
        # reports quarterly. If any nearby gap is a quarter, this is a quarterly
        # reporter with one period missing, and two quarters must not pass as a year.
        if any(80 <= other <= 100 for other in gaps):
            return None
        needed, low, high = 2, 170, 195
    else:
        return None
    window = columns[:needed]
    if len(window) < needed:
        return None
    for newer, older in zip(window, window[1:]):
        if not low <= (newer - older).days <= high:
            return None
    return window


def sum_over(frame: pd.DataFrame, row_names: list[str], columns: list[pd.Timestamp]) -> float | int | None:
    for row in row_names:
        values = [cell(frame, row, column) for column in columns]
        if values and all(v is not None for v in values):
            return clean_number(sum(values))
    return None


def income_items(quarterly: pd.DataFrame | None, annual: pd.DataFrame | None) -> tuple[dict[str, Any], str | None]:
    """Income-statement items, all taken from the SAME period.

    Prefers trailing-twelve-months; falls back to the latest fiscal year when
    interim statements are missing, incomplete, or cover fewer line items.
    """
    empty = {key: None for key in INCOME_ROWS}

    ttm = dict(empty)
    window = trailing_columns(quarterly)
    if window:
        for key, rows in INCOME_ROWS.items():
            ttm[key] = sum_over(quarterly, rows, window)

    fiscal = dict(empty)
    fiscal_label = None
    fiscal_column = None
    for column in statement_columns(annual):
        candidate = {key: sum_over(annual, rows, [column]) for key, rows in INCOME_ROWS.items()}
        if any(v is not None for v in candidate.values()):
            fiscal, fiscal_column, fiscal_label = candidate, column, f"FY{column.year}"
            break

    ttm_count = sum(v is not None for v in ttm.values())
    fiscal_count = sum(v is not None for v in fiscal.values())
    ttm_is_current = window is not None and (fiscal_column is None or window[0] >= fiscal_column)
    # Second, independent guard against a mis-read window: twelve months of revenue
    # cannot plausibly be under 60% or over 180% of the latest full fiscal year. If it
    # is, the periods were probably mis-identified, and the labelled fiscal year is safer.
    ttm_revenue, fiscal_revenue = ttm["totalRevenue"], fiscal["totalRevenue"]
    ttm_is_plausible = True
    if ttm_revenue is not None and fiscal_revenue is not None and ttm_revenue > 0 and fiscal_revenue > 0:
        ttm_is_plausible = 0.6 <= ttm_revenue / fiscal_revenue <= 1.8
    if ttm_count > 0 and ttm_count >= fiscal_count and ttm_is_current and ttm_is_plausible:
        return ttm, "TTM"
    if fiscal_count > 0:
        return fiscal, fiscal_label
    return empty, None


def free_cash_flow(quarterly: pd.DataFrame | None, annual: pd.DataFrame | None, prefer_ttm: bool) -> float | int | None:
    """Free cash flow = operating cash flow - capital expenditure (statement value)."""
    ttm = None
    window = trailing_columns(quarterly)
    if window:
        ttm = sum_over(quarterly, CASHFLOW_ROWS, window)
    fiscal = None
    for column in statement_columns(annual)[:2]:
        fiscal = sum_over(annual, CASHFLOW_ROWS, [column])
        if fiscal is not None:
            break
    if prefer_ttm:
        return first_not_none(ttm, fiscal)
    return first_not_none(fiscal, ttm)


def balance_item(quarterly: pd.DataFrame | None, annual: pd.DataFrame | None, row_names: list[str]) -> float | int | None:
    """Most recent balance-sheet value: latest two interim periods, then annual."""
    for frame in (quarterly, annual):
        columns = statement_columns(frame)[:2]
        for row in row_names:
            for column in columns:
                value = cell(frame, row, column)
                if value is not None:
                    return value
    return None


def fetch_statements(ticker: yf.Ticker, symbol: str, settings: argparse.Namespace,
                     deadline: float | None) -> dict[str, pd.DataFrame]:
    names = {
        "q_income": "quarterly_income_stmt", "a_income": "income_stmt",
        "q_balance": "quarterly_balance_sheet", "a_balance": "balance_sheet",
        "q_cash": "quarterly_cashflow", "a_cash": "cashflow",
    }
    statements = {}
    for key, attribute in names.items():
        # An empty frame is a legitimate answer (e.g. no interim statements); only
        # exceptions are retried.
        statements[key] = with_retry(f"{symbol} {attribute}", lambda a=attribute: getattr(ticker, a),
                                     settings.max_retries, settings.retry_delay, deadline)
    return statements


def fetch_info(ticker: yf.Ticker, symbol: str) -> dict[str, Any]:
    info = ticker.info
    if not isinstance(info, dict) or not info.get("quoteType"):
        raise ValueError(f"profile for {symbol} is empty")
    return info


# --------------------------------------------------------------------------- #
# Asset assembly
# --------------------------------------------------------------------------- #

def empty_fundamentals() -> dict[str, Any]:
    return {key: None for key in FUNDAMENTAL_KEYS}


def build_fundamentals(info: dict[str, Any], statements: dict[str, pd.DataFrame],
                       dividend_yield: float | int | None) -> tuple[dict[str, Any], str | None]:
    income, period = income_items(statements["q_income"], statements["a_income"])
    fcf = free_cash_flow(statements["q_cash"], statements["a_cash"], prefer_ttm=(period == "TTM"))
    balance = {key: balance_item(statements["q_balance"], statements["a_balance"], rows)
               for key, rows in BALANCE_ROWS.items()}

    fundamentals = empty_fundamentals()
    fundamentals.update({
        "marketCap": clean_number(info.get("marketCap")),
        "enterpriseValue": clean_number(info.get("enterpriseValue")),
        "ebit": income["ebit"],
        "ebitda": first_not_none(income["ebitda"], clean_number(info.get("ebitda"))),
        "operatingIncome": income["operatingIncome"],
        "totalRevenue": first_not_none(income["totalRevenue"], clean_number(info.get("totalRevenue"))),
        "netIncome": first_not_none(income["netIncome"], clean_number(info.get("netIncomeToCommon"))),
        # Yahoo's info["freeCashflow"] is *levered* FCF with a different definition,
        # so it is deliberately not used as a fallback.
        "freeCashFlow": fcf,
        "totalDebt": first_not_none(balance["totalDebt"], clean_number(info.get("totalDebt"))),
        "totalCash": first_not_none(balance["totalCash"], clean_number(info.get("totalCash"))),
        "totalEquity": balance["totalEquity"],
        "totalAssets": balance["totalAssets"],
        "trailingPE": clean_number(info.get("trailingPE"), digits=4),
        "forwardPE": clean_number(info.get("forwardPE"), digits=4),
        "priceToBook": clean_number(info.get("priceToBook"), digits=4),
        "returnOnEquity": clean_number(info.get("returnOnEquity"), digits=6),
        "dividendYieldTTM": dividend_yield,
    })
    if period is None and any(fundamentals[k] is not None for k in ("totalRevenue", "netIncome", "ebitda")):
        period = "TTM"  # values came from Yahoo's trailing summary
    return fundamentals, period


def resolve_profile(entry: dict[str, Any], sector: str | None) -> str:
    if entry["assetClass"] in CLASS_PROFILES:
        return CLASS_PROFILES[entry["assetClass"]]
    if entry.get("scoringProfile"):
        return entry["scoringProfile"]
    return SECTOR_PROFILES.get(sector or "", "CORPORATE")


def checked_price_to_book(symbol: str, fundamentals: dict[str, Any], currency: str,
                          financial_currency: str) -> float | int | None:
    """Yahoo's Price-to-Book, unless it disagrees wildly with market cap / book equity.

    Both sides of the check must be in the same currency (market cap is in the
    trading currency, equity in the reporting currency). A reported value that is
    missing, zero or negative is left alone: the engine explains those cases.
    """
    reported = fundamentals.get("priceToBook")
    market_cap = fundamentals.get("marketCap")
    equity = fundamentals.get("totalEquity")
    if (reported is None or reported <= 0 or currency != financial_currency
            or not market_cap or not equity or market_cap <= 0 or equity <= 0):
        return reported
    computed = market_cap / equity
    if 1 / PRICE_TO_BOOK_TOLERANCE <= reported / computed <= PRICE_TO_BOOK_TOLERANCE:
        return reported
    LOG.info("  %s: reported Price-to-Book %g disagrees with market cap / book equity (%.2f); using the latter",
             symbol, reported, computed)
    return clean_number(computed, digits=4)


def fetch_asset(entry: dict[str, Any], previous: dict[str, Any] | None, settings: argparse.Namespace,
                history_cfg: dict[str, str], now_utc: datetime, deadline: float | None = None) -> dict[str, Any]:
    """Fetch prices and fundamentals for one asset.

    Raises ``FetchError`` when price history is unavailable. News and forecast
    are attached afterwards by the caller, so they can never cost an asset its prices.
    """
    symbol = entry["ticker"]
    asset_class = entry["assetClass"]
    has_accounts = asset_class == "equity"  # crypto, ETFs and indices publish no company statements
    pays_out = asset_class in {"equity", "etf"}
    ticker = yf.Ticker(symbol)

    history = with_retry(
        f"{symbol} price history",
        lambda: fetch_history(symbol, history_cfg["period"], history_cfg["interval"], settings.request_timeout),
        settings.max_retries, settings.retry_delay, deadline)
    half_days = getattr(settings, "early_closes", {}).get(entry["market"], frozenset())
    candles, older = split_history(build_candles(history, entry["market"], now_utc, half_days))
    if len(candles) < MIN_CANDLES:
        raise FetchError(f"{symbol} has only {len(candles)} completed candles (minimum {MIN_CANDLES})")
    dividends = dividend_rows(history, candles[-1][0]) if pays_out else []
    last_close = candles[-1][4]
    dividend_yield = trailing_dividend_yield(history, last_close) if pays_out else None

    status, status_note = "fresh", None
    try:
        info = with_retry(f"{symbol} profile", lambda: fetch_info(ticker, symbol),
                          settings.max_retries, settings.retry_delay, deadline)
        currency = info.get("currency") or entry["currency"]
        if currency != entry["currency"]:
            warn(f"{symbol}: Yahoo reports currency {currency}, watchlist says {entry['currency']}")
        financial_currency = info.get("financialCurrency") or currency
        if has_accounts:
            statements = fetch_statements(ticker, symbol, settings, deadline)
            fundamentals, period = build_fundamentals(info, statements, dividend_yield)
            fundamentals["priceToBook"] = checked_price_to_book(symbol, fundamentals, currency, financial_currency)
        else:
            # Nothing to score. Crypto keeps its market cap and an ETF its trailing
            # distribution yield, both shown for context only.
            fundamentals, period = empty_fundamentals(), None
            if asset_class == "crypto":
                fundamentals["marketCap"] = clean_number(info.get("marketCap"))
            if asset_class == "etf":
                fundamentals["dividendYieldTTM"] = dividend_yield
        meta = {
            "name": entry.get("name") or info.get("longName") or info.get("shortName") or symbol,
            "currency": currency,
            "financialCurrency": financial_currency,
            "sector": info.get("sector") if has_accounts else None,
            "industry": info.get("industry") if has_accounts else None,
        }
    except FetchError as exc:
        if previous is None:
            raise
        warn(f"{symbol}: fundamentals unavailable ({exc}); carrying them over from the previous snapshot")
        fundamentals = {key: previous["fundamentals"].get(key) for key in FUNDAMENTAL_KEYS}
        if pays_out:
            fundamentals["dividendYieldTTM"] = dividend_yield
        period = previous.get("fundamentalsPeriod")
        meta = {key: previous.get(key) for key in ("name", "currency", "financialCurrency", "sector", "industry")}
        status = "stale"
        status_note = "Price history is fresh; fundamentals are carried over from an earlier snapshot."

    return {
        "ticker": symbol,
        "name": meta["name"],
        "assetClass": entry["assetClass"],
        "market": entry["market"],
        "currency": meta["currency"],
        "financialCurrency": meta["financialCurrency"],
        "sector": meta["sector"],
        "industry": meta["industry"],
        "scoringProfile": resolve_profile(entry, meta["sector"]),
        "lotSize": entry["lotSize"],
        "binanceSymbol": entry.get("binanceSymbol"),
        "status": status,
        "statusNote": status_note,
        "fundamentalsPeriod": period,
        "quote": {"lastClose": last_close, "previousClose": candles[-2][4], "asOf": candles[-1][0]},
        "fundamentals": fundamentals,
        "candles": candles,
        "history": older,
        "dividends": dividends,
        "news": empty_news("News has not been fetched for this asset yet."),
        "forecast": empty_forecast("The forecast model has not been run for this snapshot."),
        "events": empty_events("Events have not been fetched for this asset yet."),
    }


def aged_section(section: dict[str, Any], note: str) -> dict[str, Any]:
    """A copy of a news or forecast block, marked stale if it was fresh."""
    copy = json.loads(json.dumps(section))
    if copy.get("status") == "fresh":
        copy["status"] = "stale"
        copy["note"] = note
    return copy


def upgrade_asset(asset: dict[str, Any]) -> dict[str, Any]:
    """Bring an asset from an older snapshot schema up to the current shape."""
    upgraded = dict(asset)
    upgraded.setdefault("statusNote", None)
    if not isinstance(upgraded.get("news"), dict):
        upgraded["news"] = empty_news("No news was stored in the previous snapshot.")
    if not isinstance(upgraded.get("forecast"), dict):
        upgraded["forecast"] = empty_forecast("No forecast was stored in the previous snapshot.")
    # Schema v3: a v2 asset has one year of candles and nothing else.
    if not isinstance(upgraded.get("history"), list):
        upgraded["history"] = []
    if not isinstance(upgraded.get("dividends"), list):
        upgraded["dividends"] = []
    if not isinstance(upgraded.get("events"), dict):
        upgraded["events"] = empty_events("No events were stored in the previous snapshot.")
    return upgraded


def carry_over(previous: dict[str, Any], entry: dict[str, Any], reason: str) -> dict[str, Any]:
    """Re-use an asset from the previous snapshot, marked stale."""
    asset = {key: previous.get(key) for key in ASSET_KEYS}
    asset["lotSize"] = entry["lotSize"]
    asset["binanceSymbol"] = entry.get("binanceSymbol")
    asset["status"] = "stale"
    asset["statusNote"] = f"Carried over from an earlier snapshot (last candle {previous['quote']['asOf']}): {reason}"
    asset["news"] = aged_section(previous["news"], "Carried over from an earlier snapshot.")
    asset["forecast"] = aged_section(previous["forecast"], "Carried over from an earlier snapshot.")
    asset["events"] = aged_section(previous["events"], "Carried over from an earlier snapshot.")
    return asset


# --------------------------------------------------------------------------- #
# News: RSS, semantic de-duplication, sentiment
# --------------------------------------------------------------------------- #

def empty_news(note: str | None) -> dict[str, Any]:
    return {"status": "unavailable", "fetchedAt": None, "headlineCount": 0, "clusterCount": 0,
            "newestAt": None, "sentiment": None, "clusters": [], "note": note}


def parse_rss(data: bytes) -> list[dict[str, Any]]:
    """Parse an RSS 2.0 document into ``[{title, link, published}]``.

    Documents that declare a DOCTYPE or entities are rejected outright: a news
    feed has no need for them, and they are the vector for XML entity attacks.
    """
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("feed declares a DOCTYPE or entity, which is not accepted")
    root = ElementTree.fromstring(data)
    headlines: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in root.iter("item"):
        title = re.sub(r"\s+", " ", html.unescape(item.findtext("title") or "")).strip()
        link = (item.findtext("link") or "").strip()
        try:
            published = email.utils.parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            continue
        if not title or published is None:
            continue
        if published.tzinfo is None:
            published = published.replace(tzinfo=timezone.utc)
        key = (title, link)
        if key in seen:
            continue
        seen.add(key)
        headlines.append({
            "title": title[:NEWS_TITLE_LIMIT],
            "link": link if link.startswith("https://") and len(link) <= 2000 else None,
            "published": published.astimezone(timezone.utc),
        })
    return headlines


def normalise_title(title: str) -> str:
    """Lower-case, strip punctuation and collapse whitespace before comparing titles."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", title.lower())).strip()


def cluster_headlines(headlines: list[dict[str, Any]], threshold: float = NEWS_SIMILARITY,
                      window: timedelta = NEWS_WINDOW) -> list[dict[str, Any]]:
    """Group syndicated copies of the same story.

    Headlines are processed oldest first. One joins an existing cluster when its
    normalised title is at least ``threshold`` similar (``difflib`` ratio) to the
    cluster's *first* title AND it was published strictly less than ``window``
    after the cluster's most recent member. The window therefore rolls: a story
    that keeps being re-reported stays one cluster, while the same headline
    resurfacing days later starts a new one, because that is an escalation.
    """
    clusters: list[dict[str, Any]] = []
    for headline in sorted(headlines, key=lambda h: h["published"]):
        key = normalise_title(headline["title"])
        best: tuple[float, dict[str, Any]] | None = None
        for cluster in clusters:
            if headline["published"] - cluster["latest"] >= window:
                continue
            ratio = difflib.SequenceMatcher(None, key, cluster["key"], autojunk=False).ratio()
            if ratio >= threshold and (best is None or ratio > best[0]):
                best = (ratio, cluster)
        if best is not None:
            best[1]["members"].append(headline)
            best[1]["latest"] = headline["published"]
        else:
            clusters.append({"key": key, "first": headline, "latest": headline["published"], "members": [headline]})
    return clusters


def sentiment_label(compound: float) -> str:
    if compound >= SENTIMENT_THRESHOLD:
        return "positive"
    if compound <= -SENTIMENT_THRESHOLD:
        return "negative"
    return "neutral"


def score_title(analyzer: Any, title: str) -> dict[str, float] | None:
    if analyzer is None:
        return None
    scores = analyzer.polarity_scores(title)
    cleaned = {key: clean_number(scores.get(short), digits=4)
               for key, short in (("compound", "compound"), ("pos", "pos"), ("neu", "neu"), ("neg", "neg"))}
    return None if any(value is None for value in cleaned.values()) else cleaned


def build_news(headlines: list[dict[str, Any]], analyzer: Any, now_utc: datetime) -> dict[str, Any]:
    """Turn raw headlines into the snapshot's ``news`` block."""
    recent = sorted(headlines, key=lambda h: h["published"], reverse=True)[:NEWS_MAX_HEADLINES]
    if not recent:
        news = empty_news("The news feed returned no headlines for this asset.")
        news["fetchedAt"] = iso_timestamp(now_utc)
        return news

    clusters = sorted(cluster_headlines(recent), key=lambda c: c["latest"], reverse=True)
    stored = []
    for cluster in clusters[:NEWS_SCORED_CLUSTERS]:
        scores = score_title(analyzer, cluster["first"]["title"])
        stored.append({
            "title": cluster["first"]["title"],
            "link": cluster["first"]["link"],
            "publishedAt": iso_timestamp(cluster["latest"]),
            "firstSeenAt": iso_timestamp(cluster["first"]["published"]),
            "duplicates": len(cluster["members"]) - 1,
            "scores": scores,
            "label": sentiment_label(scores["compound"]) if scores else None,
        })

    scored = [c["scores"]["compound"] for c in stored if c["scores"]]
    sentiment = None
    if scored:
        compound = clean_number(sum(scored) / len(scored), digits=4)
        sentiment = {"compound": compound, "label": sentiment_label(compound), "basis": len(scored)}

    newest = recent[0]["published"]
    stale = now_utc - newest > NEWS_STALE_AFTER
    note = None
    if stale:
        note = f"The most recent headline is more than {NEWS_STALE_AFTER.days} days old."
    elif analyzer is None:
        note = "Headlines only: the sentiment package is not installed."
    return {
        "status": "stale" if stale else "fresh",
        "fetchedAt": iso_timestamp(now_utc),
        "headlineCount": len(recent),
        "clusterCount": len(clusters),
        "newestAt": iso_timestamp(newest),
        "sentiment": sentiment,
        "clusters": stored,
        "note": note,
    }


def fetch_news(symbol: str, previous: dict[str, Any] | None, settings: argparse.Namespace,
               analyzer: Any, now_utc: datetime) -> dict[str, Any]:
    """Fetch and score news for one ticker. Never raises."""
    url = NEWS_FEED_URL.format(symbol=urllib.parse.quote(symbol, safe=""))
    deadline = time.monotonic() + settings.news_timeout
    try:
        data = with_retry(f"{symbol} news feed", lambda: http_get(url, settings.request_timeout),
                          2, settings.retry_delay, deadline)
        return build_news(parse_rss(data), analyzer, now_utc)
    except Exception as exc:  # noqa: BLE001 - news must never break a ticker
        warn(f"{symbol}: news unavailable ({str(exc)[:160]})")
        if previous and previous.get("status") in {"fresh", "stale"}:
            return aged_section(previous, "The news feed could not be reached; these headlines are from an earlier run.")
        return empty_news("The news feed could not be reached.")



# --------------------------------------------------------------------------- #
# Events: earnings and ex-dividend dates (stocks only)
# --------------------------------------------------------------------------- #

def empty_events(note: str | None) -> dict[str, Any]:
    return {"status": "unavailable", "fetchedAt": None, "nextEarnings": None,
            "nextExDividend": None, "earnings": [], "note": note}


NO_EVENTS_NOTES = {
    "crypto": "Crypto has no earnings or ex-dividend dates.",
    "index": "An index has no earnings or ex-dividend dates of its own.",
    "etf": "Yahoo publishes no event calendar for ETFs. Ex-dividend timing can only be estimated from past payments.",
}


def earnings_timing(stamp: Any, market: str) -> tuple[str, str]:
    """The exchange-local date of an earnings release and when it fell against the session.

    Yahoo stamps every release in New York time. A stamp of exactly midnight is
    its placeholder for "date known, time not known".
    """
    moment = pd.Timestamp(stamp)
    if moment.tzinfo is None:
        moment = moment.tz_localize(YAHOO_EVENT_TIMEZONE)
    new_york = moment.tz_convert(YAHOO_EVENT_TIMEZONE)
    if (new_york.hour, new_york.minute, new_york.second) == (0, 0, 0):
        return new_york.strftime("%Y-%m-%d"), "unknown"
    local = moment.tz_convert(MARKET_TIMEZONES.get(market, YAHOO_EVENT_TIMEZONE))
    clock = local.time()
    if clock < SESSION_OPEN.get(market, dtime(9, 30)):
        timing = "before-open"
    elif clock >= SESSION_CLOSE.get(market, dtime(16, 0)):
        timing = "after-close"
    else:
        timing = "during-session"
    return local.strftime("%Y-%m-%d"), timing


def build_events(calendar: dict[str, Any] | None, earnings_frame: Any, market: str, now_utc: datetime,
                 history_start: str | None) -> dict[str, Any]:
    """Assemble the events block from Yahoo's calendar and its list of earnings dates.

    The next earnings date takes every future candidate from both sources. When
    they disagree by a few days (Yahoo's two endpoints often differ by one), the
    block keeps the earliest as ``date`` and the latest as ``dateTo``. Past
    earnings dates older than the stored price history are dropped: their moves
    could not be measured anyway.
    """
    today = now_utc.date().isoformat()
    future: dict[str, str] = {}
    past: dict[str, str] = {}
    if earnings_frame is not None and getattr(earnings_frame, "empty", True) is False:
        for stamp in earnings_frame.index:
            try:
                day, timing = earnings_timing(stamp, market)
                moment = pd.Timestamp(stamp)
                moment = moment.tz_localize(YAHOO_EVENT_TIMEZONE) if moment.tzinfo is None else moment
            except (ValueError, TypeError):
                continue
            target = future if moment.tz_convert("UTC").to_pydatetime() > now_utc else past
            if day not in target or target[day] == "unknown":
                target[day] = timing

    calendar = calendar if isinstance(calendar, dict) else {}
    candidates = dict(future)
    for value in calendar.get("Earnings Date") or []:
        if isinstance(value, date):
            candidates.setdefault(value.isoformat(), "unknown")
    upcoming = sorted(day for day in candidates if day >= today)
    next_earnings = None
    if upcoming:
        first = upcoming[0]
        limit = (date.fromisoformat(first) + timedelta(days=EARNINGS_CLUSTER_DAYS)).isoformat()
        cluster = [day for day in upcoming if day <= limit]
        known = [candidates[day] for day in cluster if candidates[day] != "unknown"]
        next_earnings = {"date": first, "dateTo": cluster[-1] if len(cluster) > 1 else None,
                         "timing": known[0] if known else "unknown"}

    ex_dividend = calendar.get("Ex-Dividend Date")
    next_ex_dividend = ({"date": ex_dividend.isoformat()}
                        if isinstance(ex_dividend, date) and ex_dividend.isoformat() >= today else None)

    earnings = [{"date": day, "timing": past[day]} for day in sorted(past, reverse=True)
                if day < today and (history_start is None or day >= history_start)][:EVENTS_MAX_PAST]

    note = None
    if next_earnings is None:
        note = "Yahoo lists no upcoming earnings date."
    elif not earnings:
        note = "No past earnings dates fall inside the stored price history, so a typical earnings move cannot be measured."
    return {"status": "fresh", "fetchedAt": iso_timestamp(now_utc), "nextEarnings": next_earnings,
            "nextExDividend": next_ex_dividend, "earnings": earnings, "note": note}


def fetch_events(entry: dict[str, Any], previous: dict[str, Any] | None, settings: argparse.Namespace,
                 now_utc: datetime, history_start: str | None) -> dict[str, Any]:
    """The events block for one asset. Never raises; costs two requests for a stock and none otherwise."""
    asset_class = entry["assetClass"]
    if asset_class != "equity":
        return empty_events(NO_EVENTS_NOTES.get(asset_class))
    symbol = entry["ticker"]
    ticker = yf.Ticker(symbol)
    deadline = time.monotonic() + settings.events_timeout

    def calendar_call() -> dict[str, Any]:
        value = ticker.calendar
        return value if isinstance(value, dict) else {}

    def earnings_call() -> Any:
        return ticker.get_earnings_dates(limit=EARNINGS_LOOKUP)

    results: dict[str, Any] = {}
    for name, call in (("calendar", calendar_call), ("earnings dates", earnings_call)):
        try:
            results[name] = with_retry(f"{symbol} {name}", call, settings.max_retries, settings.retry_delay, deadline)
        except FetchError as exc:
            LOG.info("  %s: %s unavailable (%s)", symbol, name, str(exc)[:120])
            results[name] = None
    if results["calendar"] is None and results["earnings dates"] is None:
        if isinstance(previous, dict) and previous.get("status") in {"fresh", "stale"}:
            return aged_section(previous, "The event calendar could not be refreshed in this run.")
        return empty_events("The event calendar could not be fetched.")
    return build_events(results["calendar"], results["earnings dates"], entry["market"], now_utc, history_start)

# --------------------------------------------------------------------------- #
# Forecast: a deliberately small Prophet model, with its own track record
# --------------------------------------------------------------------------- #

def empty_forecast(note: str | None) -> dict[str, Any]:
    return {"status": "unavailable", "model": None, "modelVersion": None, "config": None,
            "trainedOn": None, "horizon": None, "backtest": None, "points": [], "note": note}


def future_dates(last_date: str, horizon_days: int, weekdays_only: bool) -> list[str]:
    """The calendar days after ``last_date`` that the asset can trade on.

    Crypto trades every day. Stocks get Monday to Friday; exchange holidays are
    not removed, so a stock forecast can include a day the market is shut.
    """
    start = datetime.strptime(last_date, "%Y-%m-%d").date()
    days = (start + timedelta(days=offset) for offset in range(1, horizon_days + 1))
    return [day.isoformat() for day in days if not weekdays_only or day.weekday() < 5]


def stable_seed(text: str) -> int:
    """A seed that is the same on every machine and every run for the same text."""
    return zlib.crc32(text.encode("utf-8")) & 0x7FFFFFFF


def project_prices(dates: list[str], closes: list[float], target_dates: list[str],
                   seed: int) -> tuple[list[list[Any]], float]:
    """Fit Prophet to ``log(close)`` and project ``target_dates``.

    Model: piecewise-linear trend plus weekly seasonality, fitted by optimisation
    (no MCMC). Yearly seasonality is off because one year of history cannot
    identify it. Working in logs keeps every projected price positive.

    Anchoring: Prophet's fitted trend can sit well away from the latest price
    after a sharp move. The projection therefore uses the model's projected
    *change* from the last history date and applies it to the actual last close,
    so the path always starts where the price really is. The gap that anchoring
    closed is returned as the second value.

    Returns ``([[date, estimate, lower, upper], ...], level_gap)``.
    """
    import numpy as np  # imported here so only forecast workers pay for these imports
    from prophet import Prophet

    frame = pd.DataFrame({"ds": pd.to_datetime(dates), "y": np.log(np.asarray(closes, dtype=float))})
    model = Prophet(
        growth="linear",
        weekly_seasonality=True,
        yearly_seasonality=False,
        daily_seasonality=False,
        mcmc_samples=0,
        interval_width=FORECAST_INTERVAL,
        uncertainty_samples=FORECAST_UNCERTAINTY_SAMPLES,
        changepoint_range=FORECAST_CHANGEPOINT_RANGE,
    )
    model.fit(frame)
    asked = pd.DataFrame({"ds": pd.to_datetime([dates[-1], *target_dates])})
    np.random.seed(seed)  # the uncertainty band is simulated; seeding makes it reproducible
    predicted = model.predict(asked)

    fitted_last = float(predicted["yhat"].iloc[0])
    shift = math.log(closes[-1]) - fitted_last
    rows: list[list[Any]] = []
    for date, estimate, lower, upper in zip(target_dates, predicted["yhat"].iloc[1:],
                                            predicted["yhat_lower"].iloc[1:], predicted["yhat_upper"].iloc[1:]):
        values = [clean_number(math.exp(float(v) + shift)) for v in (estimate, lower, upper)]
        if any(v is None or v <= 0 for v in values):
            raise ValueError(f"the model produced a non-finite or non-positive price for {date}")
        mid, low, high = (round_price(float(v)) for v in values)
        rows.append([date, mid, min(low, mid), max(high, mid)])
    return rows, math.exp(fitted_last - math.log(closes[-1])) - 1


def backtest_metrics(actual: list[float], rows: list[list[Any]], anchor: float) -> dict[str, Any]:
    """How a past projection compared with what then happened.

    mape             mean absolute percentage error of the projection
    naiveMape        the same error for "the price stays where it is": the bar any
                     forecast has to beat to be worth looking at
    endError         signed error on the final held-out day
    directionCorrect did the projection get the direction of the move right
    coverage         share of actual prices that fell inside the projected band
    """
    count = len(actual)
    estimates = [row[1] for row in rows]
    mape = sum(abs(e - a) / a for e, a in zip(estimates, actual)) / count
    naive = sum(abs(anchor - a) / a for a in actual) / count
    inside = sum(1 for row, a in zip(rows, actual) if row[2] <= a <= row[3])
    actual_move = actual[-1] - anchor
    direction = None if actual_move == 0 else (estimates[-1] - anchor > 0) == (actual_move > 0)
    return {
        "holdoutDays": FORECAST_HOLDOUT_DAYS,
        "holdoutPoints": count,
        "mape": clean_number(mape, digits=6),
        "naiveMape": clean_number(naive, digits=6),
        "endError": clean_number((estimates[-1] - actual[-1]) / actual[-1], digits=6),
        "directionCorrect": direction,
        "coverage": clean_number(inside / count, digits=4),
        "note": None,
    }


def forecast_series(ticker: str, asset_class: str, dates: list[str], closes: list[float]) -> dict[str, Any]:
    """Build the snapshot's ``forecast`` block for one asset (two model fits)."""
    import prophet

    weekdays_only = asset_class != "crypto"
    seed = stable_seed(ticker)
    targets = future_dates(dates[-1], FORECAST_HORIZON_DAYS, weekdays_only)
    points, level_gap = project_prices(dates, closes, targets, seed)

    # Track record: hide the last 30 calendar days, project them with the same
    # procedure, and compare with what actually happened.
    cutoff = (datetime.strptime(dates[-1], "%Y-%m-%d").date() - timedelta(days=FORECAST_HOLDOUT_DAYS)).isoformat()
    split = sum(1 for date in dates if date <= cutoff)
    if split >= FORECAST_MIN_TRAIN and len(dates) - split >= FORECAST_MIN_HOLDOUT:
        held_rows, _ = project_prices(dates[:split], closes[:split], dates[split:], seed)
        backtest = backtest_metrics(closes[split:], held_rows, closes[split - 1])
    else:
        backtest = {"holdoutDays": FORECAST_HOLDOUT_DAYS, "holdoutPoints": 0, "mape": None, "naiveMape": None,
                    "endError": None, "directionCorrect": None, "coverage": None,
                    "note": "Not enough history to hold out a test period."}

    return {
        "status": "fresh",
        "model": "prophet",
        "modelVersion": prophet.__version__,
        "config": {
            "target": "log(close)",
            "growth": "linear",
            "weeklySeasonality": True,
            "yearlySeasonality": False,
            "dailySeasonality": False,
            "mcmcSamples": 0,
            "intervalWidth": FORECAST_INTERVAL,
            "uncertaintySamples": FORECAST_UNCERTAINTY_SAMPLES,
            "changepointRange": FORECAST_CHANGEPOINT_RANGE,
            "anchor": "last close",
            "levelGap": clean_number(level_gap, digits=6),
            "seed": seed,
        },
        "trainedOn": {"from": dates[0], "to": dates[-1], "observations": len(dates)},
        "horizon": {"calendarDays": FORECAST_HORIZON_DAYS, "points": len(points), "weekdaysOnly": weekdays_only},
        "backtest": backtest,
        "points": points,
        "note": None,
    }


def forecast_worker_init() -> None:
    """Runs once in each forecast process: keep Stan's progress chatter out of the log."""
    try:
        # cmdstanpy sets its logger to INFO when it is first imported, so import it before
        # lowering the level. This also warms the worker before its first job.
        import prophet  # noqa: F401
    except ImportError:
        pass
    logging.getLogger("prophet").setLevel(logging.ERROR)
    # Lowering cmdstanpy's level is not enough: it logs "Chain [1] start/done processing" at INFO
    # through its own handler on every fit. Real failures still surface as exceptions.
    stan_logger = logging.getLogger("cmdstanpy")
    stan_logger.setLevel(logging.ERROR)
    stan_logger.disabled = True
    # Prophet triggers pandas deprecation notices from inside its own code on every fit.
    warnings.filterwarnings("ignore", module=r"prophet(\..*)?")
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)


def forecast_job(job: tuple[str, str, list[str], list[float]]) -> dict[str, Any]:
    """Process-pool entry point. Must stay a top-level function so it can be pickled."""
    ticker, asset_class, dates, closes = job
    return forecast_series(ticker, asset_class, dates, closes)


def fallback_forecast(previous: dict[str, Any] | None, reason: str) -> dict[str, Any]:
    if previous and previous.get("status") in {"fresh", "stale"} and previous.get("points"):
        return aged_section(previous, f"{reason} This projection is from an earlier run.")
    return empty_forecast(reason)


def run_forecasts(assets: list[dict[str, Any]], previous_assets: dict[str, dict[str, Any]],
                  settings: argparse.Namespace) -> dict[str, dict[str, Any]]:
    """Forecast every freshly fetched asset. Never raises.

    The fits run in separate processes for two reasons: they use both of the
    runner's cores, and a process, unlike a thread, can be stopped. When the
    stage budget runs out the pool is terminated and every unfinished asset
    falls back to its previous projection or to "unavailable".
    """
    previous = {ticker: old.get("forecast") for ticker, old in previous_assets.items()}
    if not assets:
        return {}
    if settings.skip_forecast:
        return {a["ticker"]: fallback_forecast(previous.get(a["ticker"]), "Forecasting was skipped in this run.")
                for a in assets}
    if importlib.util.find_spec("prophet") is None:
        warn("prophet is not installed: forecasts are unavailable")
        return {a["ticker"]: fallback_forecast(previous.get(a["ticker"]), "The forecasting package is not installed.")
                for a in assets}

    started = time.monotonic()
    deadline = started + settings.forecast_budget
    results: dict[str, dict[str, Any]] = {}
    context = multiprocessing.get_context("spawn")  # never fork a process that has live threads
    pool = context.Pool(processes=max(1, settings.forecast_workers), initializer=forecast_worker_init)
    try:
        handles = {}
        for asset in assets:
            job = (asset["ticker"], asset["assetClass"], [c[0] for c in asset["candles"]], [c[4] for c in asset["candles"]])
            handles[asset["ticker"]] = pool.apply_async(forecast_job, (job,))
        for ticker, handle in handles.items():
            wait = min(settings.forecast_timeout, deadline - time.monotonic())
            try:
                if wait <= 0:
                    raise multiprocessing.TimeoutError()
                block = handle.get(timeout=wait)
                problems = validate_forecast(block)
                if problems:
                    raise ValueError("; ".join(problems))
                results[ticker] = block
            except multiprocessing.TimeoutError:
                warn(f"{ticker}: forecast did not finish in time")
                results[ticker] = fallback_forecast(previous.get(ticker), "The forecast model ran out of time.")
            except Exception as exc:  # noqa: BLE001 - a failed fit must never cost an asset its prices
                warn(f"{ticker}: forecast failed ({str(exc)[:160]})")
                results[ticker] = fallback_forecast(previous.get(ticker), "The forecast model could not be fitted.")
    finally:
        pool.terminate()
        pool.join()
    done = sum(1 for block in results.values() if block["status"] == "fresh")
    LOG.info("forecasts: %d of %d fitted in %.0fs", done, len(assets), time.monotonic() - started)
    return results


# --------------------------------------------------------------------------- #
# Macro: risk-free rates and FX
# --------------------------------------------------------------------------- #

def risk_free_entry(name: str, symbol: str | None, value: float | None, as_of: str | None,
                    source: str | None, status: str) -> dict[str, Any]:
    return {"name": name, "symbol": symbol, "yield": value, "asOf": as_of, "source": source, "status": status}


def plausible_yield(value: Any) -> bool:
    return is_finite_number(value) and YIELD_BOUNDS[0] <= value <= YIELD_BOUNDS[1]


def fetch_us_10y(settings: argparse.Namespace) -> dict[str, Any]:
    """US 10-year Treasury yield from Yahoo's ^TNX index (quoted in percent)."""
    deadline = time.monotonic() + settings.macro_timeout
    history = with_retry(f"{US_10Y_SYMBOL} yield",
                         lambda: fetch_history(US_10Y_SYMBOL, "5d", "1d", settings.request_timeout),
                         settings.max_retries, settings.retry_delay, deadline)
    closes = history["Close"].dropna()
    value = clean_number(closes.iloc[-1] / 100, digits=6) if len(closes) else None
    if not plausible_yield(value):
        raise FetchError(f"{US_10Y_SYMBOL} returned an implausible yield: {value}")
    return risk_free_entry("US 10-year Treasury yield", US_10Y_SYMBOL, value,
                           closes.index[-1].strftime("%Y-%m-%d"), "yahoo", "fresh")


def parse_mas_table(page: str) -> tuple[float, str]:
    """Latest 10-year yield from the MAS result table.

    Rows look like ``[year, month, day, yield]`` where the year and month cells
    are blank when they repeat the row above.
    """
    table = re.search(r"<table.*?</table>", page, flags=re.S)
    if not table:
        raise ValueError("MAS response contains no result table")
    year = month = None
    latest: tuple[float, str] | None = None
    for row in re.findall(r"<tr.*?</tr>", table.group(0), flags=re.S):
        cells = [re.sub(r"<[^>]+>|\s+", " ", html.unescape(c)).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S)]
        if len(cells) != 4:
            continue
        if cells[0].isdigit():
            year = int(cells[0])
        if cells[1] in MONTHS:
            month = MONTHS[cells[1]]
        if year is None or month is None or not cells[2].isdigit():
            continue
        value = clean_number(cells[3])
        if value is None:
            continue
        try:
            day = datetime(year, month, int(cells[2]))
        except ValueError:
            continue
        latest = (value / 100, day.strftime("%Y-%m-%d"))
    if latest is None:
        raise ValueError("MAS result table contains no yields")
    return latest


def fetch_sg_10y(settings: argparse.Namespace, now_utc: datetime) -> dict[str, Any]:
    """Singapore 10-year SGS benchmark yield from the MAS statistics form.

    MAS has no key-less API, so this submits the public form the way a browser
    does: load the page for its ASP.NET state fields, then post it back with the
    10-year yield ticked and a daily frequency over the last six weeks.
    """
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def attempt() -> tuple[float, str]:
        page = http_get(MAS_YIELD_URL, settings.request_timeout, opener=opener).decode("utf-8", "replace")
        hidden = {name: html.unescape(value) for name, value in
                  re.findall(r'<input type="hidden" name="(__[A-Z]+)" id="[^"]*" value="([^"]*)"', page)}
        if "__VIEWSTATE" not in hidden or "__EVENTVALIDATION" not in hidden:
            raise ValueError("MAS form state fields were not found")
        end = now_utc + timedelta(hours=8)  # Singapore time
        start = end - timedelta(days=42)
        form = {
            **hidden,
            "__EVENTTARGET": "", "__EVENTARGUMENT": "", "__LASTFOCUS": "",
            MAS_FIELD_PREFIX + "StartYearDropDownList": str(start.year),
            MAS_FIELD_PREFIX + "StartMonthDropDownList": str(start.month),
            MAS_FIELD_PREFIX + "EndYearDropDownList": str(end.year),
            MAS_FIELD_PREFIX + "EndMonthDropDownList": str(end.month),
            MAS_FIELD_PREFIX + "FrequencyDropDownList": "D",
            MAS_FIELD_PREFIX + "TenYearBondYieldCheckBox": "on",
            MAS_FIELD_PREFIX + "DisplayButton": "Display",
        }
        request = urllib.request.Request(
            MAS_YIELD_URL, data=urllib.parse.urlencode(form).encode("utf-8"),
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded",
                     "Referer": MAS_YIELD_URL})
        with opener.open(request, timeout=settings.request_timeout) as response:
            body = response.read(NEWS_MAX_BYTES + 1)
        if len(body) > NEWS_MAX_BYTES:
            raise ValueError("MAS response is unexpectedly large")
        return parse_mas_table(body.decode("utf-8", "replace"))

    deadline = time.monotonic() + settings.macro_timeout
    value, as_of = with_retry("MAS 10-year yield", attempt, 2, settings.retry_delay, deadline)
    value = clean_number(value, digits=6)
    if not plausible_yield(value):
        raise FetchError(f"MAS returned an implausible yield: {value}")
    return risk_free_entry("Singapore 10-year SGS benchmark yield", None, value, as_of, "mas", "fresh")


def build_macro(previous: dict[str, Any] | None, settings: argparse.Namespace, now_utc: datetime) -> dict[str, Any]:
    """Risk-free rates. Never raises: each rate degrades through its own chain.

    USD: Yahoo ^TNX  ->  previous value (stale)  ->  unavailable
    SGD: MAS form    ->  recent previous MAS value (stale)  ->  US yield as a labelled proxy  ->  unavailable
    """
    old = {}
    if previous and isinstance(previous.get("macro"), dict) and isinstance(previous["macro"].get("riskFree"), dict):
        old = previous["macro"]["riskFree"]

    def previous_entry(key: str) -> dict[str, Any] | None:
        entry = old.get(key)
        if isinstance(entry, dict) and plausible_yield(entry.get("yield")) and is_iso_date(entry.get("asOf")):
            return entry
        return None

    try:
        usd = fetch_us_10y(settings)
    except Exception as exc:  # noqa: BLE001
        warn(f"US 10-year yield unavailable ({str(exc)[:160]})")
        kept = previous_entry("USD")
        usd = ({**{k: kept.get(k) for k in RISK_FREE_KEYS}, "status": "stale"} if kept
               else risk_free_entry("US 10-year Treasury yield", US_10Y_SYMBOL, None, None, None, "unavailable"))

    try:
        sgd = fetch_sg_10y(settings, now_utc)
    except Exception as exc:  # noqa: BLE001
        warn(f"Singapore 10-year yield unavailable from MAS ({str(exc)[:160]})")
        kept = previous_entry("SGD")
        recent = False
        if kept and kept.get("source") == "mas":
            age = now_utc.date() - datetime.strptime(kept["asOf"], "%Y-%m-%d").date()
            recent = age.days <= MAS_STALE_LIMIT_DAYS
        if recent:
            sgd = {**{k: kept.get(k) for k in RISK_FREE_KEYS}, "status": "stale"}
        elif usd["yield"] is not None:
            sgd = risk_free_entry("US 10-year Treasury yield (proxy for Singapore)", usd["symbol"],
                                  usd["yield"], usd["asOf"], usd["source"], "proxy")
        else:
            sgd = risk_free_entry("Singapore 10-year SGS benchmark yield", None, None, None, None, "unavailable")
    return {"riskFree": {"USD": usd, "SGD": sgd}}


# --------------------------------------------------------------------------- #
# Market regime: the VIX term structure
# --------------------------------------------------------------------------- #

def classify_regime(vix: float, vix3m: float, rules: dict[str, float] = REGIME_RULES) -> str:
    """normal | elevated | stressed, from the VIX level and the VIX ÷ VIX3M ratio.

    stressed  the ratio is at or above `invertedRatio`: the curve is inverted
    normal    VIX below `elevatedLevel` and the ratio below `elevatedRatio`
    elevated  everything in between

    The browser applies the same rules (read from the block) to the same stored
    levels, and a test checks that the two agree on the committed snapshot.
    """
    ratio = vix / vix3m
    if ratio >= rules["invertedRatio"]:
        return "stressed"
    if vix < rules["elevatedLevel"] and ratio < rules["elevatedRatio"]:
        return "normal"
    return "elevated"


def plausible_level(value: Any) -> bool:
    return is_finite_number(value) and REGIME_LEVEL_BOUNDS[0] <= value <= REGIME_LEVEL_BOUNDS[1]


def empty_regime(note: str) -> dict[str, Any]:
    return {"status": "unavailable", "asOf": None, "source": None, "symbols": dict(REGIME_SYMBOLS),
            "levels": {key: None for key in REGIME_LEVEL_KEYS}, "slope": None, "ratio": None, "frontRatio": None,
            "state": None, "inverted": None, "invertedStreak": None, "rules": dict(REGIME_RULES),
            "historyFields": list(REGIME_HISTORY_FIELDS), "history": [], "note": note}


def regime_closes(frame: pd.DataFrame, now_utc: datetime, early_closes: frozenset[str] = frozenset()) -> dict[str, float]:
    """Completed daily closes of one VIX index by date. Today's value is dropped until the
    US close (1:00 p.m. on a half day) plus the usual buffer: before then it is an intraday level."""
    closes: dict[str, float] = {}
    for stamp, value in frame["Close"].items():
        level = clean_number(value, digits=2)
        if plausible_level(level):
            closes[stamp.strftime("%Y-%m-%d")] = level
    new_york = pd.Timestamp(now_utc).tz_convert(MARKET_TIMEZONES["US"])
    today = new_york.strftime("%Y-%m-%d")
    close_at = session_close("US", today, early_closes)
    if today in closes and new_york.hour * 60 + new_york.minute < close_at.hour * 60 + close_at.minute + CLOSE_BUFFER_MINUTES:
        del closes[today]
    return closes


def regime_block(series: dict[str, dict[str, float]]) -> dict[str, Any]:
    """The regime block from completed closes by role ('short', 'mid', 'long').

    VIX and VIX3M decide the state and must share dates; VIX9D is context and may be
    missing on some days (or entirely), in which case it is null there.
    """
    mid, long_ = series.get("mid") or {}, series.get("long") or {}
    short = series.get("short") or {}
    dates = sorted(set(mid) & set(long_))[-REGIME_HISTORY_MAX_ROWS:]
    if not dates:
        raise FetchError("VIX and VIX3M have no completed sessions in common")
    history = [[day, short.get(day), mid[day], long_[day]] for day in dates]
    as_of, vix9d, vix, vix3m = history[-1]
    state = classify_regime(vix, vix3m)
    streak = 0
    for row in reversed(history):
        if row[2] / row[3] < REGIME_RULES["invertedRatio"]:
            break
        streak += 1
    return {
        "status": "fresh", "asOf": as_of, "source": "yahoo", "symbols": dict(REGIME_SYMBOLS),
        "levels": {"vix9d": vix9d, "vix": vix, "vix3m": vix3m},
        "slope": clean_number(vix3m - vix, digits=2),
        "ratio": clean_number(vix / vix3m, digits=6),
        "frontRatio": clean_number(vix9d / vix, digits=6) if vix9d is not None else None,
        "state": state, "inverted": state == "stressed", "invertedStreak": streak,
        "rules": dict(REGIME_RULES), "historyFields": list(REGIME_HISTORY_FIELDS), "history": history,
        "note": None if vix9d is not None else "VIX9D has no close for the latest session, so the front of the curve is not shown.",
    }


def fetch_regime(settings: argparse.Namespace, now_utc: datetime) -> dict[str, Any]:
    """Five years of VIX9D, VIX and VIX3M closes: three requests sharing one deadline."""
    deadline = time.monotonic() + settings.macro_timeout
    series: dict[str, dict[str, float]] = {}
    for role, symbol in REGIME_SYMBOLS.items():
        try:
            frame = with_retry(f"{symbol} level",
                               lambda symbol=symbol: fetch_history(symbol, REGIME_HISTORY_PERIOD, "1d", settings.request_timeout),
                               settings.max_retries, settings.retry_delay, deadline)
            series[role] = regime_closes(frame, now_utc, getattr(settings, "early_closes", {}).get("US", frozenset()))
        except Exception as exc:  # noqa: BLE001
            if role != "short":
                raise FetchError(f"{symbol} unavailable: {str(exc)[:160]}") from exc
            warn(f"{symbol} unavailable ({str(exc)[:160]}); the regime is classified without it")
            series[role] = {}
    return regime_block(series)


def build_regime(previous: dict[str, Any] | None, settings: argparse.Namespace, now_utc: datetime,
                 fetcher: Callable[[argparse.Namespace, datetime], dict[str, Any]] | None = None) -> dict[str, Any]:
    """The market regime. Never raises: a fresh reading -> the previous one (stale, if at most
    five days old) -> unavailable."""
    try:
        block = (fetcher or fetch_regime)(settings, now_utc)
        errors = validate_regime(block)
        if errors:
            raise FetchError("; ".join(errors[:3]))
        return block
    except Exception as exc:  # noqa: BLE001
        warn(f"market regime unavailable ({type(exc).__name__}: {str(exc)[:160]})")
    macro = previous.get("macro") if isinstance(previous, dict) else None
    old = macro.get("regime") if isinstance(macro, dict) else None
    if isinstance(old, dict) and not validate_regime(old) and old["status"] != "unavailable":
        age = (now_utc.date() - date.fromisoformat(old["asOf"])).days
        if age <= REGIME_STALE_LIMIT_DAYS:
            return {**old, "status": "stale", "note": "The VIX curve could not be refreshed in this run; this is the previous reading."}
    return empty_regime("The VIX curve could not be read in this run.")


# --------------------------------------------------------------------------- #
# Macro calendar: FOMC, CPI and market holidays (kept by hand, copied every run)
# --------------------------------------------------------------------------- #

def new_york_offset(day: str, hhmm: str) -> str:
    """The UTC offset of New York at a local date and time, as "-05:00" or "-04:00"."""
    stamp = pd.Timestamp(f"{day} {hhmm}").tz_localize(MARKET_TIMEZONES["US"])
    minutes = int(stamp.utcoffset().total_seconds() // 60)
    sign = "-" if minutes < 0 else "+"
    return f"{sign}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"


def meeting_days(meeting: Any) -> tuple[date, date] | None:
    """'2026-12-08/09' -> (8 Dec 2026, 9 Dec 2026); None if malformed or not consecutive."""
    match = MEETING_RE.match(meeting) if isinstance(meeting, str) else None
    if not match:
        return None
    try:
        first = date.fromisoformat(match.group(1))
    except ValueError:
        return None
    second = first + timedelta(days=1)
    return (first, second) if second.day == int(match.group(2)) else None


def validate_calendar_event(event: Any, where: str) -> list[str]:
    if not isinstance(event, dict) or event.get("type") not in CALENDAR_TYPES:
        return [f"{where} must be an object with a type in {sorted(CALENDAR_TYPES)}"]
    required, optional, local_time = CALENDAR_TYPES[event["type"]]
    keys = set(event) - {"type", "date"}
    errors: list[str] = []
    if not is_iso_date(event.get("date")):
        return [f"{where}.date must be an ISO date"]
    if not required <= keys or not keys <= required | optional:
        return [f"{where} ({event['type']}) must have {sorted(required)} and may have {sorted(optional)}"]
    day = date.fromisoformat(event["date"])
    if day.weekday() >= 5:
        errors.append(f"{where} falls on a weekend")
    if local_time is not None:
        expected = f"{event['date']}T{local_time}:00{new_york_offset(event['date'], local_time)}"
        if event["at"] != expected:
            errors.append(f"{where}.at must be {expected} (New York time with its UTC offset)")
    if event["type"] == "market-early-close" and event.get("market") in EARLY_CLOSE:
        expected = early_close_at(event["market"], event["date"])
        if event["at"] != expected:
            errors.append(f"{where}.at must be {expected} (the market's half-day close with its UTC offset)")
    if "meeting" in event:
        days = meeting_days(event["meeting"])
        if days is None:
            errors.append(f"{where}.meeting must look like 2026-12-08/09 (two consecutive days)")
        elif event["type"] in {"fomc-decision", "fomc-meeting"} and days[1] != day:
            errors.append(f"{where} must fall on the second day of its meeting")
        elif event["type"] == "fomc-minutes" and day <= days[1]:
            errors.append(f"{where}: minutes come after the meeting")
    if event["type"] == "fomc-meeting" and event.get("decision") is not False:
        errors.append(f"{where}: an fomc-meeting entry is a meeting without a decision (decision: false)")
    for flag in ("projections", "derived"):
        if flag in event and event[flag] is not True:
            errors.append(f"{where}.{flag} must be true when present")
    if event["type"] == "cpi" and not (isinstance(event["period"], str) and PERIOD_RE.match(event["period"])
                                         and event["period"] < event["date"][:7]):
        errors.append(f"{where}.period must be an earlier month, like 2026-11")
    if "market" in event and event["market"] not in CALENDAR_MARKETS:
        errors.append(f"{where}.market must be one of {sorted(CALENDAR_MARKETS)}")
    if "name" in event and not (isinstance(event["name"], str) and event["name"].strip()):
        errors.append(f"{where}.name must be a non-empty string")
    return errors


def validate_calendar_events(events: Any, coverage: dict[str, str], where: str) -> list[str]:
    if not isinstance(events, list):
        return [f"{where} must be a list"]
    errors: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    last_day = ""
    decisions: dict[str, date] = {}
    for index, event in enumerate(events):
        here = f"{where}[{index}]"
        problems = validate_calendar_event(event, here)
        if problems:
            errors.extend(problems)
            continue
        if event["date"] < last_day:
            errors.append(f"{here} is out of date order")
        last_day = event["date"]
        if not coverage["from"] <= event["date"] <= coverage["to"]:
            errors.append(f"{here} lies outside the coverage {coverage['from']} to {coverage['to']}")
        key = (event["type"], event["date"], event.get("market", ""))
        if key in seen:
            errors.append(f"{here} duplicates another {event['type']} on {event['date']}")
        seen.add(key)
        if event["type"] == "fomc-decision":
            decisions[event["meeting"]] = date.fromisoformat(event["date"])
        if event["type"] == "fomc-minutes" and event.get("derived"):
            decided = decisions.get(event["meeting"])
            if decided is not None and date.fromisoformat(event["date"]) != decided + timedelta(days=CALENDAR_MINUTES_LAG):
                errors.append(f"{here}: derived minutes must be {CALENDAR_MINUTES_LAG} days after the decision")
    return errors


def validate_coverage(coverage: Any, where: str) -> list[str]:
    if not (isinstance(coverage, dict) and sorted(coverage) == ["from", "to"] and is_iso_date(coverage.get("from"))
            and is_iso_date(coverage.get("to")) and coverage["from"] <= coverage["to"]):
        return [f"{where} must be {{from, to}} ISO dates in order"]
    return []


def validate_macro_calendar(calendar: Any) -> list[str]:
    """The hand-kept file. Coverage is judged against the file's own `updated` date, never
    today's, so the tests do not start failing just because time passes."""
    if not isinstance(calendar, dict) or sorted(calendar) != sorted(CALENDAR_FILE_KEYS):
        return [f"macro_calendar.json must contain exactly {CALENDAR_FILE_KEYS}"]
    errors = validate_coverage(calendar["coverage"], "coverage")
    if not is_iso_date(calendar["updated"]):
        errors.append("updated must be an ISO date")
    if not (isinstance(calendar["sources"], dict) and calendar["sources"]
            and all(isinstance(url, str) and url.startswith("https://") for url in calendar["sources"].values())):
        errors.append("sources must map names to https URLs")
    if not (isinstance(calendar["notes"], list) and all(isinstance(note, str) for note in calendar["notes"])):
        errors.append("notes must be a list of strings")
    if errors:
        return errors
    errors.extend(validate_calendar_events(calendar["events"], calendar["coverage"], "events"))
    horizon = date.fromisoformat(calendar["updated"]) + timedelta(days=CALENDAR_WARN_DAYS)
    if date.fromisoformat(calendar["coverage"]["to"]) < horizon:
        errors.append(f"coverage must reach at least {CALENDAR_WARN_DAYS} days past the updated date")
    return errors


def empty_calendar(note: str) -> dict[str, Any]:
    return {"status": "unavailable", "updated": None, "coverage": None, "events": [], "note": note}


def build_calendar(path: Path, now_utc: datetime) -> dict[str, Any]:
    """macro.calendar for the snapshot. Never raises: an unreadable or invalid file gives an
    unavailable block and a warning, never a failed run."""
    try:
        calendar = load_json(path)
    except (OSError, ValueError) as exc:
        warn(f"macro calendar unreadable ({exc}); the snapshot has no macro calendar")
        return empty_calendar("The macro calendar could not be read.")
    errors = validate_macro_calendar(calendar)
    if errors:
        warn(f"macro calendar invalid ({'; '.join(errors[:3])}); the snapshot has no macro calendar")
        return empty_calendar("The macro calendar file is invalid.")
    today = now_utc.date()
    since = (today - timedelta(days=CALENDAR_LOOKBACK_DAYS)).isoformat()
    events = [event for event in calendar["events"] if event["date"] >= since]
    note = None
    if date.fromisoformat(calendar["coverage"]["to"]) < today + timedelta(days=CALENDAR_WARN_DAYS):
        note = (f"The macro calendar runs out on {calendar['coverage']['to']}: "
                "add the next year's dates to scripts/macro_calendar.json.")
        warn(note)
    return {"status": "fresh", "updated": calendar["updated"], "coverage": dict(calendar["coverage"]), "events": events, "note": note}


def validate_calendar_block(block: Any) -> list[str]:
    where = "macro.calendar"
    if not isinstance(block, dict) or sorted(block) != sorted(CALENDAR_BLOCK_KEYS):
        return [f"{where} must contain exactly the documented keys"]
    if block["status"] not in {"fresh", "unavailable"}:
        return [f"{where}.status must be fresh or unavailable"]
    if block["note"] is not None and not isinstance(block["note"], str):
        return [f"{where}.note must be a string or null"]
    if block["status"] == "unavailable":
        return [] if block["events"] == [] and block["coverage"] is None else [f"{where} must carry no events when unavailable"]
    errors = validate_coverage(block["coverage"], f"{where}.coverage")
    if not is_iso_date(block["updated"]):
        errors.append(f"{where}.updated must be an ISO date")
    if errors:
        return errors
    return validate_calendar_events(block["events"], block["coverage"], f"{where}.events")


def calendar_summary(block: Any, now_utc: datetime) -> str:
    """Next FOMC decision and CPI release, for logs and the step summary."""
    if not isinstance(block, dict) or block.get("status") != "fresh":
        return "unavailable"
    now_iso = now_utc.isoformat()
    parts = []
    for kind, label in (("fomc-decision", "FOMC"), ("cpi", "CPI")):
        upcoming = [event for event in block["events"] if event["type"] == kind
                    and pd.Timestamp(event["at"]).tz_convert("UTC").isoformat() > now_iso]
        parts.append(f"{label} {upcoming[0]['date']}" if upcoming else f"{label} none listed")
    return f"next {' · '.join(parts)} (covers to {block['coverage']['to']})" + (" · NEEDS UPDATING" if block["note"] else "")


def fetch_fx(config: dict[str, str], previous: dict[str, Any] | None, settings: argparse.Namespace) -> dict[str, Any]:
    """Latest USD/SGD rate plus one year of daily closes (for multi-currency portfolio maths)."""
    symbol = config["yahooSymbol"]
    deadline = time.monotonic() + settings.macro_timeout
    try:
        # Five years, like the asset history, so a 5-year portfolio converts each day at that day's rate.
        history = with_retry(f"{symbol} FX rate", lambda: fetch_history(symbol, FX_HISTORY_PERIOD, "1d", settings.request_timeout),
                             settings.max_retries, settings.retry_delay, deadline)
        closes = history["Close"].dropna()
        series_by_date: dict[str, float] = {}
        for stamp, value in closes.items():
            rate = clean_number(value, digits=5)
            if rate is not None and 0.5 <= rate <= 3:
                series_by_date[stamp.strftime("%Y-%m-%d")] = rate
        series = [[date, series_by_date[date]] for date in sorted(series_by_date)]
        if not series:
            raise FetchError(f"{symbol} returned no plausible rates")
        return {"base": config["base"], "quote": config["quote"], "rate": series[-1][1],
                "asOf": series[-1][0], "series": series}
    except FetchError as exc:
        old = previous.get("fx") if previous else None
        if isinstance(old, dict) and is_finite_number(old.get("rate")):
            warn(f"FX rate unavailable ({exc}); keeping the previous rate")
            return {"base": old.get("base"), "quote": old.get("quote"), "rate": old["rate"],
                    "asOf": old.get("asOf"), "series": old.get("series") if isinstance(old.get("series"), list) else []}
        raise


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #

def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_iso_date(value: Any) -> bool:
    if not isinstance(value, str) or not DATE_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def validate_news(news: Any) -> list[str]:
    if not isinstance(news, dict) or sorted(news) != sorted(NEWS_KEYS):
        return ["news must contain exactly the documented keys"]
    errors: list[str] = []
    if news["status"] not in SECTION_STATUSES:
        errors.append(f"news.status must be one of {sorted(SECTION_STATUSES)}")
    for key in ("fetchedAt", "newestAt"):
        if news[key] is not None and parse_timestamp(news[key]) is None:
            errors.append(f"news.{key} must be an ISO-8601 UTC timestamp or null")
    for key in ("headlineCount", "clusterCount"):
        if not isinstance(news[key], int) or isinstance(news[key], bool) or news[key] < 0:
            errors.append(f"news.{key} must be a non-negative integer")
    if news["note"] is not None and not isinstance(news["note"], str):
        errors.append("news.note must be a string or null")

    clusters = news["clusters"]
    if not isinstance(clusters, list) or len(clusters) > NEWS_SCORED_CLUSTERS:
        return errors + [f"news.clusters must be a list of at most {NEWS_SCORED_CLUSTERS} stories"]
    if news["status"] == "unavailable" and clusters:
        errors.append("an unavailable news block must not carry stories")
    for index, cluster in enumerate(clusters):
        where = f"news.clusters[{index}]"
        if not isinstance(cluster, dict) or sorted(cluster) != sorted(CLUSTER_KEYS):
            errors.append(f"{where} must contain exactly the documented keys")
            continue
        if not isinstance(cluster["title"], str) or not cluster["title"].strip() or len(cluster["title"]) > NEWS_TITLE_LIMIT:
            errors.append(f"{where}.title must be a non-empty string of at most {NEWS_TITLE_LIMIT} characters")
        if cluster["link"] is not None and not (isinstance(cluster["link"], str) and cluster["link"].startswith("https://")):
            errors.append(f"{where}.link must be an https URL or null")
        first = parse_timestamp(cluster["firstSeenAt"])
        last = parse_timestamp(cluster["publishedAt"])
        if first is None or last is None or first > last:
            errors.append(f"{where} needs firstSeenAt <= publishedAt as ISO-8601 UTC timestamps")
        if not isinstance(cluster["duplicates"], int) or isinstance(cluster["duplicates"], bool) or cluster["duplicates"] < 0:
            errors.append(f"{where}.duplicates must be a non-negative integer")
        scores = cluster["scores"]
        if scores is None:
            if cluster["label"] is not None:
                errors.append(f"{where}.label must be null when there are no scores")
        elif (not isinstance(scores, dict) or sorted(scores) != ["compound", "neg", "neu", "pos"]
              or not all(is_finite_number(v) for v in scores.values())
              or not -1 <= scores["compound"] <= 1
              or not all(0 <= scores[k] <= 1 for k in ("pos", "neu", "neg"))):
            errors.append(f"{where}.scores must hold compound in [-1, 1] and pos, neu, neg in [0, 1]")
        elif cluster["label"] not in SENTIMENT_LABELS:
            errors.append(f"{where}.label must be one of {sorted(SENTIMENT_LABELS)}")

    sentiment = news["sentiment"]
    if sentiment is not None:
        if (not isinstance(sentiment, dict) or sorted(sentiment) != ["basis", "compound", "label"]
                or not is_finite_number(sentiment["compound"]) or not -1 <= sentiment["compound"] <= 1
                or sentiment["label"] not in SENTIMENT_LABELS
                or not isinstance(sentiment["basis"], int) or not 1 <= sentiment["basis"] <= NEWS_SCORED_CLUSTERS):
            errors.append("news.sentiment must hold compound in [-1, 1], a label and a basis of 1 to 3")
    return errors


def validate_forecast(forecast: Any) -> list[str]:
    if not isinstance(forecast, dict) or sorted(forecast) != sorted(FORECAST_KEYS):
        return ["forecast must contain exactly the documented keys"]
    errors: list[str] = []
    if forecast["status"] not in SECTION_STATUSES:
        errors.append(f"forecast.status must be one of {sorted(SECTION_STATUSES)}")
    if forecast["note"] is not None and not isinstance(forecast["note"], str):
        errors.append("forecast.note must be a string or null")
    points = forecast["points"]
    if not isinstance(points, list):
        return errors + ["forecast.points must be a list"]
    if forecast["status"] == "unavailable":
        if points:
            errors.append("an unavailable forecast must not carry points")
        return errors
    if not points:
        errors.append("an available forecast needs at least one point")
    for key in ("model", "modelVersion"):
        if not isinstance(forecast[key], str) or not forecast[key]:
            errors.append(f"forecast.{key} must be a non-empty string")
    for key in ("config", "trainedOn", "horizon", "backtest"):
        if not isinstance(forecast[key], dict):
            errors.append(f"forecast.{key} must be an object")
    if len(points) > FORECAST_HORIZON_DAYS:
        errors.append(f"forecast.points must not exceed the {FORECAST_HORIZON_DAYS}-day horizon")
    backtest = forecast["backtest"]
    if isinstance(backtest, dict):
        for key in ("mape", "naiveMape", "coverage"):
            value = backtest.get(key)
            if value is not None and (not is_finite_number(value) or value < 0):
                errors.append(f"forecast.backtest.{key} must be a non-negative number or null")
        end_error = backtest.get("endError")
        if end_error is not None and not is_finite_number(end_error):
            errors.append("forecast.backtest.endError must be a finite number or null")
    previous_date = ""
    for index, row in enumerate(points):
        if not isinstance(row, list) or len(row) != len(FORECAST_FIELDS):
            errors.append(f"forecast.points[{index}] must have {len(FORECAST_FIELDS)} fields")
            break
        date, yhat, lower, upper = row
        if not is_iso_date(date) or date <= previous_date:
            errors.append(f"forecast.points must be strictly ascending by date (at index {index})")
            break
        previous_date = date
        if not all(is_finite_number(v) and v > 0 for v in (yhat, lower, upper)) or not lower <= yhat <= upper:
            errors.append(f"forecast point {date} needs 0 < lower <= yhat <= upper")
            break
    return errors


def validate_history(history: Any, first_candle: str | None) -> list[str]:
    if not isinstance(history, list):
        return ["history must be a list"]
    if len(history) > HISTORY_MAX_ROWS:
        return [f"history has more than {HISTORY_MAX_ROWS} rows"]
    previous_date = ""
    for row in history:
        ok = (isinstance(row, list) and len(row) == len(HISTORY_FIELDS) and is_iso_date(row[0])
              and row[0] > previous_date and is_finite_number(row[1]) and row[1] > 0)
        if not ok:
            return ["history rows must be [date, close], strictly ascending, with positive closes"]
        previous_date = row[0]
    if history and first_candle:
        if previous_date >= first_candle:
            return ["history must end before the first candle"]
        gap = (date.fromisoformat(first_candle) - date.fromisoformat(previous_date)).days
        if gap > SPLICE_MAX_GAP_DAYS:
            return [f"history ends {gap} days before the first candle (at most {SPLICE_MAX_GAP_DAYS} allowed)"]
    return []


def validate_dividends(dividends: Any) -> list[str]:
    if not isinstance(dividends, list) or len(dividends) > DIVIDEND_MAX_ROWS:
        return [f"dividends must be a list of at most {DIVIDEND_MAX_ROWS} rows"]
    previous_date = ""
    for row in dividends:
        ok = (isinstance(row, list) and len(row) == 2 and is_iso_date(row[0]) and row[0] > previous_date
              and is_finite_number(row[1]) and row[1] > 0)
        if not ok:
            return ["dividends rows must be [ex-date, amount], strictly ascending, with positive amounts"]
        previous_date = row[0]
    return []


def validate_events(events: Any) -> list[str]:
    if not isinstance(events, dict) or sorted(events) != sorted(EVENTS_KEYS):
        return ["events must contain exactly the documented keys"]
    errors: list[str] = []
    if events["status"] not in SECTION_STATUSES:
        errors.append(f"events.status must be one of {sorted(SECTION_STATUSES)}")
    if events["fetchedAt"] is not None and parse_timestamp(events["fetchedAt"]) is None:
        errors.append("events.fetchedAt must be an ISO-8601 UTC timestamp or null")
    if events["note"] is not None and not isinstance(events["note"], str):
        errors.append("events.note must be a string or null")
    upcoming = events["nextEarnings"]
    if upcoming is not None:
        if not isinstance(upcoming, dict) or sorted(upcoming) != ["date", "dateTo", "timing"]:
            errors.append("events.nextEarnings must contain date, dateTo and timing")
        elif (not is_iso_date(upcoming["date"]) or upcoming["timing"] not in EARNINGS_TIMINGS
              or (upcoming["dateTo"] is not None and (not is_iso_date(upcoming["dateTo"]) or upcoming["dateTo"] <= upcoming["date"]))):
            errors.append("events.nextEarnings has an invalid date, dateTo or timing")
    ex_dividend = events["nextExDividend"]
    if ex_dividend is not None and (not isinstance(ex_dividend, dict) or sorted(ex_dividend) != ["date"]
                                    or not is_iso_date(ex_dividend["date"])):
        errors.append("events.nextExDividend must be {date} or null")
    earnings = events["earnings"]
    if not isinstance(earnings, list) or len(earnings) > EVENTS_MAX_PAST:
        errors.append(f"events.earnings must be a list of at most {EVENTS_MAX_PAST} entries")
    else:
        previous_date = "9999-12-31"
        for item in earnings:
            if (not isinstance(item, dict) or sorted(item) != ["date", "timing"] or not is_iso_date(item["date"])
                    or item["date"] >= previous_date or item["timing"] not in EARNINGS_TIMINGS):
                errors.append("events.earnings entries must be {date, timing}, newest first, without repeats")
                break
            previous_date = item["date"]
    if events["status"] == "unavailable" and (upcoming is not None or ex_dividend is not None or earnings):
        errors.append("unavailable events may not carry dates")
    if events["status"] != "unavailable" and events["fetchedAt"] is None:
        errors.append("events that were fetched need a fetchedAt timestamp")
    return errors


def validate_asset(asset: Any) -> list[str]:
    if not isinstance(asset, dict):
        return ["asset is not an object"]
    label = str(asset.get("ticker", "<no ticker>"))
    errors: list[str] = []

    def err(message: str) -> None:
        errors.append(f"{label}: {message}")

    missing = [key for key in ASSET_KEYS if key not in asset]
    if missing:
        err(f"missing keys {missing}")
        return errors

    if not isinstance(asset["ticker"], str) or not TICKER_RE.match(asset["ticker"]):
        err("ticker must be an upper-case symbol")
    if not isinstance(asset["name"], str) or not asset["name"].strip():
        err("name must be a non-empty string")
    if asset["assetClass"] not in ASSET_CLASSES:
        err(f"assetClass must be one of {sorted(ASSET_CLASSES)}")
    if asset["market"] not in MARKETS:
        err(f"market must be one of {sorted(MARKETS)}")
    for key in ("currency", "financialCurrency"):
        if not isinstance(asset[key], str) or not CURRENCY_RE.match(asset[key]):
            err(f"{key} must be a 3-letter ISO code (got {asset[key]!r})")
    if asset["scoringProfile"] not in PROFILES:
        err(f"scoringProfile must be one of {sorted(PROFILES)}")
    required = CLASS_PROFILES.get(asset["assetClass"])
    if required is not None and asset["scoringProfile"] != required:
        err(f"{asset['assetClass']} assets must use the {required} scoring profile")
    if asset["assetClass"] == "equity" and asset["scoringProfile"] not in EQUITY_PROFILES:
        err(f"equities must use one of the {sorted(EQUITY_PROFILES)} scoring profiles")
    if asset["assetClass"] == "crypto" and (not isinstance(asset["binanceSymbol"], str) or not asset["binanceSymbol"]):
        err("crypto assets need a binanceSymbol")
    for key in ("sector", "industry", "statusNote", "fundamentalsPeriod", "binanceSymbol"):
        if asset[key] is not None and not isinstance(asset[key], str):
            err(f"{key} must be a string or null")
    if not is_finite_number(asset["lotSize"]) or asset["lotSize"] <= 0:
        err("lotSize must be a positive number")
    if asset["status"] not in STATUSES:
        err(f"status must be one of {sorted(STATUSES)}")

    fundamentals = asset["fundamentals"]
    if not isinstance(fundamentals, dict) or sorted(fundamentals) != sorted(FUNDAMENTAL_KEYS):
        err("fundamentals must contain exactly the documented keys")
    else:
        for key, value in fundamentals.items():
            if value is not None and not is_finite_number(value):
                err(f"fundamentals.{key} must be a finite number or null (got {value!r})")

    for message in (validate_news(asset["news"]) + validate_forecast(asset["forecast"])
                    + validate_events(asset["events"]) + validate_dividends(asset["dividends"])):
        err(message)

    candles = asset["candles"]
    if not isinstance(candles, list) or len(candles) < MIN_CANDLES:
        count = len(candles) if isinstance(candles, list) else 0
        err(f"needs at least {MIN_CANDLES} candles (has {count})")
        return errors
    previous_date = ""
    for index, row in enumerate(candles):
        if not isinstance(row, list) or len(row) != len(CANDLE_FIELDS):
            err(f"candle {index} must have {len(CANDLE_FIELDS)} fields")
            break
        date, open_, high, low, close, volume = row
        if not is_iso_date(date):
            err(f"candle {index} has an invalid date {date!r}")
            break
        if date <= previous_date:
            err(f"candles must be strictly ascending by date (at {date})")
            break
        previous_date = date
        if not all(is_finite_number(p) and p > 0 for p in (open_, high, low, close)):
            err(f"candle {date} has a non-positive or non-finite price")
            break
        if high < max(open_, close) or low > min(open_, close) or high < low:
            err(f"candle {date} violates high >= max(open, close) / low <= min(open, close)")
            break
        if not is_finite_number(volume) or volume < 0:
            err(f"candle {date} has an invalid volume")
            break
    first_candle = candles[0][0] if candles and isinstance(candles[0], list) and candles[0] else None
    for message in validate_history(asset["history"], first_candle if is_iso_date(first_candle) else None):
        err(message)

    quote = asset["quote"]
    if not isinstance(quote, dict) or sorted(quote) != ["asOf", "lastClose", "previousClose"]:
        err("quote must contain lastClose, previousClose and asOf")
    elif not errors:
        if quote["asOf"] != candles[-1][0]:
            err("quote.asOf must equal the last candle date")
        if quote["lastClose"] != candles[-1][4]:
            err("quote.lastClose must equal the last candle close")
        if quote["previousClose"] != candles[-2][4]:
            err("quote.previousClose must equal the second-to-last candle close")
    return errors


def validate_macro(macro: Any) -> list[str]:
    if not isinstance(macro, dict) or not isinstance(macro.get("riskFree"), dict):
        return ["macro.riskFree must be an object"]
    errors: list[str] = []
    rates = macro["riskFree"]
    if sorted(rates) != ["SGD", "USD"]:
        return ["macro.riskFree must contain exactly USD and SGD"]
    for currency, entry in rates.items():
        where = f"macro.riskFree.{currency}"
        if not isinstance(entry, dict) or sorted(entry) != sorted(RISK_FREE_KEYS):
            errors.append(f"{where} must contain exactly the documented keys")
            continue
        if entry["status"] not in RISK_FREE_STATUSES:
            errors.append(f"{where}.status must be one of {sorted(RISK_FREE_STATUSES)}")
        if not isinstance(entry["name"], str) or not entry["name"]:
            errors.append(f"{where}.name must be a non-empty string")
        if entry["status"] == "unavailable":
            if entry["yield"] is not None:
                errors.append(f"{where}.yield must be null when the rate is unavailable")
        elif not plausible_yield(entry["yield"]) or not is_iso_date(entry["asOf"]):
            errors.append(f"{where} needs a plausible yield and an asOf date")
    # Optional, so that a snapshot written before V3.1 still validates; the pipeline always writes it.
    if "regime" in macro:
        errors.extend(validate_regime(macro["regime"]))
    # Likewise the macro calendar (V3.2).
    if "calendar" in macro:
        errors.extend(validate_calendar_block(macro["calendar"]))
    return errors


def validate_regime(regime: Any) -> list[str]:
    where = "macro.regime"
    if not isinstance(regime, dict) or sorted(regime) != sorted(REGIME_KEYS):
        return [f"{where} must contain exactly the documented keys"]
    errors: list[str] = []
    if regime["status"] not in SECTION_STATUSES:
        errors.append(f"{where}.status must be one of {sorted(SECTION_STATUSES)}")
    if regime["symbols"] != REGIME_SYMBOLS:
        errors.append(f"{where}.symbols must name ^VIX9D, ^VIX and ^VIX3M")
    if regime["historyFields"] != REGIME_HISTORY_FIELDS:
        errors.append(f"{where}.historyFields must be {REGIME_HISTORY_FIELDS}")
    if regime["note"] is not None and not isinstance(regime["note"], str):
        errors.append(f"{where}.note must be a string or null")
    rules = regime["rules"]
    if not isinstance(rules, dict) or sorted(rules) != sorted(REGIME_RULES) \
            or not all(is_finite_number(rules[key]) and rules[key] > 0 for key in rules):
        return errors + [f"{where}.rules must hold the three positive thresholds"]
    history = regime["history"]
    if not isinstance(history, list) or len(history) > REGIME_HISTORY_MAX_ROWS:
        errors.append(f"{where}.history must be a list of at most {REGIME_HISTORY_MAX_ROWS} rows")
        history = []
    last_day = ""
    for row in history:
        if not (isinstance(row, list) and len(row) == 4 and is_iso_date(row[0]) and row[0] > last_day
                and plausible_level(row[2]) and plausible_level(row[3]) and (row[1] is None or plausible_level(row[1]))):
            errors.append(f"{where}.history rows must be ascending [date, vix9d or null, vix, vix3m] with plausible levels")
            break
        last_day = row[0]
    levels = regime["levels"]
    if not isinstance(levels, dict) or sorted(levels) != sorted(REGIME_LEVEL_KEYS):
        return errors + [f"{where}.levels must contain exactly {REGIME_LEVEL_KEYS}"]
    reading = ("asOf", "source", "slope", "ratio", "frontRatio", "state", "inverted", "invertedStreak")
    if regime["status"] == "unavailable":
        if any(value is not None for value in levels.values()) or any(regime[key] is not None for key in reading):
            errors.append(f"{where} must carry no reading when it is unavailable")
        return errors
    vix9d, vix, vix3m = levels["vix9d"], levels["vix"], levels["vix3m"]
    if not (is_iso_date(regime["asOf"]) and plausible_level(vix) and plausible_level(vix3m)
            and (vix9d is None or plausible_level(vix9d))):
        return errors + [f"{where} needs an asOf date and plausible VIX and VIX3M levels"]
    if not history or history[-1] != [regime["asOf"], vix9d, vix, vix3m]:
        errors.append(f"{where}.history must end with the reported levels")
    if not (is_finite_number(regime["slope"]) and abs(regime["slope"] - (vix3m - vix)) < 0.006):
        errors.append(f"{where}.slope must be VIX3M − VIX")
    if not (is_finite_number(regime["ratio"]) and abs(regime["ratio"] - vix / vix3m) < 1e-6):
        errors.append(f"{where}.ratio must be VIX ÷ VIX3M")
    front = regime["frontRatio"]
    if vix9d is None:
        if front is not None:
            errors.append(f"{where}.frontRatio must be null without VIX9D")
    elif not (is_finite_number(front) and abs(front - vix9d / vix) < 1e-6):
        errors.append(f"{where}.frontRatio must be VIX9D ÷ VIX")
    expected = classify_regime(vix, vix3m, rules)
    if regime["state"] != expected:
        errors.append(f"{where}.state must be {expected} for these levels and rules")
    if regime["inverted"] is not (vix / vix3m >= rules["invertedRatio"]):
        errors.append(f"{where}.inverted must say whether VIX ÷ VIX3M reaches the inverted ratio")
    streak = regime["invertedStreak"]
    if not (isinstance(streak, int) and not isinstance(streak, bool) and 0 <= streak <= len(history)) \
            or (streak > 0) != bool(regime["inverted"]):
        errors.append(f"{where}.invertedStreak must count the inverted sessions ending at asOf")
    return errors


def validate_snapshot(snapshot: Any) -> list[str]:
    """Return a list of schema violations. An empty list means valid."""
    if not isinstance(snapshot, dict):
        return ["snapshot is not a JSON object"]
    errors: list[str] = []
    for key in ("schemaVersion", "generatedAt", "fx", "macro", "candleFields", "historyFields", "forecastFields", "assets"):
        if key not in snapshot:
            errors.append(f"missing top-level key '{key}'")
    if errors:
        return errors

    if snapshot["schemaVersion"] != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION}")
    if parse_timestamp(snapshot["generatedAt"]) is None:
        errors.append("generatedAt must be ISO-8601 UTC, e.g. 2026-01-31T22:30:00Z")
    if snapshot["candleFields"] != CANDLE_FIELDS:
        errors.append(f"candleFields must be {CANDLE_FIELDS}")
    if snapshot["forecastFields"] != FORECAST_FIELDS:
        errors.append(f"forecastFields must be {FORECAST_FIELDS}")
    if snapshot["historyFields"] != HISTORY_FIELDS:
        errors.append(f"historyFields must be {HISTORY_FIELDS}")

    fx = snapshot["fx"]
    if not isinstance(fx, dict) or sorted(fx) != ["asOf", "base", "quote", "rate", "series"]:
        errors.append("fx must contain base, quote, rate, asOf and series")
    else:
        if fx["base"] != "USD" or fx["quote"] != "SGD":
            errors.append("fx must be the USD/SGD pair")
        if not is_finite_number(fx["rate"]) or not 0.5 <= fx["rate"] <= 3:
            errors.append(f"fx.rate is implausible: {fx['rate']!r}")
        if not is_iso_date(fx["asOf"]):
            errors.append("fx.asOf must be an ISO date")
        if not isinstance(fx["series"], list):
            errors.append("fx.series must be a list")
        else:
            previous_date = ""
            for row in fx["series"]:
                ok = (isinstance(row, list) and len(row) == 2 and is_iso_date(row[0]) and row[0] > previous_date
                      and is_finite_number(row[1]) and 0.5 <= row[1] <= 3)
                if not ok:
                    errors.append("fx.series rows must be [date, rate], ascending, with plausible rates")
                    break
                previous_date = row[0]

    errors.extend(validate_macro(snapshot["macro"]))

    assets = snapshot["assets"]
    if not isinstance(assets, list) or not assets:
        errors.append("assets must be a non-empty list")
        return errors
    seen: set[str] = set()
    for asset in assets:
        errors.extend(validate_asset(asset))
        ticker = asset.get("ticker") if isinstance(asset, dict) else None
        if ticker in seen:
            errors.append(f"{ticker}: duplicate ticker")
        seen.add(ticker)
    return errors


def validate_watchlist(watchlist: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(watchlist, dict):
        return ["watchlist is not a JSON object"]
    history = watchlist.get("history")
    if not isinstance(history, dict) or not history.get("period") or not history.get("interval"):
        errors.append("watchlist.history needs 'period' and 'interval'")
    fx = watchlist.get("fx")
    if not isinstance(fx, dict) or any(not fx.get(k) for k in ("base", "quote", "yahooSymbol")):
        errors.append("watchlist.fx needs 'base', 'quote' and 'yahooSymbol'")
    assets = watchlist.get("assets")
    if not isinstance(assets, list) or not assets:
        errors.append("watchlist.assets must be a non-empty list")
        return errors
    seen: set[str] = set()
    for entry in assets:
        ticker = entry.get("ticker") if isinstance(entry, dict) else None
        if not isinstance(ticker, str) or not TICKER_RE.match(ticker):
            errors.append(f"invalid watchlist ticker: {ticker!r}")
            continue
        if ticker in seen:
            errors.append(f"{ticker}: listed twice")
        seen.add(ticker)
        if entry.get("assetClass") not in ASSET_CLASSES:
            errors.append(f"{ticker}: assetClass must be one of {sorted(ASSET_CLASSES)}")
        if entry.get("market") not in MARKETS:
            errors.append(f"{ticker}: market must be one of {sorted(MARKETS)}")
        if not isinstance(entry.get("currency"), str) or not CURRENCY_RE.match(entry["currency"]):
            errors.append(f"{ticker}: currency must be a 3-letter ISO code")
        if not is_finite_number(entry.get("lotSize")) or entry["lotSize"] <= 0:
            errors.append(f"{ticker}: lotSize must be a positive number")
        profile = entry.get("scoringProfile")
        if profile not in PROFILES | {None}:
            errors.append(f"{ticker}: scoringProfile must be null or one of {sorted(PROFILES)}")
        required = CLASS_PROFILES.get(entry.get("assetClass"))
        if required is not None and profile not in {None, required}:
            errors.append(f"{ticker}: {entry['assetClass']} assets always use the {required} profile")
        if entry.get("assetClass") == "equity" and profile not in EQUITY_PROFILES | {None}:
            errors.append(f"{ticker}: equities may only override to {sorted(EQUITY_PROFILES)}")
        if entry.get("assetClass") == "crypto" and not entry.get("binanceSymbol"):
            errors.append(f"{ticker}: crypto assets need a binanceSymbol")
    return errors


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

def render_snapshot(snapshot: dict[str, Any]) -> str:
    """Serialise with readable metadata and one data row per line (clean git diffs)."""
    clone = json.loads(json.dumps(snapshot, allow_nan=False))
    replacements: dict[str, str] = {}

    def compact(rows: list[Any], indent: int, name: str) -> Any:
        if not rows:
            return rows
        token = f"@@ROWS_{name}@@"
        pad = " " * indent
        body = ",\n".join(pad + "  " + json.dumps(row, separators=(",", ":"), allow_nan=False) for row in rows)
        replacements[json.dumps(token)] = "[\n" + body + "\n" + pad + "]"
        return token

    clone["fx"]["series"] = compact(clone["fx"]["series"], 4, "fx")
    regime = clone["macro"].get("regime")
    if isinstance(regime, dict) and isinstance(regime.get("history"), list):
        regime["history"] = compact(regime["history"], 6, "regime")
    calendar = clone["macro"].get("calendar")
    if isinstance(calendar, dict) and isinstance(calendar.get("events"), list):
        calendar["events"] = compact(calendar["events"], 6, "calendar")
    for index, asset in enumerate(clone["assets"]):
        asset["candles"] = compact(asset["candles"], 6, f"candles_{index}")
        asset["history"] = compact(asset["history"], 6, f"history_{index}")
        asset["dividends"] = compact(asset["dividends"], 6, f"dividends_{index}")
        asset["forecast"]["points"] = compact(asset["forecast"]["points"], 8, f"forecast_{index}")
    text = json.dumps(clone, indent=2, ensure_ascii=False, allow_nan=False)
    for token, block in replacements.items():
        text = text.replace(token, block)
    return text + "\n"


def write_snapshot(snapshot: dict[str, Any], path: Path) -> None:
    text = render_snapshot(snapshot)
    if json.loads(text) != json.loads(json.dumps(snapshot, allow_nan=False)):
        raise RuntimeError("rendered snapshot does not round-trip")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_previous(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        previous = load_json(path)
    except (OSError, ValueError) as exc:
        warn(f"previous snapshot is unreadable and will be ignored: {exc}")
        return None
    return previous if isinstance(previous, dict) else None


def regime_summary(regime: Any) -> str:
    """One plain line for logs and the step summary."""
    if not isinstance(regime, dict) or regime.get("status") not in {"fresh", "stale"}:
        return "unavailable"
    levels = regime["levels"]
    front = f"VIX9D {levels['vix9d']} · " if levels["vix9d"] is not None else ""
    return (f"{regime['state']} ({front}VIX {levels['vix']} · VIX3M {levels['vix3m']}, "
            f"VIX ÷ VIX3M {regime['ratio']:.3f}; {regime['status']}, {regime['asOf']})")


def write_step_summary(snapshot: dict[str, Any], elapsed: float) -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if not target:
        return
    rates = snapshot["macro"]["riskFree"]

    def rate(entry: dict[str, Any]) -> str:
        if entry["yield"] is None:
            return "unavailable"
        return f"{entry['yield'] * 100:.2f}% ({entry['status']}, {entry['asOf']})"

    lines = [
        "### Market snapshot",
        "",
        f"Generated {snapshot['generatedAt']} in {elapsed:.0f}s · USD/SGD {snapshot['fx']['rate']} ({snapshot['fx']['asOf']})",
        f"Risk-free: USD {rate(rates['USD'])} · SGD {rate(rates['SGD'])}",
        f"Market regime: {regime_summary(snapshot['macro'].get('regime'))}",
        f"Macro calendar: {calendar_summary(snapshot['macro'].get('calendar'), datetime.now(timezone.utc))}",
        "",
        "| Ticker | Status | Candles | Last candle | Last close | Period | News | Tone | Forecast |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for asset in snapshot["assets"]:
        news = asset["news"]
        tone = news["sentiment"]["label"] if news["sentiment"] else "-"
        lines.append(
            f"| {asset['ticker']} | {asset['status']} | {len(asset['candles'])} | {asset['quote']['asOf']} "
            f"| {asset['quote']['lastClose']} {asset['currency']} | {asset['fundamentalsPeriod'] or '-'} "
            f"| {news['status']} ({news['clusterCount']} stories) | {tone} | {asset['forecast']['status']} |"
        )
    with open(target, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")



# --------------------------------------------------------------------------- #
# Daily briefing (Telegram)
# --------------------------------------------------------------------------- #

MARKDOWN_V2_SPECIAL = set("_*[]()~`>#+-=|{}.!\\")


def escape_markdown_v2(text: str) -> str:
    """Escape every character that Telegram's MarkdownV2 treats as markup."""
    return "".join("\\" + character if character in MARKDOWN_V2_SPECIAL else character for character in str(text))


class BriefingFormat:
    """The same message as MarkdownV2 or as plain text (the fallback if Markdown is rejected)."""

    def __init__(self, markdown: bool) -> None:
        self.markdown = markdown

    def text(self, value: str) -> str:
        return escape_markdown_v2(value) if self.markdown else str(value)

    def bold(self, value: str) -> str:
        return "*" + self.text(value) + "*" if self.markdown else str(value)

    def italic(self, value: str) -> str:
        return "_" + self.text(value) + "_" if self.markdown else str(value)

    def code(self, value: str) -> str:
        if not self.markdown:
            return str(value)
        return "`" + str(value).replace("\\", "\\\\").replace("`", "\\`") + "`"

    def link(self, label: str, url: str) -> str:
        if not self.markdown:
            return f"{label}: {url}"
        return "[" + self.text(label) + "](" + url.replace("\\", "\\\\").replace(")", "\\)") + ")"


def pipeline_outcome(env: dict[str, str]) -> tuple[str, str | None]:
    """('passed' | 'failed' | 'unknown', the first step that did not succeed).

    The workflow passes each step's outcome (success, failure, cancelled or
    skipped). A local run passes none, which is 'unknown'.
    """
    outcomes = [((env.get(key) or "").strip().lower(), label) for key, label in PIPELINE_STEPS]
    if not any(outcome for outcome, _ in outcomes):
        return "unknown", None
    for outcome, label in outcomes:
        if outcome != "success":
            return "failed", label
    return "passed", None


def finite_or_none(value: Any) -> float | None:
    return value if is_finite_number(value) else None


def compute_signals(snapshot_path: Path) -> list[dict[str, Any]] | None:
    """Every asset's trend regime, Technical and Fundamental scores and the figures the
    briefing needs (bucket, the latest move in σ, 3-month relative strength, the next
    earnings and ex-dividend dates), from the site's own JavaScript engines.

    Running the engines (rather than re-implementing them in Python) guarantees
    the briefing says exactly what the site shows. Returns None, with a warning,
    if Node.js is missing or the script fails; the briefing then goes out without signals.
    """
    node = shutil.which("node")
    if node is None:
        warn("Node.js is not installed, so the briefing will not include signals")
        return None
    try:
        completed = subprocess.run(
            [node, "--no-warnings", str(SIGNALS_SCRIPT), str(snapshot_path)],
            capture_output=True, text=True, encoding="utf-8", timeout=SIGNALS_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        warn(f"the signals script did not run: {type(exc).__name__}")
        return None
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()
        warn(f"the signals script failed: {detail[-1][:200] if detail else f'exit code {completed.returncode}'}")
        return None
    try:
        payload = json.loads(completed.stdout)
    except ValueError:
        warn("the signals script did not print valid JSON")
        return None
    rows = payload.get("assets") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        warn("the signals script returned no assets")
        return None
    signals = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("ticker"), str):
            continue
        trend = row.get("trend") if row.get("trend") in TREND_REGIMES else None
        name = row.get("name") if isinstance(row.get("name"), str) else row["ticker"]
        def whole(value: Any) -> bool:
            return isinstance(value, int) and not isinstance(value, bool) and value >= 0

        upcoming = row.get("nextEarnings")
        next_earnings = None
        if isinstance(upcoming, dict) and is_iso_date(upcoming.get("date")) and whole(upcoming.get("days")):
            next_earnings = {"date": upcoming["date"], "days": upcoming["days"],
                             "tradingDays": upcoming["tradingDays"] if whole(upcoming.get("tradingDays")) else None,
                             "dateTo": upcoming["dateTo"] if is_iso_date(upcoming.get("dateTo")) else None,
                             "timing": upcoming["timing"] if upcoming.get("timing") in EARNINGS_TIMINGS else None}
        dividend = row.get("nextExDividend")
        next_dividend = None
        if isinstance(dividend, dict) and is_iso_date(dividend.get("date")) and whole(dividend.get("days")):
            next_dividend = {"date": dividend["date"], "days": dividend["days"], "estimated": dividend.get("estimated") is True}
        market = row.get("market") if row.get("market") in MARKETS else None
        signals.append({
            "ticker": row["ticker"], "name": name, "trend": trend,
            "technical": finite_or_none(row.get("technical")), "fundamental": finite_or_none(row.get("fundamental")),
            "assetClass": row.get("assetClass") if row.get("assetClass") in ASSET_CLASSES else None,
            "market": market,
            "bucket": row.get("bucket") if row.get("bucket") in {"global", "sgx", "crypto"} else None,
            "tradable": row.get("tradable") is True,
            "quoteAsOf": row.get("quoteAsOf") if is_iso_date(row.get("quoteAsOf")) else None,
            "nextEarnings": next_earnings, "nextExDividend": next_dividend,
            "typicalMove": finite_or_none(row.get("typicalMove")), "worstMove": finite_or_none(row.get("worstMove")),
            "dailyReturn": finite_or_none(row.get("dailyReturn")), "zScore": finite_or_none(row.get("zScore")),
            "relativeStrength3m": finite_or_none(row.get("relativeStrength3m")),
            "benchmark": row.get("benchmark") if isinstance(row.get("benchmark"), str) else None,
        })
    return signals


def sentiment_shifts(previous: dict[str, Any] | None, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Assets whose headline tone moved notably since the previous snapshot.

    Notable means the label flipped between positive and negative, or the mean
    VADER score moved by at least SENTIMENT_SHIFT_MIN. Only freshly fetched news
    counts: a carried-over block cannot have shifted.
    """
    if not isinstance(previous, dict) or not isinstance(previous.get("assets"), list):
        return []
    before = {asset.get("ticker"): asset for asset in previous["assets"] if isinstance(asset, dict)}
    shifts = []
    for asset in snapshot.get("assets", []):
        news = asset.get("news") or {}
        old_news = (before.get(asset.get("ticker")) or {}).get("news") or {}
        new_tone, old_tone = news.get("sentiment"), old_news.get("sentiment")
        if news.get("status") != "fresh" or not isinstance(new_tone, dict) or not isinstance(old_tone, dict):
            continue
        new_score, old_score = new_tone.get("compound"), old_tone.get("compound")
        if not is_finite_number(new_score) or not is_finite_number(old_score):
            continue
        delta = new_score - old_score
        flipped = {old_tone.get("label"), new_tone.get("label")} == {"positive", "negative"}
        if not flipped and abs(delta) < SENTIMENT_SHIFT_MIN:
            continue
        clusters = news.get("clusters") or []
        shifts.append({
            "ticker": asset["ticker"],
            "from": old_tone.get("label"), "to": new_tone.get("label"),
            "before": old_score, "after": new_score, "delta": delta,
            "headline": clusters[0].get("title") if clusters and isinstance(clusters[0], dict) else None,
        })
    shifts.sort(key=lambda shift: abs(shift["delta"]), reverse=True)
    return shifts[:BRIEFING_MAX_SHIFTS]


def signed(value: float, digits: int = 2) -> str:
    """+0.31, -0.42 (with a true minus sign)."""
    text = f"{abs(value):.{digits}f}"
    return ("+" if value > 0 else "−" if value < 0 else "") + text


def short_date(iso: str | None) -> str:
    moment = parse_timestamp(iso) if isinstance(iso, str) and "T" in iso else None
    if moment is None and isinstance(iso, str) and DATE_RE.match(iso):
        moment = datetime.strptime(iso, "%Y-%m-%d")
    return f"{moment.day} {moment.strftime('%b')}" if moment else "?"


def ordinal(number: int) -> str:
    suffix = "th" if 10 <= number % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"


def regime_line(regime: Any, close_label: bool = False) -> str | None:
    """The briefing's first line: the market regime from the VIX curve. None for a snapshot
    written before V3.1 (it has no regime block at all). `close_label` names the session it
    describes ("Friday close"), for the weekend edition."""
    if regime is None:
        return None
    if not isinstance(regime, dict) or regime.get("status") not in {"fresh", "stale"}:
        return "⚪ Market regime unavailable: the VIX curve could not be read"
    vix, vix3m = regime["levels"]["vix"], regime["levels"]["vix3m"]
    name = "Market regime"
    if close_label and is_iso_date(regime.get("asOf")):
        name = f"Market regime ({WEEKDAY_FULL[date.fromisoformat(regime['asOf']).weekday()]} close)"
    if regime["state"] == "stressed":
        streak = regime["invertedStreak"] or 1
        run = "first inverted session" if streak == 1 else f"{ordinal(streak)} session in a row"
        line = f"🔴 {name}: stressed · VIX curve inverted (VIX {vix:.1f} above VIX3M {vix3m:.1f}), {run}"
    else:
        shape = "flat" if regime["ratio"] >= regime["rules"]["elevatedRatio"] else "in contango"
        mark = "🟡" if regime["state"] == "elevated" else "🟢"
        line = f"{mark} {name}: {regime['state']} · VIX {vix:.1f}, curve {shape} (VIX3M {vix3m:.1f})"
    if regime["status"] == "stale":
        line += f" · reading of {short_date(regime['asOf'])}"
    return line


def briefing_links(env: dict[str, str]) -> list[tuple[str, str]]:
    """The site and the workflow run, derived from GitHub's own variables (none locally)."""
    repository = (env.get("GITHUB_REPOSITORY") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", repository):
        return []
    owner, name = repository.split("/", 1)
    links = [("Open QuantLens", f"https://{owner.lower()}.github.io/{name}/")]
    server, run_id = (env.get("GITHUB_SERVER_URL") or "").strip(), (env.get("GITHUB_RUN_ID") or "").strip()
    if server.startswith("https://") and run_id.isdigit():
        links.append(("Run log", f"{server}/{repository}/actions/runs/{run_id}"))
    return links


# --------------------------------------------------------------------------- #
# Briefing building blocks (V3.2)
# --------------------------------------------------------------------------- #

def day_label(iso: str) -> str:
    """'2026-12-09' -> 'Wed 9 Dec'."""
    day = date.fromisoformat(iso)
    return f"{WEEKDAY_NAMES[day.weekday()]} {day.day} {day.strftime('%b')}"


def clock_12(moment: pd.Timestamp) -> str:
    """2:00 PM, 9:30 AM (portable: no %-I)."""
    hour = moment.hour % 12 or 12
    return f"{hour}:{moment.minute:02d} {'AM' if moment.hour < 12 else 'PM'}"


def event_clocks(at: str) -> tuple[str, str]:
    """('2:00 PM ET', 'Thu 3:00 AM SGT') for an event time with its UTC offset."""
    moment = pd.Timestamp(at)
    singapore = moment.tz_convert(MARKET_TIMEZONES["SG"])
    return f"{clock_12(moment.tz_convert(MARKET_TIMEZONES['US']))} ET", f"{WEEKDAY_NAMES[singapore.weekday()]} {clock_12(singapore)} SGT"


def percent(value: float, digits: int = 1) -> str:
    """+37.0%, −13.9% (true minus)."""
    return signed(value * 100, digits) + "%" if value else f"{0:.{digits}f}%"


def macro_label(event: dict[str, Any]) -> str:
    kind = event["type"]
    if kind == "fomc-decision":
        return "FOMC rate decision" + (" (+ projections)" if event.get("projections") else "")
    if kind == "cpi":
        return f"US CPI ({MONTH_NAMES[int(event['period'][5:7]) - 1]})"
    if kind == "fomc-minutes":
        return "FOMC minutes"
    if kind == "fomc-meeting":
        return "FOMC strategy meeting (no decision)"
    if kind == "market-holiday":
        return f"{'US markets' if event['market'] == 'US' else 'SGX'} closed ({event['name']})"
    if kind == "market-early-close":
        return f"{early_close_words(event['market'])} ({event['name']})"
    return kind


def calendar_events(snapshot: dict[str, Any] | None) -> list[dict[str, Any]]:
    macro = snapshot.get("macro") if isinstance(snapshot, dict) else None
    block = macro.get("calendar") if isinstance(macro, dict) else None
    if not isinstance(block, dict) or block.get("status") != "fresh" or not isinstance(block.get("events"), list):
        return []
    return [event for event in block["events"] if isinstance(event, dict) and event.get("type") in CALENDAR_TYPES]


def event_hours(event: dict[str, Any], now: datetime) -> float | None:
    """Hours from now to a timed event (None for date-only events)."""
    if not event.get("at"):
        return None
    return (pd.Timestamp(event["at"]).tz_convert("UTC") - pd.Timestamp(now).tz_convert("UTC")).total_seconds() / 3600


def upcoming_calendar(events: list[dict[str, Any]], now: datetime, days: int, after_days: int = -1) -> list[dict[str, Any]]:
    """Events still ahead, dated within `days` of today (and beyond `after_days`)."""
    today = now.astimezone(timezone.utc).date()
    out = []
    for event in events:
        ahead = (date.fromisoformat(event["date"]) - today).days
        hours = event_hours(event, now)
        if after_days < ahead <= days and (hours > 0 if hours is not None else ahead >= 0):
            out.append(event)
    return out


def regime_transition(regime: Any) -> dict[str, Any]:
    """Day 1 of an inversion, or the first session out of one, from the stored history."""
    none = {"dayOne": False, "uninverted": False, "priorStreak": 0}
    if not isinstance(regime, dict) or regime.get("status") not in {"fresh", "stale"} or not regime.get("history"):
        return none
    rule = regime["rules"]["invertedRatio"]
    rows = regime["history"]
    inverted = [row[2] / row[3] >= rule for row in rows]
    prior = 0
    for flag in reversed(inverted[:-1]):
        if not flag:
            break
        prior += 1
    return {"dayOne": inverted[-1] and prior == 0, "uninverted": (not inverted[-1]) and prior > 0, "priorStreak": prior}


def is_weekend_run(now: datetime) -> bool:
    """Saturday and Sunday runs (UTC) carry no new equity session: they get the week-ahead edition."""
    return now.astimezone(timezone.utc).weekday() >= 5


def previous_dates(previous: dict[str, Any] | None) -> dict[str, str]:
    """Each asset's last session in the previous snapshot, to tell a new session from a repeat."""
    if not isinstance(previous, dict) or not isinstance(previous.get("assets"), list):
        return {}
    return {asset.get("ticker"): (asset.get("quote") or {}).get("asOf") for asset in previous["assets"] if isinstance(asset, dict)}


def new_session(row: dict[str, Any], before: dict[str, str]) -> bool:
    old = before.get(row["ticker"])
    return row.get("quoteAsOf") is not None and (old is None or row["quoteAsOf"] > old)


def sigma(z: float) -> str:
    return f"{signed(z, 1)}σ"


def move_text(row: dict[str, Any]) -> str:
    return f"{row['ticker']} {percent(row['dailyReturn'])} ({sigma(row['zScore'])})"


def earnings_size(row: dict[str, Any]) -> str:
    if row.get("typicalMove") is None or row.get("worstMove") is None:
        return "too few past releases to size the move"
    return f"±{row['typicalMove'] * 100:.1f}% (worst {percent(row['worstMove'])})"


TIMING_WORDS = {"before-open": "before the open", "during-session": "during the session", "after-close": "after the close"}


def briefing_triggers(snapshot: dict[str, Any], signals: list[dict[str, Any]], shifts: list[dict[str, Any]] | None,
                      previous: dict[str, Any] | None, now: datetime, weekend: bool, fmt: BriefingFormat) -> tuple[list[str], dict[str, set]]:
    """The ⚡ block: only what happened or is about to. Returns its lines (none on a quiet day)
    and what it already mentioned, so the rest of the message does not repeat it."""
    lines: list[str] = []
    seen: dict[str, set] = {"moves": set(), "earnings": set(), "events": set()}
    # T4: an FOMC decision or CPI release within 48 hours, with the time in New York and Singapore.
    for event in calendar_events(snapshot):
        hours = event_hours(event, now)
        if event["type"] in MARKET_MOVING and hours is not None and 0 < hours <= BRIEFING_MACRO_HOURS:
            et, sgt = event_clocks(event["at"])
            lines.append(fmt.text(f"• {macro_label(event)}: {day_label(event['date'])} {et} · {sgt} · in {round(hours)} h"))
            seen["events"].add((event["type"], event["date"]))
    # T2: the first session of an inversion, or the first one out of it (once per session).
    macro = snapshot.get("macro") or {}
    regime = macro.get("regime")
    old_macro = previous.get("macro") if isinstance(previous, dict) else None
    old_regime = old_macro.get("regime") if isinstance(old_macro, dict) else None
    old_as_of = old_regime.get("asOf") if isinstance(old_regime, dict) else None
    if isinstance(regime, dict) and regime.get("status") in {"fresh", "stale"} and (old_as_of is None or regime["asOf"] > old_as_of):
        change = regime_transition(regime)
        vix, vix3m = regime["levels"]["vix"], regime["levels"]["vix3m"]
        if change["dayOne"]:
            lines.append(fmt.text(f"• VIX curve inverted today, day 1: VIX {vix:.1f} above VIX3M {vix3m:.1f}"))
        elif change["uninverted"]:
            run = f"{change['priorStreak']} inverted session{'s' if change['priorStreak'] != 1 else ''}"
            lines.append(fmt.text(f"• VIX curve no longer inverted: {regime['state']} after {run} (VIX {vix:.1f}, VIX3M {vix3m:.1f})"))
    # T1: a session move beyond 2.5σ of the EWMA volatility, once per new session (crypto only at weekends).
    before = previous_dates(previous)
    moves = [row for row in signals if row.get("tradable") and row.get("zScore") is not None and row.get("dailyReturn") is not None
             and abs(row["zScore"]) > BRIEFING_MOVE_SIGMA and new_session(row, before) and (not weekend or row.get("bucket") == "crypto")]
    moves.sort(key=lambda row: (-abs(row["zScore"]), row["ticker"]))
    if moves:
        shown = " · ".join(move_text(row) for row in moves[:BRIEFING_MAX_MOVES])
        extra = f" · +{len(moves) - BRIEFING_MAX_MOVES} more" if len(moves) > BRIEFING_MAX_MOVES else ""
        lines.append(fmt.text(f"• Moves beyond {BRIEFING_MOVE_SIGMA}σ: {shown}{extra}"))
        seen["moves"] = {row["ticker"] for row in moves}
    # T3: earnings within 5 trading days (weekdays; the weekend edition lists the week ahead).
    if not weekend:
        soon = [row for row in signals if row.get("tradable") and row.get("nextEarnings")
                and row["nextEarnings"].get("tradingDays") is not None and row["nextEarnings"]["tradingDays"] <= BRIEFING_EARNINGS_TRIGGER]
        for row in sorted(soon, key=lambda row: (row["nextEarnings"]["days"], row["ticker"])):
            upcoming = row["nextEarnings"]
            when = TIMING_WORDS.get(upcoming.get("timing") or "", "time not known")
            sessions = upcoming["tradingDays"]
            lines.append(fmt.text(f"• Earnings: {row['ticker']} ~{day_label(upcoming['date'])}, {when} "
                                  f"({sessions} trading day{'s' if sessions != 1 else ''}) · {earnings_size(row)}"))
            seen["earnings"].add(row["ticker"])
    # T5: headline tone shifts, tradable assets only. Never a "no shifts" line.
    tradable = {asset["ticker"] for asset in snapshot.get("assets", []) if isinstance(asset, dict) and asset.get("assetClass") != "index"}
    for shift in [shift for shift in (shifts or []) if shift["ticker"] in tradable][:BRIEFING_MAX_TONE]:
        lines.append(fmt.text(f"• Tone: {shift['ticker']} {shift['from']} → {shift['to']} ({signed(shift['before'])} → {signed(shift['after'])})"))
        if shift.get("headline"):
            headline = shift["headline"] if len(shift["headline"]) <= 70 else shift["headline"][:67].rstrip() + "..."
            lines.append("   " + fmt.italic(headline))
    return lines, seen


def tally_text(rows: list[dict[str, Any]]) -> str:
    """'6 Uptrend · 1 Pullback · 3 Recovering · 16 Downtrend': regimes with no asset are left out."""
    counts = [(regime, sum(1 for row in rows if row.get("trend") == regime)) for regime in TREND_REGIMES]
    return " · ".join(f"{count} {regime}" for regime, count in counts if count)


def trend_line(label: str, rows: list[dict[str, Any]], strongest_first: bool, versus: str) -> str | None:
    """'Uptrend (3M vs S&P 500): WMT +37.0% · BRK-B +27.7% · 3 more', by 3-month relative strength.

    Uptrend lists the strongest first, Downtrend the weakest first; an asset without a
    relative strength goes last. A description of where prices stand, not a ranking to act on.
    """
    members = [row for row in rows if row.get("trend") == label]
    if not members:
        return None
    sign = -1 if strongest_first else 1
    members.sort(key=lambda row: (row.get("relativeStrength3m") is None, sign * (row.get("relativeStrength3m") or 0.0), row["ticker"]))
    shown = members[:BRIEFING_BUCKET_SIGNALS]
    parts = [f"{row['ticker']} {percent(row['relativeStrength3m'])}" if row.get("relativeStrength3m") is not None else row["ticker"] for row in shown]
    if len(members) > len(shown):
        parts.append(f"{len(members) - len(shown)} more")
    heading = f"{label} (3M vs {versus})" if any(row.get("relativeStrength3m") is not None for row in shown) else label
    return f"{heading}: {' · '.join(parts)}"


def bucket_sections(signals: list[dict[str, Any]], previous: dict[str, Any] | None, moved: set, fmt: BriefingFormat) -> list[str]:
    """US / Global, SGX and Crypto: the trend-regime tally, the Uptrend and Downtrend lines
    by 3-month relative strength, and notable movers. Indices are left out."""
    before = previous_dates(previous)
    lines: list[str] = []
    for key, title, versus in BRIEFING_BUCKETS:
        rows = [row for row in signals if row.get("bucket") == key and row.get("tradable")]
        if not rows:
            continue
        tally = tally_text(rows)
        lines += ["", fmt.bold(title) + (fmt.text(f" · {tally}") if tally else "")]
        for label, strongest_first in (("Uptrend", True), ("Downtrend", False)):
            line = trend_line(label, rows, strongest_first, versus)
            if line:
                lines.append(fmt.text(line))
        movers = [row for row in rows if row["ticker"] not in moved and row.get("zScore") is not None and row.get("dailyReturn") is not None
                  and abs(row["zScore"]) >= BRIEFING_MOVER_SIGMA and new_session(row, before)]
        movers.sort(key=lambda row: (-abs(row["zScore"]), row["ticker"]))
        if movers:
            lines.append(fmt.text("Movers: " + " · ".join(move_text(row) for row in movers[:BRIEFING_BUCKET_MOVERS])))
    return lines


def macro_summary(events: list[dict[str, Any]]) -> str:
    return " · ".join(f"{macro_label(event)} {day_label(event['date'])}" for event in events)


def outlook_lines(snapshot: dict[str, Any], signals: list[dict[str, Any]], now: datetime, seen: dict[str, set],
                  days: int, after_days: int, fmt: BriefingFormat) -> list[str]:
    """Macro, earnings and ex-dividend lines for a window of days (empty lines left out)."""
    lines: list[str] = []
    window = upcoming_calendar(calendar_events(snapshot), now, days, after_days)
    macro = [event for event in window if event["type"] in {"fomc-decision", "cpi", "fomc-minutes", "fomc-meeting"}
             and (event["type"], event["date"]) not in seen["events"]]
    if macro:
        lines.append(fmt.text("Macro: " + macro_summary(macro)))
    today = now.astimezone(timezone.utc).date().isoformat()
    earnings = sorted((row for row in signals if row.get("tradable") and row.get("nextEarnings") and row["ticker"] not in seen["earnings"]
                       and after_days < row["nextEarnings"]["days"] <= days and row["nextEarnings"]["date"] >= today),
                      key=lambda row: (row["nextEarnings"]["days"], row["ticker"]))
    if earnings:
        lines.append(fmt.text("Earnings: " + " · ".join(f"{row['ticker']} ~{short_date(row['nextEarnings']['date'])} {earnings_size(row)}"
                                                       for row in earnings[:BRIEFING_MAX_EARNINGS])))
    dividends = sorted((row for row in signals if row.get("tradable") and row.get("nextExDividend")
                        and after_days < row["nextExDividend"]["days"] <= days and row["nextExDividend"]["date"] >= today),
                       key=lambda row: (row["nextExDividend"]["date"], row["ticker"]))
    if dividends:
        lines.append(fmt.text("Ex-dividend: " + " · ".join(
            f"{row['ticker']} {'~' if row['nextExDividend']['estimated'] else ''}{short_date(row['nextExDividend']['date'])}"
            for row in dividends[:BRIEFING_MAX_EX_DIVIDENDS])))
    return lines


def early_close_words(market: str) -> str:
    """'US closes 1:00 PM ET' or 'SGX closes 12:00 PM SGT'."""
    return "US closes 1:00 PM ET" if market == "US" else "SGX closes 12:00 PM SGT"


def closure_text(event: dict[str, Any], date_first: bool = False) -> str:
    """'US closed Thu 26 Nov (Thanksgiving Day)', or with the date first for a dated list:
    'Thu 26 Nov: US closed (Thanksgiving Day)'. Early closes: 'US closes 1:00 PM ET', 'SGX closes 12:00 PM SGT'."""
    market = "US" if event["market"] == "US" else "SGX"
    what = early_close_words(event["market"]) if event["type"] == "market-early-close" else f"{market} closed"
    detail = "" if event["type"] == "market-early-close" else f" ({event['name']})"
    return f"{day_label(event['date'])}: {what}{detail}" if date_first else f"{what} {day_label(event['date'])}{detail}"


def closure_lines(snapshot: dict[str, Any], now: datetime, fmt: BriefingFormat) -> list[str]:
    closures = [event for event in upcoming_calendar(calendar_events(snapshot), now, BRIEFING_WEEK_DAYS)
                if event["type"] in {"market-holiday", "market-early-close"}]
    return [fmt.text("Closures: " + " · ".join(closure_text(event) for event in closures))] if closures else []


def week_ahead_sections(snapshot: dict[str, Any], signals: list[dict[str, Any]], now: datetime, seen: dict[str, set],
                        fmt: BriefingFormat) -> list[str]:
    """The weekend edition: the next 7 days, the next 30, and the 24/7 market."""
    lines = ["", fmt.bold("Next 7 days")]
    events = calendar_events(snapshot)
    week = upcoming_calendar(events, now, BRIEFING_WEEK_DAYS)
    today = now.astimezone(timezone.utc).date().isoformat()
    dated: list[tuple[str, int, str]] = []   # (date, order within the day, text): one list in date order
    for event in week:
        if (event["type"], event["date"]) in seen["events"]:
            continue
        if event["type"] in {"market-holiday", "market-early-close"}:
            dated.append((event["date"], 0, f"• {closure_text(event, date_first=True)}"))
            continue
        clock = ""
        if event.get("at"):
            et, sgt = event_clocks(event["at"])
            clock = f", {et} · {sgt}"
        dated.append((event["date"], 1, f"• {day_label(event['date'])}: {macro_label(event)}{clock}"))
    earnings = [row for row in signals if row.get("tradable") and row.get("nextEarnings")
                and row["nextEarnings"]["days"] <= BRIEFING_WEEK_DAYS and row["nextEarnings"]["date"] >= today]
    for row in earnings:
        when = TIMING_WORDS.get(row["nextEarnings"].get("timing") or "", "time not known")
        dated.append((row["nextEarnings"]["date"], 2, f"• {day_label(row['nextEarnings']['date'])}: {row['ticker']} earnings, {when} · {earnings_size(row)}"))
    by_date: dict[str, list[str]] = {}
    for row in signals:
        dividend = row.get("nextExDividend")
        if row.get("tradable") and dividend and dividend["days"] <= BRIEFING_WEEK_DAYS and dividend["date"] >= today:
            by_date.setdefault(dividend["date"], []).append(("~" if dividend["estimated"] else "") + row["ticker"])
    for day, tickers in by_date.items():
        dated.append((day, 3, f"• {day_label(day)}: ex-dividend {', '.join(sorted(tickers))}"))
    lines += [fmt.text(text) for _, _, text in sorted(dated)]
    if not any(event["type"] in MARKET_MOVING for event in week) and not earnings:
        later = [event for event in upcoming_calendar(events, now, 400) if event["type"] in MARKET_MOVING]
        hint = f" Next: {macro_label(later[0])} {day_label(later[0]['date'])}" if later else ""
        lines.append(fmt.text(f"• No FOMC, CPI or watchlist earnings.{hint}"))
    watch = outlook_lines(snapshot, signals, now, seen, BRIEFING_EARNINGS_DAYS, BRIEFING_WEEK_DAYS, fmt)
    if watch:
        lines += ["", fmt.bold("Next 30 days watch")] + watch
    crypto = [row for row in signals if row.get("bucket") == "crypto" and row.get("tradable")]
    if crypto:
        cutoff = max((row["quoteAsOf"] for row in crypto if row.get("quoteAsOf")), default=None)
        lines += ["", fmt.bold("Weekend crypto check") + (fmt.text(f" (UTC day to {short_date(cutoff)})") if cutoff else "")]
        for row in crypto:
            parts = [row["ticker"]]
            if row.get("dailyReturn") is not None and row.get("zScore") is not None:
                parts.append(f"{percent(row['dailyReturn'])} ({sigma(row['zScore'])})")
            if row.get("trend"):
                parts.append(row["trend"])
            if row.get("relativeStrength3m") is not None and row.get("benchmark") == "BTC-USD":
                parts.append(f"3M vs BTC {percent(row['relativeStrength3m'])}")
            lines.append(fmt.text(" · ".join(parts[:1]) + " " + " · ".join(parts[1:])))
    return lines


def failure_status(snapshot: dict[str, Any] | None, outcome: str, failed_step: str | None) -> str | None:
    """A failed run says so at the top: it is the most important thing that day."""
    if outcome != "failed":
        return None
    generated = short_date(snapshot.get("generatedAt")) if isinstance(snapshot, dict) else "?"
    if failed_step == "data refresh":
        return (f"❌ The data refresh failed, so nothing was committed. The site keeps the snapshot of "
                f"{generated}, and the signals below are from it.")
    if failed_step == "commit":
        return "⚠️ The data passed every check but could not be committed. The site keeps the previous snapshot."
    return (f"❌ {failed_step[0].upper()}{failed_step[1:]} failed, so today's data was NOT published "
            f"and its signals are held back. The site keeps the previous snapshot.")


def footer_lines(snapshot: dict[str, Any] | None, signals: list[dict[str, Any]] | None, outcome: str, failed_step: str | None,
                 weekend: bool, links: list[tuple[str, str]], fmt: BriefingFormat) -> list[str]:
    lines = [""]
    if signals:
        rows = [row for row in signals if row.get("tradable") and (row.get("bucket") == "crypto" or not weekend)]
        tally = tally_text(rows)
        if tally:
            lines.append(fmt.text(f"{'Crypto' if weekend else 'Tradable'}: {tally}"))
    assets = snapshot.get("assets", []) if isinstance(snapshot, dict) else []
    stale = [asset["ticker"] for asset in assets if asset.get("status") != "fresh"]
    fresh = f"{len(assets) - len(stale)}/{len(assets)} fresh"
    if stale:
        fresh += f" ({', '.join(stale[:3])}{f' and {len(stale) - 3} more' if len(stale) > 3 else ''} carried over)"
    if not isinstance(snapshot, dict):
        fresh = "the snapshot could not be read"
    if outcome == "passed":
        status = f"✅ {fresh}" if isinstance(snapshot, dict) else f"✅ Every check passed, but {fresh}"
    elif outcome == "unknown":
        status = f"ℹ️ Manual run · {fresh}"
    elif failed_step == "data refresh":
        status = "❌ Data refresh failed · last good snapshot"
    elif failed_step == "commit":
        status = f"⚠️ Not committed · {fresh}"
    else:
        status = f"❌ {failed_step} failed · held back"
    status_line = fmt.text(status)
    if links:
        status_line += fmt.text(" · ") + fmt.text(" · ").join(fmt.link(label, url) for label, url in links)
    lines.append(status_line)
    macro = snapshot.get("macro") if isinstance(snapshot, dict) else None
    calendar = macro.get("calendar") if isinstance(macro, dict) else None
    if isinstance(calendar, dict) and calendar.get("note") and calendar.get("status") == "fresh":
        lines.append(fmt.text(f"⚠ {calendar['note']}"))
    lines.append(fmt.italic("Trend regimes describe the past; they do not predict returns. Not financial advice."))
    return lines


def build_briefing(snapshot: dict[str, Any] | None, signals: list[dict[str, Any]] | None,
                   shifts: list[dict[str, Any]] | None, outcome: str, failed_step: str | None,
                   now: datetime, links: list[tuple[str, str]], fmt: BriefingFormat,
                   previous: dict[str, Any] | None = None) -> str:
    """The message: risk first, bucketed, signal only.

    Weekday: the regime, a ⚡ block that appears only when something happened, three
    buckets of tradable assets, the next 30 days, and a compact footer. Saturday and Sunday
    (UTC): the week-ahead edition, with no stale equity regimes or movers. `previous` is the
    snapshot before this run; it keeps a weekend from repeating Friday's triggers.
    """
    weekend = is_weekend_run(now)
    title = "QuantLens · week ahead" if weekend else "QuantLens daily briefing"
    lines = [fmt.bold(title) + fmt.text(" · " + now.strftime("%a %d %b %Y").replace(" 0", " "))]
    # Data that failed a check is not reported: the regime and the signals follow the same rule.
    held_back = outcome == "failed" and failed_step not in {"data refresh", "commit"}
    has_data = isinstance(snapshot, dict) and not held_back
    if has_data:
        macro = snapshot.get("macro")
        line = regime_line(macro.get("regime") if isinstance(macro, dict) else None, close_label=weekend)
        if line:
            lines.append(fmt.text(line))
    status = failure_status(snapshot, outcome, failed_step)
    if status:
        lines += ["", fmt.text(status)]
    if has_data:
        rows = signals or []
        triggers, seen = briefing_triggers(snapshot, rows, shifts, previous, now, weekend, fmt)
        if triggers:
            lines += ["", fmt.bold("⚡ Triggers today")] + triggers
        if not signals:
            lines += ["", fmt.text("Signals are unavailable in this run (the engines could not be run).")]
        if weekend:
            lines += week_ahead_sections(snapshot, rows, now, seen, fmt)
        else:
            lines += bucket_sections(rows, previous, seen["moves"], fmt)
            outlook = closure_lines(snapshot, now, fmt) + outlook_lines(snapshot, rows, now, seen, BRIEFING_EARNINGS_DAYS, -1, fmt)
            if outlook:
                lines += ["", fmt.bold("Next 30 days")] + outlook
    footer = footer_lines(snapshot, signals, outcome, failed_step, weekend, links, fmt)
    # Never risk a rejected message: shorten the body from the bottom, never the footer.
    while len("\n".join(lines + footer)) > TELEGRAM_MAX_CHARS and len(lines) > 2:
        lines.pop()
    return "\n".join(lines + footer)


def send_telegram(text: str, token: str, chat_id: str, parse_mode: str | None,
                  opener: Callable[..., Any] | None = None) -> tuple[bool, int | None, str | None]:
    """POST one message. Returns (delivered, HTTP status or None, Telegram's description)."""
    body: dict[str, Any] = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    if parse_mode:
        body["parse_mode"] = parse_mode
    request = urllib.request.Request(
        TELEGRAM_API.format(token=urllib.parse.quote(token, safe=":")),
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST")
    try:
        with (opener or urllib.request.urlopen)(request, timeout=TELEGRAM_TIMEOUT) as response:
            payload = json.loads(response.read(65536).decode("utf-8", "replace"))
        if isinstance(payload, dict) and payload.get("ok") is True:
            return True, 200, None
        return False, 200, str(payload.get("description") if isinstance(payload, dict) else "unexpected reply")
    except urllib.error.HTTPError as exc:
        try:
            description = json.loads(exc.read(65536).decode("utf-8", "replace")).get("description")
        except (ValueError, AttributeError, OSError):
            description = None
        return False, exc.code, str(description or exc.reason)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return False, None, f"{type(exc).__name__}: {getattr(exc, 'reason', exc)}"


def parse_chat_ids(raw: str | None) -> tuple[list[str], int]:
    """Recipients from TELEGRAM_CHAT_ID: one id, or several separated by commas.

    Spaces around each entry are stripped, empty entries ignored and repeats
    dropped (the first one wins). Returns the valid ids and how many entries were
    skipped because they are not chat ids. The values themselves are never logged:
    GitHub masks the secret as a whole, not the pieces of it after a split.
    """
    ids: list[str] = []
    invalid = 0
    for entry in (raw or "").split(","):
        value = entry.strip()
        if not value:
            continue
        if not CHAT_ID_RE.match(value):
            invalid += 1
        elif value not in ids:
            ids.append(value)
    return ids, invalid


def send_to_recipient(texts: dict[bool, str], token: str, chat_id: str, label: str,
                      opener: Callable[..., Any] | None, pause: Callable[[float], None],
                      redact: Callable[[str | None], str]) -> str:
    """Send one briefing to one chat: Markdown first, plain text if Telegram rejects the formatting,
    one retry on a network or server error. Returns 'sent', 'sent-plain' or 'failed'. Logs only `label`."""
    for markdown in (True, False):
        status = None
        description = None
        for attempt in range(2):
            delivered, status, description = send_telegram(texts[markdown], token, chat_id, "MarkdownV2" if markdown else None, opener)
            if delivered:
                return "sent" if markdown else "sent-plain"
            transient = status is None or status == 429 or status >= 500
            if not transient or attempt == 1:
                break
            pause(3.0)
        if status == 400 and markdown:
            # Usually a formatting problem: send the same content without Markdown.
            warn(f"Telegram rejected the Markdown briefing for {label} ({redact(description)}); retrying as plain text")
            continue
        warn(f"the daily briefing was not delivered to {label}: HTTP {status or '-'} {redact(description)}")
        return "failed"
    return "failed"


def deliver_briefing(snapshot_path: Path, previous_path: Path | None, env: dict[str, str],
                     opener: Callable[..., Any] | None = None, now: datetime | None = None,
                     signals_source: Callable[[Path], list[dict[str, Any]] | None] = compute_signals,
                     pause: Callable[[float], None] = time.sleep) -> str:
    """Build the briefing once and send it to every recipient in TELEGRAM_CHAT_ID.

    Returns 'skipped' (not configured), 'sent' (every recipient, as Markdown),
    'sent-plain' (every recipient, at least one as plain text), 'partial' (some
    recipients) or 'failed' (none). Never raises.
    """
    token = (env.get("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_ids, invalid = parse_chat_ids(env.get("TELEGRAM_CHAT_ID"))
    if not token or (not chat_ids and not invalid):
        LOG.debug("Telegram is not configured; the daily briefing was not sent")
        return "skipped"

    def redact(message: str | None) -> str:
        text = message or "no detail"
        for secret in [token, *chat_ids]:
            text = text.replace(secret, "***")
        return text[:300]

    if invalid:
        warn(f"{invalid} TELEGRAM_CHAT_ID entr{'y was' if invalid == 1 else 'ies were'} skipped: not a chat id "
             "(use numbers such as 123456789 or -1001234567890, or @channelname, separated by commas)")
    if not chat_ids:
        warn("the daily briefing was not sent: TELEGRAM_CHAT_ID holds no valid chat id")
        return "failed"

    try:
        outcome, failed_step = pipeline_outcome(env)
        snapshot = load_previous(snapshot_path)  # None if missing or unreadable: status only
        held_back = outcome == "failed" and failed_step not in {"data refresh", "commit"}
        signals = signals_source(snapshot_path) if snapshot and not held_back else None
        shifts = None
        previous = load_previous(previous_path) if previous_path is not None else None
        if snapshot and not held_back and failed_step != "data refresh" and previous:
            shifts = sentiment_shifts(previous, snapshot)
        moment = now or datetime.now(timezone.utc)
        links = briefing_links(env)
        # Build both versions once: every recipient gets the same message.
        texts = {markdown: build_briefing(snapshot, signals, shifts, outcome, failed_step, moment, links, BriefingFormat(markdown),
                                          previous=previous)
                 for markdown in (True, False)}

        results = []
        for position, chat_id in enumerate(chat_ids, start=1):
            label = f"recipient {position} of {len(chat_ids)}"
            try:
                results.append(send_to_recipient(texts, token, chat_id, label, opener, pause, redact))
            except Exception as exc:  # noqa: BLE001 - one recipient must never stop the others
                warn(f"the daily briefing was not delivered to {label}: {type(exc).__name__}: {redact(str(exc))}")
                results.append("failed")
        delivered = sum(1 for result in results if result != "failed")
        plain = any(result == "sent-plain" for result in results)
        if delivered == len(results):
            LOG.info("daily briefing sent to Telegram (%d recipient%s%s)", delivered, "" if delivered == 1 else "s",
                     ", some as plain text" if plain else "")
            return "sent-plain" if plain else "sent"
        if delivered:
            warn(f"the daily briefing reached {delivered} of {len(results)} recipients")
            return "partial"
        return "failed"
    except Exception as exc:  # noqa: BLE001 - the briefing must never fail the pipeline
        warn(f"the daily briefing was not sent: {type(exc).__name__}: {redact(str(exc))}")
        return "failed"


def run_notify(settings: argparse.Namespace) -> int:
    """Entry point for --notify. Always exits 0: a briefing must never block a deployment."""
    try:
        deliver_briefing(settings.output, settings.previous, dict(os.environ))
    except Exception as exc:  # noqa: BLE001 - belt and braces: deliver_briefing already never raises
        detail = str(exc)
        secrets = [(os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip(), *parse_chat_ids(os.environ.get("TELEGRAM_CHAT_ID"))[0]]
        for secret in filter(None, secrets):
            detail = detail.replace(secret, "***")
        warn(f"the daily briefing was not sent: {type(exc).__name__}: {detail[:300]}")
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh data/market_snapshot.json from free public sources.")
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-retries", type=int, default=3, help="attempts per network call")
    parser.add_argument("--retry-delay", type=float, default=2.0, help="base backoff in seconds")
    parser.add_argument("--pause-min", type=float, default=0.5, help="shortest pause between tickers, seconds")
    parser.add_argument("--pause-max", type=float, default=1.0, help="longest pause between tickers, seconds")
    parser.add_argument("--request-timeout", type=float, default=10.0, help="timeout of one network request")
    parser.add_argument("--ticker-timeout", type=float, default=45.0, help="hard deadline for one ticker's prices and fundamentals")
    parser.add_argument("--news-timeout", type=float, default=15.0, help="deadline for one ticker's news")
    parser.add_argument("--events-timeout", type=float, default=15.0, help="deadline for one stock's event calendar")
    parser.add_argument("--macro-timeout", type=float, default=30.0, help="deadline for each macro series")
    parser.add_argument("--time-budget", type=float, default=720.0, help="seconds after which remaining tickers are carried over")
    parser.add_argument("--rate-limit-trips", type=int, default=3, help="consecutive rate-limited tickers that stop the run")
    parser.add_argument("--skip-news", action="store_true", help="do not fetch news (headlines are carried over)")
    parser.add_argument("--skip-events", action="store_true", help="do not fetch event calendars (they are carried over)")
    parser.add_argument("--skip-forecast", action="store_true", help="do not fit forecasts (projections are carried over)")
    parser.add_argument("--forecast-workers", type=int, default=2, help="processes used for model fitting")
    parser.add_argument("--forecast-timeout", type=float, default=60.0, help="longest wait for one asset's forecast, seconds")
    parser.add_argument("--forecast-budget", type=float, default=300.0, help="seconds after which unfinished forecasts are abandoned")
    parser.add_argument("--validate-only", action="store_true", help="validate the existing snapshot and exit")
    parser.add_argument("--notify", action="store_true",
                        help="send the daily Telegram briefing for the snapshot at --output and exit (never fails; "
                             "needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, otherwise does nothing)")
    parser.add_argument("--calendar", type=Path, default=DEFAULT_CALENDAR,
                        help="the hand-kept macro calendar (FOMC, CPI, market holidays) copied into the snapshot")
    parser.add_argument("--previous", type=Path, default=None,
                        help="with --notify: the snapshot before this run, to detect shifts in headline tone")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def run_validation(path: Path) -> int:
    try:
        snapshot = load_json(path)
    except (OSError, ValueError) as exc:
        fail(f"cannot read {path}: {exc}")
        return 1
    errors = validate_snapshot(snapshot)
    if errors:
        for message in errors:
            fail(message)
        return 1
    stale = [a["ticker"] for a in snapshot["assets"] if a["status"] != "fresh"]
    with_news = sum(1 for a in snapshot["assets"] if a["news"]["status"] != "unavailable")
    with_forecast = sum(1 for a in snapshot["assets"] if a["forecast"]["status"] != "unavailable")
    with_events = sum(1 for a in snapshot["assets"] if a["events"]["nextEarnings"])
    years = sum(len(a["history"]) + len(a["candles"]) for a in snapshot["assets"]) / max(1, len(snapshot["assets"]))
    LOG.info("%s is valid (schema v%d): %d assets, %d stale%s, %d with news, %d with a forecast, "
             "%d with an upcoming earnings date, %.0f sessions of history on average",
             path.name, snapshot["schemaVersion"], len(snapshot["assets"]), len(stale),
             f" ({', '.join(stale)})" if stale else "", with_news, with_forecast, with_events, years)
    return 0


def main(argv: list[str] | None = None) -> int:
    settings = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if settings.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)

    if settings.validate_only:
        return run_validation(settings.output)
    if settings.notify:
        return run_notify(settings)

    try:
        watchlist = load_json(settings.watchlist)
    except (OSError, ValueError) as exc:
        fail(f"cannot read watchlist {settings.watchlist}: {exc}")
        return 1
    watchlist_errors = validate_watchlist(watchlist)
    if watchlist_errors:
        for message in watchlist_errors:
            fail(message)
        return 1

    previous = load_previous(settings.output)
    previous_assets: dict[str, dict[str, Any]] = {}
    if previous and isinstance(previous.get("assets"), list):
        for old in previous["assets"]:
            if not isinstance(old, dict):
                continue
            upgraded = upgrade_asset(old)
            if not validate_asset(upgraded):
                previous_assets[upgraded["ticker"]] = upgraded

    analyzer = SentimentIntensityAnalyzer() if SentimentIntensityAnalyzer is not None else None
    if analyzer is None and not settings.skip_news:
        warn("vaderSentiment is not installed: headlines will be stored without sentiment scores")

    started = time.monotonic()
    now_utc = datetime.now(timezone.utc)
    total = len(watchlist["assets"])
    LOG.info("yfinance %s · %d assets · %s", yf.__version__, total, now_utc.strftime("%Y-%m-%d %H:%M UTC"))

    try:
        fx = fetch_fx(watchlist["fx"], previous, settings)
    except FetchError as exc:
        fail(f"no USD/SGD rate available and no previous snapshot to fall back on: {exc}")
        return 1
    LOG.info("USD/SGD %s (%s), %d daily closes", fx["rate"], fx["asOf"], len(fx["series"]))

    macro = build_macro(previous, settings, now_utc)
    for currency, entry in macro["riskFree"].items():
        shown = "unavailable" if entry["yield"] is None else f"{entry['yield'] * 100:.2f}%"
        LOG.info("risk-free %s: %s [%s] %s", currency, shown, entry["status"], entry["name"])
    # The calendar is read first: its half days decide when today's session counts as complete.
    calendar = build_calendar(settings.calendar, now_utc)
    settings.early_closes = {market: early_close_dates(calendar, market) for market in EARLY_CLOSE}
    macro["regime"] = build_regime(previous, settings, now_utc)
    LOG.info("market regime: %s, %d sessions of history", regime_summary(macro["regime"]), len(macro["regime"]["history"]))
    macro["calendar"] = calendar
    LOG.info("macro calendar: %s, %d events, %d US and %d SGX half days", calendar_summary(calendar, now_utc), len(calendar["events"]),
             len(settings.early_closes["US"]), len(settings.early_closes["SG"]))

    assets: list[dict[str, Any]] = []
    refreshed: list[dict[str, Any]] = []
    not_fresh: list[str] = []
    rate_limit_streak = 0
    halted_reason: str | None = None
    for position, entry in enumerate(watchlist["assets"]):
        symbol = entry["ticker"]
        previous_asset = previous_assets.get(symbol)
        ticker_started = time.monotonic()

        if halted_reason is None and ticker_started - started > settings.time_budget:
            halted_reason = f"the run exceeded its {settings.time_budget:.0f}s time budget"
            warn(f"{halted_reason}; remaining tickers are carried over")
        if halted_reason is None and rate_limit_streak >= settings.rate_limit_trips:
            halted_reason = f"the data source rate-limited {rate_limit_streak} tickers in a row"
            warn(f"{halted_reason}; remaining tickers are carried over")

        asset = None
        if halted_reason is None:
            try:
                deadline = ticker_started + settings.ticker_timeout
                asset = run_with_deadline(
                    symbol,
                    lambda e=entry, p=previous_asset, d=deadline: fetch_asset(e, p, settings, watchlist["history"], now_utc, d),
                    settings.ticker_timeout)
                problems = validate_asset(asset)
                if problems:
                    raise FetchError("; ".join(problems))
                rate_limit_streak = 0
            except Exception as exc:  # noqa: BLE001 - one bad ticker must never abort the run
                asset = None
                failure = str(exc)[:200] or type(exc).__name__
                limited = getattr(exc, "rate_limited", False) or is_rate_limit(exc)
                rate_limit_streak = rate_limit_streak + 1 if limited else 0
                if limited:
                    cooldown = min(60.0, 15.0 * rate_limit_streak)
                    LOG.warning("%s was rate-limited; cooling down for %.0fs", symbol, cooldown)
                    time.sleep(cooldown)
        else:
            failure = halted_reason

        if asset is None:
            not_fresh.append(symbol)
            if previous_asset is None:
                fail(f"{symbol}: no fresh data and no previous entry to keep ({failure})")
                continue
            warn(f"{symbol}: keeping the previous entry ({failure})")
            asset = carry_over(previous_asset, entry, failure[:160])
        else:
            if asset["status"] != "fresh":
                not_fresh.append(symbol)
            old_news = previous_asset["news"] if previous_asset else None
            if settings.skip_news:
                asset["news"] = aged_section(old_news, "News was not refreshed in this run.") if old_news else empty_news("News was not fetched in this run.")
            else:
                asset["news"] = fetch_news(symbol, old_news, settings, analyzer, now_utc)
            old_events = previous_asset["events"] if previous_asset else None
            history_start = (asset["history"] or asset["candles"])[0][0]
            if settings.skip_events:
                asset["events"] = (aged_section(old_events, "Events were not refreshed in this run.")
                                   if old_events else empty_events("Events were not fetched in this run."))
            else:
                try:
                    asset["events"] = run_with_deadline(
                        f"{symbol} events",
                        lambda e=entry, o=old_events, s=history_start: fetch_events(e, o, settings, now_utc, s),
                        settings.events_timeout + 5)
                except Exception as exc:  # noqa: BLE001 - events can never cost an asset its prices
                    LOG.info("  %s: events skipped (%s)", symbol, str(exc)[:120])
                    asset["events"] = (aged_section(old_events, "The event calendar could not be refreshed in this run.")
                                       if old_events else empty_events("The event calendar could not be fetched."))
            refreshed.append(asset)  # forecast after the network stage, in separate processes

        assets.append(asset)
        news = asset["news"]
        tone = news["sentiment"]["label"] if news["sentiment"] else "-"
        upcoming = (asset["events"].get("nextEarnings") or {}).get("date") or "-"
        LOG.info("[%d/%d] %-8s %-5s %d candles + %d older closes · news %s (%d stories, %s) · earnings %s · %.1fs",
                 position + 1, total, symbol, asset["status"], len(asset["candles"]), len(asset["history"]),
                 news["status"], news["clusterCount"], tone, upcoming, time.monotonic() - ticker_started)
        if halted_reason is None and position + 1 < total:
            time.sleep(random.uniform(min(settings.pause_min, settings.pause_max), max(settings.pause_min, settings.pause_max)))

    if len(not_fresh) * 2 > total:
        fail(f"{len(not_fresh)} of {total} assets could not be refreshed "
             f"({', '.join(not_fresh)}); nothing was written")
        return 1

    LOG.info("network stage finished in %.0fs", time.monotonic() - started)
    forecasts = run_forecasts(refreshed, previous_assets, settings)
    for asset in refreshed:
        asset["forecast"] = forecasts.get(asset["ticker"], empty_forecast("The forecast model was not run for this asset."))

    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso_timestamp(now_utc),
        "fx": fx,
        "macro": macro,
        "candleFields": CANDLE_FIELDS,
        "historyFields": HISTORY_FIELDS,
        "forecastFields": FORECAST_FIELDS,
        "assets": assets,
    }
    errors = validate_snapshot(snapshot)
    if errors:
        for message in errors:
            fail(message)
        fail("snapshot failed validation; nothing was written")
        return 1

    write_snapshot(snapshot, settings.output)
    elapsed = time.monotonic() - started
    write_step_summary(snapshot, elapsed)
    LOG.info("wrote %s in %.0fs: %d assets, %d not fresh%s", settings.output, elapsed, len(assets), len(not_fresh),
             f" ({', '.join(not_fresh)})" if not_fresh else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
