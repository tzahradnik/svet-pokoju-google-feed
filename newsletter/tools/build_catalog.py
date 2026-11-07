"""Builds the newsletter tool's catalogue from svet-pokoju.cz/sitemap.xml.

Outputs (into --out):
  site.json      categories / blog articles / info pages with real names, brand & room groups,
                 newly added products and publication-plan coverage
  products.json  compact product index for instant search: [path, name, imageFile, firstSeen]

Names of categories, articles and pages are read from each page's <h1>. Names already known from the
previously published catalogue (--previous) are reused, so a daily run only fetches new pages.
Products keep their "firstSeen" date between runs – that is how new products are detected
(the sitemap itself has no lastmod).

  python3 tools/build_catalog.py --out ../dist/newsletter \
      --previous https://tzahradnik.github.io/svet-pokoju-google-feed/newsletter/ --plan src/plan.json
"""
import argparse, datetime as dt, html, json, os, re, sys, time, unicodedata, urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

SHOP = "https://www.svet-pokoju.cz"
UA = {"User-Agent": "Mozilla/5.0 (compatible; svet-pokoju-newsletter-catalog)", "Accept-Language": "cs"}
IMG_PREFIX = re.compile(r"^https://cdn\.myshoptet\.com/usr/www\.svet-pokoju\.cz/user/shop/big/")
NEW_DAYS = 30           # a product counts as "new" for this many days after it first appeared
MIN_PRODUCTS = 3000     # safety net against a broken / partial sitemap

# Info pages worth linking from e-mails (trust & practical info); role → path
INFO_ROLES = {
    "about": "/o-nas/",
    "delivery": "/jak-se-zbozi-ke-me-dostane/",
    "guide": "/pruvodce-nakupem/",
    "custom": "/zakazkova-vyroba-nabytku-pro-deti/",
    "contact": "/kontakty/",
}
# Rooms of the house – room-focused e-mails
ROOMS = {"/detsky-pokojicek/", "/obyvak/", "/loznice/", "/predsin/", "/koupelna/", "/kuchyn/", "/pracovna/", "/studentsky-pokoj/"}
# Brand names from Shoptet (brands_list, 11/2026) without generic labels like "Vyrobeno v ČR";
# a category named after one of them is offered as a brand e-mail
BRANDS = """4BABY|Abakus|ABC Design|Adora|AJK|Akademiks|akuku|Albero Mio|Amálka|AMY|ARTI|AVENT|BABY ACTIVE|Baby Banana Brush|BABY DESIGN|BABY FEHN|BABY MIX|Baby Nellys|Baby ONO|BabyMatex|BAMBINO|BELISIMA|BJ Plastik|BMS|Bobas|BOBO BABY|BOIKIDO|BRITAX|RÖMER|Bübchen|CAM|Canpol Babies|Caretero|Castorland|CEBA|CLIC educ|CLIPPASAFE|Coccodrillo|Columbia|CUDDLEME|CYBEX|CzuCzu|DANPOL|DrBrown's|Drewex|EDU PLAY|Emitex|FEHN|Fiesta Crafts|FikiMiki|FisherPrice|Goki|Granna|Grimm's|HAPPY BABIES|Hippo Kids|HOJDAVAK|House of Toys|CHICCO|IGROTECO|INJUSA|InnoGIO|Jablotron|K´s Kids|KAPPUS|Keter|KINDERKRAFT|Klups|Kocot|KORBEL|LINEA|Linteo|LOVI|MAM|Matex|MEBLAR|Medela|millaminis|Milly Mally|Mirum|Modular Toys|NEXT|NIVEA|NUK|PALI|PIDILIDI|Pinkie|PINOKIO|PLAYGRO|puzzland|Quercetti|Reer|ROCKINO|SASSY|Smoby|TAKO|TEGA|TEGA BABY|TEPE|THERMOBABY|Tiny Love|Tommee Tippee|Topcom|Tullo|TWEETO|VIGA|WEINA|ZAZU|ZOPA""".split("|")
# Pages that are not useful in e-mails
SKIP = {"/", "/obchodni-podminky/", "/podminky-ochrany-osobnich-udaju/", "/formular-pro-odstoupeni-od-kupni-smlouvy/", "/blog/"}


