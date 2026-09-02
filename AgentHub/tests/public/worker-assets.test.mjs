import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWorkerAssets } from "../../cloudflare-worker/build-assets.mjs";
import { deployWorker } from "../../cloudflare-worker/deploy-worker.mjs";
import {
  deployWorkerRelease,
  publishWorker,
  verifyWorkerRelease,
  workerRouteBaseUrl,
} from "../../cloudflare-worker/publish-worker.mjs";
import {
  changedBackgrounds,
  fetchWithTransportRace,
  measureImmediateControlDrain,
  verifyThemeDeployment,
  WORKER_VERIFY_REQUEST_TIMEOUT_MS,
} from "../../cloudflare-worker/verify-deployment.mjs";
import { remoteControlTransportBudget } from "../../src/interfaces/web/remote-control-transport-budget.mjs";
import { REMOTE_CONTROL_WAKE_PROTOCOL } from "../../src/interfaces/web/remote-control-wake-channel.mjs";

const require = createRequire(import.meta.url);
const { localAssetPathname, localAssetReferences } = require("../../client-assets.cjs");
const { loadThemeRegistry } = require("../../theme-registry.cjs");
const ROOT = path.resolve(import.meta.dirname, "../..");

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function syntheticAttachmentProbeResponse(target) {
  const body = Buffer.from(Uint8Array.from(
    { length: 128 * 1024 + 123 },
    (_, index) => (index * 31 + 17) % 251,
  ));
  const chunks = Array.from({ length: Math.ceil(body.length / (16 * 1024)) }, (_, index) => {
    const chunk = body.subarray(index * 16 * 1024, Math.min(body.length, (index + 1) * 16 * 1024));
    return { body: chunk, hash: sha256(chunk), index, size: chunk.length };
  });
  if (target.searchParams.get("mode") === "manifest") {
    return Response.json({
      protocol: "agent-hub-attachment-chunks-v1",
      id: "dashboard-transport-probe-v1",
      size: body.length,
      hash: sha256(body),
      count: chunks.length,
      chunkBytes: 16 * 1024,
      page: 0,
      pageCount: 1,
      contentType: "application/octet-stream",
      name: "dashboard-transport-probe.bin",
      chunks: chunks.map(({ body: _body, ...descriptor }) => descriptor),
    });
  }
  const chunk = chunks[Number(target.searchParams.get("index"))];
  return new Response(chunk?.body ?? "missing", { status: chunk ? 200 : 404 });
}

