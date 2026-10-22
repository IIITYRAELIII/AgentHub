import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskReadStateStore, taskHasUnreadAnswer } from '../../../src/infrastructure/persistence/task-read-state-store.mjs';
import { DesktopReadModelService } from '../../../src/interfaces/desktop/desktop-read-model-service.mjs';

const base = { accountId: 'local', provider: 'codex', threadId: 'thread-b',
  answerTurnId: 'final-b', answerRevision: 1, answerAt: '2026-10-16T09:10:10.774Z' };

test('read final identity absorbs timestamp enrichment and higher revision wins clock skew across reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-read-identity-'));
  let store = new TaskReadStateStore({ dataDir: directory });
  try {
    await store.initialize();
    const original = await store.markRead(base);
    for (const answerAt of ['2026-10-16T09:10:25.273Z', '2026-10-16T09:09:00.000Z']) {
      assert.equal(taskHasUnreadAnswer({ ...base, answerAt }, original), false,
        'completion time enrichment cannot resurrect the exact read revision');
      assert.equal(taskHasUnreadAnswer({ ...base, answerAt, answerRevision: 2 }, original), true,
        'an unseen higher revision is not covered by an earlier read even with an earlier clock');
    }
    const newer = { ...base, answerAt: '2026-10-16T09:09:00.000Z', answerRevision: 2 };
    const receipt = await store.markRead(newer);
    assert.equal(receipt.answerRevision, 2);
    const revision = store.revision;
    await store.markRead({ ...base, answerAt: '2026-10-16T09:12:00.000Z' });
    assert.equal(store.revision, revision, 'late lower revision cannot overwrite the read cursor');
    assert.deepEqual(store.get(base), receipt);
    await store.close();
    store = new TaskReadStateStore({ dataDir: directory });
    await store.initialize();
    assert.equal(taskHasUnreadAnswer({ ...newer, answerAt: base.answerAt }, store.get(base)), false);
    assert.equal(taskHasUnreadAnswer({ ...newer, answerRevision: 3 }, store.get(base)), true);
    assert.equal(store.get({ ...base, provider: 'claude' }), null);
    assert.equal(store.get({ ...base, accountId: 'other' }), null);
    const legacy = { ...base, answerAtMs: Date.parse(base.answerAt), answerRevision: 0 };
    assert.equal(taskHasUnreadAnswer({ ...base, answerAt: '2026-10-16T09:10:25.273Z',
      migrationGuard: 'legacy-terminal-revision' }, legacy), false);
    assert.equal(taskHasUnreadAnswer({ ...base, answerRevision: 2,
      migrationGuard: 'legacy-terminal-revision' }, legacy), true);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('production read service agrees with durable exact receipt after changed completion time and rejects stale revision', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-read-service-'));
  const store = new TaskReadStateStore({ dataDir: directory });
  let record = { provider: base.provider, threadId: base.threadId, turnId: base.answerTurnId,
    terminalRevision: 1, updatedAt: base.answerAt };
  const service = new DesktopReadModelService({
    snapshot: ({ projectTask = x => x } = {}) => ({ tasks: [projectTask({ provider: base.provider,
      threadId: base.threadId, streamId: 'stream-b' })] }),
    readStateStore: store, trustedDeviceUserId: () => 'local',
    lastTaskMessage: () => record, hasUnread: taskHasUnreadAnswer,
  });
  try {
    await store.initialize();
    const final = (await service.snapshot()).tasks[0].latestFinal;
    assert.equal((await service.markTaskRead({ final })).marked, true);
    record = { ...record, updatedAt: '2026-10-16T09:10:25.273Z' };
    assert.equal((await service.snapshot()).tasks[0].unread, false);
    const retry = await service.markTaskRead({ final });
    assert.equal(retry.marked, true);
    assert.equal(taskHasUnreadAnswer({ ...base, answerAt: retry.final.completedAt }, retry.cursor), false);
    record = { ...record, terminalRevision: 2, updatedAt: '2026-10-16T09:09:00.000Z' };
    assert.equal((await service.snapshot()).tasks[0].unread, true);
    assert.equal((await service.markTaskRead({ final })).reason, 'stale-final');
    const next = (await service.snapshot()).tasks[0].latestFinal;
    assert.equal((await service.markTaskRead({ final: next })).cursor.answerRevision, 2);
    assert.equal((await service.snapshot()).tasks[0].unread, false);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
