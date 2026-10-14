// Synthetic-only owning benchmark. Never point this at a retained/live database.
// node tests/perf/repeated-journal-projection.bench.mjs [local-count] [fact-count]
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { JournalDatabase } from '../../src/infrastructure/persistence/journal-database.mjs';
import { WorkLogUsageSyncWorkerStore } from '../../src/runtime/work-log-usage-sync-worker-client.mjs';

const localCount = Math.min(20_000, Math.max(1, Number(process.argv[2]) || 2_000));
const factCount = Math.min(50_000, Math.max(1, Number(process.argv[3]) || 6_000));
const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || os.tmpdir(), 'journal-repeated-bench-'));
const databaseFile = path.join(root, 'journal.sqlite');
const journal = new JournalDatabase(databaseFile);
const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: 'bench-local' });
const operationId = process.env.AGENT_HUB_BENCH_OPERATION_ID || randomUUID();
const now = Date.parse('2026-10-07T12:00:00Z');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const delay = monitorEventLoopDelay({ resolution: 10 });
const observations = [];
let callbackCount = 0;
let callbackWorkMs = 0;
const workspaceResolver = reference => {
  const start = performance.now();
  callbackCount++;
  const value = { workspaceId: 'bench-workspace', workspaceName: 'Fixture', streamId: reference.threadId,
    streamName: reference.threadId, streamOrdinal: 1 };
  callbackWorkMs += performance.now() - start;
  return value;
};
try {
  await journal.upsertRecords(Array.from({ length: localCount }, (_, i) => ({
    provider: 'codex', threadId: `thread-${i % 100}`, taskThreadId: `thread-${i % 100}`, turnId: `turn-${i}`,
    projectRoot: root, startedAt: '2026-10-06T09:59:00Z', completedAt: '2026-10-06T10:00:00Z',
    model: 'gpt-6.1-sol', usageReported: true, usage: { inputTokens: 1_000, outputTokens: 100 },
    body: 'synthetic answer '.repeat(8), prompt: 'synthetic prompt', status: 'completed',
  })));
  await worker.importSnapshot({ events: Array.from({ length: factCount }, (_, i) => ({
    deviceId: 'bench-remote', provider: 'codex', threadId: `remote-${i}`, turnId: `fact-${i}`,
    completedAt: '2026-10-06T10:00:00Z', model: 'gpt-6.1-sol', estimatedCredits: 2,
  })) });
  delay.enable();
  let expected;
  for (let run = 0; run < 4; run++) {
    callbackCount = 0; callbackWorkMs = 0;
    const before = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    delay.reset();
    const start = performance.now();
    const result = await worker.projectJournal({ defaultProjectRoot: root, projectRoots: [root],
      includeClaudeUsage: true, localDeviceId: 'bench-local', localDeviceLabel: 'Fixture', now: now + run * 100 },
    { workspaceResolver });
    const callerAwaitMs = performance.now() - start;
    const after = process.memoryUsage();
    const cpu = process.cpuUsage(cpuBefore);
    const projectionEventLoopDelayMaxMs = delay.max / 1e6;
    const snapshot = await journal.snapshot();
    const parityHash = hash({ html: snapshot.html, days: snapshot.days, turns: snapshot.turns,
      turnEntries: snapshot.turnEntries, summary: snapshot.summary });
    if (run === 0) expected = parityHash;
    else assert.equal(parityHash, expected);
    observations.push({ run, callerAwaitMs, callbackCount, callbackWorkMs,
      heapDeltaBytes: after.heapUsed - before.heapUsed, rssAfterBytes: after.rss,
      processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000,
      projectionEventLoopDelayMaxMs,
      parityHash, result });
    assert.equal(callbackCount, Math.min(localCount, 100));
    if (run && Object.hasOwn(result, 'projectionReused')) {
      assert.equal(result.projectionReused, true);
      assert.equal(result.renderMs, 0);
      assert.equal(result.factsSourceRead, false);
    }
  }
  const logicalBytes = {};
  for (const suffix of ['', '-wal', '-shm']) {
    logicalBytes[suffix || 'main'] = (await stat(databaseFile + suffix).catch(() => null))?.size || 0;
  }
  console.log(JSON.stringify({ operationId, synthetic: true, localCount, factCount, observations,
    logicalBytes, memoryNote: 'process snapshots/deltas, not peak or physical allocation',
    timingNote: 'projection-only sampling excludes oracle reads/setup; process CPU includes both Node threads; caller await and worker phases inclusive; callbackWork is synchronous resolver only; queue separate; zero timer samples are not zero overhead' }, null, 2));
} finally {
  delay.disable();
  await worker.close();
  journal.close();
  await rm(root, { recursive: true, force: true });
}
