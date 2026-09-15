// Runs the Worker's own tests, then the browser suite against the stub Worker
// once per engine.
//
//   node test/run.mjs           worker tests, then both engines
//   node test/run.mjs webkit    worker tests, then one engine
//
// The Worker tests go first because they need no browser and take under a
// second: a broken gate should not cost a full Playwright run to discover.
// Each engine then runs in its own child process so a crash in one still
// reports the other, and the stub server is started and stopped here so no one
// has to remember to do it.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = String(Number(process.env.PORT) || 8788);
const BASE = `http://localhost:${PORT}/`;

const ENGINES = ["chromium", "webkit"];
const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const engines = asked.length ? asked : ENGINES;
for (const e of engines) {
  if (!ENGINES.includes(e)) {
    console.error(`unknown engine "${e}" — expected ${ENGINES.join(" or ")}`);
    process.exit(2);
  }
}

const server = spawn(process.execPath, [join(HERE, "server.mjs")], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, PORT },
});
server.stdout.on("data", (d) => process.stdout.write("  " + d));

// Poll rather than parse the server's greeting: the port being answerable is
// the condition that actually matters, and it is true a beat after the log line.
async function waitForServer(deadlineMs = 10000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(BASE + "api/config");
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const run = (engine) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, "session.test.mjs"), engine], {
      stdio: "inherit",
      env: { ...process.env, PORT },
    });
    child.on("exit", (code) => resolve(code === 0));
  });

// node --test, so it reports itself; only the exit code matters here.
const runWorkerTests = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", join(HERE, "worker.test.mjs")], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
  });

let allPassed = true;
try {
  console.log("\n──── worker ────");
  if (!(await runWorkerTests())) allPassed = false;

  if (!(await waitForServer())) {
    console.error(`the stub worker never answered on ${BASE} — is the port taken?`);
    process.exit(1);
  }
  for (const engine of engines) {
    console.log(`\n──── ${engine} ────`);
    if (!(await run(engine))) allPassed = false;
  }
} finally {
  server.kill();
}

console.log(allPassed ? "\nall engines passed" : "\nsome engines failed");
process.exit(allPassed ? 0 : 1);
