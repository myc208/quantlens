#!/usr/bin/env python3
"""QuantLens market-data pipeline.

Reads ``scripts/watchlist.json``, pulls one year of daily candles plus
fundamentals for every asset from Yahoo Finance (via the free ``yfinance``
package, no API key), and writes ``data/market_snapshot.json``.

Design rules
------------
* Every network call is retried with exponential backoff and jitter.
* Every number is sanitised: ``NaN``, ``Infinity`` and non-numeric values
  become ``null``. The JSON encoder runs with ``allow_nan=False`` as a backstop.
* The snapshot is validated against the schema before it is written. If
  validation fails nothing is written and the exit code is 1, so the site keeps
  serving the previous file.
* If one asset cannot be fetched, its entry from the previous snapshot is kept
  and marked ``"status": "stale"``. If more than half of the watchlist is not
  fresh, the run aborts without writing.

Units
-----
* ``marketCap`` and ``enterpriseValue`` are in the trading ``currency``.
* Statement items (revenue, EBIT, debt, equity ...) are in ``financialCurrency``.
* Ratios and yields are decimals (0.171 means 17.1 %).
* Candles are split- and dividend-adjusted and contain completed sessions only.

Usage
-----
    python scripts/fetch_fundamentals.py
    python scripts/fetch_fundamentals.py --validate-only
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import random
import re
import sys
import time
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import pandas as pd
import yfinance as yf

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WATCHLIST = REPO_ROOT / "scripts" / "watchlist.json"
DEFAULT_OUTPUT = REPO_ROOT / "data" / "market_snapshot.json"

SCHEMA_VERSION = 1
CANDLE_FIELDS = ["date", "open", "high", "low", "close", "volume"]
MIN_CANDLES = 200

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
]
ASSET_CLASSES = {"equity", "crypto"}
MARKETS = {"US", "SG", "CRYPTO"}
PROFILES = {"CORPORATE", "FINANCIAL", "REIT", "CRYPTO"}
STATUSES = {"fresh", "stale"}

# Local session close per market. A candle dated "today" is only kept once the
# session has closed (plus a buffer for Yahoo's delayed quotes).
SESSION_CLOSE = {"US": dtime(16, 0), "SG": dtime(17, 0)}
CLOSE_BUFFER_MINUTES = 20

SECTOR_PROFILES = {"Financial Services": "FINANCIAL", "Real Estate": "REIT"}

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

TICKER_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-=^]{0,14}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

LOG = logging.getLogger("quantlens.fetch")
IN_GITHUB_ACTIONS = os.environ.get("GITHUB_ACTIONS") == "true"


class FetchError(RuntimeError):
    """Raised when a data source keeps failing after all retries."""


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
# Number sanitisation
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


# --------------------------------------------------------------------------- #
# Retry
# --------------------------------------------------------------------------- #

def with_retry(label: str, fn: Callable[[], Any], attempts: int, base_delay: float) -> Any:
    """Run ``fn`` with exponential backoff (x3 per attempt) and jitter."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - yfinance raises many types
            last_error = exc
            if attempt == attempts:
                break
            delay = base_delay * (3 ** (attempt - 1)) + random.uniform(0, base_delay)
            LOG.warning("%s failed (attempt %d/%d): %s. Retrying in %.1fs",
                        label, attempt, attempts, exc, delay)
            time.sleep(delay)
    raise FetchError(f"{label} failed after {attempts} attempts: {last_error}") from last_error


# --------------------------------------------------------------------------- #
# Candles
# --------------------------------------------------------------------------- #

def fetch_history(symbol: str, period: str, interval: str) -> pd.DataFrame:
    frame = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=True, actions=True)
    if frame is None or frame.empty:
        raise ValueError(f"empty price history for {symbol}")
    missing = [c for c in ("Open", "High", "Low", "Close", "Volume") if c not in frame.columns]
    if missing:
        raise ValueError(f"price history for {symbol} lacks columns {missing}")
    return frame


