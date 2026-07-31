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
  initPromptLibrary();
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

// Reads a file as bare base64 (no data: prefix) for Workers AI inputs.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

function defaultSteps(model) {
  const f = model.fields.find((x) => x.name === "steps" || x.name === "num_steps");
  return f ? f.default : 0;
}

function priceBlurb(model) {
  const p = model.price;
  if (!p) return "";
  if (p.type === "cf_neurons") {
    // Show the cost of a default 1024x1024 run so the trade-off is visible up front.
    const n = estimateNeurons(model, { width: 1024, height: 1024, steps: defaultSteps(model) });
    if (n == null) return "Runs on Cloudflare Workers AI (free daily allowance).";
    const perDay = Math.floor(CF_FREE_NEURONS / n);
    return `Workers AI: ~${Math.round(n).toLocaleString()} neurons per 1024×1024 image — about ${perDay} free per day.`;
  }
  if (p.type === "cf_unpriced") return "Runs on Cloudflare Workers AI (no published rate).";
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
        if (f.asBase64) {
          // Workers AI takes the bytes inline; nothing is uploaded to Pruna.
          placeholder.url = await fileToBase64(file);
        } else {
          const fd = new FormData();
          fd.append("file", file);
          const res = await api("/api/upload", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok || !data.url) throw new Error(data.error || "Upload failed");
          placeholder.url = data.url;
        }
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

  // Workers AI returns finished images inline as data URIs (no job to poll).
  if (Array.isArray(data.images) && data.images.length) return data.images;
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
  // Workers AI results are already inline data URIs — nothing to proxy.
  if (prunaUrl.startsWith("data:")) return prunaUrl;
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
    item.appendChild(downloadButton(proxied, kind, i, prunaUrls.length));
    box.appendChild(item);
  });
}

function extFromType(type, kind) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  return map[(type || "").toLowerCase()] || (kind === "video" ? "mp4" : "jpg");
}

// Saving must never navigate the page. A plain <a download> sends iOS Safari to
// a full-screen file viewer with no way back, which strands the app. Instead we
// fetch the bytes, then hand them to the native share sheet ("Save Image" /
// "Save to Files") when available, or trigger a blob download everywhere else.
function downloadButton(proxiedUrl, kind, index, total) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "download";
  const idle = total > 1 ? `⬇ Save #${index + 1}` : "⬇ Save";
  btn.textContent = idle;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      const res = await fetch(proxiedUrl);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const ext = extFromType(blob.type, kind);
      const name = `pruna-${Date.now()}${total > 1 ? "-" + (index + 1) : ""}.${ext}`;
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (err) {
      if (err && err.name !== "AbortError") setStatus("Save failed: " + err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = idle;
    }
  });
  return btn;
}

// ---------------------------------------------------------------------------
// Prompt library
//
// Saved prompts live in this browser's localStorage only — they are never sent
// to the Worker or to Pruna. (The "don't store anything" rule was about
// generated media; these are your own notes, on your own device.)
// ---------------------------------------------------------------------------
const PROMPTS_KEY = "pruna_prompts";

