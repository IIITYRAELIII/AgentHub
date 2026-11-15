import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as checkpoints from "../../../src/infrastructure/persistence/test-file-checkpoint.mjs";
import { explainTestInputFingerprint } from "../../../src/infrastructure/persistence/test-input-fingerprint.mjs";
import * as runner from "../../../test-suite.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("subset execution retains other failures and retry planning never converts them into success", async t => {
  const root = await fixture(t);
  const checkpoint = checkpoints.testFileCheckpointStore(path.join(root, "checkpoint.json"));
  const options = { suite: "unit", identity: "first", checkpoint, log: () => {},
    fingerprint: async () => "same-input", run: async () => { throw new Error("original failure"); } };
  await assert.rejects(checkpoints.runCheckpointedTestFiles(["failed-a", "failed-b"], options), /original failure/);
  await checkpoints.runCheckpointedTestFiles(["failed-a"], { ...options, run: async () => {} });
  assert.deepEqual((await checkpoint.read()).suites.unit.failedFiles, ["failed-b"]);
  const before = await readFile(path.join(root, "checkpoint.json"));
  const plan = await checkpoints.planCheckpointedTestFiles(["failed-a", "failed-b", "new"], options);
  assert.deepEqual(plan.entries.map(entry => entry.status), ["reusable", "failed", "unproven"]);
  assert.deepEqual(plan.selectedFiles, ["failed-b", "new"]);
  assert.deepEqual(await readFile(path.join(root, "checkpoint.json")), before);
});

test("failed and affected rerun, unchanged success survives restart and a lost terminal reply", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets/view.html"), "first asset");
  await writeFile(path.join(root, "dependency.mjs"), "export const value = 1;\n");
  await writeFile(path.join(root, "affected.mjs"), "import './dependency.mjs';\n");
  await writeFile(path.join(root, "unchanged.mjs"), "export const value = 2;\n");
  await writeFile(path.join(root, "failed.mjs"), "export const value = 3;\n");
  await writeFile(path.join(root, "unknown.mjs"), "await import(selectedModule);\n");
  const file = path.join(root, "checkpoint.json");
  const checkpoint = checkpoints.testFileCheckpointStore(file);
  let environment = { LANG: "C", SECRET: "private-value" };
  let toolchain = { node: "original" };
  const fingerprint = id => explainTestInputFingerprint(id, { cwd: root, environment, toolchain,
    declaration: id === "affected.mjs" ? { inputs: ["assets"] } : null });
  const files = ["affected.mjs", "unchanged.mjs", "failed.mjs", "unknown.mjs"];
  const options = { suite: "unit", identity: "generation-one", checkpoint, fingerprint, log: () => {} };
  await assert.rejects(checkpoints.runCheckpointedTestFiles(files, { ...options,
    run: async id => { if (id === "failed.mjs") throw new Error("original assertion"); } }), /original assertion/);
  await writeFile(path.join(root, "dependency.mjs"), "export const value = 4;\n");
  const plan = await checkpoints.planCheckpointedTestFiles(files, options);
  assert.deepEqual(plan.entries.map(entry => entry.status), ["affected", "reusable", "failed", "unknown"]);
  const executed = [];
  await checkpoints.runCheckpointedTestFiles(files, { ...options, identity: "generation-two",
    checkpoint: checkpoints.testFileCheckpointStore(file), run: async id => executed.push(id) });
  assert.deepEqual(executed, ["affected.mjs", "failed.mjs", "unknown.mjs"]);
  // The original durable success exists, but its caller did not retain the reply.
  const resumed = [];
  await checkpoints.runCheckpointedTestFiles(files, { ...options, identity: "generation-two",
    checkpoint: checkpoints.testFileCheckpointStore(file), run: async id => resumed.push(id) });
  assert.deepEqual(resumed, ["unknown.mjs"]);
  const original = (await fingerprint("affected.mjs")).fingerprint;
  await writeFile(path.join(root, "assets/view.html"), "changed asset");
  assert.notEqual((await fingerprint("affected.mjs")).fingerprint, original);
  let next = await checkpoints.planCheckpointedTestFiles(files, options);
  assert.equal(next.entries[0].status, "affected");
  environment = { ...environment, LANG: "ru" };
  next = await checkpoints.planCheckpointedTestFiles(files, options);
  assert.equal(next.entries[1].status, "affected");
  toolchain = { node: "changed" };
  assert.notEqual((await fingerprint("unchanged.mjs")).fingerprint,
    (await checkpoint.read()).suites.unit.completedFingerprints["unchanged.mjs"]);
  // A proposal cannot freeze a reusable decision across later input drift.
  const driftRuns = [];
  await checkpoints.runCheckpointedTestFiles(files, { ...options, run: async id => driftRuns.push(id) });
  assert.equal(driftRuns.includes("unchanged.mjs"), true);
  assert.equal((await readFile(file, "utf8")).includes("private-value"), false);
});

