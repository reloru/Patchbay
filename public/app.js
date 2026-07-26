"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let MODELS = [];
let authRequired = false;
let currentModel = null;
const uploads = {}; // fieldName -> [{url, name, isImage}]

const PW_KEY = "pruna_app_password";
const getPw = () => localStorage.getItem(PW_KEY) || "";
const setPw = (v) => localStorage.setItem(PW_KEY, v);
const clearPw = () => localStorage.removeItem(PW_KEY);

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// API helper (adds password header, handles 401)
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (authRequired && getPw()) headers["x-app-password"] = getPw();
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    clearPw();
    showGate("Session expired — enter the password again.");
    throw new Error("Unauthorized");
  }
  return res;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  let cfg;
  try {
    const res = await fetch("/api/config");
    cfg = await res.json();
  } catch (e) {
    document.body.innerHTML = "<p style='padding:24px'>Failed to load app config.</p>";
    return;
  }
  MODELS = cfg.models || [];
  authRequired = Boolean(cfg.authRequired);

  if (authRequired && !getPw()) {
    showGate();
  } else {
    startApp();
  }
}

function showGate(msg) {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (msg) {
    const el = $("gate-error");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
}

$("gate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("gate-input").value.trim();
  if (!v) return;
  setPw(v);
  $("gate").classList.add("hidden");
  startApp();
});

function startApp() {
  $("app").classList.remove("hidden");
  buildModelSelect();
  selectModel(MODELS[0].id);
  $("footer-note").textContent =
    "Generations are proxied through a Cloudflare Worker and not stored. Media is cached at most 30s.";
}

// ---------------------------------------------------------------------------
// Model select (grouped)
// ---------------------------------------------------------------------------
function buildModelSelect() {
  const sel = $("model-select");
  sel.innerHTML = "";
  const groups = {};
  for (const m of MODELS) {
    (groups[m.group] = groups[m.group] || []).push(m);
  }
  for (const [group, list] of Object.entries(groups)) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.addEventListener("change", () => selectModel(sel.value));
}

function selectModel(id) {
  currentModel = MODELS.find((m) => m.id === id);
  $("model-select").value = id;
  $("model-blurb").textContent = (currentModel.blurb || "") + " " + priceBlurb(currentModel);
  for (const k of Object.keys(uploads)) delete uploads[k];
  renderFields();
}

