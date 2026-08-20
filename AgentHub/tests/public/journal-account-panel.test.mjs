import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");

test("journal regrouping preserves the account usage panel", () => {
  assert.match(app, /function currentWorkLogAccountPanel\(\)/u);
  assert.match(app, /function replaceJournalGroupedContent\(content\)/u);
  assert.doesNotMatch(
    app,
    /journal\.replaceChildren\((?:dayGroupingContent|taskGroupingContent|periodGroupingContent)\(/u,
  );
  assert.match(
    app,
    /replaceJournalGroupedContent\(dayGroupingContent\(journal\)\)/u,
  );
  assert.match(
    app,
    /replaceJournalGroupedContent\(taskGroupingContent\(journal, grouping\)\)/u,
  );
  assert.match(
    app,
    /replaceJournalGroupedContent\(periodGroupingContent\(journal, grouping\)\)/u,
  );
});
