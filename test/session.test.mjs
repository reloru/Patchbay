// Browser tests for the on-device editing session and the prompt undo history.
// Run through `npm test`, which starts test/server.mjs first; see test/README.md.
//
// Takes the engine as its first argument, because these two features are about
// what a browser keeps and iOS is the platform that matters. A Chromium-only run
// of this exact suite once reported the session restore working while Safari's
// engine silently failed to store the uploads — the storage assertions below
// pass in Chromium and failed in WebKit until the ArrayBuffer fallback landed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaywright } from "./playwright.mjs";

const ENGINE_NAME = process.argv[2] === "webkit" ? "webkit" : "chromium";
const BASE = `http://localhost:${Number(process.env.PORT) || 8788}/`;
const playwright = await loadPlaywright();
const ENGINE = playwright[ENGINE_NAME];

const dir = mkdtempSync(join(tmpdir(), "pb-"));

// 1x1 PNG and a tiny "video" stand-in for the file-field tests.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const imgPath = join(dir, "cat.png");
writeFileSync(imgPath, PNG);

let pass = 0;
const fails = [];
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const promptSel = '[data-field="prompt"]';

async function open(context, init) {
  const page = await context.newPage();
  page.on("pageerror", (e) => {
    fails.push("pageerror: " + e.message);
    console.log("  FAIL pageerror: " + e.message);
  });
  if (init) await page.addInitScript(init);
  await page.goto(BASE);
  await page.waitForSelector("#app:not(.hidden)");
  await page.waitForFunction(() => document.querySelector("#footer-note").textContent.length > 0);
  // Let the restore's async IndexedDB reads settle.
  await page.waitForTimeout(350);
  return page;
}

const settle = (page) => page.waitForTimeout(900); // > SAVE_DEBOUNCE_MS

// Every record in the named stores, with ArrayBuffers shown as their length so
// they survive the trip out of the page.
const readStores = (page, stores) =>
  page.evaluate(
    (stores) =>
      new Promise((resolve) => {
        const conv = (v) =>
          v instanceof ArrayBuffer
            ? { __buf: v.byteLength }
            : Array.isArray(v)
              ? v.map(conv)
              : v && typeof v === "object"
                ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]))
                : v;
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(stores, "readonly");
          const out = {};
          for (const name of stores) {
            const q = tx.objectStore(name).getAll();
            q.onsuccess = () => (out[name] = (q.result || []).map(conv));
          }
          tx.oncomplete = () => resolve(out);
          tx.onerror = () => resolve(null);
        };
        r.onerror = () => resolve(null);
      }),
    stores
  );

// Empties the gallery and puts `n` items straight into its stores, each built
// from defaults plus what `make(i, now)` returns.
const seedGallery = (page, make, n) =>
  page.evaluate(
    ({ src, n }) =>
      new Promise((resolve) => {
        const make = new Function("return " + src)();
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes", "galleryThumbs"], "readwrite");
          const light = tx.objectStore("gallery");
          const heavy = tx.objectStore("galleryBytes");
          light.clear();
          heavy.clear();
          tx.objectStore("galleryThumbs").clear();
          const now = Date.now();
          for (let i = 0; i < n; i++) {
            const rec = {
              modelId: "p-image",
              prompt: "",
              kind: "image",
              type: "image/png",
              width: 10,
              height: 10,
              size: 1024,
              name: "",
              albums: [],
              ...make(i, now),
            };
            light.put(rec);
            heavy.put({ id: rec.id, bytes: new ArrayBuffer(1024) });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
      }),
    { src: make.toString(), n }
  );

// The tool strip acts straight away; the models it uses are picked in ⚙
// Options, a sheet over the form.
async function openOptions(page) {
  if (await page.locator("#sheet-more").isHidden()) await page.locator("#open-more").click();
}
async function closeOptions(page) {
  if (await page.locator("#sheet-more").isVisible()) await page.locator("#sheet-more .sheet-close").click();
}
async function pickImprove(page, id) {
  await openOptions(page);
  await page.selectOption("#improve-model", id);
}
// Describe is on each gallery image: open one and caption it into the prompt
// box.
// The item is put straight into the gallery: what is under test is Describe,
// not generating, and the model on screen may need inputs to generate at all.
async function describeFromGallery(page) {
  await seedGallery(page, (i, now) => ({ id: "describe-me", createdAt: now, prompt: "an image to describe" }), 1);
  await page.evaluate(() => renderRecent());
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  await page.locator("#viewer-describe").click();
}
async function improveGear(page) {
  await openOptions(page);
  await page.locator("#improve-settings").click();
}

const browser = await ENGINE.launch();
console.log(`engine: ${ENGINE_NAME} ${browser.version()}`);

// ── Persistence ────────────────────────────────────────────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);

  // model + prompt + options
  await page.selectOption("#model-select", "p-image");
  await page.fill(promptSel, "a cat wearing a tiny hat");
  await page.fill('[data-field="width"]', "1536");
  await page.selectOption('[data-field="aspect_ratio"]', "9:16");
  // The real checkbox is visually replaced by the switch track, so the label is
  // what a user taps.
  await page.locator('label.toggle:has([data-field="prompt_upsampling"])').click();
  await settle(page);
  const changedBefore = await page.locator(".options .opt-row.changed").count();
  await page.close();

  page = await open(context);
  check("model restored", (await page.inputValue("#model-select")) === "p-image");
  check("prompt restored", (await page.inputValue(promptSel)) === "a cat wearing a tiny hat");
  // The restored text is the baseline: there is no history from last time to
  // undo into, and the first edit after a reopen undoes back to it.
  check("undo disabled after a restore", await page.locator("#prompt-undo").isDisabled());
  await page.locator(promptSel).pressSequentially(" and boots", { delay: 15 });
  await page.waitForTimeout(700);
  await page.locator("#prompt-undo").click();
  check("undo after a restore returns the restored text", (await page.inputValue(promptSel)) === "a cat wearing a tiny hat");
  await page.locator("#prompt-redo").click();
  await page.fill(promptSel, "a cat wearing a tiny hat");
  await page.waitForTimeout(700);
  check("number option restored", (await page.inputValue('[data-field="width"]')) === "1536");
  check("enum option restored", (await page.inputValue('[data-field="aspect_ratio"]')) === "9:16");
  check("bool option restored", await page.locator('[data-field="prompt_upsampling"]').isChecked());
  check("settings are in plain view, not behind a tap", await page.locator('[data-field="width"]').isVisible());
  const changedAfter = await page.locator(".options .opt-row.changed").count();
  check("changed settings restored as changed", changedBefore > 0 && changedBefore === changedAfter, `${changedBefore} vs ${changedAfter}`);

  // uploads: p-image-edit takes up to 5 images
  await page.selectOption("#model-select", "p-image-edit");
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "make it rain");
  await settle(page);
  const uploadsBefore = (await (await fetch(BASE + "__uploads")).json()).uploadCount;
  await page.close();

  page = await open(context);
  check("upload survived reopen", (await page.locator(".thumbs .thumb").count()) === 1);
  const restored = await page.evaluate(() =>
    (uploads.images || []).map((u) => ({
      isFile: u.file instanceof File,
      name: u.file && u.file.name,
      type: u.file && u.file.type,
      size: u.file && u.file.size,
      url: u.url,
    }))
  );
  check(
    "upload is a real File again, named and typed",
    restored.length === 1 &&
      restored[0].isFile &&
      restored[0].name === "cat.png" &&
      restored[0].type === "image/png" &&
      restored[0].size === 70,
    JSON.stringify(restored)
  );
  check("restored upload got a fresh provider url", /^https:\/\/files\.pruna\.ai\//.test(restored[0].url || ""), restored[0].url);
  check("prompt restored with upload", (await page.inputValue(promptSel)) === "make it rain");
  const uploadsAfter = (await (await fetch(BASE + "__uploads")).json()).uploadCount;
  check("restored file was re-encoded for the provider", uploadsAfter === uploadsBefore + 1, `${uploadsBefore} -> ${uploadsAfter}`);
  const thumbSrc = await page.locator(".thumbs .thumb img").getAttribute("src");
  check("restored thumbnail has a fresh preview url", /^blob:/.test(thumbSrc), thumbSrc);

  // model switch with an image attached still carries it over
  await page.selectOption("#model-select", "p-image-edit-text-aware");
  await page.waitForTimeout(200);
  const carried = await page.locator(".thumbs .thumb").count();
  check("image carries across a model switch", carried === 1, `thumbs=${carried}`);
  await settle(page);
  await page.close();

  page = await open(context);
  check("switched model persisted", (await page.inputValue("#model-select")) === "p-image-edit-text-aware");
  check("carried image persisted", (await page.locator(".thumbs .thumb").count()) === 1);

  // Reset clears the snapshot too
  await page.locator("#reset-btn").click();
  await settle(page);
  await page.close();
  page = await open(context);
  check("Reset persisted as empty", (await page.locator(".thumbs .thumb").count()) === 0);
  check("Reset cleared the prompt for good", (await page.inputValue(promptSel)) === "");
  await page.close();
  await context.close();
}

// ── IndexedDB unavailable ──────────────────────────────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context, () => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new Error("IndexedDB is blocked");
      },
    });
  });
  await page.fill(promptSel, "still works without storage");
  await settle(page);
  check("app usable with IndexedDB blocked", (await page.inputValue(promptSel)) === "still works without storage");
  check("no error status shown", await page.locator("#status").evaluate((el) => el.classList.contains("hidden")));
  // Undo still works with no storage at all.
  await page.waitForTimeout(600);
  await page.locator("#prompt-undo").click();
  check("undo works with IndexedDB blocked", (await page.inputValue(promptSel)) === "");
  await page.close();
  await context.close();
}

// ── An engine that refuses Blobs in IndexedDB ──────────────────────────────
//
// WebKit aborts the whole transaction with "Error preparing Blob/File data to be
// stored in object store" for any value containing a Blob, which cost exactly the
// uploads while everything else restored. This reproduces that refusal in
// whichever engine is running — abort the transaction the way WebKit does — so the
// ArrayBuffer fallback is covered even in a browser that would have taken the
// Blob happily.
{
  const context = await browser.newContext();
  const refuseBlobs = () => {
    const holdsBlob = (v) => {
      if (v instanceof Blob) return true;
      if (!v || typeof v !== "object") return false;
      return Object.values(v).some((x) => holdsBlob(x));
    };
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (!holdsBlob(value)) return realPut.call(this, value, key);
      const req = realPut.call(this, { refused: true }, key);
      try {
        this.transaction.abort();
      } catch {
        /* already finished — the request result is moot either way */
      }
      return req;
    };
  };

  let page = await open(context, refuseBlobs);
  await page.selectOption("#model-select", "p-image-edit");
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "stored as bytes");
  await settle(page);
  const shape = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction("session", "readonly");
          const g = tx.objectStore("session").get("files");
          tx.oncomplete = () => {
            const rec = g.result && g.result.files && g.result.files.images && g.result.files.images[0];
            resolve(
              !rec
                ? "no record"
                : rec.buf instanceof ArrayBuffer
                  ? "buf:" + rec.buf.byteLength
                  : rec.blob
                    ? "blob"
                    : "neither"
            );
          };
          tx.onerror = () => resolve("read failed");
        };
        r.onerror = () => resolve("open failed");
      })
  );
  check("falls back to storing the bytes", shape === "buf:70", shape);
  await page.close();

  page = await open(context, refuseBlobs);
  check("upload restores from the byte fallback", (await page.locator(".thumbs .thumb").count()) === 1);
  const back = await page.evaluate(() =>
    (uploads.images || []).map((u) => ({ isFile: u.file instanceof File, name: u.file && u.file.name, size: u.file && u.file.size }))
  );
  check(
    "byte fallback restores a named File",
    back.length === 1 && back[0].isFile && back[0].name === "cat.png" && back[0].size === 70,
    JSON.stringify(back)
  );
  check("prompt restored alongside it", (await page.inputValue(promptSel)) === "stored as bytes");
  await page.close();
  await context.close();
}

