// Frontend of the newsletter tool (vanilla JS, no build step).
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const MONTHS = ["Led", "Úno", "Bře", "Dub", "Kvě", "Čvn", "Čvc", "Srp", "Zář", "Říj", "Lis", "Pro"];
const STORE_KEY = "nl-draft-v1";

const st = {
  plan: null,
  session: null,
  kind: "topic",
  sources: [],
  pinned: [],
  candidates: [],
  email: null, // EmailState
  lists: null, // Ecomail lists, or error message
  site: null, // catalogue: categories, blog, pages, new products, plan coverage
  category: null, // chosen {path, name} in the "Kategorie a značky" tab
  catFilter: "",
  gallery: {}, // product id -> photo URLs from the product page
};

/* ---------- helpers ---------- */
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtPrice = (n) => `${Number(n).toLocaleString("cs-CZ")} Kč`;
const fold = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const KIND_LABEL = { brand: "značka", collection: "kolekce", room: "místnost", category: "kategorie" };
const THUMB = (file) => `https://www.svet-pokoju.cz/user/shop/related/${file}`;

/** Lightweight autocomplete: items(q) → [{label, sub, img, value}], pick(value). Keyboard: ↑ ↓ Enter Esc. */
function autocomplete(input, list, items, pick) {
  let current = [];
  let active = -1;
  const close = () => { list.classList.add("hidden"); active = -1; };
  const render = () => {
    current = items(input.value.trim());
    if (!current.length) return close();
    list.innerHTML = current
      .map((it, i) => `<button type="button" role="option" class="ac-item ${i === active ? "active" : ""}" data-i="${i}">${it.img ? `<img src="${escapeHtml(it.img)}" alt="" loading="lazy">` : ""}<span><span>${escapeHtml(it.label)}</span>${it.sub ? `<small>${escapeHtml(it.sub)}</small>` : ""}</span></button>`)
      .join("");
    list.classList.remove("hidden");
  };
  input.addEventListener("input", () => { active = -1; render(); });
  input.addEventListener("focus", () => render());
  input.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + current.length) % current.length;
      render();
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(current[active].value);
      close();
    } else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener("click", (e) => {
    const i = e.target.closest("[data-i]")?.dataset.i;
    if (i === undefined) return;
    pick(current[Number(i)].value);
    close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
}

function matchScore(name, q) {
  const n = fold(name);
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.every((w) => n.includes(w))) return -1;
  return (n.startsWith(words[0]) ? 0 : 10) + n.length / 100;
}

const catItem = (c) => ({ label: c.name, sub: `${KIND_LABEL[c.kind]} · ${c.path}${c.products ? ` · ${c.products} produktů` : ""}`, value: c });

function categoryItems(q, kinds) {
  if (!st.site) return [];
  const pool = st.site.categories.filter((c) => !kinds || kinds.includes(c.kind));
  if (q.length < 2) return kinds ? pool.slice(0, 40).map(catItem) : [];
  return pool
    .map((c) => ({ c, s: matchScore(`${c.name} ${c.brand || ""}`, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, 12)
    .map(({ c }) => catItem(c));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("Přihlášení vypršelo");
  }
  const type = res.headers.get("Content-Type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Chyba ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), err ? 7000 : 3500);
}

function busy(on, text = "Pracuji…") {
  $("#overlay-text").textContent = text;
  $("#overlay").classList.toggle("hidden", !on);
}

function saveLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ email: st.email, candidates: st.candidates }));
  } catch { /* storage unavailable – ignore */ }
}

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
}

/* ---------- auth ---------- */
function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#password").focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#password").value } });
    $("#password").value = "";
    await start();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ---------- brief ---------- */
function currentDef() {
  if (st.kind === "topic") return st.plan.topics.find((t) => t.id === $("#topic").value);
  if (st.kind === "special") return st.plan.specials.find((t) => t.id === $("#special").value);
  return null;
}

function setKind(kind) {
  st.kind = kind;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  $$(".kind-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== kind));
  onDefChange();
}

function onDefChange() {
  const def = currentDef();
  st.sources = def ? [...def.sources] : st.kind === "category" ? (st.category ? [st.category.path] : []) : st.kind === "custom" ? st.sources : [];
  renderSources();
  renderTopicInfo();
}

function renderTopicInfo() {
  const box = $("#topic-info");
  const t = st.kind === "topic" ? currentDef() : null;
  if (!t) return (box.innerHTML = "");
  const now = new Date().getMonth() + 1;
  const bars = t.seasonality.length
    ? `<div class="bars">${t.seasonality.map((s) => `<span title="${MONTHS[s.month - 1]}: ${s.index} %" class="${t.peak_months.includes(s.month) ? "peak" : ""} ${s.month === now ? "now" : ""}" style="height:${Math.max(8, Math.min(100, s.index - 30))}%"></span>`).join("")}</div>
       <div class="bar-labels">${t.seasonality.map((s) => `<span>${MONTHS[s.month - 1][0]}</span>`).join("")}</div>`
    : "";
  box.innerHTML = `
    <div><strong>${t.volume ? `${t.volume.toLocaleString("cs-CZ")} hledání měsíčně` : "Téma mimo analýzu klíčových slov"}</strong>${t.peak_months.length ? ` · sezóna: ${t.peak_months.map((m) => MONTHS[m - 1]).join(", ")}` : ""}</div>
    <div>${escapeHtml(t.angle)}</div>
    ${t.keywords.length ? `<div>Lidé hledají: ${escapeHtml(t.keywords.slice(0, 6).join(", "))}</div>` : ""}
    ${bars}`;
}

function renderRecommended() {
  const now = new Date().getMonth() + 1;
  const next = (now % 12) + 1;
  const recs = st.plan.topics.filter((t) => t.peak_months.includes(now) || t.peak_months.includes(next)).slice(0, 6);
  $("#recommended").innerHTML = recs.length
    ? `Doporučeno teď: ${recs.map((t) => `<span class="chip season" data-topic="${t.id}">${escapeHtml(t.name)}</span>`).join(" ")}`
    : "";
}

$("#recommended").addEventListener("click", (e) => {
  const id = e.target.closest("[data-topic]")?.dataset.topic;
  if (!id) return;
  setKind("topic");
  $("#topic").value = id;
  onDefChange();
});

function sourceLabel(s) {
  return s.startsWith("vyhledavani:") ? `hledat: ${s.slice(12)}` : s;
}

function renderSources() {
  $("#sources").innerHTML = st.sources.length
    ? st.sources.map((s, i) => `<span class="chip">${escapeHtml(sourceLabel(s))}<button type="button" data-i="${i}" aria-label="Odebrat">×</button></span>`).join("")
    : `<small>Zatím žádný zdroj produktů.</small>`;
}

$("#sources").addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  st.sources.splice(Number(i), 1);
  renderSources();
});

