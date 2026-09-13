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
let uploadCount = 0;
let lastGenerate = null;
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
    return json(res, { id: "stub-job-1" });
  }
  if (path === "/api/status") return json(res, { status: "succeeded", generation_url: "https://files.pruna.ai/stub/out.png" });
  if (path === "/api/result") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG);
  }
  if (path === "/api/improve-prompt") return json(res, { prompt: "IMPROVED PROMPT TEXT" });
  if (path === "/api/describe") return json(res, { description: "STUB CAPTION TEXT" });
  // Not configured in the stub, which is a case the app has to tolerate.
  if (path === "/api/neurons") return json(res, {}, 404);

  // Routes under /__ are the test's own window into what the browser sent;
  // the app never calls them.
  if (path === "/__generate") return json(res, lastGenerate || {});
  if (path === "/__uploads") return json(res, { uploadCount });

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