// ── Undo / redo ────────────────────────────────────────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  const undo = page.locator("#prompt-undo");
  const redo = page.locator("#prompt-redo");

  check("undo disabled on a fresh load", await undo.isDisabled());
  check("redo disabled on a fresh load", await redo.isDisabled());

  // Typing: one entry per burst, not per keystroke.
  await page.locator(promptSel).pressSequentially("hello world", { delay: 15 });
  await page.waitForTimeout(700);
  check("undo enabled after typing", await undo.isEnabled());
  await undo.click();
  check("a typing burst is one undo entry", (await page.inputValue(promptSel)) === "", await page.inputValue(promptSel));
  check("redo enabled after undo", await redo.isEnabled());
  await redo.click();
  check("redo restores the burst", (await page.inputValue(promptSel)) === "hello world");
  check("redo disabled at the tip", await redo.isDisabled());

  // Undo → type → redo cleared
  await undo.click();
  check("undo again empties it", (await page.inputValue(promptSel)) === "");
  await page.locator(promptSel).pressSequentially("brand new text", { delay: 15 });
  check("typing clears redo immediately", await redo.isDisabled());
  await page.waitForTimeout(700);
  check("redo still cleared after the commit", await redo.isDisabled());
  await undo.click();
  check("undo after retyping goes back to empty", (await page.inputValue(promptSel)) === "");

  // Improve → Undo
  await page.fill(promptSel, "cat on a skateboard");
  await page.waitForTimeout(700);
  await page.locator("#prompt-improve").click();
  await page.waitForFunction(
    (s) => document.querySelector(s).value === "IMPROVED PROMPT TEXT",
    promptSel
  );
  check("Improve stays Improve rather than becoming its own undo", (await page.locator("#prompt-improve").textContent()) === "Improve");
  await undo.click();
  check("Improve is undoable in one press", (await page.inputValue(promptSel)) === "cat on a skateboard");
  await redo.click();
  check("Improve is redoable", (await page.inputValue(promptSel)) === "IMPROVED PROMPT TEXT");
  await undo.click();

  // Describe → Undo (from a gallery image)
  await describeFromGallery(page);
  await page.waitForFunction((s) => document.querySelector(s).value === "STUB CAPTION TEXT", promptSel);
  await undo.click();
  check("Describe is undoable in one press", (await page.inputValue(promptSel)) === "cat on a skateboard");

  // Saved prompt load → Undo
  await page.evaluate(() =>
    localStorage.setItem("pruna_prompts", JSON.stringify([{ name: "saved one", text: "a saved prompt body" }]))
  );
  await page.reload();
  await page.waitForSelector("#app:not(.hidden)");
  await page.waitForTimeout(400);
  const before = await page.inputValue(promptSel);
  await page.locator("#open-prompts").click();
  // The old flat list is moved into the library rather than lost.
  check("a prompt saved by an earlier version is in the library", (await page.locator(".lib-card .lib-name").first().textContent()) === "saved one");
  check("and its text shows without loading it", (await page.locator(".lib-card .lib-text").first().textContent()) === "a saved prompt body");
  await page.locator(".lib-card .lib-use").first().click();
  check("saved prompt loaded", (await page.inputValue(promptSel)) === "a saved prompt body");
  check("and the sheet gets out of the way", await page.locator("#sheet-prompts").isHidden());
  await page.locator("#prompt-undo").click();
  check("loading a saved prompt is undoable", (await page.inputValue(promptSel)) === before, `back to "${await page.inputValue(promptSel)}" want "${before}"`);

  // Keyboard shortcuts (desktop)
  await page.fill(promptSel, "");
  await page.locator(promptSel).pressSequentially("keyboard test", { delay: 15 });
  await page.waitForTimeout(700);
  await page.locator(promptSel).press("Control+z");
  check("Ctrl+Z undoes", (await page.inputValue(promptSel)) !== "keyboard test");
  await page.locator(promptSel).press("Control+Shift+z");
  check("Ctrl+Shift+Z redoes", (await page.inputValue(promptSel)) === "keyboard test");

  // Improve twice in a row: the second click improves again rather than reverting.
  await page.fill(promptSel, "first text");
  await page.waitForTimeout(700);
  await page.locator("#prompt-improve").click();
  await page.waitForFunction((s) => document.querySelector(s).value === "IMPROVED PROMPT TEXT", promptSel);
  await page.fill(promptSel, "second text");
  await page.waitForTimeout(700);
  await page.locator("#prompt-improve").click();
  await page.waitForFunction((s) => document.querySelector(s).value === "IMPROVED PROMPT TEXT", promptSel);
  check("a second Improve improves instead of reverting", (await page.inputValue(promptSel)) === "IMPROVED PROMPT TEXT");
  await undo.click();
  check("the second Improve is undoable to its own input", (await page.inputValue(promptSel)) === "second text");

  // History survives a model switch.
  await page.fill(promptSel, "text typed on the first model");
  await page.waitForTimeout(700);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  check("prompt carried across the switch", (await page.inputValue(promptSel)) === "text typed on the first model");
  check("undo still available after a model switch", await undo.isEnabled());
  await undo.click();
  check("undo after a switch reaches pre-switch text", (await page.inputValue(promptSel)) === "second text");
  await redo.click();
  check("redo after a switch works too", (await page.inputValue(promptSel)) === "text typed on the first model");

  // A model with no prompt field holds the history rather than dropping it.
  await page.selectOption("#model-select", "p-image-upscale");
  await page.waitForTimeout(200);
  check("no prompt field means no prompt to undo", await undo.isDisabled());
  check("redo inert on a promptless model", await redo.isDisabled());
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  check("undo returns with the next model that has a prompt", await undo.isEnabled());
  await undo.click();
  check("text lost to the promptless model is recoverable", (await page.inputValue(promptSel)) === "text typed on the first model");

  // Reset is an undo entry for the prompt.
  await page.fill(promptSel, "about to be reset");
  await page.waitForTimeout(700);
  await page.locator("#reset-btn").click();
  check("Reset clears the prompt", (await page.inputValue(promptSel)) === "");
  check("Reset is undoable", await undo.isEnabled());
  await undo.click();
  check("undo after Reset restores the prompt", (await page.inputValue(promptSel)) === "about to be reset");

  // Reset mid-burst, before the typing timer fires.
  await page.fill(promptSel, "");
  await page.waitForTimeout(700);
  await page.locator(promptSel).pressSequentially("typed then immediately reset", { delay: 5 });
  await page.locator("#reset-btn").click();
  await undo.click();
  check("an uncommitted edit survives Reset", (await page.inputValue(promptSel)) === "typed then immediately reset");
  await page.close();
  await context.close();
}

// ── Mode-dependent fields, multi-file fields, stale records ────────────────
{
  const context = await browser.newContext();
  let page = await open(context);

  // A field that only exists in one mode: xAI video's source video belongs to
  // edit/extend, and the mode itself is restored from the same snapshot.
  const vidPath = join(dir, "clip.mp4");
  writeFileSync(vidPath, Buffer.from("00000018667479706d70343200000000", "hex"));
  await page.selectOption("#model-select", "xai-imagine-video");
  await page.selectOption('[data-field="mode"]', "edits");
  await page.locator('label.field:has-text("Source video") .file-input').setInputFiles(vidPath);
  await page.waitForSelector(".thumbs .thumb.file");
  await page.fill(promptSel, "make the sky purple");
  await settle(page);
  await page.close();

  page = await open(context);
  check("mode restored", (await page.inputValue('[data-field="mode"]')) === "edits");
  check("mode-only field is visible again", await page.locator('label.field:has-text("Source video")').isVisible());
  check("video file restored into its own field", (await page.locator(".thumbs .thumb.file").count()) === 1);
  const vid = await page.evaluate(() => (uploads.video || []).map((u) => ({ n: u.file && u.file.name, url: (u.url || "").slice(0, 14) })));
  check("restored video re-encoded as a data URI for xAI", vid.length === 1 && vid[0].n === "clip.mp4" && vid[0].url === "data:video/mp4", JSON.stringify(vid));

  // Several files in one field.
  await page.selectOption("#model-select", "p-image-edit");
  const imgPath2 = join(dir, "dog.png");
  writeFileSync(imgPath2, PNG);
  await page.setInputFiles(".file-input", [imgPath, imgPath2]);
  // Three, not two: the clip carried over from the xAI model is still attached.
  await page.waitForFunction(() => document.querySelectorAll(".thumbs .thumb").length === 3);
  await settle(page);
  await page.close();

  page = await open(context);
  // Three: the clip carried over from the xAI model, plus the two just added.
  check("every file in a multi-file field restored", (await page.locator(".thumbs .thumb").count()) === 3);
  check("file count label restored", (await page.locator(".file-status").textContent()).includes("3 of 5"));
  const names = await page.evaluate(() => (uploads.images || []).map((u) => u.file.name));
  check("restored in the original order", names.join(",") === "clip.mp4,cat.png,dog.png", names.join(","));
  check("mixed image and non-image thumbs restored", (await page.locator(".thumbs .thumb.file").count()) === 1);
  await page.close();
  await context.close();
}

// ── A snapshot naming a model that has left the catalogue ──────────────────
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction("session", "readwrite");
          tx.objectStore("session").put({ savedAt: Date.now(), modelId: "model-that-left", fields: { prompt: "x" }, touched: [] }, "meta");
          tx.oncomplete = () => resolve();
        };
      })
  );
  // Stop the page's own pagehide flush from overwriting the record just planted.
  await page.evaluate(() => { persistBroken = true; });
  await page.close();
  page = await open(context);
  check("boots on the default model when the saved one is gone", (await page.inputValue("#model-select")) === "p-image-edit");
  check("prompt left empty by the unusable snapshot", (await page.inputValue(promptSel)) === "");
  const wiped = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction("session", "readonly");
          const g = tx.objectStore("session").get("meta");
          g.onsuccess = () => resolve(g.result === undefined || g.result.modelId !== "model-that-left");
        };
      })
  );
  check("unusable snapshot discarded", wiped);
  await page.close();
  await context.close();
}

// ── A restored session generates the payload it was left with ──────────────
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.selectOption("#model-select", "p-image-edit");
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "restored payload prompt");
  await page.selectOption('[data-field="aspect_ratio"]', "3:2");
  // seed defaults to "" and its own -1 means "randomise": setting it is only
  // sent because the row is marked deliberately edited, which is the flag the
  // snapshot has to carry.
  await page.fill('[data-field="seed"]', "1234");
  await settle(page);
  // What this same state sends before any reopen, to compare against.
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  const fresh = await (await fetch(BASE + "__generate")).json();
  await page.close();

  page = await open(context);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  const sent = await (await fetch(BASE + "__generate")).json();
  check("generates with the restored model", sent.model === "p-image-edit", JSON.stringify(sent.model));
  check("generates with the restored prompt", sent.input.prompt === "restored payload prompt");
  check("generates with the restored option", sent.input.aspect_ratio === "3:2");
  check("generates with the restored seed", sent.input.seed === 1234);
  check("generates with the re-encoded upload", Array.isArray(sent.input.images) && /^https:\/\/files\.pruna\.ai\//.test(sent.input.images[0]), JSON.stringify(sent.input.images));
  // The point: a restored session sends exactly what the live one did. p-image-edit
  // sends turbo and the moderation flag on every request by design (their shown
  // defaults deliberately differ from the provider's), so the comparison is
  // against the pre-reopen payload rather than against a guessed key list.
  const keys = (o) => Object.keys(o).sort().join(",");
  check("restored payload carries the same fields", keys(sent.input) === keys(fresh.input), `${keys(sent.input)} vs ${keys(fresh.input)}`);
  const same = Object.keys(fresh.input).every((k) => JSON.stringify(sent.input[k]) === JSON.stringify(fresh.input[k]) || k === "images");
  check("restored payload carries the same values", same, JSON.stringify(sent.input));
  await page.close();
  await context.close();
}

// ── Sending a generated image back in as an input ──────────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);

  const generate = async () => {
    await page.locator("#generate-btn").click();
    await page.waitForSelector("#status.ok");
    await page.waitForSelector(".result-actions .reuse");
  };

  // A generation model with no image field at all: the button names the model
  // it will switch to, and switching carries the image in.
  await page.selectOption("#model-select", "p-image");
  await page.fill(promptSel, "a lighthouse");
  await page.waitForTimeout(700);
  await generate();
  check(
    "reuse button names the fallback model when there is nowhere to put it",
    (await page.locator(".reuse").textContent()) === "Edit in P-Image-Edit",
    await page.locator(".reuse").textContent()
  );
  await page.locator(".reuse").click();
  await page.waitForTimeout(400);
  check("switched to the editing model", (await page.inputValue("#model-select")) === "p-image-edit");
  const carried = await page.evaluate(() =>
    (uploads.images || []).map((u) => ({ isFile: u.file instanceof File, name: u.file && u.file.name, type: u.file && u.file.type }))
  );
  check(
    "the generated image landed in the editing model's field",
    carried.length === 1 && carried[0].isFile && /^generated-\d+\./.test(carried[0].name) && carried[0].type === "image/png",
    JSON.stringify(carried)
  );
  check("thumbnail rendered for it", (await page.locator(".thumbs .thumb").count()) === 1);
  check("prompt survived the switch", (await page.inputValue(promptSel)) === "a lighthouse");

  // On an editing model whose image field is its required subject, the label
  // says so rather than calling it a reference.
  await generate();
  check("label reads Edit this on an editing model", (await page.locator(".reuse").first().textContent()) === "Edit this");
  await page.locator(".reuse").first().click();
  await page.waitForTimeout(300);
  check("adds to the same field rather than switching", (await page.inputValue("#model-select")) === "p-image-edit");
  check("two images attached now", (await page.locator(".thumbs .thumb").count()) === 2);

  // A generation model whose image field is a reference gets the other label.
  await page.selectOption("#model-select", "xai-imagine-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "a harbour at dusk");
  await page.waitForTimeout(700);
  // This model's image field is optional; it sits with the other inputs,
  // outside Settings. Clear what carried over to make room.
  while ((await page.locator(".thumbs .thumb .rm").count()) > 0) {
    await page.locator(".thumbs .thumb .rm").first().click();
  }
  await generate();
  check(
    "label reads Use as reference on a generation model",
    (await page.locator(".reuse").first().textContent()) === "Use as reference",
    await page.locator(".reuse").first().textContent()
  );
  await page.locator(".reuse").first().click();
  await page.waitForTimeout(300);
  const ref = await page.evaluate(() => (uploads.images || []).length);
  check("landed in the reference field", ref === 1, String(ref));
  check(
    "an optional input sits in Inputs, in plain view, not inside Settings",
    (await page.locator(".section-inputs .thumbs .thumb").count()) === 1 && (await page.locator(".options .thumbs .thumb").count()) === 0
  );

  // The reused image is an ordinary upload, so the session store keeps it.
  await settle(page);
  await page.close();
  page = await open(context);
  check("a reused image survives a reopen", (await page.locator(".thumbs .thumb").count()) === 1);
  check("still on the same model", (await page.inputValue("#model-select")) === "xai-imagine-image");

  // A full field is skipped rather than overwritten.
  await page.selectOption("#model-select", "p-image-rmbg");
  await page.waitForTimeout(300);
  const held = await page.evaluate(() => (uploads.image || []).length);
  check("single-slot field took the carried image", held === 1, String(held));
  // p-image-rmbg has no prompt field at all, and its one image slot is now
  // full, so there is nowhere on this model for another image to go.
  await generate();
  check(
    "a full single-slot field sends it to the editing model instead",
    (await page.locator(".reuse").first().textContent()) === "Edit in P-Image-Edit",
    await page.locator(".reuse").first().textContent()
  );
  await page.close();
  await context.close();
}

// ── Judge still reads the provider urls, not the local blobs ───────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.fill(promptSel, "score me");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  const urls = await page.evaluate(() => ({
    urls: lastResult.urls.slice(),
    blobs: lastResult.blobs.map((b) => (b ? b.size : null)),
  }));
  check(
    "lastResult keeps provider urls and holds the bytes alongside",
    urls.urls.length === 1 && /^https:\/\/files\.pruna\.ai\//.test(urls.urls[0]) && urls.blobs[0] > 0,
    JSON.stringify(urls)
  );
  check("the result renders from the local bytes", /^blob:/.test(await page.locator(".result img").getAttribute("src")));
  await page.close();
  await context.close();
}