function syntheticControlBudgetResponse() {
  return Response.json({
    protocol: REMOTE_CONTROL_WAKE_PROTOCOL,
    ...remoteControlTransportBudget(),
  });
}

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
    assert.match(builtIndex, /https:\/\/home\.[^/]+\/app\.js\?v=[a-f0-9]{12}/u);
    assert.match(builtIndex, /https:\/\/home\.[^/]+\/styles\.css\?v=[a-f0-9]{12}/u);
    assert.ok(build.directShellAssets.get("/app.js")?.bytes > 100 * 1024);
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
    assert.match(headers, /script-src 'self' https:\/\/home\./u);
    assert.match(headers, /style-src 'self' https:\/\/home\./u);
    assert.match(headers, /Cache-Control: no-store/u);
    const wrangler = JSON.parse(await readFile(path.join(ROOT, "cloudflare-worker", "wrangler.jsonc"), "utf8"));
    assert.deepEqual(wrangler.assets.run_worker_first, ["/", "/index.html", "/__agent-hub-shell-loader.js"]);
    let activeChunkReads = 0;
    let maximumChunkReads = 0;
    const fixtureFetch = async (input, options) => {
      const target = new URL(input);
      if (target.hostname.startsWith("home.")) {
        const body = await readFile(path.join(ROOT, "assets", "web-app", ...target.pathname.slice(1).split("/")));
        return new Response(body, { status: 200 });
      }
      if (target.pathname === "/api/transport-probe/attachment") {
        return syntheticAttachmentProbeResponse(target);
      }
      if (target.pathname === "/api/transport-probe/control-budget") {
        return syntheticControlBudgetResponse();
      }
      const pathname = target.pathname === "/" ? "/index.html" : target.pathname;
      try {
        if (pathname.endsWith(".b64")) {
          assert.notEqual(options?.cache, "no-store", pathname);
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
    };
    const deployment = await verifyThemeDeployment({
      baseUrl: "https://agent-hub.test/",
      sourceRoot: path.join(ROOT, "assets", "web-app"),
      deployedRoot: output,
      fetchImpl: fixtureFetch,
      http1Fetch: fixtureFetch,
    });
    assert.ok(deployment.backgrounds > 3);
    assert.ok(deployment.sampledChunks >= deployment.backgrounds * 2);
    assert.equal(maximumChunkReads, 1);
    assert.ok(deployment.largeStaticBytes > 100 * 1024);
    assert.ok(deployment.attachmentProbeBytes > 100 * 1024);
    assert.ok(deployment.attachmentProbeChunks > 1);
    assert.equal(deployment.controlTransportBudget.fallbackRequests, 17_280);
    assert.equal(deployment.controlTransportBudget.websocketIdleGbSeconds, 0);

    await assert.rejects(() => verifyThemeDeployment({
      baseUrl: "https://agent-hub.test/",
      sourceRoot: path.join(ROOT, "assets", "web-app"),
      deployedRoot: output,
      fetchImpl: fixtureFetch,
      http1Fetch: async (input, options) => {
        const response = await fixtureFetch(input, options);
        if (!new URL(input).hostname.startsWith("home.")) return response;
        const body = Buffer.from(await response.arrayBuffer());
        return new Response(body.subarray(0, body.length - 1));
      },
      changedFiles: [],
    }), /partial or damaged over HTTP\/1\.1/u);

    await assert.rejects(() => verifyThemeDeployment({
      baseUrl: "https://agent-hub.test/",
      sourceRoot: path.join(ROOT, "assets", "web-app"),
      deployedRoot: output,
      fetchImpl: fixtureFetch,
      http1Fetch: async (input, { signal } = {}) => {
        if (!new URL(input).hostname.startsWith("home.")) return fixtureFetch(input);
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("partial"));
            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }));
      },
      changedFiles: [],
      requestTimeoutMs: 20,
    }), /abort|timeout/iu);
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

test("Worker deployment and live verification are independently retryable", async () => {
  const events = [];
  const verificationCheckpoint = { marker: "durable-worker-checkpoint" };
  const common = {
    exclusive: async (operation) => operation(),
    before: async () => events.push("guard"),
  };
  await deployWorkerRelease({
    ...common,
    build: async () => events.push("build"),
    deploy: async () => events.push("deploy"),
  });
  await verifyWorkerRelease({
    ...common,
    changedFiles: ["AgentHub/assets/web-app/themes/bespin/portal.jpg"],
    verificationCheckpoint,
    readConfig: async () => ({ routes: ["hub.example.test/*"] }),
    verify: async ({ baseUrl, changedFiles, checkpoint }) => {
      assert.equal(checkpoint, verificationCheckpoint);
      events.push(`verify:${baseUrl}:${changedFiles.length}`);
    },
  });
  assert.deepEqual(events, ["guard", "build", "deploy", "guard", "verify:https://hub.example.test/:1"]);
});

test("Worker verification selects only changed manifests and uses a five-minute request bound", () => {
  const backgrounds = [{
    theme: { id: "bespin" },
    background: { asset: "portal.jpg" },
  }, {
    theme: { id: "diablo" },
    background: { asset: "sanctuary.png" },
  }];
  assert.deepEqual(changedBackgrounds(backgrounds, [
    "AgentHub/assets/web-app/themes/bespin/portal.jpg",
  ]), [backgrounds[0]]);
  assert.deepEqual(changedBackgrounds(backgrounds, [
    "AgentHub/assets/web-app/themes/diablo/theme.json",
  ]), [backgrounds[1]]);
  assert.equal(WORKER_VERIFY_REQUEST_TIMEOUT_MS, 300_000);
});

