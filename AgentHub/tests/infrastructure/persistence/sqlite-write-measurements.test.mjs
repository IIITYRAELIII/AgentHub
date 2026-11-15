import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {JournalDatabase} from '../../../src/infrastructure/persistence/journal-database.mjs';
import {AsyncSqliteMutationQueue} from '../../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs';
import {WorkLogUsageSyncWorkerStore} from '../../../src/runtime/work-log-usage-sync-worker-client.mjs';
import {CommandTraceService} from '../../../src/application/command-trace-service.mjs';
import {CommandTraceSpanStore} from '../../../src/infrastructure/persistence/command-trace-span-store.mjs';
import {CommandTraceWorkerStore} from '../../../src/infrastructure/persistence/command-trace-worker-store.mjs';
import {TaskBoardStore} from '../../../src/infrastructure/persistence/task-board-store.mjs';
import {WorkspaceCatalogStore} from '../../../src/infrastructure/persistence/workspace-catalog-store.mjs';
import {withTaskOperationTiming} from '../../../src/infrastructure/process/task-operation-timing.mjs';

async function fixture(run) {
  const root=await mkdtemp(path.join(os.tmpdir(),'hub408-sqlite-measure-'));
  const file=path.join(root,'journal.sqlite');
  const journal=new JournalDatabase(file);
  let observer;
  try {
    await journal.currentRevision();
    observer=new DatabaseSync(file);
    observer.exec('PRAGMA busy_timeout=0');
    await run({root,file,journal,observer});
  } finally {
    if(observer?.isTransaction)observer.exec('ROLLBACK');
    observer?.close();journal.close();
    await rm(root,{recursive:true,force:true});
  }
}
const record={provider:'codex',threadId:'thread',turnId:'turn',taskTitle:'Private title',body:'Private body'};
function measurements(sample) {
  assert.equal(sample.operation,'journal-record-upsert');
  assert.equal(sample.rows,1);
  for(const k of ['rowPreparationMs','beginMs','transactionMs','finishedAtMs'])
    assert.ok(Number.isFinite(sample[k])&&sample[k]>=0,k);
  assert.equal(JSON.stringify(sample).includes('Private'),false);
  assert.equal(JSON.stringify(sample).includes('INSERT'),false);
}

