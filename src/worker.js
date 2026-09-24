// Cloudflare Worker: thin, credential-hiding proxy in front of the Pruna AI API.
//
// - The Pruna API key lives only in the `PRUNA_API_KEY` secret and is never
//   exposed to the browser.
// - Optional shared-password gate (`APP_PASSWORD` secret) protects your Pruna
//   credits from anyone who stumbles onto the URL.
// - Nothing is persisted and nothing is cached: generated media is served
//   no-store, so neither the browser nor Cloudflare's edge keeps a copy.

import {
  MODELS,
  DEFAULT_MODEL,
  MODEL_IDS,
  IMPROVE_MODELS,
  IMPROVE_MODEL_IDS,
  DEFAULT_IMPROVE_MODEL,
  DESCRIBE_MODELS,
  DESCRIBE_MODEL_IDS,
  CHAT_MODELS,
  CHAT_MODEL_IDS,
  DEFAULT_CHAT_MODEL,
  EMBED_MODELS,
  EMBED_MODEL_IDS,
  DEFAULT_EMBED_MODEL,
  TRANSLATE_MODEL,
  TRANSLATE_LANGUAGES,
  STT_MODELS,
  STT_MODEL_IDS,
  DEFAULT_STT_MODEL,
  OTHER_TOOLS,
  DEFAULT_DESCRIBE_MODEL,
  JUDGE_MODEL,
  JUDGE_USD_PER_IMAGE,
  JUDGE_MAX_IMAGES,
} from "./models.js";

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const PRUNA_BASE = "https://api.pruna.ai/v1";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// Constant-ish time string compare to avoid trivial timing oracles.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function authOk(request, env) {
  if (!env.APP_PASSWORD) return true; // gate disabled
  return safeEqual(request.headers.get("x-app-password") || "", env.APP_PASSWORD);
}

// Media URLs used to carry the password itself as a `pw` query param, because
// <img>, <video> and download links cannot set a header. Workers observability
// records request URLs, so that wrote the shared secret into log storage on
// every image the app loaded. A short-lived signed token carries the same
// permission without being the secret: it expires, and it is worth nothing to
// anyone who cannot also reach /api/token behind the header.
const RESULT_TOKEN_TTL_MS = 10 * 60 * 1000;

const TOKEN_ENC = new TextEncoder();
// Key import is the expensive part, so it is cached per isolate. Keyed by the
// secret itself so a rotated APP_PASSWORD cannot be served by a stale key.
let cachedHmac = null;

function hmacKey(secret) {
  if (!cachedHmac || cachedHmac.secret !== secret) {
    cachedHmac = {
      secret,
      key: crypto.subtle.importKey("raw", TOKEN_ENC.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    };
  }
  return cachedHmac.key;
}

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signExpiry(exp, env) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.APP_PASSWORD), TOKEN_ENC.encode(String(exp)));
  return b64url(sig);
}

async function mintResultToken(env) {
  const expiresAt = Date.now() + RESULT_TOKEN_TTL_MS;
  return { token: `${expiresAt}.${await signExpiry(expiresAt, env)}`, expiresAt };
}