function priceBlurb(model) {
  const p = model.price;
  if (!p) return "";
  if (p.type === "flat") return `List price: ${fmtUsd(p.usd)} per image.`;
  if (p.type === "per_second") return `List price: ${fmtUsd(p.usd["720p"])}/s at 720p, ${fmtUsd(p.usd["1080p"])}/s at 1080p.`;
  return "List price: varies with your settings.";
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------
function renderFields() {
  const wrap = $("fields");
  wrap.innerHTML = "";
  for (const f of currentModel.fields) {
    wrap.appendChild(f.required ? renderRequired(f) : renderOptional(f));
  }
}

function inputControl(f) {
  // Returns the control element for a field's value.
  if (f.type === "textarea") {
    const t = document.createElement("textarea");
    t.dataset.field = f.name;
    if (f.default != null) t.value = f.default;
    return t;
  }
  if (f.type === "text") {
    const i = document.createElement("input");
    i.type = "text";
    i.dataset.field = f.name;
    if (f.default != null) i.value = f.default;
    return i;
  }
  if (f.type === "int" || f.type === "number") {
    const i = document.createElement("input");
    i.type = "number";
    i.dataset.field = f.name;
    if (f.min != null) i.min = f.min;
    if (f.max != null) i.max = f.max;
    if (f.step != null) i.step = f.step;
    else if (f.type === "int") i.step = 1;
    if (f.default != null) i.value = f.default;
    return i;
  }
  if (f.type === "bool") {
    const label = document.createElement("label");
    label.className = "checkline";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.dataset.field = f.name;
    const base = Boolean(f.default);
    c.checked = f.invert ? !base : base; // show the user-facing (possibly inverted) value
    label.appendChild(c);
    const span = document.createElement("span");
    span.textContent = "On";
    label.appendChild(span);
    c.addEventListener("change", () => {
      span.textContent = c.checked ? "On" : "Off";
    });
    return label;
  }
  if (f.type === "enum") {
    const s = document.createElement("select");
    s.dataset.field = f.name;
    for (const o of f.options) {
      const opt = document.createElement("option");
      opt.value = String(o.value);
      opt.textContent = o.label;
      if (o.value === f.default) opt.selected = true;
      s.appendChild(opt);
    }
    return s;
  }
  if (f.type === "image") {
    return imageControl(f);
  }
  const i = document.createElement("input");
  i.type = "text";
  i.dataset.field = f.name;
  return i;
}

function imageControl(f) {
  const box = document.createElement("div");
  const maxItems = f.maxItems || 1;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = f.accept || "image/*";
  input.multiple = maxItems > 1;

  const thumbs = document.createElement("div");
  thumbs.className = "thumbs";

  uploads[f.name] = uploads[f.name] || [];

  const redraw = () => {
    thumbs.innerHTML = "";
    for (let idx = 0; idx < uploads[f.name].length; idx++) {
      const u = uploads[f.name][idx];
      const t = document.createElement("div");
      t.className = "thumb" + (u.isImage ? "" : " file");
      if (u.isImage) {
        const img = document.createElement("img");
        img.src = u.preview || "";
        t.appendChild(img);
      } else {
        t.textContent = "📎";
      }
      const rm = document.createElement("button");
      rm.className = "rm";
      rm.type = "button";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.addEventListener("click", () => {
        uploads[f.name].splice(idx, 1);
        redraw();
      });
      t.appendChild(rm);
      thumbs.appendChild(t);
    }
  };

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.value = "";
    for (const file of files) {
      if (uploads[f.name].length >= maxItems) break;
      const placeholder = { url: null, name: file.name, isImage: file.type.startsWith("image/"), preview: null, uploading: true };
      if (placeholder.isImage) placeholder.preview = URL.createObjectURL(file);
      uploads[f.name].push(placeholder);
      redraw();
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await api("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || "Upload failed");
        placeholder.url = data.url;
        placeholder.uploading = false;
      } catch (e) {
        const i = uploads[f.name].indexOf(placeholder);
        if (i >= 0) uploads[f.name].splice(i, 1);
        redraw();
        setStatus("Upload failed: " + e.message, "err");
      }
    }
  });

  box.appendChild(input);
  box.appendChild(thumbs);
  const hint = document.createElement("p");
  hint.className = "help";
  hint.textContent = maxItems > 1 ? `Up to ${maxItems} file(s).` : "One file.";
  box.appendChild(hint);
  redraw();
  return box;
}

function renderRequired(f) {
  const field = document.createElement("label");
  field.className = "field";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = f.label + " *";
  field.appendChild(label);
  field.appendChild(inputControl(f));
  if (f.help) {
    const h = document.createElement("p");
    h.className = "help";
    h.textContent = f.help;
    field.appendChild(h);
  }
  return field;
}

function defaultText(f) {
  if (f.defaultLabel) return f.defaultLabel;
  if (f.type === "bool") {
    const base = Boolean(f.default);
    return (f.invert ? !base : base) ? "On" : "Off";
  }
  if (f.type === "enum") {
    const o = f.options.find((o) => o.value === f.default);
    return o ? o.label : String(f.default);
  }
  if (f.type === "int" || f.type === "number") {
    return f.default == null ? null : String(f.default);
  }
  if (f.type === "text" || f.type === "textarea") {
    return f.default ? String(f.default) : "none";
  }
  return null;
}

function renderOptional(f) {
  const opt = document.createElement("div");
  opt.className = "opt disabled";

  const head = document.createElement("label");
  head.className = "opt-head";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.dataset.enable = f.name;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = f.label;
  const tag = document.createElement("span");
  tag.className = "tag";
  const dflt = defaultText(f);
  tag.textContent = dflt != null ? "Default: " + dflt : "customize";
  head.appendChild(cb);
  head.appendChild(name);
  head.appendChild(tag);

  const body = document.createElement("div");
  body.className = "opt-body";
  body.appendChild(inputControl(f));
  if (f.help) {
    const h = document.createElement("p");
    h.className = "help";
    h.textContent = f.help;
    body.appendChild(h);
  }

  cb.addEventListener("change", () => {
    opt.classList.toggle("disabled", !cb.checked);
  });

  opt.appendChild(head);
  opt.appendChild(body);
  return opt;
}

