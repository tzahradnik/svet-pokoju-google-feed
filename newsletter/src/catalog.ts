import type { Env } from "./types";

/** Catalogue built daily from the shop sitemap by tools/build_catalog.py (GitHub Actions → GitHub Pages).
 *  The copy bundled in public/data/ is used when the published one is unavailable. */
export interface SiteCategory {
  path: string;
  name: string;
  kind: "category" | "brand" | "collection" | "room";
  products: number;
  brand?: string;
}
export interface SitePage {
  path: string;
  name: string;
  role?: string;
}
export interface SiteData {
  generated: string;
  trackingSince: string;
  counts: { products: number; categories: number; blog: number; pages: number };
  categories: SiteCategory[];
  blog: SitePage[];
  pages: SitePage[];
  newProducts: { path: string; name: string; image: string; firstSeen: string }[];
  coverage: {
    topicsSearchOnly: { id: string; name: string; volume: number }[];
    categoriesWithoutTopic: { path: string; name: string; products: number }[];
    missingSources?: string[];
  };
}

const CACHE_SECONDS = 3600;

/** Returns the catalogue file as a Response (published copy, else the bundled one). */
export async function catalogFile(env: Env, ctx: ExecutionContext, name: "site.json" | "products.json"): Promise<Response> {
  if (env.CATALOG_URL) {
    const url = env.CATALOG_URL.replace(/\/?$/, "/") + name;
    const cache = caches.default;
    const key = new Request(url);
    const hit = await cache.match(key);
    if (hit) return hit;
    try {
      const res = await fetch(url, { cf: { cacheTtl: CACHE_SECONDS } });
      if (res.ok) {
        const out = new Response(res.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `max-age=${CACHE_SECONDS}` } });
        ctx.waitUntil(cache.put(key, out.clone()));
        return out;
      }
    } catch {
      /* fall back to the bundled copy */
    }
  }
  return env.ASSETS.fetch(new Request(`https://assets.local/data/${name}`));
}

let memo: { at: number; data: SiteData } | null = null;

export async function getSite(env: Env, ctx: ExecutionContext): Promise<SiteData> {
  if (memo && Date.now() - memo.at < CACHE_SECONDS * 1000) return memo.data;
  const data = (await (await catalogFile(env, ctx, "site.json")).json()) as SiteData;
  memo = { at: Date.now(), data };
  return data;
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(["detsk", "proc", "jak", "pro", "jake", "ktera", "ktery", "kdy", "nebo", "vase", "vasi", "rodic"]);
const stems = (s: string) => new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)).filter((w) => !STOP.has(w)));

/** Blog articles and guide pages most related to the e-mail topic (by shared word stems). */
export function relatedArticles(site: SiteData, text: string, limit = 3): SitePage[] {
  const want = stems(text);
  const scored = site.blog
    .map((a) => ({ a, score: [...stems(a.name)].filter((w) => want.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
  const guides = site.pages.filter((p) => p.role === "guide");
  return [...scored.slice(0, limit), ...guides];
}
