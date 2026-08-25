#!/usr/bin/env python3
"""Reads art/data/works.json and writes art/data/catalog.json plus dithered
1-bit thumbnails/images in art/img/. Also computes a repeat-sales price index
(Bailey, Muth and Nourse 1963) from documented resales of the same work.
"""
import datetime
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKS_PATH = os.path.join(ROOT, "art", "data", "works.json")
CATALOG_PATH = os.path.join(ROOT, "art", "data", "catalog.json")
IMG_DIR = os.path.join(ROOT, "art", "img")
CACHE_DIR = os.path.join(ROOT, "tools", "cache")
USER_AGENT = "meadow-art-catalog/1.0 (contact: diamondkaz578@gmail.com)"
LIST_URL = "https://en.wikipedia.org/wiki/List_of_most_expensive_paintings"
BASE_YEAR = 2000
BIN_YEARS = 5
# Below this many repeat-sale pairs the index is too thin to price individual works.
MIN_PAIRS_FOR_ESTIMATES = 20


# ---------- loading and validation ----------

def load_works():
    with open(WORKS_PATH) as f:
        works = json.load(f)
    ids = [w["id"] for w in works]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(
            f"load_works: duplicate ids {dupes} in {WORKS_PATH}, "
            "rename one of each duplicate"
        )
    for w in works:
        if not w.get("sales"):
            raise ValueError(
                f"load_works: {w['id']!r} has no sales, add at least one sale"
            )
        for s in w["sales"]:
            _validate_sale(w["id"], s)
        w["sales"].sort(key=lambda s: s["date"])
    return works


def _validate_sale(work_id, sale):
    if not sale.get("date"):
        raise ValueError(f"load_works: {work_id!r} has a sale missing 'date'")
    if not isinstance(sale.get("price_usd"), int) or sale["price_usd"] <= 0:
        raise ValueError(
            f"load_works: {work_id!r} sale on {sale.get('date')} has invalid "
            f"price_usd ({sale.get('price_usd')!r}), must be a positive integer"
        )
    if not sale.get("source"):
        raise ValueError(
            f"load_works: {work_id!r} sale on {sale['date']} is missing "
            "'source', add the URL the price was read from"
        )


# ---------- dates and bins ----------

