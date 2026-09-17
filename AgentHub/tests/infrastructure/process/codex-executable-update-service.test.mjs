import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  discover = async () => ({ candidates, rejected: [] }),
  verifyRecorded = async (recorded) => ({ ...recorded }),
  runCanary = async () => ({ ok: true, evidence: { scenario: "passed" } }),
  activeRuns = () => [],
  autoUpdateEnabled = true,
  versionPin = "",
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl,
} = {}) {
  return new CodexExecutableUpdateService({
    stateFile,
    autoUpdateEnabled,
    versionPin,
    activeRuns,
    platform: "win32",
    discover,
    verifyRecorded,
    runCanary,
    readFileImpl,
    writeFileImpl,
    mkdirImpl,
  });
}

test("state flush failure preserves the last durable identity and prevents selection", async (context) => {
  const stateFile = await fixture(context);
  const known = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [known] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  const before = await readFile(stateFile, "utf8");
  let flushAttempts = 0;
  const update = service(stateFile, {
    candidates: [known],
    writeFileImpl: async (file, content, options) => {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      // Model storage accepting buffered bytes but refusing their durable flush.
      if (options?.flush) {
        flushAttempts += 1;
        throw Object.assign(new Error("state flush failed"), { code: "EIO" });
      }
    },
  });
  await assert.rejects(update.selectForStart(), /state flush failed/u);
  assert.equal(flushAttempts, 1);
  assert.equal(await readFile(stateFile, "utf8"), before);
  assert.deepEqual(await readdir(path.dirname(stateFile)), [path.basename(stateFile)]);
  const restarted = service(stateFile, { candidates: [known] });
  assert.equal(await restarted.selectForStart(), known.path);
  assert.equal(await restarted.verifySelectedForLaunch(known.path), known.path);
});

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
    discover: async () => { assert.fail("persisted startup must not discover"); },
    runCanary: async () => { assert.fail("persisted startup must not canary"); },
  });
  assert.equal(await second.selectForStart(), newest.path);
  assert.equal(await second.verifySelectedForLaunch(newest.path), newest.path);
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

