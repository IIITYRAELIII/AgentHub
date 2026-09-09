import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  launchBrowser, openFixture, persistedRecovery, refreshWithReceipt, setSelectedTask,
} from "./composer-production.fixture.mjs";

test("production receipts route by explicit Stream or exact provider Thread, never equal message text", {
  timeout: 90_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    for (const explicitStream of [true, false]) {
      const page = await browser.newPage();
      try {
        const text = "Same message in two Streams";
        await openFixture(page, { persistedDrafts: [
          persistedRecovery({ taskId: "stream-a", requestId: "request-a", text }),
          persistedRecovery({ taskId: "stream-b", requestId: "request-b", text }),
        ] });
        assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
        const base = {
          clientUserMessageId: "request-a",
          accepted: true,
          conflictKind: "message-intake",
          clientProjectionIntent: "conversation",
          displayText: text,
        };
        for (const identity of [
          { provider: "codex", threadId: "thread-b", ...(explicitStream ? { streamId: "stream-b" } : {}) },
          { provider: "claude", threadId: "thread-a", ...(explicitStream ? { streamId: "stream-a" } : {}) },
          { provider: "codex", threadId: "thread-a", streamId: "stream-b" },
        ]) {
          await refreshWithReceipt(page, { ...base, ...identity });
          await setSelectedTask(page, "stream-a");
          assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
          await setSelectedTask(page, "stream-b");
          assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
        }
        await refreshWithReceipt(page, {
          ...base, provider: "codex", threadId: "thread-a",
          ...(explicitStream ? { streamId: "stream-a" } : {}),
        });
        await setSelectedTask(page, "stream-a");
        await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
        await setSelectedTask(page, "stream-b");
        assert.equal(await page.locator("[data-composer-input]").inputValue(), text);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
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
    /function applySnapshot\(snapshot, \{ materialized = false \} = \{\}\) \{[\s\S]*?runBatchedMessageRenders\(\(\) => \{[\s\S]*?deferredClientUserMessageIds = new Set\([\s\S]*?patchOutgoing\([\s\S]*?agentHub\.setLive\(stableTaskId, updateLiveMessage\(stableTaskId, task\)\);[\s\S]*?\}\);/u,
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
