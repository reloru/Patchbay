"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let MODELS = [];
let improveModels = [];
let defaultModel = "";
let defaultImproveModel = "";
let describeModels = [];
let defaultDescribeModel = "";
let authRequired = false;
let currentModel = null;
let optionsPanel = null;
let optionsBadge = null;
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
// A dropped connection makes fetch throw a TypeError whose message is the
// browser's own wording — "Load failed" on Safari, "Failed to fetch" on Chrome.
// That string used to reach the status line verbatim, which is what a mid-edit
// blip looked like: a bare "load failed" with no indication it was the network
// or that retrying would work.
//
// Only those throws are retried. An HTTP error status means the Worker was
// reached and answered, so repeating it just doubles the work.
//
// Retrying is opt-in per call, because a repeat is not always free:
//   - GET is idempotent here, so it retries by default. Status polling is the
//     big win — a blip mid-poll used to abandon a job that was still running.
//   - POSTs must opt in. /api/generate deliberately does not: a throw cannot
//     tell us whether the request reached the provider, and repeating it risks
//     paying for a second generation.
const RETRY_DELAYS = [400, 1200];

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (authRequired && getPw()) headers["x-app-password"] = getPw();
  // retry/onRetry are ours, not fetch's — keep them out of the request init.
  const { retry, onRetry, ...rest } = opts;
  const init = Object.assign({}, rest, { headers });
  const method = (opts.method || "GET").toUpperCase();
  const canRetry = retry === true || (retry !== false && method === "GET");

  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(path, init);
      if (res.status === 401) {
        clearPw();
        showGate("Session expired — enter the password again.");
        throw new Error("Unauthorized");
      }
      return res;
    } catch (err) {
      if (err && err.message === "Unauthorized") throw err; // ours, not the network's
      lastErr = err;
      if (!canRetry || attempt >= RETRY_DELAYS.length) break;
      if (onRetry) onRetry(attempt + 1, RETRY_DELAYS.length + 1);
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  throw new Error(networkErrorText(lastErr, canRetry));
}

// Browsers word a failed connection differently and none of the wordings say
// what to do about it. Anything else is passed through untouched.
function networkErrorText(err, retried) {
  const raw = err && err.message ? err.message : String(err);
  if (!/load failed|failed to fetch|networkerror|network request failed/i.test(raw)) return raw;
  return retried
    ? `The connection dropped and ${RETRY_DELAYS.length + 1} attempts failed. Check your connection and try again.`
    : "The connection dropped before the server answered. Check your connection and try again.";
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  let cfg;
  try {
    const res = await api("/api/config");
    cfg = await res.json();
  } catch (e) {
    document.body.innerHTML = "<p style='padding:24px'>Failed to load app config.</p>";
    return;
  }
  MODELS = cfg.models || [];
  improveModels = cfg.improveModels || [];
  defaultModel = cfg.defaultModel || "";
  defaultImproveModel = cfg.defaultImproveModel || "";
  describeModels = cfg.describeModels || [];
  defaultDescribeModel = cfg.defaultDescribeModel || "";
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
  // Fall back to whatever the picker lists first if the named default ever
  // leaves the catalogue, so startup cannot break on a stale id.
  const first = $("model-select").querySelector("option");
  const wanted = MODELS.some((m) => m.id === defaultModel) ? defaultModel : first && first.value;
  selectModel(wanted || MODELS[0].id);
  initPromptLibrary();
  refreshNeurons();
  $("footer-note").textContent =
    "Generations are proxied through a Cloudflare Worker. Nothing is stored and nothing is cached.";
}

// ---------------------------------------------------------------------------
// Model select (grouped)
// ---------------------------------------------------------------------------
// Sections read "<task> \u00b7 <provider>". Task comes first because that is
// what you pick by; provider second because it decides what an option costs
// and which key it needs, and because two providers ship models under the
// same name (FLUX.2 Klein 4B is on both Pruna and Workers AI).
// Editing leads: it is the common case, and the picker opens on a model in it.
const GROUP_ORDER = ["Image editing", "Image generation", "Video", "LoRA training"];
const PROVIDER_ORDER = ["pruna", "xai", "workers-ai"];
const PROVIDER_LABEL = { pruna: "Pruna", xai: "xAI", "workers-ai": "Workers AI" };

