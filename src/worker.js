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
// These are taught by example rather than by rule. Spelling the constraints out
// as prose does not survive contact with the 3B default model: an eight-rule
// version came back with the rule text itself as the "rewritten prompt", and a
// terser bulleted version came back as bullets with the section labels still
// attached. Worked input/output pairs pattern-match instead of having to be
// parsed, and are the only formulation that held up across every model offered.
// Example CONTENT leaks too, so these deliberately share no subject or wording
// with a prompt anyone would realistically type.
const IMAGE_RULES =
  `Never invent detail the user did not write — no hair color, age, clothing, pose, room, weather, or lighting, ` +
  `and no extra people or objects. Replace every pronoun, possessives ("his", "her", "their") included, with the ` +
  `user's own words for the subject. Keep every ` +
  `instruction they gave, and keep the word "photorealistic" if present. If they asked for no change at all, ` +
  `return their words tidied and nothing more.`;

// Pruna's own image-editing guide recommends the order
// [modification] [change target] [preservation requirements], and attributes
// most real-world editing failures (subject drifts, identity changes, unrelated
// elements mutate) to a missing preservation clause.
//
// The catch, learned the hard way: a preservation clause is only safe for a
// model that cannot see the image if it names nothing specific. "Preserve the
// subject's facial features and identity" reads like a neutral constraint but
// asserts the image contains a person with a face. Every worked example here
// used to end that way, so the model copied it onto every edit — asking to
// preserve a face in a photo of a room, or to place an added object "beside the
// subject" when there was no subject. Editing models given a nonexistent thing
// to preserve either ignore the instruction or hallucinate the thing.
//
// So preservation is restricted to properties every image has regardless of
// content: the other elements, the composition, the framing, the camera angle.
// "Leave everything else unchanged" is defined relative to the change, so it
// also cannot contradict the edit the way a named clause can.
const EDIT_SYSTEM =
  `You rewrite image-editing instructions for an image-editing model, which cannot be told anything about the ` +
  `image beyond what the user wrote. State the change, what it applies to, then what to preserve. ` +
  IMAGE_RULES +
  ` Always end with a preservation clause, and let it refer only to what is true of any image — everything else, ` +
  `the composition, the framing, the camera angle, the perspective. Never name a person, face, body, or object ` +
  `the user did not mention: the image may not contain one. If the user did not say what the change applies to, ` +
  `state the change on its own rather than inventing something for it to apply to. Never ask to preserve the very ` +
  `thing the change alters, and never state what the image currently shows — only what to change it to. Output ` +
  `only the rewritten instruction, under 120 words.`;

const EDIT_SHOTS = [
  [
    "remove the hat",
    "Remove the hat. Leave everything else in the image unchanged, and keep the original composition, " +
      "framing, and camera angle.",
  ],
  [
    "turn the background into a beach",
    "Replace the background with a sunlit beach. Leave the foreground exactly as it is, at the same position " +
      "and scale, and keep the original camera angle, framing, and perspective.",
  ],
  [
    "make it look like a watercolour",
    "Convert the image to a watercolour painting with soft bleeding washes, visible paper texture, and pooled " +
      "pigment at the edges. Leave everything else in the image unchanged, and keep the original composition " +
      "and framing.",
  ],
  // The additive case, which produced the worst output before it was taught.
  // A wearable specifically: "add sunglasses" and "add a hat" kept coming back
  // as "to the subject's face" / "to the subject" because the model knows what
  // wears them, and an image-editing model handed a wearer that is not in the
  // picture will invent one. Nothing is added to a named target here, and the
  // added object is not itself preserved.
  [
    "add a scarf",
    "Add a scarf. Leave everything else in the image unchanged, and keep the original composition, framing, " +
      "and camera angle.",
  ],
  [
    "make it daytime",
    "Change the lighting to bright natural daylight. Leave everything else in the image unchanged, and keep " +
      "the original composition and framing.",
  ],
  // Teaches the describe-don't-instruct case: input that requests no edit comes
  // back as itself. Kept last deliberately — without it the model invented an
  // edit in 4 runs out of 5, and moved mid-list it stopped carrying.
  // Deliberately contains no noun worth borrowing: earlier versions ("a photo
  // of a dog", "the two of them", "the subject") all had their subject noun
  // copied into unrelated rewrites, which is the same leak this whole block
  // exists to prevent.
  ["the image is slightly blurry", "The image is slightly blurry."],
];

// Same anti-invention core, but the editing guide's preservation advice is
// actively wrong here: telling an i2v model to hold position, pose, and camera
// fixed suppresses the motion that is the entire point of the output. So
// preservation is narrowed to appearance consistency.
//
// This path had the same hallucination as the editing one, for the same
// reason: every example preserved "the woman's facial features and identity",
// so "the waves roll in" came back preserving "the coastal environment where
// the person is standing", and "slow zoom in" zoomed on a subject that was
// never mentioned. Named preservation targets are gone here too.
const I2V_SYSTEM =
  `You rewrite instructions for an image-to-video model animating the user's photo, which cannot be told anything ` +
  `about that photo beyond what the user wrote. State the motion, who or what performs it, then what stays ` +
  `consistent. ` +
  IMAGE_RULES +
  ` Name only what the user named: never introduce a person, face, or object they did not mention, and never ` +
  `preserve one — the photo may not contain it. Describe only the motion they asked for — never add a second ` +
  `action, a camera move, or a shot length. Never freeze the subject's position or pose: motion is the point of a ` +
  `video. Output only the rewritten instruction, under 120 words.`;

