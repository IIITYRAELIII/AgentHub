import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { callDesktopControl } from "../../desktop-control.mjs";
import { E2eChildProcessOwner, waitFor } from "../../e2e/telegram-harness.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { installPreparedRuntime, prepareRuntime, verifyInstalledRuntime } from "../../src/runtime/runtime-manager.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const BOT_FILE = path.join(ROOT, "agent-hub-main.mjs");
const FAKE_CODEX_FILE = path.join(ROOT, "e2e", "fake-codex-app-server.mjs");

test("core-only components start without Telegram and keep Web App disabled", { timeout: 30_000 }, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-e2e-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const configPath = path.join(runtimeRoot, "config.json");
  const codexStatePath = path.join(runtimeRoot, "fake-codex-state.json");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  await writeFile(configPath, `${JSON.stringify({
    components: { telegram: false, miniApp: false, androidApp: false },
    provider: "codex",
    projectRoot,
    projects: [{ name: "Journal E2E", path: projectRoot }],
    dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", codexStatePath],
    codexRolloutContext: { enabled: false },
    miniApp: { enabled: true, host: "127.0.0.1", port: 65533 },
  }, null, 2)}\n`, "utf8");

  const botOwner = new E2eChildProcessOwner({ label: "journal Agent Hub" });
  const bot = botOwner.start(() => spawn(process.execPath, [BOT_FILE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_HUB_CONFIG: configPath,
      AGENT_HUB_RUNTIME_ROOT: runtimeRoot,
      AGENT_HUB_LAUNCHER: "",
      AGENT_HUB_DISABLE_SECRET_ACL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));
  let stdout = "";
  let stderr = "";
  bot.stdout.setEncoding("utf8");
  bot.stderr.setEncoding("utf8");
  bot.stdout.on("data", (chunk) => { stdout += chunk; });
  bot.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await botOwner.stop();
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  let snapshot;
  try {
    snapshot = await waitFor(
      () => callDesktopControl("snapshot", {}, { runtimeRoot }).catch(() => null),
      "journal runtime startup",
    );
  } catch (error) {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  }
  assert.equal(snapshot.apiVersion, 3);
  await waitFor(
    () => (/Agent Hub ready; components: core/u.test(stdout) ? true : null),
    "journal runtime ready log",
  );
  assert.match(stdout, /Agent Hub ready; components: core/u);
  assert.doesNotMatch(stdout, /Mini App ready/u);
  assert.doesNotMatch(stderr, /telegramBotToken|Telegram API/u);
});

