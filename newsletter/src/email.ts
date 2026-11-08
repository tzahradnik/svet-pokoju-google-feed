import type { EmailState, Env, Hook, Product } from "./types";

const C = {
  // Brand colours, darkened where white text sits on them so every pair passes WCAG AA (≥ 4.5:1)
  blue: "#14b1ef",
  blueDark: "#0b75a8",
  teal: "#0b7d74",
  orange: "#fdaf40",
  red: "#c8102e",
  link: "#09608a",
  text: "#2b2b2b",
  muted: "#6b6b6b",
  bg: "#f3f6f8",
  card: "#ffffff",
  line: "#e4e9ed",
};
const FONT = "Arial, Helvetica, sans-serif";
const LOGO = "https://cdn.myshoptet.com/usr/www.svet-pokoju.cz/user/logos/logo-2.png";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Light inline formatting typed in the editor: **bold** and *italic*. The guards keep Ecomail merge tags
// (*|VOKATIV|*, *|IF:…|*) untouched: a marker never touches "|" and never sits next to a space on the inside.
const BOLD = /\*\*(?=\S)((?:[^*\n]|\*(?!\*))+?)(?<=\S)\*\*/g;
const ITALIC = /(?<![|*\w])\*(?=[^\s*|])([^*\n]+?)(?<=[^\s*|])\*(?![|*\w])/g;

/** Escaped text with **bold** → <strong>, *italic* → <em>. */
export function inline(s: string): string {
  return esc(s).replace(BOLD, "<strong>$1</strong>").replace(ITALIC, "<em>$1</em>");
}

/** Text with the formatting markers removed (subject, preheader, headings, buttons). */
export function plain(s: string): string {
  return s.replace(BOLD, "$1").replace(ITALIC, "$1");
}

// Content blocks: warm light background with a thin vertical "book spine" in the pastel logo colours.
// Clients without CSS gradients (Outlook) show the first colour as a solid spine.
const BLOCK_BG = "#fbf8f3";
const SPINE = ["#9fd9d3", "#f8e3a4", "#fad3a0", "#f2aaa5"];
function spine(reverse: boolean): string {
  const c = reverse ? [...SPINE].reverse() : SPINE;
  const grad = `linear-gradient(to bottom,${c[0]} 0,${c[0]} 25%,${c[1]} 25%,${c[1]} 50%,${c[2]} 50%,${c[2]} 75%,${c[3]} 75%,${c[3]} 100%)`;
  return `<td width="4" bgcolor="${c[0]}" style="width:4px;background:${c[0]};background-image:${grad};border-radius:10px 0 0 10px;font-size:0;line-height:0">&nbsp;</td>`;
}

/** Plain text → paragraphs; a block of lines starting with "- " becomes a bulleted list. */
function paragraphs(text: string, style: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // a block may mix a lead sentence and bullet lines – group consecutive lines of the same type
      const runs: { list: boolean; lines: string[] }[] = [];
      for (const l of p.split("\n").map((x) => x.trim()).filter(Boolean)) {
        const list = /^[-–•]\s+/.test(l);
        const last = runs[runs.length - 1];
        if (last && last.list === list) last.lines.push(l);
        else runs.push({ list, lines: [l] });
      }
      return runs
        .map((r) =>
          r.list
            ? `<ul style="margin:0 0 14px;padding-left:20px;${style}">${r.lines.map((l) => `<li style="margin:0 0 6px">${inline(l.replace(/^[-–•]\s+/, ""))}</li>`).join("")}</ul>`
            : `<p style="margin:0 0 14px;${style}">${r.lines.map(inline).join("<br>")}</p>`,
        )
        .join("");
    })
    .join("");
}

function slug(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "newsletter";
}

function track(url: string, campaign: string, content: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("svet-pokoju.cz")) return url;
    u.searchParams.set("utm_source", "ecomail");
    u.searchParams.set("utm_medium", "email");
    u.searchParams.set("utm_campaign", slug(campaign));
    u.searchParams.set("utm_content", content);
    return u.toString();
  } catch {
    return url;
  }
}

const fmt = (n: number) => `${n.toLocaleString("cs-CZ").replace(/ /g, " ")} Kč`;