test("selected profile changes cannot borrow a prior profile success under the same parent environment", async t => {
  const parent = path.resolve(import.meta.dirname, "../../../WIP");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "retry-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "pure.mjs"), "export const value = 1;\n");
  const file = path.relative(path.resolve(import.meta.dirname, "../../.."), path.join(root, "pure.mjs")).split(path.sep).join("/");
  const entry = { id: "profile:cosmetic:fixture", file, suite: "cosmetic", isolation: true,
    env: { AGENT_HUB_TEST_PROFILES: "cosmetic" } };
  const observed = [];
  const options = { checkpointIdentity: "profile-binding", checkpoint: checkpoints.testFileCheckpointStore(path.join(root, "state.json")),
    inventory: [entry], prepareDependencies: async () => {}, createAdmission: async () => null,
    report: () => {}, onFile: () => {}, execute: async (_command, _args, { env }) => observed.push(env.AGENT_HUB_TEST_PROFILES) };
  await runner.runSelectedTests({ mode: "include", ids: [entry.id] }, options);
  entry.env = { AGENT_HUB_TEST_PROFILES: "stress" };
  await runner.runSelectedTests({ mode: "include", ids: [entry.id] }, options);
  assert.deepEqual(observed, ["cosmetic", "stress"]);
});

test("actual isolated child input proof ignores overwritten parent state and binds profiles and OS identity", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "test.mjs"), "export const value = 1;\n");
  const first = { TEMP: "parent-one", HOME: "home-one", APPDATA: "state-one", USERPROFILE: "OS-user",
    LANG: "C", AGENT_HUB_TEST_PROFILES: "cosmetic", AGENT_HUB_PUBLICATION_SESSION: "capability-one" };
  const second = { ...first, TEMP: "parent-two", HOME: "home-two", APPDATA: "state-two",
    AGENT_HUB_PUBLICATION_SESSION: "capability-two" };
  const proof = environment => explainTestInputFingerprint("test.mjs", { cwd: root,
    environment: runner.isolatedTestEnvironment(environment, "<owned-per-child-temp>") });
  const initial = (await proof(first)).fingerprint;
  assert.match(initial, /^[a-f0-9]{64}$/u);
  assert.equal((await proof(second)).fingerprint, initial);
  for (const change of [{ USERPROFILE: "other-user" }, { LANG: "ru" }, { AGENT_HUB_TEST_PROFILES: "stress" }]) {
    assert.notEqual((await proof({ ...second, ...change })).fingerprint, initial);
  }
  const windows = runner.isolatedTestEnvironment({ temp: "old", TeMp: "new", userprofile: "real-user" }, "owned", "win32");
  assert.equal(windows.TEMP, "owned");
  assert.equal(windows.USERPROFILE, "real-user");
  assert.equal(Object.hasOwn(windows, "temp"), false);
  let actual;
  await runner.runIsolatedTestCommand(process.execPath, ["-e", ""], {
    env: { AGENT_HUB_TEST_PROFILES: "cosmetic", HOME: "ignored" },
    execute: async (_command, _args, options) => { actual = options.env; },
  });
  assert.equal(actual.AGENT_HUB_TEST_PROFILES, "cosmetic");
  assert.notEqual(actual.HOME, "ignored");
  assert.equal(actual.HOME, actual.TEMP);
  assert.equal(actual.AGENT_HUB_PUBLICATION_SESSION, undefined);
});

test("retry proposal resolves exact inventory without executing or writing and never silently omits unknown checks", async t => {
  const root = await fixture(t);
  const checkpoint = checkpoints.testFileCheckpointStore(path.join(root, "checkpoint.json"));
  await checkpoints.runCheckpointedTestFiles(["stable"], { suite: "unit", identity: "old", checkpoint,
    fingerprint: async () => "same", run: async () => {}, log: () => {} });
  const before = await readFile(path.join(root, "checkpoint.json"));
  const inventory = ["stable", "changed", "unknown", "check:worker"].map(id => ({ id, file: id, suite: "unit" }));
  const plan = await runner.planTestRetry({ mode: "include", ids: inventory.map(entry => entry.id) }, {
    checkpointIdentity: "new", checkpoint, inventory,
    fingerprint: async id => id === "stable" ? "same" : id === "unknown" || id === "check:worker" ? null : "new",
  });
  assert.equal(plan.status, "proposal-only");
  assert.deepEqual(plan.reusedFiles, ["stable"]);
  assert.deepEqual(plan.selection, { mode: "include", ids: ["changed", "check:worker", "unknown"] });
  assert.deepEqual(await readFile(path.join(root, "checkpoint.json")), before);
  await assert.rejects(runner.planTestRetry({ mode: "include", ids: ["typo"] }, { inventory }), /Unknown test selector/);
});

