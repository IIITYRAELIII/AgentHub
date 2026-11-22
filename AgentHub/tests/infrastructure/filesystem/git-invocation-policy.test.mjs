import assert from "node:assert/strict";
import test from "node:test";
import { assertPreparationProcessOwned, ownedGitArguments, preparationGitInvocation, withPreparationGitIsolation }
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

test("nested preparation checks a covered lease once and still checks each distinct wrapper", async () => {
  const calls = [];
  let valid = true;
  const inherited = { ownerId: "same", async assertOwned() {
    calls.push("repository");
    if (!valid) throw new Error("repository lease lost");
  } };
  const composed = { async assertOwned() { await inherited.assertOwned(); calls.push("pool"); } };
  const other = { ownerId: "same", async assertOwned() { calls.push("other"); } };
  await withPreparationGitIsolation("fixture", async () => {
    await withPreparationGitIsolation("fixture", assertPreparationProcessOwned, composed, null, inherited);
    assert.deepEqual(calls, ["repository", "pool"]);
    calls.length = 0;
    await withPreparationGitIsolation("fixture", assertPreparationProcessOwned, other, null, other);
    assert.deepEqual(calls, ["repository", "other"]);
    calls.length = 0;
    valid = false;
    await assert.rejects(withPreparationGitIsolation("fixture", assertPreparationProcessOwned, composed, null, inherited),
      /repository lease lost/u);
    assert.deepEqual(calls, ["repository"]);
  }, inherited);
});

test("a preparation fence checks independent leases together and joins both on refusal", async () => {
  const events = [];
  let permitOuter;
  let permitInner;
  const outerHold = new Promise(resolve => { permitOuter = resolve; });
  const innerHold = new Promise(resolve => { permitInner = resolve; });
  const lost = new Error("candidate lease lost");
  const outer = { async assertOwned() {
    events.push("outer started");
    await outerHold;
    throw lost;
  } };
  const inner = { async assertOwned() {
    events.push("inner started");
    await innerHold;
    events.push("inner finished");
  } };
  const finished = withPreparationGitIsolation("fixture", () =>
    withPreparationGitIsolation("fixture", assertPreparationProcessOwned, inner), outer);
  let settled = false;
  const refusal = assert.rejects(finished, error => error === lost).then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["outer started", "inner started"]);
    permitOuter();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    permitOuter();
    permitInner();
    await refusal;
  }
  assert.equal(events.at(-1), "inner finished");
});

test("owned clone configuration survives server environment clearing without changing other Git verbs", () => {
  const args = ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", "clone", "clone", "--no-local", "fixture.bundle", "owned"];
  const expected = ["-c", "core.longpaths=true", ...args.slice(0, 6), "--config=core.longpaths=true", ...args.slice(6)];
  const configured = ownedGitArguments(args, { platform: "win32" });
  assert.deepEqual(configured, expected);
  assert.deepEqual(ownedGitArguments(configured, { platform: "win32" }), configured);
  const fetch = ["-C", "clone", "fetch", "clone", "commit"];
  assert.deepEqual(ownedGitArguments(fetch, { platform: "win32" }), ["-c", "core.longpaths=true", ...fetch]);
  assert.equal(ownedGitArguments(args, { platform: "linux" }), args);
  assert.equal(ownedGitArguments(args, { platform: "win32", executable: process.execPath }), args);
});
