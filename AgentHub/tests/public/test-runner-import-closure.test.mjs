import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runSelectedTests } from "../../test-suite.mjs";
import {
  isRuntimeSourceFile,
  verifyRuntimeImportClosure,
} from "../../src/infrastructure/filesystem/runtime-manifest-verifier.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const runner = path.join(root, "test-suite.mjs");
const cli = args => execute(process.execPath, [runner, ...args], {
  cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, AGENT_HUB_FULL_TEST_CHECKPOINT_ID: "" },
});

test("packaged source imports close over the actual runtime membership including the test runner", async () => {
  const { stdout } = await execute("git", ["ls-files", "-z"], { cwd: root, windowsHide: true });
  const files = stdout.split("\0").filter(file => file && isRuntimeSourceFile(file));
  assert.ok(files.includes("test-suite.mjs"));
  await verifyRuntimeImportClosure(root, files);
});

test("standalone test runner CLI lists and plans the same explicit check selection", async () => {
  const { stdout: listed } = await cli(["--list-tests"]);
  const inventory = JSON.parse(listed);
  const id = "tests/public/test-runner-import-closure.test.mjs";
  assert.ok(inventory.some(entry => entry.id === id));
  const selection = { mode: "include", ids: [id] };
  const { stdout: planned } = await cli([`--plan-tests=${JSON.stringify(selection)}`]);
  const plan = JSON.parse(planned);
  assert.deepEqual(plan.selectedIds, [id]);
  assert.deepEqual(plan.selection, selection);
  assert.equal(plan.inventory.length, inventory.length);
});

test("explicit empty check selection does not prepare dependencies, acquire resources or spawn a check", async () => {
  const forbidden = async () => assert.fail("empty selection must have no execution effects");
  const result = await runSelectedTests({ mode: "none", ids: [] }, {
    inventory: [{ id: "task-check", file: "task-check", suite: "unit" }],
    execute: forbidden, createAdmission: forbidden, prepareDependencies: forbidden,
    report: () => {}, onFile: () => {},
  });
  assert.equal(result.status, "not-selected");
  assert.deepEqual(result.plan.selectedIds, []);
});

test("removed publication payload arguments refuse before ordinary check execution", async () => {
  for (const args of [["unit", "--selection-file=removed.json"], ["selected", `--selection-sha256=${"a".repeat(64)}`]]) {
    await assert.rejects(cli(args), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Publication selection files are no longer supported; use --selection=/u);
      assert.equal(error.stdout, "");
      return true;
    });
  }
});
