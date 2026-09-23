// Stands in for the Worker while the browser tests run: serves the real
// public/ files and the real model catalogue from src/models.js, so the code
// under test is exactly what ships, and answers the API routes with fixed
// replies.
//
// A stub rather than `wrangler dev` on purpose. The tests are about what the
// browser does with a response, not about what the providers return, so they
// must not need API keys, must not cost anything, and must not fail because a
// provider is slow or down. /api/generate and /api/upload here never leave the
// machine.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODELS,
  DEFAULT_MODEL,
  IMPROVE_MODELS,
  DEFAULT_IMPROVE_MODEL,
  DESCRIBE_MODELS,
  DEFAULT_DESCRIBE_MODEL,
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  JUDGE_USD_PER_IMAGE,
  JUDGE_MAX_IMAGES,
} from "../src/models.js";

// 8788, not wrangler dev's 8787, so a dev server can stay up while tests run.
const PORT = Number(process.env.PORT) || 8788;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(REPO, "public");
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".webmanifest": "application/manifest+json",
};
const MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]));
let uploadCount = 0;
let lastGenerate = null;
let lastDescribe = null;
// Flipped by the test through /__slow, so a job can be caught mid-flight.
// Without it every generation here finishes on its first poll, and there is no
// window in which Stop means anything.
let slowJob = false;
// Set by the test through /__delay, to hold /api/generate open. A synchronous
// model has no other window: the whole run is that one request.
let generateDelayMs = 0;
// Set by the test through /__statusdelay, to hold each poll open. Stands in for
// the poll loop stalling — a slow provider, a hung connection, or an iOS tab
// suspended in the background, where setTimeout stops firing altogether.
let statusDelayMs = 0;
// Set by the test through /__neurons, to stand in for a day's analytics. Null
// keeps /api/neurons unconfigured, which is what every other block expects.
let neuronsUsed = null;
// What the chat last sent, for the test to inspect through /__chat.
let lastChat = null;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const json = (res, obj, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/api/config") {
    return json(res, {
      authRequired: false,
      models: MODELS,
      defaultModel: DEFAULT_MODEL,
      improveModels: IMPROVE_MODELS,
      defaultImproveModel: DEFAULT_IMPROVE_MODEL,
      describeModels: DESCRIBE_MODELS,
      defaultDescribeModel: DEFAULT_DESCRIBE_MODEL,
      chatModels: CHAT_MODELS,
      defaultChatModel: DEFAULT_CHAT_MODEL,
      judgeUsdPerImage: JUDGE_USD_PER_IMAGE,
      judgeMaxImages: JUDGE_MAX_IMAGES,
    });
  }
  if (path === "/api/upload") {
    uploadCount++;
    return json(res, { url: `https://files.pruna.ai/stub/${uploadCount}.bin` });
  }
  if (path === "/api/generate") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastGenerate = JSON.parse(Buffer.concat(chunks).toString());
    // Held open by /__delay, to stand in for a model whose whole run happens
    // inside this one request.
    if (generateDelayMs) await new Promise((r) => setTimeout(r, generateDelayMs));
    // Thirteen of the image and video models never get a job id: Workers AI and xAI's image
    // endpoints run the whole generation inside this request and answer with
    // the finished image. Returning an id for them too would let the polling
    // loop cover a path that does not exist in production.
    const spec = MODELS_BY_ID.get(lastGenerate.model);
    // Speech comes back the same way, as an MP3 data: URI. The bytes need not
    // decode: what is under test is where the file goes, not how it sounds.
    if (spec && spec.kind === "audio") {
      return json(res, { status: "succeeded", images: ["data:audio/mpeg;base64," + Buffer.from("ID3stub").toString("base64")] });
    }
    if (spec && (spec.provider === "workers-ai" || (spec.provider === "xai" && !spec.xaiAsync))) {
      return json(res, { status: "succeeded", images: ["data:image/png;base64," + PNG.toString("base64")] });
    }
    return json(res, { id: "stub-job-1" });
  }
  if (path === "/api/status") {
    if (statusDelayMs) await new Promise((r) => setTimeout(r, statusDelayMs));
    if (slowJob) return json(res, { status: "processing" });
    // A video model's job has to deliver something the app will treat as video,
    // or the archive path for the expensive half of the catalogue is untestable.
    const spec = lastGenerate && MODELS_BY_ID.get(lastGenerate.model);
    const ext = spec && spec.kind === "video" ? "mp4" : "png";
    return json(res, { status: "succeeded", generation_url: `https://files.pruna.ai/stub/out.${ext}` });
  }
  if (path === "/api/result") {
    // Deliberately the same PNG bytes under a video content type: there is no
    // encoder here, and what these tests are about is the archive — the record,
    // the split across the two stores, the strip, the lightbox. The poster
    // frame then takes videoThumb's documented "will not decode" branch, which
    // is a path worth covering in its own right.
    const isVideo = (url.searchParams.get("url") || "").endsWith(".mp4");
    res.writeHead(200, { "content-type": isVideo ? "video/mp4" : "image/png" });
    return res.end(PNG);
  }
  // The real Worker signs these; nothing here verifies one, because the browser
  // suite stubs the Worker. The signing itself is covered by worker.test.mjs.
  if (path === "/api/token") return json(res, { token: "stub-token", expiresAt: Date.now() + 600000 });
  if (path === "/api/improve-prompt") return json(res, { prompt: "IMPROVED PROMPT TEXT" });
  if (path === "/api/describe") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastDescribe = JSON.parse(Buffer.concat(chunks).toString());
    // Echoes whether the prompt rode along, so a test can tell the two modes
    // apart without the real Worker's composition in front of it.
    return json(res, {
      description: lastDescribe.question ? "STUB ANSWER TEXT" : "STUB CAPTION TEXT",
    });
  }
  // Not configured in the stub, which is a case the app has to tolerate.
  if (path === "/api/chat") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastChat = JSON.parse(Buffer.concat(chunks).toString());
    const n = lastChat.messages.filter((m) => m.role === "user").length;
    return json(res, { reply: `STUB REPLY ${n}`, neurons: 12.3 });
  }
  if (path === "/__chat") return json(res, lastChat || {});
  if (path === "/api/neurons") {
    if (neuronsUsed == null) return json(res, {}, 404);
    return json(res, { day: "2026-09-23", used: neuronsUsed, limit: 10000, remaining: Math.max(0, 10000 - neuronsUsed), byModel: [] });
  }

  // Routes under /__ are the test's own window into what the browser sent;
  // the app never calls them.
  if (path === "/__generate") return json(res, lastGenerate || {});
  if (path === "/__uploads") return json(res, { uploadCount });
  if (path === "/__describe") return json(res, lastDescribe || {});
  if (path === "/__slow") {
    slowJob = url.searchParams.get("on") === "1";
    return json(res, { slowJob });
  }
  if (path === "/__delay") {
    generateDelayMs = Number(url.searchParams.get("ms")) || 0;
    return json(res, { generateDelayMs });
  }
  if (path === "/__neurons") {
    neuronsUsed = url.searchParams.has("used") ? Number(url.searchParams.get("used")) : null;
    return json(res, { neuronsUsed });
  }
  if (path === "/__statusdelay") {
    statusDelayMs = Number(url.searchParams.get("ms")) || 0;
    return json(res, { statusDelayMs });
  }

  // Anything else is a static file, exactly as Workers Assets serves it.
  const file = path === "/" ? "index.html" : path.slice(1);
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// The runner waits for this line before starting a browser.
server.listen(PORT, () => console.log(`stub worker listening on ${PORT}`));
