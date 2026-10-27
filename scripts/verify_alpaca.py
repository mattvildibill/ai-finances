#!/usr/bin/env python3
"""Read-only Alpaca paper/IEX preflight. Never submits orders or prints secrets."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

PAPER = "https://paper-api.alpaca.markets"
DATA = "https://data.alpaca.markets"
SYMBOLS = ("AAPL", "MSFT", "SPY")


def now():
    return datetime.now(timezone.utc).isoformat()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward credential headers to a redirect target.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, headers):
    assert url.startswith(PAPER + "/") or url.startswith(DATA + "/")
    started = now()
    try:
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(urllib.request.Request(url, headers=headers, method="GET"), timeout=30) as response:
            result = {"http_status": response.status, "body": json.load(response)}
    except urllib.error.HTTPError as exc:
        result = {"http_status": exc.code, "error": "HTTP request failed; response body intentionally omitted"}
    except Exception as exc:
        result = {"http_status": None, "error": type(exc).__name__}
    return {"endpoint": url, "retrieval_started_at": started, "retrieved_at": now(), **result}


def session_label(timestamp):
    dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
    minutes = dt.hour * 60 + dt.minute
    # Label observed timestamp only; exchange calendar/clock remains authoritative.
    return {"market_date_new_york": dt.date().isoformat(), "market_time_new_york": dt.isoformat(),
            "time_window": "regular-hours" if dt.weekday() < 5 and 570 <= minutes < 960 else "outside-regular-hours",
            "calendar_validation": "Clock authoritative for current session; timestamp window alone does not validate holiday calendar"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="docs/alpaca-verification-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json")
    args = parser.parse_args()
    required = ("ALPACA_API_KEY", "ALPACA_SECRET_KEY")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise SystemExit("Missing environment variables: " + ", ".join(missing))
    if os.environ.get("ALPACA_PAPER", "true").lower() not in ("true", "1", "yes"):
        raise SystemExit("ALPACA_PAPER must be true; only the fixed paper endpoint is supported")
    headers = {"APCA-API-KEY-ID": os.environ[required[0]], "APCA-API-SECRET-KEY": os.environ[required[1]]}
    endpoints = {
        "account": PAPER + "/v2/account",
        "clock": PAPER + "/v2/clock",
        "positions": PAPER + "/v2/positions",
        "open_orders": PAPER + "/v2/orders?status=open&limit=500",
        "latest_trades": DATA + "/v2/stocks/trades/latest?symbols=AAPL,MSFT,SPY&feed=iex",
        "snapshots": DATA + "/v2/stocks/snapshots?symbols=AAPL,MSFT,SPY&feed=iex",
    }
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {name: pool.submit(fetch, url, headers) for name, url in endpoints.items()}
        results = {name: future.result() for name, future in futures.items()}
    account_fields = ("status", "currency", "cash", "equity", "portfolio_value", "buying_power", "multiplier", "trading_blocked", "account_blocked", "shorting_enabled", "pattern_day_trader")
    if "body" in results["account"]:
        source = results["account"].pop("body")
        results["account"]["account"] = {key: source.get(key) for key in account_fields}
        results["account"]["account"]["account_id_suffix"] = str(source.get("id", ""))[-4:]
    if "body" in results["clock"]:
        results["clock"]["clock"] = results["clock"].pop("body")
    for name in ("positions", "open_orders"):
        if "body" in results[name]:
            items = results[name].pop("body")
            results[name]["count"] = len(items)
            results[name]["symbols"] = sorted({x.get("symbol") for x in items if x.get("symbol")})
    if "body" in results["latest_trades"]:
        source = results["latest_trades"].pop("body")
        results["latest_trades"]["feed"] = "iex"
        results["latest_trades"]["trades"] = {symbol: {"price": trade["p"], "market_data_at": trade["t"], "size": trade["s"], "exchange": trade["x"], "conditions": trade.get("c", []), **session_label(trade["t"])} for symbol, trade in source.get("trades", {}).items()}
    if "body" in results["snapshots"]:
        results["snapshots"]["feed"] = "iex"
        results["snapshots"]["snapshots"] = results["snapshots"].pop("body")
    report = {"verification_completed_at": now(), "mode": "read-only", "paper_endpoint_enforced": True, "orders_submitted": 0, "source": "Alpaca Trading API paper account and Market Data API IEX", "checks": results}
    report["authentication_and_data_verified"] = all(result.get("http_status") == 200 for result in results.values()) and set(results["latest_trades"].get("trades", {})) == set(SYMBOLS)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    # Evidence is append-only: choose a new output file for each verification.
    with Path(args.output).open("x") as output:
        output.write(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"saved": args.output, "verified": report["authentication_and_data_verified"], "checks": {key: value["http_status"] for key, value in results.items()}, "account": results["account"].get("account"), "clock": results["clock"].get("clock"), "trades": results["latest_trades"].get("trades")}, indent=2))
    return 0 if report["authentication_and_data_verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
