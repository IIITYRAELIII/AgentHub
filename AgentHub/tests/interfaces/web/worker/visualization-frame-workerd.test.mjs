import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

test("native Worker serves the exact visualization frame and preserves the main asset shell", async (t) => {
  const app = fileURLToPath(new URL("../../../../", import.meta.url));
  const frame = await readFile(path.join(app, "assets/web-app/visualization-frame.html"), "utf8");
  const settings = JSON.parse(await readFile(path.join(app, "cloudflare-worker/wrangler.jsonc"), "utf8"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-visualization-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(path.join(directory, "index.html"), "<!doctype html><html><body>Main shell</body></html>"),
    writeFile(path.join(directory, "visualization-frame.html"), frame),
  ]);
  const sourceModules = await Promise.all([
    "cloudflare-worker/src/worker.mjs",
    "src/application/client-performance-trace.mjs",
    "src/application/client-command-trace.mjs",
  ].map(async (name) => ({
    type: "ESModule", path: path.join(app, name),
    contents: await readFile(path.join(app, name), "utf8"),
  })));
  const runtime = new Miniflare({
    modulesRoot: app,
    modules: [{
      type: "ESModule", path: path.join(app, "worker-frame-fixture.mjs"),
      contents: 'export { default, JournalStore } from "./cloudflare-worker/src/worker.mjs";',
    }, ...sourceModules],
    compatibilityDate: "2026-07-28",
    durableObjects: { JOURNAL: { className: "JournalStore", useSQLite: true } },
    assets: {
      directory,
      binding: settings.assets.binding,
      routerConfig: { has_user_worker: true, static_routing: { user_worker: settings.assets.run_worker_first } },
    },
  });
  try {
    const root = await runtime.dispatchFetch("https://hub.example.test/");
    assert.equal(root.status, 200);
    assert.match(root.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/u);
    assert.doesNotMatch(root.headers.get("Content-Security-Policy"), /script-src[^;]*unsafe-inline/u);
    assert.equal(root.headers.get("X-Agent-Hub-Static-Body"), "chunk-bootstrap");
    const address = "https://hub.example.test/visualization-frame.html";
    const first = await runtime.dispatchFetch(address, { redirect: "manual" });
    const shell = [301, 302, 307, 308].includes(first.status)
      ? await runtime.dispatchFetch(new URL(first.headers.get("Location"), address).href)
      : first;
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get("Content-Security-Policy"), "frame-ancestors 'self'");
    assert.equal(shell.headers.get("X-Agent-Hub-Static-Body"), null);
    assert.equal(await shell.text(), frame);
  } finally {
    await runtime.dispose();
  }
});