// ---------------------------------------------------------------------------
// Collect input payload
// ---------------------------------------------------------------------------
function readControlValue(f, scope) {
  if (f.type === "image") {
    const list = (uploads[f.name] || []).filter((u) => u.url);
    if (list.length === 0) return undefined;
    const urls = list.map((u) => u.url);
    return f.asArray ? urls : urls[0];
  }
  const el = scope.querySelector(`[data-field="${f.name}"]`);
  if (!el) return undefined;
  if (f.type === "bool") return f.invert ? !el.checked : el.checked;
  if (f.type === "int") {
    if (el.value === "") return undefined;
    return parseInt(el.value, 10);
  }
  if (f.type === "number") {
    if (el.value === "") return undefined;
    return parseFloat(el.value);
  }
  if (f.type === "enum") {
    const match = f.options.find((o) => String(o.value) === el.value);
    return match ? match.value : el.value;
  }
  // text / textarea
  return el.value;
}

function buildInput() {
  const form = $("gen-form");
  const input = {};
  const missing = [];

  for (const f of currentModel.fields) {
    if (f.required) {
      const v = readControlValue(f, form);
      if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
        missing.push(f.label);
        continue;
      }
      input[f.name] = v;
    } else {
      // Include only if the override toggle is on.
      const enable = form.querySelector(`[data-enable="${f.name}"]`);
      const on = f.type === "image" ? (uploads[f.name] || []).some((u) => u.url) && enable && enable.checked : enable && enable.checked;
      if (!on) continue;
      const v = readControlValue(f, form);
      if (v !== undefined && v !== "") input[f.name] = v;
    }
  }
  return { input, missing };
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
$("gen-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { input, missing } = buildInput();
  if (missing.length) {
    setStatus("Please fill required field(s): " + missing.join(", "), "err");
    return;
  }

  const btn = $("generate-btn");
  btn.disabled = true;
  $("result").innerHTML = "";
  const kind = currentModel.kind;
  const started = Date.now();
  setStatus("Submitting…", "load");

  try {
    const urls = await runGeneration(currentModel.id, input, kind, (state, secs) => {
      setStatus(`${cap(state)}… ${secs}s elapsed`, "load");
    });
    if (!urls.length) throw new Error("No output URL returned.");
    showResult(urls, kind);
    const secs = Math.round((Date.now() - started) / 1000);
    const cost = addSpend(currentModel, input, urls.length);
    setStatus(`Done in ${secs}s.${cost ? " " + cost : ""}`, "ok");
  } catch (err) {
    setStatus("Error: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("reset-btn").addEventListener("click", () => {
  for (const k of Object.keys(uploads)) delete uploads[k];
  renderFields();
  setStatus("", "hide");
});

async function runGeneration(model, input, kind, onProgress) {
  const startRes = await api("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, sync: kind === "image" }),
  });
  const data = await startRes.json();
  if (!startRes.ok) throw new Error(data.error || data.message || `HTTP ${startRes.status}`);

  if (data.status === "succeeded" && data.generation_url) return asUrlList(data.generation_url);
  if (data.status === "failed" || data.status === "error") {
    throw new Error(data.message || data.error || "Generation failed.");
  }

  let id = data.id;
  if (!id && data.get_url) {
    const m = String(data.get_url).match(/status\/([^/?#]+)/);
    if (m) id = m[1];
  }
  if (!id) throw new Error("No job id returned. Response: " + JSON.stringify(data).slice(0, 240));

  const started = Date.now();
  // Heavy video jobs (VACE especially) can run well past 10 minutes.
  const maxMs = (kind === "video" ? 30 : 10) * 60 * 1000;
  while (true) {
    await sleep(2500);
    if (Date.now() - started > maxMs) {
      throw new Error(
        `Timed out after ${Math.round(maxMs / 60000)} min. Try a lower resolution, ` +
          "fewer frames/steps, or a faster speed mode."
      );
    }
    const sRes = await api("/api/status?id=" + encodeURIComponent(id));
    const s = await sRes.json();
    if (!sRes.ok) throw new Error(s.error || `Status HTTP ${sRes.status}`);
    if (s.status === "succeeded") return asUrlList(s.generation_url || s.output || s.output_url);
    if (s.status === "failed" || s.status === "error" || s.status === "canceled") {
      throw new Error(s.message || s.error || "Generation failed.");
    }
    onProgress(s.status || "processing", Math.round((Date.now() - started) / 1000));
  }
}

// Pruna returns generation_url as a plain string for some models and as an
// array for others (flux-2-klein-4b, wan-image-small with num_outputs > 1).
function asUrlList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean);
}

function resultUrl(prunaUrl) {
  // <img>/<video>/<a download> can't send headers, so pass the password as a
  // query param when the gate is on.
  let u = "/api/result?url=" + encodeURIComponent(prunaUrl);
  if (authRequired && getPw()) u += "&pw=" + encodeURIComponent(getPw());
  return u;
}

function showResult(prunaUrls, kind) {
  const box = $("result");
  box.innerHTML = "";
  prunaUrls.forEach((prunaUrl, i) => {
    const proxied = resultUrl(prunaUrl);
    const item = document.createElement("div");
    item.className = "result-item";
    if (kind === "video") {
      const v = document.createElement("video");
      v.src = proxied;
      v.controls = true;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      item.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = proxied;
      item.appendChild(img);
    }
    const dl = document.createElement("a");
    dl.className = "download";
    dl.href = proxied;
    dl.download = kind === "video" ? "pruna-output.mp4" : "pruna-output";
    dl.textContent = prunaUrls.length > 1 ? `⬇ Download #${i + 1}` : "⬇ Download";
    item.appendChild(dl);
    box.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Cost estimate
//
// Pruna's API has no balance/credits endpoint, so the real remaining balance
// can only be seen on dashboard.pruna.ai. What we can do is estimate what each
// run costs from Pruna's published list prices and keep a running total for
// this browser session (in memory only — nothing is stored).
// ---------------------------------------------------------------------------
let sessionSpend = 0;
let sessionRuns = 0;

function estimateCost(model, input, outputCount) {
  const p = model.price;
  if (!p || p.type === "variable") return null;
  if (p.type === "flat") {
    const n = Number(input.num_outputs) || outputCount || 1;
    return p.usd * n;
  }
  if (p.type === "per_second") {
    const rate = p.usd[input.resolution || "720p"];
    if (rate == null) return null;
    const secs = Number(input.duration);
    if (!secs) return null; // length comes from the source video — unknown here
    return rate * secs;
  }
  return null;
}

function fmtUsd(v) {
  return "$" + (v < 0.01 ? v.toFixed(4) : v.toFixed(3)).replace(/0+$/, "").replace(/\.$/, "");
}

function addSpend(model, input, outputCount) {
  const cost = estimateCost(model, input, outputCount);
  sessionRuns++;
  if (cost != null) sessionSpend += cost;
  updateSpendBar();
  return cost == null ? "Cost: varies by settings." : `Est. ${fmtUsd(cost)}.`;
}

function updateSpendBar() {
  const el = $("spend");
  if (!el) return;
  el.textContent =
    `Session estimate: ${fmtUsd(sessionSpend)} over ${sessionRuns} run${sessionRuns === 1 ? "" : "s"}` +
    " · estimate only, not a balance";
  el.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(msg, mode) {
  const el = $("status");
  if (mode === "hide" || !msg) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.className = "status" + (mode === "err" ? " err" : mode === "ok" ? " ok" : "");
  el.innerHTML = "";
  if (mode === "load") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    el.appendChild(sp);
  }
  const t = document.createElement("span");
  t.textContent = msg;
  el.appendChild(t);
  el.classList.remove("hidden");
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

boot();
