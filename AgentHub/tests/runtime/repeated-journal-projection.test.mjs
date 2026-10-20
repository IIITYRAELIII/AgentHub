import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { buildLazyJournalPayload } from '../../src/application/journal-projection-data.mjs';
import { normalizePersistedWorkLog, projectWorkLogUsage, sameProjectRoot,
  workLogAccountUsageWindow } from '../../src/application/work-log-usage-projection.mjs';
import { WorkLogUsageSyncStore } from '../../src/infrastructure/persistence/work-log-usage-sync-store.mjs';
import { createWorkLogUsageStore } from '../../src/application/work-log-usage-store.mjs';
import { WorkLogUsageRepository } from '../../src/infrastructure/persistence/work-log-usage-repository.mjs';
import { JournalDatabase } from '../../src/infrastructure/persistence/journal-database.mjs';
import { WorkLogUsageSyncWorkerStore } from '../../src/runtime/work-log-usage-sync-worker-client.mjs';

test('unchanged worker projection reuses rendering but still resolves exact workspace bindings', async () => {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || os.tmpdir(), 'journal-reuse-'));
  const databaseFile = path.join(root, 'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  let resolves = 0;
  const options = { defaultProjectRoot: root, projectRoots: [root], now: Date.parse('2026-10-07T12:00:00Z') };
  const workspaceResolver = () => { resolves++; return { workspaceId: 'workspace', streamId: 'stream' }; };
  try {
    await journal.upsertRecords([{ provider: 'codex', threadId: 'thread', turnId: 'turn', projectRoot: root,
      completedAt: '2026-10-06T10:00:00Z', body: 'retained answer', model: 'gpt-6.1-sol',
      usageReported: true, usage: { inputTokens: 1000 } }]);
    assert.equal((await worker.projectJournal(options, { workspaceResolver })).projected, true);
    const before = await journal.snapshot();
    const warm = await worker.projectJournal({ ...options, now: options.now + 100 }, { workspaceResolver });
    assert.equal(warm.projectionReused, true);
    assert.equal(warm.renderMs, 0);
    assert.equal(resolves, 2);
    assert.deepEqual(await journal.snapshot(), before);
  } finally { await worker.close(); journal.close(); await rm(root, { recursive: true, force: true }); }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || os.tmpdir(), 'journal-reuse-inputs-'));
  const databaseFile = path.join(root, 'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  let worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  const peer = new WorkLogUsageSyncStore({ databaseFile });
  const cleanup = [];
  const options = { defaultProjectRoot: root, projectRoots: [root], includeClaudeUsage: true,
    localDeviceId: 'local', localDeviceLabel: 'Local', now: Date.parse('2026-10-07T12:00:00Z') };
  const record = { provider: 'codex', threadId: 'thread', turnId: 'turn', projectRoot: root,
    completedAt: '2026-10-07T11:59:00Z', body: 'retained answer', model: 'gpt-6.1-sol',
    usageReported: true, usage: { inputTokens: 1000 }, accountKey: 'chatgpt:fixture', accountAttribution: 'exact' };
  let binding = { workspaceId: 'workspace', workspaceName: 'Original', streamId: 'stream', streamName: 'Original' };
  const workspaceResolver = () => binding;
  await journal.upsertRecords([record, { ...record, provider: 'claude', turnId: 'claude', model: 'claude-sonnet-4-5' }]);
  const project = () => worker.projectJournal(options, { workspaceResolver });
  await project();
  assert.equal((await project()).projectionReused, true);
  t.after(async () => { for (const close of cleanup.reverse()) await close();
    await worker.close(); await peer.close(); journal.close();
    await rm(root, { recursive: true, force: true }); });
  const oracle = async () => {
    const ledger = normalizePersistedWorkLog(await journal.loadLedger(), options).ledger;
    const selected = Object.fromEntries(Object.entries(ledger.turns).filter(([, r]) =>
      !options.projectRoots.some(Boolean) || options.projectRoots.some(p => sameProjectRoot(p, r.projectRoot))));
    const actual = await journal.snapshot();
    const rateLimits = actual.html.match(/<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu)?.[0] || '';
    const expected = buildLazyJournalPayload(projectWorkLogUsage('# Глобальный журнал работ\n' + rateLimits,
      selected, { ...options, syncedUsageEvents: await peer.facts(), accountCatalog: await journal.accountCatalog(),
        workspaceResolver }));
    for (const key of ['html', 'days', 'turns', 'summary']) assert.deepEqual(actual[key], expected[key], key);
  };
  return { root, databaseFile, journal, peer, options, record, project, oracle,
    onCleanup(close) { cleanup.push(close); },
    setBinding(value) { binding = value; }, get worker() { return worker; },
    async reopen() { await worker.close(); worker = new WorkLogUsageSyncWorkerStore({ databaseFile }); } };
}