test("failed background canary keeps last-known-good and blocks identical bytes across reload", async (context) => {
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
  await failed.markStartupSuccess();
  await failed.refreshInBackground();
  assert.equal(failed.diagnostics().status, "ready");
  assert.equal(failed.diagnostics().background.status, "failed");
  assert.deepEqual(failed.diagnostics().failedIdentity, newest);
  assert.deepEqual(failed.diagnostics().active, legacy);
  const retried = service(stateFile, {
    candidates: [newest, legacy],
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  assert.equal(await retried.selectForStart(), legacy.path);
  await retried.refreshInBackground();
  await retried.refreshInBackground();
  assert.equal(retried.diagnostics().status, "current");
  assert.equal(retried.diagnostics().background.status, "candidate-blocked");
  assert.equal(retried.diagnostics().prepared, null);
  assert.equal(canaries, 1);
  const changed = { ...newest, sha256: "D".repeat(64) };
  const replacement = service(stateFile, {
    candidates: [changed, legacy],
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  await replacement.refreshInBackground();
  assert.equal(canaries, 2);
  assert.deepEqual(replacement.diagnostics().prepared, changed);
  assert.deepEqual(replacement.diagnostics().active, legacy);
});

test("candidate startup failure permits exactly one last-known-good rollback", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();

  const update = service(stateFile, { candidates: [newest, legacy] });
  await update.refreshInBackground();
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

test("launch verification rejects post-canary replacement and permits only verified last-known-good", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const replaced = { ...newest, sha256: "C".repeat(64) };
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();

  let installed = newest;
  const update = service(stateFile, {
    candidates: [newest, legacy],
    verifyRecorded: async (recorded) => recorded.path === newest.path ? installed : legacy,
  });
  await update.refreshInBackground();
  assert.equal(await update.selectForStart(), newest.path);
  installed = replaced;
  await assert.rejects(
    update.verifySelectedForLaunch(newest.path),
    /identity changed before process spawn/u,
  );
  assert.equal(await update.markStartupFailure(new Error("launch identity mismatch")), true);
  assert.equal(await update.selectForStart(), legacy.path);
  assert.equal(await update.verifySelectedForLaunch(legacy.path), legacy.path);
  assert.equal(update.diagnostics().status, "rollback-starting");
});

test("changed last-known-good identity fails closed at launch without another rollback", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const replaced = { ...legacy, publisher: "CN=Different Publisher" };
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();

  const update = service(stateFile, {
    discover: async () => { assert.fail("persisted startup must not discover"); },
    verifyRecorded: async () => replaced,
  });
  assert.equal(await update.selectForStart(), legacy.path);
  await assert.rejects(
    update.verifySelectedForLaunch(legacy.path),
    /identity changed before process spawn/u,
  );
  assert.equal(await update.markStartupFailure(new Error("last-known-good identity mismatch")), false);
  assert.equal(update.diagnostics().status, "startup-failed");
  assert.equal(update.diagnostics().reason, "rollback-unavailable");
});

test("launch verification fails closed when durable selected identity is altered", async (context) => {
  const stateFile = await fixture(context);
  const selected = candidate("0.152.1");
  const update = service(stateFile, { candidates: [selected] });
  assert.equal(await update.selectForStart(), selected.path);

  const durable = JSON.parse(await readFile(stateFile, "utf8"));
  durable.selected.publisher = "CN=Different Publisher";
  await writeFile(stateFile, `${JSON.stringify(durable, null, 2)}\n`, "utf8");

  await assert.rejects(
    update.verifySelectedForLaunch(selected.path),
    /Durable selected Codex executable identity changed before process spawn/u,
  );
});

test("launch verifies only the recorded identity and preserves bounded rollback eligibility", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  const discoveries = [];
  const verifications = [];
  const update = service(stateFile, {
    discover: async (options) => {
      discoveries.push(options);
      return {
        candidates: [newest, legacy],
        rejected: [],
      };
    },
    verifyRecorded: async (recorded) => {
      verifications.push({ ...recorded });
      return { ...recorded };
    },
  });
  await update.refreshInBackground();
  assert.equal(await update.selectForStart(), newest.path);
  assert.equal(await update.verifySelectedForLaunch(newest.path), newest.path);
  assert.deepEqual(discoveries, [{ trustedCandidates: [legacy] }]);
  assert.deepEqual(verifications, [newest, newest]);
  assert.equal(await update.markStartupFailure(new Error("startup failed")), true);
  assert.equal(await update.selectForStart(), legacy.path);
  assert.equal(await update.verifySelectedForLaunch(legacy.path), legacy.path);
  assert.equal(discoveries.length, 1);
  assert.deepEqual(verifications, [newest, newest, legacy]);
  assert.equal(await update.markStartupFailure(new Error("rollback failed")), false);
});

test("no-candidate failure persists bounded exact rejection diagnostics without arbitrary content", async (context) => {
  const stateFile = await fixture(context);
  const rejected = [
    { source: "desktop", error: "Process timed out after 5000 ms" },
    { source: "vscode", error: "Codex executable signature is not trusted (NotSigned)" },
    { source: "vscode-insiders", error: "Authenticode inspection returned invalid JSON" },
    { source: "synthetic-secret", error: "synthetic-secret".repeat(1000) },
    { source: "desktop", error: "Process timed out after 5000 ms" },
  ];
  const update = service(stateFile, { discover: async () => ({ candidates: [], rejected }) });
  const expected = "No trusted installed official Codex executable was found; rejected: "
    + "desktop: Process timed out after 5000 ms; vscode: Codex executable signature is not trusted (NotSigned); "
    + "vscode-insiders: Authenticode inspection returned invalid JSON; candidate: Codex executable inspection failed; 1 more rejected";
  await assert.rejects(update.selectForStart(), { message: expected });
  assert.equal(update.diagnostics().lastError, expected);
  const durable = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(durable.lastError, expected);
  assert.equal(durable.rejected[3].error, "Codex executable inspection failed");
});

test("selected launch rejection includes its timeout and still fails closed", async (context) => {
  const stateFile = await fixture(context);
  const selected = candidate("0.152.1");
  const update = service(stateFile, {
    candidates: [selected],
    verifyRecorded: async () => { throw new Error("Process timed out after 5000 ms"); },
  });
  await update.selectForStart();
  await assert.rejects(update.verifySelectedForLaunch(selected.path), {
    message: "Process timed out after 5000 ms",
  });
});

test("background preparation survives a fresh service and activates only at the next safe start", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  let canaries = 0;
  const update = service(stateFile, {
    candidates: [newest, legacy],
    runCanary: async (selected) => {
      assert.deepEqual(selected, newest);
      canaries += 1;
      return { ok: true };
    },
  });
  await update.selectForStart();
  await update.markStartupSuccess();
  await update.refreshInBackground();
  await update.refreshInBackground();
  const prepared = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(prepared.prepared, newest);
  assert.deepEqual(prepared.active, legacy);
  assert.deepEqual(prepared.selected, legacy);
  assert.deepEqual(prepared.lastKnownGood, legacy);
  assert.equal(prepared.status, "ready");
  assert.equal(canaries, 1);

  const next = service(stateFile, {
    discover: async () => { assert.fail("prepared startup must not discover"); },
    runCanary: async () => { assert.fail("prepared startup must not repeat canary"); },
  });
  assert.equal(await next.selectForStart(), newest.path);
  assert.equal(await next.verifySelectedForLaunch(newest.path), newest.path);
  assert.deepEqual(next.diagnostics().active, legacy);
  assert.deepEqual(next.diagnostics().lastKnownGood, legacy);
  await next.markStartupSuccess();
  const activated = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(activated.active, newest);
  assert.deepEqual(activated.lastKnownGood, newest);
  assert.equal(activated.prepared, null);
});

test("active run recovery defers background canary and activation of an already prepared candidate", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  let runs = [{ provider: "codex", status: "recovering" }];
  let canaries = 0;
  const update = service(stateFile, {
    candidates: [newest, legacy],
    activeRuns: () => runs,
    runCanary: async () => { canaries += 1; return { ok: true }; },
  });
  await update.selectForStart();
  await update.refreshInBackground();
  assert.equal(update.diagnostics().background.status, "deferred-active-runs");
  assert.equal(update.diagnostics().prepared, null);
  assert.equal(canaries, 0);
  runs = [{ provider: "codex", status: "completed" }, { provider: "claude", status: "running" }];
  await update.refreshInBackground();
  assert.deepEqual(update.diagnostics().prepared, newest);
  assert.equal(canaries, 1);
  runs = [{ provider: "codex", status: "running" }];
  assert.equal(await update.selectForStart(), legacy.path);
  assert.equal(update.diagnostics().status, "deferred-active-runs");
  assert.deepEqual(update.diagnostics().prepared, newest);
  runs = [];
  assert.equal(await update.selectForStart(), newest.path);
  assert.equal(canaries, 1);
});

