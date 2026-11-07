import { generateCopy, MODEL } from "./ai";
import { checkPassword, clearCookie, isAuthenticated, sessionCookie } from "./auth";
import { createDraft, listLists } from "./ecomail";
import { renderEmail } from "./email";
import planJson from "./plan.json";
import { catalogFile, getSite, relatedArticles } from "./catalog";
import { checkLinks, extractLinks } from "./links";
import { loadCandidates, loadProductPage, loadSource, sourceUrl } from "./shop";
import type { EmailState, Env, Plan, Product } from "./types";

const basePlan = planJson as Plan;
// "Novinky" is driven by the catalogue (products that newly appeared in the sitemap), not by categories
const NEWS_ID = "novinky";
const plan: Plan = {
  ...basePlan,
  specials: [
    { id: NEWS_ID, name: "Novinky v nabídce", sources: [], angle: "Představ zboží, které je v nabídce nově – co je na něm nového a pro koho se hodí." },
    ...basePlan.specials,
  ],
};
const NEWS_MAX = 12;
const MONTHS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"];
const MAX_CANDIDATES = 40;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Neplatný požadavek");
  }
}

interface GenerateRequest {
  kind: "topic" | "special" | "custom" | "category";
  id?: string;
  customName?: string;
  /** kind "category": the chosen shop category / brand / room */
  category?: { path: string; name: string };
  sources?: string[];
  productCount?: number;
  brief?: string;
  tone?: "vykani" | "tykani";
  pinnedProducts?: Product[];
  previous?: EmailState;
  feedback?: string;
}

async function handleGenerate(env: Env, ctx: ExecutionContext, r: GenerateRequest) {
  const topic = r.kind === "topic" ? plan.topics.find((t) => t.id === r.id) : undefined;
  const special = r.kind === "special" ? plan.specials.find((t) => t.id === r.id) : undefined;
  if ((r.kind === "topic" || r.kind === "special") && !topic && !special) throw new HttpError(400, "Neznámé téma");
  if (r.kind === "category" && !r.category?.path) throw new HttpError(400, "Vyberte kategorii, značku nebo místnost.");
  const isNews = special?.id === NEWS_ID;
  const name = topic?.name ?? special?.name ?? (r.kind === "category" ? r.category!.name : r.customName?.trim() || "Newsletter");
  const defaults = (topic ?? special)?.sources ?? (r.kind === "category" ? [r.category!.path] : []);
  const sources = r.sources?.length ? r.sources : defaults;
  if (!sources.length && !r.pinnedProducts?.length && !isNews) throw new HttpError(400, "Zadejte aspoň jednu kategorii nebo vyhledávání pro výběr produktů.");
  const productCount = Math.min(Math.max(r.productCount ?? 4, 1), 8);
  const site = await getSite(env, ctx).catch(() => null);

  const pinned = r.pinnedProducts ?? [];
  let loaded = sources.length ? await loadCandidates(env, ctx, sources, r.id === "akce") : [];
  if (isNews) {
    const fresh = site?.newProducts ?? [];
    if (!fresh.length) {
      throw new HttpError(422, `Zatím nejsou žádné nové produkty. Nové zboží se sleduje od ${site?.trackingSince ?? "spuštění katalogu"} – jakmile Shoptet přidá produkt, objeví se tu do 6 hodin.`);
    }
    const pages = await Promise.allSettled(fresh.slice(0, NEWS_MAX).map((p) => loadProductPage(env, ctx, p.path)));
    const news = pages.flatMap((x) => (x.status === "fulfilled" && x.value ? [x.value] : [])).map(({ images: _images, ...p }) => ({ ...p, flags: ["Novinka"] }));
    loaded = [...news, ...loaded.filter((p) => !news.some((n) => n.id === p.id))];
  }
  const candidates = [...pinned, ...loaded.filter((p) => !pinned.some((x) => x.id === p.id))].slice(0, MAX_CANDIDATES);
  if (!candidates.length) throw new HttpError(422, "Ve zvolených kategoriích se nenašly žádné produkty.");

  const topicText = [name, ...(topic?.keywords ?? []), ...(topic?.questions ?? []), r.brief ?? ""].join(" ");
  const articles = site ? relatedArticles(site, topicText).map((a) => ({ name: a.name, url: env.SHOP_URL + a.path })) : [];

  const copy = await generateCopy(env, {
    topicName: name,
    angle: topic?.angle ?? special?.angle ?? (r.kind === "category" ? `E-mail věnovaný nabídce „${name}“ na e-shopu.` : ""),
    keywords: topic?.keywords ?? [],
    questions: topic?.questions ?? [],
    categoryUrls: sources.filter((s) => !s.startsWith("vyhledavani:")).map((s) => sourceUrl(env, s)).concat(sources.length ? [] : [env.SHOP_URL]),
    productCount: Math.max(productCount, pinned.length),
    brief: [pinned.length ? `Do e-mailu povinně zařaď tyto produkty: ${pinned.map((p) => p.id).join(", ")}.` : "", isNews ? "Vybírej hlavně produkty se štítkem Novinka." : "", r.brief ?? ""]
      .filter(Boolean)
      .join(" "),
    tone: r.tone ?? "vykani",
    month: MONTHS[new Date().getMonth()] ?? "",
    candidates,
    articles,
    previous: r.previous?.copy,
    feedback: r.feedback,
  });
  if (!copy.hero_cta_url && sources[0] && !sources[0].startsWith("vyhledavani:")) copy.hero_cta_url = sourceUrl(env, sources[0]);
  const state: EmailState = { campaign: name, subject: copy.subject_variants[0] ?? name, copy, products: candidates, heroImage: r.previous?.heroImage ?? "" };
  return { state, candidates, articles };
}

