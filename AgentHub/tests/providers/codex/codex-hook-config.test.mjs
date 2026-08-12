import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexStopHookStatus,
  installCodexStopHook,
  mergeCodexStopHookConfig,
  removeCodexStopHookConfig,
} from "../../../src/infrastructure/codex/codex-hook-config.mjs";
import { runtimeLayout } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";

const options = {
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
  launcherFile: "C:\\Runtime\\codex-stop-hook-launcher.mjs",
};

test("Codex hook config preserves unrelated hooks and installs start and stop handlers", () => {
  const existing = {
    description: "Personal hooks",
    hooks: {
      Stop: [{ matcher: "other", hooks: [{ type: "command", command: "other.exe" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "start.exe" }] }],
    },
  };
  const updated = mergeCodexStopHookConfig(existing, options);
  assert.equal(updated.description, "Personal hooks");
  assert.equal(updated.hooks.SessionStart.length, 1);
  assert.equal(updated.hooks.Stop.length, 2);
  assert.equal(updated.hooks.UserPromptSubmit.length, 1);
  assert.match(updated.hooks.Stop[1].hooks[0].commandWindows, /codex-stop-hook-launcher\.mjs/);
  assert.match(
    updated.hooks.UserPromptSubmit[0].hooks[0].commandWindows,
    /codex-stop-hook-launcher\.mjs/,
  );
});

test("Codex hook config update replaces its previous handler without duplicates", () => {
  const once = mergeCodexStopHookConfig({}, options);
  const twice = mergeCodexStopHookConfig(once, {
    ...options,
    launcherFile: "D:\\Runtime\\codex-stop-hook-launcher.mjs",
  });
  assert.equal(twice.hooks.Stop.length, 1);
  assert.equal(twice.hooks.UserPromptSubmit.length, 1);
  assert.match(twice.hooks.Stop[0].hooks[0].command, /D:\\Runtime/);
});

test("Codex hook config removal leaves unrelated handlers intact", () => {
  const installed = mergeCodexStopHookConfig({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "other.exe" }] }] },
  }, options);
  const removed = removeCodexStopHookConfig(installed);
  assert.deepEqual(removed.hooks.Stop, [{ hooks: [{ type: "command", command: "other.exe" }] }]);
  assert.equal(removed.hooks.UserPromptSubmit, undefined);
});

test("Codex hook status reports executable configuration and runtime receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-hook-status-"));
  try {
    const layout = runtimeLayout(root);
    const hooksFile = path.join(root, "hooks.json");
    await mkdir(layout.dataDir, { recursive: true });
    const launcherFile = path.join(path.dirname(hooksFile), "agent-hub-hooks", "codex-stop-hook-launcher.mjs");
    await mkdir(path.dirname(launcherFile), { recursive: true });
    await writeFile(launcherFile, "// launcher\n", "utf8");
    await writeFile(hooksFile, `${JSON.stringify(mergeCodexStopHookConfig({}, {
      nodeExecutable: process.execPath,
      launcherFile,
    }))}\n`, "utf8");
    await writeFile(path.join(layout.dataDir, "state.json"), `${JSON.stringify({
      codexHookReceipts: {
        start: { turnId: "turn-1", receivedAt: "2026-07-27T00:00:00.000Z" },
        stop: { turnId: "turn-1", receivedAt: "2026-07-27T00:01:00.000Z" },
      },
    })}\n`, "utf8");
    const status = await codexStopHookStatus({ hooksFile, runtimeRoot: root });
    assert.equal(status.configured, true);
    assert.equal(status.launcherAvailable, true);
    assert.equal(status.receipts.start.turnId, "turn-1");
    assert.equal(status.receipts.stop.turnId, "turn-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex hook installation copies the launcher beside Codex config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-hook-install-"));
  try {
    const runtimeRoot = path.join(root, "runtime");
    const hooksFile = path.join(root, "codex", "hooks.json");
    const source = runtimeLayout(runtimeRoot).codexHookLauncherFile;
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "// sandbox-readable launcher\n", "utf8");
    const installed = await installCodexStopHook({ hooksFile, runtimeRoot });
    assert.equal(
      installed.launcherFile,
      path.join(path.dirname(hooksFile), "agent-hub-hooks", "codex-stop-hook-launcher.mjs"),
    );
    assert.equal(await readFile(installed.launcherFile, "utf8"), "// sandbox-readable launcher\n");
    const config = JSON.parse(await readFile(hooksFile, "utf8"));
    assert.match(config.hooks.Stop[0].hooks[0].command, /agent-hub-hooks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