test("ordinary selected execution binds actual profile overrides and reuses across overwritten parent temp changes", async t => {
  const parent = path.resolve(import.meta.dirname, "../../../WIP");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "retry-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "pure.mjs"), "export const value = 1;\n");
  const checkpoint = checkpoints.testFileCheckpointStore(path.join(root, "checkpoint.json"));
  const file = path.relative(path.resolve(import.meta.dirname, "../../.."), path.join(root, "pure.mjs")).split(path.sep).join("/");
  const entry = { id: "profile:cosmetic:fixture", file, suite: "cosmetic", isolation: true,
    env: { AGENT_HUB_TEST_PROFILES: "cosmetic" } };
  const selection = { mode: "include", ids: [entry.id] };
  const events = [];
  const executed = [];
  const options = { checkpointIdentity: "first", checkpoint, inventory: [entry],
    prepareDependencies: async () => {}, createAdmission: async () => null, report: () => {},
    onFile: event => events.push(event), execute: async (_command, _args, options) => executed.push(options.env.AGENT_HUB_TEST_PROFILES) };
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = "ignored-parent-one";
    await runner.runSelectedTests(selection, options);
    process.env.HOME = "ignored-parent-two";
    await runner.runSelectedTests(selection, { ...options, checkpointIdentity: "next-generation" });
    assert.deepEqual(executed, ["cosmetic"]);
    assert.equal(events.at(-1).outcome, "reused");
    entry.env = { AGENT_HUB_TEST_PROFILES: "stress" };
    await runner.runSelectedTests(selection, options);
    assert.deepEqual(executed, ["cosmetic", "stress"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("diagnostic import refusals contain no arbitrary captured source", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "test.mjs"), "import 'private-package-secret';\n");
  const observed = await explainTestInputFingerprint("test.mjs", { cwd: root });
  assert.equal(observed.fingerprint, null);
  assert.deepEqual(observed.missReasons, ["undeclared-package"]);
  assert.equal(JSON.stringify(observed).includes("private-package-secret"), false);
});

test("actual allocation-parent drift invalidates success before an isolated child crosses its path budget", async t => {
  const root = await fixture(t);
  const short = path.join(root, "short");
  const long = path.join(root, "long-" + "x".repeat(20));
  await mkdir(short); await mkdir(long);
  const file = path.join(root, "allocator.test.mjs");
  const limit = short.length + 12;
  await writeFile(file, [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    `test("owned root meets the same fixed path budget", () => assert.ok(process.env.TEMP.length < ${limit}, "owned root crossed the fixed budget"));`,
  ].join("\n"));
  const previous = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map(key => [key, process.env[key]]));
  const use = parent => { for (const key of Object.keys(previous)) process.env[key] = parent; };
  const fingerprint = () => explainTestInputFingerprint(path.basename(file), { cwd: root,
    declaration: { globals: ["process"] },
    environment: runner.isolatedTestEnvironment(process.env, "<owned-per-child-temp>") });
  let executions = 0;
  const actualRoots = [];
  const options = { suite: "unit", identity: "allocation-proof", log: () => {}, fingerprint,
    checkpoint: checkpoints.testFileCheckpointStore(path.join(root, "checkpoint.json")),
    run: () => runner.runIsolatedTestCommand(process.execPath, ["--test", "--test-reporter=tap", file], { cwd: root,
      execute: async (command, args, { cwd, env }) => {
        executions += 1;
        actualRoots.push(env.TEMP);
        // This fixture runs inside Node's own test worker; its internal child
        // context must not turn the independently launched test into a worker.
        const child = await promisify(execFile)(command, args, {
          cwd, env: { ...env, NODE_TEST_CONTEXT: undefined }, encoding: "utf8", windowsHide: true,
        });
        assert.match(child.stdout, /# tests 1\b/u, "the real child assertion executed");
        return child;
      } }),
  };
  try {
    use(short);
    const before = await fingerprint();
    assert.match(before.fingerprint, /^[a-f0-9]{64}$/u);
    await checkpoints.runCheckpointedTestFiles([path.basename(file)], options);
    await checkpoints.runCheckpointedTestFiles([path.basename(file)], options);
    assert.equal(executions, 1, "random child suffix does not invalidate a durable success");
    use(long);
    const after = await fingerprint();
    assert.deepEqual(after.missReasons, []);
    assert.notEqual(after.fingerprint, before.fingerprint, "actual allocation location is a proven input");
    await assert.rejects(checkpoints.runCheckpointedTestFiles([path.basename(file)], options), error =>
      error.errors?.some(child => /owned root crossed the fixed budget/u.test(child.stdout ?? "")));
    assert.equal(executions, 2, "changed allocation runs rather than borrowing the old success");
    assert.equal(actualRoots[0].length < limit, true);
    assert.equal(actualRoots[1].length > limit, true);
    assert.equal((await options.checkpoint.read()).suites.unit.completedFingerprints[path.basename(file)], undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