function buildModelSelect() {
  const sel = $("model-select");
  sel.innerHTML = "";

  const sections = new Map(); // "group\u0000provider" -> models
  for (const m of MODELS) {
    const key = `${m.group}\u0000${m.provider}`;
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(m);
  }

  // Anything carrying an unlisted group or provider still has to appear, so
  // sort unknowns to the end rather than dropping them.
  const rank = (list, v) => (list.indexOf(v) === -1 ? list.length : list.indexOf(v));
  const keys = [...sections.keys()].sort((a, b) => {
    const [ga, pa] = a.split("\u0000");
    const [gb, pb] = b.split("\u0000");
    return (
      rank(GROUP_ORDER, ga) - rank(GROUP_ORDER, gb) ||
      ga.localeCompare(gb) ||
      rank(PROVIDER_ORDER, pa) - rank(PROVIDER_ORDER, pb) ||
      pa.localeCompare(pb)
    );
  });

  for (const key of keys) {
    const [group, provider] = key.split("\u0000");
    const og = document.createElement("optgroup");
    og.label = `${group} \u00b7 ${PROVIDER_LABEL[provider] || provider}`;
    for (const m of sections.get(key)) {
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
  // Carry the user's work across the switch: free text by field name, plus the
  // primary prompt even when the two models name it differently, and any
  // uploaded files (re-encoded for whatever the new provider expects).
  const priorText = {};
  const form = $("gen-form");
  if (currentModel) {
    for (const f of currentModel.fields) {
      if (f.type !== "text" && f.type !== "textarea") continue;
      const el = form.querySelector(`[data-field="${f.name}"]`);
      if (el && el.value.trim()) priorText[f.name] = el.value;
    }
    const primary = primaryPromptEl();
    if (primary && primary.value.trim()) priorText.__primary = primary.value;
    carryFiles = Object.values(uploads)
      .flat()
      .map((u) => u.file)
      .filter(Boolean);
  }

  currentModel = MODELS.find((m) => m.id === id);
  $("model-select").value = id;
  $("model-blurb").textContent = (currentModel.blurb || "") + " " + priceBlurb(currentModel);
  // carryFiles already holds the File objects; revoking the old previews here
  // is safe, and the carried files get fresh preview URLs when re-adopted.
  clearUploads();
  resetImproveState();
  renderFields();
  carryFiles = [];

  for (const f of currentModel.fields) {
    if (f.type !== "text" && f.type !== "textarea") continue;
    const el = form.querySelector(`[data-field="${f.name}"]`);
    if (!el || priorText[f.name] === undefined) continue;
    el.value = priorText[f.name];
  }
  // Carried-over text can leave an option non-default, so recount and reveal.
  refreshOptionState();
  if (optionsPanel && optionsBadge && optionsBadge.textContent) optionsPanel.open = true;
  const primaryNow = primaryPromptEl();
  if (primaryNow && !primaryNow.value.trim() && priorText.__primary) {
    primaryNow.value = priorText.__primary;
  }
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

// Reads a video file's duration and resolution client-side (nothing is
// uploaded to do this) so per-second video costs can be estimated before the
// user hits Generate. Resolves to null on anything that isn't decodable
// metadata-only (huge files, unsupported codecs, etc.) rather than guessing.
function probeVideoMeta(file) {
  return new Promise((resolve) => {
    if (!file.type.startsWith("video/")) return resolve(null);
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    v.onloadedmetadata = () => {
      const durationSec = Number.isFinite(v.duration) ? v.duration : null;
      const h = v.videoHeight || 0;
      // Bucket into the resolution tiers xAI actually publishes rates for.
      const resBucket = h && h <= 480 ? "480p" : h && h <= 720 ? "720p" : null;
      done(durationSec ? { durationSec, resBucket } : null);
    };
    v.onerror = () => done(null);
    v.src = url;
  });
}

// A preview object URL keeps the entire file alive in memory until it is
// revoked, so every path that drops an upload has to release its preview
// first — removing a thumb, swapping a single-image field, a failed upload,
// switching models, and Reset.
function releasePreview(u) {
  if (u && u.preview) {
    URL.revokeObjectURL(u.preview);
    u.preview = null;
  }
}

function clearUploads() {
  for (const k of Object.keys(uploads)) {
    for (const u of uploads[k]) releasePreview(u);
    delete uploads[k];
  }
}

// Full data: URI (xAI reference images).
function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
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
    if (p.free) {
      return "Workers AI: no per-image charge listed — but still needs daily allowance left.";
    }
    // Show the cost of a default 1024x1024 run so the trade-off is visible up front.
    const n = estimateNeurons(model, { width: 1024, height: 1024, steps: defaultSteps(model) });
    if (n == null) return "Runs on Cloudflare Workers AI (free daily allowance).";
    const perDay = Math.floor(CF_FREE_NEURONS / n);
    return (
      `Workers AI: ~${Math.round(n).toLocaleString()} neurons per 1024×1024 image — ` +
      `about ${perDay} free per day, then ${fmtUsd(n * CF_USD_PER_NEURON)} each.`
    );
  }
  if (p.type === "cf_unpriced") return "Runs on Cloudflare Workers AI (no published rate).";
  if (p.type === "per_1k_steps") {
    return `List price: ${fmtUsd(p.usd)} per 1,000 training steps.`;
  }
  if (p.type === "flat") return `List price: ${fmtUsd(p.usd)} per image.`;
  if (p.type === "per_second") return `List price: ${fmtUsd(p.usd["720p"])}/s at 720p, ${fmtUsd(p.usd["1080p"])}/s at 1080p.`;
  if (p.type === "per_second_draft") {
    return (
      `List price: ${fmtUsd(p.usd["720p"].draft)}–${fmtUsd(p.usd["1080p"].normal)}/s ` +
      `depending on resolution and draft mode.`
    );
  }
  if (p.type === "flat_by_resolution") {
    const parts = Object.entries(p.usd).map(([res, usd]) => `${fmtUsd(usd)} at ${res}`);
    return `List price: ${parts.join(", ")} per video.`;
  }
  if (p.type === "mp_tiered") {
    const lo = p.tiers[0].usd, hi = p.tiers[p.tiers.length - 1].usd;
    return `List price: ${fmtUsd(lo)}–${fmtUsd(hi)} per image, by target size (1–128 MP).`;
  }
  if (p.type === "thinking_size_tiered") {
    return `List price: ${fmtUsd(p.usd["very low"]["1K"])}–${fmtUsd(p.usd.high["2K"])} per image, by thinking effort and resolution.`;
  }
  if (p.type === "res_quality_tiered") {
    return (
      `List price: ${fmtUsd(p.usd["1k"].low)}–${fmtUsd(p.usd["2k"].medium)} per image, ` +
      `by resolution and quality, plus ${fmtUsd(p.inputUsd)} per reference image.`
    );
  }
  if (p.type === "xai_video") {
    // Which tiers are priced differs by model — 1.5 publishes a 1080p rate,
    // 1.0 does not — so build the list from the table instead of hardcoding
    // it, and only add the caveat for tiers the model offers but can't price.
    const tiers = ["480p", "720p", "1080p"];
    const priced = tiers.filter((r) => p.outUsdPerSec[r] != null);
    const unpriced = tiers.filter((r) => p.outUsdPerSec[r] == null);
    const rates = priced.map((r) => `${fmtUsd(p.outUsdPerSec[r])}/s at ${r}`).join(", ");
    const caveat = unpriced.length ? ` (${unpriced.join(" and ")} ${unpriced.length > 1 ? "have" : "has"} no published rate)` : "";
    return (
      `List price, generating: ${rates}${caveat}, plus ${fmtUsd(p.inputImageUsd)} per input image. ` +
      `Editing or extending: ${fmtUsd(p.sourceUsdPerSec)}/s to read your source video plus the output rate for ` +
      `its resolution — estimate appears once a video is chosen.`
    );
  }
  return "List price: varies with your settings.";
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------
function renderFields() {
  const wrap = $("fields");
  wrap.innerHTML = "";
  optionRows = [];
  optionsPanel = null;
  optionsBadge = null;

  const optional = [];
  visibilityRows = [];
  for (const f of currentModel.fields) {
    if (f.required) {
      const row = renderRequired(f);
      wrap.appendChild(row);
      if (f.showWhen) visibilityRows.push({ f, row });
    } else {
      optional.push(f);
    }
  }
  if (optional.length) wrap.appendChild(renderOptionsPanel(optional));

  // Re-evaluate conditional fields whenever the field they depend on changes.
  for (const name of new Set(currentModel.fields.filter((f) => f.showWhen).map((f) => f.showWhen.field))) {
    const el = wrap.querySelector(`[data-field="${name}"]`);
    if (el) el.addEventListener("change", () => { applyVisibility(); refreshOptionState(); });
  }
  applyVisibility();
  refreshOptionState();
  // Open the panel when something is already non-default — otherwise a value
  // carried over from the previous model would be invisible.
  if (optionsPanel && optionsBadge && optionsBadge.textContent) optionsPanel.open = true;
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
    if (!f.presets || !f.presets.length) return i;

    // Quick-pick dropdown that fills the text input; the input stays editable
    // so a custom URL can always be pasted/typed instead.
    const wrap = document.createElement("div");
    wrap.className = "preset-field";
    const sel = document.createElement("select");
    sel.className = "preset-picker";
    const first = document.createElement("option");
    first.value = "";
    first.textContent = "Quick pick, or paste your own below…";
    sel.appendChild(first);
    for (const p of f.presets) {
      const opt = document.createElement("option");
      opt.value = p.value;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
    const hint = document.createElement("p");
    hint.className = "help preset-hint";
    sel.addEventListener("change", () => {
      const preset = f.presets.find((p) => p.value === sel.value);
      if (preset) {
        i.value = preset.value;
        hint.textContent = preset.hint ? "Suggested prompt: " + preset.hint : "";
      } else {
        hint.textContent = "";
      }
    });
    wrap.appendChild(sel);
    wrap.appendChild(hint);
    wrap.appendChild(i);
    return wrap;
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
    // A real checkbox drives it (so keyboard/screen-reader semantics are
    // native and readControlValue/resetField don't need to change at all),
    // but it's visually replaced by a track + knob so the control reads as
    // "here's the current state" rather than "check this box to enable X" —
    // which is genuinely ambiguous once the state being shown is Off.
    const label = document.createElement("label");
    label.className = "toggle";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.dataset.field = f.name;
    const base = Boolean(f.default);
    c.checked = f.invert ? !base : base; // show the user-facing (possibly inverted) value
    label.appendChild(c);
    const track = document.createElement("span");
    track.className = "toggle-track";
    label.appendChild(track);
    const span = document.createElement("span");
    span.className = "toggle-text";
    span.textContent = c.checked ? "On" : "Off";
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

// Each provider wants a different encoding, so the File is kept and re-encoded
// on demand rather than assuming one format.
async function encodeForField(f, file) {
  if (f.asDataUri) return await fileToDataUri(file);   // xAI: data: URI in JSON
  if (f.asBase64) return await fileToBase64(file);     // Workers AI: inline bytes
  const fd = new FormData();                            // Pruna: upload, use the URL
  fd.append("file", file);
  const res = await api("/api/upload", { method: "POST", body: fd, retry: true });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || data.message || "Upload failed");
  return data.url;
}

// Files carried across a model switch, consumed by the new model's image fields.
let carryFiles = [];

// The "image" field type is reused for audio, video, and .zip uploads (via
// `accept`), so the picker's wording has to follow suit rather than always
// saying "image".
function fileNoun(f) {
  const accept = f.accept || "";
  if (accept.startsWith("audio/")) return "audio";
  if (accept.startsWith("video/")) return "video";
  if (accept === "image/*" || !accept) return "image";
  return "file";
}

function imageControl(f) {
  const box = document.createElement("div");
  const maxItems = f.maxItems || 1;
  const noun = fileNoun(f);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = f.accept || "image/*";
  input.multiple = maxItems > 1;
  input.className = "file-input"; // hidden; the button below drives it

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "secondary file-pick";
  pick.addEventListener("click", () => input.click());

  const status = document.createElement("span");
  status.className = "file-status";

  const updateLabel = () => {
    const n = (uploads[f.name] || []).length;
    if (maxItems === 1) {
      pick.textContent = n ? `Replace ${noun}` : `Choose ${noun}`;
      status.textContent = n ? (uploads[f.name][0].name || "1 file") : `No ${noun} chosen`;
    } else {
      pick.textContent = n ? `Add ${noun}` : `Choose ${noun}(s)`;
      status.textContent = n ? `${n} of ${maxItems} chosen` : `No ${noun}s chosen`;
      pick.disabled = n >= maxItems;
    }
  };

  const thumbs = document.createElement("div");
  thumbs.className = "thumbs";

  uploads[f.name] = uploads[f.name] || [];

  const redraw = () => {
    updateLabel();
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
        releasePreview(uploads[f.name][idx]);
        uploads[f.name].splice(idx, 1);
        redraw();
      });
      t.appendChild(rm);
      thumbs.appendChild(t);
    }
    // A sibling field may be conditionally disabled based on this field's
    // uploads (e.g. aspect ratio once a start image sets it instead).
    refreshOptionState();
  };

  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.value = "";
    // A single-image field swaps the picture rather than refusing the new one.
    if (maxItems === 1 && files.length) {
      for (const u of uploads[f.name]) releasePreview(u);
      uploads[f.name].length = 0;
    }
    for (const file of files) {
      if (uploads[f.name].length >= maxItems) break;
      const placeholder = { file, url: null, name: file.name, isImage: file.type.startsWith("image/"), preview: null, uploading: true };
      if (placeholder.isImage) placeholder.preview = URL.createObjectURL(file);
      uploads[f.name].push(placeholder);
      redraw();
      probeVideoMeta(file).then((meta) => {
        if (meta) Object.assign(placeholder, meta);
      });
      try {
        placeholder.url = await encodeForField(f, file);
        placeholder.uploading = false;
      } catch (e) {
        releasePreview(placeholder);
        const i = uploads[f.name].indexOf(placeholder);
        if (i >= 0) uploads[f.name].splice(i, 1);
        redraw();
        setStatus("Upload failed: " + e.message, "err");
      }
    }
  });

  // Adopt files carried over from the previously selected model.
  if (carryFiles.length) {
    const taken = carryFiles.splice(0, maxItems - uploads[f.name].length);
    for (const file of taken) {
      const placeholder = { file, url: null, name: file.name, isImage: file.type.startsWith("image/"), preview: null, uploading: true };
      if (placeholder.isImage) placeholder.preview = URL.createObjectURL(file);
      uploads[f.name].push(placeholder);
      probeVideoMeta(file).then((meta) => {
        if (meta) Object.assign(placeholder, meta);
      });
      encodeForField(f, file)
        .then((url) => { placeholder.url = url; placeholder.uploading = false; })
        .catch((e) => {
          releasePreview(placeholder);
          const i = uploads[f.name].indexOf(placeholder);
          if (i >= 0) uploads[f.name].splice(i, 1);
          redraw();
          setStatus("Could not carry image over: " + e.message, "err");
        });
    }
  }

  const row = document.createElement("div");
  row.className = "file-row";
  row.appendChild(pick);
  row.appendChild(status);
  box.appendChild(input);
  box.appendChild(row);
  box.appendChild(thumbs);
  if (maxItems > 1) {
    const hint = document.createElement("p");
    hint.className = "help";
    hint.textContent = `Up to ${maxItems} files.`;
    box.appendChild(hint);
  }
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

