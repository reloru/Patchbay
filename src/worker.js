// Cloudflare Worker: thin, credential-hiding proxy in front of the Pruna AI API.
//
// - The Pruna API key lives only in the `PRUNA_API_KEY` secret and is never
//   exposed to the browser.
// - Optional shared-password gate (`APP_PASSWORD` secret) protects your Pruna
//   credits from anyone who stumbles onto the URL.
// - Nothing is persisted. The only caching is a <=30s edge/browser cache on
//   already-generated media so re-displaying it doesn't re-hit Pruna.

import { MODELS, MODEL_IDS, IMPROVE_MODELS, IMPROVE_MODEL_IDS, DEFAULT_IMPROVE_MODEL } from "./models.js";

const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const PRUNA_BASE = "https://api.pruna.ai/v1";
const CACHE_SECONDS = 30;

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

  // Shape 1: JSON { image: "<base64>" } (FLUX, Leonardo).
  if (out && typeof out === "object" && typeof out.image === "string") {
    return json({ status: "succeeded", images: ["data:image/jpeg;base64," + out.image] });
  }
  // Shape 2: raw PNG stream (Stable Diffusion family).
  if (out instanceof ReadableStream || out instanceof ArrayBuffer || ArrayBuffer.isView(out)) {
    const buf = out instanceof ReadableStream ? await new Response(out).arrayBuffer() : out;
    return json({ status: "succeeded", images: ["data:image/png;base64," + bytesToBase64(buf)] });
  }
  return json({ error: "Unexpected Workers AI response shape." }, 502);
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
  const system =
    `You expand short prompts into vivid ${forVideo ? "video" : "image"} generation prompts. ` +
    `Add concrete visual detail: subject, setting, lighting, composition, style` +
    (forVideo ? ", camera movement" : "") +
    `. Keep the user's original intent and subject. ` +
    `Reply with the rewritten prompt only — no preamble, no quotes, no explanation, under 80 words.`;

  // Only models from the offered list may be run here.
  const improveModel = IMPROVE_MODEL_IDS.has(body.model) ? body.model : DEFAULT_IMPROVE_MODEL;

  let out;
  try {
    out = await env.AI.run(improveModel, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 220,
    });
  } catch (err) {
    return json({ error: "Improve failed: " + (err && err.message ? err.message : String(err)) }, 502);
  }

  let text = (out && (out.response ?? out.result ?? "")) || "";
  text = String(text).trim().replace(/^["'\s]+|["'\s]+$/g, "");
  if (!text) return json({ error: "The model returned nothing usable." }, 502);
  return json({ prompt: text });
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
  if (parsed.protocol !== "https:" || !/(^|\.)pruna\.ai$/.test(parsed.hostname)) {
    return json({ error: "Refusing to proxy non-Pruna URL." }, 400);
  }

  const upstream = await fetch(parsed.toString(), { headers: { apikey: env.PRUNA_API_KEY } });
  if (!upstream.ok) {
    return json({ error: `Delivery fetch failed (${upstream.status}).` }, upstream.status);
  }

  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const cl = upstream.headers.get("content-length");
  if (cl) headers.set("content-length", cl);
  // Short-lived cache only — no long-term storage of generations.
  headers.set("cache-control", `public, max-age=${CACHE_SECONDS}`);
  return new Response(upstream.body, { status: 200, headers });
}
