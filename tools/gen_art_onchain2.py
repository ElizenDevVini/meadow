#!/usr/bin/env python3
"""Generate art/data/onchain2.json: per-work price/stock/rate inputs for the
MeadowArtV2 contract, derived deterministically from art/data/works2.json
(NOT catalog2.json -- catalog2.json is sorted for display, and DeployMeadowArtV2
requires onchain2.json's works array to be in ascending id order, id == its
constructor array index).

Same mechanics as gen_art_onchain.py: rates are BUDGETED to the treasury
actually held, not to a price formula, so every stock is fully backed for the
whole reward period. One addition over v1: a PREMIUM top tier for works whose
last sale is nine figures and up ($100M+) -- see PRICE_TIERS_USD below.

Also writes the OpenSea metadata MeadowArtV2.tokenURI(id) will serve: one
JSON file per token id under art/v2/meta/, plus a collection-level
collection.json for contractURI(). Needs both onchain2.json (stock/tier per
piece, just computed) and catalog2.json (title/artist/year/medium/last sale,
already built by build2.py), joined by slug.

Run: python3 tools/gen_art_onchain2.py
"""
import hashlib
import json
import os
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKS_PATH = os.path.join(REPO_ROOT, "art", "data", "works2.json")
OUTPUT_PATH = os.path.join(REPO_ROOT, "art", "data", "onchain2.json")
CATALOG_PATH = os.path.join(REPO_ROOT, "art", "data", "catalog2.json")
META_DIR = os.path.join(REPO_ROOT, "art", "v2", "meta")

SITE_BASE = "https://elizendevvini.github.io/meadow/"

# Only the stocks funded in the treasury Safe on Robinhood Chain. Same three
# as v1 -- v2 sells against the same treasury.
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

# Bucket a work's last USD sale price into clean project-token amounts.
# Same 5 tiers as v1 (100..2500, top tier 5000 up to $100M) plus one new tier
# above it: works.json v2 includes three $100M+ pieces (a Klimt, a Giacometti,
# a Hirst), so those need a rung the v1 collection never needed.
#
#   last sale USD          price_tokens
#   < 75,000,000            100
#   < 110,000,000           250
#   < 150,000,000           500
#   < 200,000,000          1000
#   < 300,000,000          2500
#   < 100,000,000 (top)    5000   -- v1's TOP_TIER_TOKENS, still applies below premium
#   >= 100,000,000        10000000  -- PREMIUM: the marquee 10M RWArt tier
#
# Note the premium threshold (100,000,000) sits below three of the plain
# tiers' thresholds (110M, 150M, 200M, 300M): PREMIUM_THRESHOLD_USD is checked
# first, before PRICE_TIERS_USD, so any work at or above it always lands in
# the premium tier regardless of where it'd otherwise fall. In practice, with
# works2.json's actual price distribution (max non-premium sale is $80.5M),
# only the < 75M, < 110M and premium rungs are ever reached; 500/1000/2500/
# 5000 are dead code for this catalog, kept only so the ladder still applies
# unchanged if a future work lands between $80.5M and $100M.
PRICE_TIERS_USD = [
    (75_000_000, 100),
    (110_000_000, 250),
    (150_000_000, 500),
    (200_000_000, 1000),
    (300_000_000, 2500),
]
TOP_TIER_TOKENS = 5000
PREMIUM_THRESHOLD_USD = 100_000_000
PREMIUM_TOKENS = 10_000_000

# price_tokens (above) prices the piece and drives the Tier attribute, but it
# cannot also be the reward-budget weight: premium is 10,000,000 against a
# top of 5,000 elsewhere, a 2000x spread that would starve every non-premium
# piece's rate to ~0 once rounded. WEIGHT_CAP decouples the two -- a piece's
# share of its stock's reward budget is capped at what a v1 top-tier piece
# would get, even if its price tier is premium.
WEIGHT_CAP = TOP_TIER_TOKENS


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
    if price_usd >= PREMIUM_THRESHOLD_USD:
        return PREMIUM_TOKENS
    for threshold, tokens in PRICE_TIERS_USD:
        if price_usd < threshold:
            return tokens
    return TOP_TIER_TOKENS


def stock_index_for(slug):
    # Stable deterministic assignment over the funded stocks, independent of
    # catalog order.
    digest = hashlib.sha256(slug.encode("utf-8")).hexdigest()
    return int(digest, 16) % len(STOCK_SYMBOLS)


def load_works():
    with open(WORKS_PATH) as f:
        works = json.load(f)
    for w in works:
        w["sales"].sort(key=lambda s: s["date"])
    return works