// Optional parameters used to hide behind a per-field "override" checkbox,
// which meant two interactions to change anything and a default label that
// didn't necessarily match what was sent. They now sit in one collapsible
// panel, each control visible and pre-filled with its default; anything you
// actually change is highlighted and counted in the header.
let optionRows = [];

function renderOptionsPanel(fields) {
  const det = document.createElement("details");
  det.className = "options";

  const sum = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "opt-title";
  title.textContent = "Options";
  const badge = document.createElement("span");
  badge.className = "opt-badge";
  sum.appendChild(title);
  sum.appendChild(badge);
  det.appendChild(sum);

  const list = document.createElement("div");
  list.className = "opt-list";
  for (const f of fields) list.appendChild(buildOptionRow(f));
  det.appendChild(list);

  det.dataset.badge = "";
  optionsPanel = det;
  optionsBadge = badge;
  return det;
}

function buildOptionRow(f) {
  const row = document.createElement("div");
  row.className = "opt-row";

  const head = document.createElement("div");
  head.className = "opt-row-head";
  const name = document.createElement("span");
  name.className = "opt-name";
  name.textContent = f.label;
  const note = document.createElement("span");
  note.className = "opt-note";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "opt-reset";
  reset.textContent = "↺ Reset";
  reset.title = "Back to the default";
  reset.hidden = true;
  head.appendChild(name);
  head.appendChild(note);
  head.appendChild(reset);
  row.appendChild(head);

  row.appendChild(inputControl(f));
  if (f.help) {
    const h = document.createElement("p");
    h.className = "help";
    h.textContent = f.help;
    row.appendChild(h);
  }

  // "touched" tracks a deliberate edit, separate from "differs from default":
  // a field like seed defaults to -1 (its own "randomize" sentinel), so it can
  // never differ from itself — without this, there'd be no way to force -1
  // into the request rather than omitting it, unlike every other value.
  const entry = { f, row, note, reset, touched: false };
  reset.addEventListener("click", () => {
    resetField(f, row); // dispatches "change" (re-touching it), so untouch after
    entry.touched = false;
    refreshOptionState(); // resetField's own refresh ran while still touched=true
  });
  row.addEventListener("input", () => { entry.touched = true; refreshOptionState(); });
  row.addEventListener("change", () => { entry.touched = true; refreshOptionState(); });

  optionRows.push(entry);
  return row;
}