// ── The gallery ────────────────────────────────────────────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);

  const gen = async (prompt) => {
    await page.fill(promptSel, prompt);
    await page.waitForTimeout(700);
    await page.locator("#generate-btn").click();
    await page.waitForSelector("#status.ok");
    await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);
  };

  await page.selectOption("#model-select", "p-image");
  check("the strip is hidden before anything is generated", await page.locator("#recent").evaluate((el) => el.classList.contains("hidden")));

  await gen("first picture");
  check("a generation appears in the strip", (await page.locator(".recent-strip .thumb").count()) === 1);
  const stored = await readStores(page, ["gallery", "galleryBytes", "galleryThumbs"]);
  const light = stored.gallery[0] || {};
  check(
    "the metadata record holds no media bytes and no thumbnail",
    stored.gallery.length === 1 && !("bytes" in light) && !("thumb" in light) && light.prompt === "first picture" && light.modelId === "p-image" && light.size > 0,
    JSON.stringify(light)
  );
  check(
    "a run with nothing attached records that, so reusing it clears what is attached",
    light.inputs && Object.keys(light.inputs).length === 0,
    JSON.stringify(light.inputs)
  );
  check(
    "the image itself is an ArrayBuffer in the bytes store, under the same id",
    stored.galleryBytes.length === 1 && stored.galleryBytes[0].bytes.__buf > 0 && stored.galleryBytes[0].id === light.id,
    JSON.stringify(stored.galleryBytes)
  );
  check(
    "and its thumbnail in a store of its own",
    stored.galleryThumbs.length === 1 && stored.galleryThumbs[0].id === light.id && stored.galleryThumbs[0].buf.__buf > 0,
    JSON.stringify(stored.galleryThumbs)
  );

  // Survives a reopen — the assertion that would have caught the WebKit bug.
  await page.close();
  page = await open(context);
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length === 1);
  check("the strip survives a reopen", (await page.locator(".recent-strip .thumb").count()) === 1);
  check("the strip says what the gallery holds", (await page.locator("#recent-count").textContent()).includes("1 in the gallery"));
  await page.waitForFunction(() => !!document.querySelector(".recent-strip .thumb img[src^='blob:']"));
  check("its thumbnail is loaded from the thumbnail store", true);

  // The viewer: full screen, the settings, and Reuse parameters.
  await page.fill(promptSel, "something else entirely");
  await page.waitForTimeout(700);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  check("the viewer names the model", (await page.locator("#viewer-meta").textContent()).includes("P-Image"));
  check("and shows the whole prompt", (await page.locator("#viewer-prompt").textContent()) === "first picture");
  const rows = await page.locator(".param-row dt").allTextContents();
  check("and every setting the run was made with", rows.includes("Aspect ratio") && rows.includes("Seed"), JSON.stringify(rows));
  check("the viewer covers the screen", await page.locator("#viewer").evaluate((el) => el.getBoundingClientRect().width === window.innerWidth));
  await page.locator("#viewer-reuse").click();
  await page.waitForTimeout(300);
  check("Reuse parameters closes the viewer", await page.locator("#viewer").isHidden());
  check("and puts the prompt back", (await page.inputValue(promptSel)) === "first picture");
  await page.locator("#prompt-undo").click();
  check("as one Undo step", (await page.inputValue(promptSel)) === "something else entirely");

  // Name it; a named item is kept whatever the limits say.
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  await page.fill("#viewer-name", "Fox at dawn");
  await page.locator("#viewer-name").press("Enter");
  await page.waitForTimeout(300);
  check("a name is kept on the record", (await readStores(page, ["gallery"])).gallery[0].name === "Fox at dawn");
  check("and the viewer says the item is now kept", (await page.locator(".viewer-keep").count()) === 1);

  // Albums: made from the viewer, ticked, and shown as a chip.
  await page.locator(".album-add").click();
  await page.waitForSelector("#sheet-albums:not(.hidden)");
  await page.fill("#album-new", "Animals");
  await page.locator("#album-new-form button").click();
  await page.waitForSelector(".album-check input");
  check("a new album made from an item contains it", await page.locator(".album-check input").first().isChecked());
  await page.locator("#sheet-albums .sheet-close").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".album-chip")].some((c) => c.textContent === "Animals"));
  check("the viewer shows its album", true);

  // Reuse as an input, from the viewer.
  await page.locator("#viewer-use").click();
  await page.waitForTimeout(400);
  check("use as input switches and attaches", (await page.inputValue("#model-select")) === "p-image-edit");
  check("the image landed", (await page.evaluate(() => (uploads.images || []).length)) === 1);

  // The Gallery screen: search by word, by setting, by album, and sort.
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.fill('[data-field="seed"]', "777");
  await gen("second picture of a boat");
  await page.locator("#tab-gallery").click();
  await page.waitForFunction(() => document.querySelectorAll("#gallery-grid .tile").length === 2);
  check("the Gallery tab is its own screen", (await page.locator("#screen-create").isHidden()) && (await page.locator("#screen-gallery").isVisible()));
  check("Generate is not on it", await page.locator("#generate-btn").isHidden());
  const search = async (q, n) => {
    await page.fill("#gallery-search", q);
    await page.waitForFunction((n) => document.querySelectorAll("#gallery-grid .tile").length === n, n, { timeout: 3000 }).catch(() => {});
    return page.locator("#gallery-grid .tile").count();
  };
  check("a word from the prompt finds it", (await search("boat", 1)) === 1);
  check("so does its name", (await search("dawn", 1)) === 1);
  check("a setting by name and value", (await search("seed:777", 1)) === 1);
  check("a setting compared as a number", (await search("seed>700", 1)) === 1);
  check("an album", (await search("album:animals", 1)) === 1);
  check("a word ruled out", (await search("-boat", 1)) === 1);
  check("and nothing for no match", (await search("giraffe", 0)) === 0);
  check("which says so", await page.locator("#gallery-empty").isVisible());
  await search("", 2);
  await page.selectOption("#gallery-sort", "name");
  await page.waitForTimeout(300);
  check("sorting by name puts named items first", (await page.locator("#gallery-grid .tile").first().getAttribute("title")) === "Fox at dawn");
  await page.selectOption("#gallery-sort", "new");
  await page.selectOption("#gallery-album", { label: "Animals" });
  await page.waitForTimeout(300);
  check("the album filter shows the album", (await page.locator("#gallery-grid .tile").count()) === 1);
  await page.selectOption("#gallery-album", "all");
  await page.waitForTimeout(300);

  // A setting's 🔍 in the viewer finds everything made with that value.
  await page.locator("#gallery-grid .tile").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  await page.locator(".param-row", { hasText: "Seed" }).locator(".param-find").click();
  await page.waitForTimeout(400);
  check("a setting's 🔍 searches the gallery for it", (await page.inputValue("#gallery-search")) === "seed=777" && (await page.locator("#gallery-grid .tile").count()) === 1, await page.inputValue("#gallery-search"));
  await search("", 2);

  // Select several, and file them together.
  await page.locator("#gallery-select").click();
  await page.locator("#gallery-grid .tile").nth(0).click();
  await page.locator("#gallery-grid .tile").nth(1).click();
  check("selecting counts", (await page.locator("#gallery-selcount").textContent()) === "2 selected");
  await page.locator("#sel-album").click();
  await page.fill("#album-new", "Keepers");
  await page.locator("#album-new-form button").click();
  await page.waitForTimeout(300);
  await page.locator("#sheet-albums .sheet-close").click();
  const inKeepers = (await readStores(page, ["gallery", "albums"]));
  const keepersId = inKeepers.albums.find((a) => a.name === "Keepers").id;
  check("both went into the new album", inKeepers.gallery.every((r) => r.albums.includes(keepersId)), JSON.stringify(inKeepers.gallery.map((r) => r.albums)));

  // Count eviction, under a limit set low enough to test. Seeded straight
  // into the stores: two hundred round trips through the UI would dominate the
  // suite's runtime, and what is under test is pruneGallery, which runs at boot.
  await page.evaluate(() => localStorage.setItem("patchbay_gallery_limits", JSON.stringify({ image: 200 })));
  await seedGallery(page, (i, now) => ({
    id: `seed-${String(i).padStart(3, "0")}`,
    createdAt: now - i * 1000, // seed-000 newest
    prompt: "seed " + i,
    // Past the cut, but named: kept anyway.
    name: i === 205 ? "keeper" : "",
  }), 210);
  await page.close();
  page = await open(context);
  await page.waitForTimeout(800);
  const after = await readStores(page, ["gallery", "galleryBytes"]);
  const kept = after.gallery.map((x) => x.prompt);
  check("unnamed images are capped at the set limit", kept.length === 201, String(kept.length));
  check(
    "the newest were kept and the oldest dropped",
    kept.includes("seed 0") && kept.includes("seed 199") && !kept.includes("seed 200"),
    kept.length + " items"
  );
  check("a named item past the limit is never removed by it", kept.includes("seed 205"));
  check("both halves were pruned together", after.galleryBytes.length === 201, String(after.galleryBytes.length));
  // The reopen comes back on the screen it was left on, the gallery.
  await page.locator("#tab-create").click();
  check("the strip shows the newest dozen", (await page.locator(".recent-strip .thumb").count()) === 12);
  await page.locator("#recent-open").click();
  await page.waitForFunction(() => document.querySelector("#gallery-count").textContent.startsWith("201"));
  check("and the gallery counts them all", (await page.locator("#gallery-count").textContent()).startsWith("201 items"));
  check("drawing them in pages rather than all at once", (await page.locator("#gallery-grid .tile").count()) <= 240);

  // Nothing expires by default; an age limit is a setting.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction("gallery", "readwrite");
          const st = tx.objectStore("gallery");
          const g = st.getAll();
          g.onsuccess = () => {
            for (const rec of g.result || []) {
              rec.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
              st.put(rec);
            }
          };
          tx.oncomplete = () => resolve();
        };
      })
  );
  await page.evaluate(() => localStorage.removeItem("patchbay_gallery_limits"));
  await page.close();
  page = await open(context);
  await page.waitForTimeout(600);
  check("by default nothing is removed for its age", (await readStores(page, ["gallery"])).gallery.length === 201);
  await page.evaluate(() => localStorage.setItem("patchbay_gallery_limits", JSON.stringify({ days: 7 })));
  await page.close();
  page = await open(context);
  await page.waitForTimeout(600);
  check("with an age limit set, older unnamed items go on the next load", (await readStores(page, ["gallery"])).gallery.length === 1);
  check("and the named one stays", (await page.locator(".recent-strip .thumb").count()) === 1);
  await page.evaluate(() => localStorage.removeItem("patchbay_gallery_limits"));

  // Clear removes the lot, from the gallery's ⚙.
  await page.locator("#tab-create").click();
  await page.selectOption("#model-select", "p-image");
  await gen("to be cleared");
  await page.locator("#tab-gallery").click();
  await page.locator("#gallery-settings").click();
  check("the settings say how much storage is used", (await page.locator("#storage-note").textContent()).length > 0);
  page.once("dialog", (d) => d.accept());
  await page.locator("#gallery-clear").click();
  await page.waitForTimeout(400);
  check("Clear empties the gallery", (await readStores(page, ["gallery"])).gallery.length === 0);
  check("and the strip", (await page.locator(".recent-strip .thumb").count()) === 0);
  await page.locator("#tab-create").click();

  // Clearing while a job runs must not look like it stopped the job, and an
  // archive write already in flight must not put an item back afterwards.
  await gen("something to clear later");
  await page.request.get(BASE + "__slow?on=1");
  await page.fill(promptSel, "a run that must survive a Clear");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#jobs-btn:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(2200);
  await page.locator("#tab-gallery").click();
  await page.locator("#gallery-settings").click();
  page.once("dialog", (d) => d.accept());
  await page.locator("#gallery-clear").click();
  await page.waitForTimeout(1500);
  check(
    "clearing does not write over a running job's status",
    /elapsed/.test(await page.locator("#status").textContent()),
    await page.locator("#status").textContent()
  );
  check("the run is still going", (await page.locator("#jobs-btn").textContent()).includes("running"));
  check("and the gallery did empty", (await readStores(page, ["gallery"])).gallery.length === 0);
  await page.request.get(BASE + "__slow?on=0");
  await page.waitForSelector("#status.ok", { timeout: 20000 });
  await page.waitForTimeout(600);
  check(
    "a result finishing after the Clear is still kept",
    (await readStores(page, ["gallery"])).gallery.length === 1
  );
  await page.close();
  await context.close();
}

// ── Reuse parameters puts back the files the run was given ─────────────────
// Restoring a setup used to keep whatever was attached, or drop it on a model
// switch, because the inputs were never stored with the result. They are now,
// once each however many runs use them.
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(200);
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "make it snow");
  await page.waitForTimeout(700);
  for (let i = 0; i < 2; i++) {
    await page.locator("#generate-btn").click();
    await page.waitForSelector("#status.ok");
    await page.waitForFunction((n) => document.querySelectorAll(".recent-strip .thumb").length === n, i + 1);
  }
  const st = await readStores(page, ["gallery", "galleryInputs"]);
  const refs = st.gallery.map((r) => r.inputs && r.inputs.images);
  check(
    "each item records its input by name and hash",
    refs.every((r) => r && r.length === 1 && r[0].name === "cat.png" && r[0].hash),
    JSON.stringify(refs)
  );
  check("and one image used by two runs is stored once", st.galleryInputs.length === 1, String(st.galleryInputs.length));

  // Somewhere else entirely, with nothing attached.
  await page.selectOption("#model-select", "flux-dev");
  await page.waitForTimeout(300);
  await page.fill(promptSel, "unrelated");
  await page.waitForTimeout(700);
  await page.close();
  page = await open(context);
  const uploadsBefore = (await (await fetch(BASE + "__uploads")).json()).uploadCount;
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  check("the viewer lists the input file", (await page.locator(".viewer-input").first().textContent()).includes("cat.png"));
  await page.locator("#viewer-reuse").click();
  await page.waitForFunction(() => (uploads.images || []).length === 1, null, { timeout: 5000 }).catch(() => {});
  check("Reuse parameters switches back to the model", (await page.inputValue("#model-select")) === "p-image-edit");
  check("puts the prompt back", (await page.inputValue(promptSel)) === "make it snow");
  const back = await page.evaluate(() => (uploads.images || []).map((u) => ({ isFile: u.file instanceof File, name: u.file.name, size: u.file.size })));
  check("and the image it was given", back.length === 1 && back[0].isFile && back[0].name === "cat.png" && back[0].size === 70, JSON.stringify(back));
  await page.waitForTimeout(400);
  const uploadsAfter = (await (await fetch(BASE + "__uploads")).json()).uploadCount;
  check("re-encoded for the provider, since last time's link has expired", uploadsAfter === uploadsBefore + 1, `${uploadsBefore} -> ${uploadsAfter}`);
  check("and says so", (await page.locator("#status").textContent()).includes("1 input file"), await page.locator("#status").textContent());

  // Deleting the items lets their stored inputs go.
  await page.locator("#tab-gallery").click();
  await page.locator("#gallery-select").click();
  await page.locator("#sel-all").click();
  page.once("dialog", (d) => d.accept());
  await page.locator("#sel-delete").click();
  await page.waitForTimeout(2500);
  check("inputs no item refers to are dropped", (await readStores(page, ["galleryInputs"])).galleryInputs.length === 0);
  await page.close();
  await context.close();
}