async function resultTokenOk(token, env) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  // Recomputed rather than stored: there is no token list to keep, and an
  // expiry that has been edited no longer matches its own signature.
  return safeEqual(token.slice(dot + 1), await signExpiry(exp, env));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      // Non-API requests are served by the static assets binding automatically;
      // reaching here means no asset matched.
      return new Response("Not found", { status: 404 });
    }

    try {
      // Public: lets the UI know whether a password is required + the catalog.
      if (path === "/api/config" && request.method === "GET") {
        return json({
          authRequired: Boolean(env.APP_PASSWORD),
          models: MODELS,
          defaultModel: DEFAULT_MODEL,
          improveModels: IMPROVE_MODELS,
          defaultImproveModel: DEFAULT_IMPROVE_MODEL,
          describeModels: DESCRIBE_MODELS,
          chatModels: CHAT_MODELS,
          defaultChatModel: DEFAULT_CHAT_MODEL,
          instructions: { improve: IMPROVE_SYSTEM, chat: CHAT_SYSTEM },
          embedModels: EMBED_MODELS,
          defaultEmbedModel: DEFAULT_EMBED_MODEL,
          translateLanguages: TRANSLATE_LANGUAGES,
          sttModels: STT_MODELS,
          defaultSttModel: DEFAULT_STT_MODEL,
          otherTools: OTHER_TOOLS,
          defaultDescribeModel: DEFAULT_DESCRIBE_MODEL,
          judgeUsdPerImage: JUDGE_USD_PER_IMAGE,
          judgeMaxImages: JUDGE_MAX_IMAGES,
        });
      }

      // Everything below is gated. /api/result is the one route that also
      // accepts a signed token, since the elements that load media cannot send
      // a header; every other route is reached by fetch(), which can.
      if (!authOk(request, env)) {
        const viaToken = path === "/api/result" && (await resultTokenOk(url.searchParams.get("t"), env));
        if (!viaToken) {
          return json({ error: "Unauthorized. Wrong or missing app password." }, 401);
        }
      }

      // Mints the token above. Behind the header, so only a client that already
      // holds the password can get one.
      if (path === "/api/token" && request.method === "GET") {
        // Nothing to sign without a gate, and nothing to protect either.
        return json(env.APP_PASSWORD ? await mintResultToken(env) : { token: null, expiresAt: 0 });
      }

      if (path === "/api/generate" && request.method === "POST") {
        return await handleGenerate(request, env);
      }
      if (path === "/api/status" && request.method === "GET") {
        return await handleStatus(request, env, url);
      }
      if (path === "/api/upload" && request.method === "POST") {
        return await handleUpload(request, env);
      }
      if (path === "/api/improve-prompt" && request.method === "POST") {
        return await handleImprovePrompt(request, env);
      }
      if (path === "/api/translate" && request.method === "POST") {
        return await handleTranslate(request, env);
      }
      if (path === "/api/transcribe" && request.method === "POST") {
        return await handleTranscribe(request, env);
      }
      if (path === "/api/other" && request.method === "POST") {
        return await handleOther(request, env);
      }
      if (path === "/api/embed" && request.method === "POST") {
        return await handleEmbed(request, env);
      }
      if (path === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }
      if (path === "/api/describe" && request.method === "POST") {
        return await handleDescribe(request, env);
      }
      if (path === "/api/judge" && request.method === "POST") {
        return await handleJudge(request, env);
      }
      if (path === "/api/neurons" && request.method === "GET") {
        return await handleNeurons(env);
      }
      if (path === "/api/result" && request.method === "GET") {
        return await handleResult(request, env, url);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Worker error: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};

async function handleGenerate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Invalid JSON body." }, 400);

  const { model, input } = body;
  if (!MODEL_IDS.has(model)) return json({ error: `Unknown model: ${model}` }, 400);
  if (!input || typeof input !== "object") return json({ error: "Missing input object." }, 400);

  const spec = MODELS_BY_ID.get(model);
  if (spec.provider === "workers-ai") return await runWorkersAI(spec, input, env);
  if (spec.provider === "xai") {
    return spec.xaiAsync ? await runXaiVideoStart(spec, input, env) : await runXai(spec, input, env);
  }

  // No Try-Sync: every generation is submitted async and polled. See the comment
  // above runGeneration in public/app.js for why — a synchronous success never
  // yields a job id, so closing the app mid-run lost the job outright.
  const headers = {
    apikey: env.PRUNA_API_KEY,
    Model: model,
    "content-type": "application/json",
  };

  const res = await fetch(`${PRUNA_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });

  const text = await res.text();
  // Pass Pruna's JSON straight through (status included) so the UI can branch
  // on succeeded / id+get_url / failed.
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Runs a model on Cloudflare Workers AI via the `AI` binding and normalises the
// two output shapes into data URIs the browser can render directly. Unlike the
// Pruna path these are synchronous — there is no job id to poll.
async function runWorkersAI(spec, input, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);

  const payload = { ...input };

  // Browser sends images as bare base64. Models differ in what they accept:
  // image_b64 is passed through, mask has to become a byte array.
  if (typeof payload.mask_b64 === "string") {
    payload.mask = base64ToBytes(payload.mask_b64);
    delete payload.mask_b64;
  }
  // A seed of 0 means "unset" in our UI — let the model pick its own.
  if (payload.seed === 0 || payload.seed === -1) delete payload.seed;

  let out;
  try {
    out = spec.multipart
      ? await env.AI.run(spec.cfModel, { multipart: buildMultipart(payload) })
      : await env.AI.run(spec.cfModel, payload);
  } catch (err) {
    return json({ error: "Workers AI: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  // Speech. Aura returns a raw MP3 stream; MeloTTS documents either that or
  // JSON {audio: "<base64 MP3>"}. Both are MP3 per Cloudflare's output schemas.
  if (spec.kind === "audio") {
    if (out && typeof out === "object" && typeof out.audio === "string") {
      return json({ status: "succeeded", images: ["data:audio/mpeg;base64," + out.audio] });
    }
    if (out instanceof ReadableStream || out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
      const buf = out instanceof ReadableStream ? await new Response(out).arrayBuffer() : out;
      return json({ status: "succeeded", images: ["data:audio/mpeg;base64," + bytesToBase64(buf)] });
    }
    return json({ error: "Unexpected Workers AI audio response shape." }, 502);
  }

  // Shape 1: JSON { image: "<base64>" } (FLUX, Leonardo). Sniff the real type
  // rather than assuming JPEG — a mislabelled data: URI can fail to render in
  // stricter browsers.
  if (out && typeof out === "object" && typeof out.image === "string") {
    const mime = sniffImageMime(out.image) || "image/jpeg";
    return json({ status: "succeeded", images: [`data:${mime};base64,` + out.image] });
  }
  // Shape 2: raw PNG stream (Stable Diffusion family).
  if (out instanceof ReadableStream || out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
    const buf = out instanceof ReadableStream ? await new Response(out).arrayBuffer() : out;
    return json({ status: "succeeded", images: ["data:image/png;base64," + bytesToBase64(buf)] });
  }
  return json({ error: "Unexpected Workers AI response shape." }, 502);
}

const IMPROVE_SYSTEM =
  `Take the provided text and improve its clarity by refining the phrasing while preserving its meaning. ` +
  `Do not soften the language or remove mature content. ` +
  `Do not invent new objects or details. ` +
  `Never create a relationship between two things that the original text did not already connect. ` +
  `An instruction must remain an instruction, and a description must remain a description. ` +
  `Output only the rewritten text.`;


// Rewrites a short prompt into a richer one using a chat model on Workers AI.
// Used by the "Improve" button and works for any provider's models. The model
// is chosen in the UI from IMPROVE_MODELS.
// NB: @cf/qwen/qwen1.5-0.5b-chat was deprecated by Cloudflare on 2025-10-01 and
// now returns error 5028, so it is not offered.
async function handleImprovePrompt(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);

  const body = await request.json().catch(() => null);
  const prompt = body && typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: "Nothing to improve — write a prompt first." }, 400);
  if (prompt.length > 2000) return json({ error: "Prompt is too long to improve." }, 400);

  // Only models from the offered list may be run here.
  const improveModel = IMPROVE_MODEL_IDS.has(body.model) ? body.model : DEFAULT_IMPROVE_MODEL;
  // Reasoning models burn tokens thinking before they answer; too small a
  // budget and `content` comes back null.
  const spec = IMPROVE_MODELS.find((m) => m.id === improveModel) || {};
  const mine = userSettings(body.settings, spec);

  // Same instruction for every mode, unless the ⚙ panel on this device set
  // another. Whether the target is an edit, a video or a from-scratch
  // generation changes nothing about copy-editing the sentence.
  const system = mine.system || IMPROVE_SYSTEM;

  let out;
  try {
    out = await env.AI.run(improveModel, {
      messages: spec.noSystem
        ? [{ role: "user", content: `${system}\n\nText:\n${prompt}` }]
        : [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
      // 120 words runs ~170-200 tokens; 320 leaves headroom so the raised
      // word cap doesn't just get truncated at the token level instead.
      max_tokens: mine.maxTokens || spec.maxTokens || (spec.reasoning ? 1500 : 320),
      ...withUserKnobs(reasoningKnobs(spec), mine),
    });
  } catch (err) {
    return json({ error: "Improve failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  const text = stripPreamble(stripReasoning(pickText(out))).replace(/^["'\s]+|["'\s]+$/g, "");
  if (!text) return json({ error: "The model returned nothing usable." }, 502);
  return json({ prompt: text });
}

// Actual Workers AI neuron usage for the current UTC day, from Cloudflare's
// GraphQL analytics. There is no REST endpoint for this and no "balance" call —
// the free allowance is a fixed 10,000/day, so remaining is derived by
// subtracting what has been spent. Analytics lag inference by a minute or two.
const CF_FREE_NEURONS_PER_DAY = 10000;

async function handleNeurons(env) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return json({ error: "Neuron reporting is not configured." }, 501);
  }
  const day = new Date().toISOString().slice(0, 10);
  const query = `query {
    viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) {
      aiInferenceAdaptiveGroups(limit: 100, filter: {date_geq: "${day}"}) {
        sum { totalNeurons } dimensions { modelId }
      } } } }`;

  let data;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    data = await res.json();
  } catch (err) {
    return json({ error: "Analytics request failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }
  if (data.errors) {
    return json({ error: "Analytics: " + JSON.stringify(data.errors).slice(0, 200) }, 502);
  }

  const rows = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
  const byModel = rows
    .map((r) => ({ model: r.dimensions.modelId, neurons: r.sum.totalNeurons }))
    .filter((r) => r.neurons > 0)
    .sort((a, b) => b.neurons - a.neurons);
  const used = rows.reduce((n, r) => n + (r.sum.totalNeurons || 0), 0);

  return json({
    day,
    used,
    limit: CF_FREE_NEURONS_PER_DAY,
    remaining: Math.max(0, CF_FREE_NEURONS_PER_DAY - used),
    byModel: byModel.slice(0, 10),
  });
}

// Base64 magic-number prefixes, so a data: URI never has to guess at its own
// content type. Grok returns PNG even though the old code hardcoded JPEG.
function sniffImageMime(b64) {
  if (b64.startsWith("iVBORw0KGgo")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return null;
}

// Runs a Grok Imagine model directly against api.x.ai. Reference images switch
// the call from /images/generations to /images/edits; xAI takes them as JSON
// (data URIs), not multipart. Synchronous — no job to poll.
//
// Results are requested as URLs rather than inline base64. A 2048x2048 Grok
// image is ~0.9MB, which base64 inflates to ~1.2MB of JSON that then becomes a
// single enormous data: URI in the DOM — enough to kill a mobile Safari tab.
// A URL lets /api/result stream the bytes and pass the real content-type
// through, so nothing large is ever held as a string.
async function runXai(spec, input, env) {
  if (!env.XAI_API_KEY) return json({ error: "xAI is not configured (XAI_API_KEY missing)." }, 500);

  const refs = []
    .concat(input.images || [])
    .filter(Boolean)
    .slice(0, 3)
    .map((url) => ({ type: "image_url", url }));

  const payload = { model: spec.xaiModel, prompt: input.prompt, response_format: "url" };
  if (input.aspect_ratio) payload.aspect_ratio = input.aspect_ratio;
  if (input.resolution) payload.resolution = input.resolution;
  if (input.n) payload.n = Number(input.n);
  if (input.quality) payload.quality = input.quality;
  if (refs.length) payload.images = refs;

  const path = refs.length ? "edits" : "generations";
  let res, text;
  try {
    res = await fetch(`https://api.x.ai/v1/images/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (err) {
    return json({ error: "xAI request failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "xAI returned a non-JSON response." }, 502);
  }
  if (!res.ok) {
    // Surface xAI's own wording (e.g. the no-credits message) rather than hiding it.
    return json({ error: "xAI: " + (data.error || data.message || `HTTP ${res.status}`) }, res.status);
  }

  const images = (data.data || [])
    .map((d) => {
      if (d.url) return d.url; // preferred: streamed via /api/result
      if (!d.b64_json) return null;
      // Fallback if xAI ever ignores response_format. Use its declared
      // mime_type, then magic-number sniffing, rather than assuming JPEG.
      const mime = d.mime_type || sniffImageMime(d.b64_json) || "image/png";
      return `data:${mime};base64,` + d.b64_json;
    })
    .filter(Boolean);
  if (!images.length) return json({ error: "xAI returned no images." }, 502);
  return json({ status: "succeeded", images });
}