test("disabled and pinned policy cannot activate a prepared candidate from a previous policy", async (context) => {
  for (const policy of [{ autoUpdateEnabled: false }, { versionPin: "0.151.0-alpha.7.2" }]) {
    const stateFile = await fixture(context);
    const legacy = candidate("0.151.0-alpha.7.2", "vscode");
    const newest = candidate("0.152.1");
    const baseline = service(stateFile, { candidates: [legacy] });
    await baseline.selectForStart();
    await baseline.markStartupSuccess();
    const prepare = service(stateFile, { candidates: [newest, legacy] });
    await prepare.refreshInBackground();
    const restricted = service(stateFile, {
      ...policy,
      candidates: [newest, legacy],
      runCanary: async () => { assert.fail("restricted policy must not canary the newer version"); },
    });
    assert.equal(await restricted.selectForStart(), legacy.path);
    await restricted.refreshInBackground();
    assert.equal(await restricted.selectForStart(), legacy.path);
    assert.deepEqual(restricted.diagnostics().active, legacy);
    assert.deepEqual(restricted.diagnostics().lastKnownGood, legacy);
  }
});

test("background discovery and verification failures preserve active startup state and bound diagnostics", async (context) => {
  for (const failure of ["discovery", "canary", "verification"]) {
    const stateFile = await fixture(context);
    const legacy = candidate("0.151.0-alpha.7.2", "vscode");
    const newest = candidate("0.152.1");
    const baseline = service(stateFile, { candidates: [legacy] });
    await baseline.selectForStart();
    await baseline.markStartupSuccess();
    const fail = async () => { throw new Error("synthetic-private-content".repeat(1000)); };
    const update = service(stateFile, {
      candidates: [newest, legacy],
      ...(failure === "discovery" ? { discover: fail } : {}),
      ...(failure === "canary" ? { runCanary: fail } : {}),
      ...(failure === "verification" ? { verifyRecorded: fail } : {}),
    });
    await update.selectForStart();
    await update.markStartupSuccess();
    await update.refreshInBackground();
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(saved.active, legacy, failure);
    assert.deepEqual(saved.selected, legacy, failure);
    assert.deepEqual(saved.lastKnownGood, legacy, failure);
    assert.equal(saved.prepared, null, failure);
    assert.equal(saved.status, "ready", failure);
    assert.equal(saved.lastError, null, failure);
    assert.equal(saved.background.status, "failed", failure);
    assert.equal(JSON.stringify(saved).includes("synthetic-private-content"), false, failure);
  }
});