const remote = turnId => ({ deviceId: 'remote', provider: 'codex', threadId: 'foreign-thread', turnId,
  completedAt: '2026-10-07T11:00:00Z', model: 'gpt-6.1-sol', estimatedCredits: 2 });
for (const [name, change] of [
  ['body correction', s => s.journal.upsertRecords([{ ...s.record, body: 'corrected body' }])],
  ['date move', s => s.journal.upsertRecords([{ ...s.record, completedAt: '2026-10-05T10:00:00Z' }])],
  ['deletion', s => s.journal.deleteRecords([s.record])],
  ['new late record', s => s.journal.upsertRecords([{ ...s.record, turnId: 'late', completedAt: '2026-10-01T10:00:00Z' }])],
  ['foreign sync facts', s => s.peer.importSnapshot({ events: [remote('added')] })],
  ['workspace rebind', s => s.setBinding({ workspaceId: 'moved', workspaceName: 'Moved', streamId: 'new', streamName: 'New' })],
  ['Claude inclusion', s => { s.options.includeClaudeUsage = false; }],
  ['project scope', s => { s.options.projectRoots = [path.join(s.root, 'another')]; }],
  ['device identity', s => { s.options.localDeviceId = 'remote'; }],
  ['device label', s => { s.options.localDeviceLabel = 'Changed device'; }],
  ['image version', s => { s.options.imageBackfillVersion = 'image-fixture-version'; }],
  ['pricing version', s => {
    const db = new DatabaseSync(s.databaseFile);
    try { db.exec("UPDATE journal_store_meta SET value = 'old-fixture-pricing' WHERE key = 'pricing_projection_version'"); }
    finally { db.close(); }
  }],
  ['backward clock', s => { s.options.now -= 100; }],
  ['restart', s => s.reopen()],
  ['cache reconstruction', async s => { const current = await s.journal.snapshot();
    await s.journal.replaceProjection(current, { version: current.version }); }],
]) {
  test('reuse invalidates on ' + name + ' and agrees with the full canonical renderer', async t => {
    const s = await fixture(t);
    await change(s);
    const result = await s.project();
    assert.equal(result.projectionReused, false);
    assert.ok(result.renderMs >= 0);
    assert.equal(result.conflict, undefined);
    await s.oracle();
  });
}

test('account catalog and fact generation changes invalidate without a journal revision change', async t => {
  const s = await fixture(t);
  const db = new DatabaseSync(s.databaseFile);
  s.onCleanup(() => db.close());
  const revision = await s.journal.currentRevision();
  db.exec(`CREATE TABLE rate_limit_account_events (observed_ms INTEGER, account_key TEXT,
    account_label TEXT, account_type TEXT, account_plan TEXT);
    INSERT INTO rate_limit_account_events VALUES (1, 'chatgpt:fixture', 'New label', 'oauth', 'pro');`);
  assert.equal(await s.journal.currentRevision(), revision);
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  assert.equal((await s.project()).projectionReused, true);
  db.exec("UPDATE usage_sync_meta SET value = 'new-fixture-generation' WHERE key = 'local_store_generation'");
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
});