// ── A v1 database keeps its session when the gallery stores are added ──────
{
  const context = await browser.newContext();
  const page = await context.newPage();
  // Build the v1 database from a page that is same-origin but is NOT the app —
  // any unknown path answers 404 and runs no script — so nothing else is holding
  // a connection while the version is set.
  await page.goto(BASE + "__not-the-app");
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("patchbay", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("session");
        r.onerror = () => reject(new Error("could not create the v1 database"));
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction("session", "readwrite");
          tx.objectStore("session").put(
            { savedAt: Date.now(), modelId: "p-image", fields: { prompt: "written under v1" }, touched: [] },
            "meta"
          );
          tx.oncomplete = () => {
            db.close(); // so the app's upgrade is not blocked
            resolve();
          };
          tx.onerror = () => reject(new Error("could not write the v1 session"));
        };
      })
  );
  await page.close();

  const page2 = await open(context);
  check("a v1 session is restored after the upgrade", (await page2.inputValue(promptSel)) === "written under v1");
  const stores = await page2.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => resolve({ v: r.result.version, stores: [...r.result.objectStoreNames].sort() });
        r.onerror = () => resolve(null);
      })
  );
  check(
    "the database is at v4 with all six stores",
    stores && stores.v === 4 && stores.stores.join(",") === "albums,gallery,galleryBytes,galleryInputs,galleryThumbs,session",
    JSON.stringify(stores)
  );
  await page2.close();
  await context.close();
}

// ── A v2 gallery item is split across the stores, not dropped ──────────────
{
  const context = await browser.newContext();
  const page = await context.newPage();
  // Same trick as above: a same-origin page that is not the app.
  await page.goto(BASE + "__not-the-app");
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("patchbay", 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore("session");
          db.createObjectStore("gallery", { keyPath: "id" });
        };
        r.onerror = () => reject(new Error("could not create the v2 database"));
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction("gallery", "readwrite");
          // A v2 record: the image and the thumbnail sit inline, which is what
          // the upgrade has to move.
          tx.objectStore("gallery").put({
            id: "legacy-1",
            createdAt: Date.now(),
            modelId: "p-image",
            prompt: "made under v2",
            type: "image/png",
            bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
            thumb: new Uint8Array([9, 9, 9, 9]).buffer,
            thumbType: "image/jpeg",
            width: 4,
            height: 4,
            size: 8,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error("could not write the v2 item"));
        };
      })
  );
  await page.close();

  const page2 = await open(context);
  await page2.waitForTimeout(500);
  const st = await readStores(page2, ["gallery", "galleryBytes", "galleryThumbs"]);
  const rec = st.gallery.find((x) => x.id === "legacy-1");
  check(
    "the v2 item's image and thumbnail moved to their own stores, and nothing was dropped",
    rec && !("bytes" in rec) && !("thumb" in rec) && rec.prompt === "made under v2" &&
      st.galleryBytes.some((x) => x.id === "legacy-1" && x.bytes.__buf === 8) &&
      st.galleryThumbs.some((x) => x.id === "legacy-1" && x.buf.__buf === 4),
    JSON.stringify(st)
  );
  check("the migrated item still shows in the strip", (await page2.locator(".recent-strip .thumb").count()) === 1);
  // And it still opens, which is the only thing that proves the halves still
  // find each other.
  await page2.locator(".recent-strip .thumb").first().click();
  await page2.waitForSelector("#viewer:not(.hidden)");
  check("the migrated item still opens", (await page2.locator("#viewer-prompt").textContent()) === "made under v2");
  check("and says it has no recorded settings rather than showing none", (await page2.locator("#viewer-info").textContent()).includes("No settings were recorded"));
  await page2.close();
  await context.close();
}

// ── The viewer does not leak its full-size image ───────────────────────────
{
  const context = await browser.newContext();
  // Count object URLs the way PR #33's leak test did: instrument the two calls
  // and watch the live total.
  const page = await open(context, () => {
    window.__liveUrls = 0;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      window.__liveUrls++;
      return create(b);
    };
    URL.revokeObjectURL = (u) => {
      window.__liveUrls--;
      return revoke(u);
    };
  });

  await page.selectOption("#model-select", "p-image");
  await page.fill(promptSel, "leak check");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  await page.waitForFunction(() => !!document.querySelector(".recent-strip .thumb img[src^='blob:']"));
  await page.waitForTimeout(300);

  const before = await page.evaluate(() => window.__liveUrls);
  for (let i = 0; i < 4; i++) {
    await page.locator(".recent-strip .thumb").first().click();
    await page.waitForSelector("#viewer:not(.hidden)");
    await page.locator("#viewer-close").click();
    // Not waitForSelector: .hidden is display:none, so it never becomes visible.
    await page.waitForFunction(() => document.getElementById("viewer").classList.contains("hidden"));
  }
  const after = await page.evaluate(() => window.__liveUrls);
  check("opening and closing the viewer leaves no url behind", after === before, `${before} -> ${after}`);
  await page.close();
  await context.close();
}

// ── Every model in the catalogue renders ───────────────────────────────────
//
// Breadth rather than depth: selecting each of the 48 models in turn catches a
// field definition that throws while rendering, and confirms the undo buttons
// end up in a sane state on every one — including the five with no prompt field,
// which hold the history rather than dropping it.
{
  const context = await browser.newContext();
  const page = await open(context);
  const ids = await page.evaluate(() => MODELS.map((m) => m.id));
  const broken = [];
  const promptless = [];
  let sawPrompt = false;
  for (const id of ids) {
    await page.selectOption("#model-select", id);
    await page.waitForTimeout(25);
    const s = await page.evaluate(() => ({
      hasPrompt: Boolean(primaryPromptEl()),
      undoDisabled: document.getElementById("prompt-undo").disabled,
      redoDisabled: document.getElementById("prompt-redo").disabled,
      entries: promptHistory.length,
    }));
    if (!s.hasPrompt) {
      promptless.push(id);
      if (!s.undoDisabled || !s.redoDisabled) broken.push(`${id}: buttons live with no prompt field`);
      if (sawPrompt && s.entries === 0) broken.push(`${id}: dropped the history`);
    } else {
      sawPrompt = true;
      // Nothing has been typed, so a switch that carries empty text over must
      // not invent an entry to undo into.
      if (!s.undoDisabled) broken.push(`${id}: undo offered with nothing to undo`);
    }
  }
  check(`all ${ids.length} models render with sane undo state`, broken.length === 0, broken.join("; "));
  check("the promptless models are the five expected", promptless.length === 5, promptless.join(","));
  await page.close();
  await context.close();
}

// ── Phone layout ───────────────────────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await open(context);
  check("undo button visible on a phone viewport", await page.locator("#prompt-undo").isVisible());
  check("redo button visible on a phone viewport", await page.locator("#prompt-redo").isVisible());
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 390px", overflow <= 0, `overflow=${overflow}px`);
  const box = await page.locator("#prompt-undo").boundingBox();
  check("undo is a usable tap target", box.height >= 36 && box.width >= 60, JSON.stringify(box));
  const bar = await page.locator("#generate-btn").boundingBox();
  check("Generate is on screen without scrolling", bar && bar.y + bar.height <= 844, JSON.stringify(bar));
  // iOS draws a black single-letter tile when it cannot fetch the touch icon;
  // it is served under the tag's path and the conventional root names.
  for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
    const r = await page.request.get(new URL(path, BASE).href);
    check(`the touch icon is served at ${path}`, r.ok() && r.headers()["content-type"] === "image/png");
  }
  // Inline in the page: Safari's Add to Home Screen used the icon only once it
  // was a data: URI rather than a file.
  const touch = await page.evaluate(() => document.querySelector('link[rel="apple-touch-icon"]').getAttribute("href"));
  const file = Buffer.from(await (await page.request.get(new URL("/apple-touch-icon.png", BASE).href)).body());
  const inline = touch.startsWith("data:image/png;base64,") ? Buffer.from(touch.slice(22), "base64") : Buffer.alloc(0);
  check("the touch icon is inlined in the page as the same PNG", inline.length > 0 && inline.equals(file), touch.slice(0, 40));
  // No icon the page declares may be an SVG: one cannot become a Home Screen
  // icon, and iOS falls back to a letter tile.
  const icons = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => l.getAttribute("href"))
  );
  check(
    "every declared icon is a PNG, none an SVG",
    icons.length >= 2 && icons.every((h) => /\.png$/.test(h) || h.startsWith("data:image/png;")),
    JSON.stringify(icons.map((h) => h.slice(0, 40)))
  );
  // A share sheet fills its tile with the page's og:image, and otherwise puts
  // the touch icon on a white tile.
  const og = await page.evaluate(() => (document.querySelector('meta[property="og:image"]') || {}).content || "");
  const ogPath = og ? new URL(og).pathname : "";
  const ogRes = ogPath ? await page.request.get(new URL(ogPath, BASE).href) : null;
  check("a share preview image is declared, and its file is served", /^https:\/\//.test(og) && ogRes && ogRes.ok() && ogRes.headers()["content-type"] === "image/png", og);
  await page.close();
  await context.close();
}

// ── Video results are kept too ─────────────────────────────────────────────
// The stub answers a video model with PNG bytes under a video content type (it
// has no encoder). That is enough for everything under test here, and it puts
// the poster frame through videoThumb's "will not decode" branch, which has to
// leave the archive intact rather than fail it.
{
  const context = await browser.newContext();
  let page = await open(context);

  await page.selectOption("#model-select", "p-video-edit");
  await page.waitForTimeout(200);
  // p-video-edit needs its source clip before it will submit.
  const clipPath = join(dir, "clip.mp4");
  writeFileSync(clipPath, PNG);
  await page.setInputFiles(".file-input", clipPath);
  await page.fill(promptSel, "make it rain");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok", { timeout: 20000 });

  check("a video result renders as a player", (await page.locator(".result video").count()) === 1);
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0, null, { timeout: 15000 });

  const st = await readStores(page, ["gallery", "galleryBytes"]);
  const v = st.gallery[0] || {};
  check(
    "the video is archived, tagged as video, with no bytes in the metadata record",
    st.gallery.length === 1 && v.kind === "video" && v.modelId === "p-video-edit" && v.prompt === "make it rain" && !("bytes" in v),
    JSON.stringify(v)
  );
  check(
    "its bytes are an ArrayBuffer in the other store, under the same id",
    st.galleryBytes.length === 1 && st.galleryBytes[0].bytes.__buf > 0 && st.galleryBytes[0].id === v.id,
    JSON.stringify(st.galleryBytes)
  );
  check(
    "the settings that produced it ride along",
    v.setup && Object.keys(v.setup.fields).length > 0 && v.setup.fields.prompt === "make it rain",
    JSON.stringify(v.setup)
  );
  check("and the source clip it was given", v.inputs && v.inputs.video && v.inputs.video[0].name === "clip.mp4", JSON.stringify(v.inputs));
  check("the strip counts it as a video", (await page.locator("#recent-count").textContent()).includes("1 video"));
  check("and marks the tile", (await page.locator(".recent-strip .thumb-kind").count()) === 1);

  // Survives a reopen, and opens as a player rather than a broken image.
  await page.close();
  page = await open(context);
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length === 1);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  check("the viewer opens a kept clip as a video", (await page.locator("#viewer-media video").count()) === 1);
  check("and not as an image", (await page.locator("#viewer-media img").count()) === 0);
  await page.locator("#viewer-close").click();
  await page.waitForFunction(() => document.getElementById("viewer").classList.contains("hidden"));
  await page.close();
  await context.close();
}

// ── Each kind is capped on its own ─────────────────────────────────────────
// One clip outweighs a hundred images, so under a single shared count the
// clips would evict the stills. Seeded rather than generated.
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.evaluate(() => localStorage.setItem("patchbay_gallery_limits", JSON.stringify({ video: 25 })));
  await seedGallery(page, (i, now) =>
    i < 40
      ? { id: `vid-${String(i).padStart(3, "0")}`, createdAt: now - i * 1000, kind: "video", modelId: "p-video-edit", type: "video/mp4" }
      : { id: `img-${String(i).padStart(3, "0")}`, createdAt: now - i * 1000 }, 50);
  await page.close();
  page = await open(context);
  await page.waitForTimeout(800);
  const rows = (await readStores(page, ["gallery"])).gallery;
  const kept = { videos: rows.filter((x) => x.kind === "video").length, images: rows.filter((x) => x.kind !== "video").length };
  check("videos are capped at their own limit", kept.videos === 25, JSON.stringify(kept));
  check("and evicting them costs the images nothing", kept.images === 10, JSON.stringify(kept));
  await page.close();
  await context.close();
}

// ── Reuse parameters puts the options back, not just the prompt ────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "the original run");
  // A non-default option, so there is something to restore beyond the text.
  const seedSel = '[data-field="seed"]';
  await page.fill(seedSel, "4242");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);

  // Move everything away from what produced it.
  await page.selectOption("#model-select", "flux-dev");
  await page.waitForTimeout(300);
  await page.fill(promptSel, "something unrelated");
  await page.waitForTimeout(700);

  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  check("the viewer marks the setting that was changed", await page.locator(".param-row.changed", { hasText: "Seed" }).count() === 1);
  await page.locator("#viewer-reuse").click();
  await page.waitForTimeout(500);

  check("reusing switches back to the model that made it", (await page.inputValue("#model-select")) === "p-image");
  check("the prompt comes back", (await page.inputValue(promptSel)) === "the original run");
  check("and so does the option that was set", (await page.inputValue(seedSel)) === "4242");
  check(
    "the option is still marked as deliberately set",
    await page.evaluate(() => optionRows.some((r) => r.f.name === "seed" && r.touched))
  );
  // The flag is what decides whether a value equal to the default is still
  // sent, so a reuse that loses it changes the request.
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  const sent = await (await page.request.get(BASE + "__generate")).json();
  check("and the reused run sends what the original would have", sent.input && sent.input.seed === 4242, JSON.stringify(sent.input));
  await page.close();
  await context.close();
}