$("#add-source").addEventListener("click", () => {
  let v = $("#source-input").value.trim();
  if (!v) return;
  try {
    if (v.startsWith("http")) v = new URL(v).pathname;
  } catch { /* keep as typed */ }
  st.sources.push(v.startsWith("/") ? v : `vyhledavani:${v}`);
  $("#source-input").value = "";
  renderSources();
});

autocomplete($("#source-input"), $("#source-list"), (q) => categoryItems(q), (c) => {
  if (!st.sources.includes(c.path)) st.sources.push(c.path);
  $("#source-input").value = "";
  renderSources();
});

/* ---------- category / brand / room tab ---------- */
const CAT_KINDS = { "": null, brand: ["brand", "collection"], room: ["room"] };
$("#cat-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  st.catFilter = b.dataset.k;
  $$("#cat-filter button").forEach((x) => x.classList.toggle("active", x === b));
  $("#cat-input").value = "";
  $("#cat-input").focus();
});
autocomplete($("#cat-input"), $("#cat-list"), (q) => categoryItems(q, CAT_KINDS[st.catFilter]), (c) => chooseCategory(c));

function chooseCategory(c) {
  st.category = { path: c.path, name: c.name };
  $("#cat-input").value = c.name;
  $("#cat-chosen").innerHTML = `<div><strong>${escapeHtml(c.name)}</strong> · ${KIND_LABEL[c.kind] || "kategorie"}</div><div><a href="${escapeHtml(st.session.shopUrl + c.path)}" target="_blank" rel="noopener">${escapeHtml(c.path)}</a>${c.products ? ` · ${c.products} produktů s touto hlavní kategorií` : ""}</div>`;
  onDefChange();
}

/* ---------- product index (instant search across the whole catalogue) ---------- */
let productIndex = null;
let productIndexLoading = null;
function loadProductIndex() {
  productIndexLoading ||= fetch("/api/catalog/products")
    .then((r) => r.json())
    .then((d) => (productIndex = d.items.map(([path, name, img]) => ({ path, name, img, f: fold(name) }))))
    .catch(() => (productIndex = []));
  return productIndexLoading;
}
$("#search-input").addEventListener("focus", () => loadProductIndex().then(() => $("#search-input").value && $("#search-input").dispatchEvent(new Event("input"))), { once: true });
autocomplete(
  $("#search-input"),
  $("#search-list"),
  (q) => {
    if (!productIndex || q.length < 2) return [];
    const words = fold(q).split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of productIndex) {
      if (words.every((w) => p.f.includes(w))) out.push(p);
      if (out.length >= 60) break;
    }
    return out
      .sort((a, b) => (a.f.startsWith(words[0]) ? 0 : 1) - (b.f.startsWith(words[0]) ? 0 : 1) || a.f.length - b.f.length)
      .slice(0, 10)
      .map((p) => ({ label: p.name, sub: p.path.split("/")[1], img: THUMB(p.img), value: p }));
  },
  (p) => pinFromCatalog(p.path),
);

