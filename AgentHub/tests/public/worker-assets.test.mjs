import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWorkerAssets } from "../../cloudflare-worker/build-assets.mjs";

const require = createRequire(import.meta.url);
const { localAssetPathname, localAssetReferences } = require("../../client-assets.cjs");
const { loadThemeRegistry } = require("../../theme-registry.cjs");
const ROOT = path.resolve(import.meta.dirname, "../..");

test("Worker build packages the same shell and theme resources used by local clients", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "agent-hub-worker-assets-"));
  try {
    await buildWorkerAssets({ output, includeMobile: false });
    const sourceIndex = await readFile(path.join(ROOT, "assets", "mini-app", "index.html"), "utf8");
    const expectedShell = [
      ...localAssetReferences(sourceIndex),
      "/remote-command-idempotency.js",
    ];
    for (const reference of expectedShell) {
      const pathname = localAssetPathname(reference);
      assert.ok((await stat(path.join(output, ...pathname.slice(1).split("/")))).isFile(), pathname);
    }

    const registry = loadThemeRegistry(path.join(ROOT, "assets", "mini-app"));
    for (const resource of registry.resources.values()) {
      const packaged = path.join(output, ...resource.pathname.slice(1).split("/"));
      assert.equal((await stat(packaged)).size, (await stat(resource.file)).size, resource.pathname);
    }

    const builtIndex = await readFile(path.join(output, "index.html"), "utf8");
    const catalogSource = builtIndex.match(/<script type="application\/json" data-theme-catalog>([^<]+)<\/script>/u)?.[1];
    assert.ok(catalogSource, "theme catalog");
    const catalog = JSON.parse(catalogSource);
    const bespin = catalog.find((theme) => theme.id === "bespin");
    assert.equal(bespin.backgrounds.length, 3);
    for (const background of bespin.backgrounds) {
      assert.match(background.assetUrl, /^\/themes\/bespin\/[^?]+\?v=[a-f0-9]{12}$/u);
    }

    const headers = await readFile(path.join(output, "_headers"), "utf8");
    assert.match(headers, /Content-Security-Policy:/u);
    assert.match(headers, /Cache-Control: no-store/u);
    const wrangler = JSON.parse(await readFile(path.join(ROOT, "cloudflare-worker", "wrangler.jsonc"), "utf8"));
    assert.equal(wrangler.assets.run_worker_first, false);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
