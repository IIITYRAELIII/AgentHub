import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWorkerAssets } from "../../cloudflare-worker/build-assets.mjs";
import { deployWorker } from "../../cloudflare-worker/deploy-worker.mjs";
import { publishWorker, workerRouteBaseUrl } from "../../cloudflare-worker/publish-worker.mjs";
import { verifyThemeDeployment } from "../../cloudflare-worker/verify-deployment.mjs";

const require = createRequire(import.meta.url);
const { localAssetPathname, localAssetReferences } = require("../../client-assets.cjs");
const { loadThemeRegistry } = require("../../theme-registry.cjs");
const ROOT = path.resolve(import.meta.dirname, "../..");

test("Worker build packages the same shell and theme resources used by local clients", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "agent-hub-worker-assets-"));
  try {
    const build = await buildWorkerAssets({ output, includeMobile: false });
    const sourceIndex = await readFile(path.join(ROOT, "assets", "web-app", "index.html"), "utf8");
    const expectedShell = [
      ...localAssetReferences(sourceIndex),
      "/remote-command-idempotency.js",
    ];
    for (const reference of expectedShell) {
      const pathname = localAssetPathname(reference);
      assert.ok((await stat(path.join(output, ...pathname.slice(1).split("/")))).isFile(), pathname);
    }

    const registry = loadThemeRegistry(path.join(ROOT, "assets", "web-app"));
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
      assert.match(manifest.directUrl, /^https:\/\/home\.[^/]+\/themes\/bespin\//u);
      const encoded = (await Promise.all(manifest.parts.map(async (part) => {
        const chunk = await readFile(path.join(output, ...part.slice(1).split("/")), "ascii");
        assert.ok(Buffer.byteLength(chunk) <= 20 * 1024);
        return chunk;
      }))).join("");
      const sourceName = path.basename(background.assetUrl).replace(/\.[a-f0-9]{12}\.json$/u, "");
      assert.deepEqual(Buffer.from(encoded, "base64"), await readFile(path.join(ROOT, "assets", "web-app", "themes", "bespin", sourceName)));
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
    let directAttempts = 0;
    let activeChunkReads = 0;
    let maximumChunkReads = 0;
    const deployment = await verifyThemeDeployment({
      baseUrl: "https://agent-hub.test/",
      sourceRoot: path.join(ROOT, "assets", "web-app"),
      fetchImpl: async (input) => {
        const target = new URL(input);
        if (target.hostname !== "agent-hub.test") {
          directAttempts += 1;
          return new Response("Direct origin unavailable", { status: 503 });
        }
        const pathname = target.pathname === "/" ? "/index.html" : target.pathname;
        try {
          if (pathname.endsWith(".b64")) {
            activeChunkReads += 1;
            maximumChunkReads = Math.max(maximumChunkReads, activeChunkReads);
            await new Promise((resolve) => setImmediate(resolve));
          }
          const body = await readFile(path.join(output, ...pathname.slice(1).split("/")));
          return new Response(body, { status: 200 });
        } catch {
          return new Response("Not Found", { status: 404 });
        } finally {
          if (pathname.endsWith(".b64")) activeChunkReads -= 1;
        }
      },
    });
    assert.ok(deployment.backgrounds > 3);
    assert.equal(directAttempts, deployment.backgrounds);
    assert.ok(maximumChunkReads > 1);
    assert.ok(maximumChunkReads <= 6);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Worker deploy retries transient Cloudflare failures", async () => {
  let attempts = 0;
  await deployWorker({
    run: async () => (++attempts < 3 ? 1 : 0),
    pause: async () => {},
  });
  assert.equal(attempts, 3);
  await assert.rejects(() => deployWorker({
    attempts: 2,
    run: async () => 1,
    pause: async () => {},
  }), /failed after 2 attempts/u);
});

test("Worker publication holds one transaction through build, deploy and live verification", async () => {
  const events = [];
  const result = await publishWorker({
    exclusive: async (operation) => {
      events.push("lock");
      return operation();
    },
    before: async () => events.push("guard"),
    build: async () => events.push("build"),
    deploy: async () => events.push("deploy"),
    verify: async ({ baseUrl }) => {
      events.push(`verify:${baseUrl}`);
      return { backgrounds: 45 };
    },
    readConfig: async () => ({ routes: [{ pattern: "hub.example.test/*" }] }),
  });
  assert.deepEqual(events, ["lock", "guard", "build", "deploy", "verify:https://hub.example.test/"]);
  assert.deepEqual(result, { backgrounds: 45 });
  assert.equal(workerRouteBaseUrl({ routes: ["https://hub.example.test/*"] }), "https://hub.example.test/");
});
