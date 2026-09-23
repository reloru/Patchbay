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

const browser = await ENGINE.launch();
console.log(`engine: ${ENGINE_NAME} ${browser.version()}`);

// ── Persistence ────────────────────────────────────────────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);

  // model + prompt + options
  await page.selectOption("#model-select", "p-image");
  await page.fill(promptSel, "a cat wearing a tiny hat");
  await page.locator(".options > summary").click();
  await page.fill('[data-field="width"]', "1536");
  await page.selectOption('[data-field="aspect_ratio"]', "9:16");
  // The real checkbox is visually replaced by the switch track, so the label is
  // what a user taps.
  await page.locator('label.toggle:has([data-field="prompt_upsampling"])').click();
  await settle(page);
  const badgeBefore = await page.locator(".opt-badge").textContent();
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
  check("options panel reopened", await page.locator(".options").evaluate((d) => d.open));
  const badgeAfter = await page.locator(".opt-badge").textContent();
  check("changed count restored", badgeBefore === badgeAfter, `${badgeBefore} vs ${badgeAfter}`);

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
  check("Improve stays Improve rather than becoming its own undo", (await page.locator("#prompt-improve").textContent()) === "✨ Improve");
  await undo.click();
  check("Improve is undoable in one press", (await page.inputValue(promptSel)) === "cat on a skateboard");
  await redo.click();
  check("Improve is redoable", (await page.inputValue(promptSel)) === "IMPROVED PROMPT TEXT");
  await undo.click();

  // Describe → Undo (uses the file picker path)
  await page.setInputFiles("#describe-file", imgPath);
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
  await page.selectOption("#prompt-select", "0");
  check("saved prompt loaded", (await page.inputValue(promptSel)) === "a saved prompt body");
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
  await page.locator(".options > summary").click();
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
    (await page.locator(".reuse").textContent()) === "✏️ Edit in P-Image-Edit",
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
  check("label reads Edit this on an editing model", (await page.locator(".reuse").first().textContent()) === "✏️ Edit this");
  await page.locator(".reuse").first().click();
  await page.waitForTimeout(300);
  check("adds to the same field rather than switching", (await page.inputValue("#model-select")) === "p-image-edit");
  check("two images attached now", (await page.locator(".thumbs .thumb").count()) === 2);

  // A generation model whose image field is a reference gets the other label.
  await page.selectOption("#model-select", "xai-imagine-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "a harbour at dusk");
  await page.waitForTimeout(700);
  // This model's image field is optional, so it sits inside the Options panel;
  // open it to clear what carried over and make room.
  await page.locator(".options > summary").click();
  while ((await page.locator(".thumbs .thumb .rm").count()) > 0) {
    await page.locator(".thumbs .thumb .rm").first().click();
  }
  await generate();
  check(
    "label reads Use as reference on a generation model",
    (await page.locator(".reuse").first().textContent()) === "🖼 Use as reference",
    await page.locator(".reuse").first().textContent()
  );
  await page.locator(".reuse").first().click();
  await page.waitForTimeout(300);
  const ref = await page.evaluate(() => (uploads.images || []).length);
  check("landed in the reference field", ref === 1, String(ref));
  check("the Options panel was opened so the landing is visible", await page.locator(".options").evaluate((d) => d.open));

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
    (await page.locator(".reuse").first().textContent()) === "✏️ Edit in P-Image-Edit",
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

// ── Recent generations ─────────────────────────────────────────────────────
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
  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes"], "readonly");
          const light = tx.objectStore("gallery").getAll();
          const heavy = tx.objectStore("galleryBytes").getAll();
          tx.oncomplete = () =>
            resolve({
              light: (light.result || []).map((x) => ({
                id: x.id,
                hasInlineBytes: "bytes" in x,
                thumbIsBuffer: x.thumb instanceof ArrayBuffer || x.thumb === null,
                prompt: x.prompt,
                modelId: x.modelId,
                size: x.size,
              })),
              heavy: (heavy.result || []).map((x) => ({ id: x.id, bytesIsBuffer: x.bytes instanceof ArrayBuffer })),
            });
          tx.onerror = () => resolve("read failed");
        };
        r.onerror = () => resolve("open failed");
      })
  );
  check(
    "the light record carries the thumbnail and metadata, and no image bytes",
    stored.light &&
      stored.light.length === 1 &&
      stored.light[0].hasInlineBytes === false &&
      stored.light[0].thumbIsBuffer &&
      stored.light[0].prompt === "first picture" &&
      stored.light[0].modelId === "p-image" &&
      stored.light[0].size > 0,
    JSON.stringify(stored.light)
  );
  check(
    "the image itself is an ArrayBuffer in the other store, under the same id",
    stored.heavy &&
      stored.heavy.length === 1 &&
      stored.heavy[0].bytesIsBuffer &&
      stored.heavy[0].id === stored.light[0].id,
    JSON.stringify(stored.heavy)
  );

  // Survives a reopen — the assertion that would have caught the WebKit bug.
  await page.close();
  page = await open(context);
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length === 1);
  check("the strip survives a reopen", (await page.locator(".recent-strip .thumb").count()) === 1);
  check("the strip says what it is holding", (await page.locator("#recent-count").textContent()).includes("1 recent item"));

  // The lightbox: metadata, setup restore, reuse, delete.
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#lightbox:not(.hidden)");
  check("lightbox names the model", (await page.locator("#lightbox-meta").textContent()).includes("P-Image"));
  check("lightbox shows the prompt", (await page.locator("#lightbox-prompt").textContent()) === "first picture");
  await page.fill(promptSel, "something else entirely");
  await page.waitForTimeout(700);
  await page.locator("#lightbox-actions button", { hasText: "Restore setup" }).click();
  check("restoring the setup puts the prompt back", (await page.inputValue(promptSel)) === "first picture");
  await page.locator("#prompt-undo").click();
  check("a restored setup is undoable in one press", (await page.inputValue(promptSel)) === "something else entirely");

  // Reuse from the lightbox takes the same path as the result panel.
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#lightbox:not(.hidden)");
  await page.locator("#lightbox-actions button", { hasText: /Edit|reference/ }).click();
  await page.waitForTimeout(400);
  check("reuse from the lightbox switches and attaches", (await page.inputValue("#model-select")) === "p-image-edit");
  check("the image landed", (await page.evaluate(() => (uploads.images || []).length)) === 1);

  // Count eviction. Seeded straight into both stores rather than generated:
  // two hundred round trips through the UI would dominate the suite's runtime,
  // and what is under test is pruneGallery, which runs at boot.
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes"], "readwrite");
          const light = tx.objectStore("gallery");
          const heavy = tx.objectStore("galleryBytes");
          // Start from empty: the real generations earlier in this block carry
          // their own timestamps and would otherwise displace seeds at the
          // eviction boundary, making the assertion depend on how long the
          // suite took to get here.
          light.clear();
          heavy.clear();
          const now = Date.now();
          for (let i = 0; i < 210; i++) {
            const id = `seed-${String(i).padStart(3, "0")}`;
            light.put({
              id,
              createdAt: now - i * 1000, // seed-000 newest
              modelId: "p-image",
              prompt: "seed " + i,
              kind: "image",
              type: "image/png",
              thumb: new ArrayBuffer(8),
              thumbType: "image/jpeg",
              width: 10,
              height: 10,
              size: 1024,
            });
            heavy.put({ id, bytes: new ArrayBuffer(1024) });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
      })
  );
  await page.close();
  page = await open(context);
  await page.waitForTimeout(800);
  const counts = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes"], "readonly");
          const light = tx.objectStore("gallery").getAll();
          const heavy = tx.objectStore("galleryBytes").count();
          tx.oncomplete = () =>
            resolve({
              kept: (light.result || []).map((x) => x.prompt),
              heavy: heavy.result,
            });
          tx.onerror = () => resolve(null);
        };
      })
  );
  check("the image store is capped at two hundred", counts && counts.kept.length === 200, counts && String(counts.kept.length));
  check(
    "the newest were kept and the oldest dropped",
    counts && counts.kept.includes("seed 0") && counts.kept.includes("seed 199") && !counts.kept.includes("seed 200"),
    counts && counts.kept.length + " items"
  );
  check("both halves were pruned together", counts && counts.heavy === 200, counts && String(counts.heavy));
  check("the strip shows them all", (await page.locator(".recent-strip .thumb").count()) === 200);

  // Age eviction: backdate everything and reopen.
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
  await page.close();
  page = await open(context);
  await page.waitForTimeout(600);
  check("anything older than a week is gone on the next load", (await page.locator(".recent-strip .thumb").count()) === 0);
  check("and the strip hides itself again", await page.locator("#recent").evaluate((el) => el.classList.contains("hidden")));

  // Clear removes the lot.
  await page.selectOption("#model-select", "p-image");
  await gen("to be cleared");
  page.once("dialog", (d) => d.accept());
  await page.locator("#recent-clear").click();
  await page.waitForTimeout(400);
  check("Clear empties the strip", (await page.locator(".recent-strip .thumb").count()) === 0);

  // Clearing while a job runs must not look like it stopped the job. The
  // status line belonged to the run and was being written over with
  // "Cleared…", and an archive write already in flight could land afterwards
  // and put an item back into the strip the user had just emptied.
  await gen("something to clear later");
  await page.request.get(BASE + "__slow?on=1");
  await page.fill(promptSel, "a run that must survive a Clear");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#stop-btn:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(2200);
  page.once("dialog", (d) => d.accept());
  await page.locator("#recent-clear").click();
  await page.waitForTimeout(1500);
  check(
    "clearing does not write over a running job's status",
    /elapsed/.test(await page.locator("#status").textContent()),
    await page.locator("#status").textContent()
  );
  check("the run is still going", await page.locator("#stop-btn").isVisible());
  check("and the strip did empty", (await page.locator(".recent-strip .thumb").count()) === 0);

  await page.request.get(BASE + "__slow?on=0");
  await page.waitForSelector("#status.ok", { timeout: 20000 });
  await page.waitForTimeout(600);
  check(
    "a result finishing after the Clear is still kept",
    (await page.locator(".recent-strip .thumb").count()) === 1,
    String(await page.locator(".recent-strip .thumb").count())
  );
  await page.close();
  await context.close();
}