async function api(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/login" && req.method === "POST") {
    const { password } = await body<{ password?: string }>(req);
    if (!password || !(await checkPassword(env, password))) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return json({ error: "Nesprávné heslo" }, 401);
    }
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, url) });
  }
  if (path === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });

  if (!(await isAuthenticated(env, req))) return json({ error: "Nejste přihlášeni" }, 401);

  if (path === "/api/session") {
    return json({
      ok: true,
      ecomail: Boolean(env.ECOMAIL_API_KEY),
      ai: Boolean(env.ANTHROPIC_API_KEY),
      aiModel: MODEL,
      shopUrl: env.SHOP_URL,
      planTopics: plan.topics.length,
      catalogUrl: env.CATALOG_URL ?? "",
      signature: env.SIGNATURE_NAME ? [env.SIGNATURE_NAME, env.SIGNATURE_ROLE].filter(Boolean).join(", ") : "",
      sender: { fromName: env.FROM_NAME, fromEmail: env.FROM_EMAIL, replyTo: env.REPLY_TO, defaultListId: env.DEFAULT_LIST_ID },
    });
  }
  if (path === "/api/plan") return json(plan);
  if (path === "/api/site") return json(await getSite(env, ctx));
  if (path === "/api/catalog/products") {
    const res = await catalogFile(env, ctx, "products.json");
    return new Response(res.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, max-age=3600" } });
  }
  if (path === "/api/product") {
    const target = url.searchParams.get("url") ?? "";
    if (!target) throw new HttpError(400, "Chybí odkaz na produkt");
    const product = await loadProductPage(env, ctx, target);
    if (!product) throw new HttpError(404, "Produkt se na e-shopu nepodařilo načíst – možná už neexistuje.");
    return json({ product });
  }
  if (path === "/api/check-links" && req.method === "POST") {
    const state = await body<EmailState>(req);
    const results = await checkLinks(env, extractLinks(renderEmail(env, state)));
    return json({ results, broken: results.filter((r) => !r.ok).length });
  }
  if (path === "/api/products") {
    const source = url.searchParams.get("source") ?? "";
    if (!source) throw new HttpError(400, "Chybí zdroj");
    return json({ products: await loadSource(env, ctx, source) });
  }
  if (path === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2) return json({ products: [] });
    return json({ products: (await loadSource(env, ctx, `vyhledavani:${q}`)).slice(0, 24) });
  }
  if (path === "/api/generate" && req.method === "POST") return json(await handleGenerate(env, ctx, await body<GenerateRequest>(req)));
  if (path === "/api/render" && req.method === "POST") {
    const state = await body<EmailState>(req);
    return new Response(renderEmail(env, state), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (path === "/api/ecomail/lists") return json({ lists: await listLists(env) });
  if (path === "/api/ecomail/draft" && req.method === "POST") {
    const d = await body<{ state: EmailState; title: string; listIds: number[]; fromName: string; fromEmail: string; replyTo: string }>(req);
    if (!d.state?.subject?.trim()) throw new HttpError(400, "Vyplňte předmět e-mailu.");
    if (!d.fromEmail?.trim()) throw new HttpError(400, "Vyplňte e-mail odesílatele (musí být na ověřené doméně v Ecomailu).");
    if (!d.listIds?.length) throw new HttpError(400, "Vyberte aspoň jeden seznam kontaktů.");
    const draft = await createDraft(env, {
      title: d.title?.trim() || d.state.campaign,
      subject: d.state.subject.trim(),
      html: renderEmail(env, d.state),
      listIds: d.listIds,
      fromName: d.fromName?.trim() || env.FROM_NAME,
      fromEmail: d.fromEmail.trim(),
      replyTo: d.replyTo?.trim() || env.REPLY_TO,
    });
    return json({ ok: true, id: draft.id });
  }
  return json({ error: "Nenalezeno" }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, ctx, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : "Neznámá chyba";
      console.error(message);
      return json({ error: message }, status);
    }
  },
} satisfies ExportedHandler<Env>;
