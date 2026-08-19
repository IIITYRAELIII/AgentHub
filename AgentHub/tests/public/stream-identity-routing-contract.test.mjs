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

test("snapshot message rendering is batched until deferred state and live run are applied", async () => {
  const source = await readFile(
    new URL("../../assets/web-app/hub-client.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /const batchedMessageRenders = new Map\(\);/u);
  assert.match(source, /function queueBatchedMessageRender\(taskIdValue/u);
  assert.match(source, /function renderTaskMessages\(taskIdValue,[\s\S]*?queueBatchedMessageRender/u);
  assert.match(source, /function flushBatchedMessageRenders\(\)[\s\S]*?renderTaskMessagesNow/u);
  assert.match(source, /function runBatchedMessageRenders\(operation\)[\s\S]*?flushBatchedMessageRenders\(\);/u);
  assert.match(
    source,
    /function applySnapshot\(snapshot\) \{[\s\S]*?runBatchedMessageRenders\(\(\) => \{[\s\S]*?deferredClientUserMessageIds = new Set\([\s\S]*?patchOutgoing\([\s\S]*?agentHub\.setLive\(stableTaskId, updateLiveMessage\(stableTaskId, task\)\);[\s\S]*?\}\);/u,
  );
});

test("archiving selected Stream falls back inside the same Workspace before server selection", async () => {
  const source = await readFile(
    new URL("../../assets/web-app/hub-client.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /function snapshotWorkspaceForSelection\(snapshot, selectionId\)/u);
  assert.match(source, /function snapshotFallbackSelectionId\(previousSnapshot, snapshot, previousSelectionId\)/u);
  assert.match(source, /const previousSnapshot = lastSnapshot;/u);
  assert.match(
    source,
    /const workspaceFallbackSelectionId = !pendingExists && !localExists[\s\S]*?snapshotFallbackSelectionId\(previousSnapshot, snapshot, selectedTaskId\)/u,
  );
  assert.match(
    source,
    /effectiveSelectedId = pendingExists[\s\S]*?\? pendingSelectionId[\s\S]*?: localExists[\s\S]*?\? selectedTaskId[\s\S]*?: workspaceFallbackExists[\s\S]*?\? workspaceFallbackSelectionId[\s\S]*?: serverSelectedId;/u,
  );
});