function button(text: string, href: string, color = C.orange, textColor = C.text): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr><td style="border-radius:6px;background:${color}">
<a class="btn" href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;font-weight:bold;color:${textColor};text-decoration:none;border-radius:6px">${esc(plain(text))}</a>
</td></tr></table>`;
}

function productCard(p: Product, blurb: string, badge: string, campaign: string): string {
  const href = track(p.url, campaign, `produkt-${p.id}`);
  const price = p.priceOriginal
    ? `<span style="color:${C.red};font-weight:bold;font-size:18px">${fmt(p.price)}</span> <span style="color:${C.muted};text-decoration:line-through;font-size:13px">${fmt(p.priceOriginal)}</span>`
    : `<span style="color:${C.text};font-weight:bold;font-size:18px">${fmt(p.price)}</span>`;
  const badgeHtml = badge
    ? `<span style="display:inline-block;background:${p.discountPct ? C.red : C.teal};color:#fff;font-size:13px;font-weight:bold;padding:3px 8px;border-radius:4px;margin-bottom:8px">${esc(badge)}</span><br>`
    : "";
  return `<div class="col" style="display:inline-block;vertical-align:top;width:100%;max-width:262px;margin:0 5px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border:1px solid ${C.line};border-radius:8px">
<tr><td style="padding:12px 12px 0" align="center"><a class="img" href="${esc(href)}"><img src="${esc(p.image)}" width="238" alt="${esc(p.name)}" style="display:block;width:100%;max-width:238px;height:auto;border:0;border-radius:6px"></a></td></tr>
<tr><td style="padding:12px 14px 16px;font-family:${FONT};text-align:left">
${badgeHtml}<a class="lnk" href="${esc(href)}" style="color:${C.text};text-decoration:none;font-size:15px;font-weight:bold;line-height:1.35">${esc(p.name)}</a>
<p style="margin:8px 0 10px;color:${C.muted};font-size:14px;line-height:1.5">${inline(blurb)}</p>
<p style="margin:0 0 12px">${price}</p>
<a class="btn" href="${esc(href)}" style="display:inline-block;padding:9px 16px;background:${C.blueDark};color:#fff;font-size:14px;font-weight:bold;text-decoration:none;border-radius:5px">Zobrazit produkt</a>
</td></tr></table></div>`;
}

/** Links to pages that build trust and answer practical questions (who we are, delivery, buying advice). */
const TRUST_PAGES: [string, string][] = [
  ["/o-nas/", "O nás"],
  ["/jak-se-zbozi-ke-me-dostane/", "Doprava a doručení"],
  ["/pruvodce-nakupem/", "Průvodce nákupem"],
  ["/zakazkova-vyroba-nabytku-pro-deti/", "Zakázková výroba"],
];
function trustLinks(env: Env, campaign: string): string {
  return `<span style="display:inline-block;margin:6px 0 12px">${TRUST_PAGES.map(
    ([path, label]) => `<a class="flk" href="${esc(track(env.SHOP_URL + path, campaign, "paticka"))}" style="color:${C.link}">${label}</a>`,
  ).join(" · ")}</span><br>`;
}

/** Personal sign-off (photo + name + role) – a strong trust signal; shown only when configured in wrangler vars. */
function signature(env: Env): string {
  const name = env.SIGNATURE_NAME?.trim();
  if (!name) return "";
  const role = env.SIGNATURE_ROLE?.trim();
  const photo = env.SIGNATURE_PHOTO?.trim();
  // Centred and stacked: photo above, text below
  const img = photo
    ? `<tr><td align="center" style="padding-bottom:10px"><img src="${esc(photo)}" width="72" height="72" alt="${esc(name)}" style="display:block;margin:0 auto;width:72px;height:72px;border-radius:50%;border:0;object-fit:cover"></td></tr>`
    : "";
  return `<tr><td class="px" align="center" style="padding:0 32px 28px;font-family:${FONT};text-align:center"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">${img}
<tr><td align="center" style="font-size:15px;line-height:1.45;color:${C.text};text-align:center">S láskou<br><strong>${esc(name)}</strong>${role ? `<br><span style="color:${C.muted};font-size:14px">${esc(role)}</span>` : ""}</td></tr></table></td></tr>`;
}

/** Sample name shown in the app preview instead of the Ecomail merge tag. */
const PREVIEW_NAME = "Ondřeji";

/** "Dobrý den," → greeting by first name in the vocative, with a fallback for contacts without a name. */
function greet(intro: string, preview: boolean, tykani: boolean): string {
  const m = intro.match(/^\s*(Dobrý den|Ahoj|Milí rodiče|Dobrý večer)\s*,?\s*/i);
  const word = m?.[1] ?? (tykani ? "Ahoj" : "Dobrý den");
  const rest = m ? intro.slice(m[0].length) : intro;
  const line = preview ? `${word}, ${PREVIEW_NAME},` : `*|IF:VOKATIV|*${word}, *|VOKATIV|*,*|ELSE:|*${word},*|END:IF|*`;
  return `${line}\n\n${rest.replace(/^\n+/, "")}`;
}

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

/** Opening hook blocks. Each returns table rows for its place in the layout. */
function hookTop(h: Hook | undefined, text: string): string {
  if (h?.type !== "deadline") return "";
  return `<tr><td class="px" style="background:#fff3dc;padding:14px 32px;font-family:${FONT};text-align:center;color:#6b4200">