// ── A v1 database keeps its session when the gallery store is added ────────
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
            db.close(); // so the app's upgrade to v2 is not blocked
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
    "the database is at v3 with all three stores",
    stores && stores.v === 3 && stores.stores.join(",") === "gallery,galleryBytes,session",
    JSON.stringify(stores)
  );
  await page2.close();
  await context.close();
}

// ── A v2 gallery item is split across both stores, not dropped ─────────────
{
  const context = await browser.newContext();
  const page = await context.newPage();
  // Same trick as above: a same-origin page that is not the app, so nothing
  // holds a connection while the v2 database is built.
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
          // A v2 record: the image sits inline, which is what v3 has to move.
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
  const split = await page2.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes"], "readonly");
          const light = tx.objectStore("gallery").get("legacy-1");
          const heavy = tx.objectStore("galleryBytes").get("legacy-1");
          tx.oncomplete = () =>
            resolve({
              version: r.result.version,
              lightHasBytes: light.result ? "bytes" in light.result : null,
              prompt: light.result ? light.result.prompt : null,
              thumbKept: light.result ? light.result.thumb instanceof ArrayBuffer : null,
              heavyLen: heavy.result && heavy.result.bytes ? heavy.result.bytes.byteLength : null,
            });
          tx.onerror = () => resolve(null);
        };
        r.onerror = () => resolve(null);
      })
  );
  check(
    "the v2 item's image moved to the bytes store, and nothing was dropped",
    split && split.version === 3 && split.lightHasBytes === false && split.heavyLen === 8 && split.prompt === "made under v2" && split.thumbKept,
    JSON.stringify(split)
  );
  check("the migrated item still shows in the strip", (await page2.locator(".recent-strip .thumb").count()) === 1);
  // And it still opens, which is the only thing that proves the two halves
  // still find each other.
  await page2.locator(".recent-strip .thumb").first().click();
  await page2.waitForSelector("#lightbox:not(.hidden)");
  check("the migrated item still opens", (await page2.locator("#lightbox-prompt").textContent()) === "made under v2");
  await page2.close();
  await context.close();
}

