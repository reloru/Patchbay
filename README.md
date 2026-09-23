<p align="center">
  <img src=".github/assets/social-preview.png" alt="Patchbay" width="640" />
</p>

Patchbay is a web front end for image and video generation and editing. It puts
50 models from three providers behind one interface and runs entirely on
Cloudflare Workers — no server to maintain, no build step, no framework.

| Provider | Models | Credentials |
|----------|--------|-------------|
| [Pruna AI](https://docs.api.pruna.ai/) | 32 | `PRUNA_API_KEY` |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/) | 13 | none |
| [xAI (Grok)](https://docs.x.ai/) | 5 | `XAI_API_KEY` |

A further 39 models run behind the prompt tools rather than appearing in the
picker: 30 Workers AI chat models rewrite prompts and hold the chat, 9 Workers
AI vision models caption images (6 of them are also among the 30, and can see
the attached image in the chat), 7 embedding models measure text in the
Embeddings panel, and Pruna's `p-judger` scores an image against a prompt.

## Features

**One picker, grouped by task.** Models are filed under Image editing, Image
generation, Video, Audio and LoRA training, each split by provider — provider decides
what a model costs and which key it needs, and two of them ship FLUX.2 Klein 4B
under the same name.

**Options panel.** Every optional parameter is visible and pre-filled. Modified
rows get an accent bar and their own Reset, and the header counts what has
changed. A parameter is sent only when it differs from the provider's default,
so what you see is what the provider would do anyway.

**Mode switching.** Grok's video model reaches three different endpoints —
generate, edit, extend. Picking a mode changes which fields apply, and fields
belonging to another mode are never sent.

**Prompt rewriting.** Improve runs the prompt through one of 30 Workers AI chat
models as a copy edit: grammar, phrasing and punctuation only. It adds nothing,
drops nothing, keeps your pronouns and your grammatical mood, and avoids commas,
which image models read as tag separators rather than punctuation. The result
reaches the prompt box exactly as the model produced it — the Worker does not
rewrite it afterwards. Reverting a rewrite is the prompt Undo button's job, so
the button stays Improve rather than turning into a one-shot undo of its own.

**Image description.** Describe captions whatever image is already attached,
with one of 9 Workers AI vision models, and drops the caption into the prompt
box as a starting prompt (one Undo step). It only opens a file picker when
nothing is attached.

**Chat.** A conversation about the prompt sits under the toolbar: a thread,
a multi-line box where Enter adds a line, and a Send button. Every message
sends the whole thread, so the model remembers the conversation, and the
thread stays on this device until *New chat*. With *Include the prompt box and
attached image* on, the newest message also carries the prompt box text and,
for a model marked 👁, the attached image. Any reply can be put in the prompt
box as one Undo step, and each shows the neurons it actually used, as reported
by Cloudflare. It talks to the same 30 chat models as Improve; LLaVA,
Moondream and Llama 3.2 Vision cannot hold a conversation and stay behind
Describe.

**⚙ settings, on this device.** A ⚙ beside the Improve picker and the chat's
model picker opens that tool's settings: its instruction (shared by all its
models, with *Reset instruction to default*), and for the picked model a token
limit with the most a reply can cost at it, plus Thinking and Reasoning effort
where the model's schema takes them — DeepSeek V4, Gemma 4, GLM 4.7 Flash and
5.x, Kimi and Qwen 3.8 take both, Nemotron takes thinking only, the rest take
neither. Nothing is stored server-side: the settings live in this browser and
ride along with each request, and the Worker caps them (instruction 4,000
characters, token limit 16–8,000). An orange ⚙ means the picked model has
something set.

**Translate.** Two language pickers and 🌐 Translate rewrite the prompt box
into another language with Meta's m2m100 (English, Spanish, French, German,
Portuguese, Russian, Arabic, Hindi, Chinese, Japanese — the languages
Cloudflare lists for it). Undo brings the original back.

**Speaking to the chat.** 🎤 beside Send records a message and transcribes it
into the chat box — added, not sent, so it can be corrected first. Tap ■ to
stop. Where a browser cannot record, it opens a picker for a recording
instead. The model is chosen in the chat's ⚙: Whisper Large v3 Turbo (the
default), Whisper, Whisper Tiny EN or Deepgram Nova-3, each sent the audio in
the form its schema documents. All four transcribed both an iPhone-style
AAC/MP4 clip and a WebM/Opus clip in testing. Deepgram Flux is not offered:
Cloudflare serves it over a WebSocket only.

