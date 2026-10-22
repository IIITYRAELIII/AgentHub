import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  activateRuntime,
  deployRuntime,
  prepareRuntime,
  installPreparedRuntime,
  verifyInstalledRuntime,
  prepareRuntimeConfig,
  rollbackRuntime,
  runtimeStatus,
} from "../../runtime-manager.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { captureRuntimeReleaseBinding } from "../../src/infrastructure/filesystem/runtime-installation-custody.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("frozen runtime version refuses before build and uses the canonical next suffix", async t => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  let dependencyCalls = 0, customizationCalls = 0;
  const options = { sourceRoot, runtimeRoot, releaseId: "frozen-first",
    installProductionDependencies: async () => { dependencyCalls += 1; },
    beforeManifest: async () => { customizationCalls += 1; } };
  await assert.rejects(prepareRuntime({ ...options, expectedReleaseVersion: "2026.8.23.2" }), /Frozen runtime version/u);
  assert.equal(dependencyCalls, 0);
  assert.equal(customizationCalls, 0);
  await assert.rejects(stat(path.join(runtimeRoot, "releases", "frozen-first")), /ENOENT/u);
  const prepared = await prepareRuntime({ ...options, expectedReleaseVersion: "2026.8.23.1" });
  const bytes = await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json"));
  assert.equal(JSON.parse(bytes).releaseVersion, "2026.8.23.1");
  await assert.rejects(prepareRuntime({ ...options, releaseId: "frozen-second", expectedReleaseVersion: "2026.8.23.1" }), /Frozen runtime version/u);
  assert.deepEqual(await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json")), bytes);
  assert.equal(customizationCalls, 1);
});

