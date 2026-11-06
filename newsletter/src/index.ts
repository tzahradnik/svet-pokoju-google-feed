import { generateCopy } from "./ai";
import { checkPassword, clearCookie, isAuthenticated, sessionCookie } from "./auth";
import { createDraft, listLists } from "./ecomail";
import { renderEmail } from "./email";
import planJson from "./plan.json";
import { loadCandidates, loadSource, sourceUrl } from "./shop";
import type { EmailState, Env, Plan, Product } from "./types";

const plan = planJson as Plan;
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
  kind: "topic" | "special" | "custom";
  id?: string;
  customName?: string;
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
  if (r.kind !== "custom" && !topic && !special) throw new HttpError(400, "Neznámé téma");
  const name = topic?.name ?? special?.name ?? (r.customName?.trim() || "Newsletter");
  const sources = (r.sources?.length ? r.sources : (topic ?? special)?.sources) ?? [];
  if (!sources.length && !r.pinnedProducts?.length) throw new HttpError(400, "Zadejte aspoň jednu kategorii nebo vyhledávání pro výběr produktů.");
  const productCount = Math.min(Math.max(r.productCount ?? 4, 1), 8);

  const pinned = r.pinnedProducts ?? [];
  const loaded = await loadCandidates(env, ctx, sources, r.id === "akce");
  const candidates = [...pinned, ...loaded.filter((p) => !pinned.some((x) => x.id === p.id))].slice(0, MAX_CANDIDATES);
  if (!candidates.length) throw new HttpError(422, "Ve zvolených kategoriích se nenašly žádné produkty.");

  const copy = await generateCopy(env, {
    topicName: name,
    angle: topic?.angle ?? special?.angle ?? "",
    keywords: topic?.keywords ?? [],
    questions: topic?.questions ?? [],
    categoryUrls: sources.filter((s) => !s.startsWith("vyhledavani:")).map((s) => sourceUrl(env, s)).concat(sources.length ? [] : [env.SHOP_URL]),
    productCount: Math.max(productCount, pinned.length),
    brief: [pinned.length ? `Do e-mailu povinně zařaď tyto produkty: ${pinned.map((p) => p.id).join(", ")}.` : "", r.brief ?? ""].filter(Boolean).join(" "),
    tone: r.tone ?? "vykani",
    month: MONTHS[new Date().getMonth()] ?? "",
    candidates,
    previous: r.previous?.copy,
    feedback: r.feedback,
  });
  if (!copy.hero_cta_url && sources[0] && !sources[0].startsWith("vyhledavani:")) copy.hero_cta_url = sourceUrl(env, sources[0]);
  const state: EmailState = { campaign: name, subject: copy.subject_variants[0] ?? name, copy, products: candidates, heroImage: r.previous?.heroImage ?? "" };
  return { state, candidates };
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
      sender: { fromName: env.FROM_NAME, fromEmail: env.FROM_EMAIL, replyTo: env.REPLY_TO, defaultListId: env.DEFAULT_LIST_ID },
    });
  }
  if (path === "/api/plan") return json(plan);
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