def bin_of(date_str):
    year = int(date_str[:4])
    return (year // BIN_YEARS) * BIN_YEARS


def decimal_year(date_str):
    parts = date_str.split("-")
    year = int(parts[0])
    if len(parts) == 1:
        return year + 0.5
    month = int(parts[1])
    if len(parts) == 2:
        return year + (month - 0.5) / 12
    day = int(parts[2])
    d = datetime.date(year, month, day)
    doy = (d - datetime.date(year, 1, 1)).days
    return year + doy / 365.25


# ---------- repeat-sales pairs ----------

def pairs_from(works):
    pairs, excluded = [], []
    for w in works:
        sales = w["sales"]
        for i in range(len(sales) - 1):
            s1, s2 = sales[i], sales[i + 1]
            reason = _pair_exclusion_reason(s1, s2)
            entry = {"id": w["id"], "title": w["title"], "from": s1["date"], "to": s2["date"]}
            if reason:
                excluded.append({**entry, "reason": reason})
                continue
            b1, b2 = bin_of(s1["date"]), bin_of(s2["date"])
            if b1 == b2:
                continue
            r = math.log(s2["price_usd"] / s1["price_usd"])
            years = max(1.0, decimal_year(s2["date"]) - decimal_year(s1["date"]))
            if abs(r) / years > 0.6:
                excluded.append({**entry, "reason": "extreme ratio"})
                continue
            pairs.append({**entry, "bin1": b1, "bin2": b2, "r": r})
    return pairs, excluded


def _pair_exclusion_reason(s1, s2):
    if s1.get("index", True) is False:
        return s1.get("index_note", "excluded sale")
    if s2.get("index", True) is False:
        return s2.get("index_note", "excluded sale")
    return None


# ---------- repeat-sales regression (Bailey-Muth-Nourse) ----------

def solve(matrix, rhs):
    """Gaussian elimination with partial pivoting, pure Python."""
    n = len(rhs)
    aug = [row[:] + [rhs[i]] for i, row in enumerate(matrix)]
    for col in range(n):
        pivot_row = max(range(col, n), key=lambda r: abs(aug[r][col]))
        if abs(aug[pivot_row][col]) < 1e-12:
            raise ValueError(f"solve: singular matrix at column {col}")
        aug[col], aug[pivot_row] = aug[pivot_row], aug[col]
        pivot = aug[col][col]
        for r in range(col + 1, n):
            factor = aug[r][col] / pivot
            for c in range(col, n + 1):
                aug[r][c] -= factor * aug[col][c]
    x = [0.0] * n
    for row in range(n - 1, -1, -1):
        s = aug[row][n] - sum(aug[row][c] * x[c] for c in range(row + 1, n))
        x[row] = s / aug[row][row]
    return x


def _connected_component(pairs, ground_bin):
    adjacency = defaultdict(set)
    for p in pairs:
        adjacency[p["bin1"]].add(p["bin2"])
        adjacency[p["bin2"]].add(p["bin1"])
    visited = {ground_bin}
    queue = deque([ground_bin])
    while queue:
        cur = queue.popleft()
        for nxt in adjacency[cur]:
            if nxt not in visited:
                visited.add(nxt)
                queue.append(nxt)
    return visited


def _normal_equations(pairs, col_index, n):
    xtx = [[0.0] * n for _ in range(n)]
    xty = [0.0] * n
    for p in pairs:
        i, j, r = col_index.get(p["bin1"]), col_index.get(p["bin2"]), p["r"]
        if i is not None:
            xtx[i][i] += 1
            xty[i] -= r
        if j is not None:
            xtx[j][j] += 1
            xty[j] += r
        if i is not None and j is not None:
            xtx[i][j] -= 1
            xtx[j][i] -= 1
    return xtx, xty


def repeat_sales_index(pairs):
    if not pairs:
        return {"levels": {}, "pairs_used": 0, "disconnected": [], "residuals": []}

    degree = defaultdict(int)
    for p in pairs:
        degree[p["bin1"]] += 1
        degree[p["bin2"]] += 1
    ground_bin = max(degree, key=lambda b: degree[b])
    component = _connected_component(pairs, ground_bin)

    kept, disconnected = [], []
    for p in pairs:
        if p["bin1"] in component and p["bin2"] in component:
            kept.append(p)
        else:
            disconnected.append({
                "id": p["id"], "title": p["title"],
                "from": p["from"], "to": p["to"], "reason": "disconnected",
            })

    unknowns = sorted(b for b in component if b != ground_bin)
    col_index = {b: i for i, b in enumerate(unknowns)}
    log_values = {ground_bin: 0.0}
    if unknowns:
        xtx, xty = _normal_equations(kept, col_index, len(unknowns))
        x = solve(xtx, xty)
        for b, i in col_index.items():
            log_values[b] = x[i]

    residuals = []
    for p in kept:
        r_hat = log_values[p["bin2"]] - log_values[p["bin1"]]
        residuals.append({"id": p["id"], "from": p["from"], "to": p["to"], "resid": p["r"] - r_hat})

    levels = {b: math.exp(v) for b, v in log_values.items()}
    return {"levels": levels, "pairs_used": len(kept), "disconnected": disconnected, "residuals": residuals}


def _interp_log(year, sorted_bins, levels):
    lower = max((b for b in sorted_bins if b <= year), default=None)
    upper = min((b for b in sorted_bins if b >= year), default=None)
    if lower == upper:
        return math.log(levels[lower])
    frac = (year - lower) / (upper - lower)
    return (1 - frac) * math.log(levels[lower]) + frac * math.log(levels[upper])


def finalize_index(levels):
    """Shift levels so bin BASE_YEAR = 100 and lay them out over a fixed
    1940..max(2025, latest touched bin) range, null outside the touched span."""
    sorted_bins = sorted(levels)
    lo, hi = sorted_bins[0], sorted_bins[-1]

    if BASE_YEAR in levels:
        base_log = math.log(levels[BASE_YEAR])
    elif lo < BASE_YEAR < hi:
        base_log = _interp_log(BASE_YEAR, sorted_bins, levels)
    else:
        edge = lo if BASE_YEAR < lo else hi
        base_log = math.log(levels[edge])
        print(
            f"warning: base year {BASE_YEAR} is outside touched range "
            f"[{lo},{hi}], normalizing to nearest bin {edge} instead",
            file=sys.stderr,
        )

    all_bins = list(range(1940, max(2025, hi) + BIN_YEARS, BIN_YEARS))
    values, touched = [], []
    for b in all_bins:
        is_touched = b in levels
        touched.append(is_touched)
        if lo <= b <= hi:
            log_v = math.log(levels[b]) if is_touched else _interp_log(b, sorted_bins, levels)
            values.append(round(math.exp(log_v - base_log) * 100, 4))
        else:
            values.append(None)
    return all_bins, values, touched, hi


# ---------- per-work series ----------

def estimate(work, bins, values, latest_bin):
    last = work["sales"][-1]
    if last.get("index", True) is False:
        return None
    last_bin = bin_of(last["date"])
    if last_bin == latest_bin or last_bin not in bins:
        return None
    v_last = values[bins.index(last_bin)]
    v_latest = values[bins.index(latest_bin)]
    if v_last is None or v_latest is None:
        return None
    return round(last["price_usd"] * v_latest / v_last)


def series(work, bins, values, latest_bin):
    def value_at(b):
        return values[bins.index(b)] if b in bins else None

    def add_segment(points, anchor_sale, start_bin, end_bin):
        if end_bin is None:
            return  # no index computed at all (zero valid pairs in the catalog)
        v_anchor = value_at(bin_of(anchor_sale["date"]))
        if v_anchor is None:
            return
        for b in range(start_bin, end_bin + 1, BIN_YEARS):
            v_b = value_at(b)
            if v_b is not None:
                points.append({"x": float(b), "v": round(anchor_sale["price_usd"] * v_b / v_anchor, 2), "kind": "index"})

    sales = work["sales"]
    points = [{"x": round(decimal_year(s["date"]), 3), "v": s["price_usd"], "kind": "sale"} for s in sales]
    for i in range(len(sales) - 1):
        add_segment(points, sales[i], bin_of(sales[i]["date"]) + BIN_YEARS, bin_of(sales[i + 1]["date"]))
    if sales:
        add_segment(points, sales[-1], bin_of(sales[-1]["date"]) + BIN_YEARS, latest_bin)
    points.sort(key=lambda p: p["x"])
    return points


# ---------- images ----------

def _urlopen_with_retry(url, work_id, tries=4):
    """Wikimedia rate-limits bursts of requests (HTTP 429); back off and retry
    a few times before giving up on this one image."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == tries - 1:
                raise
            wait = 5 * (attempt + 1)
            print(f"warning: 429 from Wikimedia for {work_id}, retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def fetch_image(title, work_id):
    """Download the Commons image for `title` into tools/cache, refusing
    anything not explicitly public domain / CC0. Returns the cache path or
    None (printing a warning) if refused or unavailable."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f"{work_id}.jpg")
    if os.path.exists(cache_path):
        return cache_path

    api_url = (
        "https://commons.wikimedia.org/w/api.php?action=query&titles="
        + urllib.parse.quote(f"File:{title}")
        + "&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=480&format=json"
    )
    with _urlopen_with_retry(api_url, work_id) as resp:
        data = json.load(resp)
    page = next(iter(data.get("query", {}).get("pages", {}).values()), None)
    if not page or "imageinfo" not in page:
        print(f"warning: no imageinfo for {title!r} ({work_id}), skipping image", file=sys.stderr)
        return None

    info = page["imageinfo"][0]
    license_short = info.get("extmetadata", {}).get("LicenseShortName", {}).get("value", "")
    if not (license_short.startswith("Public domain") or license_short.startswith("CC0")):
        print(f"warning: {title!r} ({work_id}) license {license_short!r} not public domain/CC0, skipping", file=sys.stderr)
        return None

    thumb_url = info.get("thumburl")
    if not thumb_url:
        print(f"warning: no thumburl for {title!r} ({work_id}), skipping image", file=sys.stderr)
        return None
    with _urlopen_with_retry(thumb_url, work_id) as resp2:
        img_bytes = resp2.read()
    with open(cache_path, "wb") as f:
        f.write(img_bytes)
    time.sleep(1)  # be polite to Wikimedia between downloads
    return cache_path


def dither(im, width):
    gray = ImageOps.autocontrast(im.convert("L"), cutoff=1)
    height = round(gray.height * (width / gray.width))
    resized = gray.resize((width, height), Image.LANCZOS)
    one = resized.convert("1", dither=Image.Dither.FLOYDSTEINBERG)
    p = one.convert("L").point(lambda v: 0 if v else 1).convert("P")
    p.putpalette([0xE0, 0xE0, 0xE0, 0x1F, 0x56, 0xD6])
    return p


def write_images(work_id, cache_path):
    os.makedirs(IMG_DIR, exist_ok=True)
    im = Image.open(cache_path)
    im.load()
    paths = {}
    for label, width in (("thumb", 200), ("full", 480)):
        out_path = os.path.join(IMG_DIR, f"{work_id}{'-t' if label == 'thumb' else ''}.png")
        dither(im, width).save(out_path, optimize=True, bits=1)
        colors = Image.open(out_path).getcolors()
        if colors is None or len(colors) > 2:
            raise ValueError(f"dither: {out_path} has more than 2 colors, palette logic is broken")
        paths[label] = f"img/{os.path.basename(out_path)}"
    return paths


# ---------- catalog assembly ----------

def _work_entry(w, bins, values, latest_bin, img):
    sales = w["sales"]
    first, last = sales[0], sales[-1]
    est = estimate(w, bins, values, latest_bin)
    ser = series(w, bins, values, latest_bin)
    gain = round(last["price_usd"] / first["price_usd"], 4) if len(sales) >= 2 else None
    return {
        "id": w["id"], "title": w["title"], "artist": w["artist"],
        "artist_died": w.get("artist_died"), "year": w.get("year"),
        "year_text": w.get("year_text"), "medium": w.get("medium"),
        "wikipedia_url": w.get("wikipedia_url"), "img": img, "sales": sales,
        "last": {"date": last["date"], "year": int(last["date"][:4]), "price_usd": last["price_usd"], "channel": last.get("channel")},
        "first": {"date": first["date"], "year": int(first["date"][:4]), "price_usd": first["price_usd"]},
        "est_now": est, "gain": gain, "series": ser, "spark": [p["v"] for p in ser],
    }


def write_catalog(works):
    pairs, excluded = pairs_from(works)
    result = repeat_sales_index(pairs)
    if result["levels"]:
        bins, values, touched, latest_bin = finalize_index(result["levels"])
    else:
        bins, values, touched, latest_bin = [], [], [], None

    images_written = 0
    entries = []
    for w in works:
        img = None
        if w.get("image"):
            cache_path = fetch_image(w["image"], w["id"])
            if cache_path:
                img = write_images(w["id"], cache_path)
                images_written += 1
        entries.append(_work_entry(w, bins, values, latest_bin, img))
    entries.sort(key=lambda e: -e["last"]["price_usd"])

    mtime = os.path.getmtime(WORKS_PATH)
    generated = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    estimates_enabled = result["pairs_used"] >= MIN_PAIRS_FOR_ESTIMATES
    if not estimates_enabled:
        for e in entries:
            e["est_now"] = None
    estimates_note = (
        "" if estimates_enabled else
        f"per-work estimates are off: they need at least {MIN_PAIRS_FOR_ESTIMATES} repeat-sale pairs and the index has {result['pairs_used']}"
    )
    catalog = {
        "generated": generated,
        "attribution": {
            "records": "Sale records compiled from Wikipedia, List of most expensive paintings and individual articles, CC BY-SA 4.0",
            "records_url": LIST_URL,
            "images": "Wikimedia Commons, public domain",
            "prices": "Prices as reported, usually including buyer's premium, nominal USD",
        },
        "index": {
            "name": "meadow trophy index", "base_year": BASE_YEAR, "bin_years": BIN_YEARS,
            "bins": bins, "values": values, "touched": touched, "latest_bin": latest_bin,
            "pairs_used": result["pairs_used"],
            "estimates_enabled": estimates_enabled,
            "estimates_note": estimates_note,
            "pairs_excluded": excluded + result["disconnected"],
            "residuals": result["residuals"],
            "method": "Repeat-sales regression (Bailey, Muth and Nourse 1963; Mei and Moses 2002) on documented resales of the same work, 5-year bins, computed by Meadow from public records",
        },
        "works": entries,
    }

    os.makedirs(os.path.dirname(CATALOG_PATH), exist_ok=True)
    with open(CATALOG_PATH, "w") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")

    _print_summary(works, pairs, excluded, result, bins, values, touched, images_written)


def _print_summary(works, pairs, excluded, result, bins, values, touched, images_written):
    total_sales = sum(len(w["sales"]) for w in works)
    print(f"works: {len(works)}  sales: {total_sales}  images written: {images_written}")
    print(f"pairs used: {result['pairs_used']}  pairs excluded: {len(excluded) + len(result['disconnected'])}")
    for e in excluded + result["disconnected"]:
        print(f"  excluded {e['id']} {e['from']}->{e['to']}: {e['reason']}")
    print("bins with values:")
    for b, v, t in zip(bins, values, touched):
        if v is not None:
            print(f"  {b}: {v}{' (touched)' if t else ' (interpolated)'}")
    print("residuals (sorted by magnitude):")
    for r in sorted(result["residuals"], key=lambda r: -abs(r["resid"])):
        print(f"  {r['id']} {r['from']}->{r['to']}: {r['resid']:.4f}")


# ---------- self-test ----------

def _selftest():
    bins = list(range(1960, 2021, BIN_YEARS))
    true_log = {b: 0.05 * i - 0.0015 * i * i for i, b in enumerate(bins)}
    pairs = []
    for i in range(len(bins) - 1):
        b1, b2 = bins[i], bins[i + 1]
        pairs.append({"id": f"s{i}", "title": "synthetic", "from": f"{b1}-01", "to": f"{b2}-01",
                      "bin1": b1, "bin2": b2, "r": true_log[b2] - true_log[b1]})
    pairs.append({"id": "s-long", "title": "synthetic", "from": f"{bins[0]}-01", "to": f"{bins[-1]}-01",
                  "bin1": bins[0], "bin2": bins[-1], "r": true_log[bins[-1]] - true_log[bins[0]]})

    result = repeat_sales_index(pairs)
    ground_bin = next(b for b, lv in result["levels"].items() if lv == 1.0)
    max_err = 0.0
    for b in bins:
        recovered = math.log(result["levels"][b]) - math.log(result["levels"][ground_bin])
        expected = true_log[b] - true_log[ground_bin]
        max_err = max(max_err, abs(recovered - expected))
    assert max_err < 1e-9, f"selftest: recovery error {max_err} exceeds 1e-9"
    print(f"PASS (max recovery error {max_err:.2e})")


def main():
    if "--selftest" in sys.argv:
        _selftest()
        return
    works = load_works()
    write_catalog(works)


if __name__ == "__main__":
    main()
