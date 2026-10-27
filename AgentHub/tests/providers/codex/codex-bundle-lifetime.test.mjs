import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexExecutableUpdateService } from "../../../src/infrastructure/process/codex-executable-update-service.mjs";
import { codexBundleDigest } from "../../../src/infrastructure/process/codex-executable-bundle.mjs";
import { CodexAppServerLifecycle } from "../../../src/providers/codex/codex-app-server-lifecycle.mjs";

test("ordinary initialize then updater cleanup cannot remove the helper or duplicate a safe tool effect", { skip: process.platform !== "win32" }, async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-lifecycle-"));
  const helper = path.join(root, "codex-code-mode-host.exe"), executable = path.join(root, "codex.exe");
  const files = [];
  for (const name of ["codex.exe", "codex-code-mode-host.exe"]) {
    await copyFile(path.join(process.env.SystemRoot, "System32", "cmd.exe"), path.join(root, name));
    files.push({ name, sha256: createHash("sha256").update(await readFile(path.join(root, name))).digest("hex").toUpperCase(), publisher: "CN=OpenAI OpCo, LLC" });
  }
  const bundle = { schemaVersion: 1, installRoot: root, root, files, codeModeHost: true, digest: codexBundleDigest(files, true) };
  const candidate = { path: executable, version: "0.164.0-alpha.11.1", sha256: files[0].sha256,
    publisher: "CN=OpenAI OpCo, LLC", source: "desktop", bundle };
  let child;
  const updates = new CodexExecutableUpdateService({ stateFile: path.join(root, "state.json"), platform: "win32",
    discover: async () => ({ candidates: [candidate], rejected: [] }), verifyRecorded: async identity => identity,
    runCanary: async () => ({ ok: true, evidence: { safeToolCount: 1 } }) });
  const runtime = new CodexAppServerLifecycle({
    resolveExecutable: () => updates.selectForStart(), verifyExecutableForLaunch: selected => updates.verifySelectedForLaunch(selected),
    bindSpawnedProcess: process => updates.bindSpawnedProcess?.(process),
    onStartupSuccess: () => updates.markStartupSuccess(), onStartupFailure: error => updates.markStartupFailure(error),
    executableArgs: [], unavailableMcpOverrides: async () => ({ disabled: [], args: [] }), projectRoot: () => root,
    spawnProcess: () => {
      child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../fixtures/codex-bundle-app-server.mjs")], {
        env: { ...process.env, HUB348_FIXTURE_HELPER: helper }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      }); return child;
    }, stopProcessTree: async () => { child.kill(); }, onMessage() {}, rpcTimeoutMs: 3000,
    isStopping: () => true, providerSelected: () => true, activeRuns: () => [], attachSelectedThread: async () => {},
    logger: { log() {}, error() {} },
  });
  context.after(async () => {
    await runtime.stop(); await updates.releaseUnboundSelection?.(); await updates.waitForCustodyRelease?.();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.start(); await runtime.initialize();
  await assert.rejects(unlink(helper));
  const result = await runtime.request("tool/read");
  assert.deepEqual(result, { output: "HUB348_TOOL_AFTER_INITIALIZE", calls: 1 });
  assert.equal(updates.diagnostics().active.sha256, candidate.sha256);
});
