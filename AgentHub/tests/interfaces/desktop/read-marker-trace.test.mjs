import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopReadModelService } from '../../../src/interfaces/desktop/desktop-read-model-service.mjs';
import { TaskReadStateStore, taskHasUnreadAnswer } from '../../../src/infrastructure/persistence/task-read-state-store.mjs';
import { openRuntimeDatabase } from '../../../src/infrastructure/persistence/runtime-state-store.mjs';
import { createCommandTraceComposition } from '../../../src/composition/command-trace-composition.mjs';
import { clientPerformanceTraceSpans } from '../../../src/application/client-performance-trace.mjs';

test('original read ID persists wait/work/projection and client paint, including failed contention and restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub291-read-trace-'));
  let trace = createCommandTraceComposition({ dataDir: directory, instanceId: 'isolated-instance', releaseId: 'isolated-result' });
  let store = new TaskReadStateStore({ dataDir: directory });
  let locker;
  let releaseTimer;
  try {
    await trace.initialize();
    await store.initialize();
    const final = { provider: 'codex', threadId: 'thread', turnId: 'turn', revision: 2,
      completedAt: '2026-10-06T07:00:00.000Z' };
    const task = { provider: final.provider, threadId: final.threadId, streamId: 'stream' };
    const service = new DesktopReadModelService({
      resolveReadTask: () => task,
      snapshot: ({ projectTask = (entry) => entry }) => ({ tasks: [projectTask(task)] }),
      readStateStore: store, trustedDeviceUserId: () => 'owner',
      lastTaskMessage: () => ({ ...final, updatedAt: final.completedAt, terminalRevision: final.revision }),
      hasUnread: taskHasUnreadAnswer, commandTrace: trace.service,
    });
    locker = openRuntimeDatabase(directory);
    locker.exec('BEGIN IMMEDIATE');
    releaseTimer = setTimeout(() => { locker.exec('ROLLBACK'); }, 60);
    const result = await service.markTaskRead({ final, clientTraceId: 'original-read' });
    assert.equal(result.marked, true);
    assert.equal((await service.snapshot()).tasks[0].unread, false);
    const revision = store.revision;
    assert.deepEqual(await service.markTaskRead({ final, clientTraceId: 'original-read' }), result);
    assert.equal(store.revision, revision, 'duplicate read does not write another cursor');
    const stale = await service.markTaskRead({ final: { ...final, revision: 1 }, clientTraceId: 'stale-read' });
    assert.equal(stale.reason, 'stale-final');
    const now = Date.now();
    const paint = clientPerformanceTraceSpans({ events: [{
      commandId: 'original-read', stage: 'ui-render', outcome: 'succeeded', observedAtMs: now, monotonicDurationMs: 17,
      metadata: { action: 'read-marker-clear', render: 'cleared', provider: final.provider,
        threadId: final.threadId, turnId: final.turnId, terminalRevision: 2, documentId: 'document',
        codeMarker: 'hub291.read-marker.1', tabReady: false, cardReady: false, text: 'PRIVATE' },
    }] });
    await trace.service.recordMany(paint);
    const timeline = await trace.service.readCommandTimeline('original-read');
    for (const stage of ['read-final-resolve', 'read-final-decision', 'read-cursor-queue-wait',
      'read-cursor-write', 'read-cursor-contention-wait', 'read-cursor-confirmed', 'read-cursor-projected', 'ui-render']) {
      assert.ok(timeline.some((span) => span.stage === stage), stage);
    }
    assert.ok(timeline.some((span) => span.stage === 'read-cursor-write' && span.outcome === 'failed' && span.metadata.contention));
    assert.ok(timeline.some((span) => span.stage === 'read-cursor-contention-wait' && span.monotonicDurationMs >= 30));
    assert.equal(timeline.find((span) => span.stage === 'read-cursor-projected').metadata.unread, false);
    assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE|owner|accountId/u);
    assert.ok(timeline.every((span) => span.metadata.instanceId === 'isolated-instance' && span.metadata.releaseId === 'isolated-result'));
    await store.close(); await trace.close();
    store = new TaskReadStateStore({ dataDir: directory }); await store.initialize();
    assert.equal(taskHasUnreadAnswer({ answerAt: final.completedAt, answerTurnId: final.turnId, answerRevision: 2 },
      store.get({ accountId: 'local', provider: final.provider, threadId: final.threadId })), false);
    trace = createCommandTraceComposition({ dataDir: directory, instanceId: 'restart-instance', releaseId: 'isolated-result' });
    await trace.initialize();
    assert.deepEqual(await trace.service.readCommandTimeline('original-read'), timeline);
  } finally {
    clearTimeout(releaseTimer);
    locker?.close();
    await store.close(); await trace.close();
    await rm(directory, { recursive: true, force: true });
  }
});
