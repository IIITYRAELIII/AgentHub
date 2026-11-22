import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { acquireCodexExecutableCustody } from "../../../src/infrastructure/process/codex-executable-custody.mjs";

test("Windows PowerShell holds a bundle with Cyrillic paths and member names", { skip: process.platform !== "win32" }, async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "codex-custody-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const installRoot = path.join(scratch, "Профиль");
  const root = path.join(installRoot, "Набор Codex");
  const name = "Файлы/помощник.dll";
  await mkdir(path.join(root, "Файлы"), { recursive: true });
  const target = path.join(root, name);
  const bytes = "inert fixture";
  await writeFile(target, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const inputs = { root, installRoot, files: [{ name, sha256 }] };

  const lease = await acquireCodexExecutableCustody(inputs);
  try {
    lease.assertAlive();
    await assert.rejects(writeFile(target, "replacement"));
    assert.equal(await readFile(target, "utf8"), bytes);
  } finally { await lease.release(); }

  await writeFile(target, "changed after release");
  await assert.rejects(acquireCodexExecutableCustody(inputs), { code: "CODEX_BUNDLE_UNAVAILABLE" });
  await unlink(target);
});

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
