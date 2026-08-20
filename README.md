# 🎛️ Patchbay

Patchbay is a web front end for image and video generation and editing. It puts
39 image and video models from three providers behind one interface, adds 17
more for rewriting prompts and captioning images, and runs entirely on
Cloudflare Workers — no server to maintain, no build step, no framework.

| Provider | Models | Credentials |
|----------|--------|-------------|
| [Pruna AI](https://docs.api.pruna.ai/) | 23 models and 2 LoRA trainers | `PRUNA_API_KEY` |
| [xAI (Grok)](https://docs.x.ai/) | 5 | `XAI_API_KEY` |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/) | 11 image, 14 text, 3 vision | none |

## Features

**One picker for every provider.** Models are grouped by what they do and then
by who runs them — `Image generation · Pruna`, `Video · xAI` — so the provider
stays visible without splitting the list by vendor. It matters: the provider
decides what a model costs and which key it needs, and two of them ship a model
under the same name.

**Options panel.** Optional parameters are collapsed behind a panel, each one
pre-filled with the provider's default. Changed rows are marked with an accent
bar and carry their own Reset, and the panel header counts how many have been
touched.

**Prompt rewriting.** Any prompt can be expanded or tightened by one of 14
Workers AI chat models, then reverted in one click. Editing and image-to-video
prompts use a different instruction set from generation prompts: the rewriting
model never sees the source image, and without those constraints it invents
details that contradict it.

**Image captioning.** An attached image can be captioned by one of 3 Workers AI
vision models and the caption used as a starting prompt. Captioning reads
whichever image is already attached to the model's own fields, and only asks for
a file when there is none.

**Cost visibility.** Every model shows its list price up front. Once a run
finishes, what it cost is reported and added to a running session total — xAI
video jobs report the real figure they were billed, everything else is computed
from published rates. Workers AI is counted in neurons against the free daily
allowance, using Cloudflare's own reported usage where `/api/neurons` is
configured.

**Uploads.** Init images, edit references, start and end frames, masks, training
archives, and source video or audio are proxied to the relevant provider and
referenced by URL.

**No persistence.** Nothing is stored server-side. Generated media is served
`no-store`, so neither the browser nor Cloudflare's edge retains a copy.

**Credential isolation.** API keys live in Cloudflare secrets and never reach
the browser; every provider call is made by the Worker.

**Optional password gate.** When `APP_PASSWORD` is set, every route except
`/api/config` requires the matching header.

## Models

### Pruna — 23 models and 2 trainers

| Group | Models |
|-------|--------|
| Image generation | `flux-dev`, `flux-dev-lora`, `flux-2-klein-4b`, `qwen-image`, `qwen-image-fast`, `z-image-turbo`, `z-image-turbo-lora`, `p-image`, `p-image-lora`, `p-image-ideogram`, `wan-image-small` |
| Image editing | `qwen-image-edit-plus`, `p-image-edit`, `p-image-edit-lora`, `p-image-try-on`, `p-image-upscale` |
| Video | `wan-t2v`, `wan-i2v`, `p-video`, `p-video-animate`, `p-video-replace`, `p-video-avatar`, `vace` |
| LoRA trainers | `p-image-trainer`, `p-image-edit-trainer` |

Pruna's documentation counts the trainers separately from its models, and they
behave differently: a trainer emits a `.zip` of LoRA weights rather than media,
runs for minutes to hours, and its output link expires roughly 30 minutes after
it finishes. `p-image-trainer` produces weights for `p-image-lora`, and
`p-image-edit-trainer` for `p-image-edit-lora`.

LoRA variants (`*-lora`) take a weights URL and a strength scale, and several
ship quick-pick presets. `p-image-lora` and `p-image-edit-lora` accept only
weights from Pruna's own trainers; the remaining variants accept HuggingFace
URLs, and `z-image-turbo-lora` accepts any host.

### xAI / Grok — 5 models

| Model | Exposed as |
|-------|------------|
| `grok-imagine-image` | Grok Imagine Image |
| `grok-imagine-image-quality` | Grok Imagine Image Quality |
| `grok-imagine-image-2.0` | Grok Imagine Image 2.0 |
| `grok-imagine-video` | Grok Imagine Video |
| `grok-imagine-video-1.5` | Grok Imagine Video 1.5 |

The image models generate from text or edit up to three reference images.

Both video models carry a Mode switch — generate, edit an existing video, or
extend one — because each maps to a different endpoint (`/v1/videos/generations`,
`/edits`, `/extensions`) taking different inputs and priced differently. The
panel shows only the fields the selected mode accepts: editing takes no duration,
resolution or aspect ratio, since the output inherits them from the source video,
and extension's duration is the length of the added footage rather than the
total. Generating covers text-, image- and reference-to-video. Every video
request is asynchronous and polls to completion.

Version 1.5 is not a replacement for 1.0: it publishes a 1080p rate that 1.0 does
not, costs more per second, and can give its subject one of six preset voices.

### Cloudflare Workers AI — 28 models

**Image (11):** `flux-1-schnell`, `flux-2-klein-4b`, `flux-2-klein-9b`,
`flux-2-dev`, `lucid-origin`, `phoenix-1.0`, `stable-diffusion-xl-base-1.0`,
`stable-diffusion-xl-lightning`, `dreamshaper-8-lcm`, `stable-diffusion-v1-5-img2img`,
`stable-diffusion-v1-5-inpainting`

**Text, behind Improve (14):** Granite 4.0 Micro; Llama 3.2 1B, 3.2 3B, 3.1 8B,
4 Scout 17B and 3.3 70B; Qwen3 30B and QwQ 32B; GPT-OSS 20B and 120B; GLM 4.7
Flash; Mistral Small 24B; Nemotron 3 120B; DeepSeek R1 32B

**Vision, behind Describe (3):** LLaVA 1.5 7B, Moondream 3.1, Llama 3.2 11B
Vision

These run on Cloudflare's GPUs through the `AI` binding and need no API key of
their own. The free allowance is 10,000 neurons per day, and `/api/neurons`
reports consumption against it.

## Architecture

```
Browser (public/)  ──►  Cloudflare Worker (src/worker.js)  ──┬──►  Pruna AI API
   static UI                                                 ├──►  xAI API
                                                             └──►  Workers AI (env.AI)

   /api/config          catalog + auth flag                 (public)
   /api/generate        dispatches on the model's provider
   /api/status          polls async jobs (Pruna, xAI video)
   /api/upload          proxies file uploads
   /api/result          streams media back, adds credentials, no-store
   /api/improve-prompt  rewrites a prompt via Workers AI
   /api/describe        captions an image via Workers AI
   /api/neurons         current-day Workers AI neuron spend
```

`src/models.js` is the single source of truth for the catalog. The Worker uses
it to allow-list models and to serve `/api/config`; the browser renders its
entire UI from the same data. Each model carries a `provider` tag, and
`handleGenerate` dispatches on it.

### How jobs complete

Pruna image jobs are submitted with `Try-Sync`, which holds the connection until
the image is ready or 60 seconds pass, whichever comes first. Anything still
running falls back to polling. Video and LoRA training jobs poll from the start.

Polling continues for up to 10 minutes for images, 30 for video and 45 for
training. Passing that limit only stops the browser waiting — the job keeps
running on Pruna, and a trainer that outlasts the wait will still finish.

Workers AI runs synchronously and returns results inline, with no job to poll.

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

Inference is billed to whichever accounts the keys belong to. Workers AI usage
beyond the free daily allowance is billed to the Cloudflare account running the
Worker; Pruna and xAI bill their own.

## Local development

Place the same values in a git-ignored `.dev.vars` and run `npm run dev`:

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

## Installing as a PWA

A web manifest and touch icons are included, so the app can be installed to a
home screen and launches standalone without browser chrome. Installed instances
get their own storage context, so the password gate and any saved prompts are
scoped separately from the browser.

## Operational notes

- The app is served `noindex, nofollow`.
- The Worker proxies paid API credentials, so the password gate is advisable on
  any deployment whose URL might be discovered.
- Cloudflare secrets are write-only. Their names can be listed but their values
  cannot be read back, so a forgotten password has to be replaced rather than
  recovered.
- Changing the Worker name in `wrangler.jsonc` provisions a *new* Worker at a
  new URL rather than renaming the existing one. Secrets do not transfer, and
  the previous Worker keeps serving until it is explicitly deleted.

## License

[MIT](LICENSE)