test("prepared runtime carries its retirement owner and refuses wrong native custody", async (t) => {
  if (process.platform !== "win32") return t.skip("Native Windows custody");
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  const owner = "src/infrastructure/filesystem/sealed-runtime-release";
  for (const name of [`${owner}.mjs`, `${owner}.cs`, "src/infrastructure/process/system-boot-identity.mjs"]) {
    await mkdir(path.dirname(path.join(sourceRoot, name)), { recursive: true });
    await cp(path.join(ROOT, name), path.join(sourceRoot, name));
  }
  const prepared = await prepareRuntime({ sourceRoot, runtimeRoot, releaseId: "retirement-owner" });
  const binding = await captureRuntimeReleaseBinding(prepared.releaseRoot, prepared.releaseId);
  const bytes = await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json"));
  const { retireSealedRuntimeRelease } = await import(pathToFileURL(path.join(prepared.releaseRoot, `${owner}.mjs`)));
  await assert.rejects(retireSealedRuntimeRelease(prepared.releaseRoot,
    { ...binding, root: { ...binding.root, ino: String(BigInt(binding.root.ino) + 1n) } }), /runtime-root-changed/u);
  assert.deepEqual(await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json")), bytes);
  await assert.rejects(readFile(path.join(runtimeRoot, "current.json")), /ENOENT/u);
});

test("prepared runtime retains the verified deletion helper and executes its exact identity guard", async (t) => {
  if (process.platform !== "win32") return t.skip("Handle deletion is Windows-only");
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  const helper = "src/infrastructure/persistence/windows-delete-verified-entry";
  await mkdir(path.join(sourceRoot, "src/infrastructure/persistence"), { recursive: true });
  await mkdir(path.join(sourceRoot, "src/infrastructure/process"), { recursive: true });
  for (const name of [`${helper}.mjs`, `${helper}.cs`, "src/infrastructure/process/system-boot-identity.mjs"]) {
    await cp(path.join(ROOT, name), path.join(sourceRoot, name));
  }
  await writeFile(path.join(sourceRoot, "src/infrastructure/persistence/unrelated.cs"), "not a runtime asset");
  const prepared = await prepareRuntime({ sourceRoot, runtimeRoot, releaseId: "verified-delete" });
  const manifest = JSON.parse(await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json"), "utf8"));
  assert.ok(manifest.files.find((entry) => entry.path === `${helper}.cs`));
  assert.deepEqual(await readFile(path.join(prepared.releaseRoot, `${helper}.cs`)), await readFile(path.join(sourceRoot, `${helper}.cs`)));
  await assert.rejects(readFile(path.join(prepared.releaseRoot, "src/infrastructure/persistence/unrelated.cs")), /ENOENT/u);
  await assert.rejects(readFile(path.join(runtimeRoot, "current.json")), /ENOENT/u);
  const { deleteVerifiedWindowsEntry } = await import(pathToFileURL(path.join(prepared.releaseRoot, `${helper}.mjs`)));
  const target = path.join(path.dirname(runtimeRoot), "disposable-backup.sqlite");
  await writeFile(target, "disposable recovery bytes");
  const identity = await stat(target, { bigint: true });
  await assert.rejects(deleteVerifiedWindowsEntry(target, { ...identity, ino: identity.ino + 1n }), /./u);
  assert.equal(await readFile(target, "utf8"), "disposable recovery bytes");
  await deleteVerifiedWindowsEntry(target, identity);
  await assert.rejects(readFile(target), /ENOENT/u);
});

test("runtime preparation refuses a missing verified deletion asset before publishing a pointer", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  const relative = "src/infrastructure/persistence/windows-delete-verified-entry.mjs";
  await mkdir(path.dirname(path.join(sourceRoot, relative)), { recursive: true });
  await writeFile(path.join(sourceRoot, relative), "export const deletionOwner = true;\n");
  await assert.rejects(prepareRuntime({ sourceRoot, runtimeRoot, releaseId: "missing-delete-source" }), /Runtime module asset is missing/u);
  await assert.rejects(readFile(path.join(runtimeRoot, "current.json")), /ENOENT/u);
});

test("preparing a runtime leaves the current installation intact; applying consumes exact prepared bytes", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "old" });
  const pointer = await readFile(path.join(runtimeRoot, "current.json"));
  const launcher = await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs"));
  await writeFile(path.join(sourceRoot, "helper.mjs"), "export const value = 2;\n");
  const prepared = await prepareRuntime({ sourceRoot, runtimeRoot, releaseId: "prepared", publicationRevision: "a".repeat(40) });
  assert.deepEqual(await readFile(path.join(runtimeRoot, "current.json")), pointer);
  assert.deepEqual(await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs")), launcher);
  assert.equal(await verifyInstalledRuntime({ runtimeRoot, ...prepared }), false);
  await writeFile(path.join(sourceRoot, "helper.mjs"), "export const value = 3;\n");
  await installPreparedRuntime({ runtimeRoot, ...prepared });
  assert.equal(await readFile(path.join(prepared.releaseRoot, "helper.mjs"), "utf8"), "export const value = 2;\n");
  assert.equal(await verifyInstalledRuntime({ runtimeRoot, ...prepared }), true);
  const installedPointer = await readFile(path.join(runtimeRoot, "current.json"));
  const repeated = await installPreparedRuntime({ runtimeRoot, ...prepared, beforePointerCommit: () => assert.fail("no duplicate pointer write") });
  assert.equal(repeated.reused, true);
  assert.deepEqual(await readFile(path.join(runtimeRoot, "current.json")), installedPointer);
  await writeFile(path.join(prepared.releaseRoot, "helper.mjs"), "damaged");
  await assert.rejects(installPreparedRuntime({ runtimeRoot, ...prepared }), /mismatch/);
});

