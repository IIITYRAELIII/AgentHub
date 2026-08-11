import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWorkerAssets } from "../../cloudflare-worker/build-assets.mjs";
import { verifyThemeDeployment } from "../../cloudflare-worker/verify-deployment.mjs";

const require = createRequire(import.meta.url);
const { localAssetPathname, localAssetReferences } = require("../../client-assets.cjs");
const { loadThemeRegistry } = require("../../theme-registry.cjs");
const ROOT = path.resolve(import.meta.dirname, "../..");

test("Worker build packages the same shell and theme resources used by local clients", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "agent-hub-worker-assets-"));
  try {
    const build = await buildWorkerAssets({ output, includeMobile: false });
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
      const publishedPathname = build.publishedThemePathnames.get(resource.pathname);
      assert.match(publishedPathname, /^\/themes\/[a-z0-9-]+\/.+\.[a-f0-9]{12}\.[a-z0-9]+$/u);
      assert.ok((await stat(path.join(output, ...publishedPathname.slice(1).split("/")))).isFile(), publishedPathname);
    }

    const builtIndex = await readFile(path.join(output, "index.html"), "utf8");
    const catalogSource = builtIndex.match(/<script type="application\/json" data-theme-catalog>([^<]+)<\/script>/u)?.[1];
    assert.ok(catalogSource, "theme catalog");
    const catalog = JSON.parse(catalogSource);
    const bespin = catalog.find((theme) => theme.id === "bespin");
    assert.equal(bespin.backgrounds.length, 3);
    for (const background of bespin.backgrounds) {
      assert.match(background.assetUrl, /^\/themes\/bespin\/[^?]+\.jpg\.[a-f0-9]{12}\.json$/u);
      const manifest = JSON.parse(await readFile(path.join(output, ...background.assetUrl.slice(1).split("/")), "utf8"));
      assert.ok(manifest.parts.length > 1);
      const encoded = (await Promise.all(manifest.parts.map(async (part) => {
        const chunk = await readFile(path.join(output, ...part.slice(1).split("/")), "ascii");
        assert.ok(Buffer.byteLength(chunk) <= 20 * 1024);
        return chunk;
      }))).join("");
      const sourceName = path.basename(background.assetUrl).replace(/\.[a-f0-9]{12}\.json$/u, "");
      assert.deepEqual(Buffer.from(encoded, "base64"), await readFile(path.join(ROOT, "assets", "mini-app", "themes", "bespin", sourceName)));
    }
    const bespinStylesheet = build.publishedThemePathnames.get("/themes/bespin/theme.css");
    const bespinCss = await readFile(path.join(output, ...bespinStylesheet.slice(1).split("/")), "utf8");
    for (const background of bespin.backgrounds) {
      assert.match(bespinCss, new RegExp(`var\\(--${background.id}-image, url\\("/themes/bespin/[^\"]+\\.[a-f0-9]{12}\\.jpg"\\)\\)`, "u"));
    }

    const headers = await readFile(path.join(output, "_headers"), "utf8");
    assert.match(headers, /Content-Security-Policy:/u);
    assert.match(headers, /Cache-Control: no-store/u);
    const wrangler = JSON.parse(await readFile(path.join(ROOT, "cloudflare-worker", "wrangler.jsonc"), "utf8"));
    assert.equal(wrangler.assets.run_worker_first, false);
    const deployment = await verifyThemeDeployment({
      baseUrl: "https://agent-hub.test/",
      sourceRoot: path.join(ROOT, "assets", "mini-app"),
      fetchImpl: async (input) => {
        const pathname = new URL(input).pathname === "/" ? "/index.html" : new URL(input).pathname;
        try {
          return new Response(await readFile(path.join(output, ...pathname.slice(1).split("/"))), { status: 200 });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      },
    });
    assert.ok(deployment.backgrounds > 3);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
