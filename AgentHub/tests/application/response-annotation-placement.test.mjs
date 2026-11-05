import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexAssistantResponseProjection as project } from '../../src/domain/codex-response-annotation.mjs';
import { claudeTranscriptHistory, codexThreadHistory, mergeCompletedTaskHistory } from '../../src/application/task-history.mjs';
import { LocalTaskSyncStore } from '../../src/infrastructure/persistence/task-sync-store.mjs';
import { TurnEndNotificationRegistry } from '../../src/application/turn-end-notifications.mjs';

test('annotation positions survive actual provider history SQLite reopen and terminal notification',async()=>{
  const raw='Git 🦊 :agent-annotation{index="2"}\n\nDependencies :codex-annotation{index="1"}\n\nCleanup :agent-annotation{index="3"}\n\nMedia :codex-annotation{index="4"}';
  const expected=project(raw);
  const dir=await mkdtemp(path.join(os.tmpdir(),'annotation-positions-'));
  let store;
  try {
    const filePath=path.join(dir,'sync.json');
    store=new LocalTaskSyncStore({filePath}); await store.load();
    for(const provider of ['codex','claude']) {
      const history=provider==='codex'?codexThreadHistory([{id:'turn',status:'completed',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'User :agent-annotation{index="4"}'}]},{id:'answer',type:'agentMessage',text:raw}]}]):claudeTranscriptHistory([
        {type:'user',uuid:'user',message:{role:'user',content:'User :agent-annotation{index="4"}'}},
        {type:'assistant',uuid:'answer',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:raw}]}}
      ].map(JSON.stringify).join('\n'));
      const task={provider,threadId:'thread-'+provider,projectRoot:process.cwd()};
      const message=history[0].messages.find(m=>m.role==='agent');
      assert.deepEqual(message.responseAnnotationReferences,expected.responseAnnotationReferences);
      assert.equal(history[0].messages[0].text,'User :agent-annotation{index="4"}');
      await store.recordHistory(task,history); await store.save();
      const registry=new TurnEndNotificationRegistry();
      const identity={...task,turnId:history[0].id};
      registry.recordCompletion({...identity,finalAnswer:message.text,responseAnnotationReferences:message.responseAnnotationReferences});
      const terminal=new TurnEndNotificationRegistry(registry.snapshot()).get(identity);
      assert.deepEqual(terminal.responseAnnotationReferences,expected.responseAnnotationReferences);
      assert.deepEqual(mergeCompletedTaskHistory([],{turnId:history[0].id,answer:terminal.finalAnswer,responseAnnotationReferences:terminal.responseAnnotationReferences})[0].messages[0].responseAnnotationReferences,expected.responseAnnotationReferences);
    }
    store.close(); store=new LocalTaskSyncStore({filePath}); await store.load();
    for(const provider of ['codex','claude']) {
      const restored=store.history({provider,threadId:'thread-'+provider,projectRoot:process.cwd()})[0];
      const message=restored.messages.find(m=>m.role==='agent');
      assert.deepEqual(message.responseAnnotationReferences,expected.responseAnnotationReferences);
      assert.equal(message.text,expected.text);
    }
  } finally {store?.close();await rm(dir,{recursive:true,force:true});}
});