async function pinFromCatalog(path) {
  try {
    busy(true, "Načítám produkt z e-shopu…");
    const { product } = await api(`/api/product?url=${encodeURIComponent(path)}`);
    const { images, ...p } = product;
    st.gallery[p.id] = images;
    if (!st.pinned.some((x) => x.id === p.id)) st.pinned.push(p);
    renderPinned();
    $("#search-input").value = "";
    toast(`Přidáno do e-mailu: ${p.name}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(false);
  }
}

function miniCard(p, action, label) {
  return `<div class="mini">
    <img src="${escapeHtml(p.image)}" alt="" loading="lazy">
    <div>${escapeHtml(p.name)}</div>
    <div class="price">${fmtPrice(p.price)}${p.priceOriginal ? `<span class="old">${fmtPrice(p.priceOriginal)}</span>` : ""}</div>
    <small>${escapeHtml(p.availability)}</small>
    <button class="btn small" type="button" data-action="${action}" data-id="${p.id}">${label}</button>
  </div>`;
}

let lastSearch = [];
async function doSearch() {
  const q = $("#search-input").value.trim();
  if (q.length < 2) return;
  try {
    const { products } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    lastSearch = products;
    $("#search-results").innerHTML = products.length ? products.map((p) => miniCard(p, "pin", "Přidat do e-mailu")).join("") : "<small>Nic nenalezeno.</small>";
  } catch (err) {
    toast(err.message, true);
  }
}
$("#search-btn").addEventListener("click", doSearch);
$("#search-input").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), doSearch()));

$("#search-results").addEventListener("click", (e) => {
  const id = e.target.dataset.id;
  const p = lastSearch.find((x) => x.id === id);
  if (!p || st.pinned.some((x) => x.id === id)) return;
  st.pinned.push(p);
  renderPinned();
});

function renderPinned() {
  $("#pinned").innerHTML = st.pinned.map((p, i) => `<span class="chip">📌 ${escapeHtml(p.name)}<button type="button" data-i="${i}" aria-label="Odebrat">×</button></span>`).join("");
}
$("#pinned").addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  st.pinned.splice(Number(i), 1);
  renderPinned();
});

/* ---------- generation progress ---------- */
const GEN_TIMES_KEY = "nl-gen-times";
// What the generator follows while the AI writes (mirrors src/ai.ts and src/hlas-znacky.md)
const GEN_TIPS = [
  "Píše Tereza v první osobě, vřele a konkrétně, podle příběhu ze stránky O nás.",
  "Produkty vybírá jen z aktuální nabídky e-shopu, ceny a dostupnost bere přímo z webu.",
  "Popisky produktů staví jen na názvu, ceně a dostupnosti, žádné vymyšlené vlastnosti.",
  "Tipy odpovídají na otázky, které lidé opravdu hledají (analýza klíčových slov).",
  "Odkazuje jen na existující články z blogu a Průvodce nákupem.",
  "Bez dlouhých pomlček, bez znaku „&“ a bez reklamních frází typu „Objevte…“.",
  "Nevymýšlí slevy, kódy, termíny doručení ani historky o rodině.",
  "Předmět do 60 znaků ve třech variantách, preheader ho doplňuje a neopakuje.",
];

function genEstimate() {
  try {
    const t = JSON.parse(localStorage.getItem(GEN_TIMES_KEY) || "[]").filter((x) => x > 3000);
    if (t.length) return [...t].sort((a, b) => a - b)[Math.floor(t.length / 2)];
  } catch { /* storage unavailable */ }
  return 35000;
}
function genRemember(ms) {
  try {
    const t = JSON.parse(localStorage.getItem(GEN_TIMES_KEY) || "[]");
    localStorage.setItem(GEN_TIMES_KEY, JSON.stringify([...t, ms].slice(-6)));
  } catch { /* storage unavailable */ }
}
const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.max(1, Math.round(ms / 1000))} s`);

function startProgress(title) {
  const est = genEstimate();
  const t0 = Date.now();
  const g = { pct: 0, aiStart: null, aiPct: 0, chars: 0, expected: 0, done: false };
  $("#gen-title").textContent = title;
  $("#gen-steps").innerHTML = "";
  $("#gen").classList.remove("hidden");
  let tip = Math.floor(Math.random() * GEN_TIPS.length);
  const showTip = () => ($("#gen-tip").textContent = "Pravidlo: " + GEN_TIPS[tip++ % GEN_TIPS.length]);
  showTip();
  const tipTimer = setInterval(showTip, 5000);

  const paint = () => {
    const t = Date.now() - t0;
    let pct;
    let left;
    if (g.done) {
      pct = 100;
      left = 0;
    } else if (g.aiStart !== null && g.chars > 0) {
      pct = g.aiPct + (95 - g.aiPct) * Math.min(g.chars / g.expected, 1);
      const rate = g.chars / Math.max(Date.now() - g.aiStart, 1); // characters per ms
      left = Math.max(g.expected - g.chars, 0) / rate + 1500;
    } else {
      pct = Math.min(60, (t / est) * 75);
      left = est - t;
    }
    g.pct = Math.max(g.pct, pct);
    $("#gen-fill").style.width = g.pct.toFixed(1) + "%";
    $(".gen-bar").setAttribute("aria-valuenow", String(Math.round(g.pct)));
    $("#gen-pct").textContent = Math.round(g.pct) + " %";
    $("#gen-eta").textContent = g.done ? "hotovo" : left > 1500 ? `zbývá asi ${secs(left)} · uplynulo ${secs(t)}` : `ještě chvilku · uplynulo ${secs(t)}`;
  };
  const timer = setInterval(paint, 250);
  paint();

  const step = (text) => {
    document.querySelectorAll("#gen-steps li.now").forEach((li) => li.classList.remove("now"));
    $("#gen-steps").insertAdjacentHTML("beforeend", `<li class="now">${escapeHtml(text)}</li>`);
    $("#gen-steps").lastElementChild.scrollIntoView({ block: "nearest" });
  };
  return {
    event(ev) {
      if (ev.type === "step") step(ev.text);
      if (ev.type === "ai") {
        if (g.aiStart === null) {
          g.aiStart = Date.now();
          g.aiPct = Math.max(g.pct, 20);
        }
        g.chars = ev.chars;
        g.expected = Math.max(ev.expected, ev.chars + 200);
        const li = $("#gen-steps li.now");
        if (li) {
          li.dataset.base = li.dataset.base || li.textContent;
          li.textContent = `${li.dataset.base} Napsáno ${Math.min(99, Math.round((ev.chars / g.expected) * 100))} %.`;
        }
      }
    },
    finish(ok) {
      g.done = ok;
      paint();
      document.querySelectorAll("#gen-steps li.now").forEach((li) => li.classList.remove("now"));
      if (ok) genRemember(Date.now() - t0);
      clearInterval(timer);
      clearInterval(tipTimer);
      setTimeout(() => $("#gen").classList.add("hidden"), ok ? 500 : 0);
    },
  };
}

/** POST /api/generate with streamed progress (one JSON object per line). */
async function generateStream(req, prog) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(req),
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Přihlášení vypršelo");
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Chyba ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "done") return ev.result;
      if (ev.type === "error") throw new Error(ev.error);
      prog.event(ev);
    }
    if (done) throw new Error("Spojení se serverem se přerušilo, zkuste to prosím znovu.");
  }
}

