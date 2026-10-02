"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let MODELS = [];
let improveModels = [];
let defaultModel = "";
let defaultImproveModel = "";
let describeModels = [];
let chatModels = [];
let defaultChatModel = "";
let embedModels = [];
let defaultInstructions = { improve: "", chat: "" };
let translateLanguages = [];
let sttModels = [];
let defaultSttModel = "";
let otherTools = [];
let defaultEmbedModel = "";
let defaultDescribeModel = "";
let judgeUsdPerImage = 0;
let judgeMaxImages = 1;
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

// `timeoutMs` bounds each attempt. A request that neither answers nor fails —
// a connection the phone kept after it went dead, a handover mid-request —
// otherwise holds whatever awaits it until the OS gives up, and a status poll
// stuck that way stalls the whole run while the counter keeps climbing. An
// attempt that runs out of time is retried exactly like one that threw.
//
// `read(res)` runs inside the same deadline, so a body that stops arriving is
// caught too, not only a slow first byte. `onAttempt` hears how each attempt
// went, for the run's timing record.
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (authRequired && getPw()) headers["x-app-password"] = getPw();
  // These are ours, not fetch's — keep them out of the request init.
  const { retry, onRetry, timeoutMs, read, onAttempt, ...rest } = opts;
  const method = (opts.method || "GET").toUpperCase();
  const canRetry = retry === true || (retry !== false && method === "GET");

  let lastErr;
  let timedOut = false;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const ctl = timeoutMs ? new AbortController() : null;
    let expired = false;
    const timer = ctl
      ? setTimeout(() => {
          expired = true;
          ctl.abort();
        }, timeoutMs)
      : null;
    const init = Object.assign({}, rest, { headers }, ctl ? { signal: ctl.signal } : {});
    try {
      const res = await fetch(path, init);
      if (res.status === 401) {
        clearPw();
        showGate("Session expired — enter the password again.");
        throw new Error("Unauthorized");
      }
      const value = read ? await read(res) : res;
      if (onAttempt) onAttempt({ attempt: attempt + 1, ms: Date.now() - t0, outcome: "ok", res });
      return value;
    } catch (err) {
      if (err && err.message === "Unauthorized") throw err; // ours, not the network's
      lastErr = err;
      timedOut = expired;
      if (onAttempt) onAttempt({ attempt: attempt + 1, ms: Date.now() - t0, outcome: expired ? "timeout" : "network" });
      if (!canRetry || attempt >= RETRY_DELAYS.length) break;
      if (onRetry) onRetry(attempt + 1, RETRY_DELAYS.length + 1);
      await sleep(RETRY_DELAYS[attempt]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (timedOut) {
    const tries = canRetry ? RETRY_DELAYS.length + 1 : 1;
    throw new Error(
      `No answer from the server within ${Math.round(timeoutMs / 1000)} s` +
        (tries > 1 ? `, ${tries} attempts.` : ".") +
        " Check your connection and try again."
    );
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
// Tool requests
//
// None of the prompt tools had a deadline: a model that never answered, or a
// connection that died mid-request, left its button disabled until a reload.
// Improve, Describe and the chat now answer as server-sent events (see
// toolStream in worker.js): a ping at once and every 10 s, then the answer.
// So the browser can tell "still working" from "gone" by silence alone, and a
// long reply that keeps arriving is never cut off. The one-shot tools get a
// plain deadline instead. Both paths go through api(), which is unchanged:
// the abort signal rides in its options straight through to fetch.
// ---------------------------------------------------------------------------
const TOOL_CANCELLED = "__tool_cancelled__";
// Six missed pings: the connection is gone, whatever the model is doing.
const TOOL_IDLE_MS = Number(window.__TEST_IDLE_MS) || 60000;
const ONE_SHOT_MS = 60000;

// Posts `body` to a streaming tool route and resolves with its `done` payload.
// `onEvent(name, data)` hears the rest (delta, reset, progress). Aborting
// `controller` cancels; the thrown message is TOOL_CANCELLED.
async function streamTool(path, body, { onEvent, controller } = {}) {
  const ctl = controller || new AbortController();
  let silent = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent = true;
      ctl.abort();
    }, TOOL_IDLE_MS);
  };
  arm();
  try {
    const res = await api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // Refusals before any work starts (a bad request, a missing binding) are
    // still plain JSON.
    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const name = (/^event: (.*)$/m.exec(block) || [])[1];
        const raw = (/^data: (.*)$/m.exec(block) || [])[1];
        if (!name || raw == null) continue;
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }
        if (name === "done") {
          reader.cancel().catch(() => {});
          return data;
        }
        if (name === "error") throw new Error(data.error || "The tool failed.");
        if (onEvent) onEvent(name, data);
      }
    }
    throw new Error("The connection closed before the answer finished.");
  } catch (e) {
    if (silent) {
      throw new Error(
        `Nothing from the server for ${Math.round(TOOL_IDLE_MS / 1000)} s — the connection looks lost. ` +
          "The model may still have run, and may still be billed."
      );
    }
    if (ctl.signal.aborted) throw new Error(TOOL_CANCELLED);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// A one-shot tool call with a deadline: resolves with { res, data }.
async function apiWithin(path, opts, ms = ONE_SHOT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await api(path, { ...opts, signal: ctl.signal });
    const data = await res.json();
    return { res, data };
  } catch (e) {
    if (ctl.signal.aborted) {
      throw new Error(`No answer after ${Math.round(ms / 1000)} s. It may still have run and been billed — try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Long edge of any image handed to a tool model. A phone photo is several
// megabytes, and as base64 inside a JSON body that is the slow part of every
// chat message and caption on a mobile connection. Generation uploads are not
// touched: those go to the provider at the size chosen.
const TOOL_IMAGE_PX = 1024;

// Resolves to { b64, mime }. Anything the browser cannot decode (HEIC outside
// Safari, say) goes as it is rather than not at all.
function toolImage(file) {
  return new Promise((resolve) => {
    const asIs = () => fileToBase64(file).then((b64) => resolve({ b64, mime: file.type || "image/jpeg" }), () => resolve(null));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const long = Math.max(img.width, img.height);
      if (!long || long <= TOOL_IMAGE_PX) return void asIs();
      try {
        const scale = TOOL_IMAGE_PX / long;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ b64: dataUrl.split(",")[1] || "", mime: "image/jpeg" });
      } catch {
        asIs();
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      asIs();
    };
    img.src = url;
  });
}

function loadImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

// For a model that takes one image per message (Llama 3.2 Vision, Moondream,
// LLaVA): the ticked images side by side in one picture, each numbered as its
// chip is, so "image 2" still names the same one. Resolves to { b64, mime }.
async function combinedImage(list) {
  const tiles = [];
  for (const x of list) {
    const img = await loadImage(x.file);
    if (img && img.width && img.height) tiles.push({ img, n: x.n });
  }
  if (!tiles.length) return null;
  const H = 768;
  const GAP = 12;
  const widths = tiles.map(({ img }) => Math.round((img.width * H) / img.height));
  const scale = Math.min(1, 2048 / (widths.reduce((a, b) => a + b, 0) + GAP * (tiles.length - 1)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((widths.reduce((a, b) => a + b, 0) + GAP * (tiles.length - 1)) * scale));
  canvas.height = Math.max(1, Math.round(H * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const r = Math.max(12, Math.round(26 * scale));
  let x = 0;
  tiles.forEach(({ img, n }, i) => {
    const w = Math.round(widths[i] * scale);
    ctx.drawImage(img, x, 0, w, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, .75)";
    ctx.fillRect(x + 6, 6, r * 2, r * 2);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), x + 6 + r, 6 + r);
    x += w + Math.round(GAP * scale);
  });
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { b64: url.split(",")[1] || "", mime: "image/jpeg" };
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
  chatModels = cfg.chatModels || [];
  defaultChatModel = cfg.defaultChatModel || "";
  embedModels = cfg.embedModels || [];
  defaultInstructions = cfg.instructions || defaultInstructions;
  translateLanguages = cfg.translateLanguages || [];
  sttModels = cfg.sttModels || [];
  defaultSttModel = cfg.defaultSttModel || "";
  otherTools = cfg.otherTools || [];
  defaultEmbedModel = cfg.defaultEmbedModel || "";
  judgeUsdPerImage = Number(cfg.judgeUsdPerImage) || 0;
  judgeMaxImages = Number(cfg.judgeMaxImages) || 1;
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

async function startApp() {
  $("app").classList.remove("hidden");
  initShell();
  // Before anything can build a media URL, and before the gallery is touched.
  await refreshResultToken();
  requestPersistentStorage();
  buildModelSelect();
  // Fall back to whatever the picker lists first if the named default ever
  // leaves the catalogue, so startup cannot break on a stale id.
  const first = $("model-select").querySelector("option");
  const wanted = MODELS.some((m) => m.id === defaultModel) ? defaultModel : first && first.value;
  selectModel(wanted || MODELS[0].id);
  initPromptLibrary();
  initStopButton();
  refreshNeurons();
  $("footer-note").textContent =
    "Generations are proxied through a Cloudflare Worker. Nothing is stored server-side; your current " +
    "edit — files, prompt, model and settings — the recent images and videos with the settings that " +
    "made them, and a running job's id are kept in this browser only, so a closed tab picks up where " +
    "it left off. Recent results are dropped after a week, and Clear removes them now.";
  // Puts the last session's files, prompt, model and settings back before any
  // of the listeners below can overwrite the saved snapshot.
  await restoreSession();
  initSessionPersistence();
  initRecent();
  // Anything that aged out while the app was closed goes before it is shown.
  pruneGallery().then(renderRecent);
  // Last, so a recovered job cannot delay the UI becoming usable.
  resumeInFlightJob();
}

// ---------------------------------------------------------------------------
// Model select (grouped)
// ---------------------------------------------------------------------------
// Sections read "<task> \u00b7 <provider>". Task comes first because that is
// what you pick by; provider second because it decides what an option costs
// and which key it needs, and because two providers ship models under the
// same name (FLUX.2 Klein 4B is on both Pruna and Workers AI).
// The first four sections are pinned in a requested order rather than derived,
// because it does not follow from either grouping key on its own: Pruna editing
// and video first, then Grok images and video. Everything else falls through to
// the group/provider ordering below.
const SECTION_ORDER = [
  ["Image editing", "pruna"],
  ["Video", "pruna"],
  ["Image generation", "xai"],
  ["Video", "xai"],
];
const GROUP_ORDER = ["Image editing", "Image generation", "Video", "Audio", "LoRA training"];
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
  const pinned = (g, p) => {
    const i = SECTION_ORDER.findIndex(([sg, sp]) => sg === g && sp === p);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  const keys = [...sections.keys()].sort((a, b) => {
    const [ga, pa] = a.split("\u0000");
    const [gb, pb] = b.split("\u0000");
    return (
      pinned(ga, pa) - pinned(gb, pb) ||
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
  // Same reason as Reset: an uncommitted edit has to make it into the history
  // before the prompt element goes away.
  commitPromptHistory();
  // A restore is not a switch: every value is about to be written from the
  // snapshot, so carrying anything over from the model shown at boot would only
  // leak that model's defaults into fields the snapshot does not mention.
  if (currentModel && !restoringSession) {
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
  // The undo history survives the switch: it holds text, not the element the
  // text was typed into. Committing here records whatever the new box ended up
  // with — usually the same text carried straight over, in which case this is a
  // no-op; a new model's own default, or an empty box after a model with no
  // prompt field at all, becomes an entry you can undo back out of.
  commitPromptHistory();
  scheduleSessionSave();
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

// Reads a media file's duration (and, for video, its resolution) client-side —
// nothing is uploaded to do this — so per-second costs can be estimated before
// the user hits Generate. Resolves to null on anything that isn't decodable
// metadata-only (huge files, unsupported codecs, etc.) rather than guessing.
//
// Audio counts too, because several models take an audio track that overrides
// the duration setting and therefore decides the bill: p-video, p-video-2 and
// p-video-infiniteworlds all document audio as setting the length.
function probeMediaMeta(file) {
  return new Promise((resolve) => {
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    if (!isVideo && !isAudio) return resolve(null);
    const url = URL.createObjectURL(file);
    // Two literal tag names rather than one computed one. Behaviour is
    // identical, but an element built from a dynamic string cannot be resolved
    // statically: analysis then has to assume `el.src` below might be an
    // <iframe>, and flags the blob: URL as a possible script-injection sink
    // (CodeQL js/xss-through-dom, raised when this was a ternary). Neither
    // <video> nor <audio> parses HTML or runs script from src, and
    // createObjectURL only ever mints blob:<origin>/<uuid>, so the warning was
    // never a real finding — but proving that beats suppressing the query.
    const el = isVideo ? document.createElement("video") : document.createElement("audio");
    el.preload = "metadata";
    el.muted = true;
    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    el.onloadedmetadata = () => {
      const durationSec = Number.isFinite(el.duration) ? el.duration : null;
      const h = (isVideo && el.videoHeight) || 0;
      // Bucket into the resolution tiers xAI actually publishes rates for.
      const resBucket = h && h <= 480 ? "480p" : h && h <= 720 ? "720p" : null;
      done(durationSec ? { durationSec, resBucket } : null);
    };
    el.onerror = () => done(null);
    el.src = url;
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

// Speech is priced by what is said, not by a picture's size, so the 1024x1024
// sample the image models quote means nothing here.
function speechRateBlurb(p) {
  if (p.perAudioMin != null) {
    return `Workers AI: ~${p.perAudioMin} neurons per minute of speech — the length is only known once it is spoken.`;
  }
  return (
    `Workers AI: ~${Math.round(p.perKChars).toLocaleString()} neurons per 1,000 characters ` +
    `(${fmtUsd((p.perKChars * CF_USD_PER_NEURON))} past the free allowance).`
  );
}

// The live line under a text-to-speech box: what this text will cost as typed.
function speechEstimateText(model, text) {
  const p = model && model.price;
  if (!p || p.type !== "cf_neurons") return "";
  if (p.perAudioMin != null) return speechRateBlurb(p);
  const n = estimateNeurons(model, { text });
  if (!n) return speechRateBlurb(p);
  const pct = (n / CF_FREE_NEURONS) * 100;
  return (
    `${text.length.toLocaleString()} characters ≈ ${Math.round(n).toLocaleString()} neurons ` +
    `(${pct < 1 ? "<1" : Math.round(pct)}% of the daily free allowance, ${fmtUsd(n * CF_USD_PER_NEURON)} past it).`
  );
}

function defaultSteps(model) {
  const f = model.fields.find((x) => x.name === "steps" || x.name === "num_steps");
  return f ? f.default : 0;
}

function priceBlurb(model) {
  const p = model.price;
  if (!p) return "";
  if (p.type === "cf_neurons" && (p.perKChars != null || p.perAudioMin != null)) return speechRateBlurb(p);
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
  if (p.type === "video_second_draft") {
    return (
      `List price: ${fmtUsd(p.usd.normal)} per second of output video, ` +
      `${fmtUsd(p.usd.draft)} in draft mode. The output is as long as your source clip.`
    );
  }
  if (p.type === "per_second_flat") {
    return `List price: ${fmtUsd(p.usd)} per second of output video, at any resolution.`;
  }
  if (p.type === "per_second_mode") {
    return (
      `List price: ${fmtUsd(p.usd["480p"].cost)}–${fmtUsd(p.usd["768p"].quality)}/s ` +
      `depending on resolution and mode (mode defaults to speed).`
    );
  }
  if (p.type === "routed_text") {
    return (
      `List price: ${fmtUsd(p.usd.noText)} per output, or ${fmtUsd(p.usd.text)} when the model ` +
      `detects text in the image — which is decided during the run, so the rate is not known up front.`
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
// The model's main text box, the one the prompt tools act on. Same order as
// primaryPromptEl(), which finds it again once the form is built.
function primaryFieldOf(model) {
  for (const name of ["prompt", "voice_script", "instruction_prompt"]) {
    const f = model.fields.find((x) => x.name === name);
    if (f) return f;
  }
  return model.fields.find((x) => x.type === "textarea") || null;
}

// The prompt toolbar is one element for the life of the page, moved under
// whichever box is the prompt each time the fields are built.
const PROMPT_TOOLS = $("prompt-tools");

function fieldSection(title, cls) {
  const s = document.createElement("section");
  s.className = "form-section " + cls;
  if (title) {
    const h = document.createElement("h2");
    h.className = "section-title";
    h.textContent = title;
    s.appendChild(h);
  }
  return s;
}

// The form reads top to bottom in the order the work is done: the mode, when a
// model has one, since it decides which inputs apply; every file the model
// takes, required or not, so none of them hides among the tuning; the prompt
// with its tools under it; any other required value; then the settings.
function renderFields() {
  const wrap = $("fields");
  // Out of the way first, so clearing the fields does not take it with them.
  $("gen-form").appendChild(PROMPT_TOOLS);
  wrap.innerHTML = "";
  fieldUI = {};
  optionRows = [];
  optionsPanel = null;
  optionsBadge = null;
  visibilityRows = [];

  const fields = currentModel.fields;
  const modeNames = new Set(fields.filter((f) => f.showWhen).map((f) => f.showWhen.field));
  const primary = primaryFieldOf(currentModel);
  const mode = [];
  const inputs = [];
  const rest = [];
  const optional = [];
  for (const f of fields) {
    if (f === primary) continue;
    if (f.required && modeNames.has(f.name)) mode.push(f);
    else if (f.type === "image") inputs.push(f);
    else if (f.required) rest.push(f);
    else optional.push(f);
  }
  const addRequired = (parent, f) => {
    const row = renderRequired(f);
    parent.appendChild(row);
    if (f.showWhen) visibilityRows.push({ f, row });
  };
  // An optional field outside Settings keeps its option-row behaviour — the
  // "changed" mark, its own Reset, the touched flag — and is labelled optional.
  const addOptional = (parent, f) => parent.appendChild(buildOptionRow(f, "optional"));

  if (mode.length) {
    const s = fieldSection("", "section-mode");
    for (const f of mode) addRequired(s, f);
    wrap.appendChild(s);
  }
  if (inputs.length) {
    const s = fieldSection("Inputs", "section-inputs");
    for (const f of inputs) (f.required ? addRequired : addOptional)(s, f);
    wrap.appendChild(s);
  }
  if (primary) {
    const s = fieldSection("", "section-prompt");
    (primary.required ? addRequired : addOptional)(s, primary);
    s.appendChild(PROMPT_TOOLS);
    wrap.appendChild(s);
  } else {
    wrap.appendChild(PROMPT_TOOLS);
  }
  // The tools need a prompt box to read and write, so a model without one
  // offers none of them rather than buttons that can only say so.
  PROMPT_TOOLS.classList.toggle("hidden", !primary);
  if (rest.length) {
    const s = fieldSection("", "section-more");
    for (const f of rest) addRequired(s, f);
    wrap.appendChild(s);
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
  // The prompt element has been replaced, so the buttons' enabled state has to
  // be recomputed against the new box — the history itself carries over, and
  // every caller settles the new text and commits it afterwards.
  updatePromptHistoryButtons();
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
    // A preset's trigger word has to appear in the prompt to do anything, so
    // it goes straight into the prompt box. Switching presets swaps the word
    // rather than stacking them, and anything already typed is kept.
    let applied = "";
    sel.addEventListener("change", () => {
      const preset = f.presets.find((p) => p.value === sel.value);
      i.value = preset ? preset.value : i.value;
      const box = primaryPromptEl();
      if (!box) return;
      let text = box.value;
      // Strip the previous preset's word from the front. Anchored and
      // whitespace-tolerant: matching on the stored "word + space" missed when
      // the box held the word alone, which stacked them instead of swapping.
      if (applied) {
        const esc = applied.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp("^" + esc + "\\s*"), "");
      }
      const word = preset && preset.hint ? preset.hint : "";
      box.value = word ? (text ? word + " " + text : word) : text;
      applied = word;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      commitPromptHistory(); // swapping the trigger word is one discrete change
    });
    wrap.appendChild(sel);
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

// name -> { redraw, box } for every image field currently rendered. Lets an
// image be dropped into a field from outside without calling renderFields(),
// which would rebuild the form and wipe every typed value. Rebuilt with the
// fields.
let fieldUI = {};

// Files handed over by "use this output as input" for the model being switched
// to. Separate from carryFiles because selectModel overwrites that one with the
// outgoing model's own uploads. The kind rides alongside so the file lands in a
// field that takes it — a clip must not be adopted into a picture slot.
let pendingAdopt = [];
let pendingAdoptKind = "image";

// Takes File objects the user did not just pick — carried across a model switch,
// or restored from the last session — into one image field. The thumbnail is
// shown straight away and the provider encoding runs behind it, because each
// provider wants a different one (a Pruna upload, base64, a data: URI) and a
// restored file has no usable encoding from last time.
function adoptFiles(f, files, redraw, failPrefix) {
  for (const file of files) {
    const placeholder = { file, url: null, name: file.name, isImage: file.type.startsWith("image/"), preview: null, uploading: true };
    if (placeholder.isImage) placeholder.preview = URL.createObjectURL(file);
    uploads[f.name].push(placeholder);
    probeMediaMeta(file).then((meta) => {
      if (meta) Object.assign(placeholder, meta);
    });
    encodeForField(f, file)
      .then((url) => { placeholder.url = url; placeholder.uploading = false; })
      .catch((e) => {
        releasePreview(placeholder);
        const i = uploads[f.name].indexOf(placeholder);
        if (i >= 0) uploads[f.name].splice(i, 1);
        redraw();
        setStatus(failPrefix + ": " + e.message, "err");
      });
  }
}

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
    // Every path that adds, swaps or drops a file lands here, so this is the
    // one place the snapshot has to follow.
    scheduleSessionSave();
  };

  fieldUI[f.name] = { redraw, box };

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
      probeMediaMeta(file).then((meta) => {
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

  // A generation being sent into this model claims its slot before the outgoing
  // model's own uploads do: "edit this image" is a request about that image, so
  // it must not be crowded out by files that merely came along for the ride.
  if (pendingAdopt.length && fieldVisible(f) && fieldTakes(f, pendingAdoptKind) && uploads[f.name].length < maxItems) {
    adoptFiles(f, pendingAdopt.splice(0, maxItems - uploads[f.name].length), redraw, "Could not use that image");
  }

  // Adopt files carried over from the previously selected model. Skipped for a
  // field the current mode hides -- adopting there swallowed the file into a
  // control the user cannot see, which looked like the upload disappearing.
  if (carryFiles.length && fieldVisible(f)) {
    adoptFiles(f, carryFiles.splice(0, maxItems - uploads[f.name].length), redraw, "Could not carry image over");
  }

  // Files put back from the last session's snapshot. Field-keyed rather than a
  // flat list, so no visibility check is needed: each file returns to the field
  // it was chosen for, and that field's own mode value is restored right after.
  if (restoreFiles[f.name] && restoreFiles[f.name].length) {
    adoptFiles(f, restoreFiles[f.name].splice(0, maxItems - uploads[f.name].length), redraw, "Could not restore an upload");
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
  if (noun === "audio") box.appendChild(voicePanel(f, redraw));
  redraw();
  return box;
}

// A voice track made in place, for the video models that take audio. It runs
// the same Workers AI speech models the picker offers, through /api/generate,
// and the MP3 it returns becomes this field's file exactly as a picked one
// would — replacing whatever was there, since each of these fields holds one.
function voicePanel(f, redraw) {
  const speech = MODELS.filter((m) => m.kind === "audio");
  const det = document.createElement("details");
  det.className = "tts-panel";
  const sum = document.createElement("summary");
  sum.textContent = "🔊 Generate voice";
  det.appendChild(sum);
  if (!speech.length) return det;

  const text = document.createElement("textarea");
  text.className = "tts-text";
  text.rows = 3;
  text.placeholder = "What should be said";

  const modelSel = document.createElement("select");
  modelSel.className = "tts-model";
  for (const m of speech) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  }

  // Aura models take a named voice; MeloTTS takes a language code instead.
  const voiceSel = document.createElement("select");
  voiceSel.className = "tts-voice";
  const lang = document.createElement("input");
  lang.type = "text";
  lang.className = "tts-lang";

  const est = document.createElement("p");
  est.className = "help tts-estimate";

  const go = document.createElement("button");
  go.type = "button";
  go.className = "secondary tts-go";
  go.textContent = "Generate voice";

  const model = () => speech.find((m) => m.id === modelSel.value);
  const textField = () => model().fields.find((x) => x.type === "textarea");
  const refresh = () => {
    const m = model();
    const speaker = m.fields.find((x) => x.name === "speaker");
    const langField = m.fields.find((x) => x.name === "lang");
    voiceSel.innerHTML = "";
    if (speaker) {
      for (const o of speaker.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        opt.selected = o.value === speaker.default;
        voiceSel.appendChild(opt);
      }
    }
    voiceSel.classList.toggle("hidden", !speaker);
    lang.classList.toggle("hidden", !langField);
    if (langField && !lang.value) lang.value = langField.default;
    est.textContent = speechEstimateText(m, text.value);
  };
  modelSel.addEventListener("change", refresh);
  text.addEventListener("input", () => (est.textContent = speechEstimateText(model(), text.value)));

  go.addEventListener("click", async () => {
    const m = model();
    const said = text.value.trim();
    if (!said) {
      setStatus("Write what the voice should say first.", "err");
      return;
    }
    const input = { [textField().name]: said };
    if (!voiceSel.classList.contains("hidden")) input.speaker = voiceSel.value;
    if (!lang.classList.contains("hidden") && lang.value.trim()) input.lang = lang.value.trim();
    go.disabled = true;
    const idle = go.textContent;
    go.textContent = "Generating…";
    setStatus(`Generating voice with ${m.label}…`, "load");
    try {
      const res = await api("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: m.id, input }),
      });
      const data = await res.json();
      const uri = data && Array.isArray(data.images) ? data.images[0] : null;
      if (!res.ok || !uri) throw new Error((data && data.error) || `HTTP ${res.status}`);
      const blob = await (await fetch(uri)).blob();
      const file = new File([blob], `voice-${Date.now()}.mp3`, { type: blob.type || "audio/mpeg" });
      for (const u of uploads[f.name]) releasePreview(u);
      uploads[f.name].length = 0;
      adoptFiles(f, [file], redraw, "Could not attach the voice");
      redraw();
      const n = estimateNeurons(m, input);
      if (n) sessionNeurons += n;
      updateSpendBar();
      setTimeout(refreshNeurons, 4000);
      setStatus(`Voice attached to ${f.label}.`, "ok");
    } catch (e) {
      setStatus("Voice failed: " + e.message, "err");
    } finally {
      go.disabled = false;
      go.textContent = idle;
    }
  });

  const pickers = document.createElement("div");
  pickers.className = "tts-row";
  pickers.appendChild(modelSel);
  pickers.appendChild(voiceSel);
  pickers.appendChild(lang);
  det.appendChild(text);
  det.appendChild(pickers);
  det.appendChild(est);
  det.appendChild(go);
  refresh();
  return det;
}

function renderRequired(f) {
  const field = document.createElement("label");
  field.className = "field";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = f.label + " *";
  field.appendChild(label);
  const control = inputControl(f);
  field.appendChild(control);
  if (f.help) {
    const h = document.createElement("p");
    h.className = "help";
    h.textContent = f.help;
    field.appendChild(h);
  }
  // Speech bills per character, and a long script can take a real share of the
  // day's allowance, so the cost follows the text as it is typed.
  if (currentModel && currentModel.kind === "audio" && f.type === "textarea") {
    const est = document.createElement("p");
    est.className = "help tts-estimate";
    const model = currentModel;
    const update = () => (est.textContent = speechEstimateText(model, control.value || ""));
    control.addEventListener("input", update);
    update();
    field.appendChild(est);
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
  title.textContent = "Settings";
  const badge = document.createElement("span");
  badge.className = "opt-badge";
  sum.appendChild(title);
  sum.appendChild(badge);
  det.appendChild(sum);

  const list = document.createElement("div");
  list.className = "opt-list";
  // Resets what is in this panel and nothing else: the inputs and the prompt
  // above are left as they are. "Start over" is the one that clears those.
  const resetAll = document.createElement("button");
  resetAll.type = "button";
  resetAll.className = "linkish opt-reset-all";
  resetAll.textContent = "Reset all settings";
  resetAll.addEventListener("click", resetAllSettings);
  list.appendChild(resetAll);
  for (const f of fields) list.appendChild(buildOptionRow(f));
  det.appendChild(list);

  det.dataset.badge = "";
  optionsPanel = det;
  optionsBadge = badge;
  return det;
}

function resetAllSettings() {
  for (const r of optionRows) {
    if (r.f.type === "image" || !optionsPanel || !optionsPanel.contains(r.row)) continue;
    resetField(r.f, r.row); // dispatches "change", which touches the row
    r.touched = false;
  }
  refreshOptionState();
  scheduleSessionSave();
}

function buildOptionRow(f, tag) {
  const row = document.createElement("div");
  row.className = "opt-row";

  const head = document.createElement("div");
  head.className = "opt-row-head";
  const name = document.createElement("span");
  name.className = "opt-name";
  name.textContent = f.label;
  if (tag) {
    const t = document.createElement("span");
    t.className = "opt-tag";
    t.textContent = tag;
    name.appendChild(document.createTextNode(" "));
    name.appendChild(t);
  }
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
  // A field with no declared default reads back as "", not undefined, so
  // comparing the two marked every such field changed the moment it rendered
  // -- the HuggingFace token and both 2nd-LoRA boxes among them.
  //
  // wrapArray fields read back as [1] while their default is 1, which flagged
  // 2nd LoRA strength on every render for the same reason: comparing the sent
  // shape against the declared one.
  const bare = f.wrapArray && Array.isArray(v) && v.length === 1 ? v[0] : v;
  return bare !== (f.default === undefined ? "" : f.default);
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
  // Attaching or removing an image changes what Judge and the chat would read,
  // and where a generated image would land if it were reused.
  updateJudgeNote();
  renderChatImages();
  updateChatNote();
  refreshReuseLabels();
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
    // The badge counts what is inside the Settings panel; an optional input or
    // prompt above it is in plain view already.
    if (isChanged && optionsPanel && optionsPanel.contains(r.row)) changed++;
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
// A bare "Processing… 200s elapsed" is indistinguishable from a hang, which is
// exactly how a correct run of a multi-minute model reads. So say what is
// normal while the job is in flight — the blurb was read once before pressing
// Generate and is no help four minutes in.
//
// The catalogue carries `typicalSeconds` on one model out of forty-eight, which
// left the hint inert for every other slow one. Rather than guess the rest, the
// app measures: every run it watches start to finish is timed, and the median
// of the last few is a better number than a hand-set one anyway — it is this
// account, this device and this connection. The two read differently on
// purpose, because they are different claims.
const RUNTIME_KEY = "patchbay_runtimes";
const RUNTIME_SAMPLES = 5;
// Below this a run is over before the status line can be read, so a hint is
// noise rather than reassurance.
const RUNTIME_HINT_FLOOR_S = 15;

function loadRuntimes() {
  try {
    const v = JSON.parse(localStorage.getItem(RUNTIME_KEY));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function recordRuntime(modelId, secs) {
  if (!modelId || !(secs > 0)) return;
  try {
    const all = loadRuntimes();
    const list = Array.isArray(all[modelId]) ? all[modelId].filter((n) => typeof n === "number") : [];
    list.push(Math.round(secs));
    all[modelId] = list.slice(-RUNTIME_SAMPLES);
    localStorage.setItem(RUNTIME_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — the hint is a convenience, not a requirement */
  }
}

// Median rather than mean: one run that hit a cold model or a bad connection
// should not drag the number it is meant to describe.
function measuredSeconds(modelId) {
  const list = loadRuntimes()[modelId];
  if (!Array.isArray(list) || !list.length) return null;
  const sorted = list.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const fmtDuration = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${s}s`);

function slowHint(model) {
  if (!model) return "";
  const mine = measuredSeconds(model.id);
  if (mine != null && mine >= RUNTIME_HINT_FLOOR_S) return ` · your last runs took about ${fmtDuration(mine)}`;
  const t = model.typicalSeconds;
  if (!t) return "";
  return ` · usually about ${fmtDuration(t)}`;
}

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
  // The old output is gone from the panel, so it is no longer something Judge
  // can offer to score.
  lastResult = { urls: [], kind: null, blobs: [] };
  clearJudgeResult();
  const kind = currentModel.kind;
  const model = currentModel;
  const started = Date.now();
  // Taken now rather than when the result lands: the point is the settings that
  // produced this run, and Improve or a model switch could move them meanwhile.
  const promptEl = primaryPromptEl();
  const meta = {
    modelId: model.id,
    prompt: promptEl ? promptEl.value : "",
    setup: currentSetupSnapshot(),
  };
  setStatus("Submitting…", "load");
  showStopButton(true);
  generationInFlight = true;

  const timer = runTimer({ model: model.id, kind, startedAt: started });
  let downloading = null;
  try {
    const progress = (state, secs) => setStatus(`${cap(state)}… ${secs}s elapsed${slowHint(model)}`, "load");
    const urls = await runGeneration(model.id, input, kind, progress, timer);
    if (!urls.length) throw new Error("No output URL returned.");
    // The provider is finished but nothing is on screen yet. The count used to
    // freeze here for the whole download, which read as a hang and left the
    // download out of the time the run was said to take.
    downloading = progressTicker(progress, started);
    downloading.set("downloading");
    let secs = null;
    const shownAt = () => {
      downloading.stop();
      secs = Math.round((Date.now() - started) / 1000);
    };
    await showResult(urls, kind, meta, { timer, onDisplayed: shownAt });
    if (secs === null) shownAt();
    // A run this tab watched start to finish, so it is a measurement of the
    // model rather than of when someone happened to reopen the app. It ends
    // when the result is on screen; the gallery save after that is not the
    // model's time.
    recordRuntime(model.id, secs);
    const cost = addSpend(model, input, urls.length);
    // Analytics lag inference slightly, so give it a moment before re-reading.
    setTimeout(refreshNeurons, 4000);
    setStatus(`Done in ${secs}s.${cost ? " " + cost : ""}`, "ok");
  } catch (err) {
    timer.finish(err.message === STOPPED ? "stopped" : "error: " + err.message);
    setStatus(err.message === STOPPED ? stoppedMessage(kind) : "Error: " + err.message, err.message === STOPPED ? "ok" : "err");
  } finally {
    if (downloading) downloading.stop();
    btn.disabled = false;
    showStopButton(false);
    stopWatching = false;
    generationInFlight = false;
  }
});

$("reset-btn").addEventListener("click", () => {
  // Before the box is rebuilt, so a burst of typing that has not hit its commit
  // boundary yet is still in the history to come back to.
  commitPromptHistory();
  clearUploads();
  renderFields();
  clearJudgeResult();
  setStatus("", "hide");
  // Reset puts every field back to its default, the prompt included. That is a
  // change to the prompt like any other, so it becomes an undo entry — Undo
  // brings the prompt back, though only the prompt: the rest stays reset.
  commitPromptHistory();
  scheduleSessionSave();
});

// Providers word failures under different keys and the Worker passes their
// JSON straight through, so read all of them before falling back to a bare
// status code. Pruna's own refusals use {title, detail} — a disabled
// deployment answers 422 with nothing under `error` or `message` at all, which
// used to reach the status line as an unexplained "HTTP 422".
function providerErrorText(data, status, fallback) {
  const parts = [data && data.error, data && data.message, data && data.title, data && data.detail]
    .filter((v) => typeof v === "string" && v.trim());
  if (!parts.length) return fallback || `HTTP ${status}`;
  // title and detail are complementary ("Deployment disabled" + why), so keep
  // both when they differ rather than showing only the headline.
  const seen = [];
  for (const p of parts) if (!seen.some((s) => s.includes(p))) seen.push(p.trim());
  return seen.join(" — ").replace(/\s*\n\s*-\s*/g, " ").replace(/\s+/g, " ");
}

// Try-Sync used to be requested for every image model except the two known to
// hang past it (forceAsync in models.js). That was the bug behind "closed the
// PWA mid-job, reopened, nothing to resume": a Try-Sync generation runs entirely
// inside one fetch, and saveJob() only ever ran on the *fallback* response —
// never on a synchronous success. So for most image models there was no job id
// to persist until that single request already finished, and closing the app at
// any point before it resolved (a network blip, the phone reclaiming the tab, a
// slow model outrunning Cloudflare's own gateway timeout) discarded the run with
// nothing to reattach to — a total loss, not merely an interrupted one, since a
// bare 504 with no body carries no id either.
//
// Sync is no longer requested for anything: every generation now gets an id
// back near-instantly and is polled, which is the same path forceAsync models
// already used successfully. `forceAsync` in models.js is consequently inert —
// left in place as documentation of which models are known to run especially
// long, not because anything still reads it.
// Fourteen of the forty-eight models never get a job id: Workers AI and xAI's
// image endpoints run the whole generation inside the /api/generate request and
// answer with the finished picture. Same fact handleGenerate dispatches on.
function isSynchronous(spec) {
  if (!spec) return false;
  return spec.provider === "workers-ai" || (spec.provider === "xai" && !spec.xaiAsync);
}

// Drives the elapsed count for as long as a job runs.
//
// The poll loop is not a clock. The status line used to be written only when a
// poll came back, so between polls — and for the whole of any one that hung —
// it sat frozen at whatever it last said. A slow provider, a stalled
// connection, or an iOS tab suspended in the background (where setTimeout stops
// firing at all) would leave it reading eight seconds after three real minutes,
// which is worse than no count: it says the job has barely started.
//
// So the number comes from here, once a second, independent of the polling. It
// also repaints the instant the tab comes back rather than waiting up to a
// whole poll interval, which is the case that matters on a phone.
//
// Nothing renders until the first set(): the caller's own opening message
// ("Picking up the job you left running…") stays up until there is a real state
// to replace it with.
function progressTicker(onProgress, started) {
  let state = null;
  const render = () => {
    if (state !== null) onProgress(state, Math.round((Date.now() - started) / 1000));
  };
  const onVisible = () => {
    if (!document.hidden) render();
  };
  const timer = setInterval(render, 1000);
  document.addEventListener("visibilitychange", onVisible);
  return {
    set(next) {
      state = next;
      render();
    },
    stop() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

// ---------------------------------------------------------------------------
// Per-run timing
//
// A run is several legs in a row — submit, the status polls, the download, the
// picture decoding, the gallery save — and the status line only ever showed
// their sum. Two runs of the same edit could differ by twenty seconds with no
// way to tell from the phone which leg took them. This records each leg as an
// offset from the moment Generate was pressed, keeps the last few runs in this
// browser, and shows them under the result. Nothing leaves the device.
//
// `upstream` is the Worker's own time spent waiting on the provider for that
// request (the x-upstream-ms header), so a slow leg can be split into the
// phone-to-Worker part and the Worker-to-provider part.
// ---------------------------------------------------------------------------
const TIMING_KEY = "patchbay_timings";
const TIMING_RUNS = 20;
// A thirty-minute video job polls hundreds of times; the record keeps enough
// to see a pattern without letting one run crowd the others out of storage.
const TIMING_MAX_POLLS = 300;

function upstreamMs(res) {
  const v = res && res.headers ? Number(res.headers.get("x-upstream-ms")) : NaN;
  return Number.isFinite(v) ? v : null;
}

function attemptLog(list) {
  return (a) =>
    list.push({ attempt: a.attempt, ms: Math.round(a.ms), outcome: a.outcome, upstream: a.res ? upstreamMs(a.res) : null });
}

function runTimer({ model, kind, label, startedAt }) {
  const t0 = startedAt || Date.now();
  const rec = {
    at: new Date(t0).toISOString(),
    model,
    kind,
    label: label || "run",
    submit: null,
    polls: [],
    pollsDropped: 0,
    states: {},
    downloads: [],
    visible: null,
    saved: null,
    hiddenMs: 0,
    hiddenCount: 0,
    outcome: null,
  };
  const at = () => Date.now() - t0;
  let hiddenSince = document.hidden ? Date.now() : null;
  const onVis = () => {
    if (document.hidden) {
      if (hiddenSince === null) {
        hiddenSince = Date.now();
        rec.hiddenCount++;
      }
    } else if (hiddenSince !== null) {
      rec.hiddenMs += Date.now() - hiddenSince;
      hiddenSince = null;
    }
  };
  if (hiddenSince !== null) rec.hiddenCount++;
  document.addEventListener("visibilitychange", onVis);
  let done = false;
  return {
    rec,
    at,
    state(s) {
      if (s && !(s in rec.states)) rec.states[s] = at();
    },
    poll(entry) {
      if (rec.polls.length < TIMING_MAX_POLLS) rec.polls.push(entry);
      else rec.pollsDropped++;
    },
    finish(outcome) {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onVis);
      if (hiddenSince !== null) rec.hiddenMs += Date.now() - hiddenSince;
      rec.outcome = outcome;
      rec.total = at();
      saveTiming(rec);
    },
  };
}

function loadTimings() {
  try {
    const v = JSON.parse(localStorage.getItem(TIMING_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveTiming(rec) {
  try {
    const all = loadTimings();
    all.push(rec);
    localStorage.setItem(TIMING_KEY, JSON.stringify(all.slice(-TIMING_RUNS)));
  } catch {
    /* storage unavailable or full — the timing is a diagnostic, not a feature */
  }
}

const fmtS = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + "s");

function timingRows(rec) {
  const rows = [];
  const s = rec.submit;
  if (s) {
    rows.push(`Submit: ${fmtS(s.ms)}` + (s.upstream != null ? ` (Worker→provider ${fmtS(s.upstream)})` : ""));
  }
  const order = Object.entries(rec.states).sort((a, b) => a[1] - b[1]);
  if (order.length) rows.push("Provider states first seen: " + order.map(([k, v]) => `${k} at ${fmtS(v)}`).join(" → "));
  if (rec.polls.length) {
    const slowest = rec.polls.reduce((m, p) => (p.ms > m.ms ? p : m), rec.polls[0]);
    const timeouts = rec.polls.reduce((n, p) => n + p.attempts.filter((a) => a.outcome === "timeout").length, 0);
    const failed = rec.polls.reduce((n, p) => n + p.attempts.filter((a) => a.outcome === "network").length, 0);
    rows.push(
      `Status checks: ${rec.polls.length + rec.pollsDropped}, slowest ${fmtS(slowest.ms)} at ${fmtS(slowest.sent)}` +
        (slowest.upstream != null ? ` (Worker→provider ${fmtS(slowest.upstream)})` : "") +
        (timeouts ? `, ${timeouts} timed out` : "") +
        (failed ? `, ${failed} dropped` : "")
    );
  }
  rec.downloads.forEach((d, i) => {
    const tag = rec.downloads.length > 1 ? ` #${i + 1}` : "";
    rows.push(
      `Download${tag}: ${d.ok ? fmtS(d.ms) : "failed after " + fmtS(d.ms)}` +
        (d.bytes != null ? `, ${Math.round(d.bytes / 1024)} KB` : "") +
        (d.upstream != null ? ` (Worker→provider ${fmtS(d.upstream)})` : "") +
        (d.attempts.length > 1 ? `, ${d.attempts.length} attempts` : "")
    );
  });
  if (rec.visible != null) rows.push(`Visible at ${fmtS(rec.visible)}`);
  if (rec.saved != null) rows.push(`Saved to Recent at ${fmtS(rec.saved)}`);
  rows.push(rec.hiddenCount ? `App in background: ${fmtS(rec.hiddenMs)} (${rec.hiddenCount}×)` : "App in background: never");
  return rows;
}

function timingSummary(rec) {
  const parts = [];
  if (rec.visible != null) parts.push(`visible ${fmtS(rec.visible)}`);
  const done = rec.states.succeeded;
  if (done != null && rec.submit) parts.push(`provider ${fmtS(done - rec.submit.returned)}`);
  const dl = rec.downloads.reduce((n, d) => n + d.ms, 0);
  if (rec.downloads.length) parts.push(`download ${fmtS(dl)}`);
  if (rec.hiddenMs) parts.push(`background ${fmtS(rec.hiddenMs)}`);
  return parts.join(" · ") || "no steps recorded";
}

async function copyText(text, btn, idle) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be refused outright; a selected field still lets a
    // long-press copy it.
    const row = btn.parentElement;
    let ta = row.nextElementSibling;
    if (!ta || !ta.classList.contains("timing-copy")) {
      ta = document.createElement("textarea");
      ta.readOnly = true;
      ta.className = "timing-copy";
      row.after(ta);
    }
    ta.value = text;
    ta.select();
    btn.textContent = "Select and copy";
    return;
  }
  btn.textContent = "Copied";
  setTimeout(() => (btn.textContent = idle), 1500);
}

function timingBlock(rec) {
  const d = document.createElement("details");
  d.className = "timing";
  const sum = document.createElement("summary");
  sum.textContent = "⏱ Timing · " + timingSummary(rec);
  d.appendChild(sum);
  const list = document.createElement("ul");
  for (const r of timingRows(rec)) {
    const li = document.createElement("li");
    li.textContent = r;
    list.appendChild(li);
  }
  d.appendChild(list);
  const actions = document.createElement("div");
  actions.className = "timing-actions";
  const one = document.createElement("button");
  one.type = "button";
  one.className = "secondary";
  one.textContent = "Copy this run";
  one.addEventListener("click", () => copyText(JSON.stringify(rec), one, "Copy this run"));
  const all = document.createElement("button");
  all.type = "button";
  all.className = "secondary";
  all.textContent = `Copy last ${TIMING_RUNS}`;
  all.addEventListener("click", () =>
    copyText(loadTimings().map((r) => JSON.stringify(r)).join("\n"), all, `Copy last ${TIMING_RUNS}`)
  );
  actions.append(one, all);
  d.appendChild(actions);
  return d;
}

// Resolves once a picture is decoded and on screen, or has failed to — one
// that will not decode must not hold the status line. Clips and audio count as
// shown when they are placed: their bytes are already local, and iOS will not
// load an audio element before a tap, or autoplay a clip in Low Power Mode, so
// waiting on their events could stall for no reason.
function whenShown(el) {
  return new Promise((resolve) => {
    const done = () => resolve();
    if (el && el.tagName === "IMG") {
      const p = typeof el.decode === "function" ? el.decode() : null;
      if (p) p.then(done, done);
      else if (el.complete) done();
      else {
        el.addEventListener("load", done, { once: true });
        el.addEventListener("error", done, { once: true });
      }
      return;
    }
    done();
  });
}

async function runGeneration(model, input, kind, onProgress, timer) {
  lastActualCostUsd = null;
  const spec = MODELS.find((m) => m.id === model);
  // One clock for the whole run — the submit leg and the polling share it, so
  // the count does not restart when polling takes over.
  const started = Date.now();
  const ticker = onProgress ? progressTicker(onProgress, started) : null;

  try {
    // A synchronous model is generating from the first moment: Workers AI and
    // xAI's image endpoints run the whole thing inside this one request, and
    // there is never anything to poll.
    if (ticker) ticker.set(isSynchronous(spec) ? "generating" : "submitting");

    const sent = timer ? timer.at() : 0;
    const startRes = await api("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
    });
    const data = await startRes.json();
    if (timer) {
      const returned = timer.at();
      timer.rec.submit = { sent, returned, ms: returned - sent, http: startRes.status, upstream: upstreamMs(startRes) };
    }
    if (!startRes.ok) throw new Error(providerErrorText(data, startRes.status));

    // Workers AI returns finished images inline as data URIs (no job to poll).
    if (Array.isArray(data.images) && data.images.length) return data.images;
    if (data.status === "succeeded" && data.generation_url) return asUrlList(data.generation_url);
    if (data.status === "failed" || data.status === "error") {
      throw new Error(providerErrorText(data, startRes.status, "Generation failed."));
    }

    let id = data.id;
    if (!id && data.get_url) {
      const m = String(data.get_url).match(/status\/([^/?#]+)/);
      if (m) id = m[1];
    }
    if (!id) throw new Error("No job id returned. Response: " + JSON.stringify(data).slice(0, 240));

    // The job now exists on the provider and will run to completion whether or
    // not this tab survives, so record it before the first poll.
    saveJob({ id, model, kind, startedAt: Date.now() });
    if (ticker) ticker.set("processing");
    // The poll supplies the state word; the ticker keeps supplying the number,
    // including while a poll is in flight.
    return await pollJob(id, kind, (state) => ticker && ticker.set(state), started, timer);
  } finally {
    // Stopped on every path, or a failed run leaves a timer rewriting the
    // status line over the top of the message saying what went wrong.
    if (ticker) ticker.stop();
  }
}

// ---------------------------------------------------------------------------
// Stopping
//
// A generation held the whole UI for as long as it ran — up to 45 minutes for a
// training run — with no way out but closing the tab, which lost nothing but
// told you nothing either. Pruna documents no cancel endpoint, so this does not
// pretend to stop the job: it stops *watching* it. The job record was written
// before the first poll, so the next load reattaches through the path that
// already exists for a tab the phone discarded.
//
// The record is deliberately left in place — clearing it is what would turn a
// stop into a loss.
// ---------------------------------------------------------------------------
const STOPPED = "__stopped__";
let stopWatching = false;
// True from pressing Generate (or reattaching on load) until the result is on
// screen. The status line belongs to the run while this holds, so nothing
// incidental gets to write over it.
let generationInFlight = false;

function stoppedMessage(kind) {
  const what = kind === "file" ? "training run" : "job";
  return `Stopped watching. The ${what} is still running and still billed — reopen the app to collect it.`;
}

function showStopButton(on) {
  const b = $("stop-btn");
  if (!b) return;
  b.classList.toggle("hidden", !on);
  b.disabled = false;
  b.textContent = "Stop waiting";
}

function initStopButton() {
  const b = $("stop-btn");
  if (!b) return;
  b.addEventListener("click", () => {
    stopWatching = true;
    b.disabled = true;
    b.textContent = "Stopping…";
  });
}

const POLL_MS = 2500;
// Removing Try-Sync above traded away its main benefit: a fast image used to
// come back in a single round trip, and now always pays for at least one poll
// cycle. Most images finish in 1-3s (execution_time on p-image has run ~1.4s in
// earlier testing), so a coarse 2.5s cadence would be a felt slowdown on the
// single most common action. Images poll on a tighter cadence to close most of
// that gap; slower kinds keep the cadence above; a job's cost is what it costs
// regardless of how often its status is checked.
const IMAGE_POLL_MS = 900;
// A status check answers in well under a second when the connection is sound,
// so one still open after this long is stuck rather than slow: it is dropped
// and asked again. Without this a single hung poll held the run for as long as
// the OS kept the dead request open.
const STATUS_TIMEOUT_MS = 8000;

// Polls one provider job to a terminal state. Split out of runGeneration so a
// reload can reattach to a job this tab never saw start.
// `startedAt` carries runGeneration's clock in, so the elapsed count runs
// continuously from Generate rather than restarting at zero once an id comes
// back. A job picked up on reload passes nothing and counts from reattaching,
// which is what its own wording says.
async function pollJob(id, kind, onProgress, startedAt, timer) {
  const started = startedAt || Date.now();
  // Heavy video jobs (VACE especially) can run well past 10 minutes. LoRA
  // training is documented as "minutes to hours", so it gets the longest
  // budget this tab is willing to wait on.
  const maxMs = (kind === "file" ? 45 : kind === "video" ? 30 : 10) * 60 * 1000;
  while (true) {
    // Checked before each poll rather than mid-sleep, so the wait to act on a
    // Stop is one poll interval at worst. Thrown rather than returned, because
    // every caller already distinguishes a result from a throw — and this one
    // must not reach clearJob() below.
    if (stopWatching) throw new Error(STOPPED);
    const attempts = [];
    const sent = timer ? timer.at() : 0;
    // The body is read inside the deadline too; parsing it is not, so a
    // malformed reply still fails once rather than being retried.
    let got;
    try {
      got = await api("/api/status?id=" + encodeURIComponent(id), {
        timeoutMs: STATUS_TIMEOUT_MS,
        read: async (res) => ({ res, text: await res.text() }),
        onAttempt: attemptLog(attempts),
        // Same (state, seconds) shape the caller already formats, so a dropped
        // poll reads as "Reconnecting (1/3)… 12s elapsed" rather than stalling
        // on the last status with no sign anything went wrong.
        onRetry: (n, of) =>
          onProgress && onProgress(`reconnecting (${n}/${of})`, Math.round((Date.now() - started) / 1000)),
      });
    } catch (err) {
      if (timer) timer.poll({ sent, ms: timer.at() - sent, status: null, http: null, upstream: null, attempts, error: err.message });
      throw err;
    }
    const { res: sRes, text } = got;
    const s = JSON.parse(text);
    if (timer) {
      const back = timer.at();
      timer.poll({ sent, ms: back - sent, status: s.status || null, http: sRes.status, upstream: upstreamMs(sRes), attempts });
      timer.state(s.status);
    }
    if (!sRes.ok) throw new Error(providerErrorText(s, sRes.status));
    if (s.status === "succeeded") {
      // xAI reports the job's real dollar cost — prefer that over any estimate.
      lastActualCostUsd = typeof s.actual_cost_usd === "number" ? s.actual_cost_usd : null;
      clearJob(); // collected — nothing left to reattach to
      return asUrlList(s.generation_url || s.output || s.output_url);
    }
    // A failed Pruna prediction can answer HTTP 200 with {message, error} and
    // report no `status` at all. On the status checks alone that fell through to
    // the onProgress call below, so the loop kept saying "processing" until the
    // timeout and a failure was indistinguishable from a slow success. An
    // in-progress body is {message:"Generation in progress", status:"processing"}
    // with no `error` key, so treating a populated `error` as terminal cannot
    // misfire on a job that is merely still running.
    const errText = typeof s.error === "string" ? s.error.trim() : "";
    if (s.status === "failed" || s.status === "error" || s.status === "canceled" || errText) {
      clearJob(); // it will never produce anything — do not offer to reattach
      throw new Error(providerErrorText(s, sRes.status, "Generation failed."));
    }
    if (onProgress) onProgress(s.status || "processing", Math.round((Date.now() - started) / 1000));
    // Checked only after a poll that still reported work in progress. A phone
    // that suspended this tab past the deadline would otherwise throw a timeout
    // on resume without ever asking, discarding a job that had finished.
    if (Date.now() - started > maxMs) {
      const mins = Math.round(maxMs / 60000);
      throw new Error(
        kind === "file"
          ? `Still training after ${mins} min — this can take hours. The job keeps running ` +
            "on the provider; reopen the app later to pick it up."
          : `No result after ${mins} min. The job keeps running on the provider and is billed ` +
            "either way; reopen the app to pick it up, or try again with lighter settings."
      );
    }
    await sleep(kind === "image" ? IMAGE_POLL_MS : POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// In-flight job handoff
//
// A phone can discard this tab at any moment to reclaim memory, and the
// provider job keeps running — and billing — regardless. Keeping the job *id*
// lets the next load reattach and collect the result instead of paying for
// output nobody ever sees.
//
// Only the id and enough metadata to resume are kept, in this browser's
// localStorage. No image or video is stored: the media still streams from the
// provider through /api/result on demand, exactly as before, and none of this
// reaches the Worker. The `input` object is deliberately excluded — Workers AI
// and xAI models carry base64 and data: URI images inline, and writing those to
// disk is precisely what "don't store the images" rules out.
//
// Every accessor is wrapped: localStorage throws outright in some contexts
// (private windows, blocked site data) and a resume convenience must never be
// the thing that stops the app loading.
// ---------------------------------------------------------------------------
const JOB_KEY = "pruna_inflight_job";

// How long a record stays worth trying. Delivery URLs expire, so an ancient
// record is likely to resolve to nothing; training runs get far longer because
// they legitimately take hours.
const JOB_MAX_AGE_MS = { file: 6 * 60 * 60 * 1000, other: 60 * 60 * 1000 };

function saveJob(rec) {
  try {
    localStorage.setItem(JOB_KEY, JSON.stringify(rec));
  } catch {
    /* storage unavailable — resume is a convenience, not a requirement */
  }
}

function loadJob() {
  try {
    const v = JSON.parse(localStorage.getItem(JOB_KEY));
    return v && typeof v.id === "string" && v.id ? v : null;
  } catch {
    return null;
  }
}

function clearJob() {
  try {
    localStorage.removeItem(JOB_KEY);
  } catch {
    /* nothing to do */
  }
}

// Called once on boot. Picks up a job left running by a tab that went away.
async function resumeInFlightJob() {
  const rec = loadJob();
  if (!rec) return;

  const age = Date.now() - (Number(rec.startedAt) || 0);
  const maxAge = rec.kind === "file" ? JOB_MAX_AGE_MS.file : JOB_MAX_AGE_MS.other;
  // A negative age means the clock moved; treat it as unusable rather than
  // trusting it.
  if (!(age >= 0) || age > maxAge) {
    clearJob();
    return;
  }

  const btn = $("generate-btn");
  btn.disabled = true;
  const mins = Math.floor(age / 60000);
  const ago = mins < 1 ? "less than a minute ago" : `${mins} min ago`;
  setStatus(`Picking up the ${rec.model || "job"} you left running ${ago}…`, "load");
  showStopButton(true);
  generationInFlight = true;
  // Same clock discipline as a fresh run: a reattached job polls just as slowly
  // and freezes just as readily. Counts from reattaching rather than from the
  // original submit, which is what the wording says — the record's own
  // startedAt is not a measure of this tab's wait.
  const reattached = Date.now();
  const progress = (state, secs) => setStatus(`${cap(state)}… ${secs}s since reattaching`, "load");
  const ticker = progressTicker(progress, reattached);
  const timer = runTimer({ model: rec.model || "", kind: rec.kind, label: "reattached", startedAt: reattached });
  try {
    let urls;
    try {
      urls = await pollJob(rec.id, rec.kind, (state) => ticker.set(state), reattached, timer);
    } finally {
      // Stopped here rather than in the outer finally, which runs *after* the
      // closing message below — long enough for a tick to land on top of it.
      ticker.stop();
    }
    if (!urls.length) throw new Error("No output URL returned.");
    // Same as a fresh run: the count keeps going through the download rather
    // than freezing until the result lands.
    const downloading = progressTicker(progress, reattached);
    downloading.set("downloading");
    // The model comes from the job record; the prompt and the settings do not
    // exist to recover, since the record deliberately never held the input.
    try {
      await showResult(
        urls,
        rec.kind,
        { modelId: rec.model || "", prompt: "", setup: null },
        { timer, onDisplayed: () => downloading.stop() }
      );
    } finally {
      downloading.stop();
    }
    // No spend is added: the estimate needs the original input, which is not
    // stored, and this run was already paid for before the tab went away.
    // No runtime is recorded either — the elapsed time here is measured from
    // reattaching, which says nothing about how long the model takes.
    setStatus(`Recovered the ${rec.model || "job"} you left running.`, "ok");
  } catch (e) {
    // The record is left in place unless pollJob cleared it on a terminal
    // outcome, so another reload can try again.
    timer.finish(e.message === STOPPED ? "stopped" : "error: " + e.message);
    setStatus(e.message === STOPPED ? stoppedMessage(rec.kind) : "Could not finish the earlier job: " + e.message, e.message === STOPPED ? "ok" : "err");
  } finally {
    btn.disabled = false;
    showStopButton(false);
    stopWatching = false;
    generationInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Editing session persistence
//
// iOS discards a backgrounded PWA whenever it feels like it, and reopening from
// the home screen is a cold start: the prompt you were drafting, the model you
// picked, every option you changed and — worst of all — the photo you just took
// were all gone. This keeps that whole editing state in IndexedDB on the device.
//
// IndexedDB rather than localStorage because the uploads are the point: it
// stores Blobs, where localStorage would need every file base64'd into a string
// (a third larger, synchronous, and against a ~5 MB quota).
//
// On-device only. Nothing here is sent to the Worker or to any provider, which
// is the same line the prompt library and the in-flight job id already sit on:
// the "nothing is stored" rule is about provider media on servers, not about
// your own draft on your own phone. Restoring an upload does re-encode it for
// whichever provider the model uses — a Pruna file URL from last time has
// expired — and that upload is the same one you would have made by hand.
//
// The record is written in two halves under separate keys. The metadata half is
// small and rewritten on every change; the file half is only rewritten when the
// set of attached files actually changes, so typing a prompt with a 40 MB video
// attached does not rewrite that video every 600 ms.
//
// Every path is failure-tolerant: a browser with IndexedDB blocked (private
// windows, blocked site data, Lockdown Mode) or a full quota loses the restore
// and nothing else.
// ---------------------------------------------------------------------------
const DB_NAME = "patchbay";
// v2 added GALLERY_STORE beside the session one; v3 moved each gallery item's
// full-size bytes out into GALLERY_BYTES_STORE. Both upgrades are safe for a
// client holding an older database — the guards in onupgradeneeded leave an
// existing session untouched, and v3 migrates the images rather than dropping
// them.
const DB_VERSION = 3;
const DB_STORE = "session";
const GALLERY_STORE = "gallery";
const GALLERY_BYTES_STORE = "galleryBytes";
const META_KEY = "meta";
const FILES_KEY = "files";

// Old enough that the attached files are probably not what you meant to come
// back to, and past the point iOS itself starts evicting storage.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 600;
// A cap so one enormous clip cannot fail the whole write; the rest of the
// session still saves without it.
const MAX_PERSIST_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PERSIST_TOTAL_BYTES = 192 * 1024 * 1024;
// Tighter caps for the ArrayBuffer fallback below, which unlike the Blob path
// holds every byte in JS memory to write it. A 190 MB allocation on a phone
// risks the very tab kill this whole feature exists to survive, so that mode
// keeps what a camera roll actually produces — several photos and one short
// clip — and skips anything larger.
const MAX_BUFFER_FILE_BYTES = 24 * 1024 * 1024;
const MAX_BUFFER_TOTAL_BYTES = 48 * 1024 * 1024;

let dbPromise = null;
let saveTimer = null;
let persistenceReady = false; // nothing is written until the restore has run
let restoringSession = false;
let persistBroken = false; // one hard failure is enough to stop trying
let lastFilesSig = null;
// fieldName -> [File], consumed by the image controls as renderFields builds them.
let restoreFiles = {};

// Both stores below are best-effort by default, and WebKit evicts a best-effort
// origin least-recently-used under storage pressure and after a period without
// user interaction — only persistent mode is exempt, and it has to be asked for.
// That matters more now that a kept video is measured in hundreds of megabytes.
// https://webkit.org/blog/14403/updates-to-storage-policy/
//
// Deliberately not awaited by anything: a refusal costs durability, not
// function, and the caps below still apply either way.
async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* unavailable or refused — the stores still work, they are just evictable */
  }
}

function openSessionDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null); // no indexedDB at all, or access throws outright
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      // Keyed by a sortable id, so "newest first" and "drop the oldest" are
      // both just cursor order.
      if (!db.objectStoreNames.contains(GALLERY_STORE)) db.createObjectStore(GALLERY_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(GALLERY_BYTES_STORE)) db.createObjectStore(GALLERY_BYTES_STORE, { keyPath: "id" });

      // Coming from v2, every gallery record still carries its full-size bytes
      // inline. Move them rather than dropping them: they are the user's images,
      // and an upgrade does not get to decide that for them. A plain cursor walk
      // inside the versionchange transaction, so nothing is awaited outside it.
      if (req.transaction && db.objectStoreNames.contains(GALLERY_STORE)) {
        const light = req.transaction.objectStore(GALLERY_STORE);
        const heavy = req.transaction.objectStore(GALLERY_BYTES_STORE);
        light.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const rec = cursor.value;
          if (rec && rec.bytes) {
            heavy.put({ id: rec.id, bytes: rec.bytes });
            delete rec.bytes;
            cursor.update(rec);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

// Resolves rather than rejects throughout: a caller only ever wants "did it
// work", and an unhandled rejection here must not surface as an app error.
// { ok } separates a failed transaction from one that succeeded and found
// nothing, which a bare value cannot.
async function idbRun(storeName, mode, work) {
  const db = await openSessionDb();
  if (!db) return { ok: false, value: undefined };
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch {
      return resolve({ ok: false, value: undefined });
    }
    let value;
    tx.onabort = () => resolve({ ok: false, value: undefined });
    tx.onerror = () => resolve({ ok: false, value: undefined });
    tx.oncomplete = () => resolve({ ok: true, value });
    try {
      const req = work(tx.objectStore(storeName));
      if (req) req.onsuccess = () => { value = req.result; };
    } catch {
      resolve({ ok: false, value: undefined });
    }
  });
}

const idbGet = (key) => idbRun(DB_STORE, "readonly", (store) => store.get(key)).then((r) => r.value);
const idbPut = (key, value) => idbRun(DB_STORE, "readwrite", (store) => store.put(value, key)).then((r) => r.ok);
const idbDelete = (key) => idbRun(DB_STORE, "readwrite", (store) => store.delete(key)).then((r) => r.ok);

async function clearSession() {
  lastFilesSig = null;
  await idbDelete(META_KEY);
  await idbDelete(FILES_KEY);
}

// The raw control values, as shown. Deliberately not buildInput()'s output:
// that is the API payload (inverted bools, omitted defaults, array-wrapped
// singles), and what has to go back into the form is what the form displayed.
function snapshotFieldValues() {
  const form = $("gen-form");
  const out = {};
  for (const f of currentModel.fields) {
    if (f.type === "image") continue;
    const el = form.querySelector(`[data-field="${f.name}"]`);
    if (!el) continue;
    out[f.name] = f.type === "bool" ? el.checked : el.value;
  }
  return out;
}

// The form as it currently stands: its own values, plus which options were
// deliberately set, plus whether the panel was open. Shared by the session
// snapshot and by each gallery record, because both have to put the form back
// exactly as it was — and buildInput()'s payload cannot, since it inverts
// bools, omits defaults and wraps singles in arrays.
function currentSetupSnapshot() {
  if (!currentModel) return null;
  return {
    fields: snapshotFieldValues(),
    touched: optionRows.filter((r) => r.touched).map((r) => r.f.name),
    optionsOpen: Boolean(optionsPanel && optionsPanel.open),
  };
}

// Identifies the current set of attached files well enough to tell whether the
// stored copy is still the right one.
function uploadsSignature() {
  return Object.keys(uploads)
    .sort()
    .map((k) => k + "=" + uploads[k].map((u) => `${u.name}|${u.file ? u.file.size : 0}`).join(","))
    .join(";");
}

// Whether this browser will accept a Blob in an IndexedDB value at all. Some
// engines refuse every Blob shape — a File, a slice of one, even a Blob built
// from bytes already in memory — and abort the whole transaction with
// "Error preparing Blob/File data to be stored in object store", which silently
// cost the uploads while the rest of the session restored fine. Rather than
// guess per browser, the first file write tries Blobs and falls back to raw
// ArrayBuffers, which every engine stores; this remembers the answer so later
// writes go straight to what works.
let blobStorageWorks = true;

// `asBuffers` reads each file's bytes into memory instead of handing over a
// Blob the engine may refuse. Async either way so the two paths are called the
// same; the Blob path never awaits anything real.
async function collectFilesForPersist(asBuffers) {
  const maxFile = asBuffers ? MAX_BUFFER_FILE_BYTES : MAX_PERSIST_FILE_BYTES;
  const maxTotal = asBuffers ? MAX_BUFFER_TOTAL_BYTES : MAX_PERSIST_TOTAL_BYTES;
  const out = {};
  let total = 0;
  for (const field of Object.keys(uploads)) {
    for (const u of uploads[field]) {
      if (!u.file || u.file.size > maxFile) continue;
      if (total + u.file.size > maxTotal) continue;
      // The name and type ride alongside either way: a File's own name does not
      // survive every engine's structured clone, and the bytes carry neither.
      const rec = { name: u.name || u.file.name || "file", type: u.file.type || "" };
      if (asBuffers) {
        try {
          rec.buf = await u.file.arrayBuffer();
        } catch {
          continue; // unreadable file — skip it rather than fail the whole write
        }
      } else {
        rec.blob = u.file.slice();
      }
      total += u.file.size;
      if (!out[field]) out[field] = [];
      out[field].push(rec);
    }
  }
  return out;
}

async function saveSessionNow() {
  if (!persistenceReady || restoringSession || persistBroken || !currentModel) return;
  // `touched` matters as much as the values: it alone decides whether a value
  // equal to the default is still sent (see buildInput).
  const meta = { savedAt: Date.now(), modelId: currentModel.id, ...currentSetupSnapshot() };
  if (!(await idbPut(META_KEY, meta))) {
    persistBroken = true;
    return;
  }

  const sig = uploadsSignature();
  if (sig === lastFilesSig) return;
  let wrote = await writeFiles(meta.savedAt, blobStorageWorks);
  if (!wrote && blobStorageWorks) {
    // The Blob attempt failed. It may have been a quota rejection, but it is
    // just as likely this engine refuses Blobs outright, so try the bytes
    // before writing the uploads off.
    blobStorageWorks = false;
    wrote = await writeFiles(meta.savedAt, false);
  }
  // Either way this file set has had its turn: retrying a quota rejection on
  // every keystroke would just burn battery. A stored set that is now known to
  // be out of date is dropped rather than left to be restored later.
  lastFilesSig = sig;
  if (!wrote) await idbDelete(FILES_KEY);
}

async function writeFiles(savedAt, asBlobs) {
  return await idbPut(FILES_KEY, { savedAt, files: await collectFilesForPersist(!asBlobs) });
}

// Debounced, because the point is surviving a kill the app never sees coming —
// a write that only happens on the way out is a write that may never happen.
function scheduleSessionSave() {
  if (!persistenceReady || restoringSession || persistBroken) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessionNow, SAVE_DEBOUNCE_MS);
}

function flushSessionSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveSessionNow();
}

// Accepts either shape the writer above may have produced.
function fileFromRecord(rec) {
  if (rec instanceof File) return rec;
  if (!rec) return null;
  const body = rec.blob instanceof Blob ? rec.blob : rec.buf instanceof ArrayBuffer ? rec.buf : null;
  if (!body) return null;
  try {
    // Back to a real File, so previews, Describe, Judge and re-encoding all
    // treat it exactly like something just picked from the camera roll.
    return new File([body], rec.name || "file", { type: rec.type || (rec.blob && rec.blob.type) || "" });
  } catch {
    return null;
  }
}

async function loadSession() {
  const meta = await idbGet(META_KEY);
  if (!meta || typeof meta !== "object" || typeof meta.modelId !== "string") return null;
  const age = Date.now() - (Number(meta.savedAt) || 0);
  // A negative age means the clock moved; treat it as unusable rather than
  // trusting it, same as the in-flight job record.
  if (!(age >= 0) || age > SESSION_MAX_AGE_MS) {
    await clearSession();
    return null;
  }
  const rec = await idbGet(FILES_KEY);
  const files = rec && rec.files && typeof rec.files === "object" ? rec.files : {};
  return { meta, files };
}

async function restoreSession() {
  let saved = null;
  try {
    saved = await loadSession();
  } catch {
    /* unreadable store — carry on with a fresh session */
  }
  // Saving starts now whether or not there was anything to read back.
  persistenceReady = true;
  if (!saved) return;

  const { meta, files } = saved;
  // A model that has left the catalogue takes its field values with it.
  if (!MODELS.some((m) => m.id === meta.modelId)) {
    await clearSession();
    return;
  }

  restoringSession = true;
  try {
    restoreFiles = {};
    for (const field of Object.keys(files)) {
      if (!Array.isArray(files[field])) continue;
      const revived = files[field].map(fileFromRecord).filter(Boolean);
      if (revived.length) restoreFiles[field] = revived;
    }
    selectModel(meta.modelId); // renders the fields and adopts restoreFiles
    applyRestoredFields(meta);
    syncPromptHistory();
  } catch (e) {
    setStatus("Could not restore your last session: " + e.message, "err");
  } finally {
    restoreFiles = {};
    restoringSession = false;
    // The stored files are, by definition, the ones now attached.
    lastFilesSig = uploadsSignature();
  }
}

function applyRestoredFields(meta) {
  const form = $("gen-form");
  const values = meta.fields && typeof meta.fields === "object" ? meta.fields : {};
  for (const f of currentModel.fields) {
    if (f.type === "image" || !(f.name in values)) continue;
    const el = form.querySelector(`[data-field="${f.name}"]`);
    if (!el) continue;
    const v = values[f.name];
    if (f.type === "bool") {
      el.checked = Boolean(v);
    } else if (el.tagName === "SELECT") {
      // An enum whose options changed since the save keeps its default rather
      // than showing a value the model no longer offers.
      if (!Array.from(el.options).some((o) => o.value === String(v))) continue;
      el.value = String(v);
    } else {
      el.value = v == null ? "" : String(v);
    }
    // Drives the bool row's On/Off text and any field whose visibility depends
    // on this one — a restored mode has to bring its own fields back with it.
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Those dispatches marked every row they touched as deliberately edited. The
  // saved flags are the truth, so they go back last.
  const touched = new Set(Array.isArray(meta.touched) ? meta.touched : []);
  for (const r of optionRows) r.touched = touched.has(r.f.name);
  applyVisibility();
  refreshOptionState();
  if (optionsPanel && (meta.optionsOpen || (optionsBadge && optionsBadge.textContent))) optionsPanel.open = true;
}

function initSessionPersistence() {
  const form = $("gen-form");
  form.addEventListener("input", scheduleSessionSave);
  form.addEventListener("change", scheduleSessionSave);
  // The model picker sits outside the form, so it needs its own listener.
  $("model-select").addEventListener("change", scheduleSessionSave);
  // iOS gives no reliable notice before it kills a backgrounded PWA: unload
  // often never runs, and beforeunload is not fired for a page being discarded.
  // visibilitychange and pagehide are the two that do arrive, so they force a
  // write — but the debounce above is what actually makes this work, because by
  // the time either fires the snapshot is usually already on disk.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushSessionSave();
  });
  window.addEventListener("pagehide", flushSessionSave);
}

// ---------------------------------------------------------------------------
// Recent generations
//
// A finished result used to survive exactly until the next Generate cleared the
// panel, and the provider's delivery URL expires soon after, so anything not
// saved in that moment was gone. Finished images and videos are now kept on the
// device so you can look back, save one later, send it in as an input, or put
// the whole setup that produced it back on screen.
//
// Bounded by count, age and bytes — but per kind, because the two are nothing
// alike: one clip outweighs a hundred images, and under a single shared ceiling
// it would evict them. Clear empties both, as does clearing site data.
//
// Stored as ArrayBuffers, never Blobs. WebKit aborts the whole transaction for
// any value containing a Blob — a File, a slice of one, even a Blob built from
// bytes already in memory — while Chromium takes all of them, which is how the
// session store shipped broken once (#69). There is no reason for new code to
// rediscover that: bytes go in as bytes.
// ---------------------------------------------------------------------------
const GALLERY_LIMITS = {
  image: { items: 200, bytes: 1024 * 1024 * 1024, ageMs: 7 * 24 * 60 * 60 * 1000 },
  video: { items: 25, bytes: 4 * 1024 * 1024 * 1024, ageMs: 7 * 24 * 60 * 60 * 1000 },
};
// Seven days matches SESSION_MAX_AGE_MS, so everything this app keeps on the
// device expires on one clock. The byte ceilings are far inside what the engine
// allows — a Home Screen web app gets the same per-origin allowance as the
// browser, up to 60% of the disk — so the binding risk is eviction, which
// requestPersistentStorage() above is what actually answers.

// Records written before video was archivable carry no `kind` at all, and every
// one of them is an image.
const recordKind = (rec) => (rec && rec.kind === "video" ? "video" : "image");

// Long edge of the stored thumbnail. The strip decodes these rather than
// full-size images, which is how a phone keeps the tab alive.
const GALLERY_THUMB_PX = 320;

let galleryBroken = false; // one hard failure is enough to stop trying

// An item is two records in two stores, for the same reason the session record
// is split into a small half and a heavy one: the strip redraws on every
// generation and must not pay for bytes it does not display. The light record
// is the thumbnail and its metadata, about 20 KB; the full image is read only
// to open, reuse or save it.
const galleryGet = (id) => idbRun(GALLERY_STORE, "readonly", (st) => st.get(id)).then((r) => r.value);
const galleryBytesGet = (id) =>
  idbRun(GALLERY_BYTES_STORE, "readonly", (st) => st.get(id)).then((r) => (r.value ? r.value.bytes : undefined));

async function galleryPut(rec, bytes) {
  if (!(await idbRun(GALLERY_BYTES_STORE, "readwrite", (st) => st.put({ id: rec.id, bytes })).then((r) => r.ok))) return false;
  if (await idbRun(GALLERY_STORE, "readwrite", (st) => st.put(rec)).then((r) => r.ok)) return true;
  // The light record is what everything else finds an item by, so bytes without
  // one are unreachable. Drop them rather than leave them stranded.
  await idbRun(GALLERY_BYTES_STORE, "readwrite", (st) => st.delete(rec.id));
  return false;
}

async function galleryDelete(id) {
  await idbRun(GALLERY_BYTES_STORE, "readwrite", (st) => st.delete(id));
  return idbRun(GALLERY_STORE, "readwrite", (st) => st.delete(id)).then((r) => r.ok);
}

// Bumped by every Clear. An archive write can be seconds in flight — reading a
// video's bytes, then seeking it for a poster frame — so one that started
// before a Clear would otherwise land after it, leaving a stray item in a strip
// the user just emptied.
let galleryEpoch = 0;

async function galleryClear() {
  galleryEpoch++;
  await idbRun(GALLERY_BYTES_STORE, "readwrite", (st) => st.clear());
  return idbRun(GALLERY_STORE, "readwrite", (st) => st.clear()).then((r) => r.ok);
}

// Every item's thumbnail and metadata, newest first. Deliberately never touches
// GALLERY_BYTES_STORE: this is what the strip redraws from, so its cost has to
// scale with the number of thumbnails rather than with the size of the images.
async function galleryAll() {
  const r = await idbRun(GALLERY_STORE, "readonly", (st) => st.getAll());
  const list = r.ok && Array.isArray(r.value) ? r.value : [];
  return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Shrinks a decoded frame to something a strip can hold a lot of. Resolves to
// null on anything that will not encode, because a missing thumbnail is worth
// far less than a failed archive. Shared tail of both paths below.
function encodeThumb(source, srcW, srcH) {
  return new Promise((resolve) => {
    try {
      if (!srcW || !srcH) return resolve(null);
      const scale = Math.min(1, GALLERY_THUMB_PX / Math.max(srcW, srcH));
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(source, 0, 0, w, h);
      canvas.toBlob(
        (out) => {
          if (!out) return resolve(null);
          out.arrayBuffer().then((buf) => resolve({ buf, type: out.type, width: srcW, height: srcH })).catch(() => resolve(null));
        },
        "image/jpeg",
        0.72
      );
    } catch {
      resolve(null);
    }
  });
}

function makeThumb(blob, kind) {
  return kind === "video" ? videoThumb(blob) : imageThumb(blob);
}

function imageThumb(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () => encodeThumb(img, img.width, img.height).then(done);
    img.onerror = () => done(null);
    img.src = url;
  });
}

// A poster frame, so a kept clip gets a tile like everything else. The element
// is built from a literal tag name for the same reason probeMediaMeta's is: an
// element built from a computed string cannot be resolved statically, and the
// blob: URL below then reads to analysis as a possible script-injection sink.
function videoThumb(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    let settled = false;
    const done = (value) => {
      if (settled) return; // seeked and the timeout below can both arrive
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const grab = () => encodeThumb(v, v.videoWidth, v.videoHeight).then(done);
    // "auto", not "metadata" as probeMediaMeta uses: that one only needs the
    // duration, this needs a decoded frame, and "metadata" is an explicit
    // instruction to stop before one is available. The bytes are already in
    // memory behind a blob: URL, so there is nothing extra to fetch.
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.onloadeddata = () => {
      // A frame in from the start: the first is very often black.
      const target = Number.isFinite(v.duration) && v.duration > 2 ? Math.min(1, v.duration / 2) : 0;
      if (!target) return void grab();
      v.onseeked = grab;
      try {
        v.currentTime = target;
      } catch {
        grab();
      }
    };
    v.onerror = () => done(null);
    // A clip that decodes but never fires either event must not leave the
    // archive — and with it the strip — waiting on it.
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

// Applies all three bounds, separately per kind. Runs after every insert and
// once at boot, so a record that aged out while the app was closed goes on the
// next load. Counting per kind is what stops one long clip evicting the images.
async function pruneGallery() {
  const all = await galleryAll();
  const now = Date.now();
  const tally = { image: { items: 0, bytes: 0 }, video: { items: 0, bytes: 0 } };
  let kept = 0;
  for (const rec of all) {
    const kind = recordKind(rec);
    const limit = GALLERY_LIMITS[kind];
    const seen = tally[kind];
    // From the light record's own `size`, so the byte ceiling costs no read of
    // the media it is measuring.
    const size = rec.size || 0;
    const tooOld = !(rec.createdAt > now - limit.ageMs);
    if (tooOld || seen.items >= limit.items || seen.bytes + size > limit.bytes) {
      await galleryDelete(rec.id);
      continue;
    }
    seen.items++;
    seen.bytes += size;
    kept++;
  }
  return kept;
}

// `setup` is the form as it stood when this ran — what makes the result
// repeatable rather than merely viewable. Null for a job collected on reload,
// where the form on screen belongs to whatever is selected now and says nothing
// about the run that produced this.
async function archiveGeneration(blob, modelId, prompt, kind, setup) {
  if (galleryBroken) return;
  const epoch = galleryEpoch;
  try {
    const bytes = await blob.arrayBuffer();
    const thumb = await makeThumb(blob, kind);
    // Cleared while this was being prepared. The user asked for an empty strip;
    // writing into it now would put back the one item they were watching.
    if (epoch !== galleryEpoch) return;
    const rec = {
      // Sortable and unique enough for one device: two results from the same
      // generation land in the same millisecond otherwise.
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      modelId: modelId || "",
      prompt: prompt || "",
      kind: kind === "video" ? "video" : "image",
      setup: setup || null,
      type: blob.type || (kind === "video" ? "video/mp4" : "image/jpeg"),
      thumb: thumb ? thumb.buf : null,
      thumbType: thumb ? thumb.type : "",
      width: thumb ? thumb.width : 0,
      height: thumb ? thumb.height : 0,
      // The one thing the light record keeps about the media itself, so the
      // byte ceiling can be enforced without reading any of it.
      size: bytes.byteLength,
    };
    if (!(await galleryPut(rec, bytes))) {
      // Out of quota, or a store that will not take this. Make room once and
      // try again before giving up on the feature for this load.
      await pruneGallery();
      if (!(await galleryPut(rec, bytes))) {
        galleryBroken = true;
        return;
      }
    }
    await pruneGallery();
  } catch {
    // Archiving is a convenience layered on top of a generation that already
    // succeeded; it never gets to report an error over the top of the result.
    galleryBroken = true;
  }
}

// --- the strip, and one item full size -------------------------------------

// The strip's thumbnail URLs, released when it is rebuilt. The lightbox keeps
// its own below: it holds a full-size image, and it opens and closes many times
// between one strip rebuild and the next.
let galleryObjectUrls = [];

function releaseGalleryUrls() {
  for (const u of galleryObjectUrls) URL.revokeObjectURL(u);
  galleryObjectUrls = [];
}

function galleryObjectUrl(buf, type) {
  const url = URL.createObjectURL(new Blob([buf], { type: type || "image/jpeg" }));
  galleryObjectUrls.push(url);
  return url;
}

// The strip's order, newest first, so the lightbox can step to the item beside
// the one it shows without closing.
let galleryOrder = [];

async function renderRecent() {
  const wrap = $("recent");
  const strip = $("recent-strip");
  if (!wrap || !strip) return;
  const items = await galleryAll();
  galleryOrder = items.map((r) => r.id);
  releaseGalleryUrls();
  strip.innerHTML = "";

  if (!items.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const clips = items.filter((r) => recordKind(r) === "video").length;
  $("recent-count").textContent =
    `${items.length} recent ${items.length === 1 ? "item" : "items"}` +
    (clips ? ` · ${clips} video${clips === 1 ? "" : "s"}` : "") +
    " · kept on this device for a week";

  for (const rec of items) {
    const kind = recordKind(rec);
    const noun = kind === "video" ? "video" : "image";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb";
    btn.title = rec.prompt || rec.modelId || `Generated ${noun}`;
    // Thumbnails only — a poster frame for a clip. An item whose thumbnail
    // failed to encode never pulls its full-size bytes in here, which is
    // exactly the cost this store was split to avoid. It gets a plain tile
    // instead of an <img> with no src, which browsers draw as a broken image
    // with the alt text spilling out of it — more likely now that a clip can
    // fail to yield a frame where a still would not.
    if (rec.thumb) {
      const img = document.createElement("img");
      img.src = galleryObjectUrl(rec.thumb, rec.thumbType);
      // The strip scrolls sideways, so most tiles are off-screen. Where these
      // are honoured the browser skips decoding them until they are scrolled
      // to; where they are not, behaviour is unchanged.
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = rec.prompt ? `Generated ${noun}: ${rec.prompt}` : `Generated ${noun}`;
      btn.appendChild(img);
    } else {
      const blank = document.createElement("span");
      blank.className = "thumb-blank";
      blank.textContent = kind === "video" ? "🎬" : "🖼";
      btn.appendChild(blank);
    }
    // Otherwise a clip and a still are the same tile, and which one opens a
    // player is a surprise.
    if (kind === "video") {
      const badge = document.createElement("span");
      badge.className = "thumb-kind";
      badge.textContent = "▶";
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => openLightbox(rec.id));
    strip.appendChild(btn);
  }
}

// The full-size image on screen. Its own variable rather than the strip's list,
// because it is replaced every time an item is opened and the strip may not be
// rebuilt for a long time — leaving them to accumulate pinned a whole image in
// memory per item viewed, the leak PR #33 fixed for upload previews.
let lightboxObjectUrl = null;

function releaseLightboxUrl() {
  if (lightboxObjectUrl) URL.revokeObjectURL(lightboxObjectUrl);
  lightboxObjectUrl = null;
}

function closeLightbox() {
  lightboxSeq++; // an open still reading its bytes must not reopen the card
  lightboxId = null;
  $("lightbox").classList.add("hidden");
  // Emptied rather than blanked: a <video> left in the DOM with a revoked src
  // keeps decoding against nothing.
  $("lightbox-media").innerHTML = "";
  $("lightbox-actions").innerHTML = "";
  releaseLightboxUrl();
}

// Bumped by every open. Two quick swipes start two reads, and the slower one
// must not paint over the item the user has already moved on to.
let lightboxSeq = 0;
let lightboxId = null;

// The item `step` places from the one on screen, in the strip's order: -1 is
// newer, +1 older. Null at either end.
function lightboxNeighbour(step) {
  const i = galleryOrder.indexOf(lightboxId);
  const j = i + step;
  return i >= 0 && j >= 0 && j < galleryOrder.length ? galleryOrder[j] : null;
}

function refreshLightboxNav() {
  const i = galleryOrder.indexOf(lightboxId);
  $("lightbox-prev").disabled = !lightboxNeighbour(-1);
  $("lightbox-next").disabled = !lightboxNeighbour(1);
  $("lightbox-prev").classList.toggle("hidden", galleryOrder.length < 2);
  $("lightbox-next").classList.toggle("hidden", galleryOrder.length < 2);
  return i;
}

function stepLightbox(step) {
  if ($("lightbox").classList.contains("hidden")) return;
  const id = lightboxNeighbour(step);
  if (id) openLightbox(id);
}

async function openLightbox(id) {
  const seq = ++lightboxSeq;
  const rec = await galleryGet(id);
  if (seq !== lightboxSeq) return;
  if (!rec) return void renderRecent();
  // The only place the full-size bytes are read.
  const bytes = await galleryBytesGet(id);
  if (seq !== lightboxSeq) return;
  if (!bytes) {
    // The light record outlived its image somehow; drop it rather than open an
    // empty frame.
    await galleryDelete(id);
    renderRecent();
    return void setStatus("That image is no longer stored on this device.", "err");
  }

  const kind = recordKind(rec);
  const blob = new Blob([bytes], { type: rec.type || (kind === "video" ? "video/mp4" : "image/jpeg") });
  releaseLightboxUrl();
  lightboxObjectUrl = URL.createObjectURL(blob);

  const media = $("lightbox-media");
  media.innerHTML = "";
  if (kind === "video") {
    const v = document.createElement("video");
    v.src = lightboxObjectUrl;
    v.controls = true;
    v.loop = true;
    v.playsInline = true;
    media.appendChild(v);
  } else {
    const img = document.createElement("img");
    img.src = lightboxObjectUrl;
    img.alt = rec.prompt ? `Generated image: ${rec.prompt}` : "Generated image";
    media.appendChild(img);
  }

  const model = MODELS.find((m) => m.id === rec.modelId);
  const when = new Date(rec.createdAt);
  const size =
    rec.size >= 1024 * 1024
      ? `${(rec.size / 1024 / 1024).toFixed(1)} MB`
      : rec.size >= 1024
        ? `${Math.round(rec.size / 1024)} KB`
        : `${rec.size} bytes`;
  lightboxId = id;
  const pos = refreshLightboxNav();
  $("lightbox-meta").textContent =
    (galleryOrder.length > 1 && pos >= 0 ? `${pos + 1} of ${galleryOrder.length} · ` : "") +
    `${model ? model.label : rec.modelId || "unknown model"} · ${when.toLocaleString()} · ${size}`;
  $("lightbox-prompt").textContent = rec.prompt || "";

  const actions = $("lightbox-actions");
  actions.innerHTML = "";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "download";
  save.textContent = "⬇ Save";
  save.addEventListener("click", () => saveBlob(blob, `generated-${rec.createdAt}.${extFromType(rec.type, kind)}`));
  actions.appendChild(save);

  // Hidden rather than inert where nothing on this model, and no model at all,
  // can take this kind of file back in.
  const reuseText = reuseLabel(reuseTarget(kind), kind);
  if (reuseText) {
    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.className = "secondary";
    reuse.textContent = reuseText;
    reuse.addEventListener("click", () => {
      closeLightbox();
      useGeneratedAsInput(blob, 0, kind);
    });
    actions.appendChild(reuse);
  }

  // Records written before the setup was stored fall back to the prompt alone
  // rather than offering a button that would restore nothing.
  if (rec.setup || rec.prompt) {
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "secondary";
    restore.textContent = rec.setup ? "↩ Restore setup" : "↩ Restore prompt";
    restore.title = rec.setup
      ? `Put ${model ? model.label : rec.modelId} back with the settings that made this`
      : "Put this prompt back in the box";
    restore.addEventListener("click", () => restoreFromRecord(rec));
    actions.appendChild(restore);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "secondary";
  del.textContent = "Delete";
  // Goes on to the item beside it rather than closing, so clearing out a run
  // of rejects is one tap each. Closes only when nothing is left.
  del.addEventListener("click", async () => {
    const next = lightboxNeighbour(1) || lightboxNeighbour(-1);
    await galleryDelete(rec.id);
    await renderRecent();
    if (next) openLightbox(next);
    else closeLightbox();
  });
  actions.appendChild(del);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "secondary";
  close.textContent = "Close";
  close.addEventListener("click", closeLightbox);
  actions.appendChild(close);

  $("lightbox").classList.remove("hidden");
}

// Puts a past run back on screen: the model, the prompt, and every option as it
// stood. Two ordering constraints, both load-bearing. The model switch goes
// first, because applyRestoredFields writes into whatever fields are currently
// rendered. And `restoringSession` has to be held across the pair, or
// selectModel carries the outgoing model's text in over the top of the snapshot
// it is about to apply — the same reason restoreSession sets it.
function restoreFromRecord(rec) {
  const known = Boolean(rec.modelId) && MODELS.some((m) => m.id === rec.modelId);
  const model = MODELS.find((m) => m.id === rec.modelId);

  // No stored setup (a record from before this shipped), or a model that has
  // since left the catalogue: the prompt is all there is to give back.
  if (!rec.setup || !known) {
    if (!rec.prompt) return void setStatus("Nothing stored for that one to restore.", "err");
    const el = primaryPromptEl();
    if (!el) return void setStatus("This model has no prompt box.", "err");
    el.value = rec.prompt;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    commitPromptHistory(); // one entry, so Undo reverses the whole restore
    closeLightbox();
    setStatus(
      known
        ? "Prompt restored — press Undo to put it back."
        : "Prompt restored. The model that made it is no longer in the catalogue.",
      "ok"
    );
    return;
  }

  // Restoring onto the model already selected keeps whatever is attached.
  // Switching cannot: selectModel clears the uploads, and the files that made
  // the original are not stored, so say so rather than let them vanish quietly.
  const sameModel = Boolean(currentModel) && currentModel.id === rec.modelId;
  const hadUploads = Object.values(uploads).some((list) => list.length);

  commitPromptHistory(); // what is in the box now stays reachable by Undo
  restoringSession = true;
  try {
    if (!sameModel) selectModel(rec.modelId);
    applyRestoredFields(rec.setup);
  } catch (e) {
    setStatus("Could not restore that setup: " + e.message, "err");
    return;
  } finally {
    restoringSession = false;
  }
  // The restored text arrived wholesale, so it is one entry rather than a burst
  // of typing — Undo reverses the whole thing.
  commitPromptHistory();
  scheduleSessionSave();
  closeLightbox();

  const what = recordKind(rec) === "video" ? "video" : "image";
  setStatus(
    `Restored ${model ? model.label : rec.modelId} with the settings that made that ${what}.` +
      (!sameModel && hadUploads ? " The files you had attached were cleared by the model switch." : ""),
    "ok"
  );
}

// The iOS-safe save: a plain <a download> sends Safari to a full-screen file
// viewer with no way back. Shared by the result panel and the lightbox.
async function saveBlob(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    if (err && err.name !== "AbortError") setStatus("Save failed: " + err.message, "err");
  }
}

function initRecent() {
  $("recent-clear").addEventListener("click", async () => {
    if (!window.confirm("Delete the recent images and videos kept on this device?")) return;
    await galleryClear();
    releaseGalleryUrls();
    renderRecent();
    // The status line belongs to a run while one is going: writing "Cleared…"
    // over "Processing… 2m 10s elapsed" reads as the generation having stopped.
    // The strip emptying is the confirmation either way.
    if (!generationInFlight) setStatus("Cleared the recent images and videos.", "ok");
  });
  // Tapping the backdrop closes, the card itself does not.
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox")) closeLightbox();
  });
  $("lightbox-prev").addEventListener("click", () => stepLightbox(-1));
  $("lightbox-next").addEventListener("click", () => stepLightbox(1));
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "ArrowRight") stepLightbox(1);
  });
  // A swipe across the picture steps through the strip: left for the older
  // item, right for the newer, matching which way the strip itself runs.
  // Mostly-sideways only, so scrolling a tall card up and down is not a swipe.
  let touchX = null;
  let touchY = null;
  const media = $("lightbox-media");
  media.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return void (touchX = null);
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  media.addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    touchX = null;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) stepLightbox(dx < 0 ? 1 : -1);
  }, { passive: true });
}