def get(url, timeout=60):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 + attempt * 3)


def fold(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def humanize(slug):
    s = slug.strip("/").split("/")[-1].replace("-", " ").strip()
    return s[:1].upper() + s[1:]


def product_name(path, titles):
    """Best human name from image titles (Shoptet uses the product name or a photo caption)."""
    cleaned = []
    for t in titles:
        t = html.unescape(t).strip()
        t = re.sub(r"\s*\(\d+\)\s*$", "", t)                 # "... (3)" photo counter
        t = re.sub(r"\s*\((Velikost|Barva|Rozměr|Varianta|Provedení)[^)]*\)\s*$", "", t, flags=re.I)
        if len(t) >= 6:
            cleaned.append(t)
    if cleaned:
        name, _ = Counter(cleaned).most_common(1)[0]
        # captions without diacritics are usually just a slug – the URL is as good and more complete
        if fold(name) != name.lower() or len(name.split()) >= 3:
            return name[:1].upper() + name[1:]
    return humanize(path)


def page_info(path):
    """Fetches <h1> (and whether it is a category) for one non-product URL."""
    try:
        h = get(SHOP + path, timeout=25)
    except Exception as e:
        return path, None, None, str(e)
    m = re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S)
    name = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))).strip() if m else ""
    if not name:
        t = re.search(r"<title>(.*?)</title>", h, re.S)
        name = re.split(r"\s+[⇒|–-]\s+", html.unescape(t.group(1)).strip())[0] if t else humanize(path)
    is_cat = 'data-testid="titleCategory"' in h or 'class="category-title"' in h
    return path, name, is_cat, None