// ── The lightbox does not leak its full-size image ─────────────────────────
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
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);

  const before = await page.evaluate(() => window.__liveUrls);
  // Open and close the same item several times. Each open mints a full-size
  // url; without the revoke on close they accumulate until the strip is next
  // rebuilt, which may be a long time.
  for (let i = 0; i < 4; i++) {
    await page.locator(".recent-strip .thumb").first().click();
    await page.waitForSelector("#lightbox:not(.hidden)");
    await page.locator("#lightbox-actions button", { hasText: "Close" }).click();
    // Not waitForSelector: .hidden is display:none, so it never becomes visible.
    await page.waitForFunction(() => document.getElementById("lightbox").classList.contains("hidden"));
  }
  const after = await page.evaluate(() => window.__liveUrls);
  check("opening and closing the lightbox leaves no url behind", after === before, `${before} -> ${after}`);
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
  await page.close();
  await context.close();
}

// ── Video results are kept too ─────────────────────────────────────────────
// The expensive half of the catalogue used to be the half that was thrown away:
// only images were archived, so a clip was gone the moment Generate was pressed
// again and the provider's link expired behind it.
//
// The stub answers a video model with PNG bytes under a video content type (it
// has no encoder). That is enough for everything under test here — the record,
// the split across the two stores, the strip, the lightbox — and it puts the
// poster frame through videoThumb's "will not decode" branch, which has to
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

  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes"], "readonly");
          const light = tx.objectStore("gallery").getAll();
          const heavy = tx.objectStore("galleryBytes").getAll();
          tx.oncomplete = () =>
            resolve({
              light: (light.result || []).map((x) => ({
                id: x.id,
                kind: x.kind,
                prompt: x.prompt,
                modelId: x.modelId,
                hasInlineBytes: "bytes" in x,
                setupFields: x.setup && x.setup.fields ? Object.keys(x.setup.fields).length : 0,
                setupPrompt: x.setup && x.setup.fields ? x.setup.fields.prompt : null,
              })),
              heavy: (heavy.result || []).map((x) => ({ id: x.id, bytesIsBuffer: x.bytes instanceof ArrayBuffer })),
            });
          tx.onerror = () => resolve(null);
        };
        r.onerror = () => resolve(null);
      })
  );
  check(
    "the video is archived, tagged as video, with no bytes in the light record",
    stored &&
      stored.light.length === 1 &&
      stored.light[0].kind === "video" &&
      stored.light[0].modelId === "p-video-edit" &&
      stored.light[0].prompt === "make it rain" &&
      stored.light[0].hasInlineBytes === false,
    JSON.stringify(stored && stored.light)
  );
  check(
    "its bytes are an ArrayBuffer in the other store, under the same id",
    stored && stored.heavy.length === 1 && stored.heavy[0].bytesIsBuffer && stored.heavy[0].id === stored.light[0].id,
    JSON.stringify(stored && stored.heavy)
  );
  check(
    "the settings that produced it ride along",
    stored && stored.light[0].setupFields > 0 && stored.light[0].setupPrompt === "make it rain",
    JSON.stringify(stored && stored.light[0])
  );
  check("the strip counts it as a video", (await page.locator("#recent-count").textContent()).includes("1 video"));
  check("and marks the tile", (await page.locator(".recent-strip .thumb-kind").count()) === 1);

  // Survives a reopen, and opens as a player rather than a broken image.
  await page.close();
  page = await open(context);
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length === 1);
  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#lightbox:not(.hidden)");
  check("the lightbox opens a kept clip as a video", (await page.locator("#lightbox-media video").count()) === 1);
  check("and not as an image", (await page.locator("#lightbox-media img").count()) === 0);
  await page.locator("#lightbox-actions button", { hasText: "Close" }).click();
  await page.waitForFunction(() => document.getElementById("lightbox").classList.contains("hidden"));
  await page.close();
  await context.close();
}