// Pruna returns generation_url as a plain string for some models and as an
// array for others (flux-2-klein-4b, wan-image-small with num_outputs > 1).
function asUrlList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean);
}

// A short-lived token for media URLs. <img>, <video> and <a download> cannot
// send a header, and this used to be solved by putting the password itself in
// the query string — which Workers observability then recorded, writing the
// shared secret into log storage on every image the app loaded. The Worker
// signs an expiry instead; the password never leaves the header.
let resultToken = "";
let resultTokenExp = 0;
let resultTokenInFlight = null;

// Refreshed a minute before it lapses, so a URL built right after this resolves
// is good for the whole of the request it is about to make.
async function refreshResultToken() {
  if (!authRequired) return "";
  if (resultToken && Date.now() < resultTokenExp - 60000) return resultToken;
  if (!resultTokenInFlight) {
    resultTokenInFlight = (async () => {
      try {
        const res = await api("/api/token");
        const d = await res.json();
        if (res.ok && d.token) {
          resultToken = d.token;
          resultTokenExp = Number(d.expiresAt) || 0;
        }
      } catch {
        /* keep whatever we have — it may still be inside its window */
      } finally {
        resultTokenInFlight = null;
      }
      return resultToken;
    })();
  }
  return resultTokenInFlight;
}

