# Home Screen icon

How the app's icons, manifest and related tags are configured, and the fix that
stopped iOS Safari's Add to Home Screen from installing a black letter tile.

## Confirmed fix

**Status:** fixed. Confirmed on 2026-10-12 on an iPhone running iOS 27.2 beta 3,
by adding the app to the Home Screen from Safari after PR #104 was deployed
(Worker version `8a35a985-1546-4dee-9a6d-2b7a08998513`).

**Symptom.** Safari's Add to Home Screen made a black tile with a single letter
instead of the app icon.

**What fixed it.** PR #104 made two changes, and the device test was run after
both. Which one fixed it was not tested separately in this repo.

1. The `apple-touch-icon` link points at the PNG inlined as a `data:` URI. It used
   to point at the file `/apple-touch-icon.png`; the bytes are the same.
2. The tab icon is now `/icon-192.png`. It used to be an SVG `data:` URI that drew
   an emoji.

The inline touch icon is the likely cause. In reloru/easycloud-oci, PR #25 made
only that change, because its tab icon was already a PNG, and it fixed the same
symptom on the same phone. That is a deduction from two repos, not a test that
changed one thing at a time.

**Root cause: unknown.** Before #104, the file the icon link pointed at was served
correctly:
- It returned 200 `image/png` to an iPhone Safari user agent.
- It was a valid, opaque 180×180 PNG.
- It was not behind the password gate.

Safari still made a letter tile. I found nothing from Apple or WebKit that
explains this, and the iOS 27.2 beta's Safari feature flags were not tested as a
cause.

**What did not fix it** (PR #103):
- Serving the icon at the paths iOS checks on its own (`/apple-touch-icon.png`,
  `/apple-touch-icon-precomposed.png`) did not change the Home Screen tile.
- Adding `og:image` fixed only a separate problem: the icon sitting on a white tile
  in the share sheet.

**Keep:**
- The touch icon stays inlined as a `data:` URI.
- No icon anywhere is an SVG.
- Every icon is an opaque PNG.

## Configuration

### Page head (`public/index.html`)

In document order:

```html
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,…" />

<meta property="og:type" content="website" />
<meta property="og:title" content="Patchbay" />
<meta property="og:image" content="https://patchbay.reloru.workers.dev/icon-512.png" />
<meta property="og:image:width" content="512" />
<meta property="og:image:height" content="512" />

<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0f1115" />

<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black" />
<meta name="apple-mobile-web-app-title" content="Patchbay" />
```

- **Inline touch icon:** the `data:` URI is 12,436 base64 characters. It decodes
  to exactly the bytes of `public/icon-180.png` (9,327 bytes).
- **`og:image`:** this is an absolute URL because link previews do not reliably
  resolve a relative one. Without it, the iOS share sheet puts the touch icon on
  a white tile.
- **Viewport:** `viewport-fit=cover` is deliberately not set. Without it, iOS keeps
  the page inside the safe areas on its own.

### Manifest (`public/manifest.webmanifest`)

```json
{
  "name": "Patchbay",
  "short_name": "Patchbay",
  "description": "Image and video generation and editing across Pruna, xAI and Cloudflare Workers AI.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0f1115",
  "theme_color": "#0f1115",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- There is no `id`, no `purpose` and no maskable icon. Those were not needed for
  the fix.
- EazyCloud's manifest has all three. Whether iOS uses them was not tested.

### Icon files (`public/`)

| File | Size | Pixels | Format |
|---|---|---|---|
| `icon-180.png` | 9,327 B | 180×180 | 8-bit RGB, no alpha |
| `apple-touch-icon.png` | 9,327 B | 180×180 | byte-identical copy of `icon-180.png` |
| `apple-touch-icon-precomposed.png` | 9,327 B | 180×180 | byte-identical copy of `icon-180.png` |
| `icon-192.png` | 9,453 B | 192×192 | 8-bit RGB, no alpha |
| `icon-512.png` | 33,644 B | 512×512 | 8-bit RGB, no alpha |

The two `apple-touch-icon*` files sit at the root paths iOS can request without
being told. They stay even though the page now inlines the icon.

### Serving

- **Static assets come first.** `wrangler.jsonc` serves `./public` as static assets
  before the Worker, so the icons and manifest never reach `src/worker.js`.
- **The password gate does not apply.** The gate checks the `x-app-password` header
  inside the Worker, so it cannot block an icon or the manifest. iOS fetches the
  icon without the site's cookies or headers, which is why this matters.
- **Live responses** (iPhone Safari user agent, checked 2026-10-12):

| Path | Status | Content-Type |
|---|---|---|
| `/manifest.webmanifest` | 200 | `application/manifest+json` |
| `/icon-180.png` | 200 | `image/png` |
| `/apple-touch-icon.png` | 200 | `image/png` |
| `/apple-touch-icon-precomposed.png` | 200 | `image/png` |
| `/icon-192.png` | 200 | `image/png` |
| `/icon-512.png` | 200 | `image/png` |

All of them are sent with `Cache-Control: public, max-age=0, must-revalidate`.

### Tests

The phone-layout block in `test/session.test.mjs` checks four things:

- `/apple-touch-icon.png` and `/apple-touch-icon-precomposed.png` are served as
  `image/png`.
- The touch-icon link is a `data:image/png` URI whose bytes equal
  `/apple-touch-icon.png`.
- Every declared icon is a PNG, and none is an SVG.
- An absolute `og:image` is declared, and its file is served as `image/png`.

## Changing the icon

1. Replace `public/icon-180.png`, keeping it an opaque PNG.
2. Run this from the repo root. It copies the file to the root names and rewrites
   the inline `data:` URI:

```sh
cp public/icon-180.png public/apple-touch-icon.png && cp public/icon-180.png public/apple-touch-icon-precomposed.png && python3 -c "import base64,re;p='public/index.html';h=open(p).read();b=base64.b64encode(open('public/icon-180.png','rb').read()).decode();n=re.sub(r'(rel=\"apple-touch-icon\" sizes=\"180x180\" href=\"data:image/png;base64,)[^\"]+',lambda m:m.group(1)+b,h);assert n.count(b)==1;open(p,'w').write(n)"
```

3. Update `icon-192.png` and `icon-512.png` to match, then deploy.

## Testing on a phone

- **Add a second copy; don't delete the old one.** In Safari, use Share → Add to
  Home Screen to make a new copy. Each Home Screen copy has its own storage, so
  deleting it may delete its gallery. That has not been checked on every iOS
  version.
- **Force-quit Safari first if the icon was just changed.** Safari may reuse an
  icon it saved before.
