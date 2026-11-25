import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskRunRegistry, markProviderTurnRequested, markProviderTurnAccepted, persistedLocalExecutionIdentity } from "../../src/domain/task-runs.mjs";
import { CodexTurnService } from "../../src/providers/provider-turn-services.mjs";
import { restorePersistedTaskRun } from "../../src/composition/runtime-state-restoration-composition.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from "./composer-production.fixture.mjs";

async function stoppedOriginalAndNewInput(dataDir) {
  const noop = async () => {};
  const registry = new TaskRunRegistry();
  const saved = { id: "old-run", provider: "codex", threadId: "thread-a", streamId: "stream-a",
    projectRoot: "D:/fixture", turnId: "old-turn", status: "running", executionOwner: "hub",
    clientUserMessageId: "old-client", responseText: "Retained old answer" };
  markProviderTurnRequested(saved); markProviderTurnAccepted(saved, { turnId: saved.turnId });
  const lifecycle = new ProviderRunTerminalStore({ dataDir });
  await lifecycle.recordLocalExecutionRetirement({ identity: persistedLocalExecutionIdentity(saved),
    proof: { kind: "previous-hub-local-execution", source: "canonical-runtime-snapshot", restoredAt: new Date().toISOString() } });
  const restored = restorePersistedTaskRun(saved, null, lifecycle);
  registry.addRestored(restored, saved);
  assert.equal(registry.forTask(saved), null);
  assert.equal(lifecycle.get(saved), null, "No fabricated provider terminal");
  const requests = [];
  const next = { id: "new-run", provider: "codex", streamId: "stream-a", threadId: "thread-a",
    projectRoot: "D:/fixture", status: "running", clientUserMessageId: "queued-client",
    modelId: "gpt-5.6-codex", reasoningId: "medium", collaborationMode: "default" };
  registry.add(next);
  const turns = new CodexTurnService({ sendRpc: async (method, params) => {
    requests.push({ method, params }); return { turn: { id: "new-turn" } };
  }, sandboxMode: () => "workspace-write", compactionRecycle: () => null,
  resolvedSkillNames: async () => [], reindexRun: run => registry.reindex(run),
  saveState: noop, startTyping: () => {}, scheduleObservedRun: () => {}, finishProgress: noop,
  completeRun: noop, readThread: async () => ({ thread: { turns: [{ id: "new-turn", items: [{ type: "userMessage" }] }] } }),
  developerInstructions: async () => "", speechButtons: new Map(), temporaryFiles: new Map(), turnTokenUsage: new Map() });
  await turns.launch(next, "continue with new input");
  assert.deepEqual(requests.map(row => row.method), ["turn/start"]);
  assert.deepEqual(requests[0].params.input, [{ type: "text", text: "continue with new input" }]);
  return { accepted: true, providerAccepted: true, queued: false, deferred: false,
    clientUserMessageId: next.clientUserMessageId, threadId: next.threadId, turnId: next.turnId, runId: next.id };
}

for (const width of [1366, 390]) test(`interrupted original releases the same queued input in the complete client (${width})`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-no-resume-dom-"));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const queuedReceipt = { accepted: true, queued: true, deferred: true, id: "queued-original",
      clientUserMessageId: "queued-client", providerAccepted: false, reason: "managed-run-activity-unknown" };
    const queued = snapshot([queuedReceipt]);
    queued.version = "interrupted-before";
    Object.assign(queued.tasks[0], { running: true, activityUnknown: true, runId: "old-run", turnId: "old-turn" });
    queued.deferredInputs = [{ ...queuedReceipt, text: "continue with new input", displayText: "continue with new input",
      provider: "codex", streamId: "stream-a", threadId: "thread-a", state: "queued",
      conflictKind: "task-running", waitReason: "managed-run-activity-unknown", createdAt: new Date().toISOString() }];
    const errors = await openFixture(page, { fixtureSnapshot: queued });
    if (width < 600) await page.locator("[data-mobile-button='chat']").click();
    assert.equal(new URL(page.url()).hostname, "agent-hub.test");
    assert.ok((await page.title()).length > 0);
    assert.ok((await page.locator("body").innerText()).length > 100);
    const row = page.locator(".queue-item[data-queue-id='queued-original']");
    await row.waitFor({ state: "visible" });
    assert.equal(await row.locator(".queue-status").count(), 0);
    assert.equal(await row.locator(".queue-text").innerText(), "continue with new input");
    assert.equal(await row.locator("[data-action='queue-edit']").isEnabled(), true);
    assert.equal(await row.locator("[data-action='queue-remove']").isEnabled(), true);
    const accepted = await stoppedOriginalAndNewInput(directory);
    const after = snapshot([accepted]);
    after.version = "interrupted-after";
    Object.assign(after.tasks[0], { running: true, activityUnknown: false, runId: "new-run", turnId: "new-turn" });
    await applyFixtureSnapshot(page, after);
    await row.waitFor({ state: "hidden" });
    await page.evaluate(receipt => window.AgentHub.setMessages("stream-a", [{
      id: "new-user", clientUserMessageId: receipt.clientUserMessageId, turnId: receipt.turnId,
      provider: "codex", threadId: "thread-a", role: "user", text: "continue with new input", providerAccepted: true,
    }]), accepted);
    const rendered = page.locator(".msg-body").filter({ hasText: "continue with new input" });
    await rendered.waitFor({ state: "visible" });
    assert.equal(await rendered.count(), 1);
    assert.equal(await page.locator(".queue-status").filter({ hasText: "прежнего хода" }).count(), 0);
    assert.deepEqual(errors, []);
    if (process.env.AGENT_HUB_TEST_SCREENSHOTS) {
      await mkdir(process.env.AGENT_HUB_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_SCREENSHOTS, `interrupted-after-${width}.png`) });
    }
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
