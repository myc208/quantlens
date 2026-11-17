#!/usr/bin/env python3
"""Run tests/engines.test.html in a headless browser and report the result.

This is the CI gate. It uses only the Python standard library and a Chromium
family browser that is already installed (Google Chrome on GitHub's runners;
Chrome, Chromium or Edge locally), so it adds no dependency to the project.

How it works
------------
1. Serve the repository on a random local port.
2. Open the test page headlessly with ``?report=<one-time path>``.
3. The page runs its suites and POSTs the totals back to that path.
4. Print the result and exit 0 only if every test passed.

The page reports by POST rather than being scraped, so no virtual clock,
polling or DevTools connection is needed, and the asynchronous tests run in
real time exactly as they do for a person.

Usage
-----
    python scripts/run_browser_tests.py
    python scripts/run_browser_tests.py --browser "C:/Program Files/Google/Chrome/Application/chrome.exe"

Exit codes: 0 all tests passed · 1 a test failed · 2 the suite could not be run.
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PAGE = "tests/engines.test.html"
MAX_REPORT_BYTES = 5_000_000

BROWSER_ENV_VARS = ("QUANTLENS_BROWSER", "CHROME_BIN", "CHROME_PATH")
BROWSER_COMMANDS = (
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "chrome", "microsoft-edge", "microsoft-edge-stable", "msedge",
)
BROWSER_PATHS = (
    # Windows
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    # macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
)


def find_browser(explicit: str | None) -> str | None:
    """Locate a Chromium-family browser: environment, PATH, then known locations.

    An explicit path is used as given and never silently replaced by another browser.
    """
    if explicit:
        return explicit if Path(explicit).is_file() else None
    candidates: list[str] = []
    candidates.extend(os.environ[name] for name in BROWSER_ENV_VARS if os.environ.get(name))
    for command in BROWSER_COMMANDS:
        found = shutil.which(command)
        if found:
            candidates.append(found)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(str(Path(local_app_data) / "Google" / "Chrome" / "Application" / "chrome.exe"))
    candidates.extend(BROWSER_PATHS)
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


class TestServer(ThreadingHTTPServer):
    """Static file server that also accepts one result report."""

    daemon_threads = True

    def __init__(self, root: Path, report_path: str) -> None:
        handler = functools.partial(Handler, directory=str(root))
        super().__init__(("127.0.0.1", 0), handler)
        self.report_path = report_path
        self.report: dict[str, Any] | None = None
        self.report_received = threading.Event()

    def handle_error(self, request: Any, client_address: Any) -> None:
        # The browser is stopped as soon as the report arrives, which can cut off a request
        # that is still in flight. That is expected and must not bury the result in a traceback.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


class Handler(SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain through the registry, which makes browsers
    # refuse ES modules. Pin the types this site uses.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".html": "text/html",
    }

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - signature of the base class
        return  # keep CI logs readable

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self) -> None:  # noqa: N802 - name required by http.server
        server: TestServer = self.server  # type: ignore[assignment]
        if self.path != server.report_path:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if not 0 < length <= MAX_REPORT_BYTES:
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        try:
            report = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        if isinstance(report, dict):
            server.report = report
            server.report_received.set()
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()


def browser_arguments(browser: str, profile_dir: str, url: str) -> list[str]:
    arguments = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--mute-audio",
        "--window-size=1280,900",
        f"--user-data-dir={profile_dir}",
    ]
    # Hosted CI runners restrict the user namespaces Chromium's sandbox needs. The
    # browser only ever loads this repository's own pages from localhost here.
    running_as_root = hasattr(os, "geteuid") and os.geteuid() == 0
    if os.environ.get("CI") or running_as_root:
        arguments.append("--no-sandbox")
    arguments.append(url)
    return arguments


def stop_browser(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass


def valid_report(report: Any) -> bool:
    if not isinstance(report, dict):
        return False
    counts = [report.get(key) for key in ("total", "passed", "failed", "skipped")]
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in counts):
        return False
    return isinstance(report.get("failures"), list) and report["passed"] + report["failed"] + report["skipped"] == report["total"]


def write_step_summary(lines: list[str]) -> None:
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if not target:
        return
    with open(target, "a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def annotate(level: str, message: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::{level}::{message}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the QuantLens browser test suite headlessly.")
    parser.add_argument("--page", default=DEFAULT_PAGE, help="test page, relative to the repository root")
    parser.add_argument("--browser", default=None, help="path to a Chrome, Chromium or Edge executable")
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to wait for the suite to finish")
    parser.add_argument("--min-tests", type=int, default=1, help="fail if fewer tests than this ran")
    settings = parser.parse_args(argv)

    page = (REPO_ROOT / settings.page).resolve()
    if REPO_ROOT not in page.parents or not page.is_file():
        print(f"error: test page not found inside the repository: {settings.page}", file=sys.stderr)
        return 2

    browser = find_browser(settings.browser)
    if browser is None:
        message = (f"the browser given with --browser does not exist: {settings.browser}" if settings.browser
                   else "no Chrome, Chromium or Edge executable was found. "
                        "Install one, or pass --browser or set QUANTLENS_BROWSER.")
        print(f"error: {message}", file=sys.stderr)
        annotate("error", message)
        return 2

    report_path = f"/__quantlens_test_report__/{secrets.token_hex(16)}"
    server = TestServer(REPO_ROOT, report_path)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, name="test-server", daemon=True).start()
    relative = page.relative_to(REPO_ROOT).as_posix()
    url = f"http://127.0.0.1:{port}/{relative}?report={report_path}"

    profile_dir = tempfile.mkdtemp(prefix="quantlens-tests-")
    print(f"browser: {browser}")
    print(f"page:    http://127.0.0.1:{port}/{relative}")
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(browser_arguments(browser, profile_dir, url),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        finished = server.report_received.wait(settings.timeout)
    finally:
        stderr_tail = b""
        if process is not None:
            stop_browser(process)
            if process.stderr is not None:
                try:
                    stderr_tail = process.stderr.read()[-2000:]
                except (OSError, ValueError):
                    stderr_tail = b""
        server.shutdown()
        server.server_close()
        shutil.rmtree(profile_dir, ignore_errors=True)

    if not finished:
        message = (f"the test page did not report within {settings.timeout:.0f}s. "
                   "A script error may have stopped it before any test ran.")
        print(f"error: {message}", file=sys.stderr)
        if stderr_tail:
            print("browser output:\n" + stderr_tail.decode("utf-8", "replace"), file=sys.stderr)
        annotate("error", message)
        write_step_summary(["### Browser tests", "", f"Could not run: {message}"])
        return 2

    report = server.report
    if not valid_report(report):
        print("error: the test page sent a malformed report", file=sys.stderr)
        annotate("error", "the test page sent a malformed report")
        return 2

    total, passed, failed, skipped = report["total"], report["passed"], report["failed"], report["skipped"]
    duration = report.get("durationMs")
    timing = f" in {duration} ms" if isinstance(duration, (int, float)) else ""
    print(f"\n{passed} passed, {failed} failed, {skipped} skipped, {total} total{timing}")

    summary = ["### Browser tests", "", f"**{passed} passed**, {failed} failed, {skipped} skipped, {total} total{timing}"]
    for failure in report["failures"]:
        if not isinstance(failure, dict):
            continue
        suite, test, detail = (str(failure.get(key, "")) for key in ("suite", "test", "message"))
        print(f"\nFAILED  {suite} > {test}\n        " + detail.replace("\n", "\n        "))
        annotate("error", f"{suite} > {test}: {detail.splitlines()[0] if detail else 'failed'}")
        summary.append(f"- **{suite} > {test}**: {detail.splitlines()[0] if detail else 'failed'}")
    write_step_summary(summary)

    if total < settings.min_tests:
        message = f"only {total} tests ran; at least {settings.min_tests} were expected"
        print(f"error: {message}", file=sys.stderr)
        annotate("error", message)
        return 1
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
