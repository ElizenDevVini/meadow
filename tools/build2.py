#!/usr/bin/env python3
"""Reads art/data/works2.json and writes art/data/catalog2.json plus 1-bit
thumbnails/images in art/img2/. This is the Vol. 2 counterpart to build.py:
same repeat-sales index, same Commons fetch + Floyd-Steinberg dither, same
catalog shape. The one addition is that Vol. 2 has works with no public
domain image on Commons (`image: null`); those get a generated pixel
name-plate instead so no piece ever ships with a blank image.

Run: python3 tools/build2.py
"""
import datetime
import json
import os
import sys
import unicodedata

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build as v1  # reuse the repeat-sales math, dither, and Commons fetch/license logic

ROOT = v1.ROOT
WORKS_PATH = os.path.join(ROOT, "art", "data", "works2.json")
CATALOG_PATH = os.path.join(ROOT, "art", "data", "catalog2.json")
IMG_DIR = os.path.join(ROOT, "art", "img2")
CACHE_DIR = os.path.join(ROOT, "tools", "cache2")
LIST_URL = v1.LIST_URL
BASE_YEAR = v1.BASE_YEAR
BIN_YEARS = v1.BIN_YEARS

# works2.json has only a handful of works with 2+ sales, so the repeat-sales
# regression can end up fit through as few as 1-2 connected pairs spanning
# many bins. build.py's own EST_MIN/MAX_RATIO band only guards est_now, not
# the series()/spark values a chart actually draws -- with this few pairs an
# interpolated series can land 100x off the real sale price. Below this
# floor, suppress the index outright (bins/values empty) rather than draw a
# chart the regression didn't have the data to support.
#
# 4 is a judgment call, not a spec requirement -- works2.json currently
# yields pairs_used=2, well under it either way, so the suppression isn't
# close to the line. Raise or lower this if repeat sales get added later.
MIN_PAIRS_FOR_INDEX = 4

PALETTE = [0xE0, 0xE0, 0xE0, 0x1F, 0x56, 0xD6]  # index 0 paper, index 1 ink -- same as build.py


# ---------- loading and validation ----------

def load_works():
    with open(WORKS_PATH) as f:
        works = json.load(f)
    ids = [w["id"] for w in works]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(
            f"load_works: duplicate ids {dupes} in {WORKS_PATH}, rename one of each duplicate"
        )
    for w in works:
        if not w.get("sales"):
            raise ValueError(f"load_works: {w['id']!r} has no sales, add at least one sale")
        for s in w["sales"]:
            v1._validate_sale(w["id"], s)
        w["sales"].sort(key=lambda s: s["date"])
    return works


# ---------- images: photos ----------

def fetch_and_open(work_id, image_title):
    """Reuse build.py's Commons fetch + public-domain/CC0 license check by
    pointing its module-level cache dir at ours for the call, then
    restoring it. Returns an opened PIL image, or None if the fetch was
    refused or failed (network error, no imageinfo, etc)."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    old_cache = v1.CACHE_DIR
    v1.CACHE_DIR = CACHE_DIR
    try:
        cache_path = v1.fetch_image(image_title, work_id)
    except (OSError, ValueError) as exc:
        print(f"warning: fetch failed for {work_id!r}: {exc}", file=sys.stderr)
        cache_path = None
    finally:
        v1.CACHE_DIR = old_cache
    if not cache_path:
        return None
    im = Image.open(cache_path)
    im.load()
    return im


def _check_palette(path):
    colors = Image.open(path).getcolors()
    if colors is None or len(colors) > 2:
        raise ValueError(f"palette check: {path} has more than 2 colors, image logic is broken")


def write_photo_images(token_id, im):
    # Filenames are the numeric token id (0..29, works2.json array position),
    # not the work's slug -- OpenSea metadata and the deploy script both
    # address pieces by that position, so art/img2 has to match.
    os.makedirs(IMG_DIR, exist_ok=True)
    paths = {}
    for label, width in (("thumb", 200), ("full", 480)):
        out_path = os.path.join(IMG_DIR, f"{token_id}{'-t' if label == 'thumb' else ''}.png")
        v1.dither(im, width).save(out_path, optimize=True, bits=1)
        _check_palette(out_path)
        paths[label] = f"img2/{os.path.basename(out_path)}"
    return paths


# ---------- images: generated name-plates ----------

def _fold_ascii(text):
    """The bundled default bitmap font has no glyphs for accented Latin
    characters (they render as tofu boxes), so fold to plain ASCII for the
    plate text."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def _to_palette(bw):
    """bw: mode '1' image, ink drawn as 0 (black) and paper background as
    255 (white). Same paper/ink palette mapping as build.dither. Drawing in
    mode '1' (not 'L') matters: '1' is a hard threshold with no
    anti-aliasing, so small text doesn't dissolve into stray gray pixels
    that would push the final PNG past 2 colors."""
    p = bw.convert("L").point(lambda v: 0 if v else 1).convert("P")
    p.putpalette(PALETTE)
    return p