test("prepared runtime manifests locked production modules and resolves them from its own release", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({
    name: "agent-hub", version: "2026.8.23", dependencies: { "example-runtime": "1.0.0" },
  }));
  await writeFile(path.join(sourceRoot, "package-lock.json"), JSON.stringify({
    name: "agent-hub", lockfileVersion: 3, packages: { "": {
      dependencies: { "example-runtime": "1.0.0" },
    } },
  }));
  const prepared = await prepareRuntime({
    sourceRoot, runtimeRoot, releaseId: "locked-production-dependency",
    installProductionDependencies: async (stagingRoot) => {
      const modules = path.join(stagingRoot, "node_modules");
      const dependency = path.join(modules, "example-runtime");
      await mkdir(dependency, { recursive: true });
      await writeFile(path.join(modules, ".package-lock.json"), "{}\n");
      await writeFile(path.join(dependency, "package.json"), JSON.stringify({
        name: "example-runtime", version: "1.0.0", type: "module", exports: "./index.mjs",
      }));
      await writeFile(path.join(dependency, "index.mjs"), "export const ready = true;\n");
    },
  });
  const manifest = JSON.parse(await readFile(path.join(prepared.releaseRoot, "runtime-manifest.json"), "utf8"));
  const names = manifest.files.map((file) => file.path);
  assert.ok(names.includes("package-lock.json"));
  assert.ok(names.includes("node_modules/example-runtime/index.mjs"));
  assert.ok(names.includes("node_modules/.package-lock.json"));
  const fromInstalledModule = createRequire(path.join(prepared.releaseRoot, "src", "application", "service.mjs"));
  assert.equal(fromInstalledModule.resolve("example-runtime"),
    path.join(prepared.releaseRoot, "node_modules", "example-runtime", "index.mjs"));
});

test("runtime dependency admission rejects a missing lock before installation", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({
    name: "agent-hub", version: "2026.8.23", dependencies: { "example-runtime": "1.0.0" },
  }));
  await assert.rejects(prepareRuntime({
    sourceRoot, runtimeRoot, releaseId: "missing-lock",
    installProductionDependencies: () => assert.fail("npm must not start without the lock"),
  }), /pinned package-lock/u);
  await assert.rejects(readFile(path.join(runtimeRoot, "current.json"), "utf8"), /ENOENT/u);
});

test("runner N operation remains readable across an interrupted and retried N+1 installation", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  const root = path.dirname(runtimeRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "runner-n" });
  const operationData = path.join(root, "operation-data");
  await mkdir(operationData, { recursive: true });
  const store = new ReleaseOperationStore({ dataDir: operationData });
  store.create({
    operationId: "operation-runner-n",
    requestId: "request-runner-n",
    workspaceId: "workspace",
    streamId: "stream",
    threadId: "thread",
    authorization: {
      taskIds: ["task-a"],
      approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
      validationMode: "full",
    },
    runnerVersion: "runner-n",
  });
  store.acquire("operation-runner-n", "worker-n", { leaseMs: 60_000, processId: process.pid });

  await writeFile(
    path.join(sourceRoot, "release-operation-publication-runner.mjs"),
    "export const durableReleaseRunner = 'runner-n+1';\n",
    "utf8",
  );
  const prepared = await prepareRuntime({
    sourceRoot, runtimeRoot, releaseId: "runner-n1", publicationRevision: "b".repeat(40),
  });
  await assert.rejects(installPreparedRuntime({
    runtimeRoot,
    ...prepared,
    beforePointerCommit: () => { throw new Error("injected N+1 install interruption"); },
  }), /injected N\+1 install interruption/u);
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current, "runner-n");
  assert.match(await readFile(path.join(runtimeRoot, "releases", "runner-n", "release-operation-publication-runner.mjs"), "utf8"),
    /durableReleaseRunner = true/u);
  assert.equal(new ReleaseOperationStore({ dataDir: operationData }).get("operation-runner-n").runnerVersion, "runner-n");

  await installPreparedRuntime({ runtimeRoot, ...prepared });
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current, "runner-n1");
  assert.match(await readFile(path.join(runtimeRoot, "releases", "runner-n1", "release-operation-publication-runner.mjs"), "utf8"),
    /runner-n\+1/u);
  const reopened = new ReleaseOperationStore({ dataDir: operationData }).get("operation-runner-n");
  assert.equal(reopened.runnerVersion, "runner-n");
  assert.equal(reopened.state, "compose");
  assert.equal(reopened.owner.ownerId, "worker-n");
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-runtime-"));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(path.join(sourceRoot, "assets"), { recursive: true });
  await mkdir(path.join(sourceRoot, "src", "application"), { recursive: true });
  await cp(path.join(ROOT, "RuntimeHost"), path.join(sourceRoot, "RuntimeHost"), {
    recursive: true,
  });
  await mkdir(path.join(sourceRoot, "VSCodeExtension", "media"), { recursive: true });
  await cp(
    path.join(ROOT, "VSCodeExtension", "media", "agent-hub-mark.png"),
    path.join(sourceRoot, "VSCodeExtension", "media", "agent-hub-mark.png"),
  );
  await writeFile(path.join(sourceRoot, "agent-hub-server.mjs"), "export const ready = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "helper.mjs"), "export const value = 1;\n", "utf8");
  await writeFile(
    path.join(sourceRoot, "release-operation-publication-runner.mjs"),
    "export const durableReleaseRunner = true;\n",
    "utf8",
  );
  await writeFile(path.join(sourceRoot, "helper.cjs"), "module.exports = { value: 1 };\n", "utf8");
  await writeFile(path.join(sourceRoot, "helper.test.mjs"), "throw new Error('not runtime');\n", "utf8");
  await writeFile(
    path.join(sourceRoot, "src", "application", "service.mjs"),
    "export const layered = true;\n",
    "utf8",
  );
  await writeFile(
    path.join(sourceRoot, "src", "application", "service.test.mjs"),
    "throw new Error('not runtime');\n",
    "utf8",
  );
  await writeFile(path.join(sourceRoot, "work-log.css"), "[data-work-log-table] { display: grid; }\n", "utf8");
  await writeFile(path.join(sourceRoot, "runtime-launch.sh"), "#!/usr/bin/env sh\nexec node agent-hub-server.mjs\n", "utf8");
  await writeFile(
    path.join(sourceRoot, "codex-stop-hook-launcher.mjs"),
    "export const ready = true;\n",
    "utf8",
  );
  await writeFile(path.join(sourceRoot, "start.ps1"), "node agent-hub-server.mjs\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({
    name: "agent-hub",
    version: "2026.8.23",
  }), "utf8");
  await writeFile(path.join(sourceRoot, "AGENT_HUB_GUIDE.md"), "Guide\n", "utf8");
  await writeFile(path.join(sourceRoot, "config.json"), JSON.stringify({
    telegramBotToken: "123:secret",
    allowedUserIds: [1],
    projectRoot: root,
  }), "utf8");
  await mkdir(path.join(sourceRoot, "data"), { recursive: true });
  await writeFile(path.join(sourceRoot, "data", "state.json"), "{\"offset\":1}\n", "utf8");
  return { sourceRoot, runtimeRoot };
}

