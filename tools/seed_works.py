#!/usr/bin/env python3
"""Fetch the Wikipedia "List of most expensive paintings" table and print
work stubs (JSON array) to stdout. Read-only: never writes files. The stubs
are a starting point for art/data/works.json, which a human then curates by
hand (adding earlier sales, medium, artist_died, and fixing image licensing).
"""
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from html.parser import HTMLParser

API_URL = (
    "https://en.wikipedia.org/w/api.php?action=parse"
    "&page=List_of_most_expensive_paintings&prop=text"
    "&format=json&formatversion=2"
)
LIST_URL = "https://en.wikipedia.org/wiki/List_of_most_expensive_paintings"
USER_AGENT = "meadow-art-catalog/1.0 (contact: diamondkaz578@gmail.com)"
COLUMNS = [
    "adjusted", "original", "name", "image", "artist", "year",
    "date_of_sale", "rank_at_sale", "seller", "buyer", "auction_house",
]


def fetch_list():
    req = urllib.request.Request(API_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    return payload["parse"]["text"]


class _TableParser(HTMLParser):
    """Extracts the first <table class="wikitable ..."> as rows of cells.

    Each cell is {"text": str, "href": str|None, "img_src": str|None}.
    Footnote markers (<sup class="reference">) are excluded from text.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.table_seen = False
        self.in_table = False
        self.row = None
        self.cell_tag = None
        self.cell_text = []
        self.cell_href = None
        self.cell_img_src = None
        self.skip_stack = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get("class", "")
        if tag == "table":
            if not self.table_seen and "wikitable" in classes:
                self.in_table = True
                self.table_seen = True
            return
        if not self.in_table:
            return
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell_tag = tag
            self.cell_text = []
            self.cell_href = None
            self.cell_img_src = None
        elif tag == "a" and self.cell_tag and self.cell_href is None and self.skip_depth == 0:
            self.cell_href = attrs.get("href")
        elif tag == "img" and self.cell_tag and self.cell_img_src is None:
            self.cell_img_src = attrs.get("src")
        elif tag == "br" and self.cell_tag:
            self.cell_text.append(" ")
        elif tag == "sup":
            is_ref = "reference" in classes
            self.skip_stack.append(is_ref)
            if is_ref:
                self.skip_depth += 1

    def handle_endtag(self, tag):
        if tag == "table" and self.in_table:
            self.in_table = False
            return
        if not self.in_table:
            return
        if tag == "tr" and self.row is not None:
            if self.row:
                self.rows.append(self.row)
            self.row = None
        elif tag in ("td", "th") and self.cell_tag == tag:
            text = re.sub(r"\s+", " ", "".join(self.cell_text)).strip()
            self.row.append({
                "text": text, "href": self.cell_href, "img_src": self.cell_img_src,
            })
            self.cell_tag = None
        elif tag == "sup" and self.skip_stack:
            if self.skip_stack.pop():
                self.skip_depth -= 1

    def handle_data(self, data):
        if self.cell_tag and self.skip_depth == 0:
            self.cell_text.append(data)


def parse_table(html):
    parser = _TableParser()
    parser.feed(html)
    rows = []
    for raw_row in parser.rows:
        if len(raw_row) != len(COLUMNS):
            continue  # header row or malformed row, skip
        row = dict(zip(COLUMNS, raw_row))
        if row["name"]["text"] in ("Name", ""):
            continue  # header row
        rows.append(row)
    return rows


_CURRENCY_SYMBOLS = {"£": "GBP", "€": "EUR", "¥": "CNY", "HK$": "HKD"}
_CURRENCY_LINK_TARGETS = {
    "Pound_sterling": "GBP", "Pound_Sterling": "GBP",
    "Euro": "EUR",
    "Japanese_yen": "JPY",
    "Renminbi": "CNY", "Chinese_yuan": "CNY", "Yuan": "CNY",
    "Hong_Kong_dollar": "HKD",
}


def parse_money(text, currency_href=None):
    """Parse a "$450.3", "~$407", "$250 +" or "$76.7 (£49.5)" style cell.

    Returns amount in millions USD as reported, approx flag, and the
    original-currency figure when the cell carries a parenthetical. The ¥
    symbol is ambiguous (yen or yuan): currency_href, the href of the first
    link inside the cell, disambiguates it when Wikipedia links the currency;
    unlinked ¥ falls back to CNY, since every unlinked case in this table is
    a yuan-denominated Chinese auction sale.
    """
    text = text.strip()
    approx = text.startswith("~")
    if approx:
        text = text[1:].strip()

    amount_original = None
    currency_original = None
    paren = re.search(r"\((£|€|¥|HK\$)\s*([\d,]+\.?\d*)\)", text)
    if paren:
        currency_original = _CURRENCY_SYMBOLS[paren.group(1)]
        if currency_href:
            link_target = currency_href.rsplit("/", 1)[-1]
            currency_original = _CURRENCY_LINK_TARGETS.get(link_target, currency_original)
        amount_original = float(paren.group(2).replace(",", ""))
        text = text[:paren.start()].strip()

    if text.endswith("+"):
        approx = True
        text = text[:-1].strip()

    match = re.search(r"[\d,]+\.?\d*", text)
    if not match:
        raise ValueError(f"parse_money: no numeric amount in {text!r}")
    amount = float(match.group(0).replace(",", ""))
    return {
        "amount": amount, "approx": approx,
        "amount_original": amount_original, "currency_original": currency_original,
    }


def parse_date(text):
    """"November 15, 2017" -> "2017-11-15", "April 2011" -> "2011-04",
    bare "2015" -> "2015"."""
    text = re.sub(r"\s+", " ", text).strip()
    for fmt, out_fmt in (("%B %d, %Y", "%Y-%m-%d"), ("%B %Y", "%Y-%m")):
        try:
            import datetime
            return datetime.datetime.strptime(text, fmt).strftime(out_fmt)
        except ValueError:
            continue
    if re.fullmatch(r"\d{4}", text):
        return text
    raise ValueError(
        f"parse_date: unrecognized date format {text!r}, add a case for it"
    )


def commons_title(img_src):
    """Commons thumb URL -> file title. Fair-use images (wikipedia/en/thumb)
    are not free to reuse, so those return None."""
    if not img_src:
        return None
    if "wikipedia/en/thumb" in img_src:
        return None
    if "wikipedia/commons/thumb" not in img_src:
        return None
    parts = img_src.split("/")
    return urllib.parse.unquote(parts[-2])


def _slug_base(text):
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text


def slugify_all(titles_years_artists):
    """Disambiguate duplicate slugs by appending sale year, then artist
    surname, in that order."""
    base_slugs = [_slug_base(title) for title, _, _ in titles_years_artists]
    counts = {}
    for s in base_slugs:
        counts[s] = counts.get(s, 0) + 1

    seen = set()
    result = []
    for slug, (title, year_text, artist) in zip(base_slugs, titles_years_artists):
        candidate = slug
        if counts[slug] > 1:
            year_digits = re.search(r"\d{4}", year_text or "")
            if year_digits:
                candidate = f"{slug}-{year_digits.group(0)}"
        if candidate in seen:
            surname = _slug_base((artist or "").split()[-1]) if artist else ""
            if surname:
                candidate = f"{slug}-{surname}"
        if candidate in seen:
            n = 2
            while f"{candidate}-{n}" in seen:
                n += 1
            candidate = f"{candidate}-{n}"
        seen.add(candidate)
        result.append(candidate)
    return result


def _strip_footnotes(text):
    return re.sub(r"\[\s*(note\s*)?\d+\s*\]", "", text, flags=re.IGNORECASE).strip()


def build_stubs(rows):
    titles_years_artists = [
        (r["name"]["text"], r["year"]["text"], r["artist"]["text"]) for r in rows
    ]
    slugs = slugify_all(titles_years_artists)

    stubs = []
    for row, slug in zip(rows, slugs):
        name = _strip_footnotes(row["name"]["text"])
        artist = _strip_footnotes(row["artist"]["text"])
        year_text = _strip_footnotes(row["year"]["text"])
        year_match = re.search(r"\d{4}", year_text)
        auction_house = _strip_footnotes(row["auction_house"]["text"])

        try:
            date_iso = parse_date(row["date_of_sale"]["text"])
        except ValueError as exc:
            print(f"warning: {name!r}: {exc}", file=sys.stderr)
            date_iso = None

        try:
            money = parse_money(row["original"]["text"], currency_href=row["original"]["href"])
        except ValueError as exc:
            print(f"warning: {name!r}: {exc}", file=sys.stderr)
            money = None

        wikipedia_url = None
        if row["name"]["href"]:
            wikipedia_url = urllib.parse.urljoin(
                "https://en.wikipedia.org", row["name"]["href"]
            )

        sale = {
            "date": date_iso,
            "price_usd": round(money["amount"] * 1_000_000) if money else None,
            "channel": auction_house,
            "source": LIST_URL,
        }
        if money and money["approx"]:
            sale["approx"] = True
        if money and money["amount_original"] is not None:
            sale["amount_original"] = money["amount_original"]
            sale["currency_original"] = money["currency_original"]

        stubs.append({
            "id": slug,
            "title": name,
            "artist": artist,
            "artist_died": None,
            "year": int(year_match.group(0)) if year_match else None,
            "year_text": year_text,
            "medium": None,
            "image": commons_title(row["image"]["img_src"]),
            "wikipedia_url": wikipedia_url,
            "sales": [sale],
        })
    return stubs


def main():
    html = fetch_list()
    rows = parse_table(html)
    stubs = build_stubs(rows)
    print(json.dumps(stubs, indent=2, ensure_ascii=False))
    print(f"fetched {len(stubs)} stubs", file=sys.stderr)


if __name__ == "__main__":
    main()