// Sync, because it feeds `img.src`. Callers that are about to fetch await
// refreshResultToken() first; a token that lapses while an already-loaded
// element sits on screen costs nothing, since the bytes are in hand.
function resultUrl(prunaUrl) {
  // Workers AI results are already inline data URIs — nothing to proxy.
  if (prunaUrl.startsWith("data:")) return prunaUrl;
  let u = "/api/result?url=" + encodeURIComponent(prunaUrl);
  if (authRequired && resultToken) u += "&t=" + encodeURIComponent(resultToken);
  return u;
}

// What is currently on screen in the output panel, so Judge can score the
// image you just generated without making you save and re-attach it.
//
// `urls` stays the PROVIDER urls even though the panel now renders from local
// bytes: Judge tests them against PRUNA_URL to decide whether it can hand one
// straight to p-judger instead of re-uploading it. `blobs` is the parallel
// array of bytes, aligned by index, null where the fetch failed.
let lastResult = { urls: [], kind: null, blobs: [] };

// Object URLs for whatever the panel is showing. An object URL pins its whole
// image in memory until revoked, so the previous set goes when the panel is
// replaced — the same discipline releasePreview() applies to upload thumbnails.
let resultObjectUrls = [];

function releaseResultUrls() {
  for (const u of resultObjectUrls) URL.revokeObjectURL(u);
  resultObjectUrls = [];
}