// ── Each kind is capped on its own ─────────────────────────────────────────
// One clip outweighs a hundred images, so under a single shared ceiling the
// clips would evict the stills. Seeded rather than generated, for the same
// reason the count-eviction test above seeds.
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction(["gallery", "galleryBytes"], "readwrite");
          const light = tx.objectStore("gallery");
          const heavy = tx.objectStore("galleryBytes");
          light.clear();
          heavy.clear();
          const now = Date.now();
          const put = (id, kind, createdAt) => {
            light.put({
              id,
              createdAt,
              kind,
              modelId: kind === "video" ? "p-video-edit" : "p-image",
              prompt: id,
              type: kind === "video" ? "video/mp4" : "image/png",
              thumb: new ArrayBuffer(8),
              thumbType: "image/jpeg",
              width: 10,
              height: 10,
              size: 1024,
            });
            heavy.put({ id, bytes: new ArrayBuffer(1024) });
          };
          // 40 clips against a cap of 25, and 10 images that must all survive.
          for (let i = 0; i < 40; i++) put(`vid-${String(i).padStart(3, "0")}`, "video", now - i * 1000);
          for (let i = 0; i < 10; i++) put(`img-${String(i).padStart(3, "0")}`, "image", now - i * 1000);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        };
      })
  );
  await page.close();
  page = await open(context);
  await page.waitForTimeout(800);
  const kept = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open("patchbay");
        r.onsuccess = () => {
          const tx = r.result.transaction("gallery", "readonly");
          const all = tx.objectStore("gallery").getAll();
          tx.oncomplete = () => {
            const rows = all.result || [];
            resolve({
              videos: rows.filter((x) => x.kind === "video").length,
              images: rows.filter((x) => x.kind !== "video").length,
            });
          };
          tx.onerror = () => resolve(null);
        };
      })
  );
  check("videos are capped at their own limit", kept && kept.videos === 25, JSON.stringify(kept));
  check("and evicting them costs the images nothing", kept && kept.images === 10, JSON.stringify(kept));
  await page.close();
  await context.close();
}