// ── Jobs run beside each other, and are never given up on ──────────────────
// A run used to hold Generate until it finished, and "Stop waiting" only left
// the record behind for the next load — which reopening did anyway. Now a job
// runs on its own: Generate is free once the provider has it, several can run
// at once, a failed check is retried rather than ending the run, and the
// record is kept until the result is.
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.request.get(BASE + "__slow?on=1");

  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "a job that runs a while");
  await page.waitForTimeout(700);
  check("no jobs chip before anything is running", await page.locator("#jobs-btn").isHidden());
  check("and no Stop waiting button any more", (await page.locator("#stop-btn").count()) === 0);

  await page.locator("#generate-btn").click();
  await page.waitForSelector("#jobs-btn:not(.hidden)", { timeout: 10000 });
  check("the chip says a job is running", (await page.locator("#jobs-btn").textContent()).includes("1 running"));
  await page.waitForFunction(() => !document.getElementById("generate-btn").disabled, null, { timeout: 5000 });
  check("Generate is free again once the provider has the job", await page.locator("#generate-btn").isEnabled());
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem("patchbay_jobs") || "[]"));
  check(
    "the job's record carries its prompt and settings, so a pick-up on load can be reused",
    recs.length === 1 && recs[0].prompt === "a job that runs a while" && recs[0].setup && recs[0].setup.fields,
    JSON.stringify(recs)
  );

  await page.fill(promptSel, "a second one beside it");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForFunction(() => document.getElementById("jobs-btn").textContent.includes("2 running"), null, { timeout: 5000 });
  check("a second job runs beside the first", true);

  await page.locator("#jobs-btn").click();
  await page.waitForSelector("#sheet-jobs:not(.hidden)");
  check("the tray lists both", (await page.locator("#jobs-list .job-row").count()) === 2);
  check("each with Check now and Forget", (await page.locator("#jobs-list .job-row button", { hasText: "Check now" }).count()) === 2);
  page.once("dialog", (d) => d.accept());
  await page.locator("#jobs-list .job-row", { hasText: "a second one beside it" }).locator("button", { hasText: "Forget" }).click();
  await page.waitForFunction(() => document.getElementById("jobs-btn").textContent.includes("1 running"), null, { timeout: 8000 });
  check("Forget stops tracking that one", true);
  check(
    "and drops its record, so the next load does not pick it up",
    (await page.evaluate(() => JSON.parse(localStorage.getItem("patchbay_jobs") || "[]"))).length === 1
  );
  await page.locator("#sheet-jobs .sheet-close").click();

  // The point of keeping the record: the next load collects the result.
  await page.request.get(BASE + "__slow?on=0");
  await page.close();
  page = await open(context);
  await page.waitForSelector("#status.ok", { timeout: 15000 });
  check("a job left running is picked up on the next load", (await page.locator("#status").textContent()).includes("Recovered"));
  check("and its result lands in the panel", (await page.locator(".result img").count()) === 1);
  check("the record is cleared once collected", (await page.evaluate(() => localStorage.getItem("patchbay_jobs"))) === null);
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  check("a picked-up job keeps its prompt in the gallery", (await page.locator("#viewer-prompt").textContent()) === "a job that runs a while", await page.locator("#viewer-prompt").textContent());
  check("and its settings", (await page.locator(".param-row").count()) > 0);
  await page.locator("#viewer-close").click();

  // A record written by an earlier version is still picked up.
  await page.request.get(BASE + "__slow?on=1");
  await page.fill(promptSel, "an old-style record");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("patchbay_jobs") || "[]")).length === 1, null, { timeout: 5000 });
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem("patchbay_jobs"))[0].id);
  await page.evaluate((id) => {
    localStorage.removeItem("patchbay_jobs");
    localStorage.setItem("pruna_inflight_job", JSON.stringify({ id, model: "p-image", kind: "image", startedAt: Date.now() }));
  }, id);
  await page.request.get(BASE + "__slow?on=0");
  await page.close();
  page = await open(context);
  await page.waitForSelector("#status.ok", { timeout: 15000 });
  check("a single record from an earlier version is picked up", (await page.locator("#status").textContent()).includes("Recovered"));
  check("and moved off the old key", (await page.evaluate(() => localStorage.getItem("pruna_inflight_job"))) === null);

  // Status checks that fail outright no longer end the run: they are retried.
  await page.request.get(BASE + "__statusfail?n=2");
  await page.fill(promptSel, "through a bad patch");
  await page.waitForTimeout(700);
  const seen = [];
  await page.locator("#generate-btn").click();
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    seen.push((await page.locator("#status").textContent()).trim());
    if (await page.locator("#status.ok, #status.err").count()) break;
    await page.waitForTimeout(300);
  }
  check("two failed status checks do not end the run", (await page.locator("#status.ok").count()) === 1, JSON.stringify(seen.slice(-3)));
  check("the wait says it is checking again", seen.some((s) => s.includes("checking again")), JSON.stringify(seen));
  await page.close();
  await context.close();
}

// ── Judge scores the bytes it already holds ────────────────────────────────
// The blobs were captured when the result rendered and then never read: every
// scoring re-downloaded them, which cost a second transfer and failed outright
// once the delivery URL had expired.
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "cf-flux-1-schnell");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "score this without fetching it again");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  // A Workers AI result is a data: URI, so it is never a Pruna file URL and
  // always has to be uploaded — which is the path that used to re-fetch first.
  const held = await page.evaluate(() => lastResult.blobs.filter(Boolean).length);
  check("the result's bytes are held after rendering", held === 1, String(held));

  const fetches = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/result")) fetches.push(r.url());
  });
  // The score button under the result is gone; the Lab card scores the image
  // on screen first.
  await page.locator("#tab-lab").click();
  await page.locator("#lab-judge").click();
  await page.waitForTimeout(1500);
  check("scoring re-reads nothing through /api/result", fetches.length === 0, fetches.join(", "));
  await page.close();
  await context.close();
}

// ── Describe captions; questions go to the chat ────────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(200);
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  const posted = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/describe") && r.method() === "POST") posted.push(JSON.parse(r.postData() || "{}"));
  });
  // On each gallery image now: the caption lands in the prompt box on Create.
  await page.fill(promptSel, "edit me");
  await page.waitForTimeout(700);
  await describeFromGallery(page);
  await page.waitForTimeout(900);
  check("a caption seeds the prompt, which is what captioning is for", (await page.inputValue(promptSel)) === "STUB CAPTION TEXT");
  check("Describe sends no question and no prompt", posted.length === 1 && !("question" in posted[0]) && !("prompt" in posted[0]), JSON.stringify(posted[0] && Object.keys(posted[0])));
  check("and goes back to Create so the caption is seen landing", (await page.locator("#viewer").isHidden()) && (await page.locator("#screen-create").isVisible()));
  check("the tool row has no Describe of its own any more", (await page.locator("#prompt-tools button", { hasText: "Describe" }).count()) === 0);

  // A model with no prompt box used to swallow a tool's tap without a word;
  // now it offers no prompt tools at all.
  await page.selectOption("#model-select", "p-image-rmbg");
  await page.waitForTimeout(300);
  check("a model with no prompt box offers no prompt tools", await page.locator("#prompt-tools").isHidden());
  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(300);
  check("and they come back with the next model that has one", await page.locator("#prompt-tools").isVisible());
  await page.close();
  await context.close();
}

// ── Chat ───────────────────────────────────────────────────────────────────
// A thread that remembers: every Send carries the whole conversation, the
// thread survives a reload, and a reply can become the prompt as one Undo.
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(200);
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "a neon cat on a rooftop");
  await page.waitForTimeout(700);

  let generates = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/generate")) generates++;
  });
  await page.locator("#tab-lab").click();
  check("the attached image has a chip, ticked to start", (await page.locator(".chat-chip.on").count()) === 1);
  await page.click("#chat-input");
  await page.keyboard.type("first line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  await page.waitForTimeout(300);
  check("Enter in the chat box starts a new line", (await page.inputValue("#chat-input")) === "first line\nsecond line");
  check("and sends nothing", generates === 0 && (await page.locator(".chat-msg").count()) === 0);

  await page.locator("#chat-send").click();
  await page.waitForSelector(".chat-msg.assistant:not(.pending)");
  let sent = await (await page.request.get(BASE + "__chat")).json();
  check("Send delivers the message", sent.messages.length === 1 && sent.messages[0].content === "first line\nsecond line", JSON.stringify(sent.messages));
  check("with the prompt box text", sent.prompt === "a neon cat on a rooftop", JSON.stringify(sent.prompt));
  check(
    "and the ticked image, for a model that can see",
    Array.isArray(sent.images) && sent.images.length === 1 && sent.images[0].b64.length > 0,
    JSON.stringify(sent.images && sent.images.map((i) => i.mime))
  );
  check("after Send the image chip unticks", (await page.locator(".chat-chip.on").count()) === 0);
  check("the reply appears in the thread", (await page.locator(".chat-msg.assistant .chat-text").first().textContent()) === "STUB REPLY 1");
  check("with what it cost", (await page.locator(".chat-cost").first().textContent()).includes("12"));
  check("the input box is cleared for the next message", (await page.inputValue("#chat-input")) === "");

  await page.fill("#chat-input", "shorter please");
  await page.locator("#chat-send").click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-msg.assistant:not(.pending)").length === 2);
  sent = await (await page.request.get(BASE + "__chat")).json();
  check(
    "the second message carries the whole thread, so the model remembers",
    sent.messages.length === 3 && sent.messages[1].role === "assistant" && sent.messages[1].content === "STUB REPLY 1",
    JSON.stringify(sent.messages.map((m) => m.role))
  );
  check("but not the image, which was unticked", !("images" in sent) && sent.prompt === "a neon cat on a rooftop", JSON.stringify(Object.keys(sent)));

  await page.locator(".chat-use").last().click();
  await page.waitForTimeout(200);
  check("Put in prompt box replaces the prompt with the reply", (await page.inputValue(promptSel)) === "STUB REPLY 2");
  check("and goes to Create so the prompt is in view", await page.locator("#screen-create").isVisible());
  await page.locator("#prompt-undo").click();
  check("and Undo brings the old prompt back", (await page.inputValue(promptSel)) === "a neon cat on a rooftop");

  await page.locator("#tab-lab").click();
  await page.uncheck("#chat-prompt");
  await page.fill("#chat-input", "no context this time");
  await page.locator("#chat-send").click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-msg.assistant:not(.pending)").length === 3);
  sent = await (await page.request.get(BASE + "__chat")).json();
  check("with the prompt box unticked and no image ticked, neither is sent", !("prompt" in sent) && !("images" in sent), JSON.stringify(Object.keys(sent)));
  await page.check("#chat-prompt");

  await page.selectOption("#chat-model", "@cf/meta/llama-3.2-3b-instruct");
  await page.waitForTimeout(150);
  check("a model that cannot see says so while an image is attached", (await page.locator("#chat-note").textContent()).includes("can't see images"));

  await page.close();
  page = await open(context);
  check("the thread survives a reload", (await page.locator(".chat-msg").count()) === 6, `${await page.locator(".chat-msg").count()} messages`);
  page.once("dialog", (d) => d.accept());
  await page.locator("#tab-lab").click();
  await page.locator("#chat-new").click();
  await page.waitForTimeout(150);
  check("New chat clears it", (await page.locator(".chat-msg").count()) === 0);
  await page.close();
  await context.close();
}

// ── The elapsed count runs during the generation, not after it ─────────────
// Fourteen models have no job to poll: Workers AI and xAI's image endpoints run
// the whole generation inside /api/generate and answer with the finished
// picture. Nothing drove the status line for that entire window, so it held
// "Submitting…" — no count at all — and then jumped straight to the finished
// time, which on a slow model is indistinguishable from a hang.
{
  const context = await browser.newContext();
  const page = await open(context);
  const sample = async (n, everyMs) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      await page.waitForTimeout(everyMs);
      seen.push((await page.locator("#status").textContent()).trim());
    }
    return seen;
  };
  const elapsed = (lines) =>
    lines.map((s) => (s.match(/(\d+)s elapsed/) || [])[1]).filter((v) => v !== undefined).map(Number);

  await page.request.get(BASE + "__delay?ms=4000");
  await page.selectOption("#model-select", "cf-flux-1-schnell");
  await page.waitForTimeout(250);
  await page.fill(promptSel, "count while you work");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();

  const during = await sample(6, 500);
  const ticks = elapsed(during);
  check("a synchronous model reports progress while it runs", ticks.length >= 4, JSON.stringify(during));
  check("and the count actually advances", ticks.length > 0 && ticks[ticks.length - 1] > ticks[0], ticks.join(","));
  check(
    "named as generating rather than submitting, because that is what it is doing",
    during.every((s) => s.startsWith("Generating")),
    JSON.stringify(during[0])
  );

  await page.waitForSelector("#status.ok", { timeout: 15000 });
  const settled = (await page.locator("#status").textContent()).trim();
  await page.waitForTimeout(2500);
  check(
    "the ticker stops once the run finishes",
    (await page.locator("#status").textContent()).trim() === settled,
    settled
  );

  // Continuity: a polled model spends a moment submitting and the rest being
  // polled. Two clocks would send the count back to zero at the handover.
  await page.request.get(BASE + "__slow?on=1");
  await page.request.get(BASE + "__delay?ms=2500");
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(250);
  await page.fill(promptSel, "one clock, not two");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();

  const across = await sample(12, 600);
  const run = elapsed(across);
  check(
    "the count never restarts when polling takes over",
    run.length > 2 && run.every((n, i) => i === 0 || n >= run[i - 1]),
    run.join(",")
  );
  check(
    "and the wording follows the stage",
    across.some((s) => s.startsWith("Submitting")) && across.some((s) => s.startsWith("Processing")),
    JSON.stringify(across)
  );

  // Let that run finish before starting another — Generate is held until it does.
  await page.request.get(BASE + "__delay?ms=0");
  await page.request.get(BASE + "__slow?on=0");
  await page.waitForSelector("#status.ok", { timeout: 20000 });

  // A stalled poll must not stall the clock. The line used to be written only
  // when a poll came back, so a slow provider, a hung connection or a suspended
  // iOS tab left it frozen at whatever it last said — reading eight seconds
  // after three real minutes, which says the job has barely started.
  await page.request.get(BASE + "__statusdelay?ms=9000");
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(250);
  await page.fill(promptSel, "a poll that hangs");
  await page.waitForTimeout(700);
  const t0 = Date.now();
  await page.locator("#generate-btn").click();

  const drifts = [];
  for (let i = 0; i < 7; i++) {
    await page.waitForTimeout(1000);
    const shown = elapsed([(await page.locator("#status").textContent()).trim()])[0];
    if (shown !== undefined) drifts.push(Math.round((Date.now() - t0) / 1000) - shown);
  }
  check(
    "the count keeps up while a poll hangs",
    drifts.length >= 5 && Math.max(...drifts) <= 2,
    `worst drift ${drifts.length ? Math.max(...drifts) : "n/a"}s from ${JSON.stringify(drifts)}`
  );

  // Leave the stub as the other blocks expect to find it.
  await page.request.get(BASE + "__statusdelay?ms=0");
  await page.waitForSelector("#status.ok", { timeout: 25000 });
  check(
    "and the finished message is not overwritten by a late tick",
    await (async () => {
      const done = (await page.locator("#status").textContent()).trim();
      await page.waitForTimeout(2200);
      return (await page.locator("#status").textContent()).trim() === done;
    })()
  );
  await page.close();
  await context.close();
}