test('facts insert/update/delete/rollback from a foreign SQLite owner invalidate only committed facts', async t => {
  const s = await fixture(t);
  await s.peer.importSnapshot({ events: [remote('foreign')] });
  assert.equal((await s.project()).projectionReused, false);
  const db = new DatabaseSync(s.databaseFile);
  s.onCleanup(() => db.close());
  db.exec('BEGIN; DELETE FROM usage_sync_events; ROLLBACK');
  assert.equal((await s.project()).projectionReused, true);
  db.exec('UPDATE usage_sync_events SET estimated_credits = 4');
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  db.exec('DELETE FROM usage_sync_events');
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
});

test('new journal revision during a warm callback refuses reuse and cannot acknowledge stale state', async t => {
  const s = await fixture(t);
  let changed = false;
  const stale = await s.worker.projectJournal(s.options, { workspaceResolver: async () => {
    if (!changed) { changed = true; await s.journal.upsertRecords([{ ...s.record, body: 'late durable correction' }]); }
    return { workspaceId: 'workspace', workspaceName: 'Original', streamId: 'stream', streamName: 'Original' };
  } });
  assert.equal(stale.projectionReused, false);
  assert.equal(stale.projectionDeferred, true);
  assert.equal(stale.conflict, true);
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  assert.equal((await s.project()).projectionReused, true);
});

for (const marker of ['pricing_projection_version', 'image_backfill_version']) {
  test('version drift during a warm Workspace callback rebuilds: ' + marker, async t => {
    const s = await fixture(t);
    s.options.imageBackfillVersion = 'image-fixture-v1';
    await s.project();
    assert.equal((await s.project()).projectionReused, true);
    const revision = await s.journal.currentRevision();
    let changed = false;
    const result = await s.worker.projectJournal(s.options, { workspaceResolver: () => {
      if (!changed) {
        const db = new DatabaseSync(s.databaseFile);
        try { db.prepare('UPDATE journal_store_meta SET value = ? WHERE key = ?').run('stale-marker', marker); }
        finally { db.close(); }
        changed = true;
      }
      return { workspaceId: 'workspace', workspaceName: 'Original', streamId: 'stream', streamName: 'Original' };
    } });
    assert.equal(result.projectionReused, false);
    assert.equal(result.projected, true);
    assert.equal(result.projectionMode, 'full');
    assert.ok(result.revision > revision);
    assert.notEqual(marker === 'pricing_projection_version'
      ? await s.journal.pricingProjectionVersion() : await s.journal.imageBackfillVersion(), 'stale-marker');
    await s.oracle();
    assert.equal((await s.project()).projectionReused, true);
  });
  for (const boundary of ['consume', 'mint']) {
    test('final SQLite snapshot rejects version drift at receipt ' + boundary + ': ' + marker, async () => {
      const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || os.tmpdir(), 'journal-version-fence-'));
      const databaseFile = path.join(root, 'journal.sqlite');
      const journal = new JournalDatabase(databaseFile);
      const preload = path.join(root, 'drift.mjs');
      const fenceOutcome = path.join(root, 'fence-outcome.json');
      // Fault precisely at the existing owning fence. Reads, renderer, revision
      // CAS and both SQLite connections remain the production implementations.
      await writeFile(preload, `import { DatabaseSync } from 'node:sqlite';
        import { writeFileSync } from 'node:fs';
        import { JournalDatabase } from ${JSON.stringify(
          new URL('../../src/infrastructure/persistence/journal-database.mjs', import.meta.url).href)};
        const original = JournalDatabase.prototype.projectionReuseFence;
        let calls = 0;
        JournalDatabase.prototype.projectionReuseFence = function (...args) {
          const drifted = ++calls === ${boundary === 'consume' ? 3 : 1};
          if (drifted) {
            const db = new DatabaseSync(${JSON.stringify(databaseFile)});
            try { db.prepare('UPDATE journal_store_meta SET value = ? WHERE key = ?')
              .run('stale-marker', ${JSON.stringify(marker)}); }
            finally { db.close(); }
          }
          return original.apply(this, args).then(result => {
            if (drifted) writeFileSync(${JSON.stringify(fenceOutcome)}, JSON.stringify(result));
            return result;
          });
        };`);
      class DriftWorker extends Worker {
        constructor(url, options) { super(url, { ...options, execArgv: ['--import', pathToFileURL(preload).href] }); }
      }
      const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, WorkerImpl: DriftWorker });
      try {
        await journal.upsertRecords([{ provider: 'codex', threadId: 'thread', turnId: 'turn', projectRoot: root,
          completedAt: '2026-10-06T10:00:00Z', body: 'durable answer' }]);
        const options = { projectRoots: [root], defaultProjectRoot: root,
          imageBackfillVersion: 'image-fixture-v1', now: Date.parse('2026-10-07T12:00:00Z') };
        assert.equal((await worker.projectJournal(options)).projected, true);
        if (boundary === 'consume') assert.equal((await worker.projectJournal(options)).projectionReused, true);
        else assert.equal(marker === 'pricing_projection_version'
          ? await journal.pricingProjectionVersion() : await journal.imageBackfillVersion(), 'stale-marker');
        const rebuilt = await worker.projectJournal(options);
        assert.equal(rebuilt.projectionReused, false);
        assert.equal(rebuilt.projected, true);
        assert.equal(rebuilt.projectionMode, 'full');
        assert.notEqual(marker === 'pricing_projection_version'
          ? await journal.pricingProjectionVersion() : await journal.imageBackfillVersion(), 'stale-marker');
        assert.equal(JSON.parse(await readFile(fenceOutcome, 'utf8')), false);
        assert.equal((await worker.projectJournal(options)).projectionReused, true);
      } finally { await worker.close(); journal.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}