<div style="font-size:16px;font-weight:bold;line-height:1.4">⏰ ${esc(h.deadlineWhat ?? "")}: ${esc(h.deadline ?? "")}</div>${text ? `<div style="font-size:14px;line-height:1.5;margin-top:4px">${inline(text)}</div>` : ""}</td></tr>`;
}

function hookAboveHeadline(env: Env, h: Hook | undefined, text: string): string {
  const box = (inner: string, bg = "#f6f1fb", border = "#b9a2d6") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:${bg};border-radius:10px;border-left:4px solid ${border}"><tr><td style="padding:16px 18px;font-family:${FONT}">${inner}</td></tr></table>`;
  const label = (t: string) => `<div style="font-size:13px;font-weight:bold;color:${C.muted};margin:0 0 6px">${t}</div>`;
  switch (h?.type) {
    case "personal": {
      const name = env.SIGNATURE_NAME?.trim();
      if (!name) return "";
      const photo = env.SIGNATURE_PHOTO?.trim();
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>${
        photo ? `<td width="48" style="padding-right:12px;vertical-align:middle"><img src="${esc(photo)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:50%;border:0;object-fit:cover"></td>` : ""
      }<td style="vertical-align:middle;font-family:${FONT};font-size:14px;line-height:1.4;color:${C.muted}">Píše vám<br><strong style="color:${C.text};font-size:15px">${esc(name)}</strong></td></tr></table>`;
    }
    case "question":
      return box(
        `${label("Otázka, kterou jsem dostala")}<div style="font-size:18px;line-height:1.45;font-style:italic;color:${C.text}">„${esc(h.question ?? "")}“</div>${
          h.asker ? `<div style="font-size:14px;color:${C.muted};margin-top:6px">píše ${esc(h.asker)}</div>` : ""
        }${text ? `<div style="font-size:15px;color:${C.text};margin-top:10px">${inline(text)}</div>` : ""}`,
        "#eef9fe",
        C.blue,
      );
    case "review":
      return box(
        `<div style="font-size:20px;letter-spacing:2px;color:#e0a100;margin:0 0 6px" aria-label="${h.rating ?? 5} z 5 hvězdiček">${stars(h.rating ?? 5)}</div><div style="font-size:17px;line-height:1.5;font-style:italic;color:${C.text}">„${esc(h.quote ?? "")}“</div>${
          h.author ? `<div style="font-size:14px;color:${C.muted};margin-top:6px">${esc(h.author)}</div>` : ""
        }`,
        "#fff9e8",
        "#e0a100",
      );
    case "story":
      return text ? box(`${label("🌙 Malá pohádka na úvod")}<div style="font-size:16px;line-height:1.6;font-style:italic;color:${C.text}">${inline(text)}</div>`) : "";
    default:
      return "";
  }
}

function hookAfterIntro(h: Hook | undefined, campaign: string): string {
  if (h?.type !== "age" || !h.ages?.length) return "";
  const btns = h.ages
    .map(
      (a) =>
        `<a class="btn" href="${esc(track(a.url, campaign, "vek"))}" style="display:inline-block;margin:4px;padding:10px 16px;border:2px solid ${C.blue};border-radius:99px;color:${C.blueDark};font-family:${FONT};font-size:15px;font-weight:bold;text-decoration:none">${esc(a.label)}</a>`,
    )
    .join("");
  return `<tr><td class="px" style="padding:4px 32px 14px;font-family:${FONT};text-align:center"><div style="font-size:16px;font-weight:bold;color:${C.text};margin:0 0 6px">Kolik je vašemu dítěti?</div>${btns}</td></tr>`;
}

/** Renders the final e-mail HTML (Ecomail merge tags *|WEBVERSION|*, *|UNSUB|* and *|VOKATIV|* included).
 *  `preview` shows a sample name instead of merge tags (app preview only). */
export function renderEmail(env: Env, s: EmailState, opts: { preview?: boolean } = {}): string {
  const { copy, campaign } = s;
  const hookText = (copy.hook ?? "").trim();
  const intro = s.greetByName ? greet(copy.intro, Boolean(opts.preview), /^\s*ahoj/i.test(copy.intro)) : copy.intro;
  const byId = new Map(s.products.map((p) => [p.id, p]));
  const cards = copy.products
    .map((pc) => {
      const p = byId.get(pc.id);
      return p ? productCard(p, pc.blurb, pc.badge, campaign) : "";
    })
    .join("");
  const heroUrl = track(copy.hero_cta_url || env.SHOP_URL, campaign, "hlavni-tlacitko");
  const footerUrl = track(copy.hero_cta_url || env.SHOP_URL, campaign, "zaver");
  const hero = s.heroImage
    ? `<tr><td style="padding:0"><a href="${esc(heroUrl)}"><img src="${esc(s.heroImage)}" width="600" alt="" style="display:block;width:100%;height:auto;border:0"></a></td></tr>`
    : "";
  const sections = copy.sections
    .filter((x) => x.title || x.text)
    .map(
      (x, i) => `<tr><td style="padding:8px 32px 8px;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr>${spine(i % 2 === 1)}<td bgcolor="${BLOCK_BG}" style="background:${BLOCK_BG};border-radius:0 10px 10px 0;padding:18px 22px">
<h3 style="margin:0 0 8px;font-size:17px;color:${C.text}">${esc(plain(x.title))}</h3>${paragraphs(x.text, `font-size:15px;line-height:1.55;color:${C.text}`)}${
        x.link_url
          ? `<p style="margin:0"><a class="lnk" href="${esc(track(x.link_url, campaign, "clanek"))}" style="color:${C.link};font-size:15px;font-weight:bold">${esc(x.link_text || "Přečtěte si víc")} →</a></p>`
          : ""
      }
</td></tr></table></td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(plain(s.subject || copy.headline))}</title>
<style>.btn:hover{opacity:.85;text-decoration:underline!important}.lnk:hover,.flk:hover{text-decoration:underline!important;color:${C.blueDark}!important}.img:hover img{opacity:.9}
@media (max-width:620px){.col{max-width:100%!important;margin:0 0 16px!important}.px{padding-left:18px!important;padding-right:18px!important}}</style></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.bg}">${esc(plain(copy.preheader))}${"&#8203;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="padding:0 8px 10px;font-family:${FONT};font-size:13px;color:${C.muted};text-align:right"><a class="flk" href="*|WEBVERSION|*" style="color:${C.link}">Zobrazit e-mail v prohlížeči</a></td></tr>
<tr><td style="background:${C.card};border-radius:10px 10px 0 0;padding:20px 32px 8px;text-align:center">
<a href="${esc(track(env.SHOP_URL, campaign, "logo"))}"><img src="${LOGO}" width="200" alt="${esc(env.SHOP_NAME)}" style="display:inline-block;width:200px;height:auto;border:0"></a></td></tr>
<tr><td style="background:${C.card}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${hookTop(s.hook, hookText)}
${hero}
<tr><td class="px" style="padding:28px 32px 6px;font-family:${FONT}">
${hookAboveHeadline(env, s.hook, hookText)}
<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;color:${C.text}">${esc(plain(copy.headline))}</h1>
${paragraphs(intro, `font-size:16px;line-height:1.6;color:${C.text}`)}
</td></tr>
${hookAfterIntro(s.hook, campaign)}
<tr><td style="padding:6px 32px 26px">${button(copy.hero_cta_text || "Prohlédnout nabídku", heroUrl)}</td></tr>
${sections}
<tr><td style="padding:18px 20px 4px;text-align:center;font-size:0">${cards}</td></tr>
<tr><td class="px" style="padding:10px 32px 4px;font-family:${FONT}">${paragraphs(copy.closing, `font-size:16px;line-height:1.6;color:${C.text}`)}</td></tr>
<tr><td style="padding:6px 32px 32px">${button(copy.cta_text || "Na e-shop", footerUrl, C.teal, "#ffffff")}</td></tr>
${signature(env)}
</table></td></tr>
<tr><td style="background:#e9eff3;border-radius:0 0 10px 10px;padding:22px 32px;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted};text-align:center">
<strong style="color:${C.text}">${esc(env.SHOP_NAME)}</strong> · dětské pokojíčky, hračky a vše kolem nich<br>
<a class="flk" href="mailto:info@svet-pokoju.cz" style="color:${C.link}">info@svet-pokoju.cz</a> · <a class="flk" href="tel:+420770330792" style="color:${C.link}">+420 770 330 792</a> · <a class="flk" href="${esc(track(env.SHOP_URL, campaign, "paticka"))}" style="color:${C.link}">www.svet-pokoju.cz</a><br><br>
${trustLinks(env, campaign)}
Tento e-mail jste obdrželi, protože jste se přihlásili k odběru novinek.<br>
<a class="flk" href="*|UNSUB|*" style="color:${C.link}">Odhlásit se z odběru</a>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