function optionChanged(f, row) {
  if (f.type === "image") return (uploads[f.name] || []).some((u) => u.url);
  const v = readControlValue(f, row);
  if (v === undefined) return false;
  return v !== f.default;
}

// A field with `showWhen: { field, is: [...] }` only applies to some of the
// model's modes — e.g. the source video belongs to Edit and Extend but not to
// Generate. Hidden rows are also skipped by buildInput, so a value left behind
// from another mode is never sent.
let visibilityRows = [];

function fieldVisible(f) {
  if (!f.showWhen) return true;
  const el = $("gen-form").querySelector(`[data-field="${f.showWhen.field}"]`);
  const v = el ? el.value : undefined;
  return f.showWhen.is.includes(v);
}

function applyVisibility() {
  for (const r of visibilityRows.concat(optionRows.filter((r) => r.f.showWhen))) {
    r.row.hidden = !fieldVisible(r.f);
  }
}

function refreshOptionState() {
  // Attaching or removing an image changes what Describe would read.
  updateDescribeNote();
  let changed = 0;
  for (const r of optionRows) {
    if (r.f.showWhen && !fieldVisible(r.f)) {
      r.row.classList.remove("changed");
      r.reset.hidden = true;
      r.note.textContent = "";
      continue;
    }
    // e.g. p-video's aspect ratio: the provider derives it from the start
    // image and ignores the dropdown once one is attached, so gray it out
    // and say why instead of leaving a control that quietly does nothing.
    const blockedBy = r.f.disabledWhen && (uploads[r.f.disabledWhen] || []).length > 0;
    const el = r.row.querySelector(`[data-field="${r.f.name}"]`);
    if (el) el.disabled = Boolean(blockedBy);
    r.row.classList.toggle("blocked", Boolean(blockedBy));
    if (blockedBy) {
      r.row.classList.remove("changed");
      r.reset.hidden = true;
      r.note.textContent = r.f.disabledNote || "not used with an image attached";
      continue;
    }

    // "touched" only matters for the visual "changed" state when it's the
    // *only* way to affect what gets sent -- i.e. the field's own default
    // already equals apiDefault (seed=-1 is itself "randomize", so entering
    // -1 has to be tracked separately from "value differs"). For a field
    // whose default is already forced to diverge from apiDefault (turbo,
    // content moderation), the value is sent on every request regardless of
    // touch, so touching-then-reverting it sends an identical payload either
    // way -- highlighting it as "changed" there would be pure theater.
    const touchMatters = apiDefaultOf(r.f) === r.f.default;
    const isChanged = (r.touched && touchMatters) || optionChanged(r.f, r.row);
    if (isChanged) changed++;
    r.row.classList.toggle("changed", isChanged);
    // Uploads are cleared with the thumbnail's own ×, so no reset button there.
    const resettable = isChanged && r.f.type !== "image";
    r.reset.hidden = !resettable;
    const dflt = defaultText(r.f);
    r.note.textContent = resettable && dflt != null ? `default: ${dflt}` : "";
  }
  if (optionsBadge) optionsBadge.textContent = changed ? `${changed} changed` : "";
}

