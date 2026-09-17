# Tests

Two suites. The Worker's own routes, driven directly in Node; and the features
that live entirely in the browser — the on-device editing session and gallery
(IndexedDB) and the prompt undo history — driven in real browsers, because they
are about what a browser keeps.

```
npm test              # worker, then chromium, then webkit
npm run test:webkit   # worker, then one engine
npm run test:worker   # worker only — no Playwright needed
```

The Worker suite runs first. It needs no browser and finishes in under a second,
so a broken password gate does not cost a full Playwright run to discover.

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

- **`worker.test.mjs`** imports `src/worker.js` and calls its fetch handler with
  a fake `env`. No browser, no network, no keys: the Workers globals these routes
  need — `Request`, `Response`, `crypto.subtle`, `btoa` — are all in Node 18+.
  This is the only place the real media-token signing can be tested, because the
  browser suite runs against a stub of that same file.
- **`run.mjs`** runs the Worker suite, starts the stub server, runs
  `session.test.mjs` once per engine in its own process, and stops the server.
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

The Worker: `/api/config` answering ahead of the gate; the gate refusing a
missing or wrong password; a token minted only behind the header; the token
accepted on `/api/result` and rejected once expired, when its expiry is pushed
out, when it was signed under a different password, when it is malformed, and on
every other route; the old `?pw=` query param no longer being accepted at all;
and an unknown model id refused by `/api/generate`.

Recent generations: a result reaching the strip; the split across the two stores
(a light record with the thumbnail and no media bytes, the media itself as an
`ArrayBuffer` under the same id in the other store); surviving a reopen; the
lightbox's metadata and setup restore; reuse from the lightbox; eviction by
count and by age, deleting both halves; Clear emptying both stores; and the two
schema upgrades — a version-1 database keeping its session, and a version-2
gallery item having its image moved out rather than dropped, then still opening.

Video: a video result rendering as a player and being archived with `kind` set;
its bytes landing in the other store; the settings riding along; the strip
counting and badging it; and the lightbox opening it as a `<video>` rather than
an `<img>`. Also that the per-kind caps hold — forty seeded clips prune to
twenty-five without costing the images beside them anything, which is the whole
reason the budgets are separate.

The stub answers a video model with PNG bytes under a video content type: it has
no encoder, and that is enough for everything above. It also puts the poster
frame through `videoThumb`'s "will not decode" branch, which has to leave the
archive intact rather than fail it — worth covering in its own right.

Restore setup: switching back to the model that produced a result, restoring the
prompt and a changed option, keeping that option's deliberately-set flag, and
then sending the same payload the original run did. The flag is the point — it
alone decides whether a value equal to the default is still sent.

Stop: the button appearing only while a job is in flight, Generate held and then
released, the status saying the job is still running, and — the assertion that
matters — the job record surviving, so the next load picks the result up. A stop
that cleared the record would be a loss, not a stop.

Judge: that scoring a generation re-reads nothing through `/api/result`. The
bytes were captured when the result rendered and then never used, so every
scoring paid for a second transfer and failed outright once the delivery URL had
expired.

Describe: no `question` key sent when the box is empty, so the Worker's own
captioning instruction stands; a typed question reaching the Worker and being
named in the note line first.

Progress: a synchronous model reporting a rising elapsed count *while* it runs
rather than only at the end, worded as Generating; the ticker stopping once the
run settles; on a polled model, the count never restarting when polling takes
over from submitting; and the count keeping up while a poll hangs, within two
seconds of real time, where it used to sit frozen at whatever the last poll
said. `/__delay` holds `/api/generate` open to make that window exist — a
synchronous model has no other, since the run *is* that one request — and
`/__statusdelay` hangs each poll, standing in for a slow provider, a stalled
connection, or a suspended iOS tab where `setTimeout` stops firing at all. The stub also answers Workers AI and xAI image models with a finished
image rather than a job id, because returning an id for them would let the
polling loop cover a path production does not have.

Eviction by count seeds items straight into both stores rather than generating
them: two hundred round trips through the UI would dominate the runtime, and
what is under test is the pruning that runs at boot.

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
