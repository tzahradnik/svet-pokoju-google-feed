import Anthropic from "@anthropic-ai/sdk";
import type { EmailCopy, Env, Product } from "./types";

export const MODEL = "claude-opus-5-5";

const SYSTEM = `Jsi zkušený e-mailový copywriter českého e-shopu Světpokojů.cz (svet-pokoju.cz). E-shop prodává dětský nábytek, postele, postýlky, matrace, doplňky do dětského pokoje a hračky. Píšeš newslettery pro rodiče malých dětí.

Zásady:
- Piš česky, přirozeně, vřele a srozumitelně; žádné prázdné fráze ani přehnané superlativy. Krátké odstavce, konkrétní přínos pro rodiče a dítě.
- Používej jazyk, kterým lidé hledají (klíčová slova z analýzy), ale nenásilně – nikdy je nevyjmenovávej ani neopakuj mechanicky.
- Ceny, slevy, dostupnost a parametry ber jen z dodaných dat o produktech. Nic si nevymýšlej (žádné termíny doručení, slevové kódy, dárky ani parametry, které nejsou v zadání).
- Produkty vybírej výhradně z dodaného seznamu kandidátů podle jejich "id". Vyber nejvhodnější pro téma, preferuj zboží skladem a s fotkou; u akcí preferuj zboží se slevou.
- Předmět: do 60 znaků, láká k otevření, může obsahovat jedno emoji. Dej 3 odlišné varianty.
- Preheader: 60–100 znaků, doplňuje předmět, neopakuje ho.
- Popisek produktu (blurb): 1–2 věty, proč ho rodiče ocení. Odznak (badge): krátký štítek jako "Sleva 15 %", "Tip", "Skladem" nebo prázdný řetězec.
- Sekce (sections): 0–2 krátké obsahové bloky s praktickou radou. Ideálně odpověď na konkrétní častou otázku z analýzy: titulek je otázka nebo „Tip od Světpokojů.cz“ / „Věděli jste, že…“, text začíná přímou odpovědí. Konkrétní čísla (rozměry, věk dítěte, výšky) jen pokud jsou obecně platná a ověřitelná. Každá max. 3 věty, nebo krátký výčet 2–4 bodů (každý bod na vlastním řádku začínajícím „- “).
- Pokud dostaneš seznam článků z blogu nebo průvodců e-shopu a některý přímo souvisí s blokem, vyplň u bloku link_url (přesně jedna z dodaných URL) a link_text (krátká výzva, např. „Přečtěte si celý návod“). Jinak nech obě pole prázdná. Žádné jiné odkazy si nevymýšlej.
- Text v polích je prostý text bez HTML a bez markdownu; nový odstavec odděl prázdným řádkem. Nepoužívej pevné mezery.

Ať text nepůsobí jako generovaný AI:
- Žádné prenadpisy (krátké slovo nebo fráze nad nadpisem), žádné nadpisy ve stylu „Objevte…“, „Ponořte se…“, „Vše, co potřebujete vědět“.
- Žádné obecné floskule („v dnešní uspěchané době“, „není nic lepšího než“, „dopřejte svému dítěti to nejlepší“, „ať už…, nebo…“) a žádné hromadění přídavných jmen.
- Neopakuj stejnou informaci v úvodu, sekcích, popiscích i závěru – každý blok přináší něco nového. Raději kratší e-mail než nafouknutý.
- Piš jako člověk z e-shopu, který sortiment zná: konkrétně, věcně, s jedním lidským detailem z praxe rodičů.`;

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
  // Non-breaking spaces read as a machine-text tell – normalise them to plain spaces
  const copy = JSON.parse(text.text.replace(/\u00a0/g, " ")) as EmailCopy;
  const allowed = new Set(input.candidates.map((p) => p.id));
  copy.products = copy.products.filter((p) => allowed.has(p.id));
  const links = new Set(input.articles.map((a) => a.url));
  copy.sections = copy.sections.map((s) => (s.link_url && links.has(s.link_url) ? s : { ...s, link_url: "", link_text: "" }));
  return copy;
}