test("prepared runtime becomes ready beside an external reviewed release awaiting restart", {
  timeout: 120_000,
}, async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-native-startup-e2e-"));
  const dataDir = path.join(runtimeRoot, "data");
  const projectRoot = path.join(runtimeRoot, "project");
  const executionRoot = path.join(dataDir, "release-operation-executions", "external-owner");
  const publicationFile = path.join(executionRoot, "publication-status.json");
  const configPath = path.join(runtimeRoot, "config.json");
  const botOwner = new E2eChildProcessOwner({ label: "prepared native-owner startup" });
  t.after(async () => {
    await botOwner.stop();
    await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectRoot), mkdir(executionRoot, { recursive: true })]);

  // Use the actual packager and locked production dependencies, not a stub
  // server. Only the provider transport is the existing local E2E fake.
  const invalidArchive = path.join(dataDir, "release-repositories", "optional-corrupt-history");
  await mkdir(invalidArchive, { recursive: true });
  await writeFile(path.join(invalidArchive, "checkpoint.json"), "{invalid legacy evidence");
  const prepared = await prepareRuntime({ sourceRoot: ROOT, runtimeRoot, releaseId: "startup-regression" });
  await installPreparedRuntime({ runtimeRoot, releaseId: prepared.releaseId, releaseRoot: prepared.releaseRoot });
  assert.equal(await verifyInstalledRuntime({ runtimeRoot, releaseId: prepared.releaseId, releaseRoot: prepared.releaseRoot }), true);
  await writeFile(configPath, `${JSON.stringify({
    components: { telegram: false, miniApp: false, androidApp: false },
    provider: "codex", projectRoot, projects: [{ name: "Native startup E2E", path: projectRoot }], dataDir,
    codexExecutable: process.execPath,
    codexExecutableArgs: [FAKE_CODEX_FILE, "--state", path.join(runtimeRoot, "fake-codex-state.json")],
    codexRolloutContext: { enabled: false },
  }, null, 2)}\n`, "utf8");

  const store = new ReleaseOperationStore({ dataDir });
  const target = { targetId: "external-publication", kind: "agent-hub-publication", repositoryRoot: projectRoot };
  const operation = store.create({
    requestId: "external-startup-release", workspaceId: "startup-workspace", streamId: "external-stream",
    threadId: "external-thread", runnerVersion: "native-owner",
    authorization: { taskIds: ["selected-task"], approvedTargets: [target], validationMode: "full" },
  }).operation;
  const generation = store.putGeneration({
    operationId: operation.operationId, generation: 1, runnerVersion: "native-owner",
    repositoryBases: [{ repositoryRoot: projectRoot, baseCommit: "a".repeat(40) }],
    selectedResults: [{ taskId: "selected-task", resultCommit: "b".repeat(40), tree: "c".repeat(40), acceptanceRevision: 1 }],
    candidates: [{ repositoryRoot: projectRoot, releaseRoot: prepared.releaseRoot,
      commit: "d".repeat(40), tree: "e".repeat(40), manifestHash: "f".repeat(64) }],
    sourceFingerprint: "startup-source",
  }).generation;
  const receipt = store.beginStep({ operationId: operation.operationId, generation: 1,
    stepId: `publish:${target.targetId}`, input: { candidate: generation.identitySha256 } }).receipt;
  store.finishStep(receipt, { status: "failed", effect: {
    status: "partial", revision: "d".repeat(40), publicationStatus: "awaiting_restart",
  } });
  store.transition(operation.operationId, { state: "publish", currentGeneration: 1, currentStep: "publish" });
  const publication = `${JSON.stringify({ version: 2, status: "awaiting_restart", currentStep: null,
    identity: { runtimeRoot, worktreeRoot: projectRoot, release: { operationId: operation.operationId } },
    progress: { expectedReleaseId: prepared.releaseId, publicationState: { revision: "d".repeat(40) } },
  })}\n`;
  await writeFile(publicationFile, publication, "utf8");

  // The persisted shape matches the production boundary: original source
  // authorization plus reviewed execution recovery and an expired/dead owner.
  // Seed only this disposable database; never bypass the live owner fence.
  const dbFile = path.join(dataDir, "runtime.sqlite");
  const database = new DatabaseSync(dbFile);
  try {
    const recorded = store.get(operation.operationId);
    const originalBinding = { schemaVersion: 1, kind: "native-publication-owner-v1",
      source: { root: projectRoot, commit: "1".repeat(40), tree: "2".repeat(40), branch: "external-task" },
      admissionSha256: "3".repeat(64), intake: { provider: "codex", threadId: "external-thread",
        turnId: "external-turn", serviceTaskId: "external-service-task", taskRevision: 1, repositoryRoot: projectRoot } };
    const executionBinding = { ...originalBinding, source: { ...originalBinding.source, commit: "4".repeat(40) } };
    recorded.authorization.nativeOwnerCutover = originalBinding;
    recorded.nativeOwnerRecovery = { schemaVersion: 1, kind: "reviewed-native-owner-recovery-v1",
      requestId: "external-recovery", originalBinding, binding: executionBinding,
      executionBindingHash: "5".repeat(64), preservedSha256: "6".repeat(64) };
    recorded.owner = { ownerId: "native-source-external", epoch: 2, processId: 999999,
      heartbeatAt: "2026-09-21T00:00:00.000Z", leaseExpiresAt: "2026-09-21T00:00:30.000Z",
      executionBindingHash: recorded.nativeOwnerRecovery.executionBindingHash };
    database.prepare("UPDATE release_operations SET operation_json=? WHERE operation_id=?")
      .run(JSON.stringify(recorded), operation.operationId);
    database.exec(`CREATE TRIGGER fixture_native_execution_fence BEFORE UPDATE ON release_operations
      WHEN json_extract(OLD.operation_json, '$.nativeOwnerRecovery') IS NOT NULL
        AND COALESCE(json_extract(NEW.operation_json, '$.owner.executionBindingHash'), '')
          != json_extract(OLD.operation_json, '$.nativeOwnerRecovery.executionBindingHash')
      BEGIN SELECT RAISE(ABORT, 'release reviewed executable owner is fenced'); END;`);
  } finally { database.close(); }
  const originalRows = () => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return ["release_operations", "release_candidate_generations", "release_step_receipts"].map(table =>
        db.prepare(`SELECT * FROM ${table} WHERE operation_id=?`).all(operation.operationId));
    } finally { db.close(); }
  };
  const before = originalRows();
  let stdout = "";
  let stderr = "";
  const startedAt = performance.now();
  const bot = botOwner.start(() => spawn(process.execPath, [path.join(prepared.releaseRoot, "agent-hub-main.mjs")], {
    cwd: prepared.releaseRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_HUB_CONFIG: configPath, AGENT_HUB_RUNTIME_ROOT: runtimeRoot,
      LOCALAPPDATA: runtimeRoot, XDG_STATE_HOME: runtimeRoot, AGENT_HUB_RELEASE_ID: prepared.releaseId,
      AGENT_HUB_LAUNCHER: "", AGENT_HUB_DISABLE_SECRET_ACL: "1",
      AGENT_HUB_PUBLICATION_SESSION: "", AGENT_HUB_PUBLICATION_STAGE_DELEGATION: "",
      AGENT_HUB_RELEASE_EXECUTION_ROOT: "" },
  }));
  bot.stdout.setEncoding("utf8");
  bot.stderr.setEncoding("utf8");
  bot.stdout.on("data", chunk => { stdout += chunk; });
  bot.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await waitFor(() => {
      if (bot.exitCode !== null) throw new Error(`Artifact exited before ready: ${bot.exitCode}; ${stderr}`);
      return /Agent Hub ready; components: core/u.test(stdout);
    }, "prepared runtime ready", 30_000);
    const lock = JSON.parse(await readFile(path.join(dataDir, "bot.lock"), "utf8"));
    assert.equal(lock.pid, bot.pid);
    assert.equal(lock.ready, true);
    assert.equal(lock.releaseId, prepared.releaseId);
    await callDesktopControl("snapshot", {}, { runtimeRoot });
    await callDesktopControl("snapshot", {}, { runtimeRoot });
    assert.equal(bot.exitCode, null, "ready runtime remains responsive after startup recovery");
    assert.match(`${stdout}\n${stderr}`, /Historical release entry unavailable/u);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /unhandled rejection|Stopping on unhandled|release reviewed executable owner is fenced/u);
    assert.deepEqual(originalRows(), before, "external operation, immutable generation and receipts cannot be acquired or rewritten");
    assert.equal(await readFile(publicationFile, "utf8"), publication);
    assert.equal(await verifyInstalledRuntime({ runtimeRoot, releaseId: prepared.releaseId, releaseRoot: prepared.releaseRoot }), true);
    t.diagnostic(`prepared runtime ready in ${(performance.now() - startedAt).toFixed(3)}ms; original ${operation.operationId}/G1 preserved`);
  } catch (error) {
    throw botOwner.failure(error, { stage: "prepared runtime with native publish/awaiting_restart", stdout, stderr });
  }
});