const I2V_SHOTS = [
  [
    "she turns her head",
    "The woman slowly turns the woman's head to one side. Keep the woman's appearance consistent throughout " +
      "the shot, and keep everything else in the frame consistent.",
  ],
  // Two subjectless examples, because that is where invention happens: with
  // nothing to anchor on, the model borrows a noun from whatever example has
  // one. An earlier "the car drives away" example leaked its car into 5 of 8
  // subjectless rewrites, preserving a car that was never in the photo. The
  // editing shots avoid this by ending nearly all of them in the same generic
  // clause, so there is a stronger pattern to copy than a noun; these match.
  [
    "pan across slowly",
    "The camera pans slowly across the frame. Keep everything in the frame consistent in appearance throughout " +
      "the shot.",
  ],
  [
    "make it move gently",
    "Introduce gentle motion. Keep everything in the frame consistent in appearance throughout the shot.",
  ],
];

// "photorealistic" is load-bearing: swapping it for "hyper-realistic" pushes
// image models toward an oversaturated, synthetic look, and dropping it loses
// the constraint entirely. Every model offered here gets this wrong sometimes —
// Mistral Small dropped it outright mid-test — so it is enforced after the
// fact rather than left to instruction-following.
// Pruna's editing guide attributes most editing failures to a missing
// preservation clause, but no model offered here emits one reliably: simple
// additive edits ("add a hat", "brighten it") come back bare from all of them,
// and tightening the instruction only traded the clause away for brevity.
//
// Enforcing it in code is only possible because the clause names nothing —
// that is the same property that stopped it hallucinating faces. A clause about
// "everything else" is true of any image and cannot contradict any edit, so it
// can be appended blind. Handled here rather than by instruction for the same
// reason as keepPhotorealistic().
const PRESERVATION_CLAUSE =
  "Leave everything else in the image unchanged, and keep the original composition and framing.";

// Imperative openers, used to tell an edit instruction from a description.
// Comparing the rewrite against the input instead does not work: a short edit
// often survives the rewrite unchanged ("add a hat" -> "Add a hat."), which is
// exactly the case that most needs the clause appended.
const EDIT_VERB =
  /^(add|remove|delete|erase|change|replace|swap|make|turn|convert|apply|increase|decrease|adjust|brighten|darken|lighten|blur|sharpen|crop|rotate|flip|resize|move|place|put|fill|extend|recolou?r|colou?r|paint|restore)\b/i;

function ensurePreservation(original, rewritten) {
  // A tidied description ("The image is slightly blurry.") states no change, so
  // there is nothing for a preservation clause to be relative to.
  if (!EDIT_VERB.test(rewritten.trim())) return rewritten;
  if (/\b(leave|keep|preserve|maintain)\b[^.]*\b(unchanged|same|original|intact|consistent|in place|as it is)\b/i.test(rewritten)) {
    return rewritten;
  }
  return rewritten.replace(/\s*[.!]?\s*$/, "") + ". " + PRESERVATION_CLAUSE;
}

function keepPhotorealistic(original, rewritten) {
  const out = rewritten.replace(/\bhyper-?realistic\b/gi, "photorealistic");
  if (!/\bphotorealistic\b/i.test(original) || /\bphotorealistic\b/i.test(out)) return out;
  return out.replace(/\s*[.!]?\s*$/, "") + ". Keep the image photorealistic.";
}

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

  const forVideo = body.kind === "video";
  // Worked examples, replayed as prior turns. Only the source-image modes get
  // them: from-scratch generation was never the failing case, and pinning it to
  // a handful of examples would only narrow the variety it produces.
  const shots = body.hasImage ? (forVideo ? I2V_SHOTS : EDIT_SHOTS) : [];
  const system = body.hasImage
    ? (forVideo ? I2V_SYSTEM : EDIT_SYSTEM)
    : `You expand short prompts into vivid ${forVideo ? "video" : "image"} generation prompts. ` +
      `Add concrete visual detail: subject, setting, lighting, composition, style` +
      (forVideo ? ", camera movement" : "") +
      `. Keep the user's original intent and subject — don't contradict anything already stated. ` +
      `Never swap "photorealistic" for "hyper-realistic", "hyperrealistic", or other intensifiers. ` +
      `Reply with the rewritten prompt only — no preamble, no quotes, no explanation, under 120 words.`;

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
        ...shots.flatMap(([u, a]) => [
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
  // Video keeps its own preservation semantics — holding position and pose
  // fixed would suppress the motion that is the point of the output.
  const kept = keepPhotorealistic(prompt, text);
  return json({ prompt: body.hasImage && !forVideo ? ensurePreservation(prompt, kept) : kept });
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

  if (spec.xaiEndpoint === "generations") {
    if (input.image) payload.image = { url: input.image };
    const refs = [].concat(input.reference_images || []).filter(Boolean).slice(0, 3);
    if (refs.length) payload.reference_images = refs.map((url) => ({ url }));
    if (input.duration) payload.duration = Number(input.duration);
    if (input.resolution) payload.resolution = input.resolution;
    if (input.aspect_ratio) payload.aspect_ratio = input.aspect_ratio;
  } else {
    // edits and extensions both take a single source video.
    if (!input.video) return json({ error: "Missing video to edit/extend." }, 400);
    payload.video = { url: input.video };
    if (spec.xaiEndpoint === "extensions" && input.duration) payload.duration = Number(input.duration);
  }

  let res, text;
  try {
    res = await fetch(`https://api.x.ai/v1/videos/${spec.xaiEndpoint}`, {
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
