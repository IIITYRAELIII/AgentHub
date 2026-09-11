import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexTerminalAudit } from "../../src/providers/codex/codex-terminal-audit.mjs";
import { readCodexRolloutSession, readCodexRolloutTail, scanCodexHistoricalRollout, discoverCodexRollouts, readCodexTurnUsage } from "../../src/providers/codex/codex-turn-usage.mjs";
import { readCodexRolloutActivity } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { scanCodexLiveRolloutInWorker } from "../../src/providers/codex/codex-historical-backfill.mjs";
import { createCodexTerminalAttachmentResolver } from "../../src/providers/codex/codex-terminal-attachments.mjs";
import { recoverCodexRolloutSubagentsOnCurrentThread } from "../../src/providers/codex/codex-rollout-subagent-recovery.mjs";

test("captured pending and historical rollout audit stays evidence without any reader or project fallback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-rollout-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recording = path.join(root, "recording"); await mkdir(recording);
  await writeFile(path.join(recording, "recording-provider.json"), JSON.stringify({
    schemaVersion: 1, kind: "literal-recording-provider", root: recording, externalEffects: "deny",
  }));
  const source = path.join(root, "source-session.jsonl");
  const sentinel = "synthetic source rollout must not be read by audit";
  await writeFile(source, sentinel);
  let reads = 0, persists = 0;
  const poison = async () => { reads++; throw new Error("source access attempted"); };
  const audit = new CodexTerminalAudit({
    recordingRoot: recording, listPage: poison, readThread: poison, resolveProject: poison,
    isTurnActive: poison, onTurnStarted: poison, onTurnActive: poison, reconcile: poison,
    discoverHistoricalThreads: poison, discoverSupplementalThreads: poison,
    scanHistoricalFile: poison, scanHistoricalChunk: poison, statFile: poison, scanFile: poison,
    readCheckpoint: poison, prepareHistoricalBackfill: poison, flushHistoricalProjection: poison,
    persistProgress: async () => { persists++; },
  });
  const thread = { id: "captured-thread", path: source, cwd: path.join(root, "source-project") };
  audit.restore({ version: 18, completedThrough: "2026-01-01T00:00:00.000Z", subagentBackfillPending: true,
    positions: [[thread.id, { path: source, offset: 4, backlog: true }]],
    pendingTurns: [[thread.id, { thread, turns: [{ turnId: "captured-turn", startedAt: "2026-01-01T00:00:00.000Z" }], nextStatusCheckAt: "2026-01-01T00:00:00.000Z" }]],
    historicalSubagentBackfill: { pending: true, initialized: true, prepared: true, totalFiles: 1,
      projectionPending: true, queue: [{ thread, offset: 2, size: 100 }] },
  });
  const before = audit.snapshot();
  await audit.run(); await audit.runHistoricalMaintenance(); await audit.run();
  assert.equal(reads, 0);
  const after = audit.snapshot();
  assert.deepEqual({ ...after, lastRun: before.lastRun }, before);
  assert.equal(after.lastRun.status, "excluded");
  assert.equal(after.lastRun.pendingThreads, 1);
  assert.equal(after.lastRun.pendingTurns, 1);
  assert.equal(after.lastRun.historicalFiles, 1);
  assert.equal(after.lastRun.cycleComplete, false);
  assert.equal(persists, 1);
  assert.equal(await readFile(source, "utf8"), sentinel);
});

test("shared rollout readers and terminal attachment import reject captured paths before I/O", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-rollout-readers-"));
  const recording = path.join(root, "recording"); await mkdir(recording);
  await writeFile(path.join(recording, "recording-provider.json"), JSON.stringify({
    schemaVersion: 1, kind: "literal-recording-provider", root: recording, externalEffects: "deny",
  }));
  const source = path.join(root, "source-session.jsonl");
  await writeFile(source, "owned sentinel, not a recording input");
  const saved = { AGENT_HUB_TEST_CONTOUR: process.env.AGENT_HUB_TEST_CONTOUR,
    AGENT_HUB_RECORDING_PROVIDER_ROOT: process.env.AGENT_HUB_RECORDING_PROVIDER_ROOT };
  process.env.AGENT_HUB_TEST_CONTOUR = "1"; process.env.AGENT_HUB_RECORDING_PROVIDER_ROOT = recording;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  let reads = 0;
  const poison = () => { reads++; throw new Error("sentinel I/O attempted"); };
  for (const operation of [
    () => readCodexRolloutSession(source, { createReadStreamImpl: poison }),
    () => readCodexRolloutTail(source, { openImpl: poison }),
    () => scanCodexHistoricalRollout(source, { createReadStreamImpl: poison }),
    () => discoverCodexRollouts({ codexHome: root, readdirImpl: poison }),
    () => readCodexTurnUsage(source, "turn", { readFileImpl: poison }),
    () => readCodexRolloutActivity(source),
    () => recoverCodexRolloutSubagentsOnCurrentThread(source, []),
  ]) await assert.rejects(operation(), { code: "CONTOUR_ROLLOUT_EXCLUDED" });
  assert.throws(() => scanCodexLiveRolloutInWorker(source, { maxBytes: 1024 }), { code: "CONTOUR_ROLLOUT_EXCLUDED" });
  const resolve = createCodexTerminalAttachmentResolver({ recordingRoot: recording,
    knownRolloutPath: poison, readRolloutActivity: poison, importAttachments: poison });
  const run = { threadId: "thread", rolloutPath: source, generatedImageSources: [{ type: "generated-path", value: source }] };
  assert.deepEqual(await resolve(run, "turn"), []);
  assert.deepEqual(run.generatedImageSources, [{ type: "generated-path", value: source }]);
  assert.equal(reads, 0);
  assert.equal(await readFile(source, "utf8"), "owned sentinel, not a recording input");
});
