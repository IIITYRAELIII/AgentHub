import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateRuntime,
  deployRuntime,
  prepareRuntimeConfig,
  rollbackRuntime,
  runtimeStatus,
} from "../../runtime-manager.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

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

test("deployRuntime publishes an atomic release without tests or local config", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  const first = await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  assert.equal(JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8")).current, "release-1");
  const firstManifest = JSON.parse(await readFile(path.join(first.releaseRoot, "runtime-manifest.json"), "utf8"));
  assert.equal(firstManifest.version, "2026.8.23");
  assert.equal(firstManifest.releaseVersion, "2026.8.23.1");
  assert.match(await readFile(path.join(first.releaseRoot, "agent-hub-server.mjs"), "utf8"), /ready/);
  assert.match(await readFile(path.join(first.releaseRoot, "helper.cjs"), "utf8"), /module\.exports/u);
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
  await assert.rejects(readFile(path.join(runtimeRoot, "releases", "release-1", "agent-hub-server.mjs"), "utf8"), /ENOENT/);
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

test("deployRuntime keeps a locked old release without failing the published pointer", async () => {
  const { sourceRoot, runtimeRoot } = await fixture();
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-1" });
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });
  const warnings = [];
  await deployRuntime({
    sourceRoot,
    runtimeRoot,
    releaseId: "release-3",
    removeRelease: async (target) => {
      const error = new Error("locked by running bot");
      error.code = "EBUSY";
      throw error;
    },
    onPruneWarning: (error, target) => warnings.push({ error, target }),
  });
  const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  assert.equal(pointer.current, "release-3");
  assert.equal(pointer.previous, "release-2");
  assert.equal(warnings.length, 1);
  assert.match(await readFile(path.join(runtimeRoot, "releases", "release-1", "agent-hub-server.mjs"), "utf8"), /ready/);
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