function resetField(f, row) {
  const el = row.querySelector(`[data-field="${f.name}"]`);
  if (!el) return;
  if (f.type === "bool") {
    const base = Boolean(f.default);
    el.checked = f.invert ? !base : base;
  } else {
    el.value = f.default == null ? "" : String(f.default);
  }
  // Keeps the bool row's On/Off text and the changed state in sync.
  el.dispatchEvent(new Event("change", { bubbles: true }));
  refreshOptionState();
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
    const v = parseFloat(el.value);
    return f.wrapArray ? [v] : v;
  }
  if (f.type === "enum") {
    const match = f.options.find((o) => String(o.value) === el.value);
    return match ? match.value : el.value;
  }
  // text / textarea
  if (f.wrapArray) return el.value === "" ? undefined : [el.value];
  return el.value;
}

// What the provider does when a field is omitted. Usually the same as the
// value we show, but not always — see moderationFilter in models.js.
function apiDefaultOf(f) {
  return "apiDefault" in f ? f.apiDefault : f.default;
}

function buildInput() {
  const form = $("gen-form");
  const input = {};
  const missing = [];
  const touchedNames = new Set(optionRows.filter((r) => r.touched).map((r) => r.f.name));

  for (const f of currentModel.fields) {
    // Belongs to a mode other than the one selected — not asked for, not sent,
    // and not counted as missing even when it is required in its own mode.
    if (!fieldVisible(f)) continue;
    const v = readControlValue(f, form);

    if (f.required) {
      if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
        missing.push(f.label);
        continue;
      }
      input[f.name] = v;
      continue;
    }

    // Optional fields are always visible now, so there is no toggle to read.
    // Send a value when the user deliberately set it, or when it differs from
    // what the provider would do on its own; otherwise sending it is just noise.
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) input[f.name] = v;
      continue;
    }
    if (f.type === "image") {
      input[f.name] = v; // an upload is only ever present because it was chosen
      continue;
    }
    if (touchedNames.has(f.name) || v !== apiDefaultOf(f)) input[f.name] = v;
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
    // Analytics lag inference slightly, so give it a moment before re-reading.
    setTimeout(refreshNeurons, 4000);
    setStatus(`Done in ${secs}s.${cost ? " " + cost : ""}`, "ok");
  } catch (err) {
    setStatus("Error: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("reset-btn").addEventListener("click", () => {
  clearUploads();
  renderFields();
  setStatus("", "hide");
});

