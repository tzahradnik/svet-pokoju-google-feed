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
};

/* ---------- helpers ---------- */
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtPrice = (n) => `${Number(n).toLocaleString("cs-CZ")} Kč`;

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
  st.sources = def ? [...def.sources] : st.kind === "custom" ? st.sources : [];
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

async function generate(withFeedback = false) {
  const req = {
    kind: st.kind,
    id: st.kind === "topic" ? $("#topic").value : st.kind === "special" ? $("#special").value : undefined,
    customName: $("#custom-name").value,
    sources: st.sources,
    productCount: Number($("#count").value) || 4,
    brief: $("#brief-text").value,
    tone: $("#tone").value,
    pinnedProducts: st.pinned,
  };
  if (withFeedback && st.email) {
    collectEditor();
    req.previous = st.email;
    req.feedback = $("#feedback").value;
  }
  busy(true, withFeedback ? "AI přepisuje e-mail podle poznámky…" : "Vybírám produkty a píšu návrh e-mailu…");
  try {
    const { state, candidates } = await api("/api/generate", { method: "POST", body: req });
    st.email = state;
    st.candidates = candidates;
    $("#feedback").value = "";
    fillEditor();
    await refreshPreview();
    $("#editor").scrollIntoView({ behavior: "smooth" });
    toast("Návrh je hotový – můžete ho upravit.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(false);
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

function renderSectionsEdit() {
  $("#sections-edit").innerHTML = st.email.copy.sections
    .map(
      (s, i) => `<div class="item" data-sec="${i}">
      <div class="item-head"><span class="name">Blok ${i + 1}</span><div class="tools"><button class="btn small" type="button" data-del-sec="${i}">Odebrat</button></div></div>
      <label>Nadpis<input data-sec-title="${i}" value="${escapeHtml(s.title)}"></label>
      <label>Text<textarea rows="3" data-sec-text="${i}">${escapeHtml(s.text)}</textarea></label>
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
  st.email.copy.sections.push({ title: "", text: "" });
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
            <button class="btn small" type="button" data-hero="${i}" title="Použít fotku jako úvodní obrázek">🖼</button>
            <button class="btn small" type="button" data-del-prod="${i}" title="Odebrat">×</button>
          </div>
        </div>
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
  } else if (b.dataset.hero !== undefined) {
    const p = productById(list[Number(b.dataset.hero)].id);
    $("#hero-image").value = p?.image || "";
  }
  renderProductsEdit();
  schedulePreview();
});

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
  copy.sections = copy.sections.map((s, i) => ({
    title: $(`[data-sec-title="${i}"]`)?.value ?? s.title,
    text: $(`[data-sec-text="${i}"]`)?.value ?? s.text,
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
    const html = await api("/api/render", { method: "POST", body: st.email });
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
    box.innerHTML = lists.length
      ? lists.map((l) => `<label><input type="checkbox" value="${l.id}" ${String(l.id) === def ? "checked" : ""}> ${escapeHtml(l.name)}</label>`).join("")
      : "<small>V Ecomailu nejsou žádné seznamy kontaktů.</small>";
  } catch (err) {
    box.innerHTML = `<small class="error">${escapeHtml(err.message)}</small>`;
  }
}

async function finalHtml() {
  collectEditor();
  return api("/api/render", { method: "POST", body: st.email });
}

$("#push").addEventListener("click", async () => {
  collectEditor();
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

/* ---------- start ---------- */
async function start() {
  st.session = await api("/api/session");
  st.plan = await api("/api/plan");
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");

  const warn = [];
  if (!st.session.ai) warn.push("chybí klíč pro AI");
  if (!st.session.ecomail) warn.push("Ecomail není napojený");
  $("#status").innerHTML = warn.length ? `<span class="warn">⚠ ${warn.join(" · ")}</span>` : "Vše napojeno";

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