test('journal write measurements run after releasing its actual SQLite transaction',async()=>fixture(async({journal,observer,root})=>{
  const samples=[];
  let notificationAtMs;
  journal.onChange(()=>{
    notificationAtMs=Date.now();
    // Delayed notification is outside the released write transaction.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  });
  const result=await journal.upsertRecords([{...record,projectRoot:root}],{
    recordMutationTiming:sample=>{
      measurements(sample);
      assert.ok(sample.lockReleasedAtMs<=notificationAtMs);
      assert.ok(sample.finishedAtMs>sample.lockReleasedAtMs);
      observer.exec('BEGIN IMMEDIATE');observer.exec('ROLLBACK');
      samples.push(sample);
      throw new Error('diagnostic sink failed');
    },
  });
  assert.equal(result.upserted,1);
  assert.equal(samples.length,1,'a completed write must expose the lock-held interval separately from row preparation');
  assert.equal(samples[0].outcome,'committed');
  assert.ok(samples[0].lockAcquiredAtMs>0);
  assert.ok(samples[0].finishedAtMs>=samples[0].lockAcquiredAtMs);
  assert.equal((await journal.getRecord(record)).body,record.body);
}));

test('a refused BEGIN and CAS rollback retain measured outcomes and canonical data',async()=>fixture(async({journal,observer,root})=>{
  const first=await journal.upsertRecords([{...record,projectRoot:root}]);
  const samples=[];
  observer.exec('BEGIN IMMEDIATE');
  let original;
  try {
    await journal.upsertRecords([{...record,projectRoot:root,body:'Uncommitted replacement'}],{
      recordMutationTiming:sample=>{samples.push(sample);throw new Error('sink must not replace SQLite error');},
    });
  } catch(error) { original=error; }
  finally {observer.exec('ROLLBACK');}
  assert.equal(original?.code,'ERR_SQLITE_ERROR');
  assert.match(original.message,/database is locked/);
  assert.equal(samples.length,1);
  measurements(samples[0]);
  assert.equal(samples[0].outcome,'begin-refused');
  assert.equal(samples[0].lockAcquiredAtMs,null);
  assert.equal(samples[0].lockReleasedAtMs,null);
  assert.equal((await journal.getRecord(record)).body,record.body);
  await assert.rejects(journal.upsertRecords([{...record,projectRoot:root,body:'Stale replacement'}],{
    expectedRevision:first.revision-1,
    recordMutationTiming:sample=>{
      observer.exec('BEGIN IMMEDIATE');observer.exec('ROLLBACK');samples.push(sample);
    },
  }),{code:'JOURNAL_REVISION_CONFLICT'});
  assert.equal(samples.length,2);
  assert.equal(samples[1].outcome,'rolled-back');
  assert.ok(samples[1].lockAcquiredAtMs>0);
  assert.ok(samples[1].lockReleasedAtMs>=samples[1].lockAcquiredAtMs);
  assert.equal(await journal.currentRevision(),first.revision);
  assert.equal((await journal.getRecord(record)).body,record.body);
}));

test('real worker failure retains scalar SQLite stages in the existing reopened trace store',async()=>fixture(async({journal,observer,root,file})=>{
  const traceFile=path.join(root,'command-traces.sqlite');
  const traceStore=new CommandTraceWorkerStore({databaseFile:traceFile});
  const traceService=new CommandTraceService({store:traceStore});
  const worker=new WorkLogUsageSyncWorkerStore({databaseFile:file});
  let commandId;let reopened;
  try {
    await journal.upsertRecords([{...record,projectRoot:root}]);
    const request={projectRoot:root,defaultProjectRoot:root,titles:[{provider:'codex',threadId:'thread',taskTitle:record.taskTitle}]};
    await worker.synchronizeTaskTitles(request);
    worker.setTraceService({startBestEffortSpan:input=>{
      if(input.metadata.action==='synchronize-task-titles')commandId=input.commandId;
      return traceService.startBestEffortSpan(input);
    }});
    observer.exec('BEGIN IMMEDIATE');
    try {await assert.rejects(worker.synchronizeTaskTitles({...request,titles:[{...request.titles[0],taskTitle:'Replacement title'}]}),{code:'ERR_SQLITE_ERROR'});}
    finally {observer.exec('ROLLBACK');}
    await worker.close();
    await traceStore.close();
    reopened=new CommandTraceSpanStore({databaseFile:traceFile});
    const timeline=await reopened.readCommandTimeline(commandId);
    const failed=timeline.find(x=>x.outcome==='failed');
    assert.ok(failed,'failure trace must survive store reopen');
    assert.ok(timeline.some(x=>x.outcome==='started'));
    const m=failed.metadata;
    assert.ok(m.sqlWriteAttempts>=1);
    assert.ok(m.sqlRetries>=1);
    assert.equal(m.sqlExhausted,1);
    assert.equal(m.sqliteErrorCode,'ERR_SQLITE_ERROR');
    assert.ok(m.sqlBeginRefused>=1);
    assert.equal(m.sqlTransactionCount,0);
    assert.equal(m.sqlFirstLockAtMs,0);
    assert.ok(m.workerProcessId>0&&m.workerThreadId>0);
    assert.ok(m.sqlQueueWaitMs>=0&&m.sqlExecutionMs>=0);
    assert.equal(JSON.stringify(timeline).includes(record.body),false);
    assert.equal(JSON.stringify(timeline).includes(record.taskTitle),false);
    assert.equal(JSON.stringify(timeline).includes(root),false);
    assert.equal((await journal.getRecord(record)).taskTitle,record.taskTitle);
  } finally {
    await worker.close();await traceStore.close();await reopened?.close();
  }
}));

test('lifecycle SQL queue timing retains its original operation identity and refusal',async()=>fixture(async({root,file,observer})=>{
  const catalog=new WorkspaceCatalogStore({databaseFile:file});
  await catalog.load();
  const tasks=new TaskBoardStore({databaseFile:file});
  const events=[];let rejected;
  try {
    observer.exec('BEGIN IMMEDIATE');
    try {
      await withTaskOperationTiming({operationId:'original-lifecycle-operation',taskId:'task',record:event=>events.push(event)},()=>
        tasks.runMutation(()=>tasks.failLifecycleTransition('missing-transition',new Error('Private failure')),
          {method:'failLifecycleTransition',timeoutMs:25}));
    } catch(error){rejected=error;}
    finally {observer.exec('ROLLBACK');}
    assert.equal(rejected?.code,'ERR_SQLITE_ERROR');
    const measurement=events.find(x=>x.stage==='sqlite-mutation');
    assert.equal(measurement.operationId,'original-lifecycle-operation');
    assert.equal(measurement.store,'task-board');
    assert.equal(measurement.method,'failLifecycleTransition');
    assert.equal(measurement.errorCode,'ERR_SQLITE_ERROR');
    assert.equal(measurement.exhausted,true);
    assert.ok(measurement.retries>=1);
    assert.equal(JSON.stringify(events).includes('Private failure'),false);
    assert.equal(JSON.stringify(events).includes(root),false);
    assert.equal(await tasks.runMutation(()=>tasks.failLifecycleTransition('missing-transition',new Error('still missing')),
      {method:'failLifecycleTransition'}),false);
  } finally {tasks.close();catalog.close();}
}));

test('contention measurements preserve the exact last SQLite error and release the local queue',async()=>fixture(async({journal,observer,root})=>{
  const queue=new AsyncSqliteMutationQueue();
  const samples=[];const errors=[];
  observer.exec('BEGIN IMMEDIATE');
  let thrown;
  try {
    await queue.run(async()=>{
      try {return await journal.upsertRecords([{...record,projectRoot:root}]);}
      catch(error){errors.push(error);throw error;}
    },{timeoutMs:25,requestId:'original-measurement-id',recordMutationTiming:sample=>{
      samples.push(sample);throw new Error('sink failed');
    }});
  } catch(error){thrown=error;}
  finally {observer.exec('ROLLBACK');}
  assert.equal(thrown,errors.at(-1));
  assert.equal(thrown.requestId,'original-measurement-id');
  assert.equal(samples.length,1,'one bounded summary per queued write, including exhaustion');
  assert.equal(samples[0].outcome,'failed');
  assert.equal(samples[0].errorCode,'ERR_SQLITE_ERROR');
  assert.equal(samples[0].exhausted,true);
  assert.ok(samples[0].retries>=1);
  assert.ok(samples[0].queueWaitMs>=0);
  assert.ok(samples[0].executionMs>=0);
  assert.equal(JSON.stringify(samples).includes('Private'),false);
  assert.equal(JSON.stringify(samples).includes(root),false);
  assert.equal((await queue.run(()=>journal.upsertRecords([{...record,projectRoot:root}]))).upserted,1);
  assert.equal(queue.diagnostics().queued,0);
}));