test("deployRuntime publishes an atomic release without tests or local config", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  const first = await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current, "release-1");
  const firstManifest = JSON.parse(await readFile(path.join(first.releaseRoot, "runtime-manifest.json"), "utf8"));
  assert.equal(firstManifest.version, "2026.8.23");
  assert.equal(firstManifest.releaseVersion, "2026.8.23.1");
  assert.match(await readFile(path.join(first.releaseRoot, "agent-hub-server.mjs"), "utf8"), /ready/);
  assert.match(await readFile(path.join(first.releaseRoot, "helper.cjs"), "utf8"), /module\.exports/u);
  assert.match(
    await readFile(path.join(first.releaseRoot, "release-operation-publication-runner.mjs"), "utf8"),
    /durableReleaseRunner/u,
  );
  assert.match(
    await readFile(path.join(first.releaseRoot, "src", "application", "service.mjs"), "utf8"),
    /layered/u,
  );
  assert.match(await readFile(path.join(first.releaseRoot, "work-log.css"), "utf8"), /display: grid/);
  assert.equal(await readFile(path.join(first.releaseRoot, "AGENT_HUB_GUIDE.md"), "utf8"), "Guide\n");
  if (process.platform === "win32") {
    assert.ok((await readFile(path.join(runtimeRoot, "AgentHub.RuntimeHost.exe"))).length > 0);
    assert.ok((await readFile(path.join(first.releaseRoot, "AgentHub.RuntimeHost.exe"))).length > 0);
  }
  assert.match(
    await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs"), "utf8"),
    /ready/,
  );
  await assert.rejects(readFile(path.join(first.releaseRoot, "helper.test.mjs"), "utf8"), /ENOENT/);
  await assert.rejects(
    readFile(path.join(first.releaseRoot, "src", "application", "service.test.mjs"), "utf8"),
    /ENOENT/,
  );
  await assert.rejects(readFile(path.join(first.releaseRoot, "config.json"), "utf8"), /ENOENT/);

  const firstRuntimeHost = process.platform === "win32"
    ? await readFile(path.join(runtimeRoot, "AgentHub.RuntimeHost.exe"))
    : null;
  const second = await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });
  assert.equal(
    JSON.parse(await readFile(path.join(second.releaseRoot, "runtime-manifest.json"), "utf8")).releaseVersion,
    "2026.8.23.2",
  );
  if (firstRuntimeHost) {
    assert.deepEqual(await readFile(path.join(runtimeRoot, "AgentHub.RuntimeHost.exe")), firstRuntimeHost);
  }
  const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  assert.deepEqual({ current: pointer.current, previous: pointer.previous }, {
    current: "release-2",
    previous: "release-1",
  });
  const third = await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-3" });
  assert.equal(
    JSON.parse(await readFile(path.join(third.releaseRoot, "runtime-manifest.json"), "utf8")).releaseVersion,
    "2026.8.23.3",
  );
  assert.match(await readFile(path.join(first.releaseRoot, "agent-hub-server.mjs"), "utf8"), /ready/u);
  const retired = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).runtimeRetention.retired;
  assert.deepEqual(retired.map(entry => entry.releaseId), ["release-1"]);
  assert.equal(third.pruningDeferred, true);
});