async function runGeneration(model, input, kind, onProgress) {
  lastActualCostUsd = null;
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
  // Heavy video jobs (VACE especially) can run well past 10 minutes. LoRA
  // training is documented as "minutes to hours", so it gets the longest
  // budget this tab is willing to wait on.
  const maxMs = (kind === "file" ? 45 : kind === "video" ? 30 : 10) * 60 * 1000;
  while (true) {
    await sleep(2500);
    if (Date.now() - started > maxMs) {
      throw new Error(
        kind === "file"
          ? `Still training after ${Math.round(maxMs / 60000)} min — this can take hours. ` +
            "Check back later; the job keeps running on Pruna even after this tab gives up."
          : `Timed out after ${Math.round(maxMs / 60000)} min. Try a lower resolution, ` +
            "fewer frames/steps, or a faster speed mode."
      );
    }
    const sRes = await api("/api/status?id=" + encodeURIComponent(id), {
      // Same (state, seconds) shape the caller already formats, so a dropped
      // poll reads as "Reconnecting (1/3)… 12s elapsed" rather than stalling
      // on the last status with no sign anything went wrong.
      onRetry: (n, of) =>
        onProgress && onProgress(`reconnecting (${n}/${of})`, Math.round((Date.now() - started) / 1000)),
    });
    const s = await sRes.json();
    if (!sRes.ok) throw new Error(s.error || `Status HTTP ${sRes.status}`);
    if (s.status === "succeeded") {
      // xAI reports the job's real dollar cost — prefer that over any estimate.
      lastActualCostUsd = typeof s.actual_cost_usd === "number" ? s.actual_cost_usd : null;
      return asUrlList(s.generation_url || s.output || s.output_url);
    }
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
    } else if (kind === "file") {
      // Not previewable media (e.g. a trained LoRA .zip) — just a plain link.
      const box2 = document.createElement("div");
      box2.className = "file-result";
      box2.textContent = "📦 File ready";
      item.appendChild(box2);
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
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
  };
  return map[(type || "").toLowerCase()] || (kind === "video" ? "mp4" : kind === "file" ? "zip" : "jpg");
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

const IMPROVE_MODEL_KEY = "pruna_improve_model";

// "Improve" rewrites the prompt in place and keeps the original so a second
// click can undo it. Editing the prompt afterwards makes the undo stale, so the
// button goes back to "Improve" rather than offering to restore unrelated text.
let preImprove = null;
let improvedText = null;

function resetImproveState() {
  preImprove = null;
  improvedText = null;
  const b = $("prompt-improve");
  if (b) b.textContent = "✨ Improve";
}

// Groups a list of {family, label} into <optgroup>s, families in first-seen
// order. Anything without a family is appended ungrouped rather than dropped.
function fillGroupedSelect(sel, list, optionLabel) {
  sel.innerHTML = "";
  const byFamily = new Map();
  for (const m of list) {
    if (!m.family) continue;
    if (!byFamily.has(m.family)) byFamily.set(m.family, []);
    byFamily.get(m.family).push(m);
  }
  const mkOption = (m) => {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = optionLabel ? optionLabel(m) : m.label;
    return o;
  };
  for (const [family, members] of byFamily) {
    const og = document.createElement("optgroup");
    og.label = family;
    for (const m of members) og.appendChild(mkOption(m));
    sel.appendChild(og);
  }
  for (const m of list) if (!m.family) sel.appendChild(mkOption(m));
}

function improveNoteFor(m) {
  if (!m) return "";
  const cost = `~${m.neurons} neurons per rewrite`;
  // Reasoning models spend tokens thinking before they answer, which shows up
  // as latency rather than as a different result, so it is worth flagging.
  return `✨ ${m.label} · ${cost}${m.reasoning ? " · reasoning, so slower" : ""}`;
}

function updateImproveNote() {
  const sel = $("improve-model");
  $("improve-note").textContent = improveNoteFor(improveModels.find((m) => m.id === sel.value));
}

function initImproveModelPicker() {
  const sel = $("improve-model");
  // Grouped by family and sized within it, so the list reads as a catalogue.
  // Cost used to be baked into every option name; it now appears in the note
  // below once a model is chosen.
  fillGroupedSelect(sel, improveModels);
  const saved = localStorage.getItem(IMPROVE_MODEL_KEY);
  sel.value = improveModels.some((m) => m.id === saved) ? saved : defaultImproveModel;
  sel.addEventListener("change", () => {
    localStorage.setItem(IMPROVE_MODEL_KEY, sel.value);
    updateImproveNote();
  });
  updateImproveNote();
}

// "Describe" captions an uploaded image straight into the prompt box, so a
// reference picture can seed a prompt.
// The picture already attached to one of the model's image fields, if any.
// Describing that is almost always what is wanted -- being made to pick the
// same file a second time was the old behaviour and it was pure friction.
// Field order follows the model definition, so the first hit is the primary
// input rather than a mask or an end frame.
function attachedImageFile() {
  if (!currentModel) return null;
  for (const f of currentModel.fields) {
    if (f.type !== "image") continue;
    for (const u of uploads[f.name] || []) {
      if (u.file && u.isImage) return u.file;
    }
  }
  return null;
}

function updateDescribeNote() {
  const noteEl = $("describe-note");
  if (!noteEl) return; // called from refreshOptionState before the toolbar exists
  const m = describeModels.find((x) => x.id === $("describe-model").value);
  if (!m) return void (noteEl.textContent = "");
  const attached = attachedImageFile();
  const source = attached
    ? `reads ${attached.name || "the attached image"}`
    : "attach an image below and it reads that";
  noteEl.textContent = `🔍 ${m.label} · ${m.note} · ${source}`;
}

function initDescribe() {
  const sel = $("describe-model");
  // Bare names here too; the per-model caveat lives in the note below.
  fillGroupedSelect(sel, describeModels);
  sel.value = defaultDescribeModel;
  sel.addEventListener("change", updateDescribeNote);

  const btn = $("prompt-describe");
  const file = $("describe-file");

  // Prefer whatever is already attached; only fall back to the file picker
  // when nothing is.
  btn.addEventListener("click", () => {
    const attached = attachedImageFile();
    if (attached) describeFile(attached);
    else file.click();
  });

  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (f) describeFile(f);
  });

  async function describeFile(f) {
    const el = primaryPromptEl();
    if (!el) return;

    btn.disabled = true;
    const idle = btn.textContent;
    btn.textContent = "Reading…";
    setStatus(`Describing ${f.name || "image"}…`, "load");
    try {
      const b64 = await fileToBase64(f);
      const res = await api("/api/describe", {
        method: "POST",
        retry: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image_b64: b64, mime: f.type || "image/jpeg", model: sel.value }),
      });
      const data = await res.json();
      if (!res.ok || !data.description) throw new Error(data.error || `HTTP ${res.status}`);
      el.value = data.description;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      setStatus("Prompt filled from the image.", "ok");
    } catch (e) {
      setStatus("Describe failed: " + e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = idle;
    }
  }

  updateDescribeNote();
}

