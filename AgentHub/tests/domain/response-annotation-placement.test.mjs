import assert from 'node:assert/strict';
import test from 'node:test';
import { codexAssistantResponseProjection as project } from '../../src/domain/codex-response-annotation.mjs';

export const fourAnswers = '# Зачем нужна история Git\n\nИстория Git сохраняет изменения. 🦊 :agent-annotation{index="2"}\n\nЗависимости можно переиспользовать. :codex-annotation{index="1"}\n\nВременные копии удаляются после проверки. :agent-annotation{index="3"}\n\nМедиа принадлежит открытой задаче. :codex-annotation{index="4"}';

test('annotation positions preserve exact nonsorted marker coordinates across aliases and reprojection', () => {
  for (const raw of [fourAnswers, '  \r\n'+fourAnswers.replaceAll('\n','\r\n')+'\r\n ']) {
    const result=project(raw);
    const canonical=result.text.replace(/\r\n?/gu,'\n').trim();
    assert.deepEqual(result.responseAnnotationReferences.map(r=>r.index),[2,1,3,4]);
    let previous=-1;
    for(const ref of result.responseAnnotationReferences) {
      assert.ok(ref.position,'a marker must carry its owning parser position');
      assert.equal(canonical.slice(ref.position.start,ref.position.end),`Цитата ${ref.index}`);
      assert.ok(ref.position.start>previous); previous=ref.position.end;
    }
    assert.deepEqual(project(canonical,result.responseAnnotationReferences),{text:canonical,responseAnnotationReferences:result.responseAnnotationReferences});
  }
});

test('annotation positions never adopt code escaped labels or partial chunks', () => {
  const literal='`literal :agent-annotation{index="3"}`\n\n```text\n:codex-annotation{index="4"}\n```\n\\:agent-annotation{index="2"}\nЦитата 1\n';
  const raw=literal+':agent-annotation{index="1"} Answer :codex-annotation{index="1"} once';
  const full=project(raw);
  assert.equal(full.responseAnnotationReferences.length,1);
  const ref=full.responseAnnotationReferences[0];
  assert.ok(ref.position.start>literal.indexOf('Цитата 1'));
  assert.ok(full.text.includes(literal));
  for (let end=literal.length+':agent'.length;end<raw.indexOf(' Answer');end++) {
    const partial=project(raw.slice(0,end));
    assert.equal(partial.responseAnnotationReferences.length,0);
    assert.equal(partial.text,literal);
  }
  assert.deepEqual(project('Old Цитата 1',[{index:1}]).responseAnnotationReferences,[{index:1}]);
});