async function generate(withFeedback = false) {
  const req = {
    kind: st.kind,
    id: st.kind === "topic" ? $("#topic").value : st.kind === "special" ? $("#special").value : undefined,
    customName: $("#custom-name").value,
    category: st.kind === "category" ? st.category : undefined,
    sources: st.sources,
    productCount: Number($("#count").value) || 4,
    brief: $("#brief-text").value,
    tone: $("#tone").value,
    pinnedProducts: st.pinned,
    hook: readHook("hk"),
    greetByName: $("#greet-name").checked,
  };
  if (withFeedback && st.email) {
    collectEditor();
    req.previous = st.email;
    req.feedback = $("#feedback").value;
    req.hook = st.email.hook ?? { type: "none" };
    req.greetByName = Boolean(st.email.greetByName);
  }
  const prog = startProgress(withFeedback ? "Přepisuji e-mail podle poznámky" : "Píšu návrh e-mailu");
  let ok = false;
  try {
    const { state, candidates } = await generateStream(req, prog);
    ok = true;
    prog.finish(true);
    st.email = state;
    st.candidates = candidates;
    $("#feedback").value = "";
    fillEditor();
    await refreshPreview();
    $("#editor").scrollIntoView({ behavior: "smooth" });
    toast("Návrh je hotový, můžete ho upravit.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (!ok) prog.finish(false);
  }
}
$("#generate").addEventListener("click", () => generate(false));
$("#regenerate").addEventListener("click", () => generate(true));

/* ---------- editor ---------- */
const FIELDS = [
  ["#preheader", "preheader"],
  ["#headline", "headline"],
  ["#intro", "intro"],
  ["#hero-cta-text", "hero_cta_text"],
  ["#hero-cta-url", "hero_cta_url"],
  ["#closing", "closing"],
  ["#cta-text", "cta_text"],
];

function fillEditor() {
  const { copy } = st.email;
  $("#editor").classList.remove("hidden");
  $("#approve").classList.remove("hidden");
  $("#subject").value = st.email.subject;
  $("#hero-image").value = st.email.heroImage || "";
  FIELDS.forEach(([sel, key]) => ($(sel).value = copy[key] ?? ""));
  $("#campaign-title").value = `${st.email.campaign} – ${new Date().toLocaleDateString("cs-CZ")}`;
  renderVariants();
  renderSectionsEdit();
  renderProductsEdit();
  renderHookEdit();
}

function renderVariants() {
  const subj = $("#subject").value;
  $("#subject-variants").innerHTML = st.email.copy.subject_variants
    .map((v, i) => `<span class="chip ${v === subj ? "active" : ""}" data-i="${i}">${escapeHtml(v)}</span>`)
    .join("");
}
$("#subject-variants").addEventListener("click", (e) => {
  const i = e.target.closest("[data-i]")?.dataset.i;
  if (i === undefined) return;
  $("#subject").value = st.email.copy.subject_variants[Number(i)];
  renderVariants();
  schedulePreview();
});

/** Blog articles and guides from the catalogue (+ the one already set, if it is not among them). */
function articleOptions(selected = "") {
  const shop = st.session.shopUrl;
  const items = st.site ? [...st.site.blog.map((a) => ["Blog", a]), ...st.site.pages.filter((p) => p.role).map((p) => ["Stránka", p])] : [];
  const opts = items.map(([g, a]) => [shop + a.path, `${g}: ${a.name}`]);
  if (selected && !opts.some(([u]) => u === selected)) opts.unshift([selected, selected]);
  return `<option value="">– bez odkazu –</option>${opts.map(([u, l]) => `<option value="${escapeHtml(u)}" ${u === selected ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}`;
}

function renderSectionsEdit() {
  $("#sections-edit").innerHTML = st.email.copy.sections
    .map(
      (s, i) => `<div class="item" data-sec="${i}">
      <div class="item-head"><span class="name">Blok ${i + 1}</span><div class="tools"><button class="btn small" type="button" data-del-sec="${i}">Odebrat</button></div></div>
      <label>Nadpis<input data-sec-title="${i}" value="${escapeHtml(s.title)}"></label>
      <label>Text<textarea rows="3" data-sec-text="${i}">${escapeHtml(s.text)}</textarea></label>
      <div class="grid2">
        <label>Odkaz „čtěte víc“<select data-sec-link="${i}">${articleOptions(s.link_url)}</select></label>
        <label>Text odkazu<input data-sec-linktext="${i}" value="${escapeHtml(s.link_text || "")}" placeholder="Přečtěte si víc"></label>
      </div>
    </div>`,
    )
    .join("");
}

$("#sections-edit").addEventListener("click", (e) => {
  const i = e.target.dataset.delSec;
  if (i === undefined) return;
  collectEditor();
  st.email.copy.sections.splice(Number(i), 1);
  renderSectionsEdit();
  schedulePreview();
});
$("#add-section").addEventListener("click", () => {
  collectEditor();
  st.email.copy.sections.push({ title: "", text: "", link_url: "", link_text: "" });
  renderSectionsEdit();
});

const productById = (id) => st.email.products.find((p) => p.id === id) || st.candidates.find((p) => p.id === id);

function renderProductsEdit() {
  st.email.copy.products = st.email.copy.products.filter((pc) => productById(pc.id));
  const list = st.email.copy.products;
  $("#products-edit").innerHTML = list
    .map((pc, i) => {
      const p = productById(pc.id);
      if (!p) return "";
      return `<div class="item">
        <div class="item-head">
          <img src="${escapeHtml(p.image)}" alt="">
          <span class="name">${escapeHtml(p.name)}<br><small>${fmtPrice(p.price)}${p.priceOriginal ? ` (původně ${fmtPrice(p.priceOriginal)})` : ""} · ${escapeHtml(p.availability)}</small></span>
          <div class="tools">
            <button class="btn small" type="button" data-move="${i}" data-dir="-1" title="Posunout nahoru" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="btn small" type="button" data-move="${i}" data-dir="1" title="Posunout dolů" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
            <button class="btn small" type="button" data-gallery="${i}" title="Vybrat jinou fotku z galerie produktu">Fotky</button>
            <button class="btn small" type="button" data-del-prod="${i}" title="Odebrat">×</button>
          </div>
        </div>
        <div class="gallery hidden" data-gal="${escapeHtml(p.id)}"></div>
        <label>Popisek<textarea rows="2" data-blurb="${i}">${escapeHtml(pc.blurb)}</textarea></label>
        <label>Odznak<input data-badge="${i}" value="${escapeHtml(pc.badge)}" placeholder="např. Sleva 15 %"></label>
      </div>`;
    })
    .join("");
  const used = new Set(list.map((p) => p.id));
  $("#candidates").innerHTML = st.candidates
    .filter((p) => !used.has(p.id))
    .map((p) => miniCard(p, "add", "Přidat"))
    .join("");
}

$("#products-edit").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  collectEditor();
  const list = st.email.copy.products;
  if (b.dataset.move !== undefined) {
    const i = Number(b.dataset.move);
    const j = i + Number(b.dataset.dir);
    [list[i], list[j]] = [list[j], list[i]];
  } else if (b.dataset.delProd !== undefined) {
    list.splice(Number(b.dataset.delProd), 1);
  } else if (b.dataset.gallery !== undefined) {
    return toggleGallery(list[Number(b.dataset.gallery)].id);
  } else if (b.dataset.useImg !== undefined) {
    const url = b.dataset.useImg;
    if (b.dataset.as === "hero") {
      $("#hero-image").value = url;
      toast("Fotka nastavena jako úvodní obrázek e-mailu.");
    } else {
      [...st.email.products, ...st.candidates].forEach((x) => x.id === b.dataset.pid && (x.image = url));
    }
  }
  renderProductsEdit();
  schedulePreview();
  if (b.dataset.useImg !== undefined) toggleGallery(b.dataset.pid); // keep the gallery open after picking
});

async function toggleGallery(id) {
  const box = $(`[data-gal="${CSS.escape(id)}"]`);
  if (!box) return;
  if (!box.classList.contains("hidden")) return box.classList.add("hidden");
  const p = productById(id);
  box.classList.remove("hidden");
  if (!st.gallery[id]) {
    box.innerHTML = "<small>Načítám fotky z e-shopu…</small>";
    try {
      st.gallery[id] = (await api(`/api/product?url=${encodeURIComponent(p.url)}`)).product.images;
    } catch (err) {
      box.innerHTML = `<small class="error">${escapeHtml(err.message)}</small>`;
      return;
    }
  }
  const imgs = st.gallery[id];
  box.innerHTML = imgs.length
    ? `<small>Vyberte fotku pro kartu produktu, nebo ji použijte jako úvodní obrázek e-mailu (fotky z interiéru působí nejlépe).</small><div class="gal-grid">${imgs
        .map(
          (u) => `<figure class="${u === p.image ? "current" : ""}"><img src="${escapeHtml(u)}" alt="" loading="lazy"><figcaption>
            <button class="btn small" type="button" data-use-img="${escapeHtml(u)}" data-pid="${escapeHtml(id)}">Produkt</button>
            <button class="btn small" type="button" data-use-img="${escapeHtml(u)}" data-pid="${escapeHtml(id)}" data-as="hero">Úvod</button></figcaption></figure>`,
        )
        .join("")}</div>`
    : "<small>Produkt nemá další fotky.</small>";
}

$("#candidates").addEventListener("click", (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  collectEditor();
  const p = st.candidates.find((x) => x.id === id);
  if (!st.email.products.some((x) => x.id === id)) st.email.products.push(p);
  st.email.copy.products.push({ id, blurb: "", badge: p.discountPct ? `Sleva ${p.discountPct} %` : "" });
  renderProductsEdit();
  schedulePreview();
});

function collectEditor() {
  if (!st.email) return;
  const { copy } = st.email;
  st.email.subject = $("#subject").value;
  st.email.heroImage = $("#hero-image").value.trim();
  FIELDS.forEach(([sel, key]) => (copy[key] = $(sel).value));
  if ($("#hke-type").value) {
    st.email.hook = readHook("hke");
    st.email.greetByName = $("#hke-greet").checked;
    copy.hook = $("#hke-text").value;
  }
  copy.sections = copy.sections.map((s, i) => ({
    title: $(`[data-sec-title="${i}"]`)?.value ?? s.title,
    text: $(`[data-sec-text="${i}"]`)?.value ?? s.text,
    link_url: $(`[data-sec-link="${i}"]`)?.value ?? s.link_url ?? "",
    link_text: $(`[data-sec-linktext="${i}"]`)?.value ?? s.link_text ?? "",
  }));
  copy.products = copy.products.map((p, i) => ({
    id: p.id,
    blurb: $(`[data-blurb="${i}"]`)?.value ?? p.blurb,
    badge: $(`[data-badge="${i}"]`)?.value ?? p.badge,
  }));
  // keep product data for every product in the e-mail; drop copy entries without product data
  const known = new Map([...st.candidates, ...st.email.products].map((p) => [p.id, p]));
  copy.products = copy.products.filter((p) => known.has(p.id));
  const ids = new Set(copy.products.map((p) => p.id));
  st.email.products = [...ids].map((id) => known.get(id));
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 450);
}

async function refreshPreview() {
  if (!st.email) return;
  collectEditor();
  saveLocal();
  try {
    const html = await api("/api/render?preview", { method: "POST", body: st.email });
    const frame = $("#preview");
    frame.srcdoc = html;
    frame.classList.remove("hidden");
    $("#preview-empty").classList.add("hidden");
  } catch (err) {
    toast(err.message, true);
  }
}

$("#editor").addEventListener("input", (e) => {
  if (e.target.id === "feedback") return;
  if (e.target.id === "subject") renderVariants();
  schedulePreview();
});

$$(".seg button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".seg button").forEach((x) => x.classList.toggle("active", x === b));
    $("#preview").style.width = b.dataset.w;
  }),
);

/* ---------- opening hook ---------- */
// Places in the e-mail layout, top to bottom; "slot" places exist only when a hook uses them
const HOOK_LAYOUT = [
  ["top", "Pruh s termínem", true],
  ["hero", "Úvodní fotka"],
  ["above", "Háček nad nadpisem", true],
  ["headline", "Nadpis"],
  ["intro", "Úvod (Dobrý den, …)"],
  ["after", "Výběr pod úvodem", true],
  ["button", "Hlavní tlačítko"],
  ["tips", "Tipy"],
  ["products", "Produkty"],
  ["sign", "Podpis Terezy"],
];
const ex = {
  box: (inner, bg = "#f6f1fb", border = "#b9a2d6") => `<div style="background:${bg};border-left:4px solid ${border};border-radius:8px;padding:10px 12px">${inner}</div>`,
  label: (t) => `<div style="font-size:11px;font-weight:700;color:#5b6b76;margin-bottom:4px">${t}</div>`,
};
const HOOKS = {
  none: { label: "Bez háčku", place: [], where: "E-mail začíná rovnou nadpisem a úvodem.", example: "" },
  personal: {
    label: "Osobní dopis od Terezy",
    place: ["above", "intro"],
    where: "Nad nadpisem fotka a jméno Terezy, úvod je napsaný jako osobní zpráva.",
    example: `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><img src="/img/podpis-tereza.jpg" alt="" width="34" height="34" style="border-radius:50%"><div style="font-size:12px;color:#5b6b76;line-height:1.3">Píše vám<br><b style="color:#22303a">Tereza ze Světa Pokojů</b></div></div><b>Jak vybrat první velkou postel</b><p>Dobrý den, poslední týdny se mě často ptáte, kdy je ten pravý čas přejít z postýlky do velké postele. Sepsala jsem, co se nám osvědčilo.</p>`,
  },
  question: {
    label: "Otázka od zákazníka",
    place: ["above", "tips"],
    where: "Rámeček se skutečnou otázkou nad nadpisem. AI na ni odpoví v prvním tipu.",
    example: ex.box(`${ex.label("Otázka, kterou jsem dostala")}<i style="font-size:14px">„Od kolika let může dítě spát nahoře na patrové posteli?“</i><div style="font-size:12px;color:#5b6b76;margin-top:4px">píše Jana z Brna</div><div style="margin-top:6px">Odpověď jsem sepsala hned níž.</div>`, "#eef9fe", "#14b1ef"),
    fields: [
      ["question", "Otázka (skutečná, jak ji zákazník napsal)", "textarea", "Od kolika let může dítě spát nahoře na patrové posteli?"],
      ["asker", "Kdo se ptá (bez příjmení)", "input", "Jana z Brna"],
    ],
  },
  review: {
    label: "Recenze zákazníka",
    place: ["above"],
    where: "Rámeček s hvězdičkami a citací skutečné recenze nad nadpisem.",
    example: ex.box(`<div style="color:#e0a100;letter-spacing:2px">★★★★★</div><i style="font-size:14px">„Postel dorazila za tři dny, montáž zvládl manžel za hodinu a malá z ní nechce vylézt.“</i><div style="font-size:12px;color:#5b6b76;margin-top:4px">Petra, Olomouc</div>`, "#fff9e8", "#e0a100"),
    fields: [
      ["quote", "Text recenze (skutečný, beze změn)", "textarea", "Zkopírujte recenzi ze Shoptetu nebo Heureky"],
      ["author", "Autor (jméno, případně město)", "input", "Petra, Olomouc"],
      ["rating", "Hodnocení", "rating"],
    ],
  },
  deadline: {
    label: "Termín, který běží",
    place: ["top"],
    where: "Oranžový pruh úplně nahoře nad úvodní fotkou. AI připíše jednu větu, proč termín hlídat.",
    example: `<div style="background:#fff3dc;color:#6b4200;text-align:center;padding:10px;border-radius:6px"><b>⏰ Postel na míru pod stromeček: objednávky do 20. listopadu</b><div style="font-size:12px;margin-top:2px">Výroba trvá několik týdnů, ať to Ježíšek stihne.</div></div>`,
    fields: [
      ["deadlineWhat", "Čeho se termín týká", "input", "Postel na míru pod stromeček"],
      ["deadline", "Termín", "input", "objednávky do 20. listopadu"],
    ],
  },
  age: {
    label: "Výběr podle věku dítěte",
    place: ["after"],
    where: "Pod úvodem otázka „Kolik je vašemu dítěti?“ a tlačítka do kategorií. V Ecomailu pak uvidíte, kdo kam klikl.",
    example: `<div style="text-align:center"><b>Kolik je vašemu dítěti?</b><div style="margin-top:6px">${["0-2 roky", "3-6 let", "7+ let"].map((l) => `<span style="display:inline-block;margin:2px;padding:4px 10px;border:2px solid #14b1ef;border-radius:99px;color:#0e8fc3;font-weight:700;font-size:12px">${l}</span>`).join("")}</div></div>`,
    fields: [["ages", "Tlačítka (text a odkaz na kategorii)", "ages"]],
  },
  story: {
    label: "Mini pohádka",
    place: ["above"],
    where: "Krátká smyšlená pohádka kurzívou nad nadpisem, úvod na ni naváže. Píše ji AI.",
    example: ex.box(`${ex.label("🌙 Malá pohádka na úvod")}<i>Rytíř Matyáš se rozhodl, že už nebude spát v kolébce. „Rytíři přece spí v hradu,“ prohlásil a začal z polštářů stavět hradby…</i>`),
  },
  numbers: {
    label: "Slib v číslech",
    place: ["headline", "tips"],
    where: "Nadpis slíbí konkrétní počet rad a tipy ho přesně splní.",
    example: `<b style="font-size:15px">3 věci, na které myslet při výběru matrace</b><p>Dobrý den, matrace se kupuje na roky, tak ať je to dobrá volba…</p>`,
  },
};
const DEFAULT_AGES = [
  { label: "0-2 roky", url: "/kojenecke-zbozi/" },
  { label: "3-6 let", url: "/detske-postele/" },
  { label: "7+ let", url: "/postele-pro-mladez/" },
];

function hookOptions(selected) {
  return Object.entries(HOOKS).map(([k, h]) => `<option value="${k}"${k === selected ? " selected" : ""}>${escapeHtml(h.label)}</option>`).join("");
}

function hookFieldsHtml(prefix, hook) {
  const def = HOOKS[hook.type];
  if (!def?.fields) return "";
  return def.fields
    .map(([key, label, kind, ph]) => {
      const id = `${prefix}-${key}`;
      const val = escapeHtml(hook[key] ?? "");
      if (kind === "textarea") return `<label>${label}<textarea id="${id}" rows="2" placeholder="${escapeHtml(ph)}">${val}</textarea></label>`;
      if (kind === "rating") {
        const r = Number(hook.rating) || 5;
        return `<label>${label}<select id="${id}">${[5, 4, 3].map((n) => `<option value="${n}"${n === r ? " selected" : ""}>${"★".repeat(n)}${"☆".repeat(5 - n)}</option>`).join("")}</select></label>`;
      }
      if (kind === "ages") {
        const ages = hook.ages?.length ? hook.ages : DEFAULT_AGES;
        return `<div class="field"><span class="label">${label}</span>${ages
          .map((a, i) => `<div class="row age-row"><input id="${id}-l${i}" value="${escapeHtml(a.label)}" aria-label="Text tlačítka ${i + 1}"><input id="${id}-u${i}" value="${escapeHtml(a.url)}" aria-label="Odkaz tlačítka ${i + 1}"></div>`)
          .join("")}<small>Odkaz může být cesta na e-shopu (např. /detske-postele/) nebo celá adresa.</small></div>`;
      }
      return `<label>${label}<input id="${id}" value="${val}" placeholder="${escapeHtml(ph)}"></label>`;
    })
    .join("");
}

function readHook(prefix) {
  const type = $(`#${prefix}-type`)?.value || "none";
  const hook = { type };
  for (const [key, , kind] of HOOKS[type]?.fields ?? []) {
    if (kind === "ages") {
      hook.ages = [0, 1, 2, 3].map((i) => ({ label: $(`#${prefix}-ages-l${i}`)?.value.trim(), url: $(`#${prefix}-ages-u${i}`)?.value.trim() })).filter((a) => a.label && a.url);
    } else if (kind === "rating") hook.rating = Number($(`#${prefix}-${key}`)?.value) || 5;
    else hook[key] = $(`#${prefix}-${key}`)?.value.trim() ?? "";
  }
  return hook;
}

/** Schematic of the e-mail with the hook's place highlighted, plus a sample. */
function hookInfoHtml(type) {
  const h = HOOKS[type] ?? HOOKS.none;
  const rows = HOOK_LAYOUT.filter(([k, , slot]) => !slot || h.place.includes(k))
    .map(([k, label]) => `<li class="${h.place.includes(k) ? "hit" : ""}">${label}</li>`)
    .join("");
  return `<div class="hook-info-grid"><div><div class="hook-info-cap">Kde v e-mailu</div><ol class="hook-map">${rows}</ol></div>
<div><div class="hook-info-cap">${escapeHtml(h.label)}</div><p class="hook-where">${escapeHtml(h.where)}</p>${h.example ? `<div class="hook-ex">${h.example}</div>` : ""}</div></div>`;
}

function renderHookUi(prefix, hook) {
  $(`#${prefix}-fields`).innerHTML = hookFieldsHtml(prefix, hook);
  $(`#${prefix}-pop`).innerHTML = hookInfoHtml(hook.type);
}

// Info "i" button: hover, keyboard focus or click toggles the popover
$$(".hook-info").forEach((wrap) => {
  const btn = wrap.querySelector("button");
  const set = (on) => {
    wrap.classList.toggle("open", on);
    btn.setAttribute("aria-expanded", String(on));
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    set(!wrap.classList.contains("open"));
  });
  document.addEventListener("click", (e) => !wrap.contains(e.target) && set(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && set(false));
});

$("#hk-type").innerHTML = hookOptions("personal");
$("#hk-type").addEventListener("change", () => renderHookUi("hk", { type: $("#hk-type").value }));
renderHookUi("hk", { type: $("#hk-type").value });

function renderHookEdit() {
  const hook = st.email.hook ?? { type: "none" };
  $("#hke-type").innerHTML = hookOptions(hook.type);
  $("#hke-greet").checked = Boolean(st.email.greetByName);
  $("#hke-text").value = st.email.copy.hook ?? "";
  $("#hke-text-wrap").classList.toggle("hidden", !["question", "deadline", "story"].includes(hook.type));
  renderHookUi("hke", hook);
}
$("#hke-type").addEventListener("change", () => {
  collectEditor();
  renderHookEdit();
  schedulePreview();
});

/* ---------- approve ---------- */
async function loadLists() {
  const box = $("#lists");
  if (!st.session.ecomail) {
    box.innerHTML = `<small>Ecomail zatím není napojený (chybí API klíč). E-mail si můžete stáhnout jako HTML.</small>`;
    $("#push").disabled = true;
    return;
  }
  try {
    const { lists } = await api("/api/ecomail/lists");
    const def = String(st.session.sender.defaultListId || "");
    st.lists = lists;
    renderStatus();
    box.innerHTML = lists.length
      ? lists.map((l) => `<label><input type="checkbox" value="${l.id}" ${String(l.id) === def ? "checked" : ""}> ${escapeHtml(l.name)}</label>`).join("")
      : "<small>V Ecomailu nejsou žádné seznamy kontaktů.</small>";
  } catch (err) {
    st.lists = err.message;
    renderStatus();
    box.innerHTML = `<small class="error">${escapeHtml(err.message)}</small>`;
  }
}

async function finalHtml() {
  collectEditor();
  return api("/api/render", { method: "POST", body: st.email });
}

async function runLinkCheck() {
  collectEditor();
  const box = $("#link-results");
  box.innerHTML = "<small>Kontroluji odkazy…</small>";
  try {
    const { results, broken } = await api("/api/check-links", { method: "POST", body: st.email });
    const bad = results.filter((r) => !r.ok);
    box.innerHTML = broken
      ? `<p class="err">⚠ ${broken} z ${results.length} odkazů nefunguje:</p><ul class="lc">${bad.map((r) => `<li><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url.replace(/^https?:\/\/(www\.)?/, ""))}</a><br><small>${escapeHtml(r.note)}</small></li>`).join("")}</ul>`
      : `<p class="ok">✓ Všech ${results.length} odkazů funguje.</p>`;
    return bad;
  } catch (err) {
    box.innerHTML = `<p class="err">${escapeHtml(err.message)}</p>`;
    return null;
  }
}
$("#check-links").addEventListener("click", runLinkCheck);

