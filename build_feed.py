#!/usr/bin/env python3
"""Optimalizovaný Google Ads / Merchant Center feed pro svet-pokoju.cz.

Vstup:  Shoptet Google feed (cca 155 000 variant) + doplnění chybějících produktů
        z kategorií na webu (Shoptet je do Google feedu nevyexportuje).
Výstup: malý feed (cca 1 000 položek) s jednou reprezentativní variantou modelu.

Spuštění:
    python3 build_feed.py --out dist/google-ads-feed.xml
    python3 build_feed.py --source products.xml --no-scrape      # lokální test
"""
import argparse
import gzip
import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from decimal import Decimal
from xml.sax.saxutils import escape

SHOP = "https://www.svet-pokoju.cz"
SOURCE_URL = f"{SHOP}/google/export/products.xml"
G = "{http://base.google.com/ns/1.0}"
UA = {"User-Agent": "Mozilla/5.0 (compatible; svet-pokoju-feed-builder)"}

# ---------------------------------------------------------------- nastavení --
MAX_ITEMS = 1500          # tvrdý strop feedu
MOTIFS_PER_MODEL = 10     # kolik motivů (mimo "BEZ MOTIVU") na model nábytku Kevin
MOTIFS_OVERRIDE = {"RW": 4, "RN": 4}   # regálů je hodně modelů, stačí méně motivů
MIN_ITEMS_OK = 400        # pod tuto hranici skript skončí chybou (ochrana proti prázdnému feedu)

# motivy, které historicky jely v Google Ads (zadání) – jdou vždy první
PRIORITY_MOTIFS = ["BAGR", "DVA PEJSCI", "JEDNOROŽEC", "PADAJÍCÍ SRDÍČKA"]
# u těchto motivů přidáme postele i v dalších barvách (kromě bílé)
BED_EXTRA_COLORS = ["Růžová", "Modrá", "Světlá hruška"]
BED_NEUTRAL_EXTRA = ["Buk"]   # postel bez motivu navíc v přírodním dřevě
TOP_LABEL_PREFIX = "Top-Kevin"   # stávající štítek klienta v custom_label_0 ("Top-Kevin-Postele(actual)")

KEVIN_NOTE = ("Kolekce Kevin tvoří kompletní nábytek do dětského pokoje – postele, komody, regály, "
              "psací stoly, skříně i noční stolky. Nábytek lze na přání doplnit potiskem jména nebo fotky dítěte.")

# kategorie z webu, které Shoptet do feedu nedává / dává neúplně
WEB_CATEGORIES = {
    "molitanove-kostky": dict(label="P2_Molitan", gpc="3172", ptype="Dětský pokoj > Molitanové kostky a hřiště"),
    "detske-kresilka": dict(label="P3_Kresilka", gpc="6499", ptype="Dětský pokoj > Dětská křesílka"),
    "detske-pohovky": dict(label="P3_Pohovky", gpc="460", ptype="Dětský pokoj > Dětské pohovky"),
    "plysove-hracky-2": dict(label="P4_Plys", gpc="1259", ptype="Hračky > Plyšové hračky"),
}

