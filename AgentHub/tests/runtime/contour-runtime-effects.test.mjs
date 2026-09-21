import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContourClaudeAuthority, createContourAwareDiffCapture, createRuntimeFileRemoval } from "../../src/runtime/test-contour-runtime-effects.mjs";
import { createContourOperationalPaths } from "../../src/domain/test-contour-operational-paths.mjs";
import { createRunAdmissionComposition } from "../../src/composition/run-admission-composition.mjs";
import { ClaudeRunController } from "../../src/providers/claude/claude-run-controller.mjs";
import { serializableTaskRun } from "../../src/domain/task-runs.mjs";
import { createRuntimeStateRestorationComposition } from "../../src/composition/runtime-state-restoration-composition.mjs";
import { TaskSelectionStore } from "../../src/application/task-selection-store.mjs";
import { ClaudeCompletionService } from "../../src/providers/provider-completion-services.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "hub-runtime-effects-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "isolated", "recording");
  const dataDir = path.join(base, "isolated", "data");
  const original = path.join(base, "production", "attachment.txt");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(path.dirname(original), { recursive: true })]);
  const sources = [{ source: path.dirname(original), kind: "attachment" }, { source: path.join(base, "repo"), kind: "project" }];
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({ schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny", sources, threads: [] }));
  const mapped = createContourOperationalPaths({ root, sources }).map(original, "attachment");
  await mkdir(path.dirname(mapped), { recursive: true });
  await Promise.all([writeFile(original, "production"), writeFile(mapped, "copy")]);
  return { base, root, dataDir, original, mapped, config: { dataDir, deferredInputTtlHours: 24, testContourRecording: { root } } };
}

test("deferred cleanup maps canonical files without mutating message identity or original bytes", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const composition = createRunAdmissionComposition({ config: f.config, pendingInputs: new Map(), queuedInputs: new Map(), stageLaunchAdmission() {}, abortLaunchAdmission() {} });
  const item = { id: "queued-1", clientUserMessageId: "original-message", temporaryFiles: [f.original], input: [{ type: "localFile", path: f.original }], messageFingerprint: "immutable" };
  const before = structuredClone(item);
  await composition.cleanupDeferredFiles(item);
  assert.deepEqual(item, before);
  assert.equal(await readFile(f.original, "utf8"), "production");
  await assert.rejects(readFile(f.mapped), { code: "ENOENT" });
  await composition.cleanupDeferredFiles(item); // Idempotent cleanup.
});

test("unknown cleanup paths and junctions never fall back to the production target", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const remove = createRuntimeFileRemoval(f.config);
  const unknown = path.join(f.base, "unknown.txt");
  await writeFile(unknown, "unknown");
  await assert.rejects(remove(unknown), /Unmapped/);
  const link = path.join(f.dataDir, "redirect");
  await symlink(path.dirname(f.original), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(remove(path.join(link, path.basename(f.original))), /link/);
  assert.equal(await readFile(unknown, "utf8"), "unknown");
  assert.equal(await readFile(f.original, "utf8"), "production");
});

test("captured Claude PID and exact fingerprint cannot authorize read, completion or stop", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  let interrupted = 0;
  const forbidden = () => { throw new Error("production process effect"); };
  const run = { id: "original-run", provider: "claude", threadId: "original-thread", turnId: "original-turn", clientUserMessageId: "original-command", pid: process.pid,
    claudeProcessFingerprint: { pid: process.pid, creationTime: "exact-production-fingerprint" }, claudeOutputPath: f.original, claudeErrorPath: f.original, responseText: "retained evidence" };
  const before = structuredClone(run);
  const controller = new ClaudeRunController({ dataDir: f.dataDir, processAuthority: createContourClaudeAuthority(f), processAlive: forbidden, processFingerprintLookup: forbidden, stopProcess: forbidden,
    onComplete: forbidden, onRecoveryUnavailable: async (value) => { assert.equal(value, run); interrupted += 1; } });
  assert.equal(await controller.stop(run), false);
  await controller.drain(run);
  await controller.complete(run);
  assert.equal(await controller.attachAfterRestart(run), false);
  assert.equal(interrupted, 1);
  const { contourRecoveryExclusion, ...preserved } = run;
  assert.equal(contourRecoveryExclusion, "captured-process-and-output-not-owned");
  assert.deepEqual(preserved, before);
  assert.equal(await readFile(f.original, "utf8"), "production");
});

test("recording Claude provenance survives serialization and allows exact owned reattachment", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const authority = createContourClaudeAuthority(f);
  const run = { id: "run", turnId: "turn", threadId: "thread" };
  authority.started(run);
  Object.assign(run, { pid: 12345, claudeProcessFingerprint: { pid: 12345, creationTime: "owned" } });
  const directory = path.join(f.dataDir, "claude-runs");
  await mkdir(directory);
  run.claudeOutputPath = path.join(directory, "turn.jsonl");
  run.claudeErrorPath = path.join(directory, "turn.err.log");
  await writeFile(run.claudeOutputPath, "");
  await writeFile(run.claudeErrorPath, "");
  const restored = JSON.parse(JSON.stringify(serializableTaskRun(run)));
  const stopped = [];
  const controller = new ClaudeRunController({ dataDir: f.dataDir, processAuthority: createContourClaudeAuthority(f), processAlive: () => true,
    processFingerprintLookup: async () => restored.claudeProcessFingerprint, stopProcess: async (pid) => { stopped.push(pid); return true; }, pollIntervalMs: 60_000 });
  t.after(() => controller.pause(restored));
  assert.equal(await controller.attachAfterRestart(restored), true);
  assert.equal(await controller.stop(restored), true);
  assert.deepEqual(stopped, [12345]);
});