$("#push").addEventListener("click", async () => {
  collectEditor();
  busy(true, "Kontroluji odkazy v e-mailu…");
  const bad = await runLinkCheck();
  busy(false);
  if (bad?.length && !confirm(`${bad.length} odkazů v e-mailu nefunguje (seznam je pod tlačítkem Zkontrolovat odkazy). Přesto vložit do Ecomailu?`)) return;
  const listIds = $$("#lists input:checked").map((i) => Number(i.value));
  const res = $("#push-result");
  res.className = "";
  res.textContent = "";
  if (!confirm(`Vložit e-mail „${st.email.subject}“ jako koncept kampaně do Ecomailu?`)) return;
  busy(true, "Vkládám koncept do Ecomailu…");
  try {
    const r = await api("/api/ecomail/draft", {
      method: "POST",
      body: {
        state: st.email,
        title: $("#campaign-title").value,
        listIds,
        fromName: $("#from-name").value,
        fromEmail: $("#from-email").value,
        replyTo: $("#reply-to").value,
      },
    });
    res.className = "ok";
    res.textContent = `Hotovo – koncept kampaně (ID ${r.id}) je v Ecomailu v sekci Kampaně. Zkontrolujte ho a odešlete.`;
  } catch (err) {
    res.className = "err";
    res.textContent = err.message;
  } finally {
    busy(false);
  }
});