// Pulls one finished result into memory. A data: URI is already the bytes and
// costs no request; anything else comes through /api/result, which answers
// no-store, so this is the only copy we get without paying for the download
// twice — once for the <img> and again for saving or reuse.
// Through api() rather than a bare fetch, so a dropped connection is retried.
// This is the largest transfer the app makes — a video is tens of megabytes on
// a phone connection — and it was the one GET with no retry at all: a single
// blip lost the bytes, which cost the archive (nothing is stored without them),
// left the player streaming from a URL that dies mid-playback, and made Save
// fail with the browser's bare "Load failed".
//
// Each attempt has a deadline that covers the body as well as the first byte:
// a transfer that stalls halfway is dropped and asked for again, like one that
// fails, instead of holding the result off the screen indefinitely.
const RESULT_TIMEOUT_MS = { video: 180000, other: 30000 };

async function fetchResultBlob(prunaUrl, kind, onAttempt) {
  const { res, blob } = await api(resultUrl(prunaUrl), {
    timeoutMs: kind === "video" ? RESULT_TIMEOUT_MS.video : RESULT_TIMEOUT_MS.other,
    read: async (r) => ({ res: r, blob: r.ok ? await r.blob() : null }),
    onAttempt,
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return blob;
}

// `meta` describes the run that produced these, not the form as it stands:
// a job collected on reload belongs to whatever model the record names, and the
// settings on screen then say nothing about it.
//
// `timer` records the download, display and save legs of the run; `onDisplayed`
// fires once every result is on screen, which is where the run's elapsed time
// stops. The gallery save after that is the app's own bookkeeping.
async function showResult(prunaUrls, kind, meta, { timer, onDisplayed } = {}) {
  const box = $("result");
  releaseResultUrls();
  box.innerHTML = "";
  lastResult = { urls: prunaUrls.slice(), kind, blobs: [] };
  updateJudgeNote();
  const archived = [];
  const info = meta || { modelId: "", prompt: "", setup: null };

  const shown = [];

  for (let i = 0; i < prunaUrls.length; i++) {
    const prunaUrl = prunaUrls[i];
    // A trained LoRA .zip is not media; there is nothing to preview or reuse,
    // so it is never fetched here.
    let blob = null;
    let src = null;
    if (kind !== "file") {
      const attempts = [];
      const began = timer ? timer.at() : 0;
      try {
        // No token is needed for this fetch: api() sends the password header,
        // which the Worker accepts before it ever looks at a token. Waiting on
        // /api/token here cost a round trip after every idle spell for nothing.
        blob = await fetchResultBlob(prunaUrl, kind, attemptLog(attempts));
        src = URL.createObjectURL(blob);
        resultObjectUrls.push(src);
      } catch {
        // Holding the bytes buys saving without a second download, reuse as an
        // input, and a copy that outlives the provider's expiring delivery URL.
        // None of that is worth losing the picture over: fall back to streaming
        // it through the proxy exactly as before. That URL is loaded by the
        // element itself, which cannot send a header, so it is the one that
        // needs a live token.
        blob = null;
        await refreshResultToken();
        src = resultUrl(prunaUrl);
      }
      if (timer) {
        const last = attempts[attempts.length - 1];
        timer.rec.downloads.push({
          start: began,
          ms: timer.at() - began,
          ok: !!blob,
          bytes: blob ? blob.size : null,
          upstream: last ? last.upstream : null,
          attempts,
        });
      }
    }
    lastResult.blobs.push(blob);
    // Video is kept for the same reason an image is, and more so: it is the
    // most expensive thing this app produces. A trained LoRA .zip is not —
    // it is not previewable, is never fetched into a Blob above, and its link
    // expires about half an hour after the run either way.
    if (blob && (kind === "image" || kind === "video")) {
      archived.push(archiveGeneration(blob, info.modelId, info.prompt, kind, info.setup));
    }

    const item = document.createElement("div");
    item.className = "result-item";
    if (kind === "video") {
      const v = document.createElement("video");
      v.src = src;
      v.controls = true;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      item.appendChild(v);
    } else if (kind === "audio") {
      const a = document.createElement("audio");
      a.src = src;
      a.controls = true;
      a.className = "result-audio";
      item.appendChild(a);
    } else if (kind === "file") {
      // Not previewable media (e.g. a trained LoRA .zip) — just a plain link.
      const box2 = document.createElement("div");
      box2.className = "file-result";
      box2.textContent = "📦 File ready";
      item.appendChild(box2);
    } else {
      const img = document.createElement("img");
      img.src = src;
      item.appendChild(img);
    }
    shown.push(whenShown(item.firstChild));
    const actions = document.createElement("div");
    actions.className = "result-actions";
    actions.appendChild(downloadButton(prunaUrl, kind, i, prunaUrls.length, blob));
    if (blob && (kind === "image" || kind === "video" || kind === "audio")) {
      actions.appendChild(reuseButton(blob, i, prunaUrls.length, kind));
    }
    item.appendChild(actions);
    box.appendChild(item);
  }

  await Promise.all(shown);
  if (timer) timer.rec.visible = timer.at();
  if (onDisplayed) onDisplayed();

  // On a phone the output sits below the whole form, so a finished result would
  // land out of sight of the Generate button that asked for it.
  if (window.matchMedia("(max-width: 899px)").matches && !$("screen-create").classList.contains("hidden")) {
    const r = box.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.6 || r.bottom < 0) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // The strip follows the archive, and only once every result has been stored.
  if (archived.length) {
    await Promise.all(archived);
    await renderRecent();
    if (timer) timer.rec.saved = timer.at();
  }
  if (timer) {
    timer.finish("ok");
    box.appendChild(timingBlock(timer.rec));
  }
}

// ---------------------------------------------------------------------------
// Sending a generated image back in as an input
//
// Before this, the only route from an output to an input was Save to the camera
// roll and pick it back up — on iOS a share-sheet round trip for bytes that were
// already on the device. The picture is now held in memory when it renders, so
// it can go straight into an image field as an ordinary File: the same
// adoptFiles() path a carried-over or restored upload takes, which means it gets
// a thumbnail immediately, the provider encoding it needs, and a place in the
// saved session for free.
// ---------------------------------------------------------------------------

// Where a result goes when the current model has nowhere to put it — one model
// per kind, each of which takes that kind as its required subject.
const REUSE_FALLBACK_MODEL = { image: "p-image-edit", video: "p-video-edit", audio: "p-video-avatar" };

// The "image" field type is reused for audio, video and .zip slots via accept,
// so a result only belongs in a field that takes its own kind.
function fieldTakes(f, kind) {
  const accept = f.accept || "image/*";
  if (kind === "audio") return accept.startsWith("audio/");
  return kind === "video" ? accept.startsWith("video/") : accept.startsWith("image/");
}

// Where a generated result would land if it were reused right now: the first
// matching field with room. "First field in model order" is the convention
// attachedImageFile() and attachedImageBatch() already follow — model
// definitions put the subject before masks, end frames and garments.
//
// A field that is full is skipped rather than overwritten: replacing a file
// the user chose, to make room for one the app chose, is not a trade it gets to
// make on their behalf.
function reuseTarget(kind = "image") {
  if (!currentModel) return null;
  for (const f of currentModel.fields) {
    if (f.type !== "image" || !fieldTakes(f, kind)) continue;
    if (!fieldVisible(f)) continue;
    if ((uploads[f.name] || []).length >= (f.maxItems || 1)) continue;
    return f;
  }
  return null;
}

// Says what the button will do before it is pressed, the way Judge's and
// Describe's note lines do. The distinction that matters is whether the result
// becomes the thing being edited or a reference alongside a prompt. Empty means
// there is nowhere for it to go at all, and the caller shows no button.
function reuseLabel(f, kind = "image") {
  if (!f) {
    const fallback = REUSE_FALLBACK_MODEL[kind];
    const m = MODELS.find((x) => x.id === fallback);
    if (!m) return "";
    if (kind === "audio") return `🔊 Use in ${m.label}`;
    return kind === "video" ? `🎬 Edit in ${m.label}` : `✏️ Edit in ${m.label}`;
  }
  if (kind === "audio") return "🔊 Use as audio track";
  if (kind === "video") {
    return currentModel.group === "Video" && f.required ? "🎬 Edit this clip" : "🎬 Use as source";
  }
  return (currentModel.group === "Image editing" || currentModel.edits) && f.required ? "✏️ Edit this" : "🖼 Use as reference";
}

// Every reuse button on screen, so their labels can follow the current target.
let reuseButtons = [];

function reuseButton(blob, index, total, kind) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary reuse";
  const label = () => reuseLabel(reuseTarget(kind), kind) + (total > 1 ? ` #${index + 1}` : "");
  btn.title = `Send this ${kind === "video" ? "clip" : kind === "audio" ? "audio" : "image"} into the model's input`;
  btn.addEventListener("click", () => useGeneratedAsInput(blob, index, kind));
  // The target moves as fields fill up or the mode changes, so the label is
  // re-read rather than frozen at render time. An empty label means the current
  // model has nowhere to put this, so the button hides rather than lying.
  btn.refreshLabel = () => {
    const text = label();
    btn.textContent = text;
    btn.classList.toggle("hidden", !text.trim());
  };
  btn.refreshLabel();
  reuseButtons.push(btn);
  return btn;
}

function refreshReuseLabels() {
  reuseButtons = reuseButtons.filter((b) => b.isConnected);
  for (const b of reuseButtons) b.refreshLabel();
}

function generatedFileName(blob, index, kind) {
  return `generated-${Date.now()}${index ? "-" + (index + 1) : ""}.${extFromType(blob.type, kind)}`;
}

function useGeneratedAsInput(blob, index, kind = "image") {
  const noun = kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
  const file = new File([blob], generatedFileName(blob, index, kind), {
    type: blob.type || (kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/jpeg"),
  });
  const f = reuseTarget(kind);

  if (f) {
    const ui = fieldUI[f.name];
    if (!ui) return;
    adoptFiles(f, [file], ui.redraw, `Could not use that ${noun}`);
    ui.redraw();
    // An optional field lives inside the collapsed Options panel, so without
    // this the file lands somewhere the user cannot see and the tap reads as
    // having done nothing.
    if (optionsPanel && optionsPanel.contains(ui.box)) optionsPanel.open = true;
    ui.box.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus(`Added the generated ${noun} to ${f.label} on ${currentModel.label}.`, "ok");
    return;
  }

  // Nowhere to put it here, so take it somewhere that can edit it. selectModel
  // does the rest: the fields render, and the file is adopted as they do.
  const target = MODELS.find((x) => x.id === REUSE_FALLBACK_MODEL[kind]);
  if (!target) {
    setStatus(`No ${noun} field on this model, and no editing model to switch to.`, "err");
    return;
  }
  pendingAdopt = [file];
  pendingAdoptKind = kind;
  selectModel(target.id);
  // Anything left over never found a slot; dropping it here keeps it from
  // turning up unannounced at the next model switch.
  pendingAdopt = [];
  pendingAdoptKind = "image";

  const landed = Object.values(uploads).some((list) => list.some((u) => u.file === file));
  if (landed) {
    const ui = Object.values(fieldUI)[0];
    if (ui) {
      if (optionsPanel && optionsPanel.contains(ui.box)) optionsPanel.open = true;
      ui.box.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setStatus(`Switched to ${target.label} with the generated ${noun} attached.`, "ok");
  } else {
    setStatus(`Switched to ${target.label}, but its ${noun} field was already full.`, "err");
  }
}

function extFromType(type, kind) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
  };
  return map[(type || "").toLowerCase()] || (kind === "video" ? "mp4" : kind === "audio" ? "mp3" : kind === "file" ? "zip" : "jpg");
}

// Saving must never navigate the page. A plain <a download> sends iOS Safari to
// a full-screen file viewer with no way back, which strands the app. Instead we
// fetch the bytes, then hand them to the native share sheet ("Save Image" /
// "Save to Files") when available, or trigger a blob download everywhere else.
// Takes the provider URL rather than a proxied one: the proxied form carries a
// token that can lapse between render and tap, so it is rebuilt at the moment
// it is used.
function downloadButton(prunaUrl, kind, index, total, blob) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "download";
  const idle = total > 1 ? `⬇ Save #${index + 1}` : "⬇ Save";
  btn.textContent = idle;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      // Already in hand for anything previewable; only a LoRA .zip, or a
      // result whose fetch failed earlier, still has to be pulled down here —
      // and that URL was built long enough ago that its token may have lapsed.
      const bytes = blob || (await (async () => {
        await refreshResultToken();
        const res = await api(resultUrl(prunaUrl));
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.blob();
      })());
      const ext = extFromType(bytes.type, kind);
      const name = `pruna-${Date.now()}${total > 1 ? "-" + (index + 1) : ""}.${ext}`;
      await saveBlob(bytes, name);
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
    // Field textareas only: the chat input and the voice panel's text box
    // live in this form too, and neither is a prompt.
    form.querySelector("textarea[data-field]")
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
  // The cost is the one thing here the picker does not already say.
  return `✨ ~${m.neurons} neurons per rewrite`;
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

function initDescribe() {
  const sel = $("describe-model");
  // Bare names here too; the per-model caveat lives in the note below.
  fillGroupedSelect(sel, describeModels);
  sel.value = defaultDescribeModel;

  const btn = $("prompt-describe");
  const file = $("describe-file");

  sel.addEventListener("change", () => {
    refreshGears();
    if (settingsOpenFor === "describe") renderToolSettings();
  });

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

  const note = (msg) => ($("describe-note").textContent = msg ? `🔍 ${msg}` : "");
  let running = null;

  async function describeFile(f) {
    note("");
    const el = primaryPromptEl();
    if (!el) {
      note("This model has no prompt box for the caption to go in — pick one that does.");
      return;
    }
    if (running) return;

    // The caption lands in the prompt box, so the sheet gets out of its way;
    // progress and Cancel are on the status line meanwhile.
    closeSheet("sheet-more");
    running = new AbortController();
    const cancel = () => running && running.abort();
    btn.disabled = true;
    setStatus("Describing the image…", "load", { cancel });
    try {
      const image = await toolImage(f);
      if (!image) throw new Error("Could not read that image.");
      const data = await streamTool(
        "/api/describe",
        { image_b64: image.b64, mime: image.mime, model: sel.value, settings: toolSettingsFor("describe", sel.value) },
        {
          controller: running,
          onEvent: (name, d) => {
            if (name === "progress") {
              setStatus(d.chars ? `Describing the image… ${d.chars} characters` : "Describing the image… thinking", "load", { cancel });
            }
          },
        }
      );
      if (!data.description) throw new Error("The model returned no description.");
      el.value = data.description;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      commitPromptHistory(); // the caption is one entry, so Undo puts back what you had
      setStatus("Prompt filled from the image — press Undo to get yours back.", "ok");
      if (typeof data.neurons === "number") sessionNeurons += data.neurons;
      updateSpendBar();
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(refreshNeurons, 4000);
    } catch (e) {
      if (e.message === TOOL_CANCELLED) setStatus("Describe cancelled. The prompt is unchanged.", "ok");
      else {
        setStatus("Describe failed: " + e.message, "err");
        note("Describe failed: " + e.message);
      }
    } finally {
      running = null;
      btn.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Chat
//
// A conversation about the prompt, in a sheet opened from the prompt toolbar.
// The thread lives in this browser until New chat, and every Send carries all
// of it, so the model sees the conversation so far. The newest message also
// carries the prompt box text while "Prompt box" is ticked, and — for a model
// that can see — each attached image whose chip is ticked. The reply streams
// in as it is written. A reply can be put in the prompt box as one Undo step.
// ---------------------------------------------------------------------------
const CHAT_THREAD_KEY = "patchbay_chat_thread";
const CHAT_MODEL_KEY = "patchbay_chat_model";
const CHAT_CONTEXT_KEY = "patchbay_chat_context";

let chatThread = []; // [{ role: "user" | "assistant", content, neurons?, images? }]
let chatBusy = false;
let chatCtl = null;

function loadChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_THREAD_KEY) || "[]");
    if (Array.isArray(saved)) chatThread = saved.filter((m) => m && typeof m.content === "string");
  } catch {
    chatThread = [];
  }
}

