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
  EMBED_MODELS,
  DEFAULT_EMBED_MODEL,
  TRANSLATE_LANGUAGES,
  STT_MODELS,
  DEFAULT_STT_MODEL,
  OTHER_TOOLS,
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
// Set by the test through /__statushang: the next N polls never answer at all,
// which is what a connection the phone kept after it died looks like. Only the
// app's own deadline can get a run past one.
let statusHangs = 0;
// Set by the test through /__resultdelay, to hold the result download open so
// the count can be watched while the picture is still on its way.
let resultDelayMs = 0;
// Set by the test through /__neurons, to stand in for a day's analytics. Null
// keeps /api/neurons unconfigured, which is what every other block expects.
let neuronsUsed = null;
// What the chat last sent, for the test to inspect through /__chat.
let lastChat = null;
let embedCalls = 0;
let lastImprove = null;
let lastTool = null;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const json = (res, obj, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

// Improve, Describe and the chat answer as server-sent events, as the Worker
// does: a ping first, then whatever the route streams, then done.
let chatStall = false;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const sseOpen = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("ping", {});
  return send;
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
      embedModels: EMBED_MODELS,
      translateLanguages: TRANSLATE_LANGUAGES,
      sttModels: STT_MODELS,
      defaultSttModel: DEFAULT_STT_MODEL,
      otherTools: OTHER_TOOLS,
      instructions: { improve: "DEFAULT IMPROVE INSTRUCTION", chat: "DEFAULT CHAT INSTRUCTION", describe: "DEFAULT DESCRIBE INSTRUCTION" },
      defaultEmbedModel: DEFAULT_EMBED_MODEL,
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
    if (statusHangs > 0) {
      statusHangs--;
      return; // left open; the browser has to give up on it
    }
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
    if (resultDelayMs) await new Promise((r) => setTimeout(r, resultDelayMs));
    res.writeHead(200, { "content-type": isVideo ? "video/mp4" : "image/png" });
    return res.end(PNG);
  }
  // The real Worker signs these; nothing here verifies one, because the browser
  // suite stubs the Worker. The signing itself is covered by worker.test.mjs.
  if (path === "/api/token") return json(res, { token: "stub-token", expiresAt: Date.now() + 600000 });
  if (path === "/api/improve-prompt") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastImprove = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const send = sseOpen(res);
    await sleepMs(30);
    send("done", { prompt: "IMPROVED PROMPT TEXT", neurons: 5 });
    return res.end();
  }
  if (path === "/__improve") return json(res, lastImprove || {});
  if (path === "/api/describe") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastDescribe = JSON.parse(Buffer.concat(chunks).toString());
    // Echoes whether the prompt rode along, so a test can tell the two modes
    // apart without the real Worker's composition in front of it.
    const send = sseOpen(res);
    await sleepMs(30);
    send("done", { description: lastDescribe.question ? "STUB ANSWER TEXT" : "STUB CAPTION TEXT", neurons: 3 });
    return res.end();
  }
  // Not configured in the stub, which is a case the app has to tolerate.
  if (path === "/api/chat") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastChat = JSON.parse(Buffer.concat(chunks).toString());
    const n = lastChat.messages.filter((m) => m.role === "user").length;
    const send = sseOpen(res);
    // Stalled: the ping went out and then nothing, the way a dead connection or
    // a model that never answers looks from the browser. Held until the
    // browser gives up and closes it.
    if (chatStall) return void req.on("close", () => res.end());
    await sleepMs(30);
    send("delta", { text: "STUB " });
    await sleepMs(30);
    send("delta", { text: `REPLY ${n}` });
    send("done", { reply: `STUB REPLY ${n}`, neurons: 12.3, sawImages: (lastChat.images || []).length });
    return res.end();
  }
  if (path === "/__chat") return json(res, lastChat || {});
  if (path === "/__chatstall") {
    chatStall = url.searchParams.get("on") === "1";
    return json(res, { chatStall });
  }
  if (path === "/api/translate" || path === "/api/transcribe" || path === "/api/other") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    lastTool = { path, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
    if (path === "/api/translate") return json(res, { text: `[${lastTool.body.target_lang}] ${lastTool.body.text}` });
    if (path === "/api/transcribe") return json(res, { text: "STUB TRANSCRIPT" });
    const tool = lastTool.body.tool;
    if (tool === "rerank") return json(res, { result: [{ id: 1, score: 0.9 }, { id: 0, score: 0.1 }] });
    if (tool === "guard") return json(res, { result: "\n\nsafe" });
    return json(res, { result: [{ label: "POSITIVE", score: 0.99 }, { label: "NEGATIVE", score: 0.01 }] });
  }
  if (path === "/__tool") return json(res, lastTool || {});
  if (path === "/api/embed") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const { text } = JSON.parse(Buffer.concat(chunks).toString());
    embedCalls++;
    // A bag of words: each word lights up a few of 64 positions, so texts that
    // share words score close and texts that do not score far apart — enough
    // to test that the panel compares, without a model.
    const vec = new Array(64).fill(0);
    for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let hsh = 0;
      for (const ch of w) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      for (let k = 0; k < 3; k++) vec[(hsh >>> (k * 7)) % 64] += k === 1 ? -1 : 1;
    }
    return json(res, { vector: vec, neurons: 0.01 });
  }
  if (path === "/__embed") return json(res, { embedCalls });
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
  if (path === "/__statushang") {
    statusHangs = Number(url.searchParams.get("n")) || 0;
    return json(res, { statusHangs });
  }
  if (path === "/__resultdelay") {
    resultDelayMs = Number(url.searchParams.get("ms")) || 0;
    return json(res, { resultDelayMs });
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
