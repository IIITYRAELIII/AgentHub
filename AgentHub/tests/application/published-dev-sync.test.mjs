import assert from "node:assert/strict";





import test from "node:test";









import { nativeMergeBaseFields } from "../../src/infrastructure/filesystem/native-release-merge.mjs";














test("native merge-base fields preserve scalar identity and reject ambiguous sets", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.deepEqual(nativeMergeBaseFields(a), { mergeBase: a });
  assert.deepEqual(nativeMergeBaseFields(`${b}\r\n${a}`), { mergeBases: [a, b] });
  for (const invalid of ["", "not-a-commit", `${a}\n${a}`, `${a}\n`, `${a}\n${b.slice(1)}`]) {
    assert.throws(() => nativeMergeBaseFields(invalid), /distinct full Git commit ids/u);
  }
});
