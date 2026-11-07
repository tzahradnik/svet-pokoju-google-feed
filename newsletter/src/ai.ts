import Anthropic from "@anthropic-ai/sdk";
import type { EmailCopy, Env, Product } from "./types";

export const MODEL = "claude-opus-5-5";

import VOICE from "./hlas-znacky.md";

/** Task rules; the brand story and tone of voice live in hlas-znacky.md (editable without touching code). */
const TASK = `Jsi Tereza ze Světa pokojů (svet-pokoju.cz) a píšeš newsletter rodičům, kteří u vás nakoupili nebo se přihlásili k odběru. Řiď se příběhem, tónem hlasu a povinnými pravidly níže.

Zadání úkolu:
- Používej jazyk, kterým lidé téma hledají (klíčová slova z analýzy), ale nenásilně. Nikdy je nevyjmenovávej.
- Produkty vybírej jen z dodaného seznamu kandidátů podle jejich "id". Vyber nejvhodnější pro téma, preferuj zboží skladem a s fotkou, u akcí zboží se slevou.
- Předmět: do 60 znaků, láká k otevření, zní jako zpráva od člověka, ne jako reklama. Dej 3 odlišné varianty.
- Preheader: 60 až 100 znaků, doplňuje předmět a neopakuje ho.
- Úvod (intro) začni pozdravem „Dobrý den,“ (při tykání „Ahoj,“) a hned řekni, proč píšeš.
- Popisek produktu (blurb): 1 až 2 věty, komu a k čemu se produkt hodí. O produktu znáš jen název, cenu, dostupnost a štítky. Nepřidávej vlastnosti, které tam nejsou (materiál, funkce, certifikace, rozměry). Čísla v názvu ber doslova. Odznak (badge): krátký štítek jako "Sleva 15 %", "Tip", "Skladem" nebo prázdný řetězec.
- Sekce (sections): 0 až 2 krátké bloky s praktickou radou, ideálně odpověď na konkrétní častou otázku z analýzy. Titulek je otázka nebo „Tip od Terezy“, text začíná přímou odpovědí. Konkrétní čísla jen obecně platná a ověřitelná. Každá nanejvýš 3 věty, nebo výčet 2 až 4 bodů (každý bod na vlastním řádku začínajícím „- “).
- Když dostaneš články z blogu nebo průvodce a některý přímo souvisí s blokem, vyplň link_url (přesně jedna z dodaných URL) a link_text (krátká výzva, např. „Přečtěte si celý návod“). Jinak nech obě pole prázdná a žádné jiné odkazy si nevymýšlej.
- Závěr (closing): 1 až 2 věty, osobní nabídka pomoci (napsat nebo zavolat, poradit s výběrem, úprava na míru). Bez rozloučení a podpisu, ty doplní šablona.
- Text v polích je prostý text. Nový odstavec odděl prázdným řádkem.`;

const SYSTEM = `${TASK}\n\n${VOICE}`;

/** Hard guarantee for the house rules: no em/en dashes as punctuation, no "&", no non-breaking spaces. */
export function cleanText(t: string): string {
  return t
    .replace(/\u00a0/g, " ")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2") // ranges: 3–6 → 3-6
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/–/g, "-")
    .replace(/\s*&\s*/g, " a ")
    .replace(/,\s*([,.!?:])/g, "$1")
    .replace(/ {2,}/g, " ");
}