# typ nábytku: (název, rod pro barvu, gpc, kategorie v product_type)
FURNITURE = {
    "B": ("Dětský psací stůl Kevin", "m", "4191", "Psací stoly"),
    "K": ("Dětská komoda Kevin", "f", "4195", "Komody"),
    "SZN": ("Dětský noční stolek Kevin", "m", "462", "Noční stolky"),
    "SZ": ("Dětská šatní skříň Kevin", "f", "4195", "Skříně"),
    "RW": ("Dětský regál vysoký Kevin", "m", "464", "Regály"),
    "RN": ("Dětský regál nízký Kevin", "m", "464", "Regály"),
    "BOX": ("Box na hračky Kevin", "m", "4268", "Boxy na hračky"),
    "POL": ("Dětská police Kevin", "f", "6372", "Poličky"),
}
BED = ("Dětská postel Kevin se zábranou", "f", "505764", "Postele")
COLOR_FORMS = {"m": {"bílá": "bílý"}, "f": {}}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ----------------------------------------------------------------- pomocné --
def clean_text(s, limit=5000):
    s = html.unescape(html.unescape(re.sub(r"<[^>]+>", " ", s or "")))   # feed občas obsahuje &amp;nbsp;
    s = s.replace("\xa0", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def sentence_case(s):
    s = s.strip()
    letters = [c for c in s if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.6:
        s = s.lower()
    s = re.sub(r"\bcm\b", "cm", s, flags=re.I)
    return s[:1].upper() + s[1:]


def fmt_price(v):
    return f"{Decimal(v):.2f} CZK"


def price_band(price):
    p = float(price)
    return "do_1000" if p < 1000 else "1000_3000" if p < 3000 else "3000_6000" if p < 6000 else "6000_plus"


def open_source(src):
    if not re.match(r"https?://", src):
        return open(src, "rb")
    req = urllib.request.Request(src, headers={**UA, "Accept-Encoding": "gzip"})
    resp = urllib.request.urlopen(req, timeout=180)
    if resp.headers.get("Content-Encoding") == "gzip":
        return gzip.GzipFile(fileobj=resp)
    return resp


def http_get(url, retries=3):
    for i in range(retries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read().decode("utf-8", "ignore")
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


# ---------------------------------------------------- klasifikace položek Kevin --
RX_HEAD = re.compile(r"^(?P<head>.*?)(?:\s+Barva(?: dílů)?:\s*(?P<params>.*))?$")
RX_CODE = re.compile(r"^(?P<type>.*?)\s+(?P<code>(?:SZN|SZ|RW|RN|B|K)\d+)\s+-\s+(?P<motif>.+)$")
RX_NOCODE = re.compile(r"^(?P<type>Box na hračky Kevin|Dětská police Kevin|Dětská polička Kevin)\s*(?:[A-Z]{0,3}\d+)?\s*-\s*(?P<motif>.+)$")
RX_SKRIN_KEVIN = re.compile(r"^(?:Skříň KEVIN) (?P<code>SZ\d+)\s+-\s+(?P<motif>.+)$")
RX_BED = re.compile(r"^Dětská postel (?:s obrázkem )?Kevin(?: s obrázkem a zábranou)?\s*(?:-\s*)?(?P<motif>.+)$")
RX_DIMS = re.compile(r",?\s*\d+\s*x\s*\d+\s*x\s*\d+\s*cm")


def parse_params(s):
    out = {}
    for part in re.split(r",\s*(?=[^,:]+:)", s or ""):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def norm_motif(m):
    m = m.strip().upper()
    return "BEZ MOTIVU" if m in ("13 BAREV", "BEZ MOTIVU") else m


def classify(title):
    """-> dict(kind, type, code, motif, params) nebo None pokud nejde o Kevin položku."""
    t = re.sub(r"^Svět pokojů\s+", "", title).strip()
    m = RX_HEAD.match(t)
    head, params_s = m.group("head").strip(), m.group("params")
    # u nábytku je "Barva dílů: …" v params, u postelí "Barva: …" (regex výše bere obojí)
    params = parse_params(("Barva: " if "Barva dílů" not in title else "Barva dílů: ") + params_s) if params_s else {}
    if not params_s and head.startswith("Dětská postel"):
        return None   # jednobarevné postele "Kevin - BÍLÁ" (barva je v názvu produktu) – nahrazuje je postel BEZ MOTIVU
    head = re.sub(r"\s*\+\s*matrace zdarma", "", head, flags=re.I).strip()
    mb = RX_BED.match(head)
    if mb and head.startswith("Dětská postel") and "Sen" not in head.split()[:5]:
        motif = re.sub(r"^(?:-\s*)", "", mb.group("motif")).strip()
        return dict(kind="BED", type="BED", code="", motif=norm_motif(motif), params=params)
    head_nodims = RX_DIMS.sub("", head).strip(" ,")
    ms = RX_SKRIN_KEVIN.match(head_nodims)
    if ms:
        return dict(kind="SZ", type="SZ", code=ms.group("code"), motif=norm_motif(ms.group("motif")), params=params)
    mc = RX_CODE.match(head_nodims)
    if mc:
        typ_txt = mc.group("type")
        code = mc.group("code")
        if re.search(r"\b(Sen|Zvířátka)\b", typ_txt):
            return None  # jiné kolekce (Sen, Zvířátka) do feedu nepatří
        prefix = re.match(r"[A-Z]+", code).group(0)
        if prefix == "SZ" and not re.search(r"Skříň", typ_txt):
            return None
        if prefix in ("RW", "RN") and "Regál" not in typ_txt:
            return None
        return dict(kind=prefix, type=prefix, code=code, motif=norm_motif(mc.group("motif")), params=params)
    mn = RX_NOCODE.match(head_nodims)
    if mn:
        typ = "BOX" if mn.group("type").startswith("Box") else "POL"
        return dict(kind=typ, type=typ, code="", motif=norm_motif(mn.group("motif")), params=params)
    return None


def variant_rank(c):
    """Čím nižší tuple, tím neutrálnější varianta. Bílá, levé otevírání, šatní tyč / 140x70 bez úložného prostoru."""
    p = c["params"]
    color = p.get("Barva dílů") or p.get("Barva") or ""
    if c["kind"] == "BED":
        return (
            0 if p.get("Rozměry") == "140x70 cm" else 1,
            0 if p.get("Úložný prostor") == "Ne" else 1,
            0 if color.lower() == "bílá" else 1,
        )
    return (
        {"bílá": 0, "buk": 1, "světlá hruška": 2}.get(color.lower(), 3),
        0 if p.get("Otevírání", "Levé") == "Levé" else 1,
        0 if p.get("Vnitřní uspořádání", "šatní tyč") == "šatní tyč" else 1,
    )


# ------------------------------------------------------------- čtení feedu --
def read_source(src):
    """Jeden průchod feedem: vrací (kevin_best, kevin_extra, other_by_group)."""
    best = {}      # group -> (rank, record)
    extra = {}     # (group, color) -> (rank, record) pouze postele
    other = {}     # group -> record (první varianta) pro položky ostatních kategorií
    n = 0
    f = open_source(src)
    for _, el in ET.iterparse(f, events=("end",)):
        if el.tag != "item":
            continue
        n += 1
        title = (el.findtext("title") or "").strip()
        gid = (el.findtext(G + "item_group_id") or "").strip()
        c = classify(title)
        if c:
            rec = to_record(el, title, gid)
            rec.update(c)
            rk = variant_rank(rec)
            if gid not in best or rk < best[gid][0]:
                best[gid] = (rk, rec)
            if c["kind"] == "BED":
                col = c["params"].get("Barva", "")
                if col in BED_EXTRA_COLORS + BED_NEUTRAL_EXTRA and c["params"].get("Rozměry") == "140x70 cm" and c["params"].get("Úložný prostor") == "Ne":
                    extra[(gid, col)] = (rk, rec)
        elif gid not in other:
            low = title.lower()
            link = el.findtext("link") or ""
            if (any(f"/{s}/" in link for s in ("molitanove-kostky", "detske-kresilka", "detske-pohovky"))
                    or re.search(r"molitan|pěnov[eé] hřišt|plyšák|křesílk|rozkládací (pohovk|souprav)", low)):
                other[gid] = to_record(el, title, gid)
        el.clear()
        if n % 20000 == 0:
            log(f"  … načteno {n} položek")
    log(f"Načteno {n} položek, {len(best)} Kevin modelů, {len(other)} ostatních kandidátů")
    return best, extra, other


def to_record(el, title, gid):
    g = lambda tag: (el.findtext(G + tag) or "").strip()  # noqa: E731
    return dict(
        id=g("id"), title=title, gid=gid, link=(el.findtext("link") or "").strip(),
        image=g("image_link"), extra_images=[(e.text or "").strip() for e in el.findall(G + "additional_image_link")][:9],
        description=clean_text(el.findtext("description") or ""),
        price=g("price").replace(" CZK", ""), sale_price=g("sale_price").replace(" CZK", ""),
        availability=g("availability"), brand=g("brand") or "Svět pokojů",
        shipping=[(s.findtext(G + "country"), s.findtext(G + "service"), s.findtext(G + "price")) for s in el.findall(G + "shipping")],
        weight=g("shipping_weight"), top_label=g("custom_label_0"),
    )


# ------------------------------------------------------- doplnění z webu --
def scrape_category(slug):
    """-> list dict(pid, url, name, image, price, price_orig, sku, available)"""
    out, seen, total, page = [], set(), None, 1
    while page <= 12:
        url = f"{SHOP}/{slug}/" + (f"strana-{page}/" if page > 1 else "")
        h = http_get(url)
        if total is None:
            m = re.search(r"(\d+)\s*položek", h)
            total = int(m.group(1)) if m else 0
        start = h.find('id="products"')
        end = h.find("pagination", start) if start > 0 else -1
        block = h[start:end if end > 0 else len(h)] if start > 0 else ""
        new = 0
        for chunk in re.split(r'(?=<div class="p" data-micro="product")', block)[1:]:
            pid = re.search(r'data-micro-product-id="(\d+)"', chunk).group(1)
            if pid in seen:
                continue
            seen.add(pid)
            new += 1
            name = clean_text(re.search(r'data-testid="productCardName">(.*?)</span>', chunk, re.S).group(1))
            href = re.search(r'class="name"\s+data-micro="url"', chunk) and re.search(r'href="([^"]+)"\s*class="name"', chunk) \
                or re.search(r'href="([^"]+)"', chunk)
            price = re.search(r'data-micro-price="([\d.]+)"', chunk)
            orig = re.search(r'class="price-standard"[^>]*>\s*<span>([\d\s\xa0]+)\s*Kč', chunk)
            sku = re.search(r'data-micro="sku">([^<]+)<', chunk)
            avail_txt = clean_text((re.search(r'class="availability">(.*?)</div>', chunk, re.S) or [None, ""])[1])
            out.append(dict(
                pid=pid, name=name, url=SHOP + href.group(1) if href.group(1).startswith("/") else href.group(1),
                price=price.group(1) if price else "", orig=re.sub(r"\D", "", orig.group(1)) if orig else "",
                sku=sku.group(1).strip() if sku else "", avail=avail_txt,
            ))
        if not new or (total and len(out) >= total):
            break
        page += 1
        time.sleep(0.3)
    return out


def scrape_detail(url):
    h = http_get(url)
    desc = re.search(r'itemprop="description"\s+content="([^"]*)"', h)
    brand = re.search(r"Značka:\s*<span>([^<]+)</span>", h)
    thumbs = re.search(r'p-thumbnails-inner">(.*?)</div>\s*</div>', h, re.S)
    imgs = re.findall(r'href="(https://cdn\.myshoptet\.com[^"]+/shop/big/[^"]+)"', thumbs.group(1) if thumbs else "")
    if not imgs:
        og = re.search(r'<meta property="og:image" content="([^"]+)"', h)
        imgs = [html.unescape(og.group(1))] if og else []
    imgs = [html.unescape(i) for i in dict.fromkeys(imgs)]
    return dict(
        description=clean_text(desc.group(1) if desc else ""),
        brand=clean_text(brand.group(1)) if brand else "Svět pokojů",
        images=imgs,
    )


def build_web_supplement(feed_other):
    """Vrací records pro 4 prioritní kategorie: z feedu kde je, jinak z webu."""
    records, from_feed, from_web = [], 0, 0
    for slug, meta in WEB_CATEGORIES.items():
        try:
            cards = scrape_category(slug)
        except Exception as e:  # noqa: BLE001
            log(f"!! kategorii {slug} se nepodařilo stáhnout: {e}")
            continue
        log(f"Web {slug}: {len(cards)} produktů")
        for c in cards:
            if re.search(r"vyprodán|nedostupn", c["avail"], re.I):
                continue
            if c["pid"] in feed_other:
                rec = dict(feed_other.pop(c["pid"]))
                from_feed += 1
            else:
                try:
                    d = scrape_detail(c["url"])
                except Exception as e:  # noqa: BLE001
                    log(f"!! detail {c['url']}: {e}")
                    continue
                time.sleep(0.3)
                if not d["images"]:
                    continue
                rec = dict(
                    id=c["pid"], gid=c["pid"], title=c["name"], link=c["url"], image=d["images"][0],
                    extra_images=d["images"][1:10], description=d["description"] or c["name"],
                    price=c["orig"] or c["price"], sale_price=c["price"] if c["orig"] and c["orig"] != c["price"].split(".")[0] else "",
                    availability="in stock", brand=d["brand"], shipping=[], weight="", top_label="",
                )
                from_web += 1
            rec["cat"] = slug
            records.append(rec)
    log(f"Doplněk: {from_feed} z feedu, {from_web} z webu")
    return records


# ----------------------------------------------------------------- výstup --
def color_of(rec):
    return rec.get("params", {}).get("Barva dílů") or rec.get("params", {}).get("Barva") or ""


def build_kevin_title(rec):
    name, gender, _, _ = BED if rec["kind"] == "BED" else FURNITURE[rec["kind"]]
    motif = "bez motivu" if rec["motif"] == "BEZ MOTIVU" else sentence_case(rec["motif"].lower())
    color = color_of(rec).lower()
    color = COLOR_FORMS[gender].get(color, color)
    code = f" {rec['code']}" if rec["code"] else ""
    if rec["kind"] == "BED":
        size = rec["params"].get("Rozměry", "140x70 cm")
        t = f"{name} – {motif}, {size}, {color}"
    else:
        dims = re.search(r"(\d+x\d+x\d+ cm)", rec["title"])
        t = f"{name}{code} – {motif}" + (f", {dims.group(1)}" if dims else "") + f", {color}"
    return t[:150]


def kevin_output(rec, tier_label, top, extra_color=False):
    name, gender, gpc, cat = BED if rec["kind"] == "BED" else FURNITURE[rec["kind"]]
    desc = rec["description"]
    desc = (desc + " " if desc else "") + KEVIN_NOTE
    if rec["kind"] == "BED":
        desc = "Dětská postel Kevin s obrázkem a zábranou, rozměr matrace 140x70 cm. " + desc
    role = "top_actual" if top else ("bez_motivu" if rec["motif"] == "BEZ MOTIVU" else "motiv")
    if rec["motif"] in PRIORITY_MOTIFS:
        role = "top_motiv" if not top else role
    return dict(
        rec, out_title=build_kevin_title(rec), out_desc=desc[:5000], gpc=gpc,
        ptype=f"Dětský pokoj > Kolekce Kevin > {cat}", color=color_of(rec),
        size=rec["params"].get("Rozměry", "") if rec["kind"] == "BED" else "",
        material="Lamino", labels=[tier_label, role, price_band(rec["sale_price"] or rec["price"]),
                                    "hlavni_produkt" if rec["kind"] == "BED" else "doplnek_pokoje", ""],
    )


def web_output(rec):
    meta = WEB_CATEGORIES[rec["cat"]]
    title = re.sub(r"^Svět pokojů\s+", "", rec["title"])
    title = re.sub(r"\s+", " ", title)
    title = sentence_case(title)
    cross = "doplnek_k_posteli" if rec["cat"] in ("detske-kresilka", "detske-pohovky") else "hlavni_produkt"
    season = "vanoce_2026" if rec["cat"] == "plysove-hracky-2" else ""
    return dict(
        rec, out_title=title[:150], out_desc=rec["description"] or title, gpc=meta["gpc"], ptype=meta["ptype"],
        color="", size="", material="",
        labels=[meta["label"], "bez_motivu", price_band(rec["sale_price"] or rec["price"]), cross, season],
    )


def select(best, extra, other):
    # --- postele: všechny motivy, bílá 140x70; priority motivy navíc v dalších barvách
    kev = [r for _, r in best.values()]
    beds = [r for r in kev if r["kind"] == "BED"]
    furn = [r for r in kev if r["kind"] != "BED"]
    top_motifs_beds = {r["motif"] for r in beds if r["top_label"].startswith(TOP_LABEL_PREFIX)}
    out = []
    for r in sorted(beds, key=lambda r: r["motif"]):
        top = r["motif"] in top_motifs_beds
        out.append(kevin_output(r, "P1_Kevin_postele", top))
        extra_cols = BED_EXTRA_COLORS if r["motif"] in PRIORITY_MOTIFS else BED_NEUTRAL_EXTRA if r["motif"] == "BEZ MOTIVU" else []
        if extra_cols:
            for col in extra_cols:
                e = extra.get((r["gid"], col))
                if e:
                    out.append(kevin_output(e[1], "P1_Kevin_postele", top, extra_color=True))
    n_beds = len(out)
    # --- nábytek: BEZ MOTIVU + nejlépe pokryté motivy (prioritní první)
    coverage = Counter()
    models = defaultdict(dict)
    for r in furn:
        models[(r["kind"], r["code"])][r["motif"]] = r
        coverage[r["motif"]] += 1
    coverage.pop("BEZ MOTIVU", None)
    ranked = [m for m in PRIORITY_MOTIFS if m in coverage]
    ranked += [m for m, _ in sorted(coverage.items(), key=lambda kv: (-(kv[0] in top_motifs_beds), -kv[1], kv[0])) if m not in ranked]
    for key in sorted(models):
        avail = models[key]
        picks = (["BEZ MOTIVU"] if "BEZ MOTIVU" in avail else []) + [m for m in ranked if m in avail][:MOTIFS_OVERRIDE.get(key[0], MOTIFS_PER_MODEL)]
        for m in picks:
            r = avail[m]
            top = r["top_label"].startswith(TOP_LABEL_PREFIX)
            out.append(kevin_output(r, "P1_Kevin_nabytek", top))
    n_furn = len(out) - n_beds
    # --- ostatní priority z webu
    sup = [web_output(r) for r in build_web_supplement(other)] if ARGS.scrape else []
    out += sup
    log(f"Výběr: postele {n_beds}, nábytek Kevin {n_furn}, doplněk z kategorií {len(sup)} → {len(out)}")
    if len(out) > MAX_ITEMS:
        log(f"!! přes limit {MAX_ITEMS}, ořezávám nábytek s nejnižší prioritou")
        keep = [o for o in out if o["labels"][0] != "P1_Kevin_nabytek"]
        room = MAX_ITEMS - len(keep)
        keep += [o for o in out if o["labels"][0] == "P1_Kevin_nabytek"][:max(room, 0)]
        out = keep
    return out


def render(items):
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">', "<channel>",
         "<title>Světpokojů.cz – feed pro Google Ads</title>", f"<link>{SHOP}</link>",
         "<description>Prioritní produkty: kolekce Kevin, molitanové kostky, křesílka a pohovky, plyšové hračky</description>"]
    seen = set()
    for o in items:
        if o["id"] in seen:
            continue
        seen.add(o["id"])
        e = lambda s: escape(str(s))  # noqa: E731
        L.append("<item>")
        L.append(f"<g:id>{e(o['id'])}</g:id>")
        L.append(f"<title>{e(o['out_title'])}</title>")
        L.append(f"<description>{e(o['out_desc'])}</description>")
        L.append(f"<link>{e(o['link'])}</link>")
        L.append(f"<g:image_link>{e(o['image'])}</g:image_link>")
        for im in o["extra_images"]:
            if im:
                L.append(f"<g:additional_image_link>{e(im)}</g:additional_image_link>")
        L.append(f"<g:availability>{'in stock' if o['availability'] != 'out of stock' else 'out of stock'}</g:availability>")
        L.append(f"<g:price>{fmt_price(o['price'])}</g:price>")
        if o["sale_price"] and Decimal(o["sale_price"]) < Decimal(o["price"]):
            L.append(f"<g:sale_price>{fmt_price(o['sale_price'])}</g:sale_price>")
        L.append(f"<g:google_product_category>{o['gpc']}</g:google_product_category>")
        L.append(f"<g:product_type>{e(o['ptype'])}</g:product_type>")
        L.append(f"<g:brand>{e(o['brand'])}</g:brand>")
        L.append("<g:condition>new</g:condition>")
        L.append("<g:identifier_exists>no</g:identifier_exists>")
        L.append("<g:adult>no</g:adult>")
        L.append("<g:age_group>kids</g:age_group>")
        if o["color"]:
            L.append(f"<g:color>{e(o['color'])}</g:color>")
        if o["material"]:
            L.append(f"<g:material>{e(o['material'])}</g:material>")
        if o["size"]:
            L.append(f"<g:size>{e(o['size'])}</g:size>")
        L.append(f"<g:item_group_id>{e(o['gid'])}</g:item_group_id>")
        for country, service, price in o["shipping"]:
            L.append(f"<g:shipping><g:country>{e(country)}</g:country><g:service>{e(service)}</g:service><g:price>{e(price)}</g:price></g:shipping>")
        if o["weight"]:
            L.append(f"<g:shipping_weight>{e(o['weight'])}</g:shipping_weight>")
        for i, lab in enumerate(o["labels"]):
            if lab:
                L.append(f"<g:custom_label_{i}>{e(lab)}</g:custom_label_{i}>")
        L.append("</item>")
    L += ["</channel>", "</rss>"]
    return "\n".join(L), len(seen)


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE_URL)
    ap.add_argument("--out", default="dist/google-ads-feed.xml")
    ap.add_argument("--no-scrape", dest="scrape", action="store_false")
    ARGS = ap.parse_args()
    best, extra, other = read_source(ARGS.source)
    items = select(best, extra, other)
    xml, n = render(items)
    if n < MIN_ITEMS_OK:
        log(f"CHYBA: feed má jen {n} položek (minimum {MIN_ITEMS_OK}) – nepřepisuji výstup")
        sys.exit(1)
    import os
    os.makedirs(os.path.dirname(ARGS.out) or ".", exist_ok=True)
    with open(ARGS.out, "w", encoding="utf-8") as f:
        f.write(xml)
    stats = Counter(o["labels"][0] for o in items)
    log(f"Hotovo: {n} položek → {ARGS.out}\n  {dict(stats)}")


if __name__ == "__main__":
    main()
