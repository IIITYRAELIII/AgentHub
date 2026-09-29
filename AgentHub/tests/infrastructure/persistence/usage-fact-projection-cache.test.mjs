import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WorkLogUsageSyncStore } from '../../../src/infrastructure/persistence/work-log-usage-sync-store.mjs';

test('projection facts reuse unchanged rows and observe local and foreign fact writes', async () => {
  const fixtureRoot = fileURLToPath(new URL('../../../../WIP/sol-benchmark/', import.meta.url));
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, 'facts-'));
  const databaseFile = path.join(directory, 'journal.sqlite');
  const store = new WorkLogUsageSyncStore({ databaseFile });
  let foreign;
  let restarted;
  try {
    const first = await store.projectionFacts();
    assert.equal(first.sourceRead, true);
    assert.equal((await store.projectionFacts()).sourceRead, false);
    const event = index => ({ deviceId: 'remote', provider: 'codex', threadId: 'thread',
      turnId: `turn-${index}`, completedAt: '2026-09-29T00:00:00Z', estimatedCredits: index });
    await store.importSnapshot({ events: [event(1)] });
    const local = await store.projectionFacts();
    assert.equal(local.sourceRead, true);
    assert.equal(local.facts.length, 1);
    foreign = new DatabaseSync(databaseFile);
    foreign.exec('CREATE TABLE unrelated (id INTEGER); INSERT INTO unrelated VALUES (1)');
    assert.equal((await store.projectionFacts()).sourceRead, false);
    foreign.prepare('UPDATE usage_sync_events SET estimated_credits = 9 WHERE event_id = ?')
      .run(local.facts[0].eventId);
    const changed = await store.projectionFacts();
    assert.equal(changed.sourceRead, true);
    assert.equal(changed.facts[0].estimatedCredits, 9);
    assert.equal((await store.projectionFacts()).sourceRead, false);
    const revisionBeforeRestart = foreign.prepare(
      "SELECT value FROM usage_sync_meta WHERE key = 'facts_revision'",
    ).get().value;
    restarted = new WorkLogUsageSyncStore({ databaseFile });
    assert.equal((await restarted.projectionFacts()).facts[0].estimatedCredits, 9);
    assert.equal(foreign.prepare(
      "SELECT value FROM usage_sync_meta WHERE key = 'facts_revision'",
    ).get().value, revisionBeforeRestart);
    foreign.exec("BEGIN; DELETE FROM usage_sync_events; ROLLBACK");
    assert.equal((await store.projectionFacts()).sourceRead, false);
    assert.equal((await store.projectionFacts()).facts.length, 1);
    foreign.exec("DELETE FROM usage_sync_events");
    const deleted = await store.projectionFacts();
    assert.equal(deleted.sourceRead, true);
    assert.deepEqual(deleted.facts, []);
    assert.deepEqual((await restarted.projectionFacts()).facts, []);
  } finally {
    await restarted?.close();
    foreign?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