def build_candles(history: pd.DataFrame, market: str, now_utc: datetime) -> list[list[Any]]:
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
        close_at = SESSION_CLOSE.get(market, dtime(23, 59))
        cutoff_minutes = close_at.hour * 60 + close_at.minute + CLOSE_BUFFER_MINUTES
        now_minutes = local_now.hour * 60 + local_now.minute
        if now_minutes < cutoff_minutes:
            LOG.info("  dropped in-progress session %s", today_local)
            candles = candles[:-1]
    return candles


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


def fetch_statements(ticker: yf.Ticker, attempts: int, base_delay: float, symbol: str) -> dict[str, pd.DataFrame]:
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
                                     attempts, base_delay)
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
    if entry.get("scoringProfile"):
        return entry["scoringProfile"]
    if entry["assetClass"] == "crypto":
        return "CRYPTO"
    return SECTOR_PROFILES.get(sector or "", "CORPORATE")


def fetch_asset(entry: dict[str, Any], previous: dict[str, Any] | None, settings: argparse.Namespace,
                history_cfg: dict[str, str], now_utc: datetime) -> dict[str, Any]:
    """Fetch one asset. Raises ``FetchError`` when price history is unavailable."""
    symbol = entry["ticker"]
    is_crypto = entry["assetClass"] == "crypto"
    ticker = yf.Ticker(symbol)

    history = with_retry(f"{symbol} price history",
                         lambda: fetch_history(symbol, history_cfg["period"], history_cfg["interval"]),
                         settings.max_retries, settings.retry_delay)
    candles = build_candles(history, entry["market"], now_utc)
    if len(candles) < MIN_CANDLES:
        raise FetchError(f"{symbol} has only {len(candles)} completed candles (minimum {MIN_CANDLES})")
    last_close = candles[-1][4]
    dividend_yield = None if is_crypto else trailing_dividend_yield(history, last_close)

    status, status_note = "fresh", None
    try:
        info = with_retry(f"{symbol} profile", lambda: fetch_info(ticker, symbol),
                          settings.max_retries, settings.retry_delay)
        if is_crypto:
            fundamentals, period = empty_fundamentals(), None
            fundamentals["marketCap"] = clean_number(info.get("marketCap"))
        else:
            statements = fetch_statements(ticker, settings.max_retries, settings.retry_delay, symbol)
            fundamentals, period = build_fundamentals(info, statements, dividend_yield)
        currency = info.get("currency") or entry["currency"]
        if currency != entry["currency"]:
            warn(f"{symbol}: Yahoo reports currency {currency}, watchlist says {entry['currency']}")
        meta = {
            "name": entry.get("name") or info.get("longName") or info.get("shortName") or symbol,
            "currency": currency,
            "financialCurrency": info.get("financialCurrency") or currency,
            "sector": None if is_crypto else info.get("sector"),
            "industry": None if is_crypto else info.get("industry"),
        }
    except FetchError as exc:
        if previous is None:
            raise
        warn(f"{symbol}: fundamentals unavailable ({exc}); carrying them over from the previous snapshot")
        fundamentals = {key: previous["fundamentals"].get(key) for key in FUNDAMENTAL_KEYS}
        if not is_crypto:
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
    }


def carry_over(previous: dict[str, Any], entry: dict[str, Any], reason: str) -> dict[str, Any]:
    """Re-use an asset from the previous snapshot, marked stale."""
    asset = {key: previous.get(key) for key in ASSET_KEYS}
    asset["lotSize"] = entry["lotSize"]
    asset["binanceSymbol"] = entry.get("binanceSymbol")
    asset["status"] = "stale"
    asset["statusNote"] = f"Carried over from an earlier snapshot (last candle {previous['quote']['asOf']}): {reason}"
    return asset