// ── A status check that never answers is dropped and asked again ───────────
// No request on the generation path had a deadline, so a poll the connection
// swallowed held the whole run for as long as the OS kept it open — with the
// counter still climbing, indistinguishable from a slow provider.
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(250);
  await page.fill(promptSel, "a poll that never answers");
  await page.waitForTimeout(700);
  await page.request.get(BASE + "__statushang?n=1");
  const seen = [];
  const t0 = Date.now();
  await page.locator("#generate-btn").click();
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const line = (await page.locator("#status").textContent()).trim();
    if (!seen.includes(line.replace(/\d+s/, "Ns"))) seen.push(line.replace(/\d+s/, "Ns"));
    if (await page.locator("#status.ok, #status.err").count()) break;
    await page.waitForTimeout(250);
  }
  const took = Date.now() - t0;
  check("a hung status check does not hold the run", await page.locator("#status.ok").count() === 1, JSON.stringify(seen));
  check("it is abandoned at its deadline, not the OS's", took >= 7500 && took < 14000, `${took} ms`);
  check("and the wait says it is reconnecting", seen.some((s) => /^Reconnecting \(1\/3\)/.test(s)), JSON.stringify(seen));
  const rec = await page.evaluate(() => (JSON.parse(localStorage.getItem("patchbay_timings")) || []).pop() || null);
  const first = rec && rec.polls[0];
  check(
    "the timing record shows the timed-out attempt",
    !!first && first.attempts[0].outcome === "timeout" && first.attempts[1].outcome === "ok",
    JSON.stringify(first)
  );
  await page.request.get(BASE + "__statushang?n=0");
  await page.close();
  await context.close();
}

// ── The count runs through the download, and no token call precedes it ────
{
  const context = await browser.newContext();
  // The gate on, as in production: that is the only case in which a token
  // exists to be fetched at all.
  await context.route("**/api/config", async (route) => {
    const res = await route.fetch();
    const cfg = await res.json();
    await route.fulfill({ response: res, json: { ...cfg, authRequired: true } });
  });
  // Every token handed out is already inside its refresh margin, so any code
  // that asks for a live token before the download would have to fetch one.
  await context.route("**/api/token", (route) =>
    route.fulfill({ json: { token: "stub-token", expiresAt: Date.now() + 30000 } })
  );
  const page = await open(context, () => localStorage.setItem("pruna_app_password", "stub"));
  const order = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (p === "/api/status" || p === "/api/token" || p === "/api/result") order.push(p);
  });
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(250);
  await page.fill(promptSel, "watch the download");
  await page.waitForTimeout(700);
  await page.request.get(BASE + "__resultdelay?ms=3500");
  const lines = [];
  const t0 = Date.now();
  await page.locator("#generate-btn").click();
  while (Date.now() - t0 < 15000) {
    lines.push((await page.locator("#status").textContent()).trim());
    if (await page.locator("#status.ok, #status.err").count()) break;
    await page.waitForTimeout(400);
  }
  await page.request.get(BASE + "__resultdelay?ms=0");
  const dl = lines.filter((s) => s.startsWith("Downloading")).map((s) => Number((s.match(/(\d+)s elapsed/) || [])[1]));
  check("the count keeps running while the result downloads", dl.length >= 3 && dl[dl.length - 1] > dl[0], JSON.stringify(dl));
  const done = Number(((await page.locator("#status").textContent()).match(/Done in (\d+)s/) || [])[1]);
  check("and Done includes the download", done >= 3, String(done));
  const lastPoll = order.lastIndexOf("/api/status");
  check(
    "no token request sits between the last poll and the result",
    lastPoll >= 0 && order[lastPoll + 1] === "/api/result" && !order.slice(lastPoll).includes("/api/token"),
    order.join(" → ")
  );

  // The breakdown under the result.
  const summary = (await page.locator(".timing summary").textContent()).trim();
  check("a timing line sits under the result", summary.startsWith("Timing") && /download/.test(summary), summary);
  await page.locator(".timing summary").click();
  const rows = await page.locator(".timing li").allTextContents();
  for (const want of ["Submit:", "Provider states first seen:", "Status checks:", "Download:", "Visible at", "Saved to gallery at", "App in background:"]) {
    check(`the breakdown has "${want}"`, rows.some((r) => r.startsWith(want)), JSON.stringify(rows));
  }
  const rec = await page.evaluate(() => JSON.parse(localStorage.getItem("patchbay_timings")).pop());
  check(
    "the recorded steps are in order",
    rec.submit.returned <= rec.states.succeeded && rec.states.succeeded <= rec.downloads[0].start && rec.visible <= rec.saved,
    JSON.stringify({ submit: rec.submit, states: rec.states, dl: rec.downloads[0] && rec.downloads[0].start, visible: rec.visible, saved: rec.saved })
  );
  check("the download leg is at least the held time", rec.downloads[0].ms >= 3400, String(rec.downloads[0].ms));

  // History is capped.
  await page.evaluate(() => {
    const many = Array.from({ length: 30 }, (_, i) => ({ at: String(i) }));
    localStorage.setItem("patchbay_timings", JSON.stringify(many));
  });
  await page.fill(promptSel, "one more run");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok", { timeout: 15000 });
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("patchbay_timings")).length);
  check("no more than 20 runs are kept", kept === 20, String(kept));
  await page.close();
  await context.close();
}

// ── ⚙ settings for Improve and the chat ────────────────────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await pickImprove(page, "@cf/zai-org/glm-5.3");
  await page.locator("#improve-settings").click();
  check("⚙ opens the settings for the picked model", (await page.locator("#tool-settings h3").textContent()).includes("GLM 5.3"));
  check("the instruction starts as the default", (await page.inputValue(".settings-system")) === "DEFAULT IMPROVE INSTRUCTION");
  check("a model with thinking offers the switch", (await page.locator(".settings-thinking").count()) === 1 && (await page.locator(".settings-effort").count()) === 1);
  check("and effort shows its built-in default", (await page.locator(".settings-effort option").first().textContent()).includes("low"));
  check(
    "effort offers only the values Cloudflare lists for the model",
    JSON.stringify(await page.locator(".settings-effort option").allTextContents()) === JSON.stringify(["Default (low)", "Low", "High", "Max"]),
    JSON.stringify(await page.locator(".settings-effort option").allTextContents())
  );
  check("the exact model id is shown", (await page.locator("#tool-settings .model-id").textContent()) === "@cf/zai-org/glm-5.3");

  await page.fill(".settings-system", "Rewrite it as a haiku.");
  check("an edited instruction is a draft until saved", (await page.locator(".settings-dirty").textContent()).includes("Not saved"));
  await page.locator("#tool-settings .instr-save").click();
  check("Save makes it the one sent", (await page.locator(".settings-dirty").textContent()).includes("Saved"));
  await page.fill(".settings-tokens", "900");
  await page.selectOption(".settings-thinking", "off");
  await page.selectOption(".settings-effort", "high");
  check("the cost of the limit is shown", (await page.locator("#tool-settings .settings-cost").textContent()).includes("360"));
  check("the ⚙ marks a customised model", await page.locator("#improve-settings").evaluate((el) => el.classList.contains("custom")));

  await page.locator("#sheet-tools .sheet-close").click();
  await closeOptions(page);
  await page.fill(promptSel, "a cat");
  await page.waitForTimeout(700);
  await page.locator("#prompt-improve").click();
  await page.waitForTimeout(500);
  const sent = await (await page.request.get(BASE + "__improve")).json();
  check(
    "Improve sends the settings",
    JSON.stringify(sent.settings) === JSON.stringify({ system: "Rewrite it as a haiku.", maxTokens: 900, thinking: false, effort: "high" }),
    JSON.stringify(sent.settings)
  );
  check("and the prompt text only", !("kind" in sent) && !("hasImage" in sent), JSON.stringify(Object.keys(sent)));

  await pickImprove(page, "@cf/meta/llama-3.2-3b-instruct");
  await page.waitForTimeout(150);
  await page.locator("#improve-settings").click();
  check("a model without thinking says so", (await page.locator(".settings-thinking").count()) === 0 && (await page.locator("#tool-settings").textContent()).includes("no thinking"));
  check("the instruction is shared by the tool's models", (await page.inputValue(".settings-system")) === "Rewrite it as a haiku.");
  check("the token limit belongs to the other model", (await page.inputValue(".settings-tokens")) === "");

  await page.close();
  page = await open(context);
  await pickImprove(page, "@cf/zai-org/glm-5.3");
  await page.locator("#improve-settings").click();
  check("settings survive a reload", (await page.inputValue(".settings-tokens")) === "900");
  await page.locator("#tool-settings button", { hasText: "Reset GLM 5.3 limits" }).click();
  check("resetting the model's limits leaves the instruction alone", (await page.inputValue(".settings-tokens")) === "" && (await page.inputValue(".settings-system")) === "Rewrite it as a haiku.");

  // Undo inside the instruction, then Revert, then Load default.
  await page.locator(".settings-system").pressSequentially(" Short.", { delay: 10 });
  await page.waitForTimeout(700);
  await page.locator("#tool-settings .instr-undo").click();
  check("the instruction has its own Undo", (await page.inputValue(".settings-system")) === "Rewrite it as a haiku.");
  await page.locator("#tool-settings .instr-default").click();
  check("Load default only fills the draft", (await page.inputValue(".settings-system")) === "DEFAULT IMPROVE INSTRUCTION" && (await page.locator(".settings-dirty").textContent()).includes("Not saved"));
  await page.locator("#tool-settings .instr-revert").click();
  check("Revert puts the saved text back", (await page.inputValue(".settings-system")) === "Rewrite it as a haiku.");
  await page.locator("#tool-settings .instr-default").click();
  await page.locator("#tool-settings .instr-save").click();
  check("saving the default puts the defaults back", (await page.inputValue(".settings-system")) === "DEFAULT IMPROVE INSTRUCTION");
  check("and the ⚙ is plain again", !(await page.locator("#improve-settings").evaluate((el) => el.classList.contains("custom"))));
  await page.selectOption(".settings-versions", { index: 1 });
  check("the replaced instruction is one pick away", (await page.inputValue(".settings-system")) === "Rewrite it as a haiku.");

  // Closing over an unsaved draft asks first.
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#sheet-tools .sheet-close").click();
  check("an unsaved draft keeps the sheet open when the question is declined", await page.locator("#sheet-tools").isVisible());
  page.once("dialog", (d) => d.accept());
  await page.locator("#sheet-tools .sheet-close").click();
  check("and is discarded when it is accepted", await page.locator("#sheet-tools").isHidden());
  await page.locator("#improve-settings").click();
  check("so the saved instruction is what shows next time", (await page.inputValue(".settings-system")) === "DEFAULT IMPROVE INSTRUCTION");

  // Every tool on the same rows.
  const rows = [];
  for (const tab of await page.locator(".tool-tab").all()) {
    await tab.click();
    rows.push((await page.locator(".tool-row-name").allTextContents()).slice(0, 5).join("|"));
  }
  check(
    "every tool is described on the same five rows",
    rows.length === 8 && rows.every((r) => r.toLowerCase() === "model|reads|instruction|limits|writes to"),
    JSON.stringify(rows)
  );
  await page.locator(".tool-tab", { hasText: "Describe" }).click();
  check("Describe's instruction is editable now, from its own default", (await page.inputValue(".settings-system")) === "DEFAULT DESCRIBE INSTRUCTION");
  await page.fill(".settings-system", "Name the colours only.");
  await page.locator("#tool-settings .instr-save").click();
  await page.locator("#sheet-tools .sheet-close").click();
  await closeOptions(page);
  await describeFromGallery(page);
  await page.waitForFunction((s) => document.querySelector(s).value === "STUB CAPTION TEXT", promptSel);
  const described = await (await page.request.get(BASE + "__describe")).json();
  check("and Describe sends it", described.settings && described.settings.system === "Name the colours only.", JSON.stringify(described.settings));

  await page.locator("#tab-lab").click();
  await page.locator("#chat-settings").click();
  check("the chat's ⚙ opens its own settings", (await page.inputValue(".settings-system")) === "DEFAULT CHAT INSTRUCTION");
  await page.fill(".settings-tokens", "300");
  await page.locator("#sheet-tools .sheet-close").click();
  await page.fill("#chat-input", "hi");
  await page.locator("#chat-send").click();
  await page.waitForSelector(".chat-msg.assistant:not(.pending)");
  const chatSent = await (await page.request.get(BASE + "__chat")).json();
  check("the chat sends its settings", chatSent.settings && chatSent.settings.maxTokens === 300, JSON.stringify(chatSent.settings));
  await page.close();
  await context.close();
}