function saveChat() {
  try {
    localStorage.setItem(CHAT_THREAD_KEY, JSON.stringify(chatThread));
  } catch {
    /* storage full or blocked: the thread still works for this visit */
  }
}

function chatModel() {
  const sel = $("chat-model");
  return chatModels.find((m) => m.id === (sel && sel.value)) || null;
}

// The attached images the chat can send, numbered in field order — the same
// order the Inputs section shows them in, so "image 2" means the same thing to
// the user, the chips and the thread.
function chatImageList() {
  if (!currentModel) return [];
  const out = [];
  for (const f of currentModel.fields) {
    if (f.type !== "image") continue;
    for (const u of uploads[f.name] || []) {
      if (u.file && u.isImage && u.preview) out.push({ file: u.file, preview: u.preview, n: out.length + 1 });
    }
  }
  return out;
}

// Which images go with the next message, by File. A newly attached image
// starts ticked; every Send unticks all of them, and one is sent again only
// when the user ticks it again — Workers AI keeps nothing between calls, so a
// follow-up about a picture needs the picture.
const chatTicks = new Map();
let chatLastError = "";

function renderChatImages() {
  const box = $("chat-images");
  if (!box) return;
  const list = chatImageList();
  for (const f of [...chatTicks.keys()]) if (!list.some((x) => x.file === f)) chatTicks.delete(f);
  for (const x of list) if (!chatTicks.has(x.file)) chatTicks.set(x.file, true);
  const m = chatModel();
  const canSee = Boolean(m && m.vision);
  box.innerHTML = "";
  for (const x of list) {
    const on = canSee && chatTicks.get(x.file);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-chip" + (on ? " on" : "");
    b.setAttribute("aria-pressed", String(Boolean(on)));
    b.setAttribute("aria-label", `Image ${x.n}`);
    b.disabled = !canSee || chatBusy;
    b.title = canSee ? `Image ${x.n} ${on ? "goes" : "does not go"} with the next message` : "This model can't see images";
    const img = document.createElement("img");
    img.src = x.preview;
    img.alt = "";
    b.appendChild(img);
    const tag = document.createElement("span");
    tag.className = "chat-chip-n";
    tag.textContent = String(x.n);
    b.appendChild(tag);
    b.addEventListener("click", () => {
      chatTicks.set(x.file, !chatTicks.get(x.file));
      renderChatImages();
      updateChatNote();
    });
    box.appendChild(b);
  }
  box.classList.toggle("hidden", !list.length);
}

function updateChatNote() {
  const el = $("chat-note");
  if (!el) return; // called before the chat exists
  const total = chatThread.reduce((n, m) => n + (m.neurons || 0), 0);
  const parts = [];
  if (chatLastError) parts.push(chatLastError);
  if (total) parts.push(`This chat so far: ~${Math.round(total).toLocaleString()} neurons`);
  const m = chatModel();
  const list = chatImageList();
  if (list.length && m && !m.vision) {
    parts.push("This model can't see images — pick one marked 👁 to send them");
  } else if (list.length) {
    const n = list.filter((x) => chatTicks.get(x.file)).length;
    if (!n && m && m.needsImage) parts.push(`${m.label} needs an image with every message — tap one to send it`);
    else parts.push(n ? `${n === 1 ? "1 image goes" : `${n} images go`} with the next message` : "No image goes with the next message — tap one to send it");
    if (n > 1 && m && m.maxImages === 1) parts.push("combined into one numbered picture, since this model takes one");
  } else if (m && m.needsImage) {
    parts.push(`${m.label} needs an image with every message — attach one first`);
  }
  el.textContent = parts.join(" · ");
  el.classList.toggle("err", Boolean(chatLastError));
}

function putInPromptBox(text) {
  const el = primaryPromptEl();
  if (!el) return void setStatus("This model has no prompt box.", "err");
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  commitPromptHistory(); // one entry, so Undo puts back what you had
  closeSheet("sheet-chat");
  setStatus("Put in the prompt box — press Undo to get the old prompt back.", "ok");
}

// The reply as it streams in, before it becomes a thread entry.
let chatPartial = "";
let chatThinking = false;

function updatePendingBubble() {
  const p = $("chat-pending");
  if (!p) return;
  p.textContent = chatPartial || (chatThinking ? "thinking…" : "…");
  const box = $("chat-thread");
  box.scrollTop = box.scrollHeight;
}

