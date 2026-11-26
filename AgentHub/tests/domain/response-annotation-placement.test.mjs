import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindResponseAnnotationTarget, codexAssistantResponseProjection as project,
  normalizedCodexResponseAnnotationReferences, responseAnnotationTargetForMessages,
} from '../../src/domain/codex-response-annotation.mjs';

test("bare indices bind only to a unique batch, preserving text and list structure", () => {
  const users = [4, 1, 1].map((count, batch) => ({
    role: "user", itemId: `user-${batch}`,
    responseAnnotations: Array.from({ length: count }, () => ({ text: "Selected", annotation: "" })),
  }));
  const raw = [1, 2, 3, 4, 1, 1].map((index, offset) =>
    `- :agent-annotation{index="${index}"} Answer ${offset + 1}`).join("\n");
  const result = bindResponseAnnotationTarget(project(raw), responseAnnotationTargetForMessages(users));
  assert.equal(result.text.split("\n").length, 6);
  for (const [offset, line] of result.text.split("\n").entries()) {
    assert.match(line, new RegExp(`^- (?:Цитата [1-4] )?Answer ${offset + 1}$`, "u"));
  }
  assert.deepEqual(result.responseAnnotationReferences.map(({ index, target }) =>
    [index, target.itemId ?? target.unresolved]), [[1, true], [2, "user-0"], [3, "user-0"], [4, "user-0"]]);
  assert.equal(raw.match(/:agent-annotation/gu).length, 6);
});

test("same-index references deduplicate only within their addressed batch", () => {
  const first = { index: 1, target: { itemId: "first", batchScoped: true }, position: { start: 0, end: 8 } };
  const second = { ...first, target: { itemId: "second", batchScoped: true }, position: { start: 9, end: 17 } };
  assert.deepEqual(normalizedCodexResponseAnnotationReferences([first, first, second, second]), [first, second]);
  assert.deepEqual(project("Цитата 1\nЦитата 1", [first, second]).responseAnnotationReferences, [first, second]);
});

test("raw reprojection keeps two addressed list markers and never invents a second address", () => {
  const raw = '- :agent-annotation{index="1"} First\n- :agent-annotation{index="1"} Second';
  const expected = "- Цитата 1 First\n- Цитата 1 Second";
  const references = ["first", "second"].map((itemId, offset) => {
    const start = offset ? expected.lastIndexOf("Цитата 1") : expected.indexOf("Цитата 1");
    return { index: 1, target: { itemId, batchScoped: true }, position: { start, end: start + 8 } };
  });
  assert.deepEqual(project(raw, references), { text: expected, responseAnnotationReferences: references });
  assert.deepEqual(project(" \r\n" + raw.replaceAll("\n", "\r\n"), references).responseAnnotationReferences, references);
  assert.equal(project(raw).responseAnnotationReferences.length, 1);
  const misplaced = [{ ...references[1], position: { start: 1, end: 9 } }];
  const unsafe = project(raw, misplaced);
  assert.equal(unsafe.responseAnnotationReferences.length, 1);
  assert.equal(unsafe.responseAnnotationReferences[0].target, undefined);
  const invalidLength = { ...references[1], position: {
    start: references[1].position.start, end: references[1].position.end - 1,
  } };
  assert.deepEqual(project(raw, [invalidLength]), project(raw));
  assert.deepEqual(project(expected, [invalidLength]).responseAnnotationReferences, []);
  const { position, ...legacy } = references[1];
  assert.deepEqual(project(raw, [legacy]).responseAnnotationReferences, [
    { ...legacy, position: references[0].position },
  ]);
});

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