def _wrap_lines(draw, text, font, max_width):
    words = text.split()
    lines, cur = [], []
    for word in words:
        trial = " ".join(cur + [word])
        if cur and draw.textlength(trial, font=font) > max_width:
            lines.append(" ".join(cur))
            cur = [word]
        else:
            cur.append(word)
    if cur:
        lines.append(" ".join(cur))
    return lines


# checker square size and title/artist font size, scaled per output width
PLATE_PARAMS = {
    480: {"border": 2, "unit": 12, "title_size": 24, "artist_size": 16},
    200: {"border": 2, "unit": 6, "title_size": 12, "artist_size": 8},
}


def make_plate(width, height, title, artist):
    p = PLATE_PARAMS[width]
    border, unit = p["border"], p["unit"]
    im = Image.new("1", (width, height), 255)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, width - 1, height - 1], outline=0, width=border)

    # checkerboard strip along the top, inside the border
    strip_h = unit * 2
    y0 = border
    x = border
    while x < width - border:
        for row in range(2):
            y = y0 + row * unit
            if (x // unit + row) % 2 == 0:
                d.rectangle([x, y, min(x + unit, width - border) - 1, y + unit - 1], fill=0)
        x += unit

    title_font = ImageFont.load_default(size=p["title_size"])
    artist_font = ImageFont.load_default(size=p["artist_size"])
    max_text_width = width - 2 * border - unit

    title_lines = _wrap_lines(d, _fold_ascii(title).upper(), title_font, max_text_width)
    artist_lines = _wrap_lines(d, _fold_ascii(artist).upper(), artist_font, max_text_width)

    title_lh = p["title_size"] + 4
    artist_lh = p["artist_size"] + 3
    gap = p["artist_size"]
    total_h = title_lh * len(title_lines) + gap + artist_lh * len(artist_lines)

    top = y0 + strip_h + gap
    bottom = height - border - gap
    ty = top + max(0, (bottom - top - total_h) / 2)

    for line in title_lines:
        tw = d.textlength(line, font=title_font)
        d.text(((width - tw) / 2, ty), line, font=title_font, fill=0)
        ty += title_lh
    ty += gap - p["artist_size"] / 2
    for line in artist_lines:
        tw = d.textlength(line, font=artist_font)
        d.text(((width - tw) / 2, ty), line, font=artist_font, fill=0)
        ty += artist_lh

    return _to_palette(im)


def write_plate_images(token_id, title, artist):
    os.makedirs(IMG_DIR, exist_ok=True)
    paths = {}
    for label, (width, height) in (("thumb", (200, 150)), ("full", (480, 360))):
        out_path = os.path.join(IMG_DIR, f"{token_id}{'-t' if label == 'thumb' else ''}.png")
        make_plate(width, height, title, artist).save(out_path, optimize=True, bits=1)
        _check_palette(out_path)
        paths[label] = f"img2/{os.path.basename(out_path)}"
    return paths


def make_collection_logo():
    """600x600 collection-level mark for art/img2/collection.png, used by
    contractURI's collection.json."""
    width = height = 600
    border, unit = 3, 24
    im = Image.new("1", (width, height), 255)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, width - 1, height - 1], outline=0, width=border)

    strip_h = unit * 2
    y0 = border
    x = border
    while x < width - border:
        for row in range(2):
            y = y0 + row * unit
            if (x // unit + row) % 2 == 0:
                d.rectangle([x, y, min(x + unit, width - border) - 1, y + unit - 1], fill=0)
        x += unit

    y1 = height - border - strip_h
    x = border
    while x < width - border:
        for row in range(2):
            y = y1 + row * unit
            if (x // unit + row) % 2 == 1:
                d.rectangle([x, y, min(x + unit, width - border) - 1, y + unit - 1], fill=0)
        x += unit

    font = ImageFont.load_default(size=52)
    sub_font = ImageFont.load_default(size=26)
    lines = ["MEADOW", "VOL. 2"]
    line_h = 60
    total_h = line_h * len(lines)
    top = y0 + strip_h + 20
    bottom = y1 - 20
    ty = top + max(0, (bottom - top - total_h - 40) / 2)
    for line in lines:
        tw = d.textlength(line, font=font)
        d.text(((width - tw) / 2, ty), line, font=font, fill=0)
        ty += line_h
    ty += 20
    sub = "THIRTY MORE PIECES"
    tw = d.textlength(sub, font=sub_font)
    d.text(((width - tw) / 2, ty), sub, font=sub_font, fill=0)

    out_path = os.path.join(IMG_DIR, "collection.png")
    os.makedirs(IMG_DIR, exist_ok=True)
    _to_palette(im).save(out_path, optimize=True, bits=1)
    _check_palette(out_path)
    return out_path


# ---------- catalog assembly ----------

def write_catalog(works):
    pairs, excluded = v1.pairs_from(works)
    result = v1.repeat_sales_index(pairs)
    if result["levels"] and result["pairs_used"] >= MIN_PAIRS_FOR_INDEX:
        bins, values, touched, latest_bin = v1.finalize_index(result["levels"])
    else:
        bins, values, touched, latest_bin = [], [], [], None

    photos_written, plates_written, fetch_failed = 0, 0, []
    entries = []
    # token_id is the work's position in works2.json (0..29) -- image filenames,
    # onchain2.json, and the OpenSea metadata files all address a piece by this
    # number, so it has to be assigned here from unsorted `works`, before the
    # display sort below.
    for token_id, w in enumerate(works):
        img = None
        if w.get("image"):
            im = fetch_and_open(w["id"], w["image"])
            if im is not None:
                img = write_photo_images(token_id, im)
                photos_written += 1
            else:
                fetch_failed.append(w["id"])
        if img is None:
            img = write_plate_images(token_id, w["title"], w["artist"])
            plates_written += 1
        entry = v1._work_entry(w, bins, values, latest_bin, img)
        entry["token_id"] = token_id
        entries.append(entry)
    entries.sort(key=lambda e: -e["last"]["price_usd"])

    logo_path = make_collection_logo()

    mtime = os.path.getmtime(WORKS_PATH)
    generated = datetime.datetime.fromtimestamp(mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if result["pairs_used"] < MIN_PAIRS_FOR_INDEX:
        estimates_note = (
            f"the index has only {result['pairs_used']} repeat-sale pairs (below the "
            f"{MIN_PAIRS_FOR_INDEX}-pair floor this catalog requires), so it is suppressed "
            "entirely -- bins/values are empty and every work's series/spark is just its "
            "documented sales, no interpolated or extrapolated points"
        )
    else:
        estimates_note = (
            f"the index has only {result['pairs_used']} repeat-sale pairs, so a per-work "
            f"estimate is shown only when it falls within {v1.EST_MIN_RATIO}x-{v1.EST_MAX_RATIO}x of "
            "the last sale; wider swings are suppressed as noise, not shown"
        )
    catalog = {
        "generated": generated,
        "attribution": {
            "records": "Sale records compiled from Wikipedia, List of most expensive paintings and individual articles, CC BY-SA 4.0",
            "records_url": LIST_URL,
            "images": "Wikimedia Commons, public domain, where available; works without a public-domain Commons image use a Meadow-generated name-plate instead",
            "prices": "Prices as reported, usually including buyer's premium, nominal USD",
        },
        "index": {
            "name": "meadow trophy index vol. 2", "base_year": BASE_YEAR, "bin_years": BIN_YEARS,
            "bins": bins, "values": values, "touched": touched, "latest_bin": latest_bin,
            "pairs_used": result["pairs_used"],
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

    _print_summary(works, pairs, excluded, result, bins, values, touched,
                    photos_written, plates_written, fetch_failed, logo_path)


def _print_summary(works, pairs, excluded, result, bins, values, touched,
                    photos_written, plates_written, fetch_failed, logo_path):
    total_sales = sum(len(w["sales"]) for w in works)
    print(f"works: {len(works)}  sales: {total_sales}")
    print(f"images: {photos_written} photos (dithered from Commons), {plates_written} generated plates")
    if fetch_failed:
        print(f"Commons fetch failed, fell back to plate for: {', '.join(fetch_failed)}")
    print(f"collection logo: {logo_path}")
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


def main():
    works = load_works()
    write_catalog(works)


if __name__ == "__main__":
    main()
