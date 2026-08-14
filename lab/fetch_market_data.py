"""Fetch real historical prices for the wheel scenario's "choose your
underlying" control, and write js/market_data.js.

This project has no backend and no build step -- js/*.js files are read
directly by the browser, exactly as committed. Real market data can't be
fetched live from a static GitHub Pages site (no server to hide an API call
behind, and Yahoo's endpoint doesn't send CORS headers a page could call
directly anyway), so it is fetched HERE, once, offline, and baked into a
static file the same way lab/verify.py bakes analytics.py's golden values
into js/golden.js. That means the data is only as fresh as the last time this
script was run -- re-run it periodically if the "present day" end of the
range should move forward.

Source: Yahoo Finance's public v8 chart endpoint, which serves daily OHLC and
split/dividend-adjusted close without an API key. This is a personal,
non-commercial, educational site; redistributing a small derived slice of
this data for that purpose is common practice across open-source finance
tooling, but it is still someone else's data, not this project's -- worth
knowing if this script or its output ever moves somewhere more visible.

Run:  python lab/fetch_market_data.py
"""

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

START = "2009-01-01"
UA = "Mozilla/5.0 (compatible; exploring-probability data fetch)"

# Every "international" name here is a US-listed ADR (American Depositary
# Receipt) rather than a native foreign-exchange ticker (e.g. AZN, not
# AZN.L) -- ADRs trade on NYSE/NASDAQ under a plain symbol and are fetched
# through the exact same endpoint as a domestic stock, so nothing here needs
# a second URL convention for foreign exchanges.
INDICES = [
    ("^GSPC", "S&P 500"),
    ("^IXIC", "NASDAQ Composite"),
    ("^DJI", "Dow Jones Industrial Average"),
    ("^RUT", "Russell 2000"),
    ("^N225", "Nikkei 225"),
]

STOCKS = [
    # Technology
    ("AAPL", "Apple", "Technology", "domestic"),
    ("MSFT", "Microsoft", "Technology", "domestic"),
    ("IBM", "IBM", "Technology", "domestic"),
    ("TSM", "Taiwan Semiconductor", "Technology", "international"),
    ("SAP", "SAP", "Technology", "international"),
    # Healthcare
    ("JNJ", "Johnson & Johnson", "Healthcare", "domestic"),
    ("PFE", "Pfizer", "Healthcare", "domestic"),
    ("UNH", "UnitedHealth Group", "Healthcare", "domestic"),
    ("NVO", "Novo Nordisk", "Healthcare", "international"),
    ("AZN", "AstraZeneca", "Healthcare", "international"),
    # Consumer
    ("AMZN", "Amazon", "Consumer", "domestic"),
    ("WMT", "Walmart", "Consumer", "domestic"),
    ("NKE", "Nike", "Consumer", "domestic"),
    ("TM", "Toyota", "Consumer", "international"),
    ("UL", "Unilever", "Consumer", "international"),
    # Financial
    ("JPM", "JPMorgan Chase", "Financial", "domestic"),
    ("BAC", "Bank of America", "Financial", "domestic"),
    ("GS", "Goldman Sachs", "Financial", "domestic"),
    ("HSBC", "HSBC", "Financial", "international"),
    ("IBN", "ICICI Bank", "Financial", "international"),
]


def fetch(symbol, start=START, end=None, retries=3):
    """One symbol's daily adjusted-close series as (dates, prices).

    adjclose, not close: it is split- and dividend-adjusted, which is the
    honest number for a buy-and-hold comparison -- an unadjusted close would
    understate every stock's real total return by however much it has paid
    in dividends since 2009, and silently show a fake price collapse on
    every split date.
    """
    p1 = int(datetime.strptime(start, "%Y-%m-%d")
             .replace(tzinfo=timezone.utc).timestamp())
    p2 = int((end or datetime.now(timezone.utc)).timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?period1={p1}&period2={p2}&interval=1d")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = json.load(resp)
            break
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            print(f"  retry {symbol} ({e})")
            time.sleep(2)

    result = payload["chart"]["result"]
    if not result:
        raise ValueError(f"{symbol}: {payload['chart'].get('error')}")
    r = result[0]
    ts = r["timestamp"]
    closes = r["indicators"]["adjclose"][0]["adjclose"]

    dates, prices = [], []
    for t, c in zip(ts, closes):
        if c is None:
            continue  # a handful of holidays/halts come back null; skip, don't zero-fill
        dates.append(datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d"))
        prices.append(round(float(c), 4))
    return dates, prices


def main():
    entries = []
    for symbol, name in INDICES:
        print(f"fetching {symbol} ({name})...")
        dates, prices = fetch(symbol)
        entries.append({
            "symbol": symbol, "name": name, "kind": "index",
            "category": "Index", "region": "domestic" if symbol != "^N225" else "international",
            "startDate": dates[0], "endDate": dates[-1], "prices": prices,
        })
        print(f"  {len(prices)} trading days, {dates[0]} to {dates[-1]}")

    for symbol, name, category, region in STOCKS:
        print(f"fetching {symbol} ({name})...")
        dates, prices = fetch(symbol)
        entries.append({
            "symbol": symbol, "name": name, "kind": "stock",
            "category": category, "region": region,
            "startDate": dates[0], "endDate": dates[-1], "prices": prices,
        })
        print(f"  {len(prices)} trading days, {dates[0]} to {dates[-1]}")

    out = os.path.join(ROOT, "js", "market_data.js")
    with open(out, "w") as fh:
        fh.write("/* GENERATED by lab/fetch_market_data.py -- do not edit by hand.\n"
                 " * Daily split/dividend-adjusted close prices, Yahoo Finance's public\n"
                 " * chart endpoint, fetched offline (see the module docstring for why a\n"
                 " * static site cannot fetch this live). Re-run the script to refresh\n"
                 " * the \"present day\" end of the range.\n"
                 f" * Fetched {datetime.now(timezone.utc).strftime('%Y-%m-%d')}. */\n")
        fh.write("window.EP_MARKET = ")
        json.dump(entries, fh)
        fh.write(";\n")

    total_days = sum(len(e["prices"]) for e in entries)
    print(f"\nwrote {out} ({len(entries)} series, {total_days} price points, "
          f"{os.path.getsize(out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