// ── Translate, 🎤 and Other ─────────────────────────────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "a lighthouse at dusk");
  await page.waitForTimeout(700);
  // Translate is a Lab card now; it rewrites the prompt box on Create.
  await page.locator("#tab-lab").click();
  await page.selectOption("#translate-to", "fr");
  await page.locator("#prompt-translate").click();
  await page.waitForSelector("#status.ok");
  check("Translate replaces the prompt box", (await page.inputValue(promptSel)) === "[fr] a lighthouse at dusk", await page.inputValue(promptSel));
  await page.locator("#tab-create").click();
  await page.locator("#prompt-undo").click();
  check("and Undo brings the original back", (await page.inputValue(promptSel)) === "a lighthouse at dusk");

  // No microphone in a headless browser, so the file path stands in for it.
  await page.setInputFiles("#chat-audio-file", { name: "speech.m4a", mimeType: "audio/mp4", buffer: Buffer.from("fake audio") });
  await page.waitForFunction(() => document.querySelector("#chat-input").value.length > 0);
  check("a recording is transcribed into the chat box, not sent", (await page.inputValue("#chat-input")) === "STUB TRANSCRIPT" && (await page.locator(".chat-msg").count()) === 0);
  let sent = await (await page.request.get(BASE + "__tool")).json();
  check("with the default speech model", sent.body.model === "@cf/openai/whisper-large-v3-turbo" && sent.body.mime === "audio/mp4", JSON.stringify(sent.body).slice(0, 120));

  await page.locator("#tab-lab").click();
  await page.locator("#chat-settings").click();
  await page.selectOption(".settings-stt", "@cf/deepgram/nova-3");
  await page.setInputFiles("#chat-audio-file", { name: "b.webm", mimeType: "audio/webm", buffer: Buffer.from("x") });
  await page.waitForFunction(() => document.querySelector("#chat-input").value.includes("STUB TRANSCRIPT STUB TRANSCRIPT"));
  sent = await (await page.request.get(BASE + "__tool")).json();
  check("the speech model follows the chat's ⚙ setting, and text is appended", sent.body.model === "@cf/deepgram/nova-3");

  await page.locator("#sheet-tools .sheet-close").click();
  await page.locator("#tab-lab").click();
  check("Lab holds what is not part of making a picture", await page.locator("#other").isVisible() && (await page.locator("#generate-btn").isHidden()));
  await page.locator("#other > summary").click();
  await page.selectOption("#other-tool", "sentiment");
  await page.locator("#other-use-prompt").click();
  check("Use prompt box copies the prompt in", (await page.inputValue("#other-text")) === "a lighthouse at dusk");
  await page.locator("#other-run").click();
  await page.waitForFunction(() => document.querySelector("#other-result").textContent.includes("POSITIVE"));
  check("sentiment shows labels, best first", (await page.locator("#other-result").textContent()).startsWith("POSITIVE — 99.0%"));

  await page.selectOption("#other-tool", "rerank");
  check("rerank asks for passages", await page.locator("#other-passages").isVisible());
  await page.fill("#other-text", "a fox");
  await page.fill("#other-passages", "tax deadlines\na red fox");
  await page.locator("#other-run").click();
  await page.waitForFunction(() => document.querySelector("#other-result").textContent.includes("a red fox"));
  check("rerank lists the passages in ranked order", (await page.locator("#other-result").textContent()).startsWith("1. 90.0% — a red fox"));
  await page.close();
  await context.close();
}

// ── Chat images: a chip each, unticked after Send; Cancel; silence ─────────
// Workers AI keeps nothing between calls, so an image goes with a message only
// when it is ticked; every Send unticks them. A reply that never comes used to
// leave Send disabled until a reload.
{
  const context = await browser.newContext();
  const page = await open(context, () => {
    window.__TEST_IDLE_MS = 1500;
  });
  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(200);
  const second = join(dir, "second.png");
  writeFileSync(second, PNG);
  await page.setInputFiles(".file-input", [imgPath, second]);
  await page.waitForFunction(() => document.querySelectorAll(".section-inputs .thumbs .thumb img").length === 2);
  await page.locator("#tab-lab").click();
  check("one chip per attached image, ticked to start", (await page.locator(".chat-chip").count()) === 2 && (await page.locator(".chat-chip.on").count()) === 2);

  await page.fill("#chat-input", "compare these");
  await page.locator("#chat-send").click();
  await page.waitForSelector(".chat-msg.assistant:not(.pending)");
  let sent = await (await page.request.get(BASE + "__chat")).json();
  check("both images go, each on its own", Array.isArray(sent.images) && sent.images.length === 2, JSON.stringify(sent.images && sent.images.length));
  check("the thread says which images a message carried", (await page.locator(".chat-sent-images").first().textContent()).includes("1, 2"));
  check("every chip unticks after Send", (await page.locator(".chat-chip.on").count()) === 0);
  check("the reply streamed in whole", (await page.locator(".chat-msg.assistant .chat-text").last().textContent()) === "STUB REPLY 1");

  await page.locator(".chat-chip").nth(1).click();
  await page.fill("#chat-input", "and the second one?");
  await page.locator("#chat-send").click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-msg.assistant:not(.pending)").length === 2);
  sent = await (await page.request.get(BASE + "__chat")).json();
  check("a re-ticked image goes again, and only that one", Array.isArray(sent.images) && sent.images.length === 1, JSON.stringify(sent.images && sent.images.length));

  await page.request.get(BASE + "__chatstall?on=1");
  await page.fill("#chat-input", "are you there?");
  await page.locator("#chat-send").click();
  await page.waitForTimeout(300);
  check("while a reply is on its way, Send is Cancel", (await page.locator("#chat-send").textContent()) === "Cancel");
  await page.locator("#chat-send").click();
  await page.waitForFunction(() => document.querySelector("#chat-send").textContent === "Send", null, { timeout: 5000 });
  check("Cancel puts the message back in the box", (await page.inputValue("#chat-input")) === "are you there?");
  check("and says it was cancelled", (await page.locator("#chat-note").textContent()).includes("Cancelled"));
  check("and the thread holds only answered messages", (await page.locator(".chat-msg").count()) === 4);

  await page.locator("#chat-send").click();
  await page.waitForFunction(() => document.querySelector("#chat-send").textContent === "Send", null, { timeout: 8000 });
  check(
    "silence ends the wait with a message instead of hanging",
    /connection looks lost/.test(await page.locator("#chat-note").textContent()),
    await page.locator("#chat-note").textContent()
  );
  check("with the message back in the box to send again", (await page.inputValue("#chat-input")) === "are you there?");
  await page.request.get(BASE + "__chatstall?on=0");
  await page.close();
  await context.close();
}

// ── Every vision model is in the chat; the two that can work on text alone
//    are in Improve too ─────────────────────────────────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  const improveIds = await page.locator("#improve-model option").evaluateAll((os) => os.map((o) => o.value));
  check(
    "Improve offers Llama 3.2 Vision and Moondream",
    improveIds.includes("@cf/meta/llama-3.2-11b-vision-instruct") && improveIds.includes("@cf/moondream/moondream3.1-9B-A2B")
  );
  check("but not LLaVA, which cannot run without an image", !improveIds.includes("@cf/llava-hf/llava-1.5-7b-hf"));
  const chatOpts = await page.locator("#chat-model option").evaluateAll((os) => os.map((o) => o.textContent));
  check("the chat offers all nine vision models, marked as such", chatOpts.filter((t) => t.includes("(vision)")).length === 9, JSON.stringify(chatOpts.filter((t) => t.includes("(vision)"))));

  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(200);
  await page.locator("#tab-lab").click();
  await page.selectOption("#chat-model", "@cf/llava-hf/llava-1.5-7b-hf");
  await page.fill("#chat-input", "what is this?");
  await page.locator("#chat-send").click();
  await page.waitForTimeout(300);
  check(
    "LLaVA with no image says so and sends nothing",
    (await page.locator("#chat-note").textContent()).includes("needs an image") && (await page.locator(".chat-msg").count()) === 0,
    await page.locator("#chat-note").textContent()
  );
  await page.locator("#tab-create").click();
  const other = join(dir, "other.png");
  writeFileSync(other, PNG);
  await page.setInputFiles(".file-input", [imgPath, other]);
  await page.waitForFunction(() => document.querySelectorAll(".section-inputs .thumbs .thumb img").length === 2);
  await page.locator("#tab-lab").click();
  check("two ticked images for a one-image model are to be combined", (await page.locator("#chat-note").textContent()).includes("combined"));
  await page.locator("#chat-send").click();
  await page.waitForSelector(".chat-msg.assistant:not(.pending)");
  const sent = await (await page.request.get(BASE + "__chat")).json();
  check(
    "and go as one picture",
    Array.isArray(sent.images) && sent.images.length === 1 && sent.images[0].mime === "image/jpeg",
    JSON.stringify(sent.images && sent.images.map((i) => i.mime))
  );
  check("while the thread still names both", (await page.locator(".chat-sent-images").first().textContent()).includes("1, 2"));
  await page.close();
  await context.close();
}

// ── Sampling settings follow each model's schema ───────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await pickImprove(page, "@cf/meta/llama-3.2-3b-instruct");
  await page.locator("#improve-settings").click();
  const all = ["temperature", "top_p", "top_k", "seed", "repetition_penalty", "frequency_penalty", "presence_penalty"];
  check("a Llama model offers every sampling setting its schema takes", JSON.stringify(await page.locator(".sampling-name").allTextContents()) === JSON.stringify(all));
  check("with the schema's default as the placeholder", (await page.getAttribute(".settings-temperature", "placeholder")) === "default 0.6");
  check("and a parameter whose default Cloudflare does not publish says so", (await page.getAttribute(".settings-top-p", "placeholder")) === "default not published");
  await page.selectOption("#improve-model", "@cf/openai/gpt-oss-20b");
  await page.waitForTimeout(150);
  check("effort shows the default Cloudflare documents for the model", (await page.locator(".settings-effort option").first().textContent()) === "Default (medium)");
  await page.selectOption("#improve-model", "@cf/zai-org/glm-5.3");
  await page.waitForTimeout(150);
  check(
    "and where Patchbay sends another effort, says both",
    (await page.locator("#tool-settings").textContent()).includes("Patchbay sends low") && (await page.locator("#tool-settings").textContent()).includes("own default for this model is max")
  );
  await page.selectOption("#improve-model", "@cf/meta/llama-3.2-3b-instruct");
  await page.waitForTimeout(150);
  await page.fill(".settings-temperature", "0.3");
  await page.fill(".settings-top-k", "12");
  await page.fill(".settings-top-p", "7");
  check("a value outside the documented range is flagged", await page.locator(".settings-top-p").evaluate((el) => el.classList.contains("invalid")));
  await page.locator("#sheet-tools .sheet-close").click();
  await closeOptions(page);
  await page.fill(promptSel, "a cat");
  await page.waitForTimeout(700);
  await page.locator("#prompt-improve").click();
  await page.waitForTimeout(500);
  const sent = await (await page.request.get(BASE + "__improve")).json();
  check(
    "and the valid ones are sent, the invalid one withheld",
    sent.settings.temperature === 0.3 && sent.settings.top_k === 12 && !("top_p" in sent.settings),
    JSON.stringify(sent.settings)
  );
  await pickImprove(page, "@cf/zai-org/glm-5.3");
  await page.locator("#improve-settings").click();
  const glm = await page.locator(".sampling-name").allTextContents();
  check("GLM 5.3 offers only what its schema takes", !glm.includes("top_k") && !glm.includes("repetition_penalty") && glm.includes("temperature"), JSON.stringify(glm));
  await page.locator("#sheet-tools .sheet-close").click();
  await pickImprove(page, "@cf/meta/llama-3.1-8b-fast-v2");
  await page.locator("#improve-settings").click();
  check("a model with no published schema says so", (await page.locator("#tool-settings").textContent()).includes("no input schema"));
  await page.locator("#sheet-tools .sheet-close").click();
  const llama2 = "@cf/meta-llama/llama-2-7b-chat-hf-lora";
  check(
    "Llama 2 7B Chat LoRA, which produces no language, is not offered",
    (await page.locator(`#improve-model option[value="${llama2}"], #chat-model option[value="${llama2}"]`).count()) === 0
  );
  await page.close();
  await context.close();
}

// ── Settings: no reset controls; Start over puts the settings back ───────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-video");
  await page.waitForTimeout(200);
  check(
    "p-video's start image, end frame and audio are inputs, not settings",
    (await page.locator('.section-inputs [data-field], .section-inputs .file-input').count()) >= 3 &&
      (await page.locator(".options .file-input").count()) === 0
  );
  await page.fill(promptSel, "a slow pan");
  await page.setInputFiles(".section-inputs .file-input >> nth=0", imgPath);
  await page.waitForSelector(".section-inputs .thumbs .thumb img");
  await page.fill('[data-field="duration"]', "7");
  await page.waitForTimeout(200);
  check("a changed setting is marked and names its default", (await page.locator(".options .opt-row.changed").count()) === 1 &&
    /^default: /.test(await page.locator(".options .opt-row.changed .opt-note").textContent()));
  check("no setting has a Reset of its own, and there is no Reset all",
    (await page.locator(".opt-reset, .opt-reset-all").count()) === 0 &&
      (await page.locator("#gen-form button", { hasText: /reset/i }).count()) === 0);
  await page.locator("#reset-btn").click();
  await page.waitForTimeout(200);
  check("Start over puts the settings back", (await page.locator(".options .opt-row.changed").count()) === 0 &&
    (await page.inputValue('[data-field="duration"]')) !== "7");
  check("and clears the prompt and the attached image", (await page.inputValue(promptSel)) !== "a slow pan" &&
    (await page.locator(".section-inputs .thumbs .thumb").count()) === 0);
  await page.close();
  await context.close();
}

// ── Settings: no Turbo or filter switches; aspect ratio and seed side by
//    side; no change marker bar ───────────────────────────────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  const models = await page.evaluate(() => MODELS.map((m) => m.id));
  const shown = [];
  for (const id of models) {
    await page.selectOption("#model-select", id);
    const names = await page.evaluate(() =>
      currentModel.fields.filter((f) => f.hidden && document.querySelector(`#gen-form [data-field="${f.name}"]`)).map((f) => f.name)
    );
    for (const n of names) shown.push(`${id}:${n}`);
  }
  check("no model shows a Turbo or moderation-filter switch", shown.length === 0, shown.join(", "));

  // Off is what is sent, even where the provider's own default is on.
  await page.selectOption("#model-select", "p-image-edit-text-aware");
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "tidy it up");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  const sent = await (await page.request.get(BASE + "__generate")).json();
  check("Turbo off is still sent where the provider would default it on", sent.input && sent.input.turbo === false, JSON.stringify(sent.input));
  check("and the filter off with it", sent.input && sent.input.disable_safety_checker === true, JSON.stringify(sent.input));

  await page.selectOption("#model-select", "p-image-edit");
  await page.waitForTimeout(200);
  check("aspect ratio reads Match input", (await page.locator('[data-field="aspect_ratio"] option:checked').textContent()) === "Match input");
  const ar = await page.locator('[data-field="aspect_ratio"]').boundingBox();
  const seed = await page.locator('[data-field="seed"]').boundingBox();
  check("aspect ratio and seed sit side by side", ar && seed && Math.abs(ar.y - seed.y) < 4 && seed.x > ar.x, JSON.stringify({ ar, seed }));
  const prompt = await page.locator(promptSel).boundingBox();
  check("the prompt sits below the settings, next to Generate and the output", prompt.y > ar.y);
  await page.fill('[data-field="seed"]', "9");
  await page.waitForTimeout(200);
  check("no Reset appears once something is changed", (await page.locator(".opt-reset, .opt-reset-all").count()) === 0);
  check("and no orange bar marks it",
    await page.locator(".opt-row.changed").first().evaluate((el) => getComputedStyle(el).borderLeftStyle === "none" || getComputedStyle(el).borderLeftWidth === "0px"));

  // The viewer closes from the bottom, or with a downward swipe.
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  await page.locator("#viewer-close-bottom").click();
  await page.waitForFunction(() => document.getElementById("viewer").classList.contains("hidden"));
  check("the viewer has a Close at the bottom", true);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  await page.evaluate(() => {
    const el = document.querySelector("#viewer-stage");
    const touch = (y) => new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(150)], changedTouches: [touch(150)], bubbles: true }));
    el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(320)], bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById("viewer").classList.contains("hidden"));
  check("and a downward swipe closes it", true);
  await page.close();
  await context.close();
}

