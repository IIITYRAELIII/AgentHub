import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateRuntime,
  deployRuntime,
  prepareRuntimeConfig,
  rollbackRuntime,
  runtimeStatus,
} from "./runtime-manager.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-runtime-"));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(path.join(sourceRoot, "assets"), { recursive: true });
  await writeFile(path.join(sourceRoot, "bot.mjs"), "export const ready = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "helper.mjs"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(sourceRoot, "helper.test.mjs"), "throw new Error('not runtime');\n", "utf8");
  await writeFile(path.join(sourceRoot, "runtime-launch.ps1"), "node bot.mjs\n", "utf8");
  await writeFile(path.join(sourceRoot, "runtime-launch.vbs"), "WScript.Quit 0\n", "utf8");
  await writeFile(path.join(sourceRoot, "runtime-launch.sh"), "#!/usr/bin/env sh\nexec node bot.mjs\n", "utf8");
  await writeFile(path.join(sourceRoot, "install-autostart.ps1"), "Write-Output 'installed'\n", "utf8");
  await writeFile(path.join(sourceRoot, "start.ps1"), "node bot.mjs\n", "utf8");
  await writeFile(path.join(sourceRoot, "package.json"), "{}\n", "utf8");
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
  assert.match(await readFile(path.join(first.releaseRoot, "bot.mjs"), "utf8"), /ready/);
  assert.match(await readFile(path.join(first.releaseRoot, "install-autostart.ps1"), "utf8"), /installed/);
  if (process.platform === "win32") {
    assert.match(await readFile(path.join(runtimeRoot, "launch.vbs"), "utf8"), /WScript/);
    assert.match(await readFile(path.join(runtimeRoot, "runtime-launch.vbs"), "utf8"), /WScript/);
    assert.match(await readFile(path.join(runtimeRoot, "launch.ps1"), "utf8"), /node bot/);
  }
  await assert.rejects(readFile(path.join(first.releaseRoot, "helper.test.mjs"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(first.releaseRoot, "config.json"), "utf8"), /ENOENT/);

  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-2" });
  const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  assert.deepEqual({ current: pointer.current, previous: pointer.previous }, {
    current: "release-2",
    previous: "release-1",
  });
  await deployRuntime({ sourceRoot, runtimeRoot, releaseId: "release-3" });
  await assert.rejects(readFile(path.join(runtimeRoot, "releases", "release-1", "bot.mjs"), "utf8"), /ENOENT/);
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
  assert.match(await readFile(path.join(runtimeRoot, "releases", "release-1", "bot.mjs"), "utf8"), /ready/);
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
  assert.deepEqual(await rollbackRuntime({ runtimeRoot }), {
    current: "release-1",
    previous: "release-2",
  });
});