def fetch_fx(config: dict[str, str], previous: dict[str, Any] | None, settings: argparse.Namespace) -> dict[str, Any]:
    symbol = config["yahooSymbol"]
    try:
        history = with_retry(f"{symbol} FX rate", lambda: fetch_history(symbol, "5d", "1d"),
                             settings.max_retries, settings.retry_delay)
        closes = history["Close"].dropna()
        rate = clean_number(closes.iloc[-1], digits=5) if len(closes) else None
        if rate is None or not 0.5 <= rate <= 3:
            raise FetchError(f"{symbol} returned an implausible rate: {rate}")
        return {"base": config["base"], "quote": config["quote"], "rate": rate,
                "asOf": closes.index[-1].strftime("%Y-%m-%d")}
    except FetchError as exc:
        if previous and isinstance(previous.get("fx"), dict):
            warn(f"FX rate unavailable ({exc}); keeping the previous rate")
            return previous["fx"]
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
    if asset["assetClass"] == "crypto":
        if asset["scoringProfile"] != "CRYPTO":
            err("crypto assets must use the CRYPTO scoring profile")
        if not isinstance(asset["binanceSymbol"], str) or not asset["binanceSymbol"]:
            err("crypto assets need a binanceSymbol")
    elif asset["scoringProfile"] == "CRYPTO":
        err("only crypto assets may use the CRYPTO scoring profile")
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