test("deployRuntime treats a legacy same-day release as sequence one", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  const legacyRoot = path.join(runtimeRoot, "releases", "legacy-release");
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(
    path.join(legacyRoot, "runtime-manifest.json"),
    JSON.stringify({ releaseId: "legacy-release", version: "2026.8.23", files: [] }),
    "utf8",
  );
  const deployed = await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });
  assert.equal(
    JSON.parse(await readFile(path.join(deployed.releaseRoot, "runtime-manifest.json"), "utf8")).releaseVersion,
    "2026.8.23.2",
  );
});

test("deployRuntime rejects a release with a missing relative import before cutover", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await writeFile(
    path.join(sourceRoot, "agent-hub-server.mjs"),
    'import "./missing-runtime-module.mjs";\nexport const ready = true;\n',
    "utf8",
  );
  await assert.rejects(
    deployRuntime({ sourceRoot, runtimeRoot, releaseId: "broken-release" }),
    /missing relative imports.*agent-hub-server\.mjs -> \.\/missing-runtime-module\.mjs/u,
  );
  await assert.rejects(readFile(path.join(runtimeRoot, "current.json"), "utf8"), /ENOENT/u);
});

test("deployRuntime defers old-body deletion to the exact after-ready owner", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });
  const result = await deployRuntime({
    sourceRoot,
    runtimeRoot,
    releaseId: "release-3",
    removeRelease: async () => assert.fail("installation cannot adopt old releases for deletion"),
  });
  const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  assert.equal(pointer.current, "release-3");
  assert.equal(pointer.previous, "release-2");
  assert.equal(result.pruningDeferred, true);
  assert.deepEqual(pointer.runtimeRetention.retired.map(entry => entry.releaseId), ["release-1"]);
  assert.match(await readFile(path.join(runtimeRoot, "releases", "release-1", "agent-hub-server.mjs"), "utf8"), /ready/);
});

test("installing another runtime preserves an unrelated prepared body and rollback custody", async (t) => {
  const { sourceRoot, runtimeRoot } = await fixture();
  t.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "first" });
  const pending = await prepareRuntime({ sourceRoot, runtimeRoot, releaseId: "not-yet-selected" });
  const original = await readFile(path.join(pending.releaseRoot, "runtime-manifest.json"));
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "second" });
  assert.deepEqual(await readFile(path.join(pending.releaseRoot, "runtime-manifest.json")), original);
  const before = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  assert.equal(before.previous, "first");
  assert.deepEqual(before.runtimeRetention.retired, []);
  await rollbackRuntime({ runtimeRoot });
  const after = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  assert.deepEqual(after.runtimeRetention.current, before.runtimeRetention.previous);
  assert.deepEqual(after.runtimeRetention.previous, before.runtimeRetention.current);
  assert.deepEqual(await readFile(path.join(pending.releaseRoot, "runtime-manifest.json")), original);
});

