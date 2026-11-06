# Patchbay

A web front end for image and video generation across Pruna AI, xAI and
Cloudflare Workers AI. One Cloudflare Worker (`src/worker.js`) proxies the
providers and hides their keys; the browser app is static files in `public/`.
There is no build step and no framework.

Live: https://patchbay.reloru.workers.dev (password gate: `APP_PASSWORD`).

## Checks

```
npm run test:worker   # Worker routes in Node, no browser, under a second
npm test              # worker, then the browser suite in Chromium and WebKit
```

The browser suite needs Playwright with Chromium and WebKit (see
`test/README.md`). Run WebKit as well as Chromium: the app is used on an
iPhone, and the two engines have differed here before. There is no typecheck
or lint step.

## Deploy

Manual, from the repo root, with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` set:

```
npm run deploy        # wrangler deploy
```

Secrets are set with `wrangler secret put` and are never in the repo:
`PRUNA_API_KEY` (required), `XAI_API_KEY`, `APP_PASSWORD`, `CF_ACCOUNT_ID`,
`CF_ANALYTICS_TOKEN`. After a deploy, confirm the live Worker serves the new
version, e.g. `curl -s https://patchbay.reloru.workers.dev/api/config` and
check the change is in it.

## Conventions

- `src/models.js` is the single source of truth for the catalogue: the Worker
  allow-lists model ids from it and serves it to the browser via `/api/config`.
- A field's `default` is what the UI shows; `apiDefault` is what the provider
  does when the field is omitted, where that differs. `buildInput()` in
  `public/app.js` omits any value equal to `apiDefault` (or `default` when
  there is none), so a wrong `default` means the UI shows one value while the
  provider uses another.
- Turbo switches and content-moderation filters are `hidden` and sent off.
  `moderationFilter()` covers the `disable_*` parameters, `safetyFilterOff()`
  the `enable_safety_filter` ones.
- Check parameter changes against the live API without running anything: send
  the value under test plus an unknown key such as `zz_probe` through
  `/api/generate`. Pruna validates properties in schema order and unknown keys
  last, and reports only the first error, so "additional properties forbidden,
  found zz_probe" means the tested value was accepted.
- Pruna's validation errors come back as HTTP 400 `{"message": …}`, not the
  422 `{title, detail}` its OpenAPI spec documents.
- Comments record what was verified live and when. Keep that habit: say what was
  observed, not what a doc claims, when the two differ.
