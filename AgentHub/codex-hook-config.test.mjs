import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeCodexStopHookConfig,
  removeCodexStopHookConfig,
} from "./codex-hook-config.mjs";

const options = {
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
  launcherFile: "C:\\Runtime\\codex-stop-hook-launcher.mjs",
};

test("Codex hook config preserves unrelated hooks and installs one Stop handler", () => {
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
  assert.match(updated.hooks.Stop[1].hooks[0].commandWindows, /codex-stop-hook-launcher\.mjs/);
});

test("Codex hook config update replaces its previous handler without duplicates", () => {
  const once = mergeCodexStopHookConfig({}, options);
  const twice = mergeCodexStopHookConfig(once, {
    ...options,
    launcherFile: "D:\\Runtime\\codex-stop-hook-launcher.mjs",
  });
  assert.equal(twice.hooks.Stop.length, 1);
  assert.match(twice.hooks.Stop[0].hooks[0].command, /D:\\Runtime/);
});

test("Codex hook config removal leaves unrelated handlers intact", () => {
  const installed = mergeCodexStopHookConfig({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "other.exe" }] }] },
  }, options);
  const removed = removeCodexStopHookConfig(installed);
  assert.deepEqual(removed.hooks.Stop, [{ hooks: [{ type: "command", command: "other.exe" }] }]);
});
