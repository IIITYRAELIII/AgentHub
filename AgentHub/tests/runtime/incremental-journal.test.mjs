import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JournalDatabase } from '../../src/infrastructure/persistence/journal-database.mjs';
import { WorkLogUsageSyncWorkerStore } from '../../src/runtime/work-log-usage-sync-worker-client.mjs';
import { projectWorkLogUsage, normalizePersistedWorkLog } from '../../src/application/work-log-usage-projection.mjs';
import { buildLazyJournalPayload } from '../../src/application/journal-projection-data.mjs';

test('incremental days match full projection after correction, move, delete, restart and conflict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'ah-incremental-'));
  const databaseFile = path.join(root,'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  let worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  const options = { projectRoots:[root], defaultProjectRoot:root, now:Date.parse('2026-09-29T12:00:00Z'), includeClaudeUsage:true };
  const records = Array.from({length:30}, (_,i)=>({ provider:'codex',threadId:`thread-${i}`,turnId:`turn-${i}`,
    projectRoot:root, completedAt:new Date(Date.UTC(2026,8,i+1,12)).toISOString(),
    startedAt:new Date(Date.UTC(2026,8,i+1,11)).toISOString(), body:`answer-${i}`, prompt:`prompt-${i}`,
    estimatedCredits:i+1, usageReported:true }));
  const parity = async () => {
    const expected=buildLazyJournalPayload(projectWorkLogUsage('# Глобальный журнал работ\n',
      normalizePersistedWorkLog(await journal.loadLedger(),{defaultProjectRoot:root}).ledger.turns,
      {...options, accountCatalog:await journal.accountCatalog(), syncedUsageEvents:await worker.facts()}));
    const actual=await journal.snapshot();
    assert.equal(actual.html,expected.html);
    assert.deepEqual(actual.days,expected.days);
    assert.deepEqual(actual.turns,expected.turns);
    assert.deepEqual(actual.summary,expected.summary);
  };
  try {
    await journal.upsertRecords(records);
    assert.equal((await worker.projectJournal(options)).recordCount,30);
    await parity();
    const original=await journal.snapshot();
    await journal.upsertRecords([{...records[2],body:'corrected',estimatedCredits:80}]);
    const changed=await worker.projectJournal(options);
    assert.equal(changed.recordCount,1);
    assert.equal(changed.projectionMode,'days');
    assert.equal(changed.accountingRecordsRead,1);
    assert.equal(changed.changedDayCount,1);
    assert.equal((await journal.snapshot()).days['10.09.2026'],original.days['10.09.2026']);
    await parity();
    const moved={...records[2],completedAt:records[3].completedAt,body:'moved'};
    await journal.upsertRecords([moved]);
    await worker.close();
    worker=new WorkLogUsageSyncWorkerStore({databaseFile});
    const movedResult=await worker.projectJournal(options);
    assert.equal(movedResult.projectionMode,'days');
    assert.equal(movedResult.changedDayCount,2);
    await parity();
    await journal.deleteRecords([records[3]]);
    await worker.projectJournal(options);
    await parity();
    const revision=await journal.currentRevision();
    const oldVersion=(await journal.snapshot()).version;
    await journal.upsertRecords([{...records[0],body:'latest'}]);
    assert.equal((await worker.projectJournal({...options,expectedRevision:revision})).conflict,true);
    assert.ok((await journal.projectionInput()).dirtyDates.length);
    await worker.projectJournal(options);
    assert.notEqual((await journal.snapshot()).version,oldVersion);
    await parity();
    assert.equal((await journal.projectionInput()).dirtyDates.length,0);
  } finally { await worker.close(); journal.close(); await rm(root,{recursive:true,force:true}); }
});