def works_generated_stamp():
    mtime = os.path.getmtime(WORKS_PATH)
    return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_onchain_json():
    works = load_works()

    # Pass 1: assign each piece a stock and a price tier, in works2.json's
    # own order (id == array position 0..N-1). Total the WEIGHT (price tier
    # capped at WEIGHT_CAP, not the raw price tier) per stock so each stock's
    # treasury can be split proportionally -- see WEIGHT_CAP above for why
    # premium pieces don't get to use their full 10,000,000 as weight.
    assigned = []
    total_weight = {s: 0 for s in STOCK_SYMBOLS}
    for id_, work in enumerate(works):
        last_price = work["sales"][-1]["price_usd"]
        price_tokens = price_tier_tokens(last_price)
        weight = min(price_tokens, WEIGHT_CAP)
        stock_idx = stock_index_for(work["id"])
        symbol = STOCK_SYMBOLS[stock_idx]
        total_weight[symbol] += weight
        assigned.append((id_, work, last_price, price_tokens, weight, stock_idx, symbol))

    # Pass 2: a piece gets a share of its stock's committed budget proportional
    # to its weight (capped price tier, see pass 1). Full-period accrual
    # across all pieces of one stock then sums to budget = treasury *
    # BUDGET_FRACTION, so it is always backed. A premium piece's weight is
    # WEIGHT_CAP (5000) same as a v1 top-tier piece would be -- in this
    # catalog no non-premium work reaches that cap either (max non-premium
    # sale is $80.5M, tier 250), so premium pieces are simply the only ones
    # whose weight equals the cap, still the largest share on their stock,
    # without swamping every other piece on that stock to a rate that rounds
    # to zero.
    treasury = treasury_wei()
    works_out = []
    for id_, work, last_price, price_tokens, weight, stock_idx, symbol in assigned:
        budget = int(treasury[symbol] * BUDGET_FRACTION)
        rate_wei = budget * weight // total_weight[symbol] // REWARD_SECONDS
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
        "generated": works_generated_stamp(),
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
    premium = []
    for w in works:
        tier_counts[w["price_tokens"]] = tier_counts.get(w["price_tokens"], 0) + 1
        stock_counts[w["stock_symbol"]] += 1
        committed[w["stock_symbol"]] += int(w["rate_wei"]) * doc["reward_days"] * 86400
        r = int(w["rate_wei"])
        min_rate = r if min_rate is None else min(min_rate, r)
        if w["price_tokens"] == PREMIUM_TOKENS:
            premium.append(w)

    print(f"onchain2.json: {len(works)} works, {doc['reward_days']}d period, generated {doc['generated']}")
    print(f"works array order: works2.json order (id {works[0]['id']}..{works[-1]['id']}, "
          f"{'OK ascending' if [w['id'] for w in works] == list(range(len(works))) else 'BROKEN'})")
    print("price tiers (tokens -> work count):")
    for tokens in sorted(tier_counts):
        label = " (PREMIUM)" if tokens == PREMIUM_TOKENS else ""
        print(f"  {tokens:>9} -> {tier_counts[tokens]}{label}")
    print(f"premium tier (>= ${PREMIUM_THRESHOLD_USD:,} last sale, {PREMIUM_TOKENS:,} tokens):")
    for w in premium:
        print(f"  id {w['id']:>2} {w['slug']}")
    print("stock -> pieces / committed over period / treasury:")
    treasury = treasury_wei()
    for s in STOCK_SYMBOLS:
        print(f"  {s}: {stock_counts[s]} pieces, commits {committed[s]/1e18:.6f}, "
              f"treasury {treasury[s]/1e18:.6f} ({100*committed[s]/treasury[s]:.1f}% used)")
    print(f"min rate_wei: {min_rate} ({'OK, nonzero' if min_rate and min_rate > 0 else 'WARNING: a rate is zero'})")


# ---------- OpenSea metadata ----------

def tier_label(price_tokens):
    if price_tokens == PREMIUM_TOKENS:
        return "Premium 10M RWArt"
    return f"{price_tokens} RWArt"


def _write_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def token_metadata(onchain_work, catalog_work):
    id_ = onchain_work["id"]
    title = onchain_work["title"]
    artist = catalog_work["artist"]
    stock = onchain_work["stock_symbol"]
    return {
        "name": title,
        "description": (
            f"{title} by {artist}. A Meadow Vol. 2 piece on Robinhood Chain: "
            f"hold it to earn streaming {stock}, trade it on the Meadow marketplace."
        ),
        "image": f"{SITE_BASE}art/img2/{id_}.png",
        "external_url": f"{SITE_BASE}art/",
        "attributes": [
            {"trait_type": "Artist", "value": artist},
            {"trait_type": "Year", "value": catalog_work.get("year_text") or ""},
            {"trait_type": "Medium", "value": catalog_work.get("medium") or ""},
            {"trait_type": "Reward stock", "value": stock},
            {"trait_type": "Last sale USD", "value": catalog_work["last"]["price_usd"], "display_type": "number"},
            {"trait_type": "Tier", "value": tier_label(onchain_work["price_tokens"])},
        ],
    }


def collection_metadata():
    return {
        "name": "Meadow Vol. 2",
        "description": (
            "Thirty more blue-chip artworks on Robinhood Chain. One per wallet. "
            "Hold to earn tokenized stock, trade on the Meadow marketplace."
        ),
        "image": f"{SITE_BASE}art/img2/collection.png",
        "external_link": f"{SITE_BASE}art/",
    }


def write_metadata(doc):
    with open(CATALOG_PATH) as f:
        catalog = json.load(f)
    by_slug = {w["id"]: w for w in catalog["works"]}

    os.makedirs(META_DIR, exist_ok=True)
    written = 0
    for onchain_work in doc["works"]:
        slug = onchain_work["slug"]
        if slug not in by_slug:
            raise ValueError(f"write_metadata: {slug!r} is in onchain2.json but not catalog2.json")
        meta = token_metadata(onchain_work, by_slug[slug])
        id_ = onchain_work["id"]
        # tokenURI = baseURI + toString(id), no extension -- write both the
        # extension-less file OpenSea will actually fetch and a .json twin
        # for anyone browsing the repo or hitting the URL with one appended.
        _write_json(os.path.join(META_DIR, str(id_)), meta)
        _write_json(os.path.join(META_DIR, f"{id_}.json"), meta)
        written += 1

    _write_json(os.path.join(META_DIR, "collection.json"), collection_metadata())
    return written


def main():
    doc = build_onchain_json()
    with open(OUTPUT_PATH, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")
    print_summary(doc)
    print(f"wrote {OUTPUT_PATH}")

    n = write_metadata(doc)
    print(f"wrote {n} token metadata files (+ .json twins) and collection.json to {META_DIR}")


if __name__ == "__main__":
    main()