test("concurrent background refresh shares discovery and canary without clobbering a concurrent startup", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  context.after(() => release.resolve());
  let discoveries = 0;
  let canaries = 0;
  const update = service(stateFile, {
    discover: async ({ trustedCandidates }) => {
      discoveries += 1;
      assert.deepEqual(trustedCandidates, [legacy]);
      return { candidates: [newest, legacy], rejected: [] };
    },
    runCanary: async () => {
      canaries += 1;
      entered.resolve();
      await release.promise;
      return { ok: true };
    },
  });
  await update.selectForStart();
  const first = update.refreshInBackground();
  await entered.promise;
  const concurrent = update.refreshInBackground();
  assert.equal(first, concurrent);
  assert.equal(await update.selectForStart(), legacy.path);
  await update.markStartupSuccess();
  release.resolve();
  await Promise.all([first, concurrent]);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(discoveries, 1);
  assert.equal(canaries, 1);
  assert.deepEqual(saved.selected, legacy);
  assert.deepEqual(saved.active, legacy);
  assert.deepEqual(saved.prepared, newest);
  assert.equal(saved.status, "ready");
});

test("stopping background checks fences a late canary result without changing selected identity", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  context.after(() => release.resolve());
  const update = service(stateFile, {
    candidates: [newest, legacy],
    runCanary: async () => { entered.resolve(); await release.promise; return { ok: true }; },
  });
  await update.selectForStart();
  const refresh = update.refreshInBackground();
  await entered.promise;
  update.stopBackgroundChecks();
  await update.markStartupSuccess();
  release.resolve();
  await refresh;
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.prepared, null);
  assert.deepEqual(saved.active, legacy);
  assert.deepEqual(saved.selected, legacy);
  assert.equal(saved.status, "ready");
});

test("background preparation rejects a same-path identity replacement returned by verification", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  const update = service(stateFile, {
    candidates: [newest, legacy],
    verifyRecorded: async (recorded) => ({ ...recorded, sha256: "C".repeat(64) }),
  });
  await update.selectForStart();
  await update.refreshInBackground();
  assert.equal(update.diagnostics().prepared, null);
  assert.equal(update.diagnostics().background.status, "failed");
  assert.deepEqual(update.diagnostics().failedIdentity, newest);
  assert.deepEqual(update.diagnostics().selected, legacy);
  assert.deepEqual(update.diagnostics().active, legacy);
});

test("stop during pending discovery prevents preparation and every late state write", async (context) => {
  for (const rejectDiscovery of [false, true]) {
    const stateFile = await fixture(context);
    const legacy = candidate("0.151.0-alpha.7.2", "vscode");
    const newest = candidate("0.152.1");
    const baseline = service(stateFile, { candidates: [legacy] });
    await baseline.selectForStart();
    await baseline.markStartupSuccess();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    context.after(() => release.resolve());
    let writes = 0;
    const update = service(stateFile, {
      discover: async () => {
        entered.resolve();
        await release.promise;
        if (rejectDiscovery) throw new Error("late discovery failure");
        return { candidates: [newest, legacy], rejected: [] };
      },
      runCanary: async () => { assert.fail("stopped refresh must not start a canary"); },
      verifyRecorded: async () => { assert.fail("stopped refresh must not verify candidates"); },
      writeFileImpl: async (...args) => { writes += 1; return writeFile(...args); },
    });
    await update.selectForStart();
    const before = await readFile(stateFile, "utf8");
    const writesBefore = writes;
    const refresh = update.refreshInBackground();
    await entered.promise;
    update.stopBackgroundChecks();
    release.resolve();
    await refresh;
    assert.equal(writes, writesBefore);
    assert.equal(await readFile(stateFile, "utf8"), before);
    assert.equal(update.diagnostics().prepared, null);
    assert.deepEqual(update.diagnostics().selected, legacy);
    assert.deepEqual(update.diagnostics().active, legacy);
  }
});

