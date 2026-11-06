import Anthropic from "@anthropic-ai/sdk";
import type { EmailCopy, Env, Product } from "./types";

const MODEL = "claude-opus-5-5";

const SYSTEM = `Jsi zkušený e-mailový copywriter českého e-shopu Světpokojů.cz (svet-pokoju.cz). E-shop prodává dětský nábytek, postele, postýlky, matrace, doplňky do dětského pokoje a hračky. Píšeš newslettery pro rodiče malých dětí.

Zásady:
- Piš česky, přirozeně, vřele a srozumitelně; žádné prázdné fráze ani přehnané superlativy. Krátké odstavce, konkrétní přínos pro rodiče a dítě.
- Používej jazyk, kterým lidé hledají (klíčová slova z analýzy), ale nenásilně – nikdy je nevyjmenovávej ani neopakuj mechanicky.
- Ceny, slevy, dostupnost a parametry ber jen z dodaných dat o produktech. Nic si nevymýšlej (žádné termíny doručení, slevové kódy, dárky ani parametry, které nejsou v zadání).
- Produkty vybírej výhradně z dodaného seznamu kandidátů podle jejich "id". Vyber nejvhodnější pro téma, preferuj zboží skladem a s fotkou; u akcí preferuj zboží se slevou.
- Předmět: do 60 znaků, láká k otevření, může obsahovat jedno emoji. Dej 3 odlišné varianty.
- Preheader: 60–100 znaků, doplňuje předmět, neopakuje ho.
- Popisek produktu (blurb): 1–2 věty, proč ho rodiče ocení. Odznak (badge): krátký štítek jako "Sleva 15 %", "Tip", "Skladem" nebo prázdný řetězec.
- Sekce (sections): 0–2 krátké obsahové bloky s radou nebo inspirací k tématu (např. odpověď na častou otázku z analýzy). Každá max. 3 věty.
- Text v polích je prostý text bez HTML a bez markdownu; nový odstavec odděl prázdným řádkem.`;

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
      items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } },
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
  const copy = JSON.parse(text.text) as EmailCopy;
  const allowed = new Set(input.candidates.map((p) => p.id));
  copy.products = copy.products.filter((p) => allowed.has(p.id));
  return copy;
}
