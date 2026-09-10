import assert from 'node:assert/strict';
import test from 'node:test';
import {codexAssistantResponseProjection as project} from '../../src/domain/codex-response-annotation.mjs';

test('inline provider annotation becomes a reference without losing surrounding prose',()=>{
  const result=project('Зафиксировал: **историю перенести**. :codex-annotation{index="1"}\nСледующий абзац.');
  assert.deepEqual(result.responseAnnotationReferences,[{index:1}]);
  assert.equal(result.text,'Зафиксировал: **историю перенести**. \nЦитата 1\nСледующий абзац.');
});
test('split inline marker stays hidden until complete and duplicate references collapse',()=>{
  assert.equal(project('Ответ. :codex-annotation{index="').text,'Ответ. ');
  const result=project('Ответ. :codex-annotation{index="2"} Дальше :codex-annotation{index="2"} конец');
  assert.deepEqual(result.responseAnnotationReferences,[{index:2}]);
  assert.doesNotMatch(result.text,/:codex-annotation/);
  assert.match(result.text,/Дальше .*конец/);
});
test('inline code, fenced code and multiline code spans retain literal markers',()=>{
  for(const text of ['Пример `:codex-annotation{index="1"}`.', '``text\n:codex-annotation{index="1"}\ntext``', '```text\n:codex-annotation{index="1"}\n```']) assert.deepEqual(project(text),{text,responseAnnotationReferences:[]});
});
test('invalid inline indices are readable but never gain an interactive identity',()=>{
  const result=project('До :codex-annotation{index="abc"} после');
  assert.deepEqual(result.responseAnnotationReferences,[]);
  assert.equal(result.text,'До \nЦитата\nпосле');
});

test('line-start marker tails retain additional references and code boundaries',()=>{
  const marker = ':codex-annotation{index="1"}';
  const second = ':codex-annotation{index="2"}';
  assert.deepEqual(project(`${marker} Later ${second}`).responseAnnotationReferences,[{index:1},{index:2}]);
  assert.doesNotMatch(project(`${marker} Later :codex-annotation{index="`).text,/:codex/);
  for(const prefix of ['',`${marker}\n`]) {
    const result=project(`${prefix}${marker} \`literal\n${second}\nend\``);
    assert.deepEqual(result.responseAnnotationReferences,[{index:1}]);
    assert.ok(result.text.includes(second));
  }
});

test('escaped and unmatched backticks do not hide ordinary annotation markers',()=>{
  const marker = ':codex-annotation{index="1"}';
  for(const text of [`Example \\\`outside ${marker}`, `A \`unclosed\n\n${marker}`, `A \`unclosed ${marker}`]) {
    assert.deepEqual(project(text).responseAnnotationReferences,[{index:1}]);
  }
  const literal = `A \`inside \\\` ${marker}`;
  assert.deepEqual(project(literal).responseAnnotationReferences,[{index:1}]);
  const escapedFirstTick = '\\``' + marker + '`';
  assert.deepEqual(project(escapedFirstTick),{text:escapedFirstTick,responseAnnotationReferences:[]});
  for(const text of ['\\'+marker,'\\:codex-annotation{index="']) {
    assert.deepEqual(project(text),{text,responseAnnotationReferences:[]});
  }
});
