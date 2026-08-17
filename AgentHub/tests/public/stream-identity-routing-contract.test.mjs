import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hub client keeps Stream identity in routing, receipts, queue and live patches", async () => {
  const source = await readFile(
    new URL("../../assets/web-app/hub-client.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /const streamId = String\(receipt\?\.streamId \?\? ""\)\.trim\(\);/u);
  assert.match(source, /const stableTaskId = taskId\(provider, threadId, streamId\);/u);
  assert.match(source, /rememberOutgoing\(stableTaskId, \{[\s\S]*?streamId,/u);
  assert.match(source, /patchOutgoing\(stableTaskId, clientUserMessageId, \{[\s\S]*?streamId,/u);
  assert.match(source, /taskId\(deferred\.provider, deferred\.threadId, deferred\.streamId\)/u);
  assert.match(source, /taskId\(task\.provider, task\.threadId, task\.streamId\)/u);
  assert.match(source, /resolvedChatRoute\(result, identity\)/u);
  assert.match(source, /resolvedChatRoute\(opened, \{ provider, threadId \}\)/u);
  assert.match(source, /streamId: task\.streamId,/u);
  assert.doesNotMatch(source, /taskId\(deferred\.provider, deferred\.threadId\)/u);
  assert.doesNotMatch(source, /taskId\(task\.provider, task\.threadId\)/u);
  assert.doesNotMatch(source, /#\/chat\/\$\{encodeURIComponent\(identity\.provider\)\}/u);
});
