import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexExecutableUpdateService } from "../../../src/infrastructure/process/codex-executable-update-service.mjs";

function candidate(version, source = "desktop") {
  return {
    path: `C:/official/${source}/${version}/codex.exe`,
    version,
    sha256: version.includes("152") ? "B".repeat(64) : "A".repeat(64),
    publisher: "CN=OpenAI OpCo, LLC",
    source,
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-codex-update-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "codex-executable-state.json");
}

function service(stateFile, {
  candidates,
  runCanary = async () => ({ ok: true, evidence: { scenario: "passed" } }),
  activeRuns = () => [],
  autoUpdateEnabled = true,
  versionPin = "",
} = {}) {
  return new CodexExecutableUpdateService({
    stateFile,
    autoUpdateEnabled,
    versionPin,
    activeRuns,
    platform: "win32",
    discover: async () => ({ candidates, rejected: [] }),
    runCanary,
  });
}

test("newest trusted identity is canaried once and reused idempotently", async (context) => {
  const stateFile = await fixture(context);
  const newest = candidate("0.152.1");
  let canaries = 0;
  const first = service(stateFile, {
    candidates: [newest],
    runCanary: async () => { canaries += 1; return { ok: true, evidence: { allSteps: true } }; },
  });
  assert.equal(await first.selectForStart(), newest.path);
  assert.equal(first.diagnostics().status, "candidate-starting");
  await first.markStartupSuccess();
  const second = service(stateFile, {
    candidates: [newest],
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  assert.equal(await second.selectForStart(), newest.path);
  assert.equal(canaries, 1);
  assert.equal(second.diagnostics().status, "current");
  assert.equal(second.diagnostics().lastKnownGood.version, "0.152.1");
});

test("active Codex run defers adoption and bootstraps the legacy VS Code identity", async (context) => {
  const stateFile = await fixture(context);
  const newest = candidate("0.152.1");
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  let canaries = 0;
  const update = service(stateFile, {
    candidates: [newest, legacy],
    activeRuns: () => [{ provider: "codex", status: "running" }],
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  assert.equal(await update.selectForStart(), legacy.path);
  assert.equal(update.diagnostics().status, "deferred-active-runs");
  assert.equal(update.diagnostics().candidate.version, "0.152.1");
  assert.equal(canaries, 0);
  await update.markStartupSuccess();
  assert.equal(update.diagnostics().lastKnownGood.version, legacy.version);
});

test("disable and exact version pin produce deterministic selection", async (context) => {
  const stateFile = await fixture(context);
  const newest = candidate("0.152.1");
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const baseline = service(stateFile, { candidates: [legacy] });
  assert.equal(await baseline.selectForStart(), legacy.path);
  await baseline.markStartupSuccess();

  const disabled = service(stateFile, { candidates: [newest, legacy], autoUpdateEnabled: false });
  assert.equal(await disabled.selectForStart(), legacy.path);
  assert.equal(disabled.diagnostics().status, "disabled");

  const pinned = service(stateFile, { candidates: [newest, legacy], versionPin: legacy.version });
  assert.equal(await pinned.selectForStart(), legacy.path);
  assert.equal(pinned.diagnostics().policy, "version-pin");

  const missing = service(stateFile, { candidates: [newest, legacy], versionPin: "9.9.9" });
  await assert.rejects(missing.selectForStart(), /matches pin 9\.9\.9/u);
});

test("disabled first-run policy preserves the trusted legacy VS Code path without canary", async (context) => {
  const stateFile = await fixture(context);
  const newest = candidate("0.152.1");
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  let canaries = 0;
  const disabled = service(stateFile, {
    candidates: [newest, legacy],
    autoUpdateEnabled: false,
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  assert.equal(await disabled.selectForStart(), legacy.path);
  assert.equal(disabled.diagnostics().status, "disabled");
  assert.equal(canaries, 0);
});

test("candidate identity is verified again after canary before Hub startup", async (context) => {
  const stateFile = await fixture(context);
  const original = candidate("0.152.1");
  const replaced = { ...original, sha256: "C".repeat(64) };
  let discoveries = 0;
  const update = new CodexExecutableUpdateService({
    stateFile,
    platform: "win32",
    activeRuns: () => [],
    discover: async () => ({ candidates: [discoveries++ === 0 ? original : replaced], rejected: [] }),
    runCanary: async () => ({ ok: true, evidence: { completed: true } }),
  });

  await assert.rejects(update.selectForStart(), /identity changed after compatibility canary/u);
  assert.equal(update.diagnostics().status, "canary-failed");
  assert.equal(update.diagnostics().failedIdentity.sha256, original.sha256);
});

test("manual path and non-Windows PATH compatibility bypass automatic discovery", async (context) => {
  const stateFile = await fixture(context);
  let discoveries = 0;
  const manual = new CodexExecutableUpdateService({
    stateFile,
    requestedExecutable: "D:/operator/codex.exe",
    platform: "win32",
    discover: async () => { discoveries += 1; return { candidates: [], rejected: [] }; },
    runCanary: async () => ({ ok: true }),
  });
  assert.equal(await manual.selectForStart(), "D:/operator/codex.exe");
  assert.equal(manual.diagnostics().policy, "manual-override");
  assert.equal(manual.diagnostics().selected.source, "manual-override");

  const compatible = new CodexExecutableUpdateService({
    stateFile,
    platform: "linux",
    discover: async () => { discoveries += 1; return { candidates: [], rejected: [] }; },
    runCanary: async () => ({ ok: true }),
  });
  assert.equal(await compatible.selectForStart(), "codex");
  assert.equal(compatible.diagnostics().status, "path-fallback");
  assert.equal(discoveries, 0);
});

test("manual path is an explicit recovery boundary when automatic state is corrupt", async (context) => {
  const stateFile = await fixture(context);
  await writeFile(stateFile, "{not-json", "utf8");
  const manual = new CodexExecutableUpdateService({
    stateFile,
    requestedExecutable: "D:/operator/recovery/codex.exe",
    platform: "win32",
    discover: async () => { throw new Error("must not discover"); },
    runCanary: async () => { throw new Error("must not canary"); },
  });
  assert.equal(await manual.selectForStart(), "D:/operator/recovery/codex.exe");
  await manual.markStartupSuccess();
  assert.equal(await manual.markStartupFailure(new Error("ignored manual failure")), false);
  assert.equal(manual.diagnostics().status, "manual-override");

  const automatic = service(stateFile, { candidates: [candidate("0.152.1")] });
  await assert.rejects(automatic.selectForStart(), /Cannot read Codex executable state/u);
});

test("failed canary keeps last-known-good and blocks identical bytes from replay", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  let canaries = 0;
  const failed = service(stateFile, {
    candidates: [newest, legacy],
    runCanary: async () => { canaries += 1; throw new Error("protocol mismatch"); },
  });
  assert.equal(await failed.selectForStart(), legacy.path);
  assert.equal(failed.diagnostics().status, "canary-failed-using-last-known-good");
  const retried = service(stateFile, {
    candidates: [newest, legacy],
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  assert.equal(await retried.selectForStart(), legacy.path);
  assert.equal(retried.diagnostics().status, "candidate-blocked");
  assert.equal(canaries, 1);
});

test("candidate startup failure permits exactly one last-known-good rollback", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();

  const update = service(stateFile, { candidates: [newest, legacy] });
  assert.equal(await update.selectForStart(), newest.path);
  assert.equal(await update.markStartupFailure(new Error("startup protocol failure")), true);
  assert.equal(await update.selectForStart(), legacy.path);
  assert.equal(update.diagnostics().status, "rollback-starting");
  await update.markStartupSuccess();
  assert.equal(update.diagnostics().status, "rolled-back");
  assert.equal(update.diagnostics().lastKnownGood.version, legacy.version);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(JSON.stringify(saved).includes("auth"), false);
});