function initPromptLibrary() {
  refreshPromptSelect();
  initImproveModelPicker();
  initDescribe();

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
  const improveBtn = $("prompt-improve");
  improveBtn.addEventListener("click", async () => {
    const el = primaryPromptEl();
    if (!el) return;

    if (preImprove !== null) {
      el.value = preImprove;
      resetImproveState();
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
      // Whether an image field actually has something in it — a text-only
      // model can't see the source image, so editing/i2v prompts need a much
      // more conservative rewrite than from-scratch generation prompts do.
      const hasImage = currentModel.fields.some(
        (f) => f.type === "image" && (uploads[f.name] || []).length > 0
      );
      const res = await api("/api/improve-prompt", {
        method: "POST",
        retry: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text, kind: currentModel.kind, hasImage, model: $("improve-model").value }),
      });
      const data = await res.json();
      if (!res.ok || !data.prompt) throw new Error(data.error || `HTTP ${res.status}`);
      preImprove = text;
      improvedText = data.prompt;
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
  $("prompt-select").addEventListener("change", resetImproveState);

  // Typing in the prompt invalidates the undo. Delegated on the form because
  // the prompt element is rebuilt whenever fields re-render.
  $("gen-form").addEventListener("input", (e) => {
    if (preImprove === null) return;
    if (e.target !== primaryPromptEl()) return;
    if (e.target.value === improvedText) return; // our own programmatic set
    resetImproveState();
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
// Real dollar cost of the most recent xAI video job, reported by xAI itself
// rather than estimated. Set in runGeneration(), consumed once by addSpend().
let lastActualCostUsd = null;
const CF_FREE_NEURONS = 10000; // Workers AI free allowance per day, resets 00:00 UTC
const CF_USD_PER_NEURON = 0.011 / 1000; // $0.011 per 1,000 neurons beyond the allowance

// Neurons for one Workers AI run, from Cloudflare's published per-model rates.
function estimateNeurons(model, input) {
  const p = model.price;
  if (!p || p.type !== "cf_neurons") return null;
  if (p.free) return 0; // Cloudflare lists these at $0.00 — unmetered.

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

// Optional fields only appear in `input` when their override toggle is on, so
// reading input.foo alone tells you nothing about what will actually be sent
// — it's just as often "the user left this at Pruna's default". This looks up
// that default so the estimate reflects what Generate will actually do.
function fieldDefault(model, name) {
  const f = model.fields.find((x) => x.name === name);
  return f ? f.default : undefined;
}

function estimateCost(model, input, outputCount) {
  const p = model.price;
  if (!p || p.type === "variable" || p.type === "cf_neurons" || p.type === "cf_unpriced") return null;
  if (p.type === "flat") {
    const n = Number(input.num_outputs) || Number(input.n) || outputCount || 1;
    // Grok's quality model charges more at 2k; reference images bill separately.
    const per = input.resolution === "2k" && p.usd2k != null ? p.usd2k : p.usd;
    const refs = Array.isArray(input.images) ? input.images.length : 0;
    return per * n + refs * (p.inputUsd || 0);
  }
  if (p.type === "per_1k_steps") {
    // Steps range 100-5000, so the bill swings 50x across the slider -- worth
    // showing before a run that can take hours.
    const steps = Number(input.steps) || fieldDefault(model, "steps") || 0;
    if (!steps) return null;
    return (steps / 1000) * p.usd;
  }
  if (p.type === "per_second") {
    const rate = p.usd[input.resolution || "720p"];
    if (rate == null) return null;
    const secs = Number(input.duration);
    if (!secs) return null; // length comes from the source video — unknown here
    return rate * secs;
  }
  if (p.type === "per_second_draft") {
    const resolution = input.resolution ?? fieldDefault(model, "resolution") ?? "720p";
    const tier = p.usd[resolution];
    if (!tier) return null;
    const draft = input.draft ?? fieldDefault(model, "draft") ?? false;
    const rate = draft ? tier.draft : tier.normal;
    const secs = Number(input.duration ?? fieldDefault(model, "duration"));
    if (!secs) return null;
    return rate * secs;
  }
  if (p.type === "flat_by_resolution") {
    const resolution = input.resolution ?? fieldDefault(model, "resolution");
    const rate = p.usd[resolution];
    return rate == null ? null : rate;
  }
  if (p.type === "mp_tiered") {
    const mp = Number(input.target) || 4;
    const tier = p.tiers.find((t) => mp <= t.max) || p.tiers[p.tiers.length - 1];
    return tier.usd;
  }
  if (p.type === "thinking_size_tiered") {
    // image_size is documented as ignored for a custom aspect ratio, so the
    // rate can't be pinned down in that case.
    if (input.aspect_ratio === "custom") return null;
    const thinking = p.usd[input.thinking || "medium"];
    if (!thinking) return null;
    const rate = thinking[input.image_size || "2K"];
    return rate == null ? null : rate;
  }
  if (p.type === "res_quality_tiered") {
    const resolution = input.resolution ?? fieldDefault(model, "resolution") ?? "1k";
    const quality = input.quality ?? fieldDefault(model, "quality") ?? "medium";
    const tier = p.usd[resolution];
    const per = tier ? tier[quality] : null;
    if (per == null) return null;
    const n = Number(input.num_outputs) || Number(input.n) || outputCount || 1;
    const refs = Array.isArray(input.images) ? input.images.length : 0;
    return per * n + refs * (p.inputUsd || 0);
  }
  if (p.type === "xai_video") {
    // Editing and extending are priced from the source video's own duration and
    // resolution, probed client-side when it was picked. Editing reruns the
    // whole clip; extending generates only the new footage on top of it.
    if (input.mode === "edits" || input.mode === "extensions") {
      const src = (uploads.video || [])[0];
      if (!src || !src.durationSec || !src.resBucket) return null;
      const outRate = p.outUsdPerSec[src.resBucket];
      if (outRate == null) return null;
      const outSecs = input.mode === "extensions" ? Number(input.extend_duration) || 6 : src.durationSec;
      return src.durationSec * p.sourceUsdPerSec + outSecs * outRate;
    }
    const rate = p.outUsdPerSec[input.resolution || "480p"];
    if (rate == null) return null; // a tier the model publishes no rate for
    const secs = Number(input.duration) || 8;
    const refs = (input.image ? 1 : 0) + (Array.isArray(input.reference_images) ? input.reference_images.length : 0);
    return rate * secs + refs * p.inputImageUsd;
  }
  return null;
}

function fmtUsd(v) {
  const n = (v < 0.01 ? v.toFixed(4) : v.toFixed(3)).replace(/0+$/, "").replace(/\.$/, "");
  // Trailing zeros are stripped so $0.050 reads as $0.05, but that also turns
  // $1.80 into $1.8. Pad one-decimal results back to cents; leave whole
  // dollars bare ($4) and keep sub-cent precision ($0.025) intact.
  return "$" + n.replace(/\.(\d)$/, ".$10");
}

function addSpend(model, input, outputCount) {
  sessionRuns++;

  const neurons = estimateNeurons(model, input);
  if (neurons != null) {
    sessionNeurons += neurons;
    updateSpendBar();
    if (neurons === 0) return "No per-image charge listed for this model.";
    const pct = Math.round((neurons / CF_FREE_NEURONS) * 100);
    return (
      `Est. ~${Math.round(neurons).toLocaleString()} neurons ` +
      `(~${pct || "<1"}% of the daily free allowance, ${fmtUsd(neurons * CF_USD_PER_NEURON)} beyond it).`
    );
  }
  if (model.price && model.price.type === "cf_unpriced") {
    updateSpendBar();
    return "Cloudflare does not publish a rate for this model.";
  }

  // xAI video jobs report their real dollar cost — use that instead of an estimate.
  if (lastActualCostUsd != null) {
    const actual = lastActualCostUsd;
    lastActualCostUsd = null;
    sessionSpend += actual;
    updateSpendBar();
    return `${fmtUsd(actual)} (xAI's reported cost).`;
  }

  const cost = estimateCost(model, input, outputCount);
  if (cost != null) sessionSpend += cost;
  updateSpendBar();
  return cost == null ? "Cost: varies by settings." : `Est. ${fmtUsd(cost)}.`;
}

// Actual neurons spent today, straight from Cloudflare analytics. Falls back
// silently to the estimate if reporting is not configured.
let actualNeurons = null;

async function refreshNeurons() {
  try {
    const res = await api("/api/neurons");
    if (!res.ok) return;
    const d = await res.json();
    if (typeof d.used !== "number") return;
    actualNeurons = d;
    updateSpendBar();
  } catch {
    /* leave the estimate in place */
  }
}

function updateSpendBar() {
  const el = $("spend");
  if (!el) return;
  const parts = [];

  // Real usage when analytics are available; the estimate only as a fallback.
  if (actualNeurons) {
    const pct = Math.round((actualNeurons.used / actualNeurons.limit) * 100);
    parts.push(
      `Workers AI ${Math.round(actualNeurons.used).toLocaleString()} of ` +
      `${actualNeurons.limit.toLocaleString()} neurons used today (${pct}%, ` +
      `${Math.round(actualNeurons.remaining).toLocaleString()} left)`
    );
  } else if (sessionNeurons > 0) {
    parts.push(`Workers AI ~${Math.round(sessionNeurons).toLocaleString()} neurons this session (est.)`);
  }

  // Pruna bills in dollars and has no usage API, so it stays an estimate.
  if (sessionSpend > 0) parts.push(`Pruna ~${fmtUsd(sessionSpend)} this session (est.)`);

  if (!parts.length) parts.push("no usage recorded yet");
  if (sessionRuns > 0) parts.push(`${sessionRuns} run${sessionRuns === 1 ? "" : "s"} this session`);
  el.textContent = parts.join(" · ");
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
