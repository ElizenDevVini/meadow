#!/usr/bin/env python3
"""Generate art/data/onchain.json: per-work price/stock/rate inputs for the
MeadowArt contract, derived deterministically from art/data/catalog.json.

Token id == the work's position in catalog.json's works array, so the
contract's constructor arrays line up with this file's works array by index.

Run: python3 tools/gen_art_onchain.py
"""
import hashlib
import json
import os
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG_PATH = os.path.join(REPO_ROOT, "art", "data", "catalog.json")
OUTPUT_PATH = os.path.join(REPO_ROOT, "art", "data", "onchain.json")

# GME appears in the site's copy but has no confirmed Robinhood Chain stock
# token address, so it is left out of the on-chain assignment pool entirely.
STOCK_SYMBOLS = ["TSLA", "AAPL", "NVDA", "MSFT", "AMZN"]

WAD = 10**18
SECONDS_PER_YEAR = 365 * 24 * 60 * 60

# Price tier mapping: bucket a work's last recorded USD sale price by rough
# order of magnitude into a small set of clean project-token amounts. All 50
# catalog works currently fall between $58M and $450M (well under one decade
# of spread), so the breakpoints below are chosen to actually split that
# range into six tiers rather than collapsing everything into one or two.
# Higher real sale price always lands in an equal or higher tier.
PRICE_TIERS_USD = [
    (75_000_000, 100),
    (110_000_000, 250),
    (150_000_000, 500),
    (200_000_000, 1000),
    (300_000_000, 2500),
]
TOP_TIER_TOKENS = 5000  # anything at or above the last breakpoint

# Reference reward rate: pay out ANNUAL_YIELD_BPS of a piece's price-tier
# token count per year, denominated in the assigned stock token (both the
# project token and every stock token are 18-decimal ERC20s, so the tier's
# token count doubles as the numeraire for the annual reward amount). This
# keeps rates modest and strictly proportional to price tier, and nowhere
# near MeadowArt.MAX_RATE (1e18 wei/sec).
ANNUAL_YIELD_BPS = 400  # 4%


def price_tier_tokens(price_usd):
    for threshold, tokens in PRICE_TIERS_USD:
        if price_usd < threshold:
            return tokens
    return TOP_TIER_TOKENS


def stock_index_for(slug):
    # Stable, deterministic assignment: sha256(slug) mod len(STOCK_SYMBOLS).
    # Independent of catalog order, so inserting/removing an unrelated work
    # never reshuffles other works' stock assignments.
    digest = hashlib.sha256(slug.encode("utf-8")).hexdigest()
    return int(digest, 16) % len(STOCK_SYMBOLS)


def rate_wei_per_second(price_tokens):
    annual_wei = price_tokens * WAD * ANNUAL_YIELD_BPS // 10_000
    return annual_wei // SECONDS_PER_YEAR


def catalog_generated_stamp():
    mtime = os.path.getmtime(CATALOG_PATH)
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_onchain_json():
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)

    works_out = []
    for id_, work in enumerate(catalog["works"]):
        price_usd = work["last"]["price_usd"]
        price_tokens = price_tier_tokens(price_usd)
        price_wei = price_tokens * WAD
        stock_idx = stock_index_for(work["id"])
        rate_wei = rate_wei_per_second(price_tokens)
        annual_tokens = rate_wei * SECONDS_PER_YEAR / WAD

        works_out.append({
            "id": id_,
            "slug": work["id"],
            "title": work["title"],
            "price_tokens": price_tokens,
            "price_wei": str(price_wei),
            "stock_symbol": STOCK_SYMBOLS[stock_idx],
            "stock_idx": stock_idx,
            "rate_wei": str(rate_wei),
            "rate_display": f"~{annual_tokens:.2f} {STOCK_SYMBOLS[stock_idx]}/year",
        })

    return {
        "generated": catalog_generated_stamp(),
        "stocks": [{"symbol": s, "address": ""} for s in STOCK_SYMBOLS],
        "project_token": "",
        "reward_days": 365,
        "works": works_out,
    }


def print_summary(doc):
    works = doc["works"]
    tier_counts = {}
    stock_counts = {s: 0 for s in STOCK_SYMBOLS}
    for w in works:
        tier_counts[w["price_tokens"]] = tier_counts.get(w["price_tokens"], 0) + 1
        stock_counts[w["stock_symbol"]] += 1

    print(f"onchain.json: {len(works)} works, generated {doc['generated']}")
    print("price tiers (tokens -> work count):")
    for tokens in sorted(tier_counts):
        print(f"  {tokens:>5} -> {tier_counts[tokens]}")
    print("stock assignment (symbol -> work count):")
    for symbol in STOCK_SYMBOLS:
        print(f"  {symbol} -> {stock_counts[symbol]}")


def main():
    doc = build_onchain_json()
    with open(OUTPUT_PATH, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print_summary(doc)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
