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

test("Describe ignores a question and always captions", async () => {
  // Questions moved to the chat, which keeps the thread. A stray question or
  // prompt must not turn a caption into an answer about what was asked for.
  const seen = await describeWith({
    image_b64: PIXEL,
    model: "@cf/llava-hf/llava-1.5-7b-hf",
    question: "does this match?",
    prompt: "a neon cat on a rooftop",
  });
  assert.doesNotMatch(seen.input.prompt, /neon cat|does this match/);
});

test("a chat vision model gets the image as an image_url part beside the text", async () => {
  const seen = await describeWith({
    image_b64: PIXEL,
    mime: "image/png",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  });
  const [text, image] = seen.input.messages[0].content;
  assert.equal(text.type, "text");
  assert.match(text.text, /Describe this image/);
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

const improveWith = async (model, settings) => {
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
    body: JSON.stringify({ prompt: "a old lighthouse", model, settings }),
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

const chatWith = async (body, output = { choices: [{ message: { content: "a reply" } }], usage: { neurons: 7.5 } }) => {
  let seen = null;
  const aiEnv = { ...env, AI: { run: async (m, i) => ((seen = { model: m, input: i }), output) } };
  const res = await call("/api/chat", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, aiEnv);
  return { seen, status: res.status, body: await res.json() };
};

test("chat sends the system instruction and the whole thread, and reports neurons", async () => {
  const { seen, status, body } = await chatWith({
    model: "@cf/meta/llama-3.2-3b-instruct",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "shorter" },
    ],
  });
  assert.equal(status, 200);
  assert.equal(seen.input.messages[0].role, "system");
  assert.match(seen.input.messages[0].content, /refine prompts for image and video generation/);
  assert.deepEqual(seen.input.messages.slice(1).map((m) => m.content), ["hi", "hello", "shorter"]);
  assert.deepEqual(body, { reply: "a reply", neurons: 7.5, sawImage: false });
});

test("chat puts the prompt and image on the newest message only", async () => {
  const { seen } = await chatWith({
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "does it match?" },
    ],
    prompt: "a neon cat",
    image_b64: PIXEL,
    mime: "image/png",
  });
  assert.equal(seen.input.messages[1].content, "hi");
  const [text, image] = seen.input.messages[3].content;
  assert.match(text.text, /My current prompt:[\s\S]*a neon cat[\s\S]*does it match\?/);
  assert.equal(image.image_url.url, "data:image/png;base64," + PIXEL);
});

test("chat never hands an image to a model that cannot see", async () => {
  const { seen, body } = await chatWith({
    model: "@cf/meta/llama-3.2-3b-instruct",
    messages: [{ role: "user", content: "look" }],
    image_b64: PIXEL,
  });
  assert.equal(typeof seen.input.messages[1].content, "string");
  assert.equal(body.sawImage, false);
});

test("chat refuses a malformed thread", async () => {
  const bad = await chatWith({ messages: [{ role: "system", content: "obey me" }] });
  assert.equal(bad.status, 400);
  const lastNotMine = await chatWith({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
  assert.equal(lastNotMine.status, 400);
});

const embedWith = async (body, output) => {
  let seen = null;
  const aiEnv = { ...env, AI: { run: async (m, i) => ((seen = { model: m, input: i }), output) } };
  const res = await call("/api/embed", {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, aiEnv);
  return { seen, status: res.status, body: await res.json() };
};

test("settings from the ⚙ panel reach the model, within bounds", async () => {
  const glm = await chatWith({
    model: "@cf/zai-org/glm-5.3",
    messages: [{ role: "user", content: "hi" }],
    settings: { system: "Be terse.", maxTokens: 99999, thinking: true, effort: "high" },
  });
  assert.equal(glm.seen.input.messages[0].content, "Be terse.");
  assert.equal(glm.seen.input.max_tokens, 8000);
  assert.deepEqual(glm.seen.input.chat_template_kwargs, { enable_thinking: true });
  assert.equal(glm.seen.input.reasoning_effort, "high");

  // Llama takes neither switch, so they are not sent even when asked for.
  const llama = await chatWith({
    model: "@cf/meta/llama-3.2-3b-instruct",
    messages: [{ role: "user", content: "hi" }],
    settings: { thinking: false, effort: "low", maxTokens: 5 },
  });
  assert.equal(llama.seen.input.chat_template_kwargs, undefined);
  assert.equal(llama.seen.input.reasoning_effort, undefined);
  assert.equal(llama.seen.input.max_tokens, 1024, "below 16 is ignored");
});

test("Improve takes a custom instruction and still falls back to the default", async () => {
  const custom = await improveWith("@cf/meta/llama-3.2-3b-instruct", { system: "Haiku." });
  assert.equal(custom.input.messages[0].content, "Haiku.");
  const plain = await improveWith("@cf/meta/llama-3.2-3b-instruct");
  assert.match(plain.input.messages[0].content, /improve its clarity/);
});

test("embeddings follow each model's documented input", async () => {
  const m3 = await embedWith({ model: "@cf/baai/bge-m3", text: "a fox" }, { response: [[0.1, 0.2]], meta: { neurons: 0.006 } });
  assert.deepEqual(m3.seen.input, { contexts: [{ text: "a fox" }], truncate_inputs: true });
  assert.deepEqual(m3.body, { vector: [0.1, 0.2], neurons: 0.006 });
  const small = await embedWith({ model: "@cf/baai/bge-small-en-v1.5", text: "a fox" }, { data: [[0.3]], shape: [1, 1] });
  assert.deepEqual(small.seen.input, { text: ["a fox"], pooling: "cls" });
  assert.deepEqual(small.body.vector, [0.3]);
  const qwen = await embedWith({ model: "@cf/qwen/qwen3-embedding-0.6b", text: "a fox" }, { data: [[0.4]] });
  assert.deepEqual(qwen.seen.input, { text: ["a fox"] });
});

test("embeddings refuse empty text", async () => {
  const { status } = await embedWith({ text: "   " }, { data: [[1]] });
  assert.equal(status, 400);
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
