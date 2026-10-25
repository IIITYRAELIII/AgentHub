import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  testExecutionPolicy,
  testFingerprint,
  runWindowsTestFile,
  runIsolatedTestCommand,
  runTestSuite,
  prepareTestDependencies,
} from "../../test-suite.mjs";
import {
  explainTestInputFingerprint,
  parallelTestExecution,
} from "../../src/infrastructure/persistence/test-input-fingerprint.mjs";
import { withPublicationLock } from "../../src/infrastructure/process/publication-lock.mjs";

test("isolated file failure retains the actual owned Node close receipt after cleanup", async () => {
  let observed;
  await assert.rejects(runIsolatedTestCommand(process.execPath, ["-e", "process.exit(3)"]), error => {
    observed = error;
    return true;
  });
  assert.equal(observed.testPhase, "execution");
  assert.equal(observed.testExecutionSucceeded, false);
  assert.ok(Number.isSafeInteger(observed.testChild.pid));
  assert.equal(observed.testChild.code, 3);
  assert.ok(Date.parse(observed.testChild.requestedAt) <= Date.parse(observed.testChild.spawnedAt));
  assert.ok(Date.parse(observed.testChild.spawnedAt) <= Date.parse(observed.testChild.exitedAt));
  assert.ok(Date.parse(observed.testChild.exitedAt) <= Date.parse(observed.testChild.closedAt));
  await assert.rejects(access(observed.testRoot), { code: "ENOENT" });
});

test("diagnostic annotation preserves original failures and caller-owned fields", async () => {
  const failures = [];
  for (const key of ["testRoot", "testPhase", "testExecutionSucceeded", "testChild"]) {
    const readonly = new Error("original readonly failure");
    Object.defineProperty(readonly, key, { value: { caller: true }, writable: false });
    failures.push(readonly);
    const accessor = new Error("original accessor failure");
    Object.defineProperty(accessor, key, {
      get() { assert.fail("diagnostics must not read caller accessors"); },
      set() { assert.fail("diagnostics must not write caller accessors"); },
    });
    failures.push(accessor);
  }
  failures.push(Object.preventExtensions(new Error("original nonextensible failure")));
  for (const trap of ["has", "getOwnPropertyDescriptor", "defineProperty", "isExtensible"]) {
    failures.push(new Proxy(new Error("original inspection failure"), {
      [trap]() { throw new Error("diagnostic inspection refused"); },
    }));
  }
  for (const original of failures) {
    let calls = 0;
    let root;
    let observed;
    try {
      await runIsolatedTestCommand("fixture", [], { execute: async (_command, _args, { env }) => {
        calls += 1;
        root = env.TEMP;
        throw original;
      } });
    } catch (error) { observed = error; }
    assert.equal(observed, original);
    assert.equal(calls, 1);
    await assert.rejects(access(root), { code: "ENOENT" });
  }
});

test("child diagnostic inspection never changes the execution outcome", async () => {
  for (const original of [null, new Error("original execution failure")]) {
    let calls = 0;
    let root;
    let observed;
    try {
      await runIsolatedTestCommand("fixture", [], { execute: async (_command, _args, { env, onChild }) => {
        calls += 1;
        root = env.TEMP;
        onChild(Object.defineProperty({}, "pid", { get() { throw new Error("diagnostic getter refused"); } }));
        if (original) throw original;
      } });
    } catch (error) { observed = error; }
    assert.equal(observed, original ?? undefined);
    assert.equal(calls, 1);
    await assert.rejects(access(root), { code: "ENOENT" });
  }
});

