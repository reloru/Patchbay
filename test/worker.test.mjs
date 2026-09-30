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

// Improve, Describe and the chat answer as server-sent events. A model asked to
// stream answers with Workers AI's own SSE body; these build one from chunks
// and read the Worker's events back.
const sse = (...chunks) =>
  new Response(chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("")).body;

const readEvents = async (res) =>
  (await res.text())
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));

// The `done` payload, or the `error` one, whichever ended the stream.
const outcome = (events) => events.find((e) => e.event === "done" || e.event === "error");

// A fake binding: streamed calls get `chunks` as SSE, buffered ones `buffered`.
const fakeAI = (chunks, buffered, record) => ({
  run: async (model, input) => {
    record({ model, input });
    return input.stream ? sse(...chunks) : buffered;
  },
});

const postTool = (path, body, aiEnv) =>
  call(path, {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, aiEnv);

// /api/describe builds a different payload per vision model, and the browser
// suite stubs this file, so the payloads themselves can only be checked here.
// A fake AI binding records what the model was handed.
const describeWith = async (body) => {
  let seen = null;
  const aiEnv = { ...env, AI: fakeAI([{ response: "ok" }, { response: "", usage: { neurons: 2 } }, "[DONE]"], { description: "ok" }, (s) => (seen = s)) };
  const res = await postTool("/api/describe", body, aiEnv);
  assert.equal(res.status, 200);
  const end = outcome(await readEvents(res));
  assert.equal(end.event, "done", JSON.stringify(end.data));
  assert.equal(end.data.description, "ok");
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

test("Describe's instruction is editable, for every kind of vision model", async () => {
  const settings = { system: "Name the colours only." };
  const llava = await describeWith({ image_b64: PIXEL, model: "@cf/llava-hf/llava-1.5-7b-hf", settings });
  assert.equal(llava.input.prompt, "Name the colours only.");
  assert.equal(llava.input.stream, undefined, "LLaVA ignores stream, so it is never asked to");
  const scout = await describeWith({ image_b64: PIXEL, model: "@cf/meta/llama-4-scout-17b-16e-instruct", settings: { ...settings, maxTokens: 300 } });
  assert.equal(scout.input.messages[0].content[0].text, "Name the colours only.");
  assert.equal(scout.input.max_tokens, 300);
  assert.equal(scout.input.stream, true);
  // Moondream's caption task takes no text, so a custom instruction becomes a query.
  const moon = await describeWith({ image_b64: PIXEL, model: "@cf/moondream/moondream3.1-9B-A2B", settings });
  assert.equal(moon.input.task, "query");
  assert.equal(moon.input.question, "Name the colours only.");
  assert.equal(moon.input.reasoning, false);
});

const improveWith = async (model, settings) => {
  let seen = null;
  const chunks = [{ choices: [{ delta: { content: "rewritten" } }] }, { response: "", usage: { neurons: 3 } }, "[DONE]"];
  const aiEnv = { ...env, AI: fakeAI(chunks, null, (s) => (seen = s)) };
  const res = await postTool("/api/improve-prompt", { prompt: "a old lighthouse", model, settings }, aiEnv);
  assert.equal(res.status, 200);
  assert.deepEqual(outcome(await readEvents(res)), { event: "done", data: { prompt: "rewritten", neurons: 3 } });
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

const chatWith = async (body, chunks = [{ choices: [{ delta: { content: "a reply" } }] }, { response: "", usage: { neurons: 7.5 } }, "[DONE]"], extraEnv = {}, buffered = null) => {
  let seen = null;
  const aiEnv = { ...env, ...extraEnv, AI: fakeAI(chunks, buffered, (s) => (seen = s)) };
  const res = await postTool("/api/chat", body, aiEnv);
  if (res.headers.get("content-type").includes("application/json")) return { seen, status: res.status, body: await res.json() };
  const events = await readEvents(res);
  const end = outcome(events);
  return { seen, status: res.status, events, body: end.data, ended: end.event };
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
  assert.equal(seen.input.stream, true);
  assert.deepEqual(body, { reply: "a reply", neurons: 7.5, sawImages: 0 });
});

test("chat streams the reply as it arrives, with reasoning kept out of it", async () => {
  // DeepSeek R1 writes its thinking inline, and the <think> tag can arrive split.
  const inline = await chatWith(
    { model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", messages: [{ role: "user", content: "hi" }] },
    [{ response: "<thi" }, { response: "nk>pondering" }, { response: "</think>Hel" }, { response: "lo" }, { response: "", usage: { neurons: 4 } }, "[DONE]"]
  );
  assert.equal(inline.events[0].event, "ping", "a ping goes out before anything else");
  assert.equal(inline.ended, "done");
  assert.equal(inline.body.reply, "Hello");
  let shown = "";
  for (const e of inline.events) {
    if (e.event === "delta") shown += e.data.text;
    if (e.event === "reset") shown = e.data.text;
  }
  assert.equal(shown, "Hello", "what the browser assembled matches the reply");

  // The OpenAI-style shape carries reasoning in its own delta field.
  const split = await chatWith(
    { model: "@cf/zai-org/glm-4.7-flash", messages: [{ role: "user", content: "hi" }] },
    [
      { choices: [{ delta: { reasoning_content: "hmm" } }] },
      { choices: [{ delta: { content: "Hi " } }] },
      { choices: [{ delta: { content: "there" } }] },
      { response: "", usage: { neurons: 6 } },
      "[DONE]",
    ]
  );
  assert.deepEqual(split.body, { reply: "Hi there", neurons: 6, sawImages: 0 });
});

test("a model that goes quiet ends the chat with an error instead of hanging", async () => {
  const silent = { run: async () => new ReadableStream({ start() {} }) };
  const aiEnv = { ...env, AI: silent, MODEL_IDLE_MS: "60" };
  const res = await postTool("/api/chat", { model: "@cf/meta/llama-3.2-3b-instruct", messages: [{ role: "user", content: "hi" }] }, aiEnv);
  const end = outcome(await readEvents(res));
  assert.equal(end.event, "error");
  assert.match(end.data.error, /stopped responding/);
});

test("chat hands every ticked image to a model that can see", async () => {
  const { seen, body } = await chatWith({
    model: "@cf/google/gemma-4-26b-a4b-it",
    messages: [{ role: "user", content: "compare them" }],
    images: [{ b64: PIXEL, mime: "image/png" }, { b64: PIXEL, mime: "image/jpeg" }],
  });
  const parts = seen.input.messages[1].content;
  assert.deepEqual(parts.map((p) => p.type), ["text", "image_url", "image_url"]);
  assert.equal(parts[2].image_url.url, "data:image/jpeg;base64," + PIXEL);
  assert.equal(body.sawImages, 2);
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
  assert.equal(body.sawImages, 0);
});

test("the three single-question vision models hold the chat too", async () => {
  const thread = [
    { role: "user", content: "what colour?" },
    { role: "assistant", content: "Red." },
    { role: "user", content: "a fruit that colour?" },
  ];
  // Llama 3.2 Vision: a real thread, the image as a top-level byte array.
  const llama = await chatWith({ model: "@cf/meta/llama-3.2-11b-vision-instruct", messages: thread, images: [{ b64: PIXEL, mime: "image/png" }] }, [
    { response: "Strawberry." },
    { response: "", usage: { neurons: 2 } },
    "[DONE]",
  ]);
  assert.equal(llama.seen.input.messages.length, 4, "system plus the thread");
  assert.ok(Array.isArray(llama.seen.input.image) && llama.seen.input.image.length > 0, "image as bytes beside the messages");
  assert.equal(typeof llama.seen.input.messages[3].content, "string");
  assert.deepEqual(llama.body, { reply: "Strawberry.", neurons: 2, sawImages: 1 });

  // Moondream: the conversation as a transcript through its query mode.
  const moon = await chatWith({ model: "@cf/moondream/moondream3.1-9B-A2B", messages: thread, images: [{ b64: PIXEL, mime: "image/png" }] }, [], {}, { answer: "Apple.", usage: { neurons: 3 } });
  assert.equal(moon.seen.input.task, "query");
  assert.match(moon.seen.input.question, /User: what colour\?\n\nAssistant: Red\.\n\nUser: a fruit that colour\?\n\nAssistant:$/);
  assert.equal(moon.seen.input.image, "data:image/png;base64," + PIXEL);
  assert.equal(moon.seen.input.stream, false);
  assert.equal(moon.body.reply, "Apple.");

  // LLaVA: the same transcript, and an image it cannot do without.
  const llava = await chatWith({ model: "@cf/llava-hf/llava-1.5-7b-hf", messages: thread, images: [{ b64: PIXEL }, { b64: PIXEL }] }, [], {}, { description: "Cherry." });
  assert.match(llava.seen.input.prompt, /Assistant:$/);
  assert.ok(Array.isArray(llava.seen.input.image));
  assert.equal(llava.body.sawImages, 1, "a one-image model is handed one");
  const noImage = await chatWith({ model: "@cf/llava-hf/llava-1.5-7b-hf", messages: thread });
  assert.equal(noImage.status, 400);
  assert.match(noImage.body.error, /needs an image/);
});

test("sampling settings reach the model only where its schema takes them, within its range", async () => {
  const sampling = { temperature: 0.3, top_p: 0.9, top_k: 20.4, seed: 7, repetition_penalty: 1.1, frequency_penalty: 0.5, presence_penalty: 0.2 };
  const llama = await chatWith({ model: "@cf/meta/llama-3.2-3b-instruct", messages: [{ role: "user", content: "hi" }], settings: sampling });
  assert.equal(llama.seen.input.temperature, 0.3);
  assert.equal(llama.seen.input.top_k, 20, "top_k is a whole number");
  assert.equal(llama.seen.input.seed, 7);
  assert.equal(llama.seen.input.presence_penalty, 0.2);
  // GLM 5.3's schema has no top_k or repetition_penalty; they are not sent.
  const glm = await chatWith({ model: "@cf/zai-org/glm-5.3", messages: [{ role: "user", content: "hi" }], settings: sampling });
  assert.equal(glm.seen.input.temperature, 0.3);
  assert.equal(glm.seen.input.top_k, undefined);
  assert.equal(glm.seen.input.repetition_penalty, undefined);
  // Outside the documented range (temperature 0–5) is dropped, not clamped.
  const hot = await chatWith({ model: "@cf/meta/llama-3.2-3b-instruct", messages: [{ role: "user", content: "hi" }], settings: { temperature: 9, top_p: "x" } });
  assert.equal(hot.seen.input.temperature, undefined);
  assert.equal(hot.seen.input.top_p, undefined);
  // Moondream's query form takes temperature and top_p only.
  const moon = await chatWith({ model: "@cf/moondream/moondream3.1-9B-A2B", messages: [{ role: "user", content: "hi" }], settings: sampling }, [], {}, { answer: "ok" });
  assert.equal(moon.seen.input.temperature, 0.3);
  assert.equal(moon.seen.input.top_k, undefined);
});

test("Improve runs Moondream through its query mode, on text alone", async () => {
  let seen = null;
  const aiEnv = { ...env, AI: fakeAI([], { result: { answer: "An old lighthouse." } }, (s) => (seen = s)) };
  const res = await postTool("/api/improve-prompt", { prompt: "a old lighthouse", model: "@cf/moondream/moondream3.1-9B-A2B" }, aiEnv);
  assert.equal(seen.input.task, "query");
  assert.match(seen.input.question, /Text:\na old lighthouse$/);
  assert.equal(seen.input.image, undefined);
  assert.equal(outcome(await readEvents(res)).data.prompt, "An old lighthouse.");
  // LLaVA needs an image on every call, so Improve does not offer it.
  let fell = null;
  const env2 = { ...env, AI: fakeAI([{ response: "x" }, "[DONE]"], null, (s) => (fell = s)) };
  await (await postTool("/api/improve-prompt", { prompt: "a cat", model: "@cf/llava-hf/llava-1.5-7b-hf" }, env2)).text();
  assert.notEqual(fell.model, "@cf/llava-hf/llava-1.5-7b-hf");
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

  // "medium" is not one of GLM 5.3's listed efforts; Cloudflare would turn it
  // into "max", so it is dropped here rather than forwarded.
  const medium = await chatWith({
    model: "@cf/zai-org/glm-5.3",
    messages: [{ role: "user", content: "hi" }],
    settings: { effort: "medium" },
  });
  assert.equal(medium.seen.input.reasoning_effort, "low", "falls back to the model's own default");

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

const runWith = async (path, body, output) => {
  let seen = null;
  const aiEnv = { ...env, AI: { run: async (m, i) => ((seen = { model: m, input: i }), output) } };
  const res = await call(path, {
    password: PASSWORD,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, aiEnv);
  return { seen, status: res.status, body: await res.json() };
};

test("translate sends m2m100 its documented fields, and refuses unknown languages", async () => {
  const ok = await runWith("/api/translate", { text: "a fox", source_lang: "en", target_lang: "fr" }, { translated_text: "un renard" });
  assert.equal(ok.seen.model, "@cf/meta/m2m100-1.2b");
  assert.deepEqual(ok.seen.input, { text: "a fox", source_lang: "en", target_lang: "fr" });
  assert.deepEqual(ok.body, { text: "un renard" });
  const bad = await runWith("/api/translate", { text: "a fox", target_lang: "xx" }, {});
  assert.equal(bad.status, 400);
});

test("each speech model gets the audio in its own documented form", async () => {
  const b64 = Buffer.from([1, 2, 3]).toString("base64");
  const turbo = await runWith("/api/transcribe", { model: "@cf/openai/whisper-large-v3-turbo", audio_b64: b64 }, { text: "hi" });
  assert.equal(turbo.seen.input.audio, b64);
  const whisper = await runWith("/api/transcribe", { model: "@cf/openai/whisper", audio_b64: b64 }, { text: "hi" });
  assert.deepEqual(whisper.seen.input.audio, [1, 2, 3]);
  const nova = await runWith(
    "/api/transcribe",
    { model: "@cf/deepgram/nova-3", audio_b64: b64, mime: "audio/webm" },
    { results: { channels: [{ alternatives: [{ transcript: "hello there" }] }] } }
  );
  assert.equal(nova.seen.input.audio.contentType, "audio/webm");
  assert.ok(nova.seen.input.audio.body instanceof ReadableStream);
  assert.deepEqual(nova.body, { text: "hello there" });
});

test("the Other tools send their documented inputs", async () => {
  const guard = await runWith("/api/other", { tool: "guard", text: "a cat" }, { response: "safe" });
  assert.deepEqual(guard.seen.input, { messages: [{ role: "user", content: "a cat" }] });
  const rr = await runWith("/api/other", { tool: "rerank", text: "fox", passages: ["a", " ", "b"] }, { response: [{ id: 0, score: 1 }] });
  assert.deepEqual(rr.seen.input, { query: "fox", contexts: [{ text: "a" }, { text: "b" }] });
  const img = await runWith("/api/other", { tool: "labels", image_b64: Buffer.from([9]).toString("base64") }, [{ label: "X", score: 1 }]);
  assert.deepEqual(img.seen.input, { image: [9] });
  const unknown = await runWith("/api/other", { tool: "nope" }, {});
  assert.equal(unknown.status, 400);
});

test("a model with no system role gets the instruction in the user message", async () => {
  let seen = null;
  const aiEnv = { ...env, AI: fakeAI([{ response: "Sure, here is the rewritten text:\n\nAn old lighthouse." }, "[DONE]"], null, (s) => (seen = s.input)) };
  const res = await postTool("/api/improve-prompt", { prompt: "a old lighthouse", model: "@cf/google/gemma-7b-it-lora" }, aiEnv);
  assert.equal(seen.messages.length, 1);
  assert.equal(seen.messages[0].role, "user");
  assert.match(seen.messages[0].content, /improve its clarity[\s\S]*Text:\na old lighthouse$/);
  assert.deepEqual(outcome(await readEvents(res)).data, { prompt: "An old lighthouse.", neurons: null }, "the 'Sure, here is' line is dropped");

  const chat = await chatWith({ model: "@cf/google/gemma-7b-it-lora", messages: [{ role: "user", content: "hi" }] });
  assert.equal(chat.seen.input.messages[0].role, "user");
  assert.match(chat.seen.input.messages[0].content, /refine prompts[\s\S]*\n\nhi$/);
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

// ── How long the Worker waited on the provider ─────────────────────────────
// Each generation leg carries x-upstream-ms, so the browser can split a slow
// step into the phone-to-Worker part and the Worker-to-provider part. The
// provider is stood in for by a fetch that answers after a fixed pause.
const withProvider = async (answer, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await new Promise((r) => setTimeout(r, 60));
    return answer(...args);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

test("/api/status reports the Worker's wait on the provider", async () => {
  await withProvider(
    () => new Response(JSON.stringify({ status: "processing" }), { headers: { "content-type": "application/json" } }),
    async () => {
      const res = await call("/api/status?id=abc123", { password: PASSWORD });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: "processing" });
      assert.ok(Number(res.headers.get("x-upstream-ms")) >= 50, res.headers.get("x-upstream-ms"));
    }
  );
});

test("/api/generate reports the Worker's wait on the provider", async () => {
  await withProvider(
    () => new Response(JSON.stringify({ id: "job1" }), { status: 201, headers: { "content-type": "application/json" } }),
    async () => {
      const res = await call("/api/generate", {
        password: PASSWORD,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "p-image", input: { prompt: "x" } }),
      });
      assert.equal(res.status, 201);
      assert.ok(Number(res.headers.get("x-upstream-ms")) >= 50, res.headers.get("x-upstream-ms"));
    }
  );
});

test("/api/result reports the Worker's wait on the provider and still streams the bytes", async () => {
  await withProvider(
    () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    async () => {
      const res = await call("/api/result?url=" + encodeURIComponent("https://api.pruna.ai/v1/predictions/delivery/x/out.png"), {
        password: PASSWORD,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
      assert.ok(Number(res.headers.get("x-upstream-ms")) >= 50, res.headers.get("x-upstream-ms"));
    }
  );
});
