#!/usr/bin/env python3
"""Build the newsletter publication plan from the AKW keyword analysis (CSV export).

Usage:
    python3 tools/build_plan.py "<path to AKW csv>" --out src/plan.json

Each topic below maps a group of keywords (regex on the keyword text) to product
sources on svet-pokoju.cz (category paths or site-search queries). The script adds
search volume, top keywords, question-style keywords and month-by-month seasonality.
"""
import argparse
import csv
import json
import re
import unicodedata
from collections import defaultdict

MONTHS = ["Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025", "Jan 2026",
          "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026"]
MONTH_NUM = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7]

# id, name, keyword regex, product sources, angle (hint for the copywriter)
TOPICS = [
    ("domeckove-postele", "Domečkové postele", r"domečk|domeck|domek",
     ["/detske-domeckove-postele/"], "Postel jako domeček – hra i spánek v jednom, varianty s úložným prostorem a přistýlkou."),
    ("patrove-postele", "Patrové postele", r"patrov|dvoupatr|palanda",
     ["/patrove-detske-postele/", "/patrova/"], "Úspora místa pro sourozence, bezpečnost (zábrany, schůdky)."),
    ("vyvysene-postele", "Vyvýšené postele a postele se skluzavkou", r"vyvýšen|vyvysen|vysok|zvýšen|zvysen|skluzav|podkrovn",
     ["/vyvysene-detske-postele/", "/detske-vyvysene-postele-a-postele-se-skluzavkou-borovice/"], "Pod postelí místo na hraní nebo psací stůl, skluzavka jako bonus."),
    ("postele-ulozny-prostor", "Postele s úložným prostorem", r"úložn|uloz|šuplík|suplik",
     ["/s-uloznym-prostorem/"], "Kam s hračkami a peřinami – úložné šuplíky pod postelí."),
    ("postele-zabrana", "Dětské postele se zábranou", r"zábran|zabran|ohrádk|ohradk|bočnic|bocnic",
     ["/detske-postele-se-zabranou/", "/detske-postele-s-obrazkem-a-zabranou-kevin/"], "Bezpečný přechod z postýlky do první postele."),
    ("postele-masiv", "Postele z masivu", r"masiv",
     ["/detske-postele-z-masivu/", "/kvalitni-postele-z-masivu-rychle-dodani/"], "Kvalitní dřevo, dlouhá životnost, rychlé dodání."),
    ("postele-pristylka", "Postele s přistýlkou", r"přistýl|pristyl|vysouvac|výsuvn",
     ["/detske-postele-s-pristylkou-2/", "/s-pristylkou/"], "Návštěva přespí – vysouvací přistýlka."),
    ("postele-holky-kluci", "Postele pro holky a pro kluky", r"holč|holc|dívč|divc|holk|chlapec|kluk",
     ["/detske-postele-pro-holky/", "/detske-postele-pro-kluky/"], "Motivy a barvy podle toho, co dítě baví."),
    ("postele-rozmery", "Dětské postele podle rozměru", r"\b(1[2-9]0|200|2[0-9]0)\s*x\s*(60|70|80|90|100|120|140|160|180|200)\b|\b(60|70|80|90)\s*x\s*(1[2-9]0|200)\b",
     ["/detske-postele-dle-rozmeru/"], "Jak vybrat správný rozměr postele a matrace podle věku."),
    ("detske-postele", "Dětské postele (obecně)", r"postel|postele|postelí",
     ["/detske-postele/", "/detske-postele-s-obrazkem-a-zabranou-kevin/"], "Výběr první dětské postele – bezpečnost, rozměr, styl."),
    ("postylky-miminka", "Postýlky pro miminka", r"postýl|postyl|kolébk|kolebk",
     ["/detske-postylky-pro-miminka/"], "Výbavička pro miminko – postýlka, matrace, mantinel."),
    ("pristavne-postylky", "Přístavné a rostoucí postýlky", r"(postýl|postyl)\w* k posteli|přístav|pristav|rostouc",
     ["/pristavne-detske-postylky/"], "Miminko na dosah – přístavná postýlka k posteli rodičů."),
    ("matrace", "Dětské matrace a chrániče", r"matrac|chránič|chranic|prostěrad|prosterad",
     ["/detske-matrace/", "/matracove-chranice/"], "Zdravý spánek – tvrdost, rozměr, pratelný potah, chránič."),
    ("montessori", "Montessori hračky a nábytek", r"montessori|montesori|montesorri|montessory|učící věž|ucici vez|piklerov",
     ["vyhledavani:montessori", "/drevene-hracky/", "/hracky-goki/"], "Samostatnost dítěte – hračky a nábytek podle Montessori."),
    ("kuchynky", "Dětské kuchyňky", r"kuchyň|kuchyn|kuchyňk",
     ["vyhledavani:kuchyňka"], "Hra na vaření – dřevěná kuchyňka jako dárek."),
    ("activity-board", "Activity boardy a motorické hračky", r"activity|aktivity|aktivní deska|motorick|busy board",
     ["vyhledavani:activity", "/drevene-hracky-pro-miminka/"], "Rozvoj jemné motoriky hrou."),
    ("stolky-zidlicky", "Dětské stolky a židličky", r"stol|stůl|židl|zidl",
     ["/hraci-stoly-a-zidle/", "/psaci-stoly/"], "Místo na kreslení, tvoření a první úkoly."),
    ("povleceni", "Dětské povlečení", r"povlečen|povleceni|povlak",
     ["/detske-povleceni-2/", "vyhledavani:povlečení"], "Oblíbený motiv na polštáři – snazší usínání."),
    ("nabytek-pokoj", "Nábytek do dětského pokoje", r"skříň|skrin|skřín|komod|regál|regal|polič|polic|knihovn|nábyt|nabyt",
     ["/detsky-nabytek/", "/detsky-obrazkovy-nabytek/"], "Kompletní pokojíček – skříně, komody, regály v jednom stylu."),
    ("doplnky-pokoj", "Koberce a doplňky do dětského pokoje", r"kober|závěs|zaves|tapet|samolep|nálepk|nalepk|nástěnk|nastenk|světýl|svetyl|lamp",
     ["/detske-koberce/", "/doplnky-k-nabytku/", "/svetylka/"], "Útulný pokojíček – koberec, světýlko, dekorace."),
    ("inspirace-pokoj", "Inspirace: zařízení dětského pokoje", r"pokoj|pokojíč|pokojic",
     ["/sestavy-pokojicku/", "/detsky-pokojicek/"], "Jak zařídit malý/sdílený dětský pokoj – nápady a sestavy."),
    ("houpacky", "Houpačky a hračky na zahradu", r"houpač|houpac|houpad|zahrad|venkovn|prolézač|prolezac",
     ["vyhledavani:houpačka", "/hracky-na-zahradu/"], "Jaro a léto venku – houpačky a hry na zahradu."),
    ("pohovky-kresilka", "Rozkládací pohovky a křesílka", r"rozkládac|rozkladac|skládac|skladac|pohovk|gauč|gauc|křesl|kresl|sedací vak|sedaci vak",
     ["/detske-pohovky/", "/detske-kresilka/"], "Pohovka, která se změní v domeček nebo spaní pro návštěvu."),
]