test('compact accounting preserves nonempty legacy compactions and prompt-based image estimates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ah-accounting-parity-'));
  const databaseFile = path.join(root, 'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  const at = '2026-09-01T12:00:00Z';
  const rows = [
    { turnId:'auto-compact-content', body:'Retained result', status:'aborted', usageReported:false },
    { turnId:'auto-compact-tools', changedFiles:['file.mjs'], status:'aborted', usageReported:false },
    { turnId:'auto-compact-empty', status:'aborted', usageReported:false },
    { turnId:'image', prompt:'generate an image', status:'completed', usageReported:false },
  ].map(row => ({provider:'codex',threadId:'legacy',projectRoot:root,completedAt:at,...row}));
  const options = {projectRoots:[root], now:Date.parse('2026-09-29T12:00:00Z')};
  try {
    await journal.upsertRecords(rows);
    await worker.projectJournal(options);
    await journal.upsertRecords([{...rows[0],body:'Corrected legacy result'}]);
    const delta = await worker.projectJournal(options);
    assert.equal(delta.accountingRecordsRead,1);
    const actual = await journal.snapshot();
    const expected = buildLazyJournalPayload(projectWorkLogUsage('# Глобальный журнал работ\n',
      normalizePersistedWorkLog(await journal.loadLedger()).ledger.turns, options));
    assert.equal(actual.html,expected.html);
    assert.deepEqual(actual.summary,expected.summary);
    assert.deepEqual(actual.turns,expected.turns);
    await worker.importSnapshot({events:[{
      deviceId:'remote',provider:'codex',threadId:'remote-thread',turnId:'remote-turn',
      completedAt:at,estimatedCredits:12,
    }]});
    const remote = await worker.projectJournal(options);
    assert.equal(remote.recordCount,0);
    assert.equal(remote.accountingRecordsRead,0);
    const remoteSnapshot = await journal.snapshot();
    const remoteExpected = buildLazyJournalPayload(projectWorkLogUsage('# Глобальный журнал работ\n',
      normalizePersistedWorkLog(await journal.loadLedger()).ledger.turns,
      {...options,syncedUsageEvents:await worker.facts()}));
    assert.equal(remoteSnapshot.html,remoteExpected.html);
    assert.deepEqual(remoteSnapshot.days,actual.days);
  } finally {await worker.close();journal.close();await rm(root,{recursive:true,force:true});}
});

test('scope changes and existing workspace rebindings rebuild once with canonical open day', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ah-journal-scope-'));
  const other = path.join(root,'other');
  const databaseFile = path.join(root,'journal.sqlite');
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({databaseFile});
  const rows = [
    {provider:'codex',threadId:'one',turnId:'one',projectRoot:root,completedAt:'2026-09-01T12:00:00Z',body:'One'},
    {provider:'claude',threadId:'two',turnId:'two',projectRoot:other,completedAt:'2026-09-02T12:00:00Z',body:'Two'},
  ];
  let binding = {workspaceId:'workspace',workspaceName:'Before',streamId:'stream',streamName:'Stream'};
  const options = {projectRoots:[root],includeClaudeUsage:true,now:Date.parse('2026-09-29T12:00:00Z')};
  const resolver = {workspaceResolver:()=>binding};
  const parity = async roots => {
    const all = normalizePersistedWorkLog(await journal.loadLedger()).ledger.turns;
    const selected = Object.fromEntries(Object.entries(all).filter(([,row])=>roots.includes(row.projectRoot)));
    const expected = buildLazyJournalPayload(projectWorkLogUsage('# Глобальный журнал работ\n',selected,
      {...options,workspaceResolver:()=>binding}));
    const actual = await journal.snapshot();
    assert.equal(actual.html,expected.html);
    assert.deepEqual(actual.summary,expected.summary);
    assert.deepEqual(actual.days,expected.days);
  };
  try {
    await journal.upsertRecords(rows);
    await worker.projectJournal(options,resolver);
    await parity([root]);
    await journal.upsertRecords([{...rows[1],body:'Other scope correction'}]);
    assert.equal((await worker.projectJournal(options,resolver)).recordCount,0);
    await parity([root]);
    binding = {...binding,workspaceName:'After'};
    assert.equal((await worker.projectJournal(options,resolver)).projectionMode,'full');
    await parity([root]);
    assert.equal((await worker.projectJournal({...options,projectRoots:[root,other]},resolver)).projectionMode,'full');
    await parity([root,other]);
    assert.equal((await worker.projectJournal({...options,projectRoots:[root,other]},resolver)).reason,'unchanged');
  } finally {await worker.close();journal.close();await rm(root,{recursive:true,force:true});}
});
