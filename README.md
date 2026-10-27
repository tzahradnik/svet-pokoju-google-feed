# Feed pro Google Ads – svet-pokoju.cz

`build_feed.py` stáhne Shoptet feed (`/google/export/products.xml`), vybere prioritní produkty
a vygeneruje malý feed `dist/google-ads-feed.xml` (cca 700 položek, strop 1 500).

- **P1_Kevin_postele / P1_Kevin_nabytek** – kolekce Kevin, jedna varianta na model (bílá, 140x70, bez úložného prostoru)
- **P2_Molitan** – molitanové stavebnice a pěnové hřiště
- **P3_Kresilka / P3_Pohovky** – dětská křesílka a pohovky (cross-sell k postelím)
- **P4_Plys** – plyšové hračky (`custom_label_4 = vanoce_2026`)

Kojenecké potřeby, levné hračky a matrace se do feedu nedostanou (whitelist).
Kategorie molitan/křesílka/pohovky/plyš doplňuje skript z webu, protože je Shoptet do Google feedu neexportuje.

Ladění: konstanty nahoře v `build_feed.py` (`MOTIFS_PER_MODEL`, `PRIORITY_MOTIFS`, `MAX_ITEMS` …).
Test lokálně: `python3 build_feed.py --out dist/google-ads-feed.xml`
Aktualizace: GitHub Actions každých 6 h publikuje feed na GitHub Pages.
