import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { defaultRuntimeRoot, runtimeLayout, runtimeReleaseDirectory } from "./src/infrastructure/filesystem/runtime-layout.mjs";

test("defaultRuntimeRoot keeps Windows runtime outside the workspace", () => {
  assert.equal(
    defaultRuntimeRoot({ environment: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, platform: "win32" }),
    path.resolve("C:\\Users\\me\\AppData\\Local", "AgentHub"),
  );
});

test("runtimeLayout groups config, state and versioned releases", () => {
  const layout = runtimeLayout("C:\\Runtime");
  assert.equal(layout.configFile, path.resolve("C:\\Runtime", "config.json"));
  assert.equal(layout.dataDir, path.resolve("C:\\Runtime", "data"));
  assert.equal(
    layout.codexHookLauncherFile,
    path.resolve("C:\\Runtime", "codex-stop-hook-launcher.mjs"),
  );
  if (process.platform === "win32") {
    assert.equal(layout.launcherFile, path.resolve("C:\\Runtime", "AgentHub.RuntimeHost.exe"));
    assert.equal(
      layout.runtimeHostSourceHashFile,
      path.resolve("C:\\Runtime", "AgentHub.RuntimeHost.source.sha256"),
    );
    assert.equal(
      layout.runtimeHostBinaryHashFile,
      path.resolve("C:\\Runtime", "AgentHub.RuntimeHost.exe.sha256"),
    );
  }
  assert.equal(runtimeReleaseDirectory(layout.root, "release-1"), path.resolve("C:\\Runtime", "releases", "release-1"));
  assert.throws(() => runtimeReleaseDirectory(layout.root, "../escape"), /unsupported characters/);
});
