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