**Other.** A collapsed section for the catalogue models that fit nowhere else:
a safety check with Llama Guard 3 8B, sentiment with DistilBERT SST-2, image
labels with ResNet-50 (on the attached image, or a picked one), and ranking
passages against a query with the BGE reranker.

**Embeddings.** A panel of its own, with its own text box: write something,
change it, and watch the numbers move. About a second after you stop typing
the text is measured by one of 6 Workers AI embedding models, which turns it
into a list of numbers placed by meaning (384 to 2,048 of them, by model).
Each version shows how close it is to the baseline — the first version, or
any you set — and to the version before it, on a 0–1 scale, and draws its
numbers as a barcode with a second strip for what changed since the previous
version. Pause stops the automatic measuring; Measure now works either way.
Versions are kept on this device, separately per model, since lists from
different models cannot be compared. Each request follows the model's
documented schema: `contexts` for BGE M3, `cls` pooling for the English BGE
models, as Cloudflare recommends. A measurement costs about a tenth of a
neuron.

**Prompt-match scoring.** Judge runs Pruna's `p-judger` over an image and
returns how well it matches the prompt. It scores the image you just generated
if one is on screen, otherwise the one attached to the model's inputs, and the
note under the toolbar always says which — with an inline link to a file picker
for anything else, which also reaches batch mode (up to 10 images against a
shared prompt). The score lands under the toolbar rather than in the output
panel, so scoring a generation does not clear the generation.

**Uploads.** Init images, edit references, start and end frames, masks, and
source video or audio are proxied to the provider and referenced by URL.

**Reuse an output as an input.** A finished image can go straight back in as
the thing to edit or as a reference, without a trip through the camera roll.
The button names its target before you press it — Edit this when the image
becomes an editing model's subject, Use as reference when it joins a prompt,
and Edit in P-Image-Edit when the current model has nowhere to put it, which
switches and carries the image across. The receiving field is scrolled into
view and named in the status line, and the Options panel opens if that is where
the field lives, so the tap never reads as having done nothing. A reused image
is an ordinary upload from there on: it gets the provider encoding that model
needs, and the saved session keeps it.

**Cost visibility.** List prices per model, live estimates that follow your
settings, and Workers AI neuron consumption against the free daily allowance.
The account is on Workers Paid, where use past the 10,000 free neurons is
billed at $0.011 per 1,000 rather than refused, so the meter turns amber at
8,000 and red at 10,000, and past that shows the overage and what it has cost
today.

**How long this normally takes.** A bare "Processing… 200s elapsed" is
indistinguishable from a hang, which is exactly how a correct run of a
multi-minute model reads. Every run the app watches start to finish is timed,
and the median of the last few for that model is shown alongside the elapsed
count. Measured rather than catalogued, because a hand-set figure existed for
one model out of 48 and a measured one describes this account, this device and
this connection. A run collected on reload is not counted — its elapsed time is
measured from reattaching and says nothing about the model.

The count is driven by its own clock rather than by the polling, and repaints
the moment the tab comes back. The status line used to be written only when a
poll returned, so a slow provider, a stalled connection or an iOS tab suspended
in the background left it frozen at whatever it last said — reading eight
seconds after three real minutes, which is worse than no count at all, since it
says the job has barely started.

It runs from the moment you press Generate, on one clock, whatever the model
does underneath. Sixteen of them never get a job id — Workers AI and
xAI's image endpoints run the whole generation inside a single request and
answer with the finished picture — so there is nothing to poll and nothing was
driving the status line: it held "Submitting…" for the entire run and then
jumped to the finished time. Those now count up from this side and say
*Generating* rather than *Submitting*, since that is what is happening. On a
polled model the submit leg and the polling share the same clock, so the count
does not restart at the handover.

**Resilient requests.** Dropped connections are retried, except where a retry
could bill twice — a generation that may already have reached the provider is
reported rather than repeated. That includes pulling the finished result down,
which is the largest transfer the app makes: losing those bytes costs the
archive too, since nothing is kept without them.

**Prompt undo/redo.** Undo and Redo buttons in the prompt toolbar cover the main
prompt box and nothing else. Typing is grouped into one entry per burst rather
than one per keystroke, and an Improve rewrite, a Describe caption, a loaded
saved prompt or a Reset is a single entry, so one press reverses the whole
replacement. Editing after an undo drops the redo tail, as it does in any
editor. The history is text rather than a handle on the element it was typed
into, so it survives switching models and a Reset; a model with no prompt field
holds it rather than dropping it, and the buttons come back with the next model
that has one. History is in memory only. `Cmd`/`Ctrl`+`Z` and
`Shift`+`Cmd`/`Ctrl`+`Z` work on a desktop keyboard while the prompt has focus;
the buttons exist because iOS offers no undo gesture that reaches a web
textarea.