function cleanDeep<T>(v: T): T {
  if (typeof v === "string") return cleanText(v) as T;
  if (Array.isArray(v)) return v.map(cleanDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /url|^id$/.test(k) ? x : cleanDeep(x)])) as T;
  return v;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject_variants", "preheader", "headline", "intro", "hero_cta_text", "hero_cta_url", "sections", "products", "closing", "cta_text"],
  properties: {
    subject_variants: { type: "array", items: { type: "string" }, description: "3 varianty předmětu" },
    preheader: { type: "string" },
    headline: { type: "string", description: "Hlavní nadpis e-mailu" },
    intro: { type: "string", description: "Úvodní text, 2–4 věty" },
    hero_cta_text: { type: "string", description: "Text hlavního tlačítka" },
    hero_cta_url: { type: "string", description: "URL hlavního tlačítka – jedna z dodaných URL kategorií" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "text", "link_url", "link_text"],
        properties: { title: { type: "string" }, text: { type: "string" }, link_url: { type: "string" }, link_text: { type: "string" } },
      },
    },
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "blurb", "badge"],
        properties: { id: { type: "string" }, blurb: { type: "string" }, badge: { type: "string" } },
      },
    },
    closing: { type: "string", description: "Závěrečný odstavec" },
    cta_text: { type: "string", description: "Text závěrečného tlačítka" },
  },
} as const;

export interface GenerateInput {
  topicName: string;
  angle: string;
  keywords: string[];
  questions: string[];
  categoryUrls: string[];
  productCount: number;
  brief: string;
  tone: "vykani" | "tykani";
  month: string;
  candidates: Product[];
  /** Blog articles / guides on the shop that sections may link to. */
  articles: { name: string; url: string }[];
  previous?: EmailCopy;
  feedback?: string;
}

function productLine(p: Product): string {
  const price = p.priceOriginal ? `${p.price} Kč (původně ${p.priceOriginal} Kč, sleva ${p.discountPct ?? ""} %)` : `${p.price} Kč`;
  return `- id=${p.id} | ${p.name} | ${price} | ${p.availability || "dostupnost neuvedena"}${p.flags.length ? ` | štítky: ${p.flags.join(", ")}` : ""}`;
}

function buildPrompt(i: GenerateInput): string {
  const parts = [
    `Napiš newsletter na téma: ${i.topicName}.`,
    `Úhel pohledu: ${i.angle}`,
    `Aktuální měsíc: ${i.month}.`,
    `Oslovení: ${i.tone === "tykani" ? "tykej čtenáři" : "vykej čtenáři"}.`,
    `Počet produktů v e-mailu: ${i.productCount}.`,
    i.keywords.length ? `Jak lidé téma hledají (analýza klíčových slov): ${i.keywords.join(", ")}.` : "",
    i.questions.length ? `Časté otázky z vyhledávání: ${i.questions.join("; ")}.` : "",
    `URL kategorií pro hlavní tlačítko: ${i.categoryUrls.join(", ")}.`,
    i.brief ? `Zadání od uživatele (má přednost): ${i.brief}` : "",
    i.articles.length ? `Články a průvodci na e-shopu, na které můžeš z bloku odkázat:\n${i.articles.map((a) => `- ${a.name} | ${a.url}`).join("\n")}` : "",
    `Kandidáti produktů:\n${i.candidates.map(productLine).join("\n")}`,
  ];
  if (i.previous) {
    parts.push(`Předchozí verze e-mailu (JSON):\n${JSON.stringify(i.previous)}`);
    parts.push(`Uprav ji podle této zpětné vazby: ${i.feedback || "napiš novou, odlišnou verzi"}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

export async function generateCopy(env: Env, input: GenerateInput): Promise<EmailCopy> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Chybí ANTHROPIC_API_KEY – nastavte ho v Cloudflare (wrangler secret put).");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: buildPrompt(input) }],
  });
  if (response.stop_reason === "refusal") throw new Error("AI odmítla zadání zpracovat – upravte zadání a zkuste to znovu.");
  if (response.stop_reason === "max_tokens") throw new Error("Odpověď AI byla příliš dlouhá – zkuste méně produktů.");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("AI nevrátila žádný text.");
  const copy = cleanDeep(JSON.parse(text.text) as EmailCopy);
  const allowed = new Set(input.candidates.map((p) => p.id));
  copy.products = copy.products.filter((p) => allowed.has(p.id));
  const links = new Set(input.articles.map((a) => a.url));
  copy.sections = copy.sections.map((s) => (s.link_url && links.has(s.link_url) ? s : { ...s, link_url: "", link_text: "" }));
  return copy;
}
