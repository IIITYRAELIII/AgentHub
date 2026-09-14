import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareTestContourCandidate } from "../../src/runtime/test-contour-manager.mjs";
import { verifyRuntimeManifest } from "../../src/infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { runtimeHostSourceHash } from "../../src/infrastructure/process/runtime-host-builder.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, html = "<html><body>synthetic</body></html>") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "contour-manifest-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceRoot = path.join(temporary, "source");
  const root = path.join(temporary, "runtime");
  const put = async (base, name, bytes) => {
    const file = path.join(base, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  };
  for (const [name, bytes] of Object.entries({
    "package.json": '{"name":"agent-hub","version":"2026.9.11"}',
    "agent-hub-main.mjs": "export {};\n",
    "codex-stop-hook-launcher.mjs": "export {};\n",
    "runtime-launch.sh": "#!/bin/sh\nexit 0\n",
    "assets/web-app/index.html": html,
  })) await put(sourceRoot, name, bytes);
  await put(root, "current.json", '{"current":"retained-old"}\n');
  await put(root, "codex-stop-hook-launcher.mjs", "retained stable hook\n");
  if (process.platform === "win32") {
    // Only exercise the existing verified cache path. These synthetic bytes are
    // never executed; no Windows artifact or compiler is needed for deployment.
    for (const name of ["RuntimeHost/AgentHub.RuntimeHost.cs", "RuntimeHost/AgentHub.IconBuilder.cs", "RuntimeHost/app.manifest", "VSCodeExtension/media/agent-hub-mark.png"])
      await put(sourceRoot, name, "synthetic hash input\n");
    await put(root, "AgentHub.RuntimeHost.exe", "synthetic cached host; never execute\n");
    await put(root, "AgentHub.RuntimeHost.source.sha256", `${await runtimeHostSourceHash(sourceRoot)}\n`);
    await put(root, "AgentHub.RuntimeHost.exe.sha256", `${digest(await readFile(path.join(root, "AgentHub.RuntimeHost.exe")))}\n`);
  } else await put(root, "runtime-launch.sh", "retained stable launcher\n");
  const stableNames = ["current.json", "codex-stop-hook-launcher.mjs", ...(process.platform === "win32"
    ? ["AgentHub.RuntimeHost.exe", "AgentHub.RuntimeHost.source.sha256", "AgentHub.RuntimeHost.exe.sha256"] : ["runtime-launch.sh"])];
  const before = new Map(await Promise.all(stableNames.map(async (name) => [name, await readFile(path.join(root, name))])));
  return { root, sourceRoot, before, html,
    options: { root, sourceRoot, prepareSource: async () => ({ sourceRoot, branch: "dev", headCommit: "exact-synthetic-dev" }) } };
}

test("real contour deployment manifests the branded staging bytes", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const candidate = await prepareTestContourCandidate(f.options);
  await verifyRuntimeManifest(candidate.releaseRoot, candidate.releaseId);
  const branded = await readFile(path.join(candidate.releaseRoot, "assets/web-app/index.html"), "utf8");
  assert.ok(branded.includes('data-test-contour=""'));
  assert.ok(branded.includes('class="test-contour-watermark"'));
  assert.equal(await readFile(path.join(f.sourceRoot, "assets/web-app/index.html"), "utf8"), f.html);
  assert.deepEqual(await readFile(path.join(f.root, "current.json")), f.before.get("current.json"));
  assert.equal(candidate.headCommit, "exact-synthetic-dev");
});

test("failed contour staging customization preserves every stable file and publishes no release", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, "no document roots");
  await assert.rejects(prepareTestContourCandidate(f.options), /no expected document roots/);
  for (const [name, bytes] of f.before) assert.deepEqual(await readFile(path.join(f.root, name)), bytes, name);
  assert.deepEqual(await readdir(path.join(f.root, "releases")), []);
  assert.equal(await readFile(path.join(f.sourceRoot, "assets/web-app/index.html"), "utf8"), f.html);
});