function loadPrompts() {
  try {
    const v = JSON.parse(localStorage.getItem(PROMPTS_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function storePrompts(list) {
  localStorage.setItem(PROMPTS_KEY, JSON.stringify(list));
}

// The box a saved prompt should load into, for whichever model is selected.
function primaryPromptEl() {
  const form = $("gen-form");
  return (
    form.querySelector('[data-field="prompt"]') ||
    form.querySelector('[data-field="voice_script"]') ||
    form.querySelector('[data-field="instruction_prompt"]') ||
    form.querySelector("textarea")
  );
}

function refreshPromptSelect(keepValue) {
  const sel = $("prompt-select");
  const list = loadPrompts();
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = list.length ? "Saved prompts…" : "No saved prompts yet";
  sel.appendChild(ph);
  list.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = p.name;
    sel.appendChild(o);
  });
  if (keepValue != null && list[keepValue]) sel.value = String(keepValue);
}

function initPromptLibrary() {
  refreshPromptSelect();

  $("prompt-select").addEventListener("change", (e) => {
    const idx = e.target.value;
    if (idx === "") return;
    const p = loadPrompts()[Number(idx)];
    const el = primaryPromptEl();
    if (!p || !el) return;
    el.value = p.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus(`Loaded prompt "${p.name}".`, "ok");
  });

  $("prompt-save").addEventListener("click", () => {
    const el = primaryPromptEl();
    const text = el && el.value.trim();
    if (!text) {
      setStatus("Nothing to save — write a prompt first.", "err");
      return;
    }
    const suggested = text.length > 40 ? text.slice(0, 40).trim() + "…" : text;
    const name = (window.prompt("Save this prompt as:", suggested) || "").trim();
    if (!name) return;

    const list = loadPrompts();
    const existing = list.findIndex((p) => p.name === name);
    if (existing >= 0) {
      if (!window.confirm(`"${name}" already exists. Replace it?`)) return;
      list[existing].text = text;
    } else {
      list.push({ name, text });
    }
    storePrompts(list);
    refreshPromptSelect(existing >= 0 ? existing : list.length - 1);
    setStatus(`Saved prompt "${name}".`, "ok");
  });

  // "Improve" rewrites the prompt in place via a small chat model, keeping the
  // previous text so a second click can undo it.
  let preImprove = null;
  const improveBtn = $("prompt-improve");
  improveBtn.addEventListener("click", async () => {
    const el = primaryPromptEl();
    if (!el) return;

    if (preImprove !== null) {
      el.value = preImprove;
      preImprove = null;
      improveBtn.textContent = "✨ Improve";
      setStatus("Reverted to your original prompt.", "ok");
      return;
    }

    const text = el.value.trim();
    if (!text) {
      setStatus("Write a prompt first, then hit Improve.", "err");
      return;
    }

    improveBtn.disabled = true;
    improveBtn.textContent = "Improving…";
    try {
      const res = await api("/api/improve-prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text, kind: currentModel.kind }),
      });
      const data = await res.json();
      if (!res.ok || !data.prompt) throw new Error(data.error || `HTTP ${res.status}`);
      preImprove = text;
      el.value = data.prompt;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      improveBtn.textContent = "↩ Undo";
      setStatus("Prompt improved — click Undo to revert.", "ok");
    } catch (e) {
      setStatus("Improve failed: " + e.message, "err");
    } finally {
      improveBtn.disabled = false;
    }
  });

  // A new prompt from any other source invalidates the undo buffer.
  $("prompt-select").addEventListener("change", () => {
    preImprove = null;
    improveBtn.textContent = "✨ Improve";
  });

  $("prompt-del").addEventListener("click", () => {
    const sel = $("prompt-select");
    if (sel.value === "") {
      setStatus("Pick a saved prompt to delete.", "err");
      return;
    }
    const list = loadPrompts();
    const p = list[Number(sel.value)];
    if (!p || !window.confirm(`Delete saved prompt "${p.name}"?`)) return;
    list.splice(Number(sel.value), 1);
    storePrompts(list);
    refreshPromptSelect();
    setStatus(`Deleted prompt "${p.name}".`, "ok");
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
let sessionNeurons = 0;
const CF_FREE_NEURONS = 10000; // Workers AI free allowance per day, resets 00:00 UTC

// Neurons for one Workers AI run, from Cloudflare's published per-model rates.
function estimateNeurons(model, input) {
  const p = model.price;
  if (!p || p.type !== "cf_neurons") return null;

  const w = Number(input.width) || 1024;
  const h = Number(input.height) || 1024;
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  const steps = Number(input.steps ?? input.num_steps) || 0;
  const refs = Array.isArray(input.input_images) ? input.input_images.length : 0;

  if (p.perFirstMp != null) {
    const mp = (w * h) / (1024 * 1024);
    return p.perFirstMp + Math.max(0, mp - 1) * p.perExtraMp + refs * (p.perInputMp || 0);
  }
  if (p.perOutputTilePerStep != null) {
    // flux-2-dev bills per tile *per step*, so steps dominate the cost.
    const s = steps || 1;
    return s * (tiles * p.perOutputTilePerStep + refs * tiles * (p.perInputTilePerStep || 0));
  }
  if (p.perOutputTile != null) {
    return tiles * p.perOutputTile + refs * tiles * (p.perInputTile || 0);
  }
  if (p.perTile != null) {
    return tiles * p.perTile + steps * (p.perStep || 0);
  }
  return null;
}

function estimateCost(model, input, outputCount) {
  const p = model.price;
  if (!p || p.type === "variable" || p.type === "cf_neurons" || p.type === "cf_unpriced") return null;
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
  sessionRuns++;

  const neurons = estimateNeurons(model, input);
  if (neurons != null) {
    sessionNeurons += neurons;
    updateSpendBar();
    const pct = Math.round((neurons / CF_FREE_NEURONS) * 100);
    return `Est. ~${Math.round(neurons).toLocaleString()} neurons (~${pct || "<1"}% of the daily free allowance).`;
  }
  if (model.price && model.price.type === "cf_unpriced") {
    updateSpendBar();
    return "Cloudflare does not publish a rate for this model.";
  }

  const cost = estimateCost(model, input, outputCount);
  if (cost != null) sessionSpend += cost;
  updateSpendBar();
  return cost == null ? "Cost: varies by settings." : `Est. ${fmtUsd(cost)}.`;
}

function updateSpendBar() {
  const el = $("spend");
  if (!el) return;
  const parts = [];
  if (sessionSpend > 0) parts.push(`Pruna ~${fmtUsd(sessionSpend)}`);
  if (sessionNeurons > 0) {
    const pct = Math.round((sessionNeurons / CF_FREE_NEURONS) * 100);
    parts.push(`Workers AI ~${Math.round(sessionNeurons).toLocaleString()} neurons (~${pct}% of today's free 10,000)`);
  }
  if (!parts.length) parts.push("no billable runs yet");
  el.textContent =
    `Session estimate: ${parts.join(" · ")} over ${sessionRuns} run${sessionRuns === 1 ? "" : "s"} · estimates only`;
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