// ── Restore setup puts the options back, not just the prompt ───────────────
{
  const context = await browser.newContext();
  const page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "the original run");
  // A non-default option, so there is something to restore beyond the text.
  // It lives in the Options panel, which starts collapsed.
  await page.locator(".options > summary").click();
  const seedSel = '[data-field="seed"]';
  await page.fill(seedSel, "4242");
  await page.waitForTimeout(700);
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  await page.waitForFunction(() => document.querySelectorAll(".recent-strip .thumb").length > 0);

  // Move everything away from what produced it — a different model, a different
  // prompt, a different seed.
  await page.selectOption("#model-select", "flux-dev");
  await page.waitForTimeout(300);
  await page.fill(promptSel, "something unrelated");
  await page.waitForTimeout(700);

  await page.locator(".recent-strip .thumb").first().click();
  await page.waitForSelector("#lightbox:not(.hidden)");
  await page.locator("#lightbox-actions button", { hasText: "Restore setup" }).click();
  await page.waitForTimeout(500);

  check("restoring switches back to the model that made it", (await page.inputValue("#model-select")) === "p-image");
  check("the prompt comes back", (await page.inputValue(promptSel)) === "the original run");
  check("and so does the option that was set", (await page.inputValue(seedSel)) === "4242");
  check(
    "the option is still marked as deliberately set",
    await page.evaluate(() => optionRows.some((r) => r.f.name === "seed" && r.touched))
  );
  // The flag is what decides whether a value equal to the default is still
  // sent, so a restore that loses it changes the request.
  await page.locator("#generate-btn").click();
  await page.waitForSelector("#status.ok");
  const sent = await (await page.request.get(BASE + "__generate")).json();
  check("and the restored run sends what the original would have", sent.input && sent.input.seed === 4242, JSON.stringify(sent.input));
  await page.close();
  await context.close();
}

