import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { testFingerprint, runWindowsTestFile, runTestSuite } from "../../test-suite.mjs";

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

test("fingerprints cover locks, declared fixtures, environment and toolchain without unrelated contour input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-inputs-"));
  try {
    await mkdir(path.join(root, "fixtures"));
    await writeFile(path.join(root, "test.mjs"), "import { readFile } from 'node:fs/promises';\n");
    await writeFile(path.join(root, "fixtures/value.json"), "1");
    await writeFile(path.join(root, "package-lock.json"), "{}");
    const options = { cwd: root, declaration: { inputs: ["fixtures"] }, environment: { LANG: "C", SECRET: "do-not-persist" }, toolchain: { node: "v24" } };
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
