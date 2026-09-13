// Finds Playwright wherever it happens to live.
//
// It is deliberately NOT a devDependency. `npm install` in this repo runs before
// every `wrangler deploy`, and Playwright pulls browser binaries on install —
// hundreds of megabytes to publish a static front end. So the browser tests are
// opt-in: install Playwright once, globally or locally, and they work; skip it
// and only the tests are unavailable, never the deploy.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const INSTALL_HINT = `
Playwright is not installed, so the browser tests cannot run.

  npm i -g playwright && playwright install chromium webkit

(or "npm i -D playwright" to keep it in this repo — note that makes every
npm install here pull browser binaries, including before a deploy.)
`;

export async function loadPlaywright() {
  // A local or global node_modules that Node can already resolve.
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return await import(spec);
    } catch {
      /* try the next one */
    }
  }
  // A global install Node cannot resolve on its own: NODE_PATH is not consulted
  // for ES modules, so ask npm where global packages live and import by path.
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return await import(pathToFileURL(join(root, "playwright", "index.mjs")).href);
  } catch {
    /* fall through to the message below */
  }
  console.error(INSTALL_HINT);
  process.exit(1);
}