// ── Stop stops the waiting, not the job ────────────────────────────────────
// There is no cancel endpoint to call, so this must leave the job record alone:
// clearing it is what would turn a stop into a loss.
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.request.get(BASE + "__slow?on=1");

  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.fill(promptSel, "a job worth abandoning");
  await page.waitForTimeout(700);
  check("no Stop button before anything is running", await page.locator("#stop-btn").isHidden());

  await page.locator("#generate-btn").click();
  await page.waitForSelector("#stop-btn:not(.hidden)", { timeout: 10000 });
  check("Stop appears once a job is in flight", await page.locator("#stop-btn").isVisible());
  check("and Generate is held while it runs", await page.locator("#generate-btn").isDisabled());

  await page.locator("#stop-btn").click();
  await page.waitForSelector("#status.ok", { timeout: 15000 });
  check("stopping reports the job as still running", (await page.locator("#status").textContent()).includes("still running"));
  check("Generate comes back", await page.locator("#generate-btn").isEnabled());
  check("and Stop goes away", await page.locator("#stop-btn").isHidden());

  const job = await page.evaluate(() => localStorage.getItem("pruna_inflight_job"));
  check("the job record is kept, so the run is not lost", Boolean(job) && JSON.parse(job).id === "stub-job-1", String(job));

  // The point of keeping it: the next load collects the result.
  await page.request.get(BASE + "__slow?on=0");
  await page.close();
  page = await open(context);
  await page.waitForSelector("#status.ok", { timeout: 15000 });
  check("a stopped job is picked up on the next load", (await page.locator("#status").textContent()).includes("Recovered"));
  check("and its result lands in the panel", (await page.locator(".result img").count()) === 1);
  check("the record is cleared once collected", (await page.evaluate(() => localStorage.getItem("pruna_inflight_job"))) === null);
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
  await page.locator("#prompt-judge").click();
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
  await page.locator("#prompt-describe").click();
  await page.waitForTimeout(900);
  check("a caption seeds the prompt, which is what captioning is for", (await page.inputValue(promptSel)) === "STUB CAPTION TEXT");
  check("Describe sends no question and no prompt", posted.length === 1 && !("question" in posted[0]) && !("prompt" in posted[0]), JSON.stringify(posted[0] && Object.keys(posted[0])));
  const notes = await page.locator(".tool-notes").textContent();
  check("the notes name no files", !notes.includes("cat.png"), notes);
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
  check("and the attached image, for a model that can see", typeof sent.image_b64 === "string" && sent.image_b64.length > 0);
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

  await page.locator(".chat-use").last().click();
  await page.waitForTimeout(200);
  check("Put in prompt box replaces the prompt with the reply", (await page.inputValue(promptSel)) === "STUB REPLY 2");
  await page.locator("#prompt-undo").click();
  check("and Undo brings the old prompt back", (await page.inputValue(promptSel)) === "a neon cat on a rooftop");

  await page.uncheck("#chat-context");
  await page.fill("#chat-input", "no context this time");
  await page.locator("#chat-send").click();
  await page.waitForFunction(() => document.querySelectorAll(".chat-msg.assistant:not(.pending)").length === 3);
  sent = await (await page.request.get(BASE + "__chat")).json();
  check("with the switch off, neither prompt nor image is sent", !("prompt" in sent) && !("image_b64" in sent), JSON.stringify(Object.keys(sent)));
  await page.check("#chat-context");

  await page.selectOption("#chat-model", "@cf/meta/llama-3.2-3b-instruct");
  await page.waitForTimeout(150);
  check("a model that cannot see says so while an image is attached", (await page.locator("#chat-note").textContent()).includes("can't see images"));

  await page.close();
  page = await open(context);
  check("the thread survives a reload", (await page.locator(".chat-msg").count()) === 6, `${await page.locator(".chat-msg").count()} messages`);
  page.once("dialog", (d) => d.accept());
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

