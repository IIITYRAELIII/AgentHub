import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");

test("bug report closes optimistically and reopens with its draft after an error", () => {
  const submit = app.match(/bugReportForm\?\.addEventListener\("submit"[\s\S]*?\n\}\);/u)?.[0] ?? "";
  const complete = app.match(/completeBugReport\(result = \{\}\) \{[\s\S]*?\n  \},/u)?.[0] ?? "";
  assert.match(submit, /setBugReportSending\(true\)[\s\S]*bugReportForm\.hidden = true/u);
  assert.match(submit, /aria-expanded", "false"[\s\S]*emit\("bug-report:submit"/u);
  assert.match(complete, /if \(result\.error\)[\s\S]*bugReportForm\.hidden = false/u);
  assert.match(complete, /aria-expanded", "true"[\s\S]*bugReportText\?\.focus\(\)/u);
  assert.match(complete, /if \(result\.error\)[\s\S]*return;[\s\S]*bugReportAttachments = \[\]/u);
});