$("#download").addEventListener("click", async () => {
  const html = await finalHtml();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = `${(st.email.campaign || "newsletter").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#copy-html").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(await finalHtml());
    toast("HTML zkopírováno do schránky.");
  } catch {
    toast("Kopírování se nepodařilo – použijte Stáhnout HTML.", true);
  }
});

/* ---------- connection status (hover / focus shows details) ---------- */
function renderStatus() {
  const s = st.session;
  const host = (() => { try { return new URL(s.shopUrl).hostname.replace(/^www\./, ""); } catch { return s.shopUrl || "e-shop"; } })();
  const lists = st.lists;
  const listName = Array.isArray(lists) ? lists.find((l) => String(l.id) === String(s.sender.defaultListId))?.name : "";
  // [ok | warn | off, label, detail]
  const rows = [
    [s.ai ? "ok" : "off", "AI copywriter", s.ai ? `Claude (${s.aiModel}) píše texty e-mailů` : "chybí API klíč Anthropic"],
    [s.ecomail ? "ok" : "off", "Ecomail API", !s.ecomail ? "chybí API klíč" : Array.isArray(lists) ? `připojeno, ${lists.length} ${lists.length === 1 ? "seznam" : lists.length < 5 ? "seznamy" : "seznamů"} kontaktů` : typeof lists === "string" ? `chyba: ${lists}` : "ověřuji…"],
    [s.sender.fromEmail ? "ok" : "warn", "Odesílatel", s.sender.fromEmail ? `${s.sender.fromName} <${s.sender.fromEmail}>` : "zatím nenastaven – čeká na ověření domény v Ecomailu"],
    [s.sender.defaultListId ? "ok" : "warn", "Výchozí seznam", s.sender.defaultListId ? listName || `ID ${s.sender.defaultListId}` : "nevybrán – seznam zaškrtnete při vložení"],
    ["ok", "Produkty", `načítají se živě z ${host}`],
    ["ok", "Publikační plán", `${s.planTopics} témat z analýzy klíčových slov`],
    [st.site ? "ok" : "warn", "Katalog ze sitemapy", st.site ? `${st.site.counts.products.toLocaleString("cs-CZ")} produktů, ${st.site.counts.categories} kategorií, ${st.site.counts.blog} článků · aktualizováno ${new Date(st.site.generated).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}` : "načítám…"],
    [s.signature ? "ok" : "warn", "Osobní podpis", s.signature || "nenastaven"],
  ];
  const core = s.ai && s.ecomail && typeof lists !== "string";
  const notes = rows.filter((r) => r[0] !== "ok").length;
  const btn = $("#status-btn");
  btn.className = `status-btn ${core ? "" : "warn"}`;
  btn.textContent = core ? `✓ Vše napojeno${notes ? ` · ${notes} upozornění` : ""}` : "⚠ Něco není napojené";
  const icon = { ok: "✓", warn: "!", off: "✕" };
  $("#status-pop").innerHTML = `<strong>Stav napojení</strong><ul>${rows
    .map(([k, label, detail]) => `<li class="${k}"><span class="ic" aria-hidden="true">${icon[k]}</span><span><b>${escapeHtml(label)}</b><br>${escapeHtml(detail)}</span></li>`)
    .join("")}</ul>`;
}
// Click toggles the panel too (touch devices have no hover)
$("#status-btn").addEventListener("click", () => {
  const open = $("#status").classList.toggle("open");
  $("#status-btn").setAttribute("aria-expanded", String(open));
  if (!open) $("#status-btn").blur(); // otherwise :focus-within keeps the panel visible
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#status")) { $("#status").classList.remove("open"); $("#status-btn").setAttribute("aria-expanded", "false"); }
});

/* ---------- changelog ---------- */
const TYPE_LABEL = { new: "Novinka", improve: "Vylepšení", fix: "Oprava" };
$("#changelog-open").addEventListener("click", async () => {
  const dlg = $("#changelog");
  dlg.showModal();
  try {
    const res = await fetch("/changelog.json", { cache: "no-cache" });
    const log = await res.json();
    $("#changelog-body").innerHTML = log
      .map(
        (day) => `<section class="cl-day"><h3>${new Date(day.date + "T12:00:00").toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" })}</h3><ul>${day.changes
          .map((c) => `<li><span class="cl-tag ${c.type}">${TYPE_LABEL[c.type] || c.type}</span> ${escapeHtml(c.text)}</li>`)
          .join("")}</ul></section>`,
      )
      .join("");
  } catch {
    $("#changelog-body").innerHTML = `<p class="error">Historii změn se nepodařilo načíst.</p>`;
  }
});
$("#changelog-close").addEventListener("click", () => $("#changelog").close());
$("#changelog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ---------- plan coverage ---------- */
$("#coverage-open").addEventListener("click", () => {
  $("#coverage").showModal();
  const s = st.site;
  if (!s) return ($("#coverage-body").innerHTML = `<p class="error">Katalog se nepodařilo načíst.</p>`);
  const c = s.coverage;
  $("#coverage-body").innerHTML = `
    <p class="hint">Porovnání témat z analýzy klíčových slov s kategoriemi e-shopu (podle sitemapy, aktualizováno ${new Date(s.generated).toLocaleString("cs-CZ")}).</p>
    <section class="cl-day"><h3>Témata bez vlastní kategorie na e-shopu</h3>
      ${c.topicsSearchOnly.length ? `<p class="hint">Lidé je hledají, ale produkty jdou najít jen vyhledáváním. Vlastní kategorie by pomohla e-mailům i SEO.</p><ul>${c.topicsSearchOnly.map((t) => `<li><strong>${escapeHtml(t.name)}</strong> · ${t.volume.toLocaleString("cs-CZ")} hledání měsíčně</li>`).join("")}</ul>` : "<p>Všechna témata mají kategorii.</p>"}
    </section>
    ${c.missingSources?.length ? `<section class="cl-day"><h3>Kategorie z plánu, které už na e-shopu nejsou</h3><ul>${c.missingSources.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></section>` : ""}
    <section class="cl-day"><h3>Kategorie, které v plánu chybí</h3>
      <p class="hint">Seřazeno podle počtu produktů s touto hlavní kategorií. Kliknutím připravíte e-mail.</p>
      <ul class="cov">${c.categoriesWithoutTopic.map((x) => `<li><button type="button" class="linkbtn" data-cov="${escapeHtml(x.path)}">${escapeHtml(x.name)}</button> <small>${x.products} produktů</small></li>`).join("")}</ul>
    </section>`;
});
$("#coverage-body").addEventListener("click", (e) => {
  const path = e.target.closest("[data-cov]")?.dataset.cov;
  const c = path && st.site.categories.find((x) => x.path === path);
  if (!c) return;
  $("#coverage").close();
  setKind("category");
  chooseCategory(c);
  $("#brief").scrollIntoView({ behavior: "smooth" });
});
$$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
$("#coverage").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ---------- start ---------- */
async function start() {
  st.session = await api("/api/session");
  st.plan = await api("/api/plan");
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");

  renderStatus();

  $("#topic").innerHTML = st.plan.topics
    .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}${t.volume ? ` (${t.volume.toLocaleString("cs-CZ")}/měs.)` : ""}</option>`)
    .join("");
  $("#special").innerHTML = st.plan.specials.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  $("#from-name").value = st.session.sender.fromName || "";
  $("#from-email").value = st.session.sender.fromEmail || "";
  $("#reply-to").value = st.session.sender.replyTo || "";
  renderRecommended();
  setKind("topic");
  loadLists();
  api("/api/site")
    .then((site) => {
      st.site = site;
      renderStatus();
      if (st.email) renderSectionsEdit();
    })
    .catch(() => renderStatus());

  const saved = loadLocal();
  if (saved?.email) {
    st.email = saved.email;
    st.candidates = saved.candidates || [];
    fillEditor();
    refreshPreview();
  }
}

$$(".tab").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind)));
$("#topic").addEventListener("change", onDefChange);
$("#special").addEventListener("change", onDefChange);

start().catch(() => showLogin());