test("cold full-test checkout installs locked development dependencies once before every suite", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-test-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageJson = { name: "cold-generation", version: "1.0.0", devDependencies: { "browser-fixture": "1.0.0" } };
  const entry = { version: "1.0.0", resolved: "https://registry.example.invalid/browser-fixture.tgz", integrity: "sha512-fixture", dev: true };
  const lock = { name: packageJson.name, lockfileVersion: 3, packages: { "": packageJson, "node_modules/browser-fixture": entry } };
  await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const capabilityKeys = ["AGENT_HUB_PUBLICATION_SESSION", "AGENT_HUB_PUBLICATION_STAGE_DELEGATION"];
  const precedingCapabilities = Object.fromEntries(capabilityKeys.map((key) => [key, process.env[key]]));
  for (const key of capabilityKeys) process.env[key] = "fixture-publisher-capability";
  t.after(() => {
    for (const key of capabilityKeys) {
      if (precedingCapabilities[key] === undefined) delete process.env[key];
      else process.env[key] = precedingCapabilities[key];
    }
  });
  const packageFile = path.join(root, "node_modules", "browser-fixture", "package.json");
  await assert.rejects(readFile(packageFile), { code: "ENOENT" });
  let installs = 0;
  const prepare = () => prepareTestDependencies({ root, execute: async (args, options) => {
    installs += 1;
    assert.ok(args.includes("--include=dev"));
    assert.ok(args.includes("--include=optional"));
    assert.equal(options.cwd, root);
    assert.equal(options.commandLabel, "npm");
    assert.equal(options.env.AGENT_HUB_PUBLICATION_SESSION, undefined);
    assert.equal(options.env.AGENT_HUB_PUBLICATION_STAGE_DELEGATION, undefined);
    for (const key of capabilityKeys) assert.equal(Object.hasOwn(options.env, key), true);
    assert.ok(options.signal instanceof AbortSignal);
    await access(path.join(root, "WIP", "test-dependencies.lock"));
    await mkdir(path.dirname(packageFile), { recursive: true });
    await writeFile(packageFile, JSON.stringify({ name: "browser-fixture", version: entry.version }));
    await writeFile(path.join(root, "node_modules", ".package-lock.json"), JSON.stringify({
      lockfileVersion: 3, packages: { "node_modules/browser-fixture": entry },
    }));
  } });
  let validationCalls = 0;
  const validate = async () => {
    assert.equal(JSON.parse(await readFile(packageFile, "utf8")).version, "1.0.0");
    validationCalls += 1;
  };
  await runTestSuite("all", {
    checkpointIdentity: "", checkpoint: null,
    prepareDependencies: prepare,
    discover: async () => ["tests/composition/example.test.mjs", "tests/domain/example.test.mjs"],
    execute: validate,
  });
  assert.ok(validationCalls > 1);
  assert.equal(installs, 1);
  assert.equal((await prepare())[0].prepared, false);
  assert.equal(installs, 1);
  await assert.rejects(access(path.join(root, "WIP", "test-dependencies.lock")), { code: "ENOENT" });

  // A changed lock cannot reuse the preceding successful dependency marker.
  const marker = path.join(root, "node_modules", ".agent-hub-task-dependencies.json");
  const priorMarker = await readFile(marker);
  entry.version = "2.0.0";
  packageJson.devDependencies["browser-fixture"] = "2.0.0";
  await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  const failure = new Error("dependency process failed");
  validationCalls = 0;
  await assert.rejects(runTestSuite("all", {
    prepareDependencies: () => prepareTestDependencies({ root, execute: async () => { throw failure; } }),
    execute: validate,
  }), (error) => error === failure);
  assert.equal(validationCalls, 0);
  assert.deepEqual(await readFile(marker), priorMarker);
  await assert.rejects(access(path.join(root, "WIP", "test-dependencies.lock")), { code: "ENOENT" });
});

