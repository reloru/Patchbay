# 🎛️ Patchbay

A single-user web app for **image & video generation and editing**, routing one
front end to **41 models across three providers**, deployed on **Cloudflare
Workers**.

| Provider | Models | Needs a key? |
|----------|--------|--------------|
| [Pruna AI](https://docs.api.pruna.ai/) | 24 | `PRUNA_API_KEY` |
| [xAI (Grok)](https://docs.x.ai/) | 6 | `XAI_API_KEY` |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/) | 11 | no — billed to your Cloudflare account |

- **Model picker** grouped by task, spanning all three providers.
- **Options panel.** Every optional parameter is visible and pre-filled with its
  real default. Changed rows get an accent bar and their own Reset; the summary
  carries an "N changed" badge. A value is only sent when it differs from what
  the provider would do on its own — so the defaults you see are the defaults
  you get.
- **Improve prompt.** Rewrites your prompt through one of 14 Workers AI chat
  models. Editing and image-to-video prompts use a different instruction set
  from generation prompts, because the improve model never sees your source
  image and will otherwise invent details that fight it.
- **Describe image.** Captions an upload via one of 3 Workers AI vision models.
- **File uploads** (init images, edit references, start/end frames, masks,
  source video/audio) are proxied to the provider and referenced by URL.
- **Spend tracking.** Per-model list prices in the UI, plus live Workers AI
  neuron usage against the free daily allowance.
- **No storage, no caching.** Nothing is persisted, and generated media is
  served `no-store`, so neither the browser nor Cloudflare's edge keeps a copy.
- **Credential-hiding proxy.** Your API keys live only in Cloudflare secrets and
  are never exposed to the browser.
- **Password gate** (optional) protects your paid credits from anyone who finds
  the URL.

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
   /api/neurons         today's Workers AI neuron spend
```

`src/models.js` is the single source of truth for the catalog. The Worker uses
it to allow-list models and to serve `/api/config`; the browser renders its UI
from the same data. Each model carries a `provider` tag, and `handleGenerate`
dispatches on it.

Image jobs are submitted with `Try-Sync: true` (fast path) and fall back to
polling; video jobs always poll `/api/status` until `succeeded`. Workers AI runs
synchronously — there is no job id to poll.

## Models included

### Pruna (24)

| Group | Models |
|-------|--------|
| Image generation | `flux-dev`, `flux-dev-lora`, `qwen-image`, `qwen-image-fast`, `z-image-turbo`, `z-image-turbo-lora`, `p-image`, `p-image-lora`, `flux-2-klein-4b`, `wan-image-small`, `p-image-ideogram` |
| Image editing | `qwen-image-edit-plus`, `p-image-edit`, `p-image-edit-lora`, `p-image-try-on`, `p-image-upscale` |
| LoRA training | `p-image-edit-trainer` |
| Video | `wan-t2v`, `wan-i2v`, `p-video`, `p-video-animate`, `p-video-replace`, `p-video-avatar`, `vace` |

LoRA variants (`*-lora`) accept a LoRA weights URL (HuggingFace for the
`p-image*` and `flux-dev-lora` models, any host for `z-image-turbo-lora`) plus a
strength scale, and several ship quick-pick presets. The `p-image-lora` /
`p-image-edit-lora` LoRAs must have been trained via Pruna's own trainers —
LoRAs from other sources aren't compatible with those two endpoints.

### Cloudflare Workers AI (11)

`cf-flux-1-schnell`, `cf-flux-2-klein-4b`, `cf-flux-2-klein-9b`, `cf-flux-2-dev`,
`cf-lucid-origin`, `cf-phoenix-1`, `cf-sdxl-base`, `cf-sdxl-lightning`,
`cf-dreamshaper-8`, `cf-sd15-img2img`, `cf-sd15-inpainting`

Run on Cloudflare's own GPUs and need no API key of their own. The free
allowance is 10,000 neurons/day; `/api/neurons` reports what you've used.

### xAI / Grok (6)

`xai-imagine-image`, `xai-imagine-image-quality`, `xai-imagine-image-2`,
`xai-imagine-video`, `xai-video-edit`, `xai-video-extend`

The image models generate, or edit up to 3 reference images. The video models
are asynchronous and poll to completion.

## Setup / deploy

Requirements: Node 18+, a Cloudflare account, and at least a Pruna API key.

```bash
npm install

# Required:
npx wrangler secret put PRUNA_API_KEY      # your Pruna API key

# Optional:
npx wrangler secret put XAI_API_KEY        # enables the xAI / Grok models
npx wrangler secret put APP_PASSWORD       # shared UI password gate
npx wrangler secret put CF_ACCOUNT_ID      # enables /api/neurons reporting
npx wrangler secret put CF_ANALYTICS_TOKEN # ditto — needs Account Analytics: Read

npm run deploy
```

Missing optional keys degrade gracefully: the models stay in the picker and
return a clear "not configured" error rather than breaking the app.

### Local dev

Put the same values in a git-ignored `.dev.vars` and run `npm run dev`:

```
# .dev.vars
PRUNA_API_KEY=pru_...
XAI_API_KEY=xai-...
APP_PASSWORD=your-password
```

The AI binding is marked `remote: true` in `wrangler.jsonc` because Workers AI
has no local emulation — without it every AI call fails with *"Binding AI needs
to be run remotely"*. It bills your account even in dev.

### Rotating a key later

No redeploy needed — secrets take effect immediately:

```bash
printf '%s' 'pru_your_new_key' | npx wrangler secret put PRUNA_API_KEY
```

Cloudflare's dashboard can also set secrets (Workers & Pages → your Worker →
Settings → Variables and Secrets), which is handy from a phone.

### Removing / changing the password gate

- Remove: `npx wrangler secret delete APP_PASSWORD` (the app becomes open).
- Change: `npx wrangler secret put APP_PASSWORD`.

Secrets are write-only — you can list their names but never read a value back,
so a forgotten password has to be replaced rather than recovered.

## Notes

- The app is `noindex, nofollow` and single-user by design.
- Because the Worker proxies your paid keys, keep the password gate on if the
  URL might be shared or discovered.
- Renaming the Worker in `wrangler.jsonc` creates a *new* Worker at a new URL
  rather than moving the existing one — secrets don't follow, and the old Worker
  keeps serving until deleted.