function renderChat({ pending = false } = {}) {
  const box = $("chat-thread");
  box.innerHTML = "";
  for (const m of chatThread) {
    const b = document.createElement("div");
    b.className = `chat-msg ${m.role}`;
    const t = document.createElement("div");
    t.className = "chat-text";
    t.textContent = m.content;
    b.appendChild(t);
    // Which images a message carried, so the thread says what the model saw.
    if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
      const tag = document.createElement("div");
      tag.className = "chat-sent-images";
      tag.textContent = `🖼 ${m.images.join(", ")}`;
      b.appendChild(tag);
    }
    if (m.role === "assistant") {
      const row = document.createElement("div");
      row.className = "chat-msg-actions";
      if (m.neurons != null) {
        const cost = document.createElement("span");
        cost.className = "chat-cost";
        cost.textContent = `~${m.neurons < 10 ? m.neurons.toFixed(1) : Math.round(m.neurons)} neurons`;
        row.appendChild(cost);
      }
      const use = document.createElement("button");
      use.type = "button";
      use.className = "secondary chat-use";
      use.textContent = "Put in prompt box";
      use.addEventListener("click", () => putInPromptBox(m.content));
      row.appendChild(use);
      b.appendChild(row);
    }
    box.appendChild(b);
  }
  if (pending) {
    const w = document.createElement("div");
    w.className = "chat-msg assistant pending";
    w.id = "chat-pending";
    box.appendChild(w);
    updatePendingBubble();
  }
  box.classList.toggle("hidden", !chatThread.length && !pending);
  box.scrollTop = box.scrollHeight;
  updateChatNote();
}

// While a reply is on its way, Send is the way to cancel it.
function setChatBusy(on) {
  const b = $("chat-send");
  b.textContent = on ? "Cancel" : "Send";
  b.classList.toggle("secondary", on);
}

async function sendChat() {
  if (chatBusy) {
    if (chatCtl) chatCtl.abort();
    return;
  }
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  const m = chatModel();
  if (!m) return void setStatus("No chat model available.", "err");

  const body = { model: m.id, settings: toolSettingsFor("chat", m.id) };
  if ($("chat-prompt").checked) {
    const el = primaryPromptEl();
    if (el && el.value.trim()) body.prompt = el.value.trim();
  }
  const ticked = m.vision ? chatImageList().filter((x) => chatTicks.get(x.file)) : [];
  if (m.needsImage && !ticked.length) {
    chatLastError = `${m.label} needs an image with every message — tick one, then Send`;
    updateChatNote();
    return;
  }
  const mine = { role: "user", content: text };
  if (ticked.length) mine.images = ticked.map((x) => x.n);
  chatThread.push(mine);
  body.messages = chatThread.map(({ role, content }) => ({ role, content }));
  input.value = "";
  // Sent with this message only; the next one carries an image when it is
  // ticked again.
  for (const x of ticked) chatTicks.set(x.file, false);
  chatBusy = true;
  chatCtl = new AbortController();
  chatLastError = "";
  chatPartial = "";
  chatThinking = false;
  setChatBusy(true);
  renderChat({ pending: true });
  renderChatImages();

  try {
    if (ticked.length > 1 && m.maxImages === 1) {
      const im = await combinedImage(ticked);
      body.images = im ? [im] : [];
    } else if (ticked.length) {
      body.images = [];
      for (const x of ticked) {
        const im = await toolImage(x.file);
        if (im) body.images.push(im);
      }
    }
    const data = await streamTool("/api/chat", body, {
      controller: chatCtl,
      onEvent: (name, d) => {
        if (name === "delta") chatPartial += d.text;
        else if (name === "reset") chatPartial = d.text;
        else if (name === "progress") chatThinking = d.thinking > 0;
        updatePendingBubble();
      },
    });
    if (!data.reply) throw new Error("The model returned nothing usable.");
    chatThread.push({ role: "assistant", content: data.reply, neurons: data.neurons });
    if (typeof data.neurons === "number") sessionNeurons += data.neurons;
    saveChat();
    updateSpendBar();
    setTimeout(refreshNeurons, 4000);
  } catch (e) {
    // Not answered, so the message goes back in the box — with the images it
    // was going to carry ticked again — rather than sitting in the thread as
    // if it had been.
    chatThread.pop();
    input.value = text;
    for (const x of ticked) chatTicks.set(x.file, true);
    chatLastError = e.message === TOOL_CANCELLED ? "Cancelled — your message is back in the box" : "Chat failed: " + e.message;
    if (e.message !== TOOL_CANCELLED) setStatus("Chat failed: " + e.message, "err");
  } finally {
    chatBusy = false;
    chatCtl = null;
    setChatBusy(false);
    renderChat();
    renderChatImages();
  }
}

function initChat() {
  const sel = $("chat-model");
  if (!sel) return;
  // 👁 marks a model that can be shown the attached images.
  fillGroupedSelect(sel, chatModels.map((m) => ({ ...m, label: m.vision ? `${m.label} 👁` : m.label })));
  let saved = null;
  try {
    saved = localStorage.getItem(CHAT_MODEL_KEY);
  } catch {
    /* default below */
  }
  sel.value = chatModels.some((m) => m.id === saved) ? saved : defaultChatModel;
  sel.addEventListener("change", () => {
    try {
      localStorage.setItem(CHAT_MODEL_KEY, sel.value);
    } catch {
      /* remembered for this visit only */
    }
    renderChatImages();
    updateChatNote();
  });

  // The prompt box rides along until switched off, and stays as set.
  const withPrompt = $("chat-prompt");
  try {
    if (localStorage.getItem(CHAT_CONTEXT_KEY) === "off") withPrompt.checked = false;
  } catch {
    /* stays on */
  }
  withPrompt.addEventListener("change", () => {
    try {
      localStorage.setItem(CHAT_CONTEXT_KEY, withPrompt.checked ? "on" : "off");
    } catch {
      /* remembered for this visit only */
    }
  });

  // Enter adds a line, as in any text box; only Send sends.
  $("chat-send").addEventListener("click", sendChat);
  $("chat-new").addEventListener("click", () => {
    if (chatBusy) return;
    if (chatThread.length && !window.confirm("Start a new chat? This one will be cleared.")) return;
    chatThread = [];
    chatLastError = "";
    saveChat();
    renderChat();
  });

  loadChat();
  renderChat();
  renderChatImages();
}

// ---------------------------------------------------------------------------
// ⚙ Tools: the same rows for every tool
//
// Each tool is described on the same five rows — the model, what it reads, how
// it can be instructed, which limits it takes, where its answer goes — so that
// where two tools differ, the sheet says how and why instead of leaving it to
// be discovered. Improve, the chat and Describe run instruction-following
// models and take an instruction; the others run models whose inputs have no
// place for one, and their rows say which input they have instead.
//
// Kept in this browser only and sent with each request; the Worker bounds them
// (instruction up to 4,000 characters, token limit 16–8,000) and applies
// thinking and effort only to models whose schema takes them. The instruction
// belongs to the tool; the limits belong to the model, because a limit that
// suits Kimi wastes money on Llama.
//
// An instruction is a draft until saved. Typing changes nothing that is sent;
// Undo and Redo step through the draft; Revert puts the saved text back; Load
// default puts the app's own text in the draft, where it can still be undone;
// and every Save keeps the text it replaced among the last ten versions.
// ---------------------------------------------------------------------------
const TOOL_SETTINGS_KEY = "patchbay_tool_settings";
const INSTRUCTABLE = ["improve", "chat", "describe"];
const INSTRUCTION_VERSIONS = 10;
const INSTRUCTION_COMMIT_MS = 500;
let toolSettings = {};
for (const t of INSTRUCTABLE) toolSettings[t] = { system: "", models: {}, versions: [] };
let settingsOpenFor = null;
// Unsaved instruction drafts, per tool, for as long as the page is open:
// { text, past: [texts], at }.
const instructionDrafts = {};

const TOOL_TABS = [
  ["improve", "✨ Improve"],
  ["chat", "💬 Chat"],
  ["describe", "🔍 Describe"],
  ["translate", "🌐 Translate"],
  ["judge", "⚖️ Judge"],
  ["embed", "Embeddings"],
  ["other", "Other"],
  ["stt", "🎤 Speech to text"],
];

const TOOL_INFO = {
  improve: {
    where: "Picked beside ✨ Improve.",
    reads: "The prompt box text, and nothing else: it is a copy edit.",
    scope: "all Improve models",
    writes: "Replaces the prompt box, as one Undo step.",
  },
  chat: {
    where: "Picked at the top of the chat.",
    reads:
      "The whole thread, so it remembers the conversation; the prompt box text while “Prompt box” is ticked; and each attached image whose chip is ticked, for a model marked 👁. The chips untick after every Send — tick one again when a follow-up needs it.",
    scope: "all chat models",
    writes: "The thread. “Put in prompt box” replaces the prompt, as one Undo step.",
  },
  describe: {
    where: "Picked under ⋯ More.",
    reads: "The first attached image, or one you pick when none is attached. Not the prompt.",
    scope: "all Describe models",
    writes: "Replaces the prompt box, as one Undo step.",
  },
  translate: {
    model: "m2m100 1.2B · @cf/meta/m2m100-1.2b — the one translation model in the catalogue.",
    reads: "The prompt box text, and the two languages picked under ⋯ More.",
    instruction: "None. m2m100 translates: its input is the text and two language codes, and nothing else (Cloudflare's model schema).",
    limits: "None in its schema.",
    writes: "Replaces the prompt box, as one Undo step.",
  },
  judge: {
    model: "Pruna p-judger — the only scoring model, so there is nothing to choose between.",
    reads: "The prompt box text, and the generated image on screen — or, from Lab, the attached images or up to 10 files you pick.",
    instruction: "None. p-judger takes a prompt and images, and refuses any other input key (checked 2026-09-08).",
    limits: "None.",
    writes: "The score under the result, or in Lab. The scale is undocumented, so it is shown as a bare number.",
  },
  embed: {
    reads: "Its own text box in Lab — never the prompt.",
    instruction:
      "None. The panel measures text as a document. Qwen3 Embedding does take an instruction, but one meant for search queries, and it is left out on purpose; the other six have no such input.",
    limits: "None.",
    writes: "The Embeddings panel in Lab: each version against the baseline and the one before it.",
  },
  other: {
    reads: "Its own text box in Lab (Use prompt box copies the prompt in), or for image labels the attached image or one you pick.",
    instruction:
      "None. Llama Guard 3 takes messages only; DistilBERT takes text; ResNet-50 an image; the reranker a query and passages. None of their schemas has an instruction input.",
    limits: "None.",
    writes: "The Other panel in Lab.",
  },
  stt: {
    reads: "A recording from 🎤 in the chat, or an audio file where the browser cannot record.",
    instruction: "None. Audio in, text out: none of the four models takes an instruction.",
    limits: "None.",
    writes: "Adds the words to the chat box — not sent, so they can be corrected first.",
  },
};

function loadToolSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOOL_SETTINGS_KEY) || "null");
    if (saved && typeof saved === "object") {
      for (const t of INSTRUCTABLE) {
        if (!saved[t]) continue;
        toolSettings[t] = {
          system: saved[t].system || "",
          stt: saved[t].stt || "",
          models: saved[t].models || {},
          versions: Array.isArray(saved[t].versions) ? saved[t].versions.filter((v) => v && typeof v.text === "string") : [],
        };
      }
    }
  } catch {
    /* defaults */
  }
}

function saveToolSettings() {
  try {
    localStorage.setItem(TOOL_SETTINGS_KEY, JSON.stringify(toolSettings));
  } catch {
    /* kept for this visit */
  }
  refreshGears();
}

// The sampling parameters, in the order the settings show them, with what
// each does. Which ones a model takes, and their ranges, come from its schema
// (`sampling` on each model in models.js).
const SAMPLING_HELP = {
  temperature: "Controls the randomness of the output; higher values produce more random results.",
  top_p: "How many possible words it considers. Lower is more predictable; higher allows more varied and creative responses.",
  top_k: "Chooses from the top k most probable words. Lower is more focused; higher adds variety and surprises.",
  seed: "Random seed, for reproducible generations.",
  repetition_penalty: "Penalty for repeated tokens; higher values discourage repetition.",
  frequency_penalty: "Decreases the likelihood of repeating the same lines verbatim.",
  presence_penalty: "Increases the likelihood of introducing new topics.",
};

// What goes out with a request: only what differs from the defaults. A draft
// is never sent — only what was saved.
function toolSettingsFor(tool, modelId) {
  const t = toolSettings[tool];
  const m = (t.models || {})[modelId] || {};
  const out = {};
  if (t.system && t.system.trim()) out.system = t.system;
  if (m.maxTokens) out.maxTokens = m.maxTokens;
  if (typeof m.thinking === "boolean") out.thinking = m.thinking;
  if (m.effort) out.effort = m.effort;
  for (const name of Object.keys(SAMPLING_HELP)) if (typeof m[name] === "number") out[name] = m[name];
  return out;
}

const TOOL_MODEL_SELECT = { improve: "improve-model", chat: "chat-model", describe: "describe-model" };

function toolModel(tool) {
  const sel = $(TOOL_MODEL_SELECT[tool]);
  const id = sel && sel.value;
  const list = tool === "describe" ? describeModels : tool === "chat" ? chatModels : improveModels;
  return list.find((m) => m.id === id) || null;
}

// The limit the Worker uses when none is set here, mirroring its own defaults.
function defaultMaxTokens(tool, m) {
  if (m.maxTokens) return m.maxTokens;
  if (tool === "improve") return m.reasoning ? 1500 : 320;
  if (tool === "describe") return m.chat ? 1024 : 512;
  return m.reasoning ? 2000 : 1024;
}

function refreshGears() {
  for (const tool of INSTRUCTABLE) {
    const btn = $(`${tool}-settings`);
    const m = toolModel(tool);
    if (!btn || !m) continue;
    btn.classList.toggle("custom", Object.keys(toolSettingsFor(tool, m.id)).length > 0);
  }
}

const savedInstruction = (tool) => toolSettings[tool].system || defaultInstructions[tool] || "";

function instructionDraft(tool) {
  if (!instructionDrafts[tool]) {
    const text = savedInstruction(tool);
    instructionDrafts[tool] = { text, past: [text], at: 0, timer: null };
  }
  return instructionDrafts[tool];
}

const draftDirty = (tool) => Boolean(instructionDrafts[tool]) && instructionDrafts[tool].text !== savedInstruction(tool);
const anyDraftDirty = () => INSTRUCTABLE.filter(draftDirty);

// One history entry per burst of typing, the prompt box's own rule.
function commitDraft(d) {
  clearTimeout(d.timer);
  d.timer = null;
  if (d.past[d.at] === d.text) return;
  d.past = d.past.slice(0, d.at + 1);
  d.past.push(d.text);
  d.at = d.past.length - 1;
}

function toolRow(box, name, body) {
  const row = document.createElement("div");
  row.className = "tool-row";
  const n = document.createElement("div");
  n.className = "tool-row-name";
  n.textContent = name;
  row.appendChild(n);
  const b = document.createElement("div");
  b.className = "tool-row-body";
  if (typeof body === "string") {
    const p = document.createElement("p");
    p.textContent = body;
    b.appendChild(p);
  } else {
    b.appendChild(body);
  }
  row.appendChild(b);
  box.appendChild(row);
  return b;
}

function button(text, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function sttPicker() {
  const t = toolSettings.chat;
  const sel = document.createElement("select");
  sel.className = "settings-stt";
  sel.setAttribute("aria-label", "Speech-to-text model");
  for (const sm of sttModels) {
    const o = document.createElement("option");
    o.value = sm.id;
    o.textContent = `${sm.label} · ${sm.id}`;
    sel.appendChild(o);
  }
  sel.value = t.stt || defaultSttModel;
  sel.addEventListener("change", () => {
    t.stt = sel.value === defaultSttModel ? "" : sel.value;
    saveToolSettings();
  });
  return sel;
}

function renderToolTabs() {
  const tabs = $("tool-tabs");
  tabs.innerHTML = "";
  for (const [id, label] of TOOL_TABS) {
    const b = button(label, "tool-tab", () => {
      settingsOpenFor = id;
      renderToolSettings();
    });
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(id === settingsOpenFor));
    tabs.appendChild(b);
  }
}

function renderToolSettings() {
  const box = $("tool-settings");
  box.innerHTML = "";
  renderToolTabs();
  const tool = settingsOpenFor;
  if (!tool) return;
  if (INSTRUCTABLE.includes(tool)) renderInstructableTool(box, tool);
  else renderFixedTool(box, tool);
}

function renderFixedTool(box, tool) {
  const info = TOOL_INFO[tool];
  const h = document.createElement("h3");
  h.textContent = TOOL_TABS.find(([id]) => id === tool)[1];
  box.appendChild(h);
  if (tool === "embed") {
    const m = embedModels.find((x) => x.id === ($("embed-model") && $("embed-model").value));
    toolRow(box, "Model", m ? `${m.label} · ${m.id} — picked in the Embeddings panel. ${embedModels.length} to choose from; each keeps its own history, since their numbers cannot be compared.` : "Picked in the Embeddings panel.");
  } else if (tool === "other") {
    toolRow(box, "Model", otherTools.map((t) => `${t.label} · ${t.model}`).join("\n")).classList.add("pre");
  } else if (tool === "stt") {
    const wrap = document.createElement("div");
    wrap.appendChild(sttPicker());
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Used by 🎤 in the chat.";
    wrap.appendChild(p);
    toolRow(box, "Model", wrap);
  } else {
    toolRow(box, "Model", info.model);
  }
  toolRow(box, "Reads", info.reads);
  toolRow(box, "Instruction", info.instruction);
  toolRow(box, "Limits", info.limits);
  toolRow(box, "Writes to", info.writes);
}

function renderInstructableTool(box, tool) {
  const m = toolModel(tool);
  if (!m) return;
  const info = TOOL_INFO[tool];
  const t = toolSettings[tool];
  const mine = t.models[m.id] || {};
  const label = TOOL_TABS.find(([id]) => id === tool)[1].replace(/^\S+\s/, "");

  const h = document.createElement("h3");
  h.textContent = `${label} settings · ${m.label}`;
  box.appendChild(h);
  const exact = document.createElement("p");
  exact.className = "hint model-id";
  exact.textContent = m.id;
  box.appendChild(exact);

  let where = info.where;
  if (tool === "describe" && m.id.includes("moondream")) {
    where += " Moondream's caption mode takes no text, so with your own instruction it answers it as a question instead.";
  }
  if (tool === "chat") where += m.vision ? " This one can see images (👁)." : " This one cannot see images.";
  if (tool === "chat" && (m.format === "question" || m.format === "prompt")) {
    where += " It answers one question at a time, so the conversation goes to it as a transcript.";
  }
  if (tool === "chat" && m.maxImages === 1) where += " It takes one image per message: several ticked images go combined into one numbered picture.";
  if (tool === "chat" && m.needsImage) where += " It needs an image with every message.";
  if (tool === "improve" && m.format === "question") {
    where += " Moondream answers one question, so the instruction and your text go to its query mode together.";
  }
  toolRow(box, "Model", `${m.label} — ${where}`);
  toolRow(box, "Reads", info.reads);
  toolRow(box, "Instruction", instructionEditor(tool, info.scope));
  toolRow(box, "Limits", limitsEditor(tool, m, mine));
  toolRow(box, "Writes to", info.writes);
  if (tool === "chat" && sttModels.length) {
    const wrap = document.createElement("div");
    wrap.appendChild(sttPicker());
    toolRow(box, "Speech to text (🎤)", wrap);
  }
}

function instructionEditor(tool, scope) {
  const d = instructionDraft(tool);
  const def = defaultInstructions[tool] || "";
  const wrap = document.createElement("div");
  wrap.className = "instruction";

  const lab = document.createElement("label");
  lab.textContent = `Shared by ${scope}`;
  const ta = document.createElement("textarea");
  ta.className = "settings-system";
  ta.value = d.text;
  lab.appendChild(ta);
  wrap.appendChild(lab);

  const state = document.createElement("p");
  state.className = "hint settings-dirty";
  const undo = button("↶", "secondary instr-undo", () => {
    commitDraft(d);
    if (d.at > 0) setDraft(d.past[--d.at], false);
  });
  undo.setAttribute("aria-label", "Undo in the instruction");
  const redo = button("↷", "secondary instr-redo", () => {
    commitDraft(d);
    if (d.at < d.past.length - 1) setDraft(d.past[++d.at], false);
  });
  redo.setAttribute("aria-label", "Redo in the instruction");
  const save = button("Save", "instr-save", () => {
    commitDraft(d);
    const before = savedInstruction(tool);
    if (d.text === before) return;
    const t = toolSettings[tool];
    // The text being replaced is kept, so a save made in error is one pick away.
    t.versions = [{ text: before, at: Date.now() }, ...t.versions.filter((v) => v.text !== before && v.text !== d.text)].slice(0, INSTRUCTION_VERSIONS);
    // Saving the default text verbatim would pin it, so a later change to the
    // app's default would never reach this device. Equal to default = unset.
    t.system = d.text.trim() === def.trim() ? "" : d.text;
    saveToolSettings();
    delete instructionDrafts[tool];
    renderToolSettings();
  });
  const revert = button("Revert to saved", "secondary instr-revert", () => setDraft(savedInstruction(tool), true));
  const loadDefault = button("Load default", "secondary instr-default", () => setDraft(def, true));

  const refresh = () => {
    const dirty = d.text !== savedInstruction(tool);
    state.textContent = dirty
      ? "Not saved yet — the saved instruction is still the one sent."
      : toolSettings[tool].system
        ? "Saved. Your own instruction is sent."
        : "The app's default is sent.";
    state.classList.toggle("dirty", dirty);
    save.disabled = !dirty;
    revert.disabled = !dirty;
    loadDefault.disabled = d.text === def;
    undo.disabled = d.at <= 0 && d.past[d.at] === d.text;
    redo.disabled = d.at >= d.past.length - 1 || d.past[d.at] !== d.text;
  };
  // A replacement from a button is its own history step.
  function setDraft(text, record) {
    if (record) commitDraft(d);
    d.text = text;
    ta.value = text;
    if (record) commitDraft(d);
    refresh();
  }
  ta.addEventListener("input", () => {
    d.text = ta.value;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      commitDraft(d);
      refresh();
    }, INSTRUCTION_COMMIT_MS);
    refresh();
  });

  const row = document.createElement("div");
  row.className = "row";
  for (const b of [undo, redo, save, revert, loadDefault]) row.appendChild(b);
  wrap.appendChild(row);
  wrap.appendChild(state);

  const versions = toolSettings[tool].versions;
  if (versions.length) {
    const sel = document.createElement("select");
    sel.className = "settings-versions";
    sel.setAttribute("aria-label", "Earlier versions of the instruction");
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = `Earlier versions (${versions.length})…`;
    sel.appendChild(ph);
    versions.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      const when = v.at ? new Date(v.at).toLocaleString() : "";
      const text = v.text.replace(/\s+/g, " ");
      o.textContent = `${when} — ${text.length > 60 ? text.slice(0, 60) + "…" : text}`;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      const v = versions[Number(sel.value)];
      if (v) setDraft(v.text, true);
      sel.value = "";
    });
    wrap.appendChild(sel);
  }
  refresh();
  return wrap;
}

