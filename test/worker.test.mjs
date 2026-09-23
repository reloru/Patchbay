// The Worker's own routes, driven directly rather than through a browser.
//
// Everything here is about the password gate and the media token, which is
// Worker-side code the browser suite cannot reach: session.test.mjs runs
// against a stub of this file, so the real signing has to be exercised
// somewhere else.
//
// No Playwright, no network, no API keys. The Workers runtime globals these
// routes depend on — Request, Response, crypto.subtle, btoa — are all present
// in Node 18+, so the module is imported and its fetch handler called.
//
//   node --test test/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const PASSWORD = "correct horse battery staple";
const env = { APP_PASSWORD: PASSWORD, PRUNA_API_KEY: "test-key" };
const open = {}; // no APP_PASSWORD: the gate is disabled

const call = (path, { password, ...init } = {}, e = env) =>
  worker.fetch(
    new Request("https://patchbay.test" + path, {
      ...init,
      headers: { ...(init.headers || {}), ...(password ? { "x-app-password": password } : {}) },
    }),
    e
  );

const tokenFor = async (e = env) => {
  const res = await call("/api/token", { password: e.APP_PASSWORD }, e);
  assert.equal(res.status, 200);
  return await res.json();
};

test("/api/config answers before the gate, and says a gate exists", async () => {
  const res = await call("/api/config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.authRequired, true);
  assert.ok(Array.isArray(body.models) && body.models.length > 0);
});

test("a gated route refuses a request with no password", async () => {
  const res = await call("/api/token");
  assert.equal(res.status, 401);
});

test("a gated route refuses the wrong password", async () => {
  const res = await call("/api/token", { password: PASSWORD + "!" });
  assert.equal(res.status, 401);
});

test("/api/token mints a token only for a caller holding the password", async () => {
  const { token, expiresAt } = await tokenFor();
  assert.match(token, /^\d+\.[A-Za-z0-9_-]+$/);
  assert.ok(expiresAt > Date.now(), "the token should not arrive already expired");
  assert.equal(token.split(".")[0], String(expiresAt));
});

test("with no gate configured there is nothing to sign", async () => {
  const res = await call("/api/token", {}, open);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: null, expiresAt: 0 });
});

// /api/result is the one route reached without a header, because <img>,
// <video> and download links cannot send one. Each case below stops at the
// auth decision: a 400 for the missing `url` param means the request got past
// the gate, which is exactly what is being asserted. Nothing leaves the
// machine either way.
test("/api/result rejects a request carrying neither header nor token", async () => {
  const res = await call("/api/result?url=https%3A%2F%2Ffiles.pruna.ai%2Fx.png");
  assert.equal(res.status, 401);
});

test("/api/result accepts a freshly minted token", async () => {
  const { token } = await tokenFor();
  const res = await call("/api/result?t=" + encodeURIComponent(token));
  assert.equal(res.status, 400, "past the gate, and stopped on the missing url param");
  assert.match((await res.json()).error, /Missing url param/);
});

test("/api/result rejects an expired token", async () => {
  const { token } = await tokenFor();
  const sig = token.split(".")[1];
  const stale = `${Date.now() - 1000}.${sig}`;
  const res = await call("/api/result?t=" + encodeURIComponent(stale));
  assert.equal(res.status, 401);
});

test("/api/result rejects a token whose expiry has been pushed out", async () => {
  // The forgery this is really about: take a valid signature and try to make it
  // last longer. The expiry is what is signed, so moving it breaks the pair.
  const { token, expiresAt } = await tokenFor();
  const forged = `${expiresAt + 60 * 60 * 1000}.${token.split(".")[1]}`;
  const res = await call("/api/result?t=" + encodeURIComponent(forged));
  assert.equal(res.status, 401);
});

test("/api/result rejects a token signed under a different password", async () => {
  const { token } = await tokenFor({ ...env, APP_PASSWORD: "some other password" });
  const res = await call("/api/result?t=" + encodeURIComponent(token));
  assert.equal(res.status, 401);
});

