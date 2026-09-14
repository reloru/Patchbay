# Browser tests

Covers the two features that live entirely in the browser: the on-device editing
session (IndexedDB) and the prompt undo history. Both are about what a browser
keeps, so both are tested by driving real browsers.

```
npm test              # chromium, then webkit
npm run test:webkit   # one engine
```

Playwright is needed and is **not** a dependency of this repo:

```
npm i -g playwright && playwright install chromium webkit
```

`npm install` here runs before every `wrangler deploy`, and Playwright pulls
browser binaries on install — hundreds of megabytes to publish a static front
end. So the tests are opt-in; without Playwright they refuse to run and say so,
and nothing else is affected. On Linux the WebKit build also needs system
libraries: `npx playwright install-deps webkit`.

## Run WebKit, not just Chromium

Patchbay is used on an iPhone. A Chromium-only run of this suite once reported
the session restore working while Safari's engine was silently failing to store
the uploads: WebKit aborts the whole IndexedDB transaction with
`UnknownError: Error preparing Blob/File data to be stored in object store` for
any value containing a Blob — a `File`, a slice of one, even a Blob built from
bytes already in memory — while Chromium accepts all of them. Because the session
record is written in two halves, the prompt, model and options restored and the
photo did not.

The fix was to fall back to storing raw ArrayBuffers, which every engine accepts.
The suite now has a test that reproduces the refusal in *any* engine by aborting
the transaction the way WebKit does, so that fallback stays covered even where
Blobs would work — but run both engines anyway.

## Shape

- **`run.mjs`** starts the stub server, runs `session.test.mjs` once per engine in
  its own process, and stops the server.
- **`server.mjs`** stands in for the Worker: serves the real `public/` files and
  the real catalogue from `src/models.js`, and answers the API routes with fixed
  replies. A stub rather than `wrangler dev` because these tests are about what
  the browser does with a response — they must not need API keys, must not cost
  anything, and must not fail because a provider is slow. Routes under `/__` are
  the test's own window into what the browser sent.
- **`session.test.mjs`** is the suite: plain `check(name, condition)` calls, no
  test framework, exit code 1 if anything fails. Probes that open IndexedDB
  directly call `indexedDB.open("patchbay")` with no version, so a schema bump
  in the app does not turn every probe into a `VersionError`.
- **`playwright.mjs`** finds Playwright locally or globally, or explains how to
  install it.

Port 8788, so `wrangler dev` can stay up on 8787 alongside. Override with `PORT`.

## What it asserts

Recent generations: a result reaching the strip; the split across the two stores
(a light record with the thumbnail and no image bytes, the image itself as an
`ArrayBuffer` under the same id in the other store); surviving a reopen; the
lightbox's metadata and prompt restore; reuse from the lightbox; eviction by
count and by age, deleting both halves; Clear emptying both stores; and the two
schema upgrades — a version-1 database keeping its session, and a version-2
gallery item having its image moved out rather than dropped, then still opening.

Eviction by count seeds sixty items straight into both stores rather than
generating them: sixty round trips through the UI would dominate the runtime,
and what is under test is the pruning that runs at boot.

The lightbox leak test counts live object URLs through an instrumented
`createObjectURL`/`revokeObjectURL` — the technique PR #33 used. It has been
checked against the unfixed code, where it fails: without the revoke on close, a
full-size image stays pinned after the lightbox is dismissed.

The byte ceiling is the one bound with no test: tripping it means allocating
150 MB inside a browser, and it shares its loop with the two bounds that are
covered.

Reuse as an input: the label for each target case, landing on the current model,
switching to the editing model and carrying the image, a full slot falling
through to that switch, the Options panel opening when the field lives there,
and a reused image surviving a reopen.

Session restore: model, prompt, numeric/enum/bool options, which options were
deliberately set (that flag decides what `/api/generate` actually sends, so the
payload is compared field-for-field before and after a reopen), the Options panel
state, single and multi-file uploads, a file in a mode-dependent field, a
restored upload's `File` identity and fresh provider encoding, Reset and a stale
model id clearing the snapshot, the ArrayBuffer fallback, blocked IndexedDB
leaving the app fully usable, and persistence across a browser restart rather
than just a new tab.

Prompt history: typing grouped per burst, Improve/Describe/saved-prompt/Reset as
single entries, redo cleared by a new edit, survival across a model switch, a
promptless model holding the history, and the desktop keyboard chords.

Plus: all 48 models render with sane undo state, and the phone-width layout has
no horizontal overflow.
