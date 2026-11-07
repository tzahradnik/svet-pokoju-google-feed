import type { Env } from "./types";

export interface LinkResult {
  url: string;
  status: number;
  ok: boolean;
  note: string;
}

const MAX_LINKS = 40;

/** Extracts every real link from the e-mail HTML (merge tags, mailto: and tel: are skipped). */
export function extractLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) {
    const raw = (m[1] ?? "").replace(/&amp;/g, "&");
    try {
      const u = new URL(raw);
      for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
      out.add(u.toString());
    } catch {
      /* ignore malformed */
    }
  }
  return [...out];
}

/** Checks that each link works. Shoptet redirects removed products to a category – reported as a problem. */
export async function checkLinks(env: Env, urls: string[]): Promise<LinkResult[]> {
  const shopHost = new URL(env.SHOP_URL).hostname;
  return Promise.all(
    urls.slice(0, MAX_LINKS).map(async (url): Promise<LinkResult> => {
      try {
        const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; svet-pokoju-newsletter)" } });
        res.body?.cancel();
        const loc = res.headers.get("Location");
        if (res.status >= 300 && res.status < 400 && loc) {
          const target = new URL(loc, url);
          const sameUrl = target.pathname === new URL(url).pathname && target.hostname.replace(/^www\./, "") === new URL(url).hostname.replace(/^www\./, "");
          // CDN images redirect to the shop domain – that is fine
          const harmless = sameUrl || /\/user\/shop\//.test(new URL(url).pathname);
          return { url, status: res.status, ok: harmless, note: harmless ? "přesměrování (v pořádku)" : `přesměrováno na ${target.toString()}${new URL(url).hostname === shopHost ? " – produkt nebo stránka nejspíš už neexistuje" : ""}` };
        }
        if (res.ok) return { url, status: res.status, ok: true, note: "v pořádku" };
        return { url, status: res.status, ok: false, note: res.status === 404 ? "stránka neexistuje (404)" : `chyba ${res.status}` };
      } catch (e) {
        return { url, status: 0, ok: false, note: `nedostupné: ${e instanceof Error ? e.message : "chyba"}` };
      }
    }),
  );
}
