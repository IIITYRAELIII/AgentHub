import assert from "node:assert/strict";
import test from "node:test";
import { ownedGitArguments, preparationGitInvocation, withPreparationGitIsolation }
  from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";

test("shared Git argument policy is Windows-only, idempotent and leaves external commands unchanged", () => {
  const args = ["--no-replace-objects", "-C", "fixture", "rev-parse", "HEAD"];
  const snapshot = [...args];
  const windows = ownedGitArguments(args, { platform: "win32", executable: "C:\\Git\\bin\\GIT.EXE" });
  assert.deepEqual(windows, ["-c", "core.longpaths=true", ...snapshot]);
  assert.deepEqual(ownedGitArguments(windows, { platform: "win32" }), windows);
  assert.deepEqual(args, snapshot);
  for (const platform of ["linux", "darwin"]) assert.equal(ownedGitArguments(args, { platform }), args);
  for (const executable of [process.execPath, "npm", "cmd.exe", "gh", "notgit.exe"]) {
    assert.equal(ownedGitArguments(args, { platform: "win32", executable }), args);
  }
});

test("inactive, authenticated remote and scrubbed local preparation share policy without changing environment authority", () => {
  const expected = process.platform === "win32" ? "true" : null;
  const setting = args => {
    const at = args.indexOf("core.longpaths=true");
    return at >= 0 && args[at - 1] === "-c" ? "true" : null;
  };
  const before = { ...process.env };
  assert.equal(setting(preparationGitInvocation(["status"], "fixture").args), expected);
  withPreparationGitIsolation("fixture-isolation", () => {
    for (const args of [["status"], ["ls-remote", "origin"], ["fetch", "origin"]]) {
      const invocation = preparationGitInvocation(args, "fixture-root");
      assert.equal(setting(invocation.args), expected);
      assert.deepEqual(invocation.args.slice(-args.length), args);
      assert.ok(invocation.args.includes("core.fsmonitor=false"));
      assert.ok(invocation.args.includes("maintenance.auto=false"));
      assert.ok(!Object.keys(invocation.env).some(key => /^GIT_(?:DIR|INDEX_FILE|OBJECT_DIRECTORY|CONFIG_COUNT)$/iu.test(key)));
      if (args[0] === "status") {
        assert.equal(invocation.env.GIT_CONFIG_NOSYSTEM, "1");
        assert.equal(invocation.env.GIT_TERMINAL_PROMPT, "0");
      }
    }
  });
  assert.equal(Object.keys(process.env).length === Object.keys(before).length
    && Object.keys(before).every(key => process.env[key] === before[key]), true,
  "argument construction must not change process environment");
});
