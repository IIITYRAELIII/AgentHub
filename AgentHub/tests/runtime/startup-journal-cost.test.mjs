import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JournalDatabase } from '../../src/infrastructure/persistence/journal-database.mjs';
import { WorkspaceCatalogStore } from '../../src/infrastructure/persistence/workspace-catalog-store.mjs';
import { WorkLogUsageRepository } from '../../src/infrastructure/persistence/work-log-usage-repository.mjs';
import { createWorkLogUsageStore } from '../../src/application/work-log-usage-store.mjs';
import { WorkLogUsageSyncWorkerStore } from '../../src/runtime/work-log-usage-sync-worker-client.mjs';
import { CommandTraceWorkerStore } from '../../src/infrastructure/persistence/command-trace-worker-store.mjs';
import { CommandTraceService } from '../../src/application/command-trace-service.mjs';
import { RunJournalService } from '../../src/application/run-journal-service.mjs';
import { TurnEndDeliveryService } from '../../src/application/turn-end-delivery-service.mjs';
import { TerminalTurnCommitService } from '../../src/application/terminal-turn-commit-service.mjs';
import { ProviderTurnTerminalStore } from '../../src/infrastructure/persistence/provider-turn-terminal-store.mjs';
import { AgentHubStartupCoordinator } from '../../src/application/agent-hub-startup-coordinator.mjs';
import { createRuntimeHealth } from '../../src/application/runtime-health.mjs';
import { createWorkspaceCatalogMutationOwner } from '../../src/application/sqlite-mutation-owner.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub409-journal-'));
  const databaseFile = path.join(root, 'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: 'local' });
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, 'catalog.sqlite') });
  await catalog.load();
  const workspace = catalog.createWorkspaceWithStream({ name: 'Fixture' });
  t.after(async () => {
    await worker.close(); journal.close(); catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const record = (i) => ({ provider: 'codex', threadId: `thread-${i}`, turnId: `turn-${i}`,
    projectRoot: root, completedAt: '2026-10-07T10:00:00Z', body: `Answer ${i}`,
    model: 'gpt-6.1-sol', usageReported: true, usage: { inputTokens: 20 } });
  const options = { defaultProjectRoot: root, projectRoots: [root], now: Date.parse('2026-10-07T12:00:00Z') };
  return { root, databaseFile, journal, worker, catalog, workspace, record, options };
}

test('the production catalog capability exposes the batch read to the real projection worker', async t => {
  const s = await fixture(t), record = s.record(0);
  s.catalog.bindThread({ ...record, streamId: s.workspace.stream.id, source: 'created' });
  await s.journal.upsertRecords([record]);
  const catalog = createWorkspaceCatalogMutationOwner(s.catalog);
  const usage = createWorkLogUsageStore({ ledgerFile: path.join(s.root, 'retired.json'),
    databaseFile: s.databaseFile, defaultProjectRoot: s.root, usageSyncStore: s.worker,
    workspaceCatalogStore: catalog, repositoryFactory: options => new WorkLogUsageRepository(options) });
  try {
    await usage.project(null);
    assert.equal(s.worker.diagnostics().lastJournalProjection.projected, true);
    const bindings = new Map((await s.journal.projectionSource()).bindings);
    assert.deepEqual(bindings.get('codex\0thread-0'), s.catalog.resolveThread(record));
  } finally { await usage.close(); }
});

test('a coalesced trailing projection carries its requesting original ID, not the completed leading ID', async t => {
  const s = await fixture(t);
  await s.journal.upsertRecords([s.record(0)]);
  const ids = [], project = s.worker.projectJournal.bind(s.worker);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  s.worker.projectJournal = async (payload, options) => {
    ids.push(options.traceCommandId);
    if (ids.length === 1) { enter(); await released; }
    return project(payload, options);
  };
  const usage = createWorkLogUsageStore({ ledgerFile: path.join(s.root, 'retired.json'),
    databaseFile: s.databaseFile, defaultProjectRoot: s.root, usageSyncStore: s.worker,
    workspaceCatalogStore: createWorkspaceCatalogMutationOwner(s.catalog),
    repositoryFactory: options => new WorkLogUsageRepository(options) });
  const leading = usage.project(null, { traceCommandId: 'fixture-leading-original' });
  try {
    await entered;
    const trailing = usage.project(null, { traceCommandId: 'fixture-trailing-original' });
    const coalesced = usage.project(null, { traceCommandId: 'fixture-coalesced-original' });
    release(); await Promise.all([leading, trailing, coalesced]);
    assert.deepEqual(ids, ['fixture-leading-original', 'fixture-trailing-original']);
  } finally { release(); await leading; await usage.close(); }
});

test('cold startup projection resolves the bounded worker batches without per-Thread catalog calls', async t => {
  const s = await fixture(t);
  const records = Array.from({ length: 257 }, (_, i) => s.record(i));
  for (const r of records) s.catalog.bindThread({ ...r, streamId: s.workspace.stream.id, source: 'created' });
  await s.journal.upsertRecords(records);
  const expected = new Map(records.map(r => [`${r.provider}\0${r.threadId}`, s.catalog.resolveThread(r)]));
  let pointReads = 0, batches = 0;
  const point = s.catalog.resolveThread.bind(s.catalog);
  s.catalog.resolveThread = (...args) => { pointReads++; return point(...args); };
  if (s.catalog.resolveThreads) {
    const batch = s.catalog.resolveThreads.bind(s.catalog);
    s.catalog.resolveThreads = refs => { batches++; return batch(refs); };
  }
  const usage = createWorkLogUsageStore({ ledgerFile: path.join(s.root, 'retired.json'),
    databaseFile: s.databaseFile, defaultProjectRoot: s.root, usageSyncStore: s.worker,
    workspaceCatalogStore: s.catalog, repositoryFactory: options => new WorkLogUsageRepository(options) });
  try {
    const started = performance.now();
    await usage.project(null);
    t.diagnostic(JSON.stringify({ phase: 'cold', records: records.length, pointReads, batches,
      elapsedMs: performance.now() - started, databaseBytes: (await stat(s.databaseFile)).size,
      phases: s.worker.diagnostics().lastJournalProjection }));
    const source = await s.journal.projectionSource();
    for (const [key, value] of source.bindings) assert.deepEqual(value, expected.get(key));
    assert.equal(pointReads, 0, 'one fresh batch lookup must replace repeated catalog point calls');
    assert.equal(batches, 3);
    assert.equal(s.worker.diagnostics().lastJournalProjection.accountingBulkRead, true);
    assert.equal(s.worker.diagnostics().lastJournalProjection.accountingPointReads, 0);
    const other = s.catalog.createWorkspaceWithStream({ name: 'New binding' });
    s.catalog.rebindThread(records[0], { streamId: other.stream.id, source: 'migration' });
    await usage.project(null);
    const rebound = new Map((await s.journal.projectionSource()).bindings);
    assert.equal(rebound.get('codex\0thread-0').workspaceId, other.workspace.id);
    assert.equal(pointReads, 0);
    assert.equal(s.worker.diagnostics().lastJournalProjection.accountingBulkRead, false);
    assert.equal(s.worker.diagnostics().lastJournalProjection.accountingRecordsRead, 0);
  } finally { await usage.close(); }
});

test('a journal revision changed during workspace resolution is refused before facts and rendering', async t => {
  const s = await fixture(t);
  await s.journal.upsertRecords([s.record(0)]);
  const before = await s.journal.snapshot();
  let changed = false;
  const result = await s.worker.projectJournal(s.options, { workspaceResolver: async () => {
    if (!changed) { changed = true; await s.journal.upsertRecords([{ ...s.record(0), body: 'New exact answer' }]); }
    return { workspaceId: 'fixture', streamId: 'fixture' };
  }});
  assert.equal(result.projectionDeferred, true);
  assert.equal(result.renderSkipped, true, 'an already stale snapshot must not rebuild an unusable journal');
  assert.equal(result.factsSourceRead, false);
  assert.equal(result.factsReadMs, 0);
  assert.equal(result.renderMs, 0);
  assert.deepEqual(await s.journal.snapshot(), before);
  const recovered = await s.worker.projectJournal(s.options, { workspaceResolver: () => ({ workspaceId: 'fixture', streamId: 'fixture' }) });
  assert.equal(recovered.projected, true);
  assert.match(JSON.stringify(await s.journal.snapshot()), /New exact answer/);
});

test('workspace batch error remains an original-ID failed trace after the trace worker reopens', async t => {
  const s = await fixture(t);
  await s.journal.upsertRecords([s.record(0)]);
  const before = await s.journal.snapshot();
  const databaseFile = path.join(s.root, 'trace.sqlite');
  const traceStore = new CommandTraceWorkerStore({ databaseFile });
  const trace = new CommandTraceService({ store: traceStore });
  s.worker.setTraceService(trace);
  const resolver = () => { throw new Error('ordinary lookup must not be used'); };
  resolver.batch = async () => { throw new Error('owned batch failure'); };
  try {
    await assert.rejects(s.worker.projectJournal(s.options, { workspaceResolver: resolver,
      traceCommandId: 'fixture-original-projection' }), /owned batch failure/);
  } finally { await traceStore.close(); }
  const reopened = new CommandTraceWorkerStore({ databaseFile });
  try {
    const spans = await reopened.readCommandTimeline('fixture-original-projection');
    assert.deepEqual(spans.map(s => s.outcome), ['started', 'failed']);
    assert.equal(spans[1].metadata.action, 'project-journal');
    assert.equal(spans[1].metadata.workspaceReferenceCount, 1);
    assert.equal(spans[1].metadata.workspaceBatchCount, 1);
    assert.ok(spans[1].metadata.workspaceResolveMs >= 0);
    assert.deepEqual(await s.journal.snapshot(), before);
  } finally { await reopened.close(); }
});

test('batch binding lookup preserves exact identities, missing entries and fresh external changes', async t => {
  const s = await fixture(t);
  const peer = new WorkspaceCatalogStore({ databaseFile: path.join(s.root, 'catalog.sqlite') });
  await peer.load();
  try {
    const identity = { provider: 'codex', threadId: "thread-'?-literal" };
    s.catalog.bindThread({ ...identity, streamId: s.workspace.stream.id, source: 'created' });
    const refs = [identity, { provider: 'claude', threadId: identity.threadId }, identity,
      { provider: 'codex', threadId: 'missing' }];
    const compare = () => assert.deepEqual(s.catalog.resolveThreads(refs), refs.map(r => s.catalog.resolveThread(r)));
    compare();
    const sibling = peer.createStream({ workspaceId: s.workspace.workspace.id });
    compare();
    assert.equal(s.catalog.resolveThreads([identity])[0].streamDisplayName, 'Stream 1');
    peer.archiveStream(sibling.id); compare();
    peer.renameWorkspace(s.workspace.workspace.id, 'External rename'); compare();
    assert.equal(s.catalog.resolveThreads([identity])[0].workspaceName, 'External rename');
    assert.deepEqual(s.catalog.resolveThreads([]), []);
    assert.throws(() => s.catalog.resolveThreads([{ provider: 'foreign', threadId: 'thread' }]), /invalid provider/);
  } finally { peer.close(); }
});

test('an incomplete workspace batch refuses projection without committing a partial binding set', async t => {
  const s = await fixture(t);
  await s.journal.upsertRecords([s.record(0), s.record(1)]);
  const before = await s.journal.snapshot();
  const resolver = () => { throw new Error('ordinary lookup must not be used'); };
  resolver.batch = () => [{ workspaceId: 'fixture', streamId: 'fixture' }];
  await assert.rejects(s.worker.projectJournal(s.options, { workspaceResolver: resolver }),
    /Workspace batch lookup returned an incomplete result/);
  assert.deepEqual(await s.journal.snapshot(), before);
  resolver.batch = refs => refs.map(() => ({ workspaceId: 'fixture', streamId: 'fixture' }));
  assert.equal((await s.worker.projectJournal(s.options, { workspaceResolver: resolver })).projected, true);
});

test('startup backlog retains every real outbox ACK fence before Ready with the optimized worker', async t => {
  const s = await fixture(t);
  const completions = Array.from({ length: 17 }, (_, i) => ({ ...s.record(i),
    status: 'completed', finalAnswer: `Exact retained final ${i}`,
    clientUserMessageId: `fixture-startup-original-${i}`, resolveAccount: false }));
  for (const c of completions) s.catalog.bindThread({ ...c, streamId: s.workspace.stream.id, source: 'created' });
  const terminalStore = new ProviderTurnTerminalStore({ dataDir: s.root });
  const terminal = new TerminalTurnCommitService({ store: terminalStore });
  for (const c of completions) await terminal.commit(c);
  const realUsage = createWorkLogUsageStore({ ledgerFile: path.join(s.root, 'retired.json'),
    databaseFile: s.databaseFile, defaultProjectRoot: s.root, usageSyncStore: s.worker,
    usageSyncDeviceId: 'local', usageSyncRuntimeHomeIds: { codex: 'fixture' },
    workspaceCatalogStore: s.catalog, repositoryFactory: options => new WorkLogUsageRepository(options) });
  const journal = new RunJournalService({ usageStore: realUsage, defaultProjectRoot: s.root,
    projectionProjectRoots: [s.root], findProject: root => ({ path: root }) });
  let releaseSave, reachedSave, ready = 0;
  const saved = new Promise(resolve => { releaseSave = resolve; });
  const saving = new Promise(resolve => { reachedSave = resolve; });
  const service = new TurnEndDeliveryService({ terminalCommits: terminal,
    notifications: { values: () => [], markDelivered() {} }, taskRuns: { forEvent: () => null },
    persistHistory: async () => {}, projectTurn: (...args) => journal.projectTurn(...args),
    ensureTurnUsageFact: (...args) => journal.ensureTurnUsageFact(...args),
    readTurnProjection: (...args) => journal.turnProjectionStatus(...args),
    flushTurnProjections: (...args) => journal.flushTurnProjections(...args),
    rememberLastMessage() {}, rememberSeenTurn() {},
    saveState: async () => { reachedSave(); await saved; }, logger: { error() {} } });
  const noop = async () => {};
  const health = createRuntimeHealth();
  health.setDiagnosticSource('fixture', () => ({ synthetic: true }));
  const startup = new AgentHubStartupCoordinator({ telegramEnabled: false,
    health, startMiniApp: noop, startDesktopControl: noop,
    startRuntimeCommand: noop, startHubMcp: noop, sanitizeRollouts: noop,
    initializeProvider: noop, providerIsRunning: () => false, recoverRuns: noop,
    retryTerminalProjections: () => service.retryPendingProjections({ recoverProjecting: true }),
    retryNotifications: noop, restoreBackgroundJobs: noop, startTimers: noop,
    hasPendingRestart: () => false, markReady: () => { ready++; }, readyMessage: () => 'ready',
    waitForever: noop, log() {}, logError() {} });
  const start = startup.start();
  try {
    await Promise.race([saving, start.then(() => {
      throw new Error('startup completed before its terminal persistence fence');
    })]);
    assert.equal(ready, 0);
    assert.ok((await terminal.pendingProjections()).length > 0);
    releaseSave(); await start;
    assert.equal(ready, 1);
    assert.deepEqual(await terminal.pendingProjections(), []);
    for (const c of completions) assert.equal((await journal.turnProjectionStatus(c)).current, true);
  } finally {
    releaseSave(); await start; await startup.waitForBackgroundWork();
    await realUsage.close();
  }
});