def validate_snapshot(snapshot: Any) -> list[str]:
    """Return a list of schema violations. An empty list means valid."""
    if not isinstance(snapshot, dict):
        return ["snapshot is not a JSON object"]
    errors: list[str] = []
    for key in ("schemaVersion", "generatedAt", "fx", "candleFields", "assets"):
        if key not in snapshot:
            errors.append(f"missing top-level key '{key}'")
    if errors:
        return errors

    if snapshot["schemaVersion"] != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION}")
    try:
        datetime.strptime(snapshot["generatedAt"], "%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        errors.append("generatedAt must be ISO-8601 UTC, e.g. 2026-01-31T22:30:00Z")
    if snapshot["candleFields"] != CANDLE_FIELDS:
        errors.append(f"candleFields must be {CANDLE_FIELDS}")

    fx = snapshot["fx"]
    if not isinstance(fx, dict) or sorted(fx) != ["asOf", "base", "quote", "rate"]:
        errors.append("fx must contain base, quote, rate and asOf")
    else:
        if fx["base"] != "USD" or fx["quote"] != "SGD":
            errors.append("fx must be the USD/SGD pair")
        if not is_finite_number(fx["rate"]) or not 0.5 <= fx["rate"] <= 3:
            errors.append(f"fx.rate is implausible: {fx['rate']!r}")
        if not is_iso_date(fx["asOf"]):
            errors.append("fx.asOf must be an ISO date")

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
        if entry.get("scoringProfile") not in PROFILES | {None}:
            errors.append(f"{ticker}: scoringProfile must be null or one of {sorted(PROFILES)}")
        if entry.get("assetClass") == "crypto" and not entry.get("binanceSymbol"):
            errors.append(f"{ticker}: crypto assets need a binanceSymbol")
    return errors


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

def render_snapshot(snapshot: dict[str, Any]) -> str:
    """Serialise with readable metadata and one candle per line (clean git diffs)."""
    clone = json.loads(json.dumps(snapshot, allow_nan=False))
    replacements: dict[str, str] = {}
    for index, asset in enumerate(clone["assets"]):
        token = f"@@CANDLES_{index}@@"
        rows = ",\n".join("        " + json.dumps(row, separators=(",", ":"), allow_nan=False)
                          for row in asset["candles"])
        replacements[json.dumps(token)] = "[\n" + rows + "\n      ]"
        asset["candles"] = token
    text = json.dumps(clone, indent=2, ensure_ascii=False, allow_nan=False)
    for token, block in replacements.items():
        text = text.replace(token, block)
    return text + "\n"


def write_snapshot(snapshot: dict[str, Any], path: Path) -> None:
    text = render_snapshot(snapshot)
    json.loads(text)  # the rendered text must round-trip
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


def write_step_summary(snapshot: dict[str, Any]) -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if not target:
        return
    lines = [
        "### Market snapshot",
        "",
        f"Generated {snapshot['generatedAt']} · USD/SGD {snapshot['fx']['rate']} ({snapshot['fx']['asOf']})",
        "",
        "| Ticker | Status | Candles | Last candle | Last close | Period |",
        "|---|---|---|---|---|---|",
    ]
    for asset in snapshot["assets"]:
        lines.append(
            f"| {asset['ticker']} | {asset['status']} | {len(asset['candles'])} | {asset['quote']['asOf']} "
            f"| {asset['quote']['lastClose']} {asset['currency']} | {asset['fundamentalsPeriod'] or '-'} |"
        )
    with open(target, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh data/market_snapshot.json from Yahoo Finance.")
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-retries", type=int, default=4, help="attempts per network call")
    parser.add_argument("--retry-delay", type=float, default=4.0, help="base backoff in seconds")
    parser.add_argument("--pause", type=float, default=1.5, help="pause between tickers in seconds")
    parser.add_argument("--validate-only", action="store_true",
                        help="validate the existing snapshot and exit")
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
    LOG.info("%s is valid: %d assets, %d stale%s", path.name, len(snapshot["assets"]), len(stale),
             f" ({', '.join(stale)})" if stale else "")
    return 0


def main(argv: list[str] | None = None) -> int:
    settings = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if settings.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)

    if settings.validate_only:
        return run_validation(settings.output)

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
    previous_assets = {}
    if previous and isinstance(previous.get("assets"), list):
        previous_assets = {a.get("ticker"): a for a in previous["assets"]
                           if isinstance(a, dict) and not validate_asset(a)}

    now_utc = datetime.now(timezone.utc)
    LOG.info("yfinance %s · %d assets · %s", yf.__version__, len(watchlist["assets"]),
             now_utc.strftime("%Y-%m-%d %H:%M UTC"))

    try:
        fx = fetch_fx(watchlist["fx"], previous, settings)
    except FetchError as exc:
        fail(f"no USD/SGD rate available and no previous snapshot to fall back on: {exc}")
        return 1
    LOG.info("USD/SGD %s (%s)", fx["rate"], fx["asOf"])

    assets: list[dict[str, Any]] = []
    not_fresh: list[str] = []
    for position, entry in enumerate(watchlist["assets"]):
        symbol = entry["ticker"]
        LOG.info("[%d/%d] %s", position + 1, len(watchlist["assets"]), symbol)
        previous_asset = previous_assets.get(symbol)
        try:
            asset = fetch_asset(entry, previous_asset, settings, watchlist["history"], now_utc)
            problems = validate_asset(asset)
            if problems:
                raise FetchError("; ".join(problems))
        except FetchError as exc:
            not_fresh.append(symbol)
            if previous_asset is None:
                fail(f"{symbol}: fetch failed and there is no previous entry to keep: {exc}")
                continue
            warn(f"{symbol}: fetch failed, keeping the previous entry: {exc}")
            asset = carry_over(previous_asset, entry, str(exc)[:160])
        else:
            if asset["status"] != "fresh":
                not_fresh.append(symbol)
        assets.append(asset)
        if position + 1 < len(watchlist["assets"]):
            time.sleep(max(0.0, settings.pause))

    total = len(watchlist["assets"])
    if len(not_fresh) * 2 > total:
        fail(f"{len(not_fresh)} of {total} assets could not be refreshed "
             f"({', '.join(not_fresh)}); nothing was written")
        return 1

    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fx": fx,
        "candleFields": CANDLE_FIELDS,
        "assets": assets,
    }
    errors = validate_snapshot(snapshot)
    if errors:
        for message in errors:
            fail(message)
        fail("snapshot failed validation; nothing was written")
        return 1

    write_snapshot(snapshot, settings.output)
    write_step_summary(snapshot)
    LOG.info("wrote %s: %d assets, %d not fresh%s", settings.output, len(assets), len(not_fresh),
             f" ({', '.join(not_fresh)})" if not_fresh else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