test("Worker verification accepts the first complete transport and aborts a stalled fallback", async () => {
  let curlAborted = false;
  const response = await fetchWithTransportRace("https://agent-hub.test/", {
    nativeFetch: async () => new Response("native response"),
    curlFetch: async (_target, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        curlAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  assert.equal(await response.text(), "native response");
  assert.equal(curlAborted, true);
});

test("Worker verification ignores a fast failed transport when the fallback succeeds", async () => {
  const response = await fetchWithTransportRace("https://agent-hub.test/", {
    nativeFetch: async () => new Response("unavailable", { status: 503 }),
    curlFetch: async () => new Response("curl response"),
  });
  assert.equal(await response.text(), "curl response");
});

test("Worker verification resumes unfinished chunks and rejects damaged checkpoint evidence", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "agent-hub-worker-resume-"));
  let savedCheckpoint = null;
  let cleared = 0;
  const checkpoint = {
    read: async () => structuredClone(savedCheckpoint),
    write: async (value) => { savedCheckpoint = structuredClone(value); },
    clear: async () => { savedCheckpoint = null; cleared += 1; },
  };
  const calls = new Map();
  const count = (target) => {
    const key = new URL(target).href;
    calls.set(key, (calls.get(key) ?? 0) + 1);
  };
  let stallChunkFive = true;
  try {
    await buildWorkerAssets({ output, includeMobile: false });
    const fixtureFetch = async (input, { signal } = {}) => {
      const target = new URL(input);
      count(target);
      if (target.hostname.startsWith("home.")) {
        const body = await readFile(path.join(ROOT, "assets", "web-app", ...target.pathname.slice(1).split("/")));
        return new Response(body);
      }
      if (target.pathname === "/api/transport-probe/attachment") {
        const response = syntheticAttachmentProbeResponse(target);
        if (target.searchParams.get("mode") === "chunk"
          && target.searchParams.get("index") === "5" && stallChunkFive) {
          stallChunkFive = false;
          const body = Buffer.from(await response.arrayBuffer());
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(body.subarray(0, 8 * 1024));
              const abort = () => controller.error(signal?.reason ?? new Error("aborted"));
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            },
          }));
        }
        return response;
      }
      if (target.pathname === "/api/transport-probe/control-budget") {
        return syntheticControlBudgetResponse();
      }
      const pathname = target.pathname === "/" ? "/index.html" : target.pathname;
      try {
        return new Response(await readFile(path.join(output, ...pathname.slice(1).split("/"))));
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    };
    const verify = () => verifyThemeDeployment({
      baseUrl: "https://agent-hub.test/",
      sourceRoot: path.join(ROOT, "assets", "web-app"),
      deployedRoot: output,
      fetchImpl: fixtureFetch,
      http1Fetch: fixtureFetch,
      changedFiles: [],
      requestTimeoutMs: 25,
      checkpoint,
      log: () => {},
    });

    await assert.rejects(verify, /index=5.*8192 bytes/u);
    assert.ok(savedCheckpoint.completed["attachment/chunk/4"]);
    assert.equal(savedCheckpoint.completed["attachment/chunk/5"], undefined);
    savedCheckpoint.completed["attachment/chunk/4"].evidence.base64 = Buffer.from("damaged").toString("base64");

    const result = await verify();
    assert.ok(result.attachmentProbeChunks > 5);
    assert.equal(cleared, 1);
    assert.equal(savedCheckpoint, null);
    assert.equal(calls.get("https://agent-hub.test/"), 1);
    assert.equal(calls.get("https://agent-hub.test/api/transport-probe/attachment?mode=manifest&page=0"), 1);
    for (let index = 0; index < result.attachmentProbeChunks; index += 1) {
      const key = `https://agent-hub.test/api/transport-probe/attachment?mode=chunk&index=${index}`;
      assert.equal(calls.get(key), index === 4 || index === 5 ? 2 : 1, key);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("deployment control drain measurement rejects partial queues and slow p99", async () => {
  let clock = 0;
  const measured = await measureImmediateControlDrain({
    drain: async () => ({ commands: [] }),
    samples: 20,
    now: () => {
      clock += 100;
      return clock;
    },
  });
  assert.deepEqual(measured, { samples: 20, p99Ms: 100, maxP99Ms: 250 });
  await assert.rejects(
    measureImmediateControlDrain({ drain: async () => ({ commands: [{}] }) }),
    /non-empty or invalid/u,
  );
});