test("schema-1 identities seed the trusted cache without discovery or canary on cold startup", async (context) => {
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  for (const prepared of [null, newest]) {
    const stateFile = await fixture(context);
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      active: legacy,
      selected: legacy,
      lastKnownGood: legacy,
      ...(prepared ? { prepared } : {}),
    }), "utf8");
    const verifications = [];
    const update = service(stateFile, {
      discover: async () => { assert.fail("schema migration must not discover"); },
      runCanary: async () => { assert.fail("schema migration must not canary"); },
      verifyRecorded: async (recorded) => { verifications.push(recorded); return { ...recorded }; },
    });
    const expected = prepared ?? legacy;
    assert.equal(await update.selectForStart(), expected.path);
    assert.equal(await update.verifySelectedForLaunch(expected.path), expected.path);
    assert.deepEqual(verifications, [expected]);
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(saved.trustedCandidates, prepared ? [legacy, newest] : [legacy]);
    assert.deepEqual(saved.active, legacy);
    assert.deepEqual(saved.lastKnownGood, legacy);
    const restarted = service(stateFile, {
      discover: async () => { assert.fail("migrated restart must not discover"); },
      runCanary: async () => { assert.fail("migrated restart must not canary"); },
    });
    assert.equal(await restarted.selectForStart(), expected.path);
    assert.equal(await restarted.verifySelectedForLaunch(expected.path), expected.path);
  }
});

test("cold startup and background refresh share one pending persisted-state load", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  await writeFile(stateFile, JSON.stringify({
    schemaVersion: 1, active: legacy, selected: legacy, lastKnownGood: legacy,
  }), "utf8");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  context.after(() => release.resolve());
  let reads = 0;
  const discoveries = [];
  const update = service(stateFile, {
    readFileImpl: async (...args) => {
      reads += 1;
      entered.resolve();
      await release.promise;
      return readFile(...args);
    },
    discover: async (options) => {
      discoveries.push(options);
      return { candidates: [legacy], rejected: [] };
    },
    runCanary: async () => { assert.fail("cold concurrent load must not lose persisted LKG"); },
  });
  const selection = update.selectForStart();
  await entered.promise;
  const refresh = update.refreshInBackground();
  release.resolve();
  const [selected] = await Promise.all([selection, refresh]);
  assert.equal(selected, legacy.path);
  assert.equal(reads, 1);
  assert.deepEqual(discoveries, [{ trustedCandidates: [legacy] }]);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(saved.selected, legacy);
  assert.deepEqual(saved.active, legacy);
  assert.deepEqual(saved.trustedCandidates, [legacy]);
});

test("ordered state writes keep a concurrent successful startup newer than background preparation", async (context) => {
  const stateFile = await fixture(context);
  const legacy = candidate("0.151.0-alpha.7.2", "vscode");
  const newest = candidate("0.152.1");
  const baseline = service(stateFile, { candidates: [legacy] });
  await baseline.selectForStart();
  await baseline.markStartupSuccess();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  context.after(() => release.resolve());
  let blockNextWrite = false;
  let writesInFlight = 0;
  let maximumWrites = 0;
  const update = service(stateFile, {
    candidates: [newest, legacy],
    mkdirImpl: async () => {},
    writeFileImpl: async (...args) => {
      writesInFlight += 1;
      maximumWrites = Math.max(maximumWrites, writesInFlight);
      try {
        if (blockNextWrite) {
          blockNextWrite = false;
          entered.resolve();
          await release.promise;
        }
        return await writeFile(...args);
      } finally {
        writesInFlight -= 1;
      }
    },
  });
  await update.selectForStart();
  blockNextWrite = true;
  const refresh = update.refreshInBackground();
  await entered.promise;
  const selection = update.selectForStart();
  await new Promise(setImmediate);
  release.resolve();
  await Promise.all([refresh, selection]);
  await update.markStartupSuccess();
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(maximumWrites, 1);
  assert.deepEqual(saved.selected, newest);
  assert.deepEqual(saved.active, newest);
  assert.deepEqual(saved.lastKnownGood, newest);
  assert.equal(saved.prepared, null);
  assert.equal(saved.status, "ready");
});
