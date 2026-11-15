import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeTranscriptHistory, codexThreadHistory, mergeActiveTaskHistory, mergeCompletedTaskHistory } from '../../src/application/task-history.mjs';
import { parseClaudeTranscript } from '../../src/providers/claude/claude-session-reader.mjs';
import { startCodexAgentMessage, appendCodexAgentMessageDelta, hydrateCodexAgentMessages } from '../../src/providers/codex/codex-agent-message-reducer.mjs';
import { TurnEndNotificationRegistry } from '../../src/application/turn-end-notifications.mjs';
import { ManagedRunHistoryService } from '../../src/application/managed-run-history-service.mjs';

const raw=':agent-annotation{index="1"} Answer :codex-annotation{index="1"} continued\n`literal :agent-annotation{index="2"}`';
const refs=[{index:1,position:{start:0,end:8}}];
const user='User literal :agent-annotation{index="2"} and :codex-annotation{index="3"}';
export function annotationTranscript(answer=raw,prompt=user) {
  return [
    {type:'user',uuid:'user-1',message:{role:'user',content:prompt}},
    {type:'assistant',uuid:'agent-1',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:answer}]}}
  ].map(JSON.stringify).join('\n');
}
function assertAnswer(value) {
  assert.match(value,/Цитата 1/u); assert.match(value,/Answer .*continued/u);
  assert.ok(value.includes('`literal :agent-annotation{index="2"}`'));
  assert.equal((value.match(/Цитата 1/gu)??[]).length,1);
}

test('generic annotations project Claude observed transcript and preserve literal users and annotation inputs',()=>{
  const snapshot=parseClaudeTranscript(annotationTranscript()); assertAnswer(snapshot.answer);
  assert.deepEqual(snapshot.responseAnnotationReferences,refs);
  const history=claudeTranscriptHistory(annotationTranscript());
  assert.equal(history[0].messages[0].text,user);
  assertAnswer(history[0].answer); assertAnswer(history[0].messages[1].text);
  assert.deepEqual(history[0].messages[1].responseAnnotationReferences,refs);
  const prompt='<response-annotations>\n'+JSON.stringify([{text:'Quoted original',annotation:'Comment'}])+'\n</response-annotations>\n\n## My request:\nCheck';
  const annotated=claudeTranscriptHistory(annotationTranscript(raw,prompt))[0];
  assert.deepEqual(annotated.messages[0].responseAnnotations,[{text:'Quoted original',annotation:'Comment'}]);
  assert.equal(annotated.messages[0].responseAnnotationRequest,'Check');
});

test('generic annotations keep Codex live partial replay and hydrate tied to the original item',()=>{
  const run={};
  startCodexAgentMessage(run,{turnId:'turn-1',item:{id:'agent-1',type:'agentMessage',text:''}});
  appendCodexAgentMessageDelta(run,{turnId:'turn-1',itemId:'agent-1',delta:':agent-annotation{index="'});
  assert.equal(run.responseText,'');
  appendCodexAgentMessageDelta(run,{turnId:'turn-1',itemId:'agent-1',delta:'1"} Answer '});
  appendCodexAgentMessageDelta(run,{turnId:'turn-1',itemId:'agent-1',delta:'Answer :codex-annotation{index="1"} continued',hydrationReplay:true});
  assert.equal(run.responseItemId,'agent-1'); assert.deepEqual(run.responseAnnotationReferences,refs);
  assert.equal((run.responseText.match(/Answer/gu)??[]).length,1);
  hydrateCodexAgentMessages(run,[{id:'agent-1',type:'agentMessage',text:raw}],{turnId:'turn-1'});
  assertAnswer(run.responseText); assert.deepEqual(run.responseAnnotationReferences,refs);
  const history=codexThreadHistory([{id:'turn-1',status:'completed',items:[{id:'user-1',type:'userMessage',content:[{type:'text',text:user}]},{id:'agent-1',type:'agentMessage',text:raw}]}]);
  assert.equal(history[0].messages[0].text,user); assertAnswer(history[0].answer);
});

test('generic annotations survive shared history persistence completion notification and reopen for both providers',async()=>{
  for(const provider of ['codex','claude']) {
    const run={id:'run-1',provider,threadId:'thread-1',turnId:'turn-1',responseItemId:'agent-1',responseText:raw,
      promptPreview:user,userMessages:[{role:'user',itemId:'user-1',text:user}],responseAnnotationReferences:refs};
    const history=[]; let saved; let writes=0;
    const store={history:()=>history,recordHistory:async(_run,value,snapshot)=>{saved=structuredClone({value,snapshot});},save:async()=>{writes++;}};
    const service=new ManagedRunHistoryService({taskSyncStore:store,mergeActiveHistory:mergeActiveTaskHistory,hubExecutionOwner:'hub',nowIso:()=>new Date(0).toISOString(),nowMs:()=>0});
    await service.persist(run,{active:false,status:'completed'});
    assert.equal(writes,1); assertAnswer(saved.value[0].answer); assertAnswer(saved.snapshot.answer);
    assert.deepEqual(saved.value[0].messages.find(m=>m.role==='agent').responseAnnotationReferences,refs);
    assert.equal(saved.value[0].messages.find(m=>m.role==='user').text,user); assert.equal(run.responseText,raw);
    const completed=mergeCompletedTaskHistory([], {turnId:'turn-1',answer:raw,responseAnnotationReferences:[{index:1},{index:1}]});
    assertAnswer(completed[0].answer); assert.deepEqual(completed[0].messages[0].responseAnnotationReferences,refs);
    const registry=new TurnEndNotificationRegistry();
    const identity={provider,threadId:'thread-1',turnId:'turn-1',projectRoot:process.cwd()};
    const notification=registry.registerMessage({...identity,text:raw}); assertAnswer(notification.text);
    registry.recordCompletion({...identity,finalAnswer:raw,prompt:user,responseAnnotationReferences:[{index:1},{index:1}]});
    const reopened=new TurnEndNotificationRegistry(registry.snapshot()).get(identity);
    assertAnswer(reopened.finalAnswer); assert.deepEqual(reopened.responseAnnotationReferences,refs); assert.equal(reopened.prompt,user);
  }
});
