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
  DEFAULT_DESCRIBE_MODEL,
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

function authOk(request, env, url) {
  if (!env.APP_PASSWORD) return true; // gate disabled
  // Header is used by fetch() calls; the `pw` query param is used by <img>,
  // <video> and download links, which cannot set custom headers.
  const provided =
    request.headers.get("x-app-password") ||
    (url && url.searchParams.get("pw")) ||
    "";
  return safeEqual(provided, env.APP_PASSWORD);
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
          defaultDescribeModel: DEFAULT_DESCRIBE_MODEL,
        });
      }

      // Everything below is gated.
      if (!authOk(request, env, url)) {
        return json({ error: "Unauthorized. Wrong or missing app password." }, 401);
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
      if (path === "/api/describe" && request.method === "POST") {
        return await handleDescribe(request, env);
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

  const { model, input, sync } = body;
  if (!MODEL_IDS.has(model)) return json({ error: `Unknown model: ${model}` }, 400);
  if (!input || typeof input !== "object") return json({ error: "Missing input object." }, 400);

  const spec = MODELS_BY_ID.get(model);
  if (spec.provider === "workers-ai") return await runWorkersAI(spec, input, env);
  if (spec.provider === "xai") {
    return spec.xaiAsync ? await runXaiVideoStart(spec, input, env) : await runXai(spec, input, env);
  }

  const headers = {
    apikey: env.PRUNA_API_KEY,
    Model: model,
    "content-type": "application/json",
  };
  if (sync) headers["Try-Sync"] = "true";

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

// An editing/i2v prompt describes a source image the improve model can never
// see. Left to "make it vivid", small chat models default to whatever's
// statistically typical — golden-hour light indoors, a standing pose for
// someone described as sitting — and those invented details then fight the real
// image at generation time.
//
// One job: copy-editing. Earlier versions of this taught the model about
// image editing, Pruna's prompt structure, preservation clauses, and tag
// parsing. Every one of those made it worse, because a model that cannot see
// the image has no basis for any of it and fills the gap by inventing. It does
// not need to know what the text is for.
//
// Written comma-free on purpose. Image models read a comma as a tag separator
// rather than punctuation, and small models copy the register of their own
// instructions, so a comma-heavy system prompt produces comma-heavy output.
const IMPROVE_SYSTEM =
  `You are a copy editor. Rewrite the user's text so it is correct and clearly phrased English. ` +
  `That is the whole job. You are not told what the text is for and you do not need to know. ` +
  `Fix grammar spelling punctuation and awkward or ambiguous phrasing. ` +
  `If the text is already correct and clear return it exactly as it is. ` +
  `Never add anything the user did not write. No new objects people places colours lighting styles or details of any kind. ` +
  `Never drop anything the user did write. Every instruction object and qualifier in the input must survive into the output. ` +
  `Never soften weaken or hedge their wording and never make it more polite than they wrote it. ` +
  `Never invent a relationship between two things the user did not connect. ` +
  `If they listed things separately keep them separate. ` +
  `If a clause is ambiguous keep the ambiguity rather than picking a reading for them. ` +
  `Do not use commas or em dashes anywhere in your output. Write short separate sentences instead. ` +
  `Keep the user's own words and their pronouns wherever they already read naturally. ` +
  `Repeating a noun where a pronoun is already clear is wrong. ` +
  `Keep the grammatical mood. An instruction stays an instruction. A description stays a description. ` +
  `Never turn "make the sky blue" into "the sky is blue". ` +
  `Never explain never comment and never ask a question. Output only the rewritten text.`;

// Worked examples rather than more rules: prose constraints do not survive
// contact with the 3B default model, which has returned the rule text itself as
// its answer.
//
// Replayed as prior turns rather than listed inside the system text. Inline
// they were treated as prose to continue: the model copied the first example's
// output and then invented past the user's words ("add a cat, a dog, and a
// bird" produced "Put the bird in its cage"). As turns it can still occasionally
// prefix the last answer, which is visible and harmless next to inventing.
const IMPROVE_SHOTS = [
  // One subject keeps its pronouns instead of having the noun stamped over
  // every one of them. Imperative in and imperative out.
  ["make the womans jacket red and put her hat on the table", "Make the woman's jacket red. Put her hat on the table."],
  // Both halves survive. Nothing the user asked to preserve is dropped.
  ["change the jacket to red but preserve her face and hair", "Change the jacket to red. Preserve her face and hair."],
  // The same lesson worded as "keep", which was being dropped where "preserve"
  // survived.
  ["make it snow and keep the building exactly as it is", "Make it snow. Keep the building exactly as it is."],
  // And the negative form, which was dropped where "preserve" and "keep" both
  // survived. All three phrasings mean the same thing to the user.
  ["remove the fence and dont touch anything else", "Remove the fence. Do not touch anything else."],
  // Two independent items stay independent. No comma and no invented link.
  ["make the sky purple and the car red", "Make the sky purple. Make the car red."],
  // Already clear: returned untouched.
  ["remove the hat", "Remove the hat."],
  // Filler and politeness go. The qualifier "a bit" is the user's and stays.
  ["can you please maybe make it a bit brighter if thats ok", "Make it a bit brighter."],
];


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

  // Same instruction for every mode. Whether the target is an edit, a video or
  // a from-scratch generation changes nothing about copy-editing the sentence,
  // and the branching only ever gave the model more to get wrong.
  const system = IMPROVE_SYSTEM;

  // Only models from the offered list may be run here.
  const improveModel = IMPROVE_MODEL_IDS.has(body.model) ? body.model : DEFAULT_IMPROVE_MODEL;
  // Reasoning models burn tokens thinking before they answer; too small a
  // budget and `content` comes back null.
  const isReasoning = IMPROVE_MODELS.some((m) => m.id === improveModel && m.reasoning);

  let out;
  try {
    out = await env.AI.run(improveModel, {
      messages: [
        { role: "system", content: system },
        ...IMPROVE_SHOTS.flatMap(([u, a]) => [
          { role: "user", content: u },
          { role: "assistant", content: a },
        ]),
        { role: "user", content: prompt },
      ],
      // 120 words runs ~170-200 tokens; 320 leaves headroom so the raised
      // word cap doesn't just get truncated at the token level instead.
      max_tokens: isReasoning ? 1500 : 320,
    });
  } catch (err) {
    return json({ error: "Improve failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  const text = stripReasoning(pickText(out)).replace(/^["'\s]+|["'\s]+$/g, "");
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

// Captions an uploaded image so the text can seed a prompt. The two vision
// models take quite different inputs, so each payload is built separately.
async function handleDescribe(request, env) {
  if (!env.AI) return json({ error: "Workers AI binding is not configured." }, 500);

  const body = await request.json().catch(() => null);
  const b64 = body && typeof body.image_b64 === "string" ? body.image_b64 : "";
  if (!b64) return json({ error: "No image provided." }, 400);

  const model = DESCRIBE_MODEL_IDS.has(body.model) ? body.model : DEFAULT_DESCRIBE_MODEL;
  const question =
    (typeof body.question === "string" && body.question.trim()) ||
    "Describe this image in vivid detail, as if writing a prompt to recreate it.";

  let input;
  if (model.includes("moondream")) {
    // Streams by default; disable so we get a single JSON body back.
    input = {
      task: "caption",
      image: `data:${body.mime || "image/jpeg"};base64,${b64}`,
      caption_length: body.caption_length || "normal",
      stream: false,
      max_tokens: 512,
    };
  } else {
    // llava and llama-3.2-11b-vision both want raw bytes as 8-bit ints.
    input = { image: base64ToBytes(b64), prompt: question, max_tokens: 512 };
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