**Session restore.** iOS discards a backgrounded PWA whenever it needs the
memory, and reopening it is a cold start. The current edit — attached files,
prompt text, selected model, and every option including which were deliberately
set — is kept in IndexedDB on the device and put back on the next load. Files are
stored as binary (which is what rules localStorage out) and come back as real
`File` objects, re-encoded for whichever provider the model uses, since last
session's upload URL has expired. Writes are debounced rather than hung off
`beforeunload`, which iOS does not fire for a page it is discarding. The file
half of the record is only rewritten when the set of attached files changes.
Blocked site data, Lockdown Mode or a full quota costs the restore and nothing
else.

**Recent generations.** Finished images *and videos* are kept on the device, so
one you did not save in the moment is not gone: the strip under the output opens
any of them full size — a clip in a player, with its own poster frame in the
strip — to save, to send back in as an input, or to put the whole setup that
produced it back on screen. Clear empties it immediately.

Bounded by count, age and bytes, but **per kind**, because the two are nothing
alike: one clip outweighs a hundred stills, and under a single shared ceiling it
would evict them. Images get 200 items and 1 GB, video 25 clips and 4 GB, both
for seven days — the same clock as the saved session. Those ceilings are far
inside what the engine allows, so the real risk is eviction rather than quota,
and the app asks for [persistent
storage](https://webkit.org/blog/14403/updates-to-storage-policy/) on load:
WebKit evicts a best-effort origin under storage pressure and after a spell
without interaction, and only persistent mode is exempt.

A trained LoRA `.zip` is not kept. It is not previewable, and its link expires
about half an hour after the run either way.

Clear does not disturb a generation in progress. It leaves the status line to
the run rather than writing over it, and an archive write already under way
when you clear is dropped rather than landing afterwards in the strip you just
emptied — while a result that finishes later is still kept.

Stored as `ArrayBuffer`s rather than Blobs: WebKit aborts an IndexedDB
transaction outright for any value containing a Blob, which is how the session
store shipped broken once.

Each item is two records in two stores, for the same reason the session record
is split: the strip redraws on every generation and must not pay for bytes it
never displays. The light record is a thumbnail, the settings, and the rest of
the metadata, on the order of 20 KB; the media itself lives in a second store
and is read only to open, reuse or save it. Before that split, drawing the strip
deserialised every stored image in full — the cost scaled with the size of the
library rather than with the number of thumbnails, which is what kept the cap at
twelve.

**Repeat a past run.** Each stored result carries the settings that made it —
the model, the prompt, every option, and which options were deliberately set,
since that last flag alone decides whether a value equal to the default is still
sent. Restore puts all of it back. Restoring onto the model already selected
keeps whatever is attached; switching cannot, and says so, because the input
files are not stored alongside the output.

**Stop waiting.** A generation used to hold the UI for as long as it ran — up to
45 minutes for a training run — with no way out but closing the tab. Stop ends
the waiting, not the job: Pruna documents no cancel endpoint, so the run
continues and is billed either way, and the job record is deliberately kept so
the next load reattaches through the path a discarded tab already uses.

**No server-side persistence.** Nothing is stored server-side. Generated media
is served `no-store`, so neither the browser nor Cloudflare's edge keeps a copy
in transit. What the browser keeps — the session above, the recent results and
their settings, saved prompts, measured runtimes, the running job's id — never
leaves the device.

**Job recovery.** A phone can discard the tab mid-generation to reclaim memory,
and the provider job keeps running and billing regardless. The running job's
id is kept in this browser — id and model only, never the input or the output —
so the next load reattaches, polls it to completion and shows the result rather
than paying for output nobody sees. The media still streams from the provider on
demand; the `input` object is deliberately excluded, since Workers AI and xAI
models carry base64 and `data:` URI images inline. A record is discarded once
collected, once the job definitively fails, or after an hour (six for training
runs, which legitimately take that long).

**Credential isolation.** API keys live in Cloudflare secrets and never reach
the browser. Every provider call is made by the Worker.

**Optional password gate.** With `APP_PASSWORD` set, every route except
`/api/config` requires the matching header. `<img>`, `<video>` and download
links cannot send a header, and the answer is a short-lived token rather than
the password: `/api/token` signs a ten-minute expiry with HMAC-SHA256 keyed by
`APP_PASSWORD`, and `/api/result` takes that. The password itself used to travel
in the query string, which meant Cloudflare's observability recorded it on every
image the app loaded. The token is good for `/api/result` alone, and moving its
expiry breaks its own signature.

## Architecture

```
Browser (public/)  ──►  Cloudflare Worker (src/worker.js)  ──┬──►  Pruna AI API
   static UI                                                 ├──►  xAI API
                                                             └──►  Workers AI (env.AI)

   /api/config          catalog + auth flag                 (public)
   /api/token           short-lived signed token for /api/result
   /api/generate        dispatches on the model's provider
   /api/status          polls async jobs (Pruna, xAI video)
   /api/upload          proxies file uploads
   /api/result          streams media back, adds credentials, no-store
   /api/improve-prompt  copy-edits a prompt via Workers AI
   /api/describe        captions an image via Workers AI
   /api/chat            the chat thread, via Workers AI
   /api/embed           embeds text for the Embeddings panel
   /api/translate       translates the prompt via m2m100
   /api/transcribe      speech to text for the chat's 🎤
   /api/other           the Other section's tools
   /api/judge           scores an image against a prompt via Pruna p-judger
   /api/neurons         current-day Workers AI neuron spend
```

`src/models.js` is the single source of truth. The Worker uses it to allow-list
models and to serve `/api/config`; the browser renders its entire UI from the
same data. Each model carries a `provider` tag and `handleGenerate` dispatches
on it, so adding a model is usually a catalog edit alone.

Every Pruna job — image, video, and training — is submitted async and polled
via `/api/status` until it finishes. Try-Sync is deliberately not used for
this: it runs the whole generation inside a single request, and a job only
gets an id (and therefore becomes resumable) on the *fallback* response, never
on a synchronous success — so closing the app during that window loses the
run outright rather than merely interrupting it. Workers AI and xAI's
synchronous image endpoints run in one request each and return no job id;
that is a genuine limit of those two providers, not something this app can
poll around.

## Models

### Pruna (32)

| Group | Models |
|-------|--------|
| Image editing | `p-image-edit`, `p-image-edit-lora`, `p-image-edit-text-aware`, `p-image-rmbg`, `p-image-try-on`, `p-try-on-glasses`, `p-image-upscale`, `qwen-image-edit-plus` |
| Image generation | `flux-dev`, `flux-dev-lora`, `flux-2-klein-4b`, `qwen-image`, `qwen-image-fast`, `z-image-turbo`, `z-image-turbo-lora`, `z-image-turbo-small`, `p-image`, `p-image-lora`, `p-image-ideogram`, `wan-image-small` |
| Video | `wan-t2v`, `wan-i2v`, `p-video`, `p-video-edit`, `p-video-2`, `p-video-infiniteworlds`, `p-video-animate`, `p-video-replace`, `p-video-avatar`, `vace` |
| LoRA training | `p-image-trainer`, `p-image-edit-trainer` |

`p-video-edit` rewrites an existing clip from a text prompt, with up to 4
optional reference images to guide identity or style. The source may be at most
15 seconds and the output runs the same length, so it is billed per second of
that length — $0.045, or $0.025 in draft mode — and the estimate comes from the
duration the browser reads off your clip when you pick it.

`p-video-2` takes the same inputs as `p-video` at roughly a 25% premium, and its
Length box is blank by default: leave it that way and the model picks the length
from the prompt. Nothing can be estimated in that case, and no estimate is shown
rather than a guessed one. Where audio is attached to `p-video`, `p-video-2` or
`p-video-infiniteworlds`, the track sets the length and therefore the bill, so
the browser reads its duration and prices from that instead of the Length box.

`p-image-rmbg` returns a transparent PNG and takes exactly one input, the image
— no options at all. `p-image-edit-text-aware` routes to whichever edit model
suits the input, which changes the price: $0.01 per output, or $0.03 when it
detects text in the image. That decision happens during the run, so the app
shows the range up front and no per-run estimate. Its `turbo` is left at Pruna's
documented default of on, unlike `p-image-edit`, where this repo deliberately
forces it off.

**`p-image-pro` is documented but not included.** As of 2026-09-08 every call to
it — including a bare prompt — is refused before input validation with
`422 Deployment disabled`. Listing a model that cannot run is worse than leaving
it out; `src/models.js` carries a comment with its full parameter set and price
so it can be restored when Pruna enables the deployment.

`p-judger` is a Pruna model too, but it scores rather than generates, so it sits
behind the Judge button instead of in the picker. Its documentation describes a
score object carrying `total`, `level1`, `level2`, `level3` and `detailed`; as
of 2026-09-08 the endpoint returns `total` alone and rejects any undocumented
input key, so the UI headlines `total` and keeps the whole payload one tap away
rather than assuming the shape. The scale is not documented, so the score is
rendered as a bare number — no bar, no percentage.

LoRA variants (`*-lora`) take a weights URL and a strength scale, and several
ship quick-pick presets. `p-image-lora` and `p-image-edit-lora` require weights
from Pruna's own trainers; other sources are rejected by those two endpoints.
The remaining variants accept HuggingFace URLs, and `z-image-turbo-lora` accepts
any host.

The two trainers emit a `.zip` of weights rather than an image, and are billed
per 1,000 training steps. A run takes minutes to hours and its output link
expires about 30 minutes after it finishes.

### Cloudflare Workers AI (13)

`cf-flux-1-schnell`, `cf-flux-2-klein-4b`, `cf-flux-2-klein-9b`, `cf-flux-2-dev`,
`cf-lucid-origin`, `cf-phoenix-1`, `cf-sdxl-base`, `cf-sdxl-lightning`,
`cf-dreamshaper-8`, `cf-sd15-inpainting`, `cf-aura-2-en`, `cf-aura-2-es`, `cf-aura-1`

These run on Cloudflare's GPUs through the `AI` binding and need no key of their
own. The free allowance is 10,000 neurons per day; `/api/neurons` reports
consumption against it.

`cf-sd15-img2img` was removed on 2026-09-23: the account is refused it with
`403 / 5018`, and Cloudflare no longer lists it. That left SD 1.5 Inpainting
alone under Workers AI Image editing, so it is filed with the other Workers AI
image models instead.

**Text to speech.** Deepgram's Aura-2 (English and Spanish) and Aura-1 turn
text into an MP3, which plays in the output panel and can be saved or sent
into a video model's audio track. The same voices are available without
leaving a video model: every audio field has a *Generate voice* panel that
speaks the text and attaches the result as that field's file. Aura bills per
character — about 2,727 neurons per 1,000 characters for Aura-2 and half that
for Aura-1, so a 1,000-character script is over a quarter of the daily free
allowance — and the estimate under the text follows it as you type.
MeloTTS is documented but not offered: on 2026-09-23 it answered every call
with `500 / 3043: Internal server error`. Generated audio is not kept in the
Recent strip, which holds images and video only.

**Workers Paid models.** Cloudflare gates seven Workers AI models behind the
paid plan, all of them chat models: DeepSeek V4 Flash and Pro, GLM 5.2, 5.3
and 5.3 Flash, Kimi K2.6 and K2.7 Code. They sit behind Improve, and GLM 5.3
Flash and Kimi K2.7 Code behind Describe too; their notes say *Workers Paid*.
They draw on the same neuron allowance as everything else. Kimi K2.6 is
deliberately not offered for Describe — on an image it ran past a
4,000-token budget without finishing, at about 15% of the daily allowance.

Several of the newer reasoning models need a request knob to return anything
at all within budget — thinking switched off, or a low reasoning effort — and
each is declared per model in `src/models.js` with the measurement that
settled it. Their neuron figures are measured from a live run rather than
computed from list rates, because the reasoning tokens bill as output.

### Workers AI model identity

Labels are readable but keep every version detail; the ⚙ panel shows each
model's exact Cloudflare id. Cloudflare's pricing page and its model catalogue
(the 65 models its model-search API returns for this account) do not agree,
and some ids resolve to a different model than their name says — a chat reply
carries the `model` that actually answered. As checked on 2026-09-23:

- `@cf/mistral/mistral-7b-instruct-v0.1` answers as
  `@cf/mistral/mistral-7b-instruct-v0.2-lora`, so the app uses the v0.2 id.
- `@cf/meta/llama-3.1-8b-instruct-fp8-fast` answers as
  `@cf/meta/llama-3.1-8b-fast-v2`, which the app now calls directly. Neither id
  is in the catalogue.
- `@cf/moonshotai/kimi-k2.5` answers as `@cf/moonshotai/kimi-k2.6`, which the
  app already has, so it was removed.
- `@cf/meta/llama-3.1-70b-instruct-fp8-fast` is on the pricing page but not in
  the catalogue, and its reply format carries no model name.
- Mistral Small 3.1 is not flagged as vision in the model API, but its
  catalogue page says it is and it read a test image correctly, so it is
  offered for images.
- Mistral 7B v0.2, Gemma 2B, Gemma 7B and EmbeddingGemma have no published
  rate. Measured once each: Gemma 2B about 1 neuron per token, Gemma 7B and
  Mistral 7B v0.2 near zero; EmbeddingGemma reports no usage.
- Reasoning effort is offered per model with exactly the values Cloudflare
  lists for it; a value outside that list is rewritten on Cloudflare's side,
  and GLM 5.3 turns "medium" into "max".

### xAI / Grok (5)

`xai-imagine-image`, `xai-imagine-image-quality`, `xai-imagine-image-2`,
`xai-imagine-video`, `xai-imagine-video-1-5`

The image models generate, or edit up to 3 reference images. Both video models
are asynchronous and poll to completion, and each covers three endpoints through
its Mode field:

- **Generate** — text-to-video, or image-to-video with a starting image, or
  reference-to-video with up to 3 reference images. On 1.5 a preset voice can be
  added, tagged in the prompt as `<AUDIO_0>`.
- **Edit** — changes an existing video. Length, resolution and aspect ratio are
  inherited from the source, so those fields do not apply.
- **Extend** — continues an existing video. Its duration is the length of the
  added footage, not the total.

`grok-imagine-video-1.5` is not a straight upgrade: it publishes a 1080p rate
that 1.0 does not and accepts preset voices, but costs more per second.

## Deployment

Requires Node 18+ and a Cloudflare account.

```bash
npm install

# Required
npx wrangler secret put PRUNA_API_KEY      # Pruna API key

# Optional
npx wrangler secret put XAI_API_KEY        # enables the xAI / Grok models
npx wrangler secret put APP_PASSWORD       # enables the password gate
npx wrangler secret put CF_ACCOUNT_ID      # enables /api/neurons reporting
npx wrangler secret put CF_ANALYTICS_TOKEN # requires Account Analytics: Read

npm run deploy
```

Missing optional credentials degrade gracefully: the affected models stay in the
picker and return an explicit "not configured" error rather than failing
somewhere less obvious.

Secrets take effect immediately and need no redeploy:

```bash
printf '%s' 'pru_...' | npx wrangler secret put PRUNA_API_KEY
```

They can also be set from the Cloudflare dashboard, under Workers & Pages →
Settings → Variables and Secrets.

## Local development

Put the same values in a git-ignored `.dev.vars` and run `npm run dev`:

```
# .dev.vars
PRUNA_API_KEY=pru_...
XAI_API_KEY=xai-...
APP_PASSWORD=...
```

The `AI` binding is declared `remote: true` in `wrangler.jsonc` because Workers
AI has no local emulation — without it every AI call fails with `Binding AI
needs to be run remotely`. Inference during local development is billed
normally.

## Tests

`npm test` runs the Worker's own tests, then drives the browser features in real
browsers — Chromium and WebKit — against a stub of the Worker, so no API keys
are needed and nothing is billed. 33 Worker tests, then 240 assertions per
engine.

The Worker tests need no browser and take under a second, so they run first: a
broken password gate should not cost a full Playwright run to discover. They are
`node --test` over `src/worker.js` directly, driving its fetch handler with a
fake `env` — which is the only place the real token signing can be exercised,
since the browser suite runs against a stub of exactly that file.

    npm run test:worker   # just those, no Playwright needed

Run both engines. These features are about what a browser keeps, and a
Chromium-only run once reported the session restore working while Safari's engine
was silently failing to store the uploads. Playwright is needed and is
deliberately not a dependency of this repo; `test/README.md` explains why and how
to install it.

## Installing as a PWA

A web manifest and touch icons are included, so the app installs to a home
screen and launches without browser chrome. Installed instances get their own
storage context, so the password gate and saved prompts are scoped separately
from the browser.

## Operational notes

- The app is served `noindex, nofollow`.
- The Worker proxies paid API credentials, so the password gate is advisable on
  any deployment whose URL might be discovered.
- Cloudflare secrets are write-only. Their names can be listed but their values
  cannot be read back, so a forgotten password has to be replaced rather than
  recovered.
- Changing the Worker name in `wrangler.jsonc` provisions a *new* Worker at a
  new URL rather than renaming the existing one. Secrets do not transfer, and
  the previous Worker keeps serving until it is deleted.

## License

[MIT](LICENSE)