# Keyword -> topic matching order: specific topics before generic ones
MATCH_ORDER = [
    "montessori", "povleceni", "pristavne-postylky", "domeckove-postele", "patrove-postele", "vyvysene-postele",
    "postele-ulozny-prostor", "postele-zabrana", "postele-masiv", "postele-pristylka", "postele-holky-kluci",
    "matrace", "pohovky-kresilka", "postele-rozmery", "detske-postele", "postylky-miminka", "kuchynky",
    "activity-board", "houpacky", "stolky-zidlicky", "nabytek-pokoj", "doplnky-pokoj", "inspirace-pokoj",
]
assert sorted(MATCH_ORDER) == sorted(t[0] for t in TOPICS)

# Topics without AKW keywords (eshop priorities from the Google Ads feed)
EXTRA_TOPICS = [
    dict(id="molitan", name="Molitanové kostky a pěnové hřiště", sources=["/molitanove-kostky/"],
         angle="Bezpečné hraní doma i v zimě – stavění, lezení, skákání.", volume=0, keywords=[], questions=[],
         seasonality=[], peak_months=[10, 11, 12, 1, 2]),
    dict(id="plys", name="Plyšové hračky", sources=["/plysove-hracky-2/"],
         angle="Plyšák jako drobný dárek a parťák na usínání.", volume=0, keywords=[], questions=[],
         seasonality=[], peak_months=[11, 12]),
]

