# 🍊 Pruna Studio

A single-user web app for **image & video generation and editing** using the
[Pruna AI API](https://docs.api.pruna.ai/), deployed on **Cloudflare Workers**.

- **Model picker** with 16 image / video models grouped by task, including LoRA variants.
- **Per-model, per-parameter toggles** — every optional parameter (quality,
  duration/frames, aspect ratio, resolution, guidance, steps, seed, *disable
  safety checker*, etc.) has an "override" switch. Only the parameters you
  turn on are sent; everything else uses Pruna's defaults.
- **File uploads** (init images, edit references, start/end frames, masks,
  source video/audio) are proxied to Pruna's `/v1/files` and referenced by URL.
- **No storage, no caching.** Nothing is persisted, and generated media is
  served `no-store` so neither the browser nor Cloudflare's edge keeps a copy.
- **Credential-hiding proxy.** Your Pruna API key lives only in a Cloudflare
  secret and is never exposed to the browser.
- **Password gate** (optional) protects your Pruna credits from anyone who
  finds the URL.

LoRA / trainer parameters are intentionally left out.

## Architecture

```
Browser (public/)  ──►  Cloudflare Worker (src/worker.js)  ──►  Pruna AI API
   static UI              /api/config   catalog + auth flag
                          /api/generate → POST /v1/predictions
                          /api/status   → GET  /v1/predictions/status/{id}
                          /api/upload   → POST /v1/files
                          /api/result   → GET  /v1/predictions/delivery/... (adds apikey, no-store)
```

`src/models.js` is the single source of truth for the model catalog. The
Worker uses it to allow-list models and to serve `/api/config`; the browser
renders its UI from the same data.

The Worker submits image jobs with `Try-Sync: true` (fast path) and falls back
to polling; video jobs always poll `/api/status` until `succeeded`.

## Models included

| Group | Models |
|-------|--------|
| Image generation | `flux-dev`, `flux-dev-lora`, `qwen-image`, `qwen-image-fast`, `z-image-turbo`, `z-image-turbo-lora`, `p-image`, `p-image-lora` |
| Image editing | `qwen-image-edit-plus`, `p-image-edit`, `p-image-edit-lora`, `p-image-upscale` |
| Video | `wan-t2v`, `wan-i2v`, `p-video`, `vace` |
| DigitalOcean (Gradient) | `do-gpt-image-2`, `do-gpt-image-1-5`, `do-sd-3-5-large` |

LoRA variants (`*-lora`) accept a LoRA weights URL (HuggingFace for the `p-image*`
and `flux-dev-lora` models, any host for `z-image-turbo-lora`) plus a strength
scale. The `p-image-lora` / `p-image-edit-lora` LoRAs must have been trained via
Pruna's `p-image-trainer` / `p-image-edit-trainer` — LoRAs from other sources
aren't compatible with those two endpoints.

## Setup / deploy

Requirements: Node 18+, a Cloudflare account, a valid Pruna API key.

```bash
npm install

# Secrets (never committed):
npx wrangler secret put PRUNA_API_KEY   # required — your Pruna API key
npx wrangler secret put APP_PASSWORD    # optional — shared UI password gate
npx wrangler secret put DO_INFERENCE_KEY # optional — DigitalOcean Gradient model access key

npm run deploy
```

Local dev: put the same values in a git-ignored `.dev.vars` file and run
`npm run dev`.

```
# .dev.vars
PRUNA_API_KEY=pru_...
APP_PASSWORD=your-password
```

### Updating the Pruna key later

No redeploy needed — secrets take effect immediately:

```bash
printf '%s' 'pru_your_new_key' | npx wrangler secret put PRUNA_API_KEY
```

### Removing / changing the password gate

- Remove: `npx wrangler secret delete APP_PASSWORD` (the app becomes open).
- Change: `npx wrangler secret put APP_PASSWORD`.

## Notes

- The app is `noindex, nofollow` and single-user by design.
- Because the Worker proxies your paid Pruna key, keep the password gate on if
  the URL might be shared or discovered.