// ── ⚙ settings for Improve and the chat ────────────────────────────────────
{
  const context = await browser.newContext();
  let page = await open(context);
  await page.selectOption("#model-select", "p-image");
  await page.waitForTimeout(200);
  await page.selectOption("#improve-model", "@cf/zai-org/glm-5.3");
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
  await page.fill(".settings-tokens", "900");
  await page.selectOption(".settings-thinking", "off");
  await page.selectOption(".settings-effort", "high");
  check("the cost of the limit is shown", (await page.locator("#tool-settings .settings-cost").textContent()).includes("360"));
  check("the ⚙ marks a customised model", await page.locator("#improve-settings").evaluate((el) => el.classList.contains("custom")));

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

  await page.selectOption("#improve-model", "@cf/meta/llama-3.2-3b-instruct");
  await page.waitForTimeout(150);
  check("a model without thinking says so", (await page.locator(".settings-thinking").count()) === 0 && (await page.locator("#tool-settings").textContent()).includes("no thinking"));
  check("the instruction is shared by the tool's models", (await page.inputValue(".settings-system")) === "Rewrite it as a haiku.");
  check("the token limit belongs to the other model", (await page.inputValue(".settings-tokens")) === "");

  await page.close();
  page = await open(context);
  await page.selectOption("#improve-model", "@cf/zai-org/glm-5.3");
  await page.locator("#improve-settings").click();
  check("settings survive a reload", (await page.inputValue(".settings-tokens")) === "900");
  await page.locator("#tool-settings button", { hasText: "Reset this model" }).click();
  await page.locator("#tool-settings button", { hasText: "Reset instruction" }).click();
  check("Reset puts the defaults back", (await page.inputValue(".settings-tokens")) === "" && (await page.inputValue(".settings-system")) === "DEFAULT IMPROVE INSTRUCTION");
  check("and the ⚙ is plain again", !(await page.locator("#improve-settings").evaluate((el) => el.classList.contains("custom"))));

  await page.locator("#chat-settings").click();
  check("the chat's ⚙ opens its own settings", (await page.inputValue(".settings-system")) === "DEFAULT CHAT INSTRUCTION");
  await page.fill(".settings-tokens", "300");
  await page.fill("#chat-input", "hi");
  await page.locator("#chat-send").click();
  await page.waitForSelector(".chat-msg.assistant:not(.pending)");
  const chatSent = await (await page.request.get(BASE + "__chat")).json();
  check("the chat sends its settings", chatSent.settings && chatSent.settings.maxTokens === 300, JSON.stringify(chatSent.settings));
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
  check("with nowhere to put it here, reuse offers a model that takes a voice", (await reuse.textContent()).startsWith("🔊 Use in"), await reuse.textContent());
  await reuse.click();
  await page.waitForTimeout(500);
  const audioThumbs = await page.locator("#gen-form .thumb.file").count();
  check("reusing it lands the voice in an audio field", audioThumbs === 1, `thumbs ${audioThumbs}, status ${await page.locator("#status").textContent()}`);

  // The voice panel on a video model's audio field.
  await page.selectOption("#model-select", "p-video");
  await page.waitForTimeout(300);
  const panel = page.locator(".tts-panel").first();
  check("an audio field offers to generate a voice", (await panel.count()) === 1);
  if (await page.locator("details.options").count()) await page.locator("details.options > summary").click();
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