test("even marked Claude runs reject foreign output and turn path traversal", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const authority = createContourClaudeAuthority(f);
  assert.throws(() => authority.started({ turnId: "../escape" }), /identity/);
  assert.throws(() => authority.started({ turnId: "turn", pid: process.pid }), /Captured PID/);
  assert.throws(() => authority.owns({ turnId: "turn", contourProcessRoot: f.root, claudeOutputPath: f.original }), /does not belong/);
});

test("runtime restoration expires only owned copies while retaining live queue and captured run evidence", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const queues = new Map();
  const runs = [];
  const restore = { restore() {} };
  const context = {
    selectionStore: new TaskSelectionStore({ activeProvider: "claude", activeProjectRoot: f.base }),
    taskMetadata: restore, preferences: restore, runJournal: { restoreLastMessages() {} },
    contextCompactions: restore, codexUsageTracker: restore, codexTerminalAudit: restore,
    turnEndNotifications: { restore: () => ({}) }, desktopMessageReceipts: restore,
    pendingInputs: new Map(), queuedInputs: queues, forwardBundles: new Map(),
    taskRuns: { add: (run) => runs.push(run) }, updateDeferredDesktopReceipt() {},
  };
  const common = { provider: "claude", streamId: "stream", threadId: "thread", projectRoot: f.base, input: "literal", conflictKind: "message-intake" };
  const live = { ...common, id: "live", clientUserMessageId: "original-live", createdAt: new Date().toISOString(), temporaryFiles: [] };
  const expired = { ...common, id: "expired", createdAt: "2000-01-01T00:00:00Z", temporaryFiles: [f.original] };
  const active = { ...common, id: "original-run", turnId: "original-turn", status: "running", pid: process.pid, claudeOutputPath: f.original };
  const snapshot = { queuedInputs: [expired, live], activeRuns: [active] };
  const original = structuredClone(snapshot);
  const result = await createRuntimeStateRestorationComposition({ config: f.config, projects: [], maximumDeferredInputs: 10,
    runtimeStateStore: { load: async () => ({ value: snapshot }) }, canonicalizeProjectRoots: (value) => value,
    restoreContext: context, snapshotContext: {} });
  assert.equal(result.stateLoadFailed, false);
  assert.deepEqual([...queues.values()], [live]);
  assert.equal(runs[0].pid, active.pid);
  assert.equal(runs[0].claudeOutputPath, active.claudeOutputPath);
  assert.equal(runs[0].turnId, active.turnId);
  assert.deepEqual(snapshot, original);
  assert.equal(await readFile(f.original, "utf8"), "production");
  await assert.rejects(readFile(f.mapped), { code: "ENOENT" });
});

test("recording diff excludes Git execution and preserves historical diff semantics", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const capture = createContourAwareDiffCapture(f.config, () => { throw new Error("Git executed"); });
  assert.equal(await capture({ repoRoot: path.join(f.base, "repo"), tree: "historic-tree" }), null);
  const effects = (await readFile(path.join(f.root, "external-effects.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(effects.at(-1).kind, "task-git-diff");
  assert.equal(effects.at(-1).status, "excluded");
  const realCapture = () => "ordinary diff";
  assert.equal(createContourAwareDiffCapture({}, realCapture), realCapture);
});

test("owned real child records provenance and completes through the guarded output reader", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const run = { id: "owned-run", turnId: "owned-turn", threadId: "owned-thread" };
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const controller = new ClaudeRunController({ dataDir: f.dataDir, processAuthority: createContourClaudeAuthority(f), pollIntervalMs: 5,
    processFingerprintLookup: async (pid) => ({ pid, creationTime: "test-owned-child" }),
    onComplete: (_run, value) => complete(value) });
  t.after(async () => { controller.pause(run); if (run.process?.exitCode == null && run.process) await controller.stop(run); });
  const payload = JSON.stringify({ type: "result", result: "owned result", session_id: run.threadId });
  await controller.start(run, { command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(payload + "\n")})`], cwd: f.dataDir, env: { SystemRoot: process.env.SystemRoot } });
  assert.equal((await completed).result.result, "owned result");
  assert.equal(run.contourProcessRoot, f.root);
  assert.equal(run.claudeSettled, true);
  assert.equal(await readFile(f.original, "utf8"), "production");
});

test("Claude completion cleans canonical restored temporary files through the bound adapter", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const noop = async () => {};
  const run = { id: "run", turnId: "turn", threadId: "thread", claudeTemporaryFiles: [f.original] };
  const statuses = [];
  const completion = new ClaudeCompletionService({ runForTask: () => run, isSelectedRun: () => false, reindexRun() {}, setSelectedThread() {}, saveState: noop,
    finishProgress: noop, persistHistory: async (_run, options) => statuses.push(options.status), projectWorkLog: noop, finalizeDelivery: noop,
    temporaryFiles: new Map(), removeFile: createRuntimeFileRemoval(f.config) });
  await completion.completeManaged(run, { result: { result: "explicit recorded terminal" } });
  assert.deepEqual(statuses, ["completed"]);
  assert.equal(await readFile(f.original, "utf8"), "production");
  await assert.rejects(readFile(f.mapped), { code: "ENOENT" });
});