// Extracts an xAI error message regardless of whether it comes back as a
// plain string (seen on /images/*) or a structured {message} object (the
// OpenAI-compatible shape used elsewhere in xAI's API).
function xaiErrorText(data, res) {
  const e = data && data.error;
  if (typeof e === "string" && e) return e;
  if (e && typeof e.message === "string") return e.message;
  if (typeof data?.message === "string" && data.message) return data.message;
  return `HTTP ${res.status}`;
}

// Starts an async Grok Imagine Video job (generation, edit, or extension) and
// hands back a synthetic job id the browser can poll via /api/status. The
// "xai_" prefix lets handleStatus route polling to xAI instead of Pruna.
async function runXaiVideoStart(spec, input, env) {
  if (!env.XAI_API_KEY) return json({ error: "xAI is not configured (XAI_API_KEY missing)." }, 500);

  const payload = { model: spec.xaiModel, prompt: input.prompt };

  // One model, three endpoints. `mode` is a UI-level field: it selects the
  // endpoint and is never forwarded in the payload. Allow-listed so a crafted
  // request cannot point the fetch below at an arbitrary path.
  const MODES = ["generations", "edits", "extensions"];
  const endpoint = spec.xaiModal && MODES.includes(input.mode) ? input.mode : spec.xaiEndpoint;

  if (endpoint === "generations") {
    if (input.image) payload.image = { url: input.image };
    const refs = [].concat(input.reference_images || []).filter(Boolean).slice(0, 3);
    if (refs.length) payload.reference_images = refs.map((url) => ({ url }));
    // Preset voice, offered only on models that accept reference audio.
    if (input.reference_voice) payload.reference_audios = [{ voice_id: input.reference_voice }];
    if (input.duration) payload.duration = Number(input.duration);
    if (input.resolution) payload.resolution = input.resolution;
    if (input.aspect_ratio) payload.aspect_ratio = input.aspect_ratio;
  } else {
    // edits and extensions both take a single source video.
    if (!input.video) return json({ error: "Missing video to edit/extend." }, 400);
    payload.video = { url: input.video };
    // Extension's duration is the length of the added footage only. Editing
    // takes no duration at all — the output follows the source.
    if (endpoint === "extensions" && input.extend_duration) payload.duration = Number(input.extend_duration);
  }

  let res, text;
  try {
    res = await fetch(`https://api.x.ai/v1/videos/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.XAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (err) {
    return json({ error: "xAI request failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "xAI returned a non-JSON response." }, 502);
  }
  if (!res.ok || !data.request_id) {
    return json({ error: "xAI: " + xaiErrorText(data, res) }, res.ok ? 502 : res.status);
  }
  return json({ id: "xai_" + data.request_id });
}

// Polls an xAI video job and translates its shape into the same
// {status, generation_url, message} shape the Pruna path already produces, so
// the frontend's polling loop doesn't need to know which provider it's on.
async function pollXaiVideo(requestId, env) {
  let res, text;
  try {
    res = await fetch(`https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${env.XAI_API_KEY}` },
    });
    text = await res.text();
  } catch (err) {
    return json({ error: "xAI status check failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "xAI returned a non-JSON status response." }, 502);
  }
  if (!res.ok) return json({ error: "xAI: " + xaiErrorText(data, res) }, res.status);

  if (data.status === "failed") {
    return json({ status: "failed", message: data.error?.message || "Video generation failed." });
  }
  if (data.status !== "done") {
    return json({ status: "processing" }); // "pending" or anything else — keep polling
  }
  // Moderation can block output on an otherwise "done" job: the URL is empty.
  if (!data.video?.respect_moderation || !data.video?.url) {
    return json({ status: "failed", message: "Blocked by xAI's moderation — no video was produced." });
  }
  const result = { status: "succeeded", generation_url: data.video.url };
  // 1 USD cent = 100,000,000 ticks, so 1 USD = 10,000,000,000 ticks.
  if (data.usage?.cost_in_usd_ticks != null) {
    result.actual_cost_usd = data.usage.cost_in_usd_ticks / 10_000_000_000;
  }
  return json(result);
}

// Overrides from the ⚙ panel, kept on the user's device and sent with each
// request. Bounded here: an instruction up to 4,000 characters, a token limit
// of 16–8,000, and thinking or effort only for a model whose schema takes it.
const USER_MAX_TOKENS = 8000;
const USER_MAX_SYSTEM = 4000;

function userSettings(raw, spec) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.system === "string" && raw.system.trim()) out.system = raw.system.trim().slice(0, USER_MAX_SYSTEM);
  const n = Math.floor(Number(raw.maxTokens));
  if (Number.isFinite(n) && n >= 16) out.maxTokens = Math.min(n, USER_MAX_TOKENS);
  if (spec.canThink && typeof raw.thinking === "boolean") out.thinking = raw.thinking;
  if (Array.isArray(spec.efforts) && spec.efforts.includes(raw.effort)) out.effort = raw.effort;
  return out;
}

function withUserKnobs(knobs, mine) {
  const k = { ...knobs };
  if (mine.thinking !== undefined) k.chat_template_kwargs = { enable_thinking: mine.thinking };
  if (mine.effort) k.reasoning_effort = mine.effort;
  return k;
}

// The per-model reasoning controls declared in IMPROVE_MODELS / DESCRIBE_MODELS,
// as request fields. Absent knobs send nothing, so every model without one
// runs exactly as it did before they existed.
function reasoningKnobs(spec) {
  const extra = {};
  if (spec.thinking === false) extra.chat_template_kwargs = { enable_thinking: false };
  if (spec.effort) extra.reasoning_effort = spec.effort;
  return extra;
}

// Workers AI text responses come back in several shapes depending on the
// model family: a bare {response}, an OpenAI-style {choices[].message.content}
// (gpt-oss), or nested under {result} (moondream). Pull the text from whichever
// one is present.
function pickText(out) {
  if (!out) return "";
  if (typeof out === "string") return out.trim();
  const choice = out.choices && out.choices[0];
  const candidate =
    out.response ??
    out.description ??
    out.caption ??
    out.answer ??
    out.output_text ??
    (choice && choice.message && choice.message.content) ??
    (choice && choice.text);
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  // One level of nesting, e.g. moondream's {result: {caption}}.
  if (out.result && typeof out.result === "object") return pickText(out.result);
  return "";
}

// Small models often open with a line like "Sure, here is the rewritten
// text:" before the rewrite itself. Only a short first line of that shape,
// ending in a colon, is dropped; the rewrite never starts that way.
function stripPreamble(text) {
  return String(text).replace(/^\s*(sure|certainly|okay|ok|of course|here is|here's)\b[^\n]{0,80}:\s*\n+/i, "");
}

// Distill-style reasoning models (DeepSeek R1) emit a <think> monologue before
// the answer. Drop it so the prompt box gets the rewrite, not the thinking.
function stripReasoning(text) {
  let t = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "");
  // An unterminated <think> means the model ran out of budget while thinking
  // and never wrote an answer. Drop the monologue so the caller reports a
  // clean error instead of pasting the thinking into the prompt box.
  if (/<think>/i.test(t)) t = t.replace(/<think>[\s\S]*$/i, "");
  return t.trim();
}

// The chat under the prompt toolbar. The browser keeps the thread and sends all
// of it every time, so the model sees the conversation so far; the Worker adds
// the system instruction, and — when the context switch is on — the prompt
// box's text and the attached image to the newest message only. Earlier
// messages go as plain text: resending the image with every turn would bill
// it again each time for nothing the model had not already seen.
const CHAT_SYSTEM =
  `You are helping the user write and refine prompts for image and video generation models. ` +
  `Their current prompt and any attached image are included for context. ` +
  `Answer directly and briefly. ` +
  `When asked to rewrite the prompt, output only the rewritten prompt. ` +
  `Do not soften the language or remove mature content.`;

// Bounds on what one request may carry, so a runaway thread fails here with a
// clear message rather than as an opaque model error or a huge bill.
const CHAT_MAX_MESSAGES = 60;
const CHAT_MAX_CHARS = 60000;

function chatContext(prompt, text) {
  return prompt ? `My current prompt:\n"""\n${prompt}\n"""\n\n${text}` : text;
}

async function handleChat(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return json({ error: "Nothing to send." }, 400);
  }
  const model = CHAT_MODEL_IDS.has(body.model) ? body.model : DEFAULT_CHAT_MODEL;
  const spec = CHAT_MODELS.find((m) => m.id === model);

  const thread = body.messages.slice(-CHAT_MAX_MESSAGES);
  let chars = 0;
  for (const m of thread) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return json({ error: "Malformed message in the thread." }, 400);
    }
    chars += m.content.length;
  }
  if (thread[thread.length - 1].role !== "user") return json({ error: "The last message must be yours." }, 400);
  if (chars > CHAT_MAX_CHARS) return json({ error: "This chat is too long to send. Start a new chat." }, 400);

  const mine = userSettings(body.settings, spec);
  const system = mine.system || CHAT_SYSTEM;
  const messages = [...thread.map((m) => ({ role: m.role, content: m.content }))];
  // A model with no system role gets the instruction at the head of the
  // thread's first message instead.
  if (spec.noSystem) messages[0] = { ...messages[0], content: `${system}\n\n${messages[0].content}` };
  else messages.unshift({ role: "system", content: system });
  const last = messages[messages.length - 1];
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  last.content = chatContext(prompt, last.content);

  // An image only reaches a model that can see one; the knobs that make those
  // answer at all are the Describe entry's, measured with an image attached.
  const b64 = typeof body.image_b64 === "string" ? body.image_b64 : "";
  let knobs = spec;
  if (b64 && spec.vision) {
    knobs = DESCRIBE_MODELS.find((m) => m.id === model) || spec;
    last.content = [
      { type: "text", text: last.content },
      { type: "image_url", image_url: { url: `data:${body.mime || "image/jpeg"};base64,${b64}` } },
    ];
  }

  let out;
  try {
    out = await env.AI.run(model, {
      messages,
      max_tokens: mine.maxTokens || knobs.maxTokens || (spec.reasoning ? 2000 : 1024),
      ...withUserKnobs(reasoningKnobs(knobs), mine),
    });
  } catch (err) {
    return json({ error: "Chat failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }
  const text = stripReasoning(pickText(out));
  if (!text) return json({ error: "The model returned nothing usable. Try again or pick another model." }, 502);
  const neurons = out && out.usage && typeof out.usage.neurons === "number" ? out.usage.neurons : null;
  return json({ reply: text, neurons, sawImage: Boolean(b64 && spec.vision) });
}

const aiError = (label, err) => json({ error: `${label}: ` + (err && err.message ? err.message : String(err)) }, 502);

async function handleTranslate(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);
  const body = await request.json().catch(() => null);
  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  const codes = new Set(TRANSLATE_LANGUAGES.map((l) => l.code));
  if (!text) return json({ error: "Nothing to translate." }, 400);
  if (text.length > 4000) return json({ error: "Text is too long to translate." }, 400);
  if (!codes.has(body.target_lang)) return json({ error: "Pick a language to translate into." }, 400);
  const source = codes.has(body.source_lang) ? body.source_lang : "en";
  let out;
  try {
    out = await env.AI.run(TRANSLATE_MODEL, { text, source_lang: source, target_lang: body.target_lang });
  } catch (err) {
    return aiError("Translate failed", err);
  }
  const translated = out && typeof out.translated_text === "string" ? out.translated_text.trim() : "";
  if (!translated) return json({ error: "The model returned no translation." }, 502);
  return json({ text: translated });
}

// Audio arrives as base64 from the browser; each model then gets it in the
// form its schema documents.
const STT_MAX_BYTES = 20 * 1024 * 1024;

async function handleTranscribe(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);
  const body = await request.json().catch(() => null);
  const b64 = body && typeof body.audio_b64 === "string" ? body.audio_b64 : "";
  if (!b64) return json({ error: "No audio received." }, 400);
  if (b64.length * 0.75 > STT_MAX_BYTES) return json({ error: "Recording is too long." }, 400);
  const model = STT_MODEL_IDS.has(body.model) ? body.model : DEFAULT_STT_MODEL;
  const spec = STT_MODELS.find((m) => m.id === model);
  const mime = typeof body.mime === "string" && body.mime ? body.mime : "audio/mp4";

  let input;
  if (spec.audio === "base64") input = { audio: b64 };
  else if (spec.audio === "bytes") input = { audio: base64ToBytes(b64) };
  else input = { audio: { body: new Response(new Uint8Array(base64ToBytes(b64))).body, contentType: mime } };

  let out;
  try {
    out = await env.AI.run(model, input);
  } catch (err) {
    return aiError("Transcription failed", err);
  }
  const alt = out && out.results && out.results.channels && out.results.channels[0] && out.results.channels[0].alternatives;
  const text = ((out && typeof out.text === "string" ? out.text : alt && alt[0] && alt[0].transcript) || "").trim();
  if (!text) return json({ error: "No speech was recognised." }, 502);
  return json({ text });
}

async function handleOther(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);
  const body = await request.json().catch(() => null);
  const tool = OTHER_TOOLS.find((t) => t.id === (body && body.tool));
  if (!tool) return json({ error: "Unknown tool." }, 400);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";

  let input;
  if (tool.id === "guard") {
    if (!text) return json({ error: "Nothing to check." }, 400);
    input = { messages: [{ role: "user", content: text }] };
  } else if (tool.id === "sentiment") {
    if (!text) return json({ error: "Nothing to classify." }, 400);
    input = { text };
  } else if (tool.id === "labels") {
    if (typeof body.image_b64 !== "string" || !body.image_b64) return json({ error: "No image received." }, 400);
    input = { image: base64ToBytes(body.image_b64) };
  } else {
    const passages = Array.isArray(body.passages) ? body.passages.filter((p) => typeof p === "string" && p.trim()).slice(0, 50) : [];
    if (!text || !passages.length) return json({ error: "A query and at least one passage are needed." }, 400);
    input = { query: text, contexts: passages.map((p) => ({ text: p.trim() })) };
  }

  let out;
  try {
    out = await env.AI.run(tool.model, input);
  } catch (err) {
    return aiError(tool.label, err);
  }
  if (tool.id === "guard") return json({ result: out && out.response !== undefined ? out.response : out });
  if (tool.id === "rerank") return json({ result: (out && out.response) || [] });
  return json({ result: Array.isArray(out) ? out.slice(0, 5) : out });
}

// One text in, its embedding out: the list of numbers the Embeddings panel
// draws and compares. The comparing happens in the browser, which holds the
// history; this only asks the model.
const EMBED_MAX_CHARS = 8000;

async function handleEmbed(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);
  const body = await request.json().catch(() => null);
  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Nothing to measure." }, 400);
  if (text.length > EMBED_MAX_CHARS) return json({ error: "Text is too long to measure." }, 400);
  const model = EMBED_MODEL_IDS.has(body.model) ? body.model : DEFAULT_EMBED_MODEL;

  const spec = EMBED_MODELS.find((m) => m.id === model);
  const input = spec.contexts ? { contexts: [{ text }], truncate_inputs: true } : { text: [text] };
  if (spec.pooling) input.pooling = spec.pooling;

  let out;
  try {
    out = await env.AI.run(model, input);
  } catch (err) {
    return json({ error: "Embedding failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }
  const rows = out && (Array.isArray(out.data) ? out.data : out.response);
  const vector = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : null;
  if (!vector || !vector.length) return json({ error: "The model returned no embedding." }, 502);
  const neurons =
    (out.usage && typeof out.usage.neurons === "number" && out.usage.neurons) ||
    (out.meta && typeof out.meta.neurons === "number" && out.meta.neurons) ||
    null;
  return json({ vector, neurons });
}

const CAPTION_REQUEST = "Describe this image in vivid detail, as if writing a prompt to recreate it.";

// Captions an uploaded image so the text can seed a prompt. The vision models
// take quite different inputs, so each payload is built separately.
async function handleDescribe(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);

  const body = await request.json().catch(() => null);
  const b64 = body && typeof body.image_b64 === "string" ? body.image_b64 : "";
  if (!b64) return json({ error: "No image provided." }, 400);

  const model = DESCRIBE_MODEL_IDS.has(body.model) ? body.model : DEFAULT_DESCRIBE_MODEL;
  // Captions only. Questions about an image are asked in the chat, which keeps
  // the thread; this route used to take one too, and threw the answer away.
  const asking = CAPTION_REQUEST;

  const spec = DESCRIBE_MODELS.find((m) => m.id === model) || {};
  let input;
  if (spec.chat) {
    input = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: asking },
            { type: "image_url", image_url: { url: `data:${body.mime || "image/jpeg"};base64,${b64}` } },
          ],
        },
      ],
      max_tokens: spec.maxTokens || 1024,
      ...reasoningKnobs(spec),
    };
  } else if (model.includes("moondream")) {
    const image = `data:${body.mime || "image/jpeg"};base64,${b64}`;
    // Streams by default; disabled so a single JSON body comes back.
    // https://developers.cloudflare.com/workers-ai/models/moondream3.1-9B-A2B/
    input = {
      task: "caption",
      image,
      caption_length: body.caption_length || "normal",
      stream: false,
      max_tokens: 512,
    };
  } else {
    // llava and llama-3.2-11b-vision both want raw bytes as 8-bit ints.
    input = { image: base64ToBytes(b64), prompt: asking, max_tokens: 512 };
  }

  let out;
  try {
    out = await env.AI.run(model, input);
  } catch (err) {
    return json({ error: "Describe failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  const text = pickText(out);
  if (!text) return json({ error: "The model returned no description." }, 502);
  return json({ description: text });
}

// Scores one or more images against a prompt with p-judger. This does not go
// through /api/generate: p-judger returns a JSON score object rather than
// media, so it has no place in the MODELS catalogue or the polling loop the
// browser runs for generations. It is a prompt tool, like Improve and Describe.
//
// The browser always sends an array. One image uses the API's single-image mode
// (`image`), more than one uses batch mode (`images`) with the prompt reused
// for every image. Per-image `prompts` is not exposed — it needs one prompt box
// per image to mean anything, and the toolbar has exactly one.
async function handleJudge(request, env) {
  const body = await request.json().catch(() => null);
  const prompt = body && typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: "Write a prompt first — the score is against it." }, 400);

  const images = Array.isArray(body.images) ? body.images.filter((u) => typeof u === "string" && u) : [];
  if (!images.length) return json({ error: "No image to score." }, 400);
  if (images.length > JUDGE_MAX_IMAGES) {
    return json({ error: `Too many images — ${JUDGE_MAX_IMAGES} at a time.` }, 400);
  }
  // These come from /api/upload, so they are always Pruna file URLs. Checking
  // keeps the endpoint from being used to point Pruna at an arbitrary host.
  for (const u of images) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return json({ error: "Images must be uploaded first." }, 400);
    }
    if (parsed.protocol !== "https:" || !/(^|\.)pruna\.ai$/.test(parsed.hostname)) {
      return json({ error: "Images must be uploaded first." }, 400);
    }
  }

  const input = images.length === 1 ? { prompt, image: images[0] } : { prompt, images };

  let res, text;
  try {
    res = await fetch(`${PRUNA_BASE}/predictions`, {
      method: "POST",
      headers: {
        apikey: env.PRUNA_API_KEY,
        Model: JUDGE_MODEL,
        "content-type": "application/json",
        "Try-Sync": "true",
      },
      body: JSON.stringify({ input }),
    });
    text = await res.text();
  } catch (err) {
    return json({ error: "Judge request failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "Pruna returned a non-JSON response." }, 502);
  }
  if (!res.ok) {
    return json({ error: "Pruna: " + (data.message || data.error || `HTTP ${res.status}`) }, res.status);
  }

  // Try-Sync usually finishes in about a second, but it is best-effort: a
  // response carrying an id instead of a result has to be polled like any
  // other async job. Each poll is one subrequest, so the budget is bounded.
  if (data.status !== "succeeded" && data.id) {
    data = await pollJudge(data.id, env);
    if (data.error) return json({ error: data.error }, 502);
  }

  if (data.status === "failed" || data.status === "error" || data.status === "canceled") {
    return json({ error: data.message || data.error || "Scoring failed." }, 502);
  }
  if (data.status !== "succeeded") {
    return json({ error: "Scoring did not finish in time. Try again." }, 504);
  }

  const payload = judgePayload(data.generation_url);
  if (payload == null) return json({ error: "Pruna returned no score." }, 502);
  // One shape for the UI whichever mode ran: batch results carry a `results`
  // list, a single image is its own score object.
  const scores = Array.isArray(payload.results) ? payload.results : [payload];
  return json({ scores, raw: payload, count: images.length });
}

const JUDGE_POLL_MS = 1500;
const JUDGE_POLL_TRIES = 20;

async function pollJudge(id, env) {
  for (let i = 0; i < JUDGE_POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, JUDGE_POLL_MS));
    let res, text;
    try {
      res = await fetch(`${PRUNA_BASE}/predictions/status/${encodeURIComponent(id)}`, {
        headers: { apikey: env.PRUNA_API_KEY },
      });
      text = await res.text();
    } catch (err) {
      return { error: "Judge status check failed: " + (err && err.message ? err.message : String(err)) };
    }
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      return { error: "Pruna returned a non-JSON status response." };
    }
    if (d.status === "succeeded" || d.status === "failed" || d.status === "error" || d.status === "canceled") {
      return d;
    }
  }
  return { status: "processing" };
}

// p-judger puts the score object straight into `generation_url` rather than a
// download link — verified against the live API. It is returned as a JSON
// object; a string is parsed in case that ever changes, and anything else is
// treated as no result rather than guessed at.
function judgePayload(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// The FLUX.2 family takes multipart/form-data rather than JSON. Reference
// images must be fields named input_image_0 … input_image_3.
function buildMultipart(payload) {
  const form = new FormData();
  for (const [k, v] of Object.entries(payload)) {
    if (v == null || v === "") continue;
    if (k === "input_images") {
      const list = Array.isArray(v) ? v : [v];
      list.slice(0, 4).forEach((b64, i) => {
        const bytes = new Uint8Array(base64ToBytes(b64));
        form.append(`input_image_${i}`, new Blob([bytes], { type: "image/png" }), `input_${i}.png`);
      });
      continue;
    }
    form.append(k, String(v));
  }
  // Serialising through Response gives us the multipart boundary header.
  const res = new Response(form);
  return { body: res.body, contentType: res.headers.get("content-type") };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function bytesToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  let bin = "";
  const CHUNK = 0x8000; // avoid blowing the argument limit on large images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function handleStatus(request, env, url) {
  const id = url.searchParams.get("id");
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return json({ error: "Invalid id." }, 400);

  if (id.startsWith("xai_")) return await pollXaiVideo(id.slice(4), env);

  const res = await fetch(`${PRUNA_BASE}/predictions/status/${encodeURIComponent(id)}`, {
    headers: { apikey: env.PRUNA_API_KEY },
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleUpload(request, env) {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Expected multipart form data." }, 400);
  const file = form.get("file") || form.get("content");
  if (!(file instanceof File)) return json({ error: "Missing 'file' field." }, 400);

  const outbound = new FormData();
  outbound.append("content", file, file.name || "upload");

  const res = await fetch(`${PRUNA_BASE}/files`, {
    method: "POST",
    headers: { apikey: env.PRUNA_API_KEY },
    body: outbound,
  });

  const text = await res.text();
  if (!res.ok) {
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: "Unexpected upload response." }, 502);
  }
  const fileUrl = data?.urls?.get || data?.url || null;
  return json({ id: data?.id || null, url: fileUrl });
}

// Streams a Pruna delivery/generation URL back to the browser with the apikey
// attached (delivery endpoints require it), so the media never needs the key.
async function handleResult(request, env, url) {
  const target = url.searchParams.get("url");
  if (!target) return json({ error: "Missing url param." }, 400);

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: "Invalid url." }, 400);
  }
  // SSRF guard: only proxy Pruna's own hosts.
  const allowedHost = /(^|\.)pruna\.ai$/.test(parsed.hostname) || /(^|\.)x\.ai$/.test(parsed.hostname);
  if (parsed.protocol !== "https:" || !allowedHost) {
    return json({ error: "Refusing to proxy a URL outside Pruna and xAI." }, 400);
  }

  const isXai = /(^|\.)x\.ai$/.test(parsed.hostname);
  const upstream = await fetch(parsed.toString(), {
    headers: isXai ? { authorization: `Bearer ${env.XAI_API_KEY}` } : { apikey: env.PRUNA_API_KEY },
  });
  if (!upstream.ok) {
    return json({ error: `Delivery fetch failed (${upstream.status}).` }, upstream.status);
  }

  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const cl = upstream.headers.get("content-length");
  if (cl) headers.set("content-length", cl);
  // Never cached: no-store keeps it out of the browser cache, and the
  // CDN-specific header stops Cloudflare's edge holding a copy either.
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("cdn-cache-control", "no-store");
  headers.set("pragma", "no-cache");
  return new Response(upstream.body, { status: 200, headers });
}