test("deployRuntime recompiles a tampered cached RuntimeHost", async (t) => {
  if (process.platform !== "win32") return t.skip("RuntimeHost is Windows-only");
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  const launcher = path.join(runtimeRoot, "AgentHub.RuntimeHost.exe");
  await writeFile(launcher, "tampered\n", "utf8");

  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });

  assert.notEqual((await readFile(launcher, "utf8")).trim(), "tampered");
});

test("deployRuntime restores a missing RuntimeHost without changing user data", async (context) => {
  if (process.platform !== "win32") return context.skip("RuntimeHost is Windows-only");
  const { sourceRoot, runtimeRoot } = await fixture();
  context.after(() => rm(path.dirname(runtimeRoot), { recursive: true, force: true }));
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  const configFile = path.join(runtimeRoot, "config.json");
  const journalFile = path.join(runtimeRoot, "data", "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  await writeFile(configFile, '{"provider":"codex","customSetting":true}\n');
  await writeFile(journalFile, "retained journal bytes");
  const configBefore = await readFile(configFile);
  const journalBefore = await readFile(journalFile);
  const launcher = path.join(runtimeRoot, "AgentHub.RuntimeHost.exe");
  await rm(launcher);
  await rm(path.join(runtimeRoot, "releases", "release-1", "AgentHub.RuntimeHost.exe"));

  const restored = await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });

  const binary = await readFile(launcher);
  assert.equal(binary.subarray(0, 2).toString(), "MZ");
  assert.deepEqual(binary, await readFile(path.join(restored.releaseRoot, "AgentHub.RuntimeHost.exe")));
  assert.deepEqual(await readFile(configFile), configBefore);
  assert.deepEqual(await readFile(journalFile), journalBefore);
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current, "release-2");
});

test("deployRuntime does not replace unchanged stable runtime files", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  const stableFiles = [path.join(runtimeRoot, "codex-stop-hook-launcher.mjs")];
  if (process.platform === "win32") {
    stableFiles.push(path.join(runtimeRoot, "AgentHub.RuntimeHost.exe"));
  }
  const preservedTime = new Date("2000-01-01T00:00:00.000Z");
  for (const target of stableFiles) await utimes(target, preservedTime, preservedTime);

  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });

  for (const target of stableFiles) {
    assert.equal((await stat(target)).mtime.toISOString(), preservedTime.toISOString());
  }
});

test("deployRuntime replaces a locked Windows stable launcher before release cutover", async (t) => {
  if (process.platform !== "win32") return t.skip("locked executable replacement is Windows-only");
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  const stableHook = path.join(runtimeRoot, "codex-stop-hook-launcher.mjs");
  const originalHook = await readFile(stableHook, "utf8");
  await writeFile(
    path.join(sourceRoot, "codex-stop-hook-launcher.mjs"),
    "export const changed = true;\n",
    "utf8",
  );

  const deferred = await deployRuntime({
    sourceRoot,
    runtimeRoot,
    releaseId: "release-2",
    commitStableFile: async (source, target) => {
      const targetExists = await stat(target).then(() => true, () => false);
      if (path.resolve(target) === path.resolve(stableHook) && targetExists) {
        const error = new Error("locked stable launcher");
        error.code = "EPERM";
        throw error;
      }
      await cp(source, target, { force: true });
    },
  });

  assert.equal(deferred.stableUpdateDeferred, false);
  assert.equal(deferred.blockedStableTarget, null);
  assert.notEqual(await readFile(stableHook, "utf8"), originalHook);
  assert.match(await readFile(stableHook, "utf8"), /changed/u);
  assert.equal(
    JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current,
    "release-2",
  );
});

test("deployRuntime does not publish a pointer before the stable launchers are ready", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  const beforePointer = await readFile(path.join(runtimeRoot, "current.json"), "utf8");
  const beforeHook = await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs"), "utf8");

  await assert.rejects(
    deployRuntime({
      sourceRoot,
      runtimeRoot,
      releaseId: "release-2",
      beforeStableLauncherCommit: async () => { throw new Error("injected stable launcher failure"); },
    }),
    /injected stable launcher failure/,
  );

  assert.equal(await readFile(path.join(runtimeRoot, "current.json"), "utf8"), beforePointer);
  assert.equal(await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs"), "utf8"), beforeHook);
});

