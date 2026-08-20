# 🎛️ Patchbay

Patchbay is a web front end for image and video generation and editing. It
routes a single interface to 41 models across three providers and runs entirely
on Cloudflare Workers — no server to maintain, no build step, no framework.

| Provider | Models | Credentials |
|----------|--------|-------------|
| [Pruna AI](https://docs.api.pruna.ai/) | 24 | `PRUNA_API_KEY` |
| [xAI (Grok)](https://docs.x.ai/) | 6 | `XAI_API_KEY` |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/) | 11 | none |

## Features

**Unified model picker.** Models from all three providers appear in one list,
grouped by task rather than by vendor.

**Options panel.** Every optional parameter is visible and pre-filled with its
real default. Modified rows are marked with an accent bar and an individual
Reset control, and the panel header shows a count of what has changed. A
parameter is transmitted only when it differs from the provider's own default,
so the displayed defaults match what is actually sent.

**Prompt rewriting.** A prompt can be expanded or tightened by one of 14 Workers
AI chat models. Editing and image-to-video prompts use a separate instruction
set from generation prompts: the rewriting model never sees the source image,
and without those constraints it invents details that contradict it.

**Image description.** An uploaded image can be captioned by one of 3 Workers AI
vision models, and the caption used as a starting prompt.

**Uploads.** Init images, edit references, start and end frames, masks, and
source video or audio are proxied to the relevant provider and referenced by
URL.

**Cost visibility.** List prices are shown per model, alongside live Workers AI
neuron consumption against the free daily allowance.

**No persistence.** Nothing is stored server-side. Generated media is served
`no-store`, so neither the browser nor Cloudflare's edge retains a copy.

**Credential isolation.** API keys are held in Cloudflare secrets and are never
exposed to the browser; all provider calls are made by the Worker.

**Optional password gate.** When `APP_PASSWORD` is set, every route except
`/api/config` requires the matching header.

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

Image jobs are submitted with `Try-Sync: true` and fall back to polling; video
jobs always poll `/api/status` until `succeeded`. Workers AI runs synchronously
and returns no job id.

## Models

### Pruna (24)

| Group | Models |
|-------|--------|
| Image generation | `flux-dev`, `flux-dev-lora`, `qwen-image`, `qwen-image-fast`, `z-image-turbo`, `z-image-turbo-lora`, `p-image`, `p-image-lora`, `flux-2-klein-4b`, `wan-image-small`, `p-image-ideogram` |
| Image editing | `qwen-image-edit-plus`, `p-image-edit`, `p-image-edit-lora`, `p-image-try-on`, `p-image-upscale` |
| LoRA training | `p-image-edit-trainer` |
| Video | `wan-t2v`, `wan-i2v`, `p-video`, `p-video-animate`, `p-video-replace`, `p-video-avatar`, `vace` |

LoRA variants (`*-lora`) take a weights URL and a strength scale, and several
ship quick-pick presets. `p-image-lora` and `p-image-edit-lora` require LoRAs
trained with Pruna's own trainers; weights from other sources are not compatible
with those two endpoints. The remaining variants accept HuggingFace URLs, and
`z-image-turbo-lora` accepts any host.

### Cloudflare Workers AI (11)

`cf-flux-1-schnell`, `cf-flux-2-klein-4b`, `cf-flux-2-klein-9b`, `cf-flux-2-dev`,
`cf-lucid-origin`, `cf-phoenix-1`, `cf-sdxl-base`, `cf-sdxl-lightning`,
`cf-dreamshaper-8`, `cf-sd15-img2img`, `cf-sd15-inpainting`

These run on Cloudflare's GPUs via the `AI` binding and need no API key of their
own. The free allowance is 10,000 neurons per day; `/api/neurons` reports
consumption against it.

### xAI / Grok (6)

`xai-imagine-image`, `xai-imagine-image-quality`, `xai-imagine-image-2`,
`xai-imagine-video`, `xai-video-edit`, `xai-video-extend`

The image models generate, or edit up to 3 reference images. The video models
are asynchronous and poll to completion.

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

Absent optional credentials degrade gracefully: the affected models remain in
the picker and return an explicit "not configured" error rather than failing
elsewhere.

Secrets take effect immediately and need no redeploy:

```bash
printf '%s' 'pru_...' | npx wrangler secret put PRUNA_API_KEY
```

They can also be set from the Cloudflare dashboard, under Workers & Pages →
Settings → Variables and Secrets.

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
receive their own storage context, so the password gate and any saved prompts
are scoped separately from the browser.

## Operational notes

- The app is served `noindex, nofollow`.
- The Worker proxies paid API credentials, so the password gate is advisable on
  any deployment whose URL may be discovered.
- Cloudflare secrets are write-only. Their names can be listed but their values
  cannot be read back, so a forgotten password must be replaced rather than
  recovered.
- Changing the Worker name in `wrangler.jsonc` provisions a *new* Worker at a
  new URL rather than renaming the existing one. Secrets do not transfer, and
  the previous Worker keeps serving until explicitly deleted.

## License

[MIT](LICENSE)
