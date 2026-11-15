import assert from 'node:assert/strict';
import test from 'node:test';
import {codexAssistantResponseProjection as project} from '../../src/domain/codex-response-annotation.mjs';

function references(result) {
  const text=result.text.replace(/\r\n?/gu,'\n').trim();
  for(const ref of result.responseAnnotationReferences) {
    assert.ok(ref.position);
    assert.equal(text.slice(ref.position.start,ref.position.end),`Цитата ${ref.index}`);
  }
  return result.responseAnnotationReferences.map(({index})=>({index}));
}

test('generic annotation aliases share indices and streamed boundaries with legacy markers',()=>{
  for(const alias of ['agent','codex']) {
    const marker=`:${alias}-annotation{index="2"}`;
    for(const prefix of [':'+alias, ':'+alias+'-annotation{', ':'+alias+'-annotation{index="2']) {
      assert.deepEqual(project('Answer '+prefix),{text:'Answer ',responseAnnotationReferences:[]});
    }
    for(const text of ['`'+marker+'`','```text\n'+marker+'\n```','\\'+marker,'``multi\n'+marker+'\nline``']) {
      assert.deepEqual(project(text),{text,responseAnnotationReferences:[]});
    }
    for(const index of ['0','21','-1','1.5','9007199254740993','abc']) {
      assert.deepEqual(project(`:${alias}-annotation{index="${index}"}`),{text:'Цитата',responseAnnotationReferences:[]});
    }
  }
  const result=project(':agent-annotation{index="1"} First :codex-annotation{index="1"} same\n:codex-annotation{index="2"} Second :agent-annotation{index="2"} same');
  assert.deepEqual(references(result),[{index:1},{index:2}]);
  assert.equal((result.text.match(/Цитата /gu)??[]).length,2);
  assert.doesNotMatch(result.text,/:agent|:codex/u);
  assert.match(result.text,/First.*same/u);
});

test('inline provider annotation becomes a reference without losing surrounding prose',()=>{
  const result=project('Зафиксировал: **историю перенести**. :codex-annotation{index="1"}\nСледующий абзац.');
  assert.deepEqual(references(result),[{index:1}]);
  assert.equal(result.text,'Зафиксировал: **историю перенести**. \nЦитата 1\nСледующий абзац.');
});
test('split inline marker stays hidden until complete and duplicate references collapse',()=>{
  assert.equal(project('Ответ. :codex-annotation{index="').text,'Ответ. ');
  const result=project('Ответ. :codex-annotation{index="2"} Дальше :codex-annotation{index="2"} конец');
  assert.deepEqual(references(result),[{index:2}]);
  assert.doesNotMatch(result.text,/:codex-annotation/);
  assert.match(result.text,/Дальше .*конец/);
});
test('inline code, fenced code and multiline code spans retain literal markers',()=>{
  for(const text of ['Пример `:codex-annotation{index="1"}`.', '``text\n:codex-annotation{index="1"}\ntext``', '```text\n:codex-annotation{index="1"}\n```']) assert.deepEqual(project(text),{text,responseAnnotationReferences:[]});
});
test('invalid inline indices are readable but never gain an interactive identity',()=>{
  const result=project('До :codex-annotation{index="abc"} после');
  assert.deepEqual(references(result),[]);
  assert.equal(result.text,'До \nЦитата\nпосле');
});

test('line-start marker tails retain additional references and code boundaries',()=>{
  const marker = ':codex-annotation{index="1"}';
  const second = ':codex-annotation{index="2"}';
  assert.deepEqual(references(project(`${marker} Later ${second}`)),[{index:1},{index:2}]);
  assert.doesNotMatch(project(`${marker} Later :codex-annotation{index="`).text,/:codex/);
  for(const prefix of ['',`${marker}\n`]) {
    const result=project(`${prefix}${marker} \`literal\n${second}\nend\``);
    assert.deepEqual(references(result),[{index:1}]);
    assert.ok(result.text.includes(second));
  }
});

test('escaped and unmatched backticks do not hide ordinary annotation markers',()=>{
  const marker = ':codex-annotation{index="1"}';
  for(const text of [`Example \\\`outside ${marker}`, `A \`unclosed\n\n${marker}`, `A \`unclosed ${marker}`]) {
    assert.deepEqual(references(project(text)),[{index:1}]);
  }
  const literal = `A \`inside \\\` ${marker}`;
  assert.deepEqual(references(project(literal)),[{index:1}]);
  const escapedFirstTick = '\\``' + marker + '`';
  assert.deepEqual(project(escapedFirstTick),{text:escapedFirstTick,responseAnnotationReferences:[]});
  for(const text of ['\\'+marker,'\\:codex-annotation{index="']) {
    assert.deepEqual(project(text),{text,responseAnnotationReferences:[]});
  }
});
