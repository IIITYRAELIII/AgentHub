import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  boundedTestFileConcurrency,
  testFingerprint,
  runWindowsTestFile,
  runTestSuite,
} from "../../test-suite.mjs";
import {
  explainTestInputFingerprint,
  parallelTestExecution,
} from "../../src/infrastructure/persistence/test-input-fingerprint.mjs";
import { withPublicationLock } from "../../src/infrastructure/process/publication-lock.mjs";

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

test("test process concurrency requires both CPU and memory headroom", () => {
  const gib = 1024 ** 3;
  assert.equal(boundedTestFileConcurrency({ availableParallelism: 8, freeMemory: 8 * gib }), 2);
  assert.equal(boundedTestFileConcurrency({ availableParallelism: 3, freeMemory: 8 * gib }), 1);
  assert.equal(boundedTestFileConcurrency({ availableParallelism: 8, freeMemory: 3 * gib }), 1);
});

test("parallel admission requires a complete valid isolation declaration", () => {
  assert.equal(parallelTestExecution({ execution: { parallel: true } }), null);
  assert.equal(parallelTestExecution({
    execution: {
      parallel: true,
      isolation: { filesystem: "shared" },
    },
  }), null);
  assert.deepEqual(parallelTestExecution({
    execution: {
      parallel: true,
      isolation: { filesystem: "per-child-temp", locks: "per-test-temp" },
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
      discover: async () => discovery,
      execute: async (_command, args) => { files.push(...args.filter((argument) => argument.endsWith(".test.mjs"))); },
    });
    return files;
  }
  const unit = await invoked("unit");
  assert.deepEqual(unit, ["tests/domain/example.test.mjs", "tests/public/message-behavior.test.mjs"]);
  assert.deepEqual(await invoked("visual"), visual);
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