test("/api/result rejects malformed tokens rather than throwing", async () => {
  for (const bad of ["", ".", "abc", "abc.def", ".sig", "123", `${Date.now() + 1000}.`]) {
    const res = await call("/api/result?t=" + encodeURIComponent(bad));
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(bad)}`);
  }
});

test("a token is no use on any route other than /api/result", async () => {
  // It authorises reading media the caller was already shown, nothing else.
  const { token } = await tokenFor();
  for (const path of ["/api/generate", "/api/upload", "/api/judge", "/api/neurons", "/api/status"]) {
    const res = await call(`${path}?t=${encodeURIComponent(token)}`, { method: "GET" });
    assert.equal(res.status, 401, `${path} should not accept a media token`);
  }
});

test("the password is no longer accepted as a query param", async () => {
  // What this change is for: the URL of every image the app loaded used to
  // carry the password itself, and Workers observability records request URLs.
  const res = await call("/api/result?pw=" + encodeURIComponent(PASSWORD));
  assert.equal(res.status, 401);
});

test("with no gate configured /api/result needs no token at all", async () => {
  const res = await call("/api/result", {}, open);
  assert.equal(res.status, 400, "no gate to pass, so it stops on the missing url param");
});

// /api/describe builds a different payload per vision model, and the browser
// suite stubs this file, so the payloads themselves can only be checked here.
// A fake AI binding records what the model was handed.
const describeWith = async (body) => {
  let seen = null;
  const aiEnv = {
    ...env,
    AI: {
      run: async (model, input) => {
        seen = { model, input };
        return { description: "ok" };
      },
    },
  };
  const res = await call("/api/describe", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, aiEnv);
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  return seen;
};

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("Moondream captions with the caption task when nothing was asked", async () => {
  const seen = await describeWith({ image_b64: PIXEL, model: "@cf/moondream/moondream3.1-9B-A2B" });
  assert.equal(seen.input.task, "caption");
  assert.equal(seen.input.stream, false, "streaming would not come back as one JSON body");
});

test("Moondream takes a question through the query task, not caption", async () => {
  // "caption" ignores a question outright, which is what every question typed
  // used to get on this model — it silently captioned instead of answering.
  const seen = await describeWith({
    image_b64: PIXEL,
    model: "@cf/moondream/moondream3.1-9B-A2B",
    question: "how many cats?",
  });
  assert.equal(seen.input.task, "query");
  assert.match(seen.input.question, /how many cats\?/);
});

test("the prompt is put in front of a question so it can be asked about", async () => {
  const seen = await describeWith({
    image_b64: PIXEL,
    model: "@cf/llava-hf/llava-1.5-7b-hf",
    question: "does this match?",
    prompt: "a neon cat on a rooftop",
  });
  assert.match(seen.input.prompt, /a neon cat on a rooftop/);
  assert.match(seen.input.prompt, /does this match\?/);
});

test("a caption never sees the prompt", async () => {
  // It has to describe the image as it is. Handed the prompt, it would describe
  // what was asked for instead — and the caption's whole job is to tell you
  // what is actually there.
  const seen = await describeWith({
    image_b64: PIXEL,
    model: "@cf/llava-hf/llava-1.5-7b-hf",
    prompt: "a neon cat on a rooftop",
  });
  assert.doesNotMatch(seen.input.prompt, /neon cat/);
});

test("a chat vision model gets the image as an image_url part beside the text", async () => {
  const seen = await describeWith({
    image_b64: PIXEL,
    mime: "image/png",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    question: "does this match?",
    prompt: "a neon cat on a rooftop",
  });
  const [text, image] = seen.input.messages[0].content;
  assert.equal(text.type, "text");
  assert.match(text.text, /a neon cat on a rooftop/);
  assert.equal(image.type, "image_url");
  assert.equal(image.image_url.url, "data:image/png;base64," + PIXEL);
  assert.equal(seen.input.chat_template_kwargs, undefined, "no knob declared, none sent");
});

test("a vision model with thinking off says so, and one with an effort sends it", async () => {
  // Without these, both returned null content at their token budgets.
  const qwen = await describeWith({ image_b64: PIXEL, model: "@cf/qwen/qwen3.8-27b" });
  assert.deepEqual(qwen.input.chat_template_kwargs, { enable_thinking: false });
  const glm = await describeWith({ image_b64: PIXEL, model: "@cf/zai-org/glm-5.3-flash" });
  assert.equal(glm.input.reasoning_effort, "low");
  assert.equal(glm.input.max_tokens, 3072);
});

const improveWith = async (model) => {
  let seen = null;
  const aiEnv = {
    ...env,
    AI: {
      run: async (m, input) => {
        seen = { model: m, input };
        return { choices: [{ message: { content: "rewritten" } }] };
      },
    },
  };
  const res = await call("/api/improve-prompt", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a old lighthouse", model }),
  }, aiEnv);
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  return seen;
};

test("Improve sends each model's reasoning knobs and nothing to models without them", async () => {
  const kimi = await improveWith("@cf/moonshotai/kimi-k2.6");
  assert.deepEqual(kimi.input.chat_template_kwargs, { enable_thinking: false });
  assert.equal(kimi.input.max_tokens, 1500);
  const glm = await improveWith("@cf/zai-org/glm-5.3");
  assert.equal(glm.input.reasoning_effort, "low");
  const llama = await improveWith("@cf/meta/llama-3.2-3b-instruct");
  assert.equal(llama.input.max_tokens, 320);
  assert.equal(llama.input.chat_template_kwargs, undefined);
  assert.equal(llama.input.reasoning_effort, undefined);
});

test("the img2img model the account cannot reach is no longer offered", async () => {
  const res = await call("/api/generate", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cf-sd15-img2img", input: { prompt: "x" } }),
  });
  assert.equal(res.status, 400);
});

const generateWith = async (model, input, output) => {
  let seen = null;
  const aiEnv = { ...env, AI: { run: async (m, i) => ((seen = { model: m, input: i }), output) } };
  const res = await call("/api/generate", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  }, aiEnv);
  return { seen, status: res.status, body: await res.json() };
};

test("Aura's raw MP3 stream comes back as an audio data URI", async () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3"
  const { seen, status, body } = await generateWith(
    "cf-aura-2-en",
    { text: "hello", speaker: "luna" },
    new Response(mp3).body
  );
  assert.equal(status, 200);
  assert.equal(seen.model, "@cf/deepgram/aura-2-en");
  assert.deepEqual(seen.input, { text: "hello", speaker: "luna" });
  assert.equal(body.images[0], "data:audio/mpeg;base64,SUQzBA==");
});

test("/api/generate rejects a model outside the catalogue", async () => {
  const res = await call("/api/generate", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "../../etc/passwd", input: { prompt: "x" } }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unknown model/);
});