// ── The viewer steps through the list it was opened from ───────────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "cf-flux-1-schnell");
  await page.waitForTimeout(200);
  for (const text of ["first", "second", "third"]) {
    await page.fill(promptSel, text);
    await page.waitForTimeout(100);
    await page.locator("#generate-btn").click();
    await page.waitForSelector("#status.ok");
    await page.waitForFunction((n) => document.querySelectorAll(".recent-strip .thumb").length === n, ["first", "second", "third"].indexOf(text) + 1);
  }
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#viewer:not(.hidden)");
  const prompt = () => page.locator("#viewer-prompt").textContent();
  const shows = (t) => page.waitForFunction((t) => (document.querySelector("#viewer-prompt") || {}).textContent === t, t);
  check("the newest opens first, and says where it is", (await prompt()) === "third" && (await page.locator("#viewer-pos").textContent()) === "1 of 3");
  check("nothing before the newest", await page.locator("#viewer-prev").isDisabled());
  await page.locator("#viewer-next").click();
  await shows("second");
  check("› steps to the next one without closing", !(await page.locator("#viewer").isHidden()));
  await page.keyboard.press("ArrowRight");
  await shows("first");
  check("→ does the same", (await page.locator("#viewer-pos").textContent()) === "3 of 3");
  check("and stops at the end", await page.locator("#viewer-next").isDisabled());
  await page.keyboard.press("ArrowLeft");
  await shows("second");
  check("← goes back", true);
  // A swipe right-to-left moves on to the next item.
  await page.evaluate(() => {
    const el = document.querySelector("#viewer-stage");
    const touch = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 200 });
    el.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(300)], changedTouches: [touch(300)], bubbles: true }));
    el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(150)], bubbles: true }));
  });
  await shows("first");
  check("a swipe steps too", true);
  page.once("dialog", (d) => d.accept());
  await page.locator("#viewer-delete").click();
  await shows("second");
  check("Delete moves on to the neighbour instead of closing", (await page.locator("#viewer-pos").textContent()) === "2 of 2");
  check("and the strip follows", (await page.locator(".recent-strip .thumb").count()) === 2);
  // The phone's own Back closes the viewer rather than leaving the app.
  await page.goBack();
  await page.waitForFunction(() => document.getElementById("viewer").classList.contains("hidden"));
  check("Back closes the viewer and stays in the app", (await page.locator("#app").isVisible()) && page.url().startsWith(BASE));
  await page.close();
  await context.close();
}

// ── Prompt library: folders, the text itself, editing ──────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  const long = "a very long prompt about a lighthouse on a cliff at dusk, waves breaking below, gulls overhead, " + "more detail ".repeat(30);
  await page.fill(promptSel, long);
  await page.waitForTimeout(700);
  await page.locator("#open-prompts").click();
  await page.locator("#prompt-save").click();
  await page.fill("#lib-edit-name", "Lighthouse");
  page.once("dialog", (d) => d.accept("Places"));
  await page.selectOption("#lib-edit-folder", "__new__");
  await page.waitForTimeout(100);
  await page.locator("#lib-editor button", { hasText: "Save" }).click();
  check("a prompt is saved with a name", (await page.locator(".lib-card .lib-name").first().textContent()) === "Lighthouse");
  check("and its whole text, not a short string", (await page.locator(".lib-card .lib-text").first().textContent()) === long.trim());
  check("in the folder made for it", (await page.locator(".lib-folder", { hasText: "Places" }).count()) === 1);

  await page.locator("#sheet-prompts .sheet-close").click();
  await page.fill(promptSel, "a cat in a box");
  await page.waitForTimeout(700);
  await page.locator("#open-prompts").click();
  await page.locator("#prompt-save").click();
  await page.locator("#lib-editor button", { hasText: "Save" }).click();
  check("two saved", (await page.locator(".lib-card").count()) === 2);

  await page.locator(".lib-folder", { hasText: "Places" }).click();
  check("a folder shows only its own", (await page.locator(".lib-card").count()) === 1);
  await page.locator(".lib-folder", { hasText: "All" }).click();
  await page.fill("#lib-search", "gulls");
  check("search reads the text, not only the name", (await page.locator(".lib-card").count()) === 1);
  await page.fill("#lib-search", "");

  // Edit in place: rename and move.
  await page.locator(".lib-card", { hasText: "a cat in a box" }).locator("button", { hasText: "Edit" }).click();
  await page.fill("#lib-edit-name", "Cat");
  await page.selectOption("#lib-edit-folder", { label: "Places" });
  await page.locator("#lib-editor button", { hasText: "Save changes" }).click();
  await page.locator(".lib-folder", { hasText: "Places" }).click();
  check("edited prompts move between folders", (await page.locator(".lib-card").count()) === 2);

  // Survives a reload; deleting a folder keeps its prompts.
  await page.close();
  page = await open(context);
  await page.locator("#open-prompts").click();
  check("the library survives a reload", (await page.locator(".lib-card").count()) === 2);
  await page.locator(".lib-folder", { hasText: "Places" }).click();
  page.once("dialog", (d) => d.accept());
  await page.locator("#lib-folder-tools button", { hasText: "Delete folder" }).click();
  check("deleting a folder keeps its prompts", (await page.locator(".lib-card").count()) === 2 && (await page.locator(".lib-folder", { hasText: "Places" }).count()) === 0);
  await page.locator(".lib-card", { hasText: "Cat" }).locator(".lib-use").click();
  check("Use puts it in the prompt box", (await page.inputValue(promptSel)) === "a cat in a box");
  await page.close();
  await context.close();
}

// ── Embeddings ─────────────────────────────────────────────────────────────
// Measured a moment after typing stops, compared against the baseline and the
// previous version, paused on request, kept per model across a reload.
{
  const context = await browser.newContext();
  let page = await open(context);
  const calls = async () => (await (await page.request.get(BASE + "__embed")).json()).embedCalls;
  await page.locator("#tab-lab").click();
  await page.locator("#embed > summary").click();
  const before = await calls();
  await page.fill("#embed-text", "a red fox in the snow");
  await page.waitForTimeout(1500);
  check("a pause in typing measures the text", (await calls()) === before + 1 && (await page.locator(".embed-row").count()) === 1);
  check("the first version is the baseline", (await page.locator(".embed-row.baseline").count()) === 1);
  check("and is drawn as a barcode", (await page.locator(".embed-row canvas").count()) === 1);

  await page.fill("#embed-text", "a red fox in the deep snow");
  await page.waitForTimeout(1500);
  const small = await page.locator(".embed-row").first().locator(".embed-scores").textContent();
  check("a small edit scores close to the baseline", /vs baseline (0\.[89]|1\.0)/.test(small), small);
  check("and gets a change strip", (await page.locator(".embed-row").first().locator("canvas").count()) === 2);

  await page.fill("#embed-text", "quarterly tax filing deadlines");
  await page.waitForTimeout(1500);
  const far = await page.locator(".embed-row").first().locator(".embed-scores").textContent();
  const farScore = Number((far.match(/vs baseline ([\d.-]+)/) || [])[1]);
  check("a different subject scores far from it", farScore < 0.5, far);

  await page.check("#embed-pause");
  const paused = await calls();
  await page.fill("#embed-text", "typed while paused");
  await page.waitForTimeout(1500);
  check("paused, typing measures nothing", (await calls()) === paused);
  await page.locator("#embed-measure").click();
  await page.waitForTimeout(400);
  check("Measure now still measures", (await calls()) === paused + 1 && (await page.locator(".embed-row").count()) === 4);

  await page.locator(".embed-row").nth(1).locator("button", { hasText: "Set as baseline" }).click();
  check("any version can become the baseline", (await page.locator(".embed-row").nth(1).evaluate((el) => el.classList.contains("baseline"))));

  await page.selectOption("#embed-model", "@cf/baai/bge-small-en-v1.5");
  check("another model has its own, empty, history", (await page.locator(".embed-row").count()) === 0);
  await page.selectOption("#embed-model", "@cf/baai/bge-m3");
  check("and switching back finds it", (await page.locator(".embed-row").count()) === 4);

  await page.close();
  page = await open(context);
  await page.locator("#embed > summary").click();
  check("the versions survive a reload", (await page.locator(".embed-row").count()) === 4);
  page.once("dialog", (d) => d.accept());
  await page.locator("#embed-clear").click();
  check("Clear empties them", (await page.locator(".embed-row").count()) === 0);
  await page.close();
  await context.close();
}

// ── Neuron meter past and approaching the free allowance ───────────────────
// On Workers Paid the 10,000 is where billing starts, not where the models
// stop, so the bar has to say so on the way up and price the overage after.
{
  const context = await browser.newContext();
  const bar = async (used) => {
    await context.request.get(BASE + `__neurons?used=${used}`);
    const page = await open(context);
    await page.waitForFunction(() => /neurons/.test(document.querySelector("#spend").textContent));
    const out = { level: await page.getAttribute("#spend", "data-level"), text: await page.locator("#spend").textContent() };
    await page.close();
    return out;
  };
  const low = await bar(2000);
  check("under the warning line the bar is plain", low.level === "" && !low.text.includes("⚠"), JSON.stringify(low));
  const near = await bar(8500);
  check("approaching the free allowance, the bar warns", near.level === "warn" && near.text.includes("1,500 left"), JSON.stringify(near));
  check("and says what comes after it", near.text.includes("$0.011 per 1,000"), near.text);
  const over = await bar(12000);
  check("past it, the bar says so", over.level === "over" && over.text.includes("2,000 over"), JSON.stringify(over));
  check("and prices the overage", over.text.includes("$0.022"), over.text);
  await context.request.get(BASE + "__neurons");
  await context.close();
}

// ── Text to speech ─────────────────────────────────────────────────────────
// Aura bills per character, so its cost has to follow the text as typed; the
// result has to be playable, and has to reach a video model's audio field both
// from the result panel and from the field's own voice panel.
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "cf-aura-2-en");
  await page.waitForTimeout(250);
  await page.fill('[data-field="text"]', "x".repeat(500));
  const est = await page.locator(".tts-estimate").first().textContent();
  check("the speech estimate follows the text", est.includes("500 characters") && est.includes("1,364 neurons"), est);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#result audio", { timeout: 10000 });
  check("a speech result plays in an audio element", (await page.locator("#result audio").count()) === 1);
  const sent = await (await page.request.get(BASE + "__generate")).json();
  check("the text goes out under the model's own key", sent.input && sent.input.text === "x".repeat(500), JSON.stringify(sent).slice(0, 200));
  const reuse = page.locator("#result .reuse");
  check("with nowhere to put it here, reuse offers a model that takes a voice", (await reuse.textContent()).startsWith("Use in"), await reuse.textContent());
  await reuse.click();
  await page.waitForTimeout(500);
  const audioThumbs = await page.locator("#gen-form .thumb.file").count();
  check("reusing it lands the voice in an audio field", audioThumbs === 1, `thumbs ${audioThumbs}, status ${await page.locator("#status").textContent()}`);

  // The voice panel on a video model's audio field.
  await page.selectOption("#model-select", "p-video");
  await page.waitForTimeout(300);
  const panel = page.locator(".tts-panel").first();
  check("an audio field offers to generate a voice", (await panel.count()) === 1);
  await panel.locator("summary").click();
  check("Aura-2 English is the panel's default", (await panel.locator(".tts-model").inputValue()) === "cf-aura-2-en");
  await panel.locator(".tts-model").selectOption("cf-aura-2-es");
  check("switching speech model switches the voice list", (await panel.locator(".tts-voice").inputValue()) === "aquila");
  check("an Aura model asks for a voice, not a language", await panel.locator(".tts-lang").isHidden());
  await panel.locator(".tts-model").selectOption("cf-aura-2-en");
  await panel.locator(".tts-text").fill("hello there");
  await panel.locator(".tts-go").click();
  await page.waitForSelector("#status.ok", { timeout: 10000 });
  const sent2 = await (await page.request.get(BASE + "__generate")).json();
  check("the panel sends the chosen speech model and voice", sent2.model === "cf-aura-2-en" && sent2.input.speaker === "luna" && sent2.input.text === "hello there", JSON.stringify(sent2));
  const field = panel.locator("xpath=..");
  check("and the voice becomes that field's file", (await field.locator(".thumb").count()) === 1, await page.locator("#status").textContent());
  await page.close();
  await context.close();
}

// ── Real disk persistence (separate browser process, same profile) ──────────
{
  const profile = mkdtempSync(join(tmpdir(), "pb-profile-"));
  let ctx = await ENGINE.launchPersistentContext(profile, {});
  let page = await open(ctx);
  await page.selectOption("#model-select", "p-image-edit");
  await page.setInputFiles(".file-input", imgPath);
  await page.waitForSelector(".thumbs .thumb img");
  await page.fill(promptSel, "survives a process restart");
  await settle(page);
  await ctx.close();

  ctx = await ENGINE.launchPersistentContext(profile, {});
  page = await open(ctx);
  check("prompt survived a browser restart", (await page.inputValue(promptSel)) === "survives a process restart");
  check("upload survived a browser restart", (await page.locator(".thumbs .thumb").count()) === 1);
  await ctx.close();
}

await browser.close();

console.log(`\n[${ENGINE_NAME}] ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
