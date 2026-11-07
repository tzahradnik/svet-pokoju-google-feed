import type { Env, Product } from "./types";

const UA = "Mozilla/5.0 (compatible; svet-pokoju-newsletter)";
const CACHE_SECONDS = 3600;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function absolute(url: string, base: string): string {
  if (!url) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Turns a plan source ("/category/" or "vyhledavani:query") into a shop URL. */
export function sourceUrl(env: Env, source: string): string {
  if (source.startsWith("vyhledavani:")) {
    return `${env.SHOP_URL}/vyhledavani/?string=${encodeURIComponent(source.slice("vyhledavani:".length))}`;
  }
  const path = source.startsWith("/") ? source : `/${source}`;
  return env.SHOP_URL + (path.endsWith("/") ? path : `${path}/`);
}

async function fetchHtml(url: string, ctx: ExecutionContext): Promise<string> {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit.text();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "cs" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Stránku ${url} se nepodařilo načíst (HTTP ${res.status})`);
  const html = await res.text();
  ctx.waitUntil(cache.put(key, new Response(html, { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}`, "Content-Type": "text/html" } })));
  return html;
}

/** Parses Shoptet product cards (category or search listing). */
export function parseProducts(html: string, shopUrl: string): Product[] {
  const start = html.indexOf('id="products"');
  const block = start >= 0 ? html.slice(start) : html;
  const out: Product[] = [];
  const seen = new Set<string>();
  for (const chunk of block.split(/(?=<div class="p" data-micro="product")/).slice(1)) {
    const id = chunk.match(/data-micro-product-id="(\d+)"/)?.[1];
    if (!id || seen.has(id)) continue;
    const name = chunk.match(/data-testid="productCardName">([\s\S]*?)<\/span>/)?.[1];
    const href = chunk.match(/href="([^"]+)"\s+class="name"/)?.[1] ?? chunk.match(/href="([^"]+)"/)?.[1];
    const price = chunk.match(/data-micro-price="([\d.]+)"/)?.[1];
    if (!name || !href || !price) continue;
    seen.add(id);
    const image = chunk.match(/data-micro-image="([^"]+)"/)?.[1] ?? chunk.match(/<img[^>]+src="(https:[^"]+)"/)?.[1] ?? "";
    const orig = chunk.match(/class="price-standard"[^>]*>\s*<span>([\d\s &nbsp;]+)\s*Kč/)?.[1];
    const save = chunk.match(/class="price-save"[^>]*>[^\d]*(\d+)\s*%/)?.[1];
    const availability = clean(chunk.match(/class="availability">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const flags = [...chunk.matchAll(/<span class="flag flag-[a-z-]+">\s*([^<]+?)\s*<\/span>/g)].map((m) => clean(m[1] ?? "")).filter(Boolean);
    const priceOriginal = orig ? Number(decodeEntities(orig).replace(/\D/g, "")) : null;
    out.push({
      id,
      name: clean(name),
      url: href.startsWith("http") ? href : shopUrl + href,
      // Shoptet serves relative image paths to some clients (e.g. Cloudflare) – e-mails need absolute URLs
      image: absolute(decodeEntities(image.trim()), shopUrl),
      price: Math.round(Number(price)),
      priceOriginal: priceOriginal && priceOriginal > Number(price) ? priceOriginal : null,
      discountPct: save ? Number(save) : null,
      availability,
      // "Skladem do 7–21 dní" means made to order, not available right now
      inStock: /^skladem\b/i.test(availability) && !/skladem do|není skladem|vyprodán/i.test(availability),
      flags,
    });
  }
  return out;
}

export async function loadSource(env: Env, ctx: ExecutionContext, source: string): Promise<Product[]> {
  return parseProducts(await fetchHtml(sourceUrl(env, source), ctx), env.SHOP_URL);
}

/** Loads products from several sources, de-duplicated, best candidates first. */
export async function loadCandidates(env: Env, ctx: ExecutionContext, sources: string[], preferDiscount: boolean): Promise<Product[]> {
  const lists = await Promise.allSettled(sources.map((s) => loadSource(env, ctx, s)));
  const all = new Map<string, Product>();
  for (const r of lists) if (r.status === "fulfilled") for (const p of r.value) if (!all.has(p.id)) all.set(p.id, p);
  const score = (p: Product) => (p.inStock ? 0 : 10) + (preferDiscount && !p.discountPct ? 5 : 0) + (p.image ? 0 : 20);
  return [...all.values()].sort((a, b) => score(a) - score(b));
}

export interface ProductPage extends Product {
  images: string[];
}

/** Parses a product detail page: real name, current price, stock and the whole photo gallery. */
export function parseProductPage(html: string, url: string, shopUrl: string): ProductPage | null {
  const id = html.match(/name="productId" value="(\d+)"/)?.[1];
  const h1 = html.match(/<div class="p-detail-inner-header">\s*<h1>([\s\S]*?)<\/h1>/)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  if (!id || !h1) return null;
  const images = [
    ...new Set(
      // Shoptet serves relative paths to some clients (e.g. Cloudflare) – e-mails need absolute URLs
      [...html.matchAll(/href="((?:https:\/\/cdn\.myshoptet\.com\/usr\/[^/"]+)?\/user\/shop\/big\/[^"]+)"/g)].map((m) => absolute(decodeEntities(m[1] ?? ""), shopUrl)),
    ),
  ];
  const ogImage = html.match(/property="og:image" content="([^"]+)"/)?.[1];
  if (!images.length && ogImage) images.push(absolute(decodeEntities(ogImage), shopUrl));
  // og:title carries the lowest current price ("… za 9 119 Kč - …")
  const ogTitle = decodeEntities(html.match(/property="og:title" content="([^"]+)"/)?.[1] ?? "");
  const priceTxt = ogTitle.match(/za ([\d\s ]+) Kč/)?.[1] ?? html.match(/class="price-final[^"]*"[^>]*>[\s\S]*?([\d\s ]+)\s*Kč/)?.[1] ?? "0";
  const orig = html.match(/class="price-standard"[^>]*>[\s\S]*?<span>([\d\s ]+)\s*Kč/)?.[1];
  const save = html.match(/class="price-save"[^>]*>[^\d]*(\d+)\s*%/)?.[1];
  const availability = clean(html.match(/class="availability-label"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
  const price = Number(priceTxt.replace(/\D/g, "")) || 0;
  const priceOriginal = orig ? Number(orig.replace(/\D/g, "")) : null;
  return {
    id,
    name: clean(h1),
    url,
    image: images[0] ?? "",
    images: images.slice(0, 24),
    price,
    priceOriginal: priceOriginal && priceOriginal > price ? priceOriginal : null,
    discountPct: save ? Number(save) : null,
    availability,
    inStock: /^skladem\b/i.test(availability) && !/skladem do|není skladem|vyprodán/i.test(availability),
    flags: [],
  };
}

export async function loadProductPage(env: Env, ctx: ExecutionContext, pathOrUrl: string): Promise<ProductPage | null> {
  const url = new URL(pathOrUrl, env.SHOP_URL);
  if (url.hostname !== new URL(env.SHOP_URL).hostname) throw new Error("Odkaz nevede na e-shop");
  url.search = "";
  return parseProductPage(await fetchHtml(url.toString(), ctx), url.toString(), env.SHOP_URL);
}