# Special campaign types (not tied to AKW topics)
SPECIALS = [
    dict(id="akce", name="Akce a výprodej", sources=["/akce-a-vyprodej/", "/vyprodej-nabytku/"],
         angle="Zboží se slevou – zdůraznit původní cenu, výši slevy a omezené množství."),
    dict(id="vanoce", name="Vánoční dárky", sources=["vyhledavani:kuchyňka", "/plysove-hracky-2/", "/hracky-goki/", "/molitanove-kostky/"],
         angle="Tipy na dárky pod stromeček, termín doručení do Vánoc."),
    dict(id="skola", name="Zpátky do školy", sources=["/psaci-stoly/", "/detsky-nabytek/"],
         angle="Psací stůl a pracovní koutek pro školáka."),
    dict(id="zima", name="Zimní oblečení", sources=["/zimni-obleceni/"],
         angle="Teplé oblečení na zimní radovánky."),
]

QUESTION_RE = re.compile(r"^(jak|jaký|jaká|jaké|jakou|co|kdy|proč|kolik|kde|který|která|které)\b|rozměr|recenze|nejlepší|test", re.I)


def fold(s):
    """Accent-free, crude stem form used to drop near-duplicate keyword spellings."""
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(w[:5] for w in re.findall(r"[a-z0-9]+", s))


def num(s):
    s = (s or "").replace("\xa0", "").replace(" ", "").replace("€", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--out", default="src/plan.json")
    args = ap.parse_args()

    rows, seen = [], set()
    with open(args.csv, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            kw = r["Keyword"].strip().lower()
            if kw in seen or r["Priorita"].strip() not in ("1", "2", "3"):
                continue
            seen.add(kw)
            rows.append(r)

    assigned = defaultdict(list)
    by_id = {t[0]: t for t in TOPICS}
    compiled = [(tid, re.compile(by_id[tid][2], re.I)) for tid in MATCH_ORDER]
    for r in rows:
        kw = r["Keyword"].strip().lower()
        for tid, rx in compiled:   # first matching topic wins (specific topics first)
            if rx.search(kw):
                assigned[tid].append(r)
                break

    topics = []
    for tid, name, _rx, sources, angle in TOPICS:
        rs = assigned[tid]
        vol = sum(num(r["Searches total (avg. per month)"]) for r in rs)
        monthly = [sum(num(r[f"Searches {m} Google CZ"]) for r in rs) for m in MONTHS]
        avg = sum(monthly) / 12 or 1
        idx = [round(v / avg * 100) for v in monthly]
        season = sorted(zip(MONTH_NUM, idx))
        peaks = [m for m, i in season if i >= 115]
        top = sorted(rs, key=lambda r: -num(r["Searches total (avg. per month)"]))
        kws, qs, folded = [], [], set()
        for r in top:
            k = r["Keyword"].strip()
            if fold(k) in folded:
                continue
            folded.add(fold(k))
            if QUESTION_RE.search(k):
                if len(qs) < 8:
                    qs.append(k)
            elif len(kws) < 12:
                kws.append(k)
        topics.append(dict(id=tid, name=name, sources=sources, angle=angle, volume=round(vol),
                           keywords=kws, questions=qs,
                           seasonality=[dict(month=m, index=i) for m, i in season], peak_months=peaks))
    topics.sort(key=lambda t: -t["volume"])
    topics += EXTRA_TOPICS

    plan = dict(source="AKW 2026 – pokojicky-tepe.cz (priorita 1–3)", topics=topics, specials=SPECIALS)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=1)
    for t in topics:
        print(f"{t['name']:45} {t['volume']:>7}  peaks={t['peak_months']}  e.g. {', '.join(t['keywords'][:3])}")


if __name__ == "__main__":
    main()