function limitsEditor(tool, m, mine) {
  const t = toolSettings[tool];
  const wrap = document.createElement("div");
  wrap.className = "limits";
  const store = () => {
    t.models[m.id] = mine;
    if (!Object.keys(mine).length) delete t.models[m.id];
    saveToolSettings();
  };

  const def = defaultMaxTokens(tool, m);
  const tok = document.createElement("label");
  tok.textContent = `Token limit — ${m.label} only`;
  const num = document.createElement("input");
  num.type = "number";
  num.min = "16";
  num.max = "8000";
  num.className = "settings-tokens";
  num.placeholder = `default ${def}`;
  num.value = mine.maxTokens || "";
  const cost = document.createElement("p");
  cost.className = "hint settings-cost";
  const showCost = () => {
    const n = Number(num.value) || def;
    cost.textContent = m.outPerM
      ? `At most ~${Math.round((n * m.outPerM) / 1e6).toLocaleString()} neurons of reply at ${n.toLocaleString()} tokens.`
      : "";
  };
  num.addEventListener("input", () => {
    const n = Math.floor(Number(num.value));
    if (n >= 16) mine.maxTokens = Math.min(n, 8000);
    else delete mine.maxTokens;
    store();
    showCost();
  });
  tok.appendChild(num);
  wrap.appendChild(tok);
  wrap.appendChild(cost);
  showCost();

  const row = document.createElement("div");
  row.className = "row";
  if (m.canThink) {
    const lab = document.createElement("label");
    lab.textContent = "Thinking";
    const sel = document.createElement("select");
    sel.className = "settings-thinking";
    const dflt = m.thinking === false ? "off" : "on";
    for (const [v, text] of [["", `Default (${dflt})`], ["on", "On"], ["off", "Off"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = typeof mine.thinking === "boolean" ? (mine.thinking ? "on" : "off") : "";
    sel.addEventListener("change", () => {
      if (sel.value === "") delete mine.thinking;
      else mine.thinking = sel.value === "on";
      store();
    });
    lab.appendChild(sel);
    row.appendChild(lab);
  }
  if (Array.isArray(m.efforts) && m.efforts.length) {
    const lab = document.createElement("label");
    lab.textContent = "Reasoning effort";
    const sel = document.createElement("select");
    sel.className = "settings-effort";
    // Only the values Cloudflare lists for this model: anything else is
    // silently rewritten on its side, sometimes to the priciest setting.
    const shown = m.effort || m.effortDefault;
    const opts = [["", `Default${shown ? ` (${shown})` : ""}`], ...m.efforts.map((e) => [e, e[0].toUpperCase() + e.slice(1)])];
    for (const [v, text] of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.value = mine.effort || "";
    sel.addEventListener("change", () => {
      if (sel.value) mine.effort = sel.value;
      else delete mine.effort;
      store();
    });
    lab.appendChild(sel);
    row.appendChild(lab);
  }
  if (row.children.length) {
    wrap.appendChild(row);
    if (m.effort && m.effortDefault && m.effort !== m.effortDefault) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = `Patchbay sends ${m.effort} unless you choose another; Cloudflare's own default for this model is ${m.effortDefault}.`;
      wrap.appendChild(p);
    }
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "This model takes no thinking or effort setting.";
    wrap.appendChild(p);
  }

  // Every sampling parameter this model's schema takes, within the range it
  // documents; blank means the model's own default. One the schema does not
  // list is not offered at all.
  const sampling = Object.entries(m.sampling || {});
  if (sampling.length) {
    const grid = document.createElement("div");
    grid.className = "sampling";
    for (const [name, [min, max, dflt]] of sampling) {
      const lab = document.createElement("label");
      lab.className = "sampling-field";
      const title = document.createElement("span");
      title.className = "sampling-name";
      title.textContent = name;
      lab.appendChild(title);
      const input = document.createElement("input");
      input.type = "number";
      input.className = `settings-${name.replace(/_/g, "-")}`;
      input.step = name === "top_k" || name === "seed" ? "1" : "0.01";
      if (min != null) input.min = String(min);
      if (max != null) input.max = String(max);
      input.placeholder = dflt != null ? `default ${dflt}` : "default not published";
      input.value = typeof mine[name] === "number" ? String(mine[name]) : "";
      const help = document.createElement("span");
      help.className = "hint";
      const range = min != null && max != null ? ` Range ${min}–${max}.` : "";
      help.textContent = SAMPLING_HELP[name] + range;
      input.addEventListener("input", () => {
        const v = input.value.trim() === "" ? NaN : Number(input.value);
        const inRange = Number.isFinite(v) && (min == null || v >= min) && (max == null || v <= max);
        input.classList.toggle("invalid", input.value.trim() !== "" && !inRange);
        if (inRange) mine[name] = name === "top_k" || name === "seed" ? Math.round(v) : v;
        else delete mine[name];
        store();
      });
      lab.appendChild(input);
      lab.appendChild(help);
      grid.appendChild(lab);
    }
    wrap.appendChild(grid);
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Cloudflare publishes no input schema for this model, so only the token limit is offered.";
    wrap.appendChild(p);
  }
  // Scoped to the model in its own label, so it cannot be mistaken for
  // resetting the instruction as well.
  wrap.appendChild(
    button(`Reset ${m.label} limits`, "secondary reset-limits", () => {
      delete t.models[m.id];
      saveToolSettings();
      renderToolSettings();
    })
  );
  return wrap;
}

function openTools(tool) {
  settingsOpenFor = tool;
  renderToolSettings();
  openSheet("sheet-tools");
}

function initToolSettings() {
  loadToolSettings();
  for (const tool of INSTRUCTABLE) {
    const btn = $(`${tool}-settings`);
    if (btn) btn.addEventListener("click", () => openTools(tool));
    $(TOOL_MODEL_SELECT[tool]).addEventListener("change", () => {
      refreshGears();
      if (settingsOpenFor === tool) renderToolSettings();
    });
  }
  $("open-tools").addEventListener("click", () => openTools("judge"));
  // An unsaved instruction is asked about rather than lost, or kept by accident.
  sheetGuards["sheet-tools"] = () => {
    const dirty = anyDraftDirty();
    if (!dirty.length) return true;
    const names = dirty.map((t) => TOOL_TABS.find(([id]) => id === t)[1]).join(", ");
    if (!window.confirm(`Discard the unsaved instruction changes (${names})?`)) return false;
    for (const t of dirty) delete instructionDrafts[t];
    return true;
  };
  refreshGears();
}

// ---------------------------------------------------------------------------
// Translate, the chat's 🎤, and the Other section
// ---------------------------------------------------------------------------
const TRANSLATE_KEY = "patchbay_translate";

function initTranslate() {
  const from = $("translate-from");
  const to = $("translate-to");
  if (!from || !translateLanguages.length) return;
  for (const sel of [from, to]) {
    for (const l of translateLanguages) {
      const o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.label;
      sel.appendChild(o);
    }
  }
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(TRANSLATE_KEY) || "{}") || {};
  } catch {
    /* defaults */
  }
  from.value = saved.from || "en";
  to.value = saved.to || "es";
  const remember = () => {
    try {
      localStorage.setItem(TRANSLATE_KEY, JSON.stringify({ from: from.value, to: to.value }));
    } catch {
      /* this visit only */
    }
  };
  from.addEventListener("change", remember);
  to.addEventListener("change", remember);

  const btn = $("prompt-translate");
  btn.addEventListener("click", async () => {
    const el = primaryPromptEl();
    const text = el ? el.value.trim() : "";
    if (!text) return void setStatus("Nothing to translate — write a prompt first.", "err");
    if (from.value === to.value) return void setStatus("Pick two different languages.", "err");
    btn.disabled = true;
    closeSheet("sheet-more");
    setStatus("Translating…", "load");
    try {
      const { res, data } = await apiWithin("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source_lang: from.value, target_lang: to.value }),
      });
      if (!res.ok || !data.text) throw new Error(data.error || `HTTP ${res.status}`);
      el.value = data.text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      commitPromptHistory(); // Undo puts the original back
      setStatus("Translated — press Undo to get the original back.", "ok");
      setTimeout(refreshNeurons, 4000);
    } catch (e) {
      setStatus("Translate failed: " + e.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
}

// Records with MediaRecorder where the browser has it, and falls back to a
// file picker where it does not. The transcript is added to the chat box, not
// sent, so it can be corrected first.
let micRecorder = null;

async function transcribeBlob(blob) {
  const btn = $("chat-mic");
  btn.disabled = true;
  setStatus("Transcribing…", "load");
  try {
    const file = new File([blob], "speech", { type: blob.type || "audio/mp4" });
    const { res, data } = await apiWithin("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: toolSettings.chat.stt || defaultSttModel,
        audio_b64: await fileToBase64(file),
        mime: file.type,
      }),
    });
    if (!res.ok || !data.text) throw new Error(data.error || `HTTP ${res.status}`);
    const input = $("chat-input");
    input.value = input.value.trim() ? `${input.value.trim()} ${data.text}` : data.text;
    setStatus("Transcribed into the chat box — edit it, then Send.", "ok");
    setTimeout(refreshNeurons, 4000);
  } catch (e) {
    setStatus("Transcription failed: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function initMic() {
  const btn = $("chat-mic");
  const file = $("chat-audio-file");
  if (!btn) return;
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (f) transcribeBlob(f);
  });
  btn.addEventListener("click", async () => {
    if (micRecorder) {
      micRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      file.click();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("No microphone access — pick a recording instead.", "err");
      file.click();
      return;
    }
    const chunks = [];
    micRecorder = new MediaRecorder(stream);
    micRecorder.addEventListener("dataavailable", (e) => e.data && e.data.size && chunks.push(e.data));
    micRecorder.addEventListener("stop", () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = micRecorder.mimeType || (chunks[0] && chunks[0].type) || "audio/mp4";
      micRecorder = null;
      btn.classList.remove("recording");
      btn.textContent = "🎤";
      if (chunks.length) transcribeBlob(new Blob(chunks, { type }));
    });
    micRecorder.start();
    btn.classList.add("recording");
    btn.textContent = "■";
    setStatus("Recording — tap ■ to stop.", "load");
  });
}

function currentOtherTool() {
  return otherTools.find((t) => t.id === $("other-tool").value) || otherTools[0];
}

function refreshOtherForm() {
  const t = currentOtherTool();
  if (!t) return;
  const text = $("other-text");
  text.classList.toggle("hidden", t.input === "image");
  text.placeholder = t.input === "rerank" ? "What to rank the passages against" : "Text to check";
  $("other-passages").classList.toggle("hidden", t.input !== "rerank");
  $("other-use-prompt").classList.toggle("hidden", t.input === "image");
  const note = $("other-image-note");
  note.classList.toggle("hidden", t.input !== "image");
  if (t.input === "image") {
    note.textContent = attachedImageFile() ? "Labels the attached image." : "No image attached — Run opens a picker.";
  }
  $("other-result").textContent = "";
}

function showOtherResult(t, result) {
  const box = $("other-result");
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  if (t.id === "guard") {
    box.textContent = typeof result === "string" ? result.trim() : JSON.stringify(result, null, 2);
  } else if (t.id === "rerank") {
    const passages = $("other-passages").value.split("\n").map((x) => x.trim()).filter(Boolean);
    box.textContent = result.map((r, i) => `${i + 1}. ${pct(r.score)} — ${passages[r.id] ?? `#${r.id}`}`).join("\n");
  } else if (Array.isArray(result)) {
    box.textContent = [...result].sort((a, b) => b.score - a.score).map((r) => `${r.label} — ${pct(r.score)}`).join("\n");
  } else {
    box.textContent = JSON.stringify(result, null, 2);
  }
}

async function runOther(imageFile) {
  const t = currentOtherTool();
  const body = { tool: t.id };
  if (t.input === "image") {
    const f = imageFile || attachedImageFile();
    if (!f) return void $("other-file").click();
    const im = await toolImage(f);
    if (!im) return void ($("other-result").textContent = "Failed: could not read that image.");
    body.image_b64 = im.b64;
  } else {
    body.text = $("other-text").value;
    if (t.input === "rerank") body.passages = $("other-passages").value.split("\n");
  }
  const btn = $("other-run");
  btn.disabled = true;
  $("other-result").textContent = "…";
  try {
    const { res, data } = await apiWithin("/api/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showOtherResult(t, data.result);
    setTimeout(refreshNeurons, 4000);
  } catch (e) {
    $("other-result").textContent = "Failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

function initOther() {
  const sel = $("other-tool");
  if (!sel || !otherTools.length) return;
  for (const t of otherTools) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.label;
    sel.appendChild(o);
  }
  sel.addEventListener("change", refreshOtherForm);
  $("other").addEventListener("toggle", refreshOtherForm);
  $("other-use-prompt").addEventListener("click", () => {
    const el = primaryPromptEl();
    if (el) $("other-text").value = el.value;
  });
  $("other-run").addEventListener("click", () => runOther());
  $("other-file").addEventListener("change", () => {
    const f = $("other-file").files && $("other-file").files[0];
    $("other-file").value = "";
    if (f) runOther(f);
  });
  refreshOtherForm();
}

// ---------------------------------------------------------------------------
// Embeddings
//
// Write something, change it, and watch the numbers move. Each measured
// version is the text plus the model's list of numbers for it; every row shows
// how close it is in meaning to the baseline (the first version, unless another
// is set) and to the version before it, and draws the list as a barcode with a
// second strip for what changed since the previous version.
//
// Lists from different models cannot be compared, so the history is kept per
// model, in this browser. Numbers are rounded to 4 places to keep the store
// small; that moves a similarity by far less than the 3 places shown.
// ---------------------------------------------------------------------------
const EMBED_STORE_KEY = "patchbay_embed";
const EMBED_MODEL_KEY = "patchbay_embed_model";
const EMBED_MAX_VERSIONS = 30;
const EMBED_IDLE_MS = 1000;

let embedStore = {}; // model id -> { baseline: index, versions: [{ text, vec }] }
let embedTimer = null;
let embedBusy = false;
let embedAgain = false;

function embedHistory() {
  const id = $("embed-model").value;
  if (!embedStore[id]) embedStore[id] = { baseline: 0, versions: [] };
  return embedStore[id];
}

function saveEmbed() {
  try {
    localStorage.setItem(EMBED_STORE_KEY, JSON.stringify(embedStore));
  } catch {
    /* full or blocked: the history still works for this visit */
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// One column per number. Orange for positive, blue for negative, brighter the
// larger it is. `scale` is shared by every strip of one history, so a faint
// change strip means a small change rather than a rescaled one.
function drawStrip(canvas, values, scale) {
  const w = values.length;
  canvas.width = w;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, 1);
  for (let i = 0; i < w; i++) {
    const t = Math.max(-1, Math.min(1, values[i] / scale));
    const k = Math.abs(t);
    const [r, g, b] = t >= 0 ? [255, 138, 61] : [90, 169, 255];
    img.data[i * 4] = Math.round(15 + (r - 15) * k);
    img.data[i * 4 + 1] = Math.round(17 + (g - 17) * k);
    img.data[i * 4 + 2] = Math.round(21 + (b - 21) * k);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function renderEmbed() {
  const h = embedHistory();
  const list = $("embed-list");
  list.innerHTML = "";
  const m = embedModels.find((x) => x.id === $("embed-model").value);
  const note = [];
  if (m) {
    note.push(`${m.dims.toLocaleString()} numbers per text`);
    note.push(m.neuronsPerM ? `~${m.neuronsPerM.toLocaleString()} neurons per million tokens` : "no published rate");
  }
  if (h.versions.length) note.push(`${h.versions.length} version${h.versions.length === 1 ? "" : "s"}`);
  if ($("embed-pause").checked) note.push("paused");
  $("embed-note").textContent = note.join(" · ");
  if (!h.versions.length) return;

  let scale = 0;
  for (const v of h.versions) for (const x of v.vec) scale = Math.max(scale, Math.abs(x));
  const base = h.versions[h.baseline] || h.versions[0];

  // Newest first: the change just made is the one being watched.
  for (let i = h.versions.length - 1; i >= 0; i--) {
    const v = h.versions[i];
    const prev = h.versions[i - 1];
    const row = document.createElement("div");
    row.className = "embed-row" + (i === h.baseline ? " baseline" : "");

    const text = document.createElement("p");
    text.className = "embed-text";
    text.textContent = v.text;
    row.appendChild(text);

    const scores = document.createElement("p");
    scores.className = "embed-scores";
    const parts = [];
    parts.push(i === h.baseline ? "<b>baseline</b>" : `vs baseline <b>${cosine(v.vec, base.vec).toFixed(3)}</b>`);
    if (prev) parts.push(`vs previous <b>${cosine(v.vec, prev.vec).toFixed(3)}</b>`);
    scores.innerHTML = parts.join(" · ");
    row.appendChild(scores);

    const strip = document.createElement("canvas");
    strip.className = "embed-strip";
    drawStrip(strip, v.vec, scale);
    row.appendChild(strip);

    if (prev) {
      const label = document.createElement("p");
      label.className = "embed-strip-label";
      label.textContent = "change since previous";
      row.appendChild(label);
      const diff = document.createElement("canvas");
      diff.className = "embed-strip diff";
      drawStrip(diff, v.vec.map((x, j) => x - prev.vec[j]), scale);
      row.appendChild(diff);
    }

    if (i !== h.baseline) {
      const set = document.createElement("button");
      set.type = "button";
      set.className = "secondary";
      set.textContent = "Set as baseline";
      set.addEventListener("click", () => {
        h.baseline = i;
        saveEmbed();
        renderEmbed();
      });
      row.appendChild(set);
    }
    list.appendChild(row);
  }
}

async function measureEmbed() {
  const text = $("embed-text").value.trim();
  if (!text) return;
  const h = embedHistory();
  const last = h.versions[h.versions.length - 1];
  if (last && last.text === text) return; // nothing changed since the last measure
  if (embedBusy) {
    embedAgain = true;
    return;
  }
  embedBusy = true;
  const model = $("embed-model").value;
  try {
    const { res, data } = await apiWithin("/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, text }),
    });
    if (!res.ok || !Array.isArray(data.vector)) throw new Error(data.error || `HTTP ${res.status}`);
    const hist = embedStore[model] || (embedStore[model] = { baseline: 0, versions: [] });
    hist.versions.push({ text, vec: data.vector.map((x) => Math.round(x * 1e4) / 1e4) });
    if (hist.versions.length > EMBED_MAX_VERSIONS) {
      hist.versions.shift();
      hist.baseline = Math.max(0, hist.baseline - 1);
    }
    if (typeof data.neurons === "number") sessionNeurons += data.neurons;
    saveEmbed();
    if ($("embed-model").value === model) renderEmbed();
  } catch (e) {
    setStatus("Embedding failed: " + e.message, "err");
  } finally {
    embedBusy = false;
    if (embedAgain) {
      embedAgain = false;
      measureEmbed();
    }
  }
}

function initEmbed() {
  const sel = $("embed-model");
  if (!sel) return;
  for (const m of embedModels) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  try {
    embedStore = JSON.parse(localStorage.getItem(EMBED_STORE_KEY) || "{}") || {};
    const saved = localStorage.getItem(EMBED_MODEL_KEY);
    sel.value = embedModels.some((m) => m.id === saved) ? saved : defaultEmbedModel;
  } catch {
    embedStore = {};
    sel.value = defaultEmbedModel;
  }
  sel.addEventListener("change", () => {
    try {
      localStorage.setItem(EMBED_MODEL_KEY, sel.value);
    } catch {
      /* remembered for this visit only */
    }
    renderEmbed();
  });

  // Measured once typing has stopped for a moment, unless paused; Measure now
  // works either way.
  $("embed-text").addEventListener("input", () => {
    clearTimeout(embedTimer);
    if ($("embed-pause").checked) return;
    embedTimer = setTimeout(measureEmbed, EMBED_IDLE_MS);
  });
  $("embed-pause").addEventListener("change", () => {
    clearTimeout(embedTimer);
    renderEmbed();
  });
  $("embed-measure").addEventListener("click", measureEmbed);
  $("embed-clear").addEventListener("click", () => {
    const h = embedHistory();
    if (h.versions.length && !window.confirm("Clear this model's versions?")) return;
    delete embedStore[sel.value];
    saveEmbed();
    renderEmbed();
  });
  renderEmbed();
}

// ---------------------------------------------------------------------------
// Judge (p-judger)
//
// Scores how well an image matches the prompt. It is a prompt tool rather than
// a catalogue model because it returns a number, not media: it has no place in
// the model picker, the generation polling loop, or the output panel. Its
// score renders under the toolbar so that scoring a generation does not clear
// the generation.
//
// It reuses what is already on screen instead of asking for it again — the
// prompt you typed, and the image you already have. Priority is the generated
// image first (scoring what you just made against the prompt that made it is
// the common case), then an attached input image, then a file picker. The note
// line always says which one it will read, so it is never a guess.
// ---------------------------------------------------------------------------

// Only images can be scored. A video generation is not a target, and neither
// is a trained-LoRA .zip.
// The attached images Judge will score: every image in the FIRST image field
// that holds any. Field-scoped rather than model-scoped on purpose — several
// models carry image fields with unrelated roles (person_image next to
// garment_images, image next to last_frame_image), and scoring those together
// against a single prompt would be meaningless. Within one field they are the
// same kind of thing, so a batch is exactly right.
function attachedImageBatch() {
  if (!currentModel) return [];
  for (const f of currentModel.fields) {
    if (f.type !== "image") continue;
    const list = (uploads[f.name] || []).filter((u) => u.file && u.isImage);
    if (list.length) return list.slice(0, judgeMaxImages);
  }
  return [];
}

function judgeTarget() {
  if (lastResult.urls.length && lastResult.kind === "image") {
    return { from: "result", label: lastResult.urls.length > 1 ? `the ${lastResult.urls.length} generated images` : "the generated image" };
  }
  const batch = attachedImageBatch();
  if (batch.length) {
    return {
      from: "attached",
      // Name the file when there is one, count them when there are several —
      // the note has to make a partial read impossible to miss.
      label: batch.length > 1 ? `${batch.length} attached images` : "the attached image",
    };
  }
  return null;
}

function updateJudgeNote() {
  // Score sits under a generated image, and only while one is on screen.
  const scoreBtn = $("prompt-judge");
  if (scoreBtn) scoreBtn.classList.toggle("hidden", !(lastResult.urls.length && lastResult.kind === "image"));
  const noteEl = $("judge-note");
  if (!noteEl) return; // called before the toolbar exists
  noteEl.innerHTML = "";
  const t = judgeTarget();
  const text = document.createElement("span");
  text.textContent = t ? `⚖️ Scores ${t.label} against your prompt` : "⚖️ Pick image(s) to score against your prompt";
  noteEl.appendChild(text);
  // The button always scores the disclosed target, so without this there would
  // be no way to reach the file picker — or batch mode — while an image is
  // attached.
  if (t) {
    const alt = document.createElement("button");
    alt.type = "button";
    alt.className = "linkish";
    alt.textContent = "pick files instead";
    alt.addEventListener("click", () => $("judge-file").click());
    noteEl.appendChild(document.createTextNode(" · "));
    noteEl.appendChild(alt);
  }
}

function clearJudgeResult() {
  for (const id of ["judge-result", "lab-judge-result"]) {
    const box = $(id);
    if (!box) continue;
    box.innerHTML = "";
    box.classList.add("hidden");
  }
  updateJudgeNote();
}

// p-judger takes URIs, and the ones it accepts are Pruna file URLs. An upload
// on a Pruna model already is one; anything else (a Workers AI base64 blob, an
// xAI data: URI, a freshly picked file, a finished generation) has to be sent
// through /api/upload first.
const PRUNA_URL = /^https:\/\/([a-z0-9-]+\.)*pruna\.ai\//i;

async function uploadForJudge(blob, name) {
  const fd = new FormData();
  fd.append("file", new File([blob], name || "image", { type: blob.type || "image/jpeg" }));
  const res = await api("/api/upload", { method: "POST", body: fd, retry: true });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error || data.message || "Upload failed");
  return data.url;
}

// The generated images, as URLs p-judger will accept, so what gets scored is
// what is actually on screen.
//
// showResult already holds every result's bytes, so the usual path costs no
// download at all. It used to re-fetch each one through /api/result regardless:
// a second full transfer per scoring, and an outright failure once the
// provider's delivery URL had expired on an image still sitting in the panel.
// The fetch survives only for the case showResult itself falls back to, where
// that first read failed and there are no bytes in hand.
async function generatedImageUrls() {
  const out = [];
  for (let i = 0; i < lastResult.urls.length && out.length < judgeMaxImages; i++) {
    const u = lastResult.urls[i];
    if (PRUNA_URL.test(u)) {
      out.push(u); // already a Pruna file URL — nothing to upload
      continue;
    }
    const held = lastResult.blobs[i];
    if (held instanceof Blob) {
      out.push(await uploadForJudge(held, "generated"));
      continue;
    }
    await refreshResultToken();
    const res = await api(resultUrl(u));
    if (!res.ok) throw new Error(`Could not read the generated image (HTTP ${res.status}).`);
    out.push(await uploadForJudge(await res.blob(), "generated"));
  }
  return out;
}

async function attachedImageUrls() {
  const out = [];
  for (const u of attachedImageBatch()) {
    // An upload on a Pruna model already is a Pruna file URL; anything else
    // (Workers AI base64, an xAI data: URI) has to go through /api/upload.
    out.push(typeof u.url === "string" && PRUNA_URL.test(u.url) ? u.url : await uploadForJudge(u.file, u.name));
  }
  return out;
}

// Two ways in: Score under a generated image, which scores what is on screen,
// and the Lab card, which scores whatever judgeTarget() names or files picked
// there — batch mode included. Each shows its score where it was asked for.
function initJudge() {
  const btn = $("prompt-judge");
  const labBtn = $("lab-judge");
  const picker = $("judge-file");

  btn.addEventListener("click", () => runJudge(null, btn, "judge-result"));
  labBtn.addEventListener("click", () => {
    if (judgeTarget()) runJudge(null, labBtn, "lab-judge-result");
    else picker.click();
  });

  picker.addEventListener("change", () => {
    const files = Array.from(picker.files || []).slice(0, judgeMaxImages);
    picker.value = "";
    if (files.length) runJudge(files, labBtn, "lab-judge-result");
  });

  async function runJudge(files, btn, boxId) {
    const promptEl = primaryPromptEl();
    const prompt = promptEl ? promptEl.value.trim() : "";
    if (!prompt) {
      setStatus("Write a prompt first — the score is against it.", "err");
      return;
    }

    btn.disabled = true;
    const idle = btn.textContent;
    btn.textContent = "Scoring…";
    setStatus("Scoring…", "load");
    try {
      let images;
      if (files && files.length) {
        images = [];
        for (const f of files) images.push(await uploadForJudge(f, f.name));
      } else {
        const t = judgeTarget();
        images = t && t.from === "result" ? await generatedImageUrls() : await attachedImageUrls();
      }
      if (!images.length) throw new Error("No image to score.");

      const { res, data } = await apiWithin("/api/judge", {
        method: "POST",
        retry: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, images }),
      });
      if (!res.ok || !Array.isArray(data.scores)) throw new Error(data.error || `HTTP ${res.status}`);

      renderJudge(data.scores, data.raw, boxId);
      const cost = judgeUsdPerImage * images.length;
      if (cost > 0) {
        sessionSpend += cost;
        sessionRuns++;
        updateSpendBar();
      }
      setStatus(`Scored ${images.length} image${images.length === 1 ? "" : "s"}. Est. ${fmtUsd(cost)}.`, "ok");
    } catch (e) {
      setStatus("Judge failed: " + e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = idle;
    }
  }

  updateJudgeNote();
}

// The live API returns `total` and nothing else, so that is what gets the
// headline. Pruna's docs also describe level1/level2/level3/detailed fields
// that no call has produced; showing the whole payload behind a disclosure
// means any of those appearing later is visible without a code change, rather
// than silently dropped. The scale is undocumented, so the number is shown as
// a number — never a percentage or a bar.
function renderJudge(scores, raw, boxId = "judge-result") {
  const box = $(boxId);
  box.innerHTML = "";

  const list = document.createElement("div");
  list.className = "judge-scores";
  scores.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "judge-score";
    if (scores.length > 1) {
      const idx = document.createElement("span");
      idx.className = "judge-index";
      idx.textContent = `#${i + 1}`;
      row.appendChild(idx);
    }
    const val = document.createElement("span");
    val.className = "judge-total";
    // A payload without `total` is not something to invent a headline for —
    // say so and let the disclosure below carry the actual content.
    const total = s && typeof s.total === "number" ? s.total : null;
    val.textContent = total == null ? "—" : total.toFixed(2);
    row.appendChild(val);
    const key = document.createElement("span");
    key.className = "judge-key";
    key.textContent = total == null ? "no total field — see payload" : "total";
    row.appendChild(key);
    list.appendChild(row);
  });
  box.appendChild(list);

  const det = document.createElement("details");
  det.className = "judge-payload";
  const sum = document.createElement("summary");
  sum.textContent = "Full payload";
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(raw, null, 2);
  det.appendChild(pre);
  box.appendChild(det);

  box.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Prompt undo / redo
//
// The main prompt box only. It is the one field that gets rewritten wholesale by
// something other than typing — Improve, Describe, loading a saved prompt,
// Reset — and none of those used to have a way back. Nothing else on the form is
// covered: an option is a single value you can see and set back, a prompt is
// paragraphs you cannot.
//
// The buttons are the interface. iOS has no keyboard chord for undo in a web
// textarea and the shake-to-undo gesture does not reach one, so on a phone a
// visible control is the only way to offer this at all; the desktop shortcuts
// below are a convenience on top.
//
// The history is text, not a reference to the element the text was typed into,
// so it outlives the prompt box: switching models keeps it, and so does a Reset.
// A model with no prompt field at all simply has nothing to apply it to, so the
// buttons go inert there and come back when a prompt field does.
//
// In memory and per-load: the text itself is what the session snapshot persists,
// not the route taken to it.
// ---------------------------------------------------------------------------
// Long enough that a burst of typing is one entry, short enough that a pause to
// think is a boundary you can come back to.
const PROMPT_COMMIT_MS = 500;
const PROMPT_HISTORY_MAX = 200;

let promptHistory = []; // [{ text, start, end }], oldest first
let promptIndex = -1; // which entry the box is currently showing
let promptCommitTimer = null;
let applyingPromptState = false;

function promptStateNow() {
  const el = primaryPromptEl();
  if (!el) return null;
  const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
  return { text: el.value, start, end };
}

// Starts the history over from whatever the box holds now. A page load only:
// there is no earlier history to keep, and a restored prompt is the baseline
// rather than something to undo out of.
function syncPromptHistory() {
  clearTimeout(promptCommitTimer);
  promptCommitTimer = null;
  const s = promptStateNow();
  promptHistory = s ? [s] : [];
  promptIndex = s ? 0 : -1;
  updatePromptHistoryButtons();
}

// True while the box holds an edit that has not been committed as an entry yet —
// i.e. mid-burst typing. Redo is unavailable in that state because those
// keystrokes are exactly what "type something new" means.
function promptDiverged() {
  const s = promptStateNow();
  if (!s || promptIndex < 0) return false;
  return promptHistory[promptIndex].text !== s.text;
}

// Records the box's current text as one entry. Called directly by anything that
// replaces the prompt in one go, and by the typing timer below.
function commitPromptHistory() {
  clearTimeout(promptCommitTimer);
  promptCommitTimer = null;
  const s = promptStateNow();
  if (!s) return;
  if (promptIndex >= 0 && promptHistory[promptIndex].text === s.text) {
    promptHistory[promptIndex] = s; // same text, newer caret — not a new entry
    updatePromptHistoryButtons();
    return;
  }
  promptHistory.splice(promptIndex + 1); // a new edit after an undo drops the redo tail
  promptHistory.push(s);
  if (promptHistory.length > PROMPT_HISTORY_MAX) promptHistory.shift();
  promptIndex = promptHistory.length - 1;
  updatePromptHistoryButtons();
}

function applyPromptState(state) {
  const el = primaryPromptEl();
  if (!el) return;
  applyingPromptState = true;
  el.value = state.text;
  try {
    el.setSelectionRange(state.start, state.end);
  } catch {
    /* not a control with a selection — the text is what matters */
  }
  // Other listeners still have to hear this: a stale Improve undo has to drop,
  // and the session snapshot has to follow the new text. The flag keeps this
  // module's own input handler from treating it as fresh typing.
  el.dispatchEvent(new Event("input", { bubbles: true }));
  applyingPromptState = false;
  updatePromptHistoryButtons();
}

// A model with no prompt field has nowhere to put a restored state, so the
// history is held rather than applied — it comes back with the next model that
// does have one.
const canUndoPrompt = () => Boolean(primaryPromptEl()) && (promptIndex > 0 || promptDiverged());
const canRedoPrompt = () =>
  Boolean(primaryPromptEl()) && !promptDiverged() && promptIndex >= 0 && promptIndex < promptHistory.length - 1;

function undoPrompt() {
  if (!canUndoPrompt()) return;
  // An uncommitted edit is committed first, so undoing out of it leaves it
  // sitting there as the redo target rather than losing it.
  if (promptDiverged()) commitPromptHistory();
  if (promptIndex <= 0) {
    updatePromptHistoryButtons();
    return;
  }
  promptIndex--;
  applyPromptState(promptHistory[promptIndex]);
}

function redoPrompt() {
  if (!canRedoPrompt()) return;
  promptIndex++;
  applyPromptState(promptHistory[promptIndex]);
}

function updatePromptHistoryButtons() {
  const u = $("prompt-undo");
  const r = $("prompt-redo");
  if (u) u.disabled = !canUndoPrompt();
  if (r) r.disabled = !canRedoPrompt();
}

function initPromptHistory() {
  $("prompt-undo").addEventListener("click", undoPrompt);
  $("prompt-redo").addEventListener("click", redoPrompt);

  // Delegated on the form, because the prompt element is replaced whenever the
  // fields re-render.
  $("gen-form").addEventListener("input", (e) => {
    if (applyingPromptState) return;
    if (e.target !== primaryPromptEl()) return;
    // One entry per burst of typing rather than one per keystroke.
    clearTimeout(promptCommitTimer);
    promptCommitTimer = setTimeout(commitPromptHistory, PROMPT_COMMIT_MS);
    updatePromptHistoryButtons();
  });

  // Desktop only, and only while the prompt itself has focus — the browser's
  // own undo would otherwise fight this one over the same text.
  $("gen-form").addEventListener("keydown", (e) => {
    if (e.target !== primaryPromptEl()) return;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = (e.key || "").toLowerCase();
    if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) redoPrompt();
      else undoPrompt();
    } else if (k === "y") {
      e.preventDefault();
      redoPrompt();
    }
  });

  syncPromptHistory();
}