test('unknown-thread assignment remains active and a subsequently visible binding rebuilds history', async t => {
  const s = await fixture(t);
  let resolves = 0, assigns = 0, binding = null;
  const usage = createWorkLogUsageStore({ databaseFile: s.databaseFile, ledgerFile: path.join(s.root, 'retired.json'),
    defaultProjectRoot: s.root, usageSyncStore: s.worker,
    repositoryFactory: options => new WorkLogUsageRepository(options),
    workspaceCatalogStore: { resolveThread() { resolves++; return binding; },
      async assignUnknownThread() { assigns++; return null; } } });
  s.onCleanup(() => usage.close());
  await usage.project(null);
  await usage.project(null);
  assert.equal(resolves, 4);
  assert.equal(assigns, 4);
  binding = { workspaceId: 'assigned', workspaceName: 'Assigned', streamId: 'assigned', streamName: 'Assigned' };
  assert.equal((await usage.project(null)).projectionReused, false);
  assert.match(JSON.stringify(await s.journal.snapshot()), /Assigned/);
});

test('future entry, rolling 24h expiry and local midnight expire reuse without a source write', async t => {
  const s = await fixture(t);
  await s.journal.upsertRecords([{ ...s.record, turnId: 'future', completedAt: new Date(s.options.now + 1000).toISOString() }]);
  await s.project();
  const before = await s.journal.currentRevision();
  s.options.now += 1000;
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  s.options.now = Date.parse(s.record.completedAt) + 24 * 60 * 60 * 1000 + 1;
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  const midnight = new Date(s.options.now); midnight.setHours(24, 0, 0, 0);
  s.options.now = midnight.getTime();
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  assert.ok(await s.journal.currentRevision() >= before);
});

test('canonical window is conservative at exact inclusive cutpoints and rejects invalid clocks', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(workLogAccountUsageWindow({ a: { completedAt: new Date(now - 86400000).toISOString() } }, { now }).until, now);
  assert.equal(workLogAccountUsageWindow({ a: { completedAt: new Date(now + 5).toISOString() } }, { now }).until, now + 5);
  assert.equal(workLogAccountUsageWindow({}, { now: NaN }), null);
  assert.equal(workLogAccountUsageWindow({}, { now: now + 0.5 }), null);
});