test("test checkpoint fingerprints only transitive module dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-fingerprint-"));
  try {
    await writeFile(path.join(root, "dependency.mjs"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(root, "side-effect.mjs"), "export const loaded = true;\n", "utf8");
    await writeFile(path.join(root, "test.mjs"), [
      "import './side-effect.mjs';",
      "import { value } from './dependency.mjs';",
      "export default value;",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "unrelated.mjs"), "export const unrelated = 1;\n", "utf8");

    const initial = await testFingerprint("test.mjs", { cwd: root });
    assert.match(initial, /^[a-f0-9]{64}$/u);
    await writeFile(path.join(root, "unrelated.mjs"), "export const unrelated = 2;\n", "utf8");
    assert.equal(await testFingerprint("test.mjs", { cwd: root }), initial);

    await writeFile(path.join(root, "dependency.mjs"), "export const value = 2;\n", "utf8");
    assert.notEqual(await testFingerprint("test.mjs", { cwd: root }), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test execution never retries an assertion or an unclassified OS error", async () => {
  for (const failure of [new assert.AssertionError({ message: "deterministic" }), Object.assign(new Error("locked"), { code: "EPERM" })]) {
    let calls = 0;
    await assert.rejects(runWindowsTestFile("failure.mjs", {
      execute: async () => { calls += 1; throw failure; },
    }), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test("native busy temp cleanup preserves execution and cleanup outcomes without replay", {
  skip: process.platform !== "win32",
}, async () => {
  for (const executionError of [null, new assert.AssertionError({ message: "original assertion" }),
    Object.assign(new Error("original OS failure"), { code: "EPERM" })]) {
    let holder;
    let root;
    let calls = 0;
    let observed;
    try {
      await runIsolatedTestCommand("fixture", [], { execute: async (_command, _args, { env }) => {
        calls += 1;
        root = env.TEMP;
        const script = "$f=[IO.File]::Open($env:AH_TEST_LOCK_FILE,'OpenOrCreate','ReadWrite','None');"
          + "try{[Console]::WriteLine('locked');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}";
        holder = spawn(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AH_TEST_LOCK_FILE: path.join(root, "owned.lock") } });
        const ready = await Promise.race([
          once(holder.stdout, "data").then(([chunk]) => String(chunk)),
          once(holder, "exit").then(([code]) => { throw new Error(`lock holder exited ${code}`); }),
          once(holder, "error").then(([error]) => { throw error; }),
        ]);
        assert.match(ready, /locked/u);
        if (executionError) throw executionError;
      } });
    } catch (error) {
      observed = error;
    } finally {
      if (holder && holder.exitCode === null) {
        const closed = once(holder, "close");
        holder.stdin.end("release\n");
        await closed;
      }
      if (root) await rm(root, { recursive: true, force: true });
    }
    assert.equal(calls, 1);
    const cleanupError = executionError ? observed.errors[1] : observed;
    if (executionError) {
      assert.ok(observed instanceof AggregateError);
      assert.equal(observed.cause, executionError);
      assert.equal(observed.errors[0], executionError);
    }
    assert.equal(cleanupError.code, "EBUSY");
    assert.equal(cleanupError.testPhase, "cleanup");
    assert.equal(cleanupError.testRoot, root);
    assert.equal(cleanupError.testExecutionSucceeded, !executionError);
  }
});

test("a changed runner accounting input invalidates otherwise identical successful test evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-runner-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "test.mjs"), "export const valid = true;\n");
  const accounting = path.join(root, "accounting.cs");
  await writeFile(accounting, "first accounting implementation");
  const options = { cwd: root, runnerInputs: [accounting] };
  const first = await testFingerprint("test.mjs", options);
  assert.match(first, /^[a-f0-9]{64}$/u);
  await writeFile(accounting, "corrected accounting implementation");
  assert.notEqual(await testFingerprint("test.mjs", options), first);
});

test("parallel execution is independent from cache eligibility", () => {
  assert.deepEqual(testExecutionPolicy(undefined), { parallel: true, shared: [] });
  assert.deepEqual(testExecutionPolicy({ builtins: ["child_process"] }), { parallel: true, shared: [] });
  assert.deepEqual(testExecutionPolicy({ builtins: ["child_process"], execution: { shared: ["fixture"] } }), { parallel: true, shared: ["fixture"] });
  assert.throws(() => testExecutionPolicy({ execution: { shared: ["invalid resource"] } }), /shared-resource/u);
});

test("legacy cache declarations retain validated shared-resource ownership", () => {
  assert.equal(parallelTestExecution({ execution: { parallel: true } }), null);
  assert.equal(parallelTestExecution({
    execution: {
      parallel: true,
      isolation: {
        filesystem: "per-child-temp", locks: "per-test-temp", git: "none",
        ports: "none", browerProfile: "none",
      },
    },
  }), null);
  assert.equal(parallelTestExecution({
    execution: {
      parallel: true,
      isolation: {
        filesystem: "none", locks: "per-test-temp", git: "none",
        ports: "none", browserProfile: "none",
      },
    },
  }), null);
  assert.deepEqual(parallelTestExecution({
    execution: {
      parallel: true,
      isolation: {
        filesystem: "per-child-temp", locks: "per-test-temp", git: "none",
        ports: "none", browserProfile: "none",
      },
      shared: ["fixture-a"],
    },
  }), { parallel: true, shared: ["fixture-a"] });
});

test("each test process receives a disposable environment root", async () => {
  const roots = [];
  for (let index = 0; index < 2; index += 1) {
    await runWindowsTestFile("environment.test.mjs", {
      env: { LOCALAPPDATA: "must-not-be-inherited", TEMP: "must-not-be-inherited" },
      execute: async (_command, _args, { env }) => {
        assert.notEqual(env.LOCALAPPDATA, "must-not-be-inherited");
        assert.equal(env.LOCALAPPDATA, env.TEMP);
        assert.equal(env.TEMP, env.TMP);
        for (const name of ["APPDATA", "HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) assert.equal(env[name], env.TEMP);
        assert.equal(Object.hasOwn(env, "USERPROFILE"), false, "Windows OS identity stays intact for native browser KnownFolders");
        assert.ok(path.basename(env.LOCALAPPDATA).length <= 10);
        await access(env.LOCALAPPDATA);
        roots.push(env.LOCALAPPDATA);
      },
    });
  }
  assert.notEqual(roots[0], roots[1]);
  for (const root of roots) await assert.rejects(access(root), { code: "ENOENT" });
});

test("test child processes never inherit publication mutation ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-publication-env-"));
  try {
    await writeFile(path.join(root, "environment.test.mjs"), [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('isolated publication environment', () => {",
      "  assert.equal(process.env.AGENT_HUB_PUBLICATION_SESSION, undefined);",
      "  assert.equal(process.env.AGENT_HUB_PUBLICATION_STAGE_DELEGATION, undefined);",
      "});",
      "",
    ].join("\n"), "utf8");
    await runWindowsTestFile("environment.test.mjs", {
      cwd: root,
      env: {
        AGENT_HUB_PUBLICATION_SESSION: "publisher-session",
        AGENT_HUB_PUBLICATION_STAGE_DELEGATION: "publisher-delegation",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every default-lock validation suite uses a fixture root while the publisher lock is held", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-held-publication-lock-"));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    const files = [
      "tests/infrastructure/persistence/publication-state.test.mjs",
      "tests/infrastructure/persistence/github-publication-baseline.test.mjs",
      "tests/infrastructure/persistence/local-publication-receipt-baseline.test.mjs",
      "tests/application/request-safe-restart.test.mjs",
      "tests/public/release-candidate-contour.test.mjs",
      "tests/public/publish-all.test.mjs",
      "tests/runtime/runtime-publication-completion.test.mjs",
    ];
    await withPublicationLock(async () => {
      for (const file of files) {
        await runWindowsTestFile(file, { cwd: path.resolve(import.meta.dirname, "../..") });
      }
    });
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("visual matrices run explicitly and exactly once in all, never in the unit suite", async () => {
  const visual = ["tests/public/card-layout-dom.test.mjs", "tests/public/journal-account-provider-column.test.mjs"];
  const discovery = ["tests/composition/example.test.mjs", "tests/domain/example.test.mjs", "tests/public/message-behavior.test.mjs", ...visual];
  async function invoked(mode) {
    const files = [];
    await runTestSuite(mode, {
      checkpointIdentity: "", checkpoint: null,
      prepareDependencies: async () => [],
      discover: async () => discovery,
      execute: async (_command, args) => { files.push(...args.filter((argument) => argument.endsWith(".test.mjs"))); },
    });
    return files;
  }
  const unit = await invoked("unit");
  assert.deepEqual(unit, ["tests/domain/example.test.mjs", "tests/public/message-behavior.test.mjs"]);
  assert.deepEqual((await invoked("visual")).toSorted(), visual.toSorted());
  const all = await invoked("all");
  for (const file of discovery) assert.equal(all.filter((actual) => actual === file).length, 1, file);
});

test("sequential and bounded isolated runners execute the same declared file set", async () => {
  const discovery = [
    "tests/infrastructure/filesystem/task-git-workspace.test.mjs",
    "tests/infrastructure/filesystem/release-git-workspace.test.mjs",
    "tests/infrastructure/filesystem/release-task-net-projection.test.mjs",
    "tests/public/stream-tabs-controller.test.mjs",
  ];
  async function observed(testConcurrency) {
    const files = [];
    let active = 0;
    let maximumActive = 0;
    await runTestSuite("unit", {
      checkpointIdentity: "",
      checkpoint: null,
      discover: async () => discovery,
      testConcurrency,
      execute: async (_command, args) => {
        const file = args.find((argument) => argument.endsWith(".test.mjs"));
        files.push(file);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
      },
    });
    return { files: files.toSorted(), maximumActive };
  }

  const sequential = await observed(1);
  const bounded = await observed(2);
  assert.deepEqual(sequential.files, discovery.toSorted());
  assert.deepEqual(bounded.files, sequential.files);
  assert.equal(sequential.maximumActive, 1);
  assert.equal(bounded.maximumActive, 2);
});

test("fingerprints cover locks, declared fixtures, environment and toolchain without unrelated contour input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-inputs-"));
  try {
    await mkdir(path.join(root, "fixtures"));
    await writeFile(path.join(root, "test.mjs"), "import { readFile } from 'node:fs/promises';\n");
    await writeFile(path.join(root, "fixtures/value.json"), "1");
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const options = {
      cwd: root,
      declaration: { inputs: ["fixtures"], builtins: ["fs/promises"] },
      environment: { LANG: "C", SECRET: "do-not-persist" },
      toolchain: { node: "v24" },
    };
    const initial = await testFingerprint("test.mjs", options);
    assert.match(initial, /^[a-f0-9]{64}$/u);
    await writeFile(path.join(root, "test-contour.mjs"), "unrelated smoke correction");
    assert.equal(await testFingerprint("test.mjs", options), initial);
    for (const [file, next] of [["fixtures/value.json", "2"], ["package-lock.json", '{"lockfileVersion":3}']]) {
      const before = await testFingerprint("test.mjs", options);
      await writeFile(path.join(root, file), next);
      assert.notEqual(await testFingerprint("test.mjs", options), before);
    }
    const current = await testFingerprint("test.mjs", options);
    assert.equal(
      await testFingerprint("test.mjs", { ...options, environment: { ...options.environment, AGENT_HUB_PUBLICATION_SESSION: "first-attempt" } }),
      await testFingerprint("test.mjs", { ...options, environment: { ...options.environment, AGENT_HUB_PUBLICATION_SESSION: "resumed-attempt" } }),
    );
    assert.notEqual(await testFingerprint("test.mjs", { ...options, environment: { ...options.environment, LANG: "ru" } }), current);
    assert.notEqual(await testFingerprint("test.mjs", { ...options, toolchain: { node: "v25" } }), current);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("undeclared IO, computed imports and missing browser identity cannot reuse success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-uncached-"));
  try {
    for (const source of ["import fs from 'node:fs';", "await import(selectedModule);", "import { spawn } from 'node:child_process';", "const value = process.env.TEST_VALUE;"]) {
      await writeFile(path.join(root, "test.mjs"), source);
      assert.equal(await testFingerprint("test.mjs", { cwd: root }), null);
    }
    await writeFile(path.join(root, "test.mjs"), "export const value = 1;");
    assert.equal(await testFingerprint("test.mjs", { cwd: root, declaration: { browser: true } }), null);
    const binary = path.join(root, "browser.bin");
    await writeFile(binary, "browser-version-1");
    const options = { cwd: root, declaration: { browser: true }, browserFile: binary };
    const before = await testFingerprint("test.mjs", options);
    await writeFile(binary, "browser-version-2");
    assert.notEqual(await testFingerprint("test.mjs", options), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fingerprint diagnostics explain misses without exposing input contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fingerprint-reason-"));
  try {
    await writeFile(path.join(root, "test.mjs"), "const token = process.env.SECRET; await fetch('https://example.invalid');");
    const result = await explainTestInputFingerprint("test.mjs", {
      cwd: root,
      environment: { SECRET: "sensitive-value" },
    });
    assert.equal(result.fingerprint, null);
    assert.deepEqual(result.missReasons, ["undeclared-global:process", "undeclared-network-fetch"]);
    assert.equal(JSON.stringify(result).includes("sensitive-value"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cache declarations allow only audited builtins and globals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-declared-inputs-"));
  try {
    await writeFile(path.join(root, "fixture.txt"), "one", "utf8");
    await writeFile(path.join(root, "test.mjs"), [
      "import { readFile } from 'node:fs/promises';",
      "export const value = process.platform + await readFile(new URL('./fixture.txt', import.meta.url), 'utf8');",
    ].join("\n"), "utf8");
    const declaration = {
      inputs: ["fixture.txt"],
      builtins: ["fs/promises"],
      globals: ["process"],
    };
    const initial = await testFingerprint("test.mjs", { cwd: root, declaration });
    assert.match(initial, /^[a-f0-9]{64}$/u);
    assert.equal(await testFingerprint("test.mjs", {
      cwd: root,
      declaration: { ...declaration, globals: [] },
    }), null);
    assert.equal(await testFingerprint("test.mjs", {
      cwd: root,
      declaration: { ...declaration, builtins: [] },
    }), null);
    assert.equal(await testFingerprint("test.mjs", {
      cwd: root,
      declaration: { ...declaration, builtins: ["child_process"] },
    }), null);
    await writeFile(path.join(root, "test.mjs"), "import 'node:child_process';", "utf8");
    assert.equal(await testFingerprint("test.mjs", {
      cwd: root,
      declaration: { packages: ["node:child_process"] },
    }), null);
    await writeFile(path.join(root, "test.mjs"), "await fetch('https://example.invalid');", "utf8");
    assert.equal(await testFingerprint("test.mjs", { cwd: root, declaration: {} }), null);
    await writeFile(path.join(root, "test.mjs"), [
      "import { readFile } from 'node:fs/promises';",
      "export const value = process.platform + await readFile(new URL('./fixture.txt', import.meta.url), 'utf8');",
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "unrelated.txt"), "changed", "utf8");
    assert.equal(await testFingerprint("test.mjs", { cwd: root, declaration }), initial);
    await writeFile(path.join(root, "fixture.txt"), "two", "utf8");
    assert.notEqual(await testFingerprint("test.mjs", { cwd: root, declaration }), initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});
