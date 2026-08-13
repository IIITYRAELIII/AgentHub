import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
const policyStart = app.indexOf("const PASTED_TEXT_ATTACHMENT_THRESHOLD");
const policyEnd = app.indexOf("function pastedTextFile", policyStart);
assert.ok(policyStart >= 0 && policyEnd > policyStart, "paste policy must be present in app.js");

const context = { DRAFT_STORAGE_MAX_TEXT: 100_000 };
vm.runInNewContext(app.slice(policyStart, policyEnd), context);

test("large pasted text becomes an attachment before the message limit", () => {
  assert.equal(context.pastedTextShouldBeAttachment("x".repeat(7_999)), false);
  assert.equal(context.pastedTextShouldBeAttachment("x".repeat(8_000)), true);
  assert.equal(context.pastedTextShouldBeAttachment("x".repeat(2_000), "", 99_000), true);
});

test("pasted spreadsheet and Markdown tables become text attachments", () => {
  assert.equal(context.pastedTextShouldBeAttachment("A\tB\n1\t2"), true);
  assert.equal(context.pastedTextShouldBeAttachment("A | B\n--- | ---\n1 | 2"), true);
  assert.equal(context.pastedTextShouldBeAttachment("A B", "<table><tr><td>A</td></tr></table>"), true);
  assert.equal(context.pastedTextShouldBeAttachment("Короткий обычный текст"), false);
});

test("composer paste creates the standard pasted-text file card", () => {
  assert.match(app, /new File\(\[String\(text \?\? ""\)\], "Вставленный текст\.txt"/u);
  assert.match(app, /getData\("text\/plain"\)/u);
  assert.match(app, /getData\("text\/html"\)/u);
  assert.match(app, /readAttachmentFiles\(\[pastedTextFile\(text\)\]\)/u);
});
