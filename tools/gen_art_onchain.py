#!/usr/bin/env python3
"""Generate art/data/onchain.json: per-work price/stock/rate inputs for the
MeadowArt contract, derived deterministically from art/data/catalog.json.

Token id == the work's position in catalog.json's works array, so the
contract's constructor arrays line up with this file's works array by index.

Rates are BUDGETED to the treasury actually held, not to a price formula, so
every stock is fully backed for the whole reward period. Only the stocks funded
in the meadow Safe are used, so no piece ever accrues against an empty balance.

Run: python3 tools/gen_art_onchain.py
"""
import hashlib
import json
import os
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_PATH = os.path.join(REPO_ROOT, "art", "data", "catalog.json")
OUTPUT_PATH = os.path.join(REPO_ROOT, "art", "data", "onchain.json")

# Only the stocks funded in the treasury Safe on Robinhood Chain. TSLA and MSFT
# are intentionally excluded (zero balance), so add them here only after funding.
STOCKS = [
    ("AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"),
    ("NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
    ("AMZN", "0x12f190a9F9d7D37a250758b26824B97CE941bF54"),
]
STOCK_SYMBOLS = [s for s, _ in STOCKS]

WAD = 10**18
REWARD_DAYS = int(os.environ.get("REWARD_DAYS", "365"))
REWARD_SECONDS = REWARD_DAYS * 24 * 60 * 60

# Per-stock treasury (18-decimal wei). Defaults are the current Safe balances;
# override with TREASURY_WEI="AAPL:...,NVDA:...,AMZN:..." after you top up.
DEFAULT_TREASURY_WEI = {
    "AAPL": 39379988682162039,
    "NVDA": 56910267543151945,
    "AMZN": 46680791993137663,
}
# Fraction of the treasury committed to rewards; the rest is headroom so
# rounding and late claims can never exceed the funded balance.
BUDGET_FRACTION = float(os.environ.get("BUDGET_FRACTION", "0.9"))

# Bucket a work's last USD sale price into clean project-token amounts. All 50
# catalog works fall between $58M and $450M; higher sale price never lands in a
# lower tier. A piece's tier also weights its share of the treasury budget.
PRICE_TIERS_USD = [
    (75_000_000, 100),
    (110_000_000, 250),
    (150_000_000, 500),
    (200_000_000, 1000),
    (300_000_000, 2500),
]
TOP_TIER_TOKENS = 5000


def treasury_wei():
    raw = os.environ.get("TREASURY_WEI")
    if not raw:
        return dict(DEFAULT_TREASURY_WEI)
    out = {}
    for part in raw.split(","):
        sym, amt = part.split(":")
        out[sym.strip()] = int(amt)
    missing = [s for s in STOCK_SYMBOLS if s not in out]
    if missing:
        raise SystemExit(f"TREASURY_WEI is missing {missing}; list all of {STOCK_SYMBOLS}")
    return out


def price_tier_tokens(price_usd):
    for threshold, tokens in PRICE_TIERS_USD:
        if price_usd < threshold:
            return tokens
    return TOP_TIER_TOKENS


def stock_index_for(slug):
    # Stable deterministic assignment over the funded stocks, independent of
    # catalog order.
    digest = hashlib.sha256(slug.encode("utf-8")).hexdigest()
    return int(digest, 16) % len(STOCK_SYMBOLS)


def catalog_generated_stamp():
    mtime = os.path.getmtime(CATALOG_PATH)
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_onchain_json():
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)
    works = catalog["works"]

    # Pass 1: assign each piece a stock and a price tier, and total the price
    # weight per stock so each stock's treasury can be split proportionally.
    assigned = []
    total_price = {s: 0 for s in STOCK_SYMBOLS}
    for id_, work in enumerate(works):
        price_tokens = price_tier_tokens(work["last"]["price_usd"])
        stock_idx = stock_index_for(work["id"])
        symbol = STOCK_SYMBOLS[stock_idx]
        total_price[symbol] += price_tokens
        assigned.append((id_, work, price_tokens, stock_idx, symbol))

    # Pass 2: a piece gets a share of its stock's committed budget proportional
    # to its price tier. Full-period accrual across all pieces of one stock then
    # sums to budget = treasury * BUDGET_FRACTION, so it is always backed.
    treasury = treasury_wei()
    works_out = []
    for id_, work, price_tokens, stock_idx, symbol in assigned:
        budget = int(treasury[symbol] * BUDGET_FRACTION)
        rate_wei = budget * price_tokens // total_price[symbol] // REWARD_SECONDS
        period_payout = rate_wei * REWARD_SECONDS / WAD
        works_out.append({
            "id": id_,
            "slug": work["id"],
            "title": work["title"],
            "price_tokens": price_tokens,
            "price_wei": str(price_tokens * WAD),
            "stock_symbol": symbol,
            "stock_idx": stock_idx,
            "rate_wei": str(rate_wei),
            "rate_display": f"~{period_payout:.4f} {symbol} / {REWARD_DAYS}d",
        })

    return {
        "generated": catalog_generated_stamp(),
        "stocks": [{"symbol": s, "address": a} for s, a in STOCKS],
        "project_token": "",
        "reward_days": REWARD_DAYS,
        "works": works_out,
    }


def print_summary(doc):
    works = doc["works"]
    tier_counts = {}
    stock_counts = {s: 0 for s in STOCK_SYMBOLS}
    committed = {s: 0 for s in STOCK_SYMBOLS}
    min_rate = None
    for w in works:
        tier_counts[w["price_tokens"]] = tier_counts.get(w["price_tokens"], 0) + 1
        stock_counts[w["stock_symbol"]] += 1
        committed[w["stock_symbol"]] += int(w["rate_wei"]) * doc["reward_days"] * 86400
        r = int(w["rate_wei"])
        min_rate = r if min_rate is None else min(min_rate, r)

    print(f"onchain.json: {len(works)} works, {doc['reward_days']}d period, generated {doc['generated']}")
    print("price tiers (tokens -> work count):")
    for tokens in sorted(tier_counts):
        print(f"  {tokens:>5} -> {tier_counts[tokens]}")
    print("stock -> pieces / committed over period / treasury:")
    treasury = treasury_wei()
    for s in STOCK_SYMBOLS:
        print(f"  {s}: {stock_counts[s]} pieces, commits {committed[s]/1e18:.6f}, "
              f"treasury {treasury[s]/1e18:.6f} ({100*committed[s]/treasury[s]:.1f}% used)")
    print(f"min rate_wei: {min_rate} ({'OK, nonzero' if min_rate and min_rate > 0 else 'WARNING: a rate is zero'})")


def main():
    doc = build_onchain_json()
    with open(OUTPUT_PATH, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print_summary(doc)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