test("deployRuntime completes release preparation before publishing current.json", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });

  await deployRuntime({
    sourceRoot,
    runtimeRoot,
    releaseId: "release-2",
    beforePointerCommit: async ({ releaseRoot }) => {
      const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
      assert.equal(pointer.current, "release-1");
      await writeFile(path.join(releaseRoot, "prepared.marker"), "ready\n", "utf8");
    },
  });

  assert.equal(
    JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current,
    "release-2",
  );
  assert.equal(
    await readFile(path.join(runtimeRoot, "releases", "release-2", "prepared.marker"), "utf8"),
    "ready\n",
  );
});

test("deployRuntime rolls stable launchers back when publishing current.json fails", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  const beforePointer = await readFile(path.join(runtimeRoot, "current.json"), "utf8");
  const beforeHook = await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs"), "utf8");
  await writeFile(path.join(sourceRoot, "codex-stop-hook-launcher.mjs"), "export const changed = true;\n", "utf8");

  await assert.rejects(
    deployRuntime({
      sourceRoot,
      runtimeRoot,
      releaseId: "release-2",
      writePointer: async () => { throw new Error("injected pointer commit failure"); },
    }),
    /injected pointer commit failure/,
  );
  assert.equal(await readFile(path.join(runtimeRoot, "current.json"), "utf8"), beforePointer);
  assert.equal(await readFile(path.join(runtimeRoot, "codex-stop-hook-launcher.mjs"), "utf8"), beforeHook);
});

test("deployRuntime reports a pointer rollback failure without hiding the publish error", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });

  await assert.rejects(
    deployRuntime({
      sourceRoot,
      runtimeRoot,
      releaseId: "release-2",
      protectPointer: async () => { throw new Error("pointer protection failed"); },
      restorePointer: async () => { throw new Error("pointer rollback failed"); },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /pointer protection failed/u);
      assert.deepEqual(error.errors.map((item) => item.message), [
        "pointer protection failed",
        "pointer rollback failed",
      ]);
      return true;
    },
  );
});

test("activation preserves source data when an incomplete runtime target already exists", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  await mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "data", "partial.json"), "{}\n", "utf8");

  await assert.rejects(
    activateRuntime({ sourceRoot, runtimeRoot }),
    /data migration is incomplete/,
  );
  assert.equal(JSON.parse(await readFile(path.join(sourceRoot, "data", "state.json"), "utf8")).offset, 1);
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "data", "partial.json"), "utf8")).constructor, Object);
});

test("runtime config and data are external, activation is explicit and rollback is atomic", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  await prepareRuntimeConfig({ sourceRoot, runtimeRoot });
  const config = JSON.parse(await readFile(path.join(runtimeRoot, "config.json"), "utf8"));
  assert.equal(config.telegramBotToken, "123:secret");
  assert.equal(config.dataDir, "data");
  assert.equal((await runtimeStatus({ runtimeRoot })).active, false);

  await activateRuntime({ sourceRoot, runtimeRoot });
  assert.equal((await runtimeStatus({ runtimeRoot })).active, true);
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "data", "state.json"), "utf8")).offset, 1);
  await assert.rejects(readFile(path.join(sourceRoot, "config.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(sourceRoot, "data", "state.json"), "utf8"), /ENOENT/);

  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });
  await writeFile(path.join(runtimeRoot, "data", "bot.lock"), JSON.stringify({
    pid: process.pid,
    instanceToken: "test-runtime",
    releaseId: "release-1",
    ready: true,
  }), "utf8");
  assert.deepEqual(await runtimeStatus({ runtimeRoot }), {
    root: path.resolve(runtimeRoot),
    current: "release-2",
    previous: "release-1",
    configured: true,
    active: true,
    running: true,
    ready: true,
    pid: process.pid,
    runningRelease: "release-1",
    restartRequired: true,
  });
  assert.deepEqual(await rollbackRuntime({ runtimeRoot }), {
    current: "release-1",
    previous: "release-2",
  });
});
