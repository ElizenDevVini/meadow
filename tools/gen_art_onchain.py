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

# Reward rate is tied to a piece's REAL purchase value, not its raw token
# count. A piece bought for (price_tokens * MDW_PRICE_USD) dollars pays
# ANNUAL_YIELD_BPS of that value per year, and that dollar amount is converted
# into the assigned stock at its own price. This keeps the treasury cost
# proportional to money actually paid instead of paying whole shares per token.
# Prices are unknown until the token trades, so pass the real numbers via env
# before a mainnet deploy; the defaults are deliberately conservative placeholders.
#   MDW_PRICE_USD      project token price in USD (default 0.02)
#   STOCK_PRICES_USD   per-stock USD prices "TSLA:250,AAPL:230,..." or a single
#                      number applied to all (default 250)
#   ANNUAL_YIELD_BPS   target yield in bps (default 400 = 4%)
ANNUAL_YIELD_BPS = int(os.environ.get("ANNUAL_YIELD_BPS", "400"))
MDW_PRICE_USD = float(os.environ.get("MDW_PRICE_USD", "0.02"))


def stock_prices_usd():
    raw = os.environ.get("STOCK_PRICES_USD", "250")
    if ":" not in raw:
        flat = float(raw)
        return {s: flat for s in STOCK_SYMBOLS}
    out = {}
    for part in raw.split(","):
        sym, price = part.split(":")
        out[sym.strip()] = float(price)
    missing = [s for s in STOCK_SYMBOLS if s not in out]
    if missing:
        raise SystemExit(f"STOCK_PRICES_USD is missing prices for {missing}; list all of {STOCK_SYMBOLS}")
    return out


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


def rate_wei_per_second(price_tokens, stock_symbol, stock_px):
    # annual payout value in USD, then converted to whole stock tokens
    purchase_usd = price_tokens * MDW_PRICE_USD
    annual_stock = purchase_usd * (ANNUAL_YIELD_BPS / 10_000) / stock_px[stock_symbol]
    annual_wei = int(annual_stock * WAD)
    return annual_wei // SECONDS_PER_YEAR


def catalog_generated_stamp():
    mtime = os.path.getmtime(CATALOG_PATH)
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_onchain_json():
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)

    stock_px = stock_prices_usd()
    works_out = []
    for id_, work in enumerate(catalog["works"]):
        price_usd = work["last"]["price_usd"]
        price_tokens = price_tier_tokens(price_usd)
        price_wei = price_tokens * WAD
        stock_idx = stock_index_for(work["id"])
        symbol = STOCK_SYMBOLS[stock_idx]
        rate_wei = rate_wei_per_second(price_tokens, symbol, stock_px)
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