for (const type of ['auth_observation', 'limit_observation']) {
  test('a foreign ' + type + ' invalidates the same facts-revision authority', async t => {
    const s = await fixture(t);
    const fact = type === 'auth_observation' ? {
      schemaVersion: 2, type, deviceId: 'remote', provider: 'codex', runtimeHomeId: '1'.repeat(64),
      accountKey: 'chatgpt:fixture', observedAt: '2026-10-07T11:00:00Z',
      installationInstanceId: '0b7f3a52-3c1e-4c55-9a8e-5d2f1a7c9e10',
    } : {
      schemaVersion: 2, type, deviceId: 'remote', provider: 'codex', accountKey: 'chatgpt:fixture',
      limitId: 'codex', window: 'primary', usedPercent: 5, observedAt: '2026-10-07T11:00:00Z',
    };
    await s.peer.importSnapshot({ events: [fact] });
    assert.equal((await s.project()).projectionReused, false);
    await s.oracle();
    assert.equal((await s.project()).projectionReused, true);
  });
}

test('lost caller receipt and stale expected revision never fabricate a new projection acknowledgement', async t => {
  const s = await fixture(t);
  const revision = await s.journal.currentRevision();
  await assert.rejects(s.project().then(() => { throw Error('lost caller receipt'); }), /lost caller receipt/);
  assert.equal(await s.journal.currentRevision(), revision);
  const refused = await s.worker.projectJournal({ ...s.options, expectedRevision: -1 });
  assert.equal(refused.projectionReused, false);
  assert.equal(refused.projectionDeferred, true);
  assert.equal(await s.journal.currentRevision(), revision);
  assert.equal((await s.project()).projectionReused, false);
  await s.oracle();
  assert.equal((await s.project()).projectionReused, true);
});

test('failure to establish optional reuse proof cannot reject an already committed projection', async () => {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || os.tmpdir(), 'journal-reuse-proof-fault-'));
  const databaseFile = path.join(root, 'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  const preload = path.join(root, 'fault.mjs');
  // A test-only owning-method fault, not a source assertion or alternate store.
  // Every read/write/render still uses the real disposable SQLite + worker.
  await writeFile(preload, `import { JournalDatabase } from ${JSON.stringify(
    new URL('../../src/infrastructure/persistence/journal-database.mjs', import.meta.url).href)};
    const original = JournalDatabase.prototype.projectionReuseFence;
    let fail = true;
    JournalDatabase.prototype.projectionReuseFence = function (...args) {
      if (fail) { fail = false; throw Error('reuse proof unavailable'); }
      return original.apply(this, args);
    };`);
  class FaultWorker extends Worker {
    constructor(url, options) { super(url, { ...options, execArgv: ['--import', pathToFileURL(preload).href] }); }
  }
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, WorkerImpl: FaultWorker });
  try {
    await journal.upsertRecords([{ provider: 'codex', threadId: 'thread', turnId: 'turn', projectRoot: root,
      completedAt: '2026-10-06T10:00:00Z', body: 'durable answer' }]);
    const options = { projectRoots: [root], defaultProjectRoot: root, now: Date.parse('2026-10-07T12:00:00Z') };
    const first = await worker.projectJournal(options);
    assert.equal(first.projected, true);
    assert.equal(first.reuseReceiptFailed, 1);
    assert.equal(await journal.currentRevision(), first.revision);
    const before = await journal.snapshot();
    assert.equal((await worker.projectJournal(options)).projectionReused, false);
    assert.equal((await worker.projectJournal(options)).projectionReused, true);
    assert.deepEqual(await journal.snapshot(), before);
  } finally { await worker.close(); journal.close(); await rm(root, { recursive: true, force: true }); }
});