def load_previous(prev):
    """First location (URL or folder; comma-separated list) that has both files wins."""
    for loc in [x.strip() for x in prev.split(",") if x.strip()]:
        try:
            def read(name):
                src = loc.rstrip("/") + "/" + name
                return json.loads(get(src, timeout=60) if src.startswith("http") else open(src, encoding="utf-8").read())
            site, products = read("site.json"), read("products.json")
            print(f"Předchozí katalog: {loc}")
            return site, products
        except Exception as e:
            print(f"  (předchozí katalog z {loc} nenačten: {e})", file=sys.stderr)
    return {}, {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--previous", default="", help="URL or folder of the previously published catalogue")
    ap.add_argument("--plan", default=os.path.join(os.path.dirname(__file__), "..", "src", "plan.json"))
    ap.add_argument("--sitemap", default=SHOP + "/sitemap.xml", help="URL or local file")
    a = ap.parse_args()
    today = dt.date.today().isoformat()

    print("Stahuji sitemapu…")
    xml = open(a.sitemap, encoding="utf-8").read() if os.path.exists(a.sitemap) else get(a.sitemap, timeout=300)
    blocks = re.findall(r"<url>(.*?)</url>", xml, re.S)
    prev_site, prev_products = load_previous(a.previous)
    first_seen = {p[0]: p[3] for p in prev_products.get("items", [])} if prev_products else {}
    baseline = prev_products.get("baseline") if prev_products else None
    baseline = baseline or today

    products, others = [], []
    for b in blocks:
        loc = re.search(r"<loc>(.*?)</loc>", b)
        if not loc:
            continue
        path = html.unescape(loc.group(1)).replace(SHOP, "") or "/"
        images = [html.unescape(x) for x in re.findall(r"<image:loc>(.*?)</image:loc>", b)]
        if images and path.count("/") >= 3:
            titles = re.findall(r"<image:title>(.*?)</image:title>", b)
            img = IMG_PREFIX.sub("", images[0]).split("?")[0]
            products.append([path, product_name(path, titles), img, first_seen.get(path, today if first_seen else baseline)])
        elif path not in SKIP:
            others.append(path)
    if len(products) < MIN_PRODUCTS:
        sys.exit(f"Sitemapa obsahuje jen {len(products)} produktů – nejspíš je neúplná, katalog nepřepisuji.")

    # names of categories / articles / pages – reuse known ones, fetch only new
    known = {}
    for group in ("categories", "blog", "pages"):
        for x in prev_site.get(group, []):
            known[x["path"]] = (x["name"], group == "categories")
    todo = [p for p in others if p not in known]
    print(f"Produkty: {len(products)}, ostatní stránky: {len(others)} (nové k načtení: {len(todo)})")
    with ThreadPoolExecutor(6) as ex:
        for path, name, is_cat, err in ex.map(page_info, todo):
            if err:
                print(f"  ! {path}: {err}", file=sys.stderr)
                known[path] = (humanize(path), True)
            else:
                known[path] = (name, is_cat)

    counts = Counter("/" + p[0].strip("/").split("/")[0] + "/" for p in products)
    categories, blog, pages = [], [], []
    for path in others:
        name, is_cat = known[path]
        if path.startswith("/blog/"):
            blog.append({"path": path, "name": name})
        elif is_cat:
            kind = "room" if path in ROOMS else "collection" if path.startswith("/kolekce-") or fold(name).startswith("kolekce") else \
                "category"
            categories.append({"path": path, "name": name, "kind": kind, "products": counts.get(path, 0)})
        else:
            role = next((r for r, p in INFO_ROLES.items() if p == path), "")
            pages.append({"path": path, "name": name, "role": role})

    # brands: categories whose name contains a brand as a whole word (e.g. "Emitex", "HRAČKY GOKI")
    brand_re = [(b, re.compile(r"(?<![a-z0-9])" + re.escape(fold(b)) + r"(?![a-z0-9])")) for b in BRANDS]
    for c in categories:
        if c["kind"] == "category" and len(c["name"].split()) <= 4:
            hit = next((b for b, rx in brand_re if rx.search(fold(c["name"]))), None)
            if hit:
                c["kind"], c["brand"] = "brand", hit

    # new products
    cutoff = (dt.date.today() - dt.timedelta(days=NEW_DAYS)).isoformat()
    new = sorted((p for p in products if p[3] != baseline and p[3] >= cutoff), key=lambda p: p[3], reverse=True)[:80]

    # publication-plan coverage
    coverage = {"topicsSearchOnly": [], "categoriesWithoutTopic": []}
    try:
        plan = json.load(open(a.plan, encoding="utf-8"))
        used = {s for t in plan["topics"] + plan.get("specials", []) for s in t["sources"]}
        coverage["topicsSearchOnly"] = [
            {"id": t["id"], "name": t["name"], "volume": t.get("volume", 0)}
            for t in plan["topics"] if all(s.startswith("vyhledavani:") for s in t["sources"])
        ]
        cat_paths = {c["path"] for c in categories}
        coverage["missingSources"] = sorted({s for s in used if not s.startswith("vyhledavani:") and s not in cat_paths})
        coverage["categoriesWithoutTopic"] = sorted(
            ({"path": c["path"], "name": c["name"], "products": c["products"]} for c in categories if c["path"] not in used and c["products"] >= 5),
            key=lambda c: -c["products"],
        )[:60]
    except Exception as e:
        print(f"  (pokrytí plánu nespočítáno: {e})", file=sys.stderr)

    site = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "trackingSince": baseline,
        "counts": {"products": len(products), "categories": len(categories), "blog": len(blog), "pages": len(pages)},
        "categories": sorted(categories, key=lambda c: c["name"].lower()),
        "blog": blog,
        "pages": pages,
        "newProducts": [{"path": p[0], "name": p[1], "image": p[2], "firstSeen": p[3]} for p in new],
        "coverage": coverage,
    }
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "site.json"), "w", encoding="utf-8") as f:
        json.dump(site, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(a.out, "products.json"), "w", encoding="utf-8") as f:
        json.dump({"generated": site["generated"], "baseline": baseline, "items": products}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Hotovo: {len(categories)} kategorií, {len(blog)} článků, {len(pages)} stránek, {len(new)} novinek → {a.out}")


if __name__ == "__main__":
    main()
