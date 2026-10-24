import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { acquireCodexExecutableCustody } from "../../../src/infrastructure/process/codex-executable-custody.mjs";

test("native lifetime custody prevents helper removal after initialize and permits real safe execution", { skip: process.platform !== "win32" }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-bundle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const names = ["codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"];
  const files = [];
  for (const name of names) {
    await copyFile(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(root, name));
    files.push({ name, sha256: createHash("sha256").update(await readFile(path.join(root, name))).digest("hex").toUpperCase() });
  }
  const lease = await acquireCodexExecutableCustody({ root, installRoot: root, files });
  try {
    lease.assertAlive();
    const helper = path.join(root, names[1]);
    await assert.rejects(unlink(helper));
    await assert.rejects(rename(helper, `${helper}.old`));
    await assert.rejects(writeFile(helper, "replacement"));
    const { stdout } = await promisify(execFile)(helper, ["/d", "/c", "echo HUB348_SAFE_TOOL_OK"], { windowsHide: true });
    assert.equal(stdout.trim(), "HUB348_SAFE_TOOL_OK");
    assert.equal(createHash("sha256").update(await readFile(helper)).digest("hex").toUpperCase(), files[1].sha256);
  } finally { await lease.release(); }
  await unlink(path.join(root, names[1]));
});

test("native custody rejects a missing or changed member without retaining partial handles", { skip: process.platform !== "win32" }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-bundle-refusal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "codex.exe");
  await writeFile(target, "original");
  const file = { name: "codex.exe", sha256: createHash("sha256").update("original").digest("hex").toUpperCase() };
  await assert.rejects(acquireCodexExecutableCustody({ root, installRoot: root, files: [file, { ...file, name: "missing.exe" }] }));
  await writeFile(target, "changed");
  await assert.rejects(acquireCodexExecutableCustody({ root, installRoot: root, files: [file] }));
  await unlink(target);
});