function initPromptLibrary() {
  refreshPromptSelect();
  initImproveModelPicker();
  initDescribe();
  initChat();
  initEmbed();
  initToolSettings();
  initTranslate();
  initMic();
  initOther();
  initJudge();
  initPromptHistory();

  $("prompt-select").addEventListener("change", (e) => {
    const idx = e.target.value;
    if (idx === "") return;
    const p = loadPrompts()[Number(idx)];
    const el = primaryPromptEl();
    if (!p || !el) return;
    el.value = p.text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    commitPromptHistory(); // one entry for the whole load, undoable in one press
    closeSheet("sheet-prompts");
    setStatus(`Loaded prompt "${p.name}" — press Undo to get yours back.`, "ok");
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

  // "Improve" rewrites the prompt in place via a small chat model. It used to
  // turn into its own one-shot "↩ Undo" afterwards, which is now the prompt
  // Undo button's job — and that one is not one-shot, does not go stale when you
  // type, and covers Describe and saved prompts the same way. So the button
  // stays Improve and only ever improves.
  // Improve reads the prompt text and nothing else: it is a copy edit, and the
  // instruction it runs under says so. While it runs the button is its Cancel.
  const improveBtn = $("prompt-improve");
  const improveIdle = improveBtn.textContent;
  let improving = null;
  improveBtn.addEventListener("click", async () => {
    if (improving) return void improving.abort();
    const el = primaryPromptEl();
    if (!el) return;

    const text = el.value.trim();
    if (!text) {
      setStatus("Write a prompt first, then hit Improve.", "err");
      return;
    }

    improving = new AbortController();
    const cancel = () => improving && improving.abort();
    improveBtn.textContent = "✕ Cancel";
    improveBtn.classList.add("running");
    setStatus("Improving the prompt…", "load", { cancel });
    const modelId = $("improve-model").value;
    try {
      const data = await streamTool(
        "/api/improve-prompt",
        { prompt: text, model: modelId, settings: toolSettingsFor("improve", modelId) },
        {
          controller: improving,
          onEvent: (name, d) => {
            if (name === "progress") setStatus(d.chars ? `Improving the prompt… ${d.chars} characters` : "Improving the prompt… thinking", "load", { cancel });
          },
        }
      );
      if (!data.prompt) throw new Error("The model returned nothing usable.");
      el.value = data.prompt;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      commitPromptHistory(); // the rewrite is one entry, so Undo reverses it whole
      setStatus("Prompt improved — press Undo to revert.", "ok");
      // A reasoning rewrite can cost hundreds of neurons, enough to move the
      // daily meter on its own, so it counts like a generation does. The
      // stream reports what this one actually used; the list figure stands in
      // where it does not.
      const im = improveModels.find((m) => m.id === modelId);
      if (typeof data.neurons === "number") sessionNeurons += data.neurons;
      else if (im && im.neurons) sessionNeurons += im.neurons;
      updateSpendBar();
      setTimeout(refreshNeurons, 4000);
    } catch (e) {
      if (e.message === TOOL_CANCELLED) setStatus("Improve cancelled. The prompt is unchanged.", "ok");
      else setStatus("Improve failed: " + e.message, "err");
    } finally {
      improving = null;
      improveBtn.classList.remove("running");
      improveBtn.textContent = improveIdle;
    }
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
const CF_NEURON_WARN_AT = 0.8; // the spend bar turns amber at 8,000 of the 10,000

// Neurons for one Workers AI run, from Cloudflare's published per-model rates.
function estimateNeurons(model, input) {
  const p = model.price;
  if (!p || p.type !== "cf_neurons") return null;
  if (p.free) return 0; // Cloudflare lists these at $0.00 — unmetered.
  if (p.perKChars != null) return (String(input.text ?? input.prompt ?? "").length / 1000) * p.perKChars;
  if (p.perAudioMin != null) return null; // priced on the audio's length, unknown until it exists

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

// How many seconds of video a run will bill for. An attached audio track wins:
// p-video, p-video-2 and p-video-infiniteworlds all document audio as setting
// the length and the duration field as ignored when one is present, so its
// probed length is what gets billed. Falls back to the duration setting, and to
// nothing at all when neither is known — p-video-2 lets the length be left to
// the model, and an estimate cannot be invented for that.
function outputSeconds(model, input) {
  const audio = (uploads.audio || [])[0];
  if (audio && audio.durationSec) return audio.durationSec;
  const secs = Number(input.duration ?? fieldDefault(model, "duration"));
  return Number.isFinite(secs) && secs > 0 ? secs : null;
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
    const secs = outputSeconds(model, input);
    if (!secs) return null;
    return rate * secs;
  }
  if (p.type === "per_second_flat") {
    const secs = outputSeconds(model, input);
    return secs ? p.usd * secs : null;
  }
  if (p.type === "per_second_mode") {
    const resolution = input.resolution ?? fieldDefault(model, "resolution") ?? "768p";
    const tier = p.usd[resolution];
    if (!tier) return null;
    const mode = input.mode ?? fieldDefault(model, "mode") ?? "speed";
    const rate = tier[mode];
    if (rate == null) return null;
    const secs = outputSeconds(model, input);
    return secs ? rate * secs : null;
  }
  // Rate depends on whether the model finds text in the image, which it decides
  // during the run. Guessing either end would be worse than saying nothing.
  if (p.type === "routed_text") return null;
  if (p.type === "video_second_draft") {
    // There is no duration field: the output runs as long as the source clip,
    // whose length was probed client-side when it was picked. Without that
    // reading there is nothing to multiply, so no estimate is shown.
    const src = (uploads.video || [])[0];
    if (!src || !src.durationSec) return null;
    const draft = input.draft ?? fieldDefault(model, "draft") ?? false;
    return src.durationSec * (draft ? p.usd.draft : p.usd.normal);
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
  if (model.price && model.price.perAudioMin != null) {
    updateSpendBar();
    return `Priced on the speech's length, ~${model.price.perAudioMin} neurons per minute.`;
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
  // On Workers Paid, going past the free allowance is billed rather than
  // refused, so the bar warns on the way up and then prices the overage.
  let level = "";
  if (actualNeurons) {
    const used = actualNeurons.used;
    const limit = actualNeurons.limit;
    const pct = Math.round((used / limit) * 100);
    if (used >= limit) {
      level = "over";
      const over = used - limit;
      parts.push(
        `⚠ Workers AI past the free ${limit.toLocaleString()} neurons today: ` +
        `${Math.round(used).toLocaleString()} used, ${Math.round(over).toLocaleString()} over ` +
        `≈ ${fmtUsd(over * CF_USD_PER_NEURON)} billed so far`
      );
    } else {
      if (used >= limit * CF_NEURON_WARN_AT) level = "warn";
      parts.push(
        `${level ? "⚠ " : ""}Workers AI ${Math.round(used).toLocaleString()} of ` +
        `${limit.toLocaleString()} neurons used today (${pct}%, ` +
        `${Math.round(actualNeurons.remaining).toLocaleString()} left` +
        `${level ? `, then ${fmtUsd(1000 * CF_USD_PER_NEURON)} per 1,000` : ""})`
      );
    }
  } else if (sessionNeurons > 0) {
    // A lower bound on the day: it only knows about this tab.
    if (sessionNeurons >= CF_FREE_NEURONS) level = "over";
    else if (sessionNeurons >= CF_FREE_NEURONS * CF_NEURON_WARN_AT) level = "warn";
    parts.push(
      `${level ? "⚠ " : ""}Workers AI ~${Math.round(sessionNeurons).toLocaleString()} neurons this session (est.)` +
      (level === "over" ? ` — past the free ${CF_FREE_NEURONS.toLocaleString()}, now billed` : "")
    );
  }
  el.dataset.level = level;

  // Pruna bills in dollars and has no usage API, so it stays an estimate.
  if (sessionSpend > 0) parts.push(`Pruna ~${fmtUsd(sessionSpend)} this session (est.)`);

  if (!parts.length) parts.push("no usage recorded yet");
  if (sessionRuns > 0) parts.push(`${sessionRuns} run${sessionRuns === 1 ? "" : "s"} this session`);
  el.textContent = parts.join(" · ");

  // The same in a few characters, for the top bar; the sentence above opens
  // from it.
  const pill = $("spend-pill");
  if (pill) {
    let short = "";
    if (actualNeurons) {
      const over = actualNeurons.used - actualNeurons.limit;
      short = over >= 0 ? `+${Math.round(over).toLocaleString()} over` : `${Math.round((actualNeurons.used / actualNeurons.limit) * 100)}%`;
    } else if (sessionNeurons > 0) {
      short = `~${Math.round(sessionNeurons).toLocaleString()} neurons`;
    }
    if (sessionSpend > 0) short += `${short ? " · " : ""}${fmtUsd(sessionSpend)}`;
    pill.textContent = `⚡ ${short || "Usage"}`;
    pill.dataset.level = level;
  }
}


// ---------------------------------------------------------------------------
// Shell: the two screens, the sheets, the usage pill and the bottom bar
//
// Create holds what making a picture needs, in the order it is done; Lab holds
// the tools that work on their own text or images. The chat, saved prompts,
// Describe and Translate, and the ⚙ Tools page open as sheets over whichever
// screen is showing, so nothing has to be scrolled past to reach the prompt.
// The bottom bar is always on screen: the status line is where every tool and
// every run reports, and Generate never scrolls out of reach.
// ---------------------------------------------------------------------------
const SCREEN_KEY = "patchbay_screen";
// Per sheet, a check run before it closes; false keeps it open.
const sheetGuards = {};

function openSheet(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("hidden");
  document.body.classList.add("sheet-open");
}

function closeSheet(id) {
  const el = $(id);
  if (!el || el.classList.contains("hidden")) return true;
  if (sheetGuards[id] && !sheetGuards[id]()) return false;
  el.classList.add("hidden");
  if (!document.querySelector(".sheet:not(.hidden)")) document.body.classList.remove("sheet-open");
  return true;
}

function showScreen(which) {
  const lab = which === "lab";
  $("screen-create").classList.toggle("hidden", lab);
  $("screen-lab").classList.toggle("hidden", !lab);
  $("tab-create").setAttribute("aria-selected", String(!lab));
  $("tab-lab").setAttribute("aria-selected", String(lab));
  // Generate belongs to Create; the status line stays, since Lab reports there too.
  $("action-row").classList.toggle("hidden", lab);
  try {
    localStorage.setItem(SCREEN_KEY, lab ? "lab" : "create");
  } catch {
    /* this visit only */
  }
}

function initShell() {
  for (const sheet of document.querySelectorAll(".sheet")) {
    // The backdrop closes; the card itself does not.
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) closeSheet(sheet.id);
    });
    for (const b of sheet.querySelectorAll(".sheet-close")) b.addEventListener("click", () => closeSheet(sheet.id));
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".sheet:not(.hidden)")].pop();
    if (open) closeSheet(open.id);
  });
  $("open-chat").addEventListener("click", () => {
    openSheet("sheet-chat");
    renderChatImages();
    updateChatNote();
    const box = $("chat-thread");
    box.scrollTop = box.scrollHeight;
  });
  $("open-prompts").addEventListener("click", () => openSheet("sheet-prompts"));
  $("open-more").addEventListener("click", () => openSheet("sheet-more"));

  $("tab-create").addEventListener("click", () => showScreen("create"));
  $("tab-lab").addEventListener("click", () => showScreen("lab"));
  let screen = "create";
  try {
    screen = localStorage.getItem(SCREEN_KEY) || "create";
  } catch {
    /* Create */
  }
  showScreen(screen);

  const pill = $("spend-pill");
  pill.addEventListener("click", () => {
    const open = $("spend").classList.toggle("hidden") === false;
    pill.setAttribute("aria-expanded", String(open));
  });

  // The bar is fixed, so the page keeps room for it at the bottom, following
  // its height as the status line comes and goes.
  const bar = $("bottombar");
  const pad = () => document.body.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
  if (window.ResizeObserver) new ResizeObserver(pad).observe(bar);
  pad();

  // A long message is clamped to two lines: a tap shows all of it, and a tap
  // on a finished message clears it. A running one stays.
  $("status").addEventListener("click", () => {
    const el = $("status");
    if (el.dataset.mode === "load") return;
    const text = el.querySelector(".status-text");
    if (!el.classList.contains("expanded") && text && text.scrollHeight > text.clientHeight + 2) el.classList.add("expanded");
    else setStatus("", "hide");
  });
  updateSpendBar();
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
// `opts.cancel`, on a "load" status, adds a Cancel beside the text that calls it.
function setStatus(msg, mode, opts = {}) {
  const el = $("status");
  if (mode === "hide" || !msg) {
    el.classList.add("hidden");
    el.innerHTML = "";
    el.dataset.mode = "";
    return;
  }
  const cls = "status" + (mode === "err" ? " err" : mode === "ok" ? " ok" : "");
  const placeCancel = () => {
    const old = el.querySelector(".status-cancel");
    if (old) old.remove();
    if (!opts.cancel) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linkish status-cancel";
    b.textContent = "Cancel";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.cancel();
    });
    el.appendChild(b);
  };
  // A progress line is rewritten every second now. Rebuilding the spinner on
  // each one restarts its CSS animation, so it twitches at the top of every
  // rotation instead of turning — keep the element and swap only the text
  // while the mode is unchanged.
  const text = el.querySelector(".status-text");
  if (el.dataset.mode === mode && text) {
    el.className = cls + (el.classList.contains("expanded") ? " expanded" : "");
    text.textContent = msg;
    if (Boolean(opts.cancel) !== Boolean(el.querySelector(".status-cancel")) || opts.cancel) placeCancel();
    el.classList.remove("hidden");
    return;
  }
  el.className = cls;
  el.dataset.mode = mode;
  el.innerHTML = "";
  if (mode === "load") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    el.appendChild(sp);
  }
  const t = document.createElement("span");
  t.className = "status-text";
  t.textContent = msg;
  el.appendChild(t);
  placeCancel();
  el.classList.remove("hidden");
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

boot();
