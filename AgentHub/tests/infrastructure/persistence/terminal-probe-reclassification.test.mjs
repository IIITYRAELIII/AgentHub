import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ManagedRunHistoryService } from "../../../src/application/managed-run-history-service.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { TurnEndDeliveryService } from "../../../src/application/turn-end-delivery-service.mjs";
import { CODEX_CONTEXT_PROBE_PROMPT } from "../../../src/domain/codex-context-probe.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { LocalTaskSyncStore } from "../../../src/infrastructure/persistence/task-sync-store.mjs";
import { createRuntimeFacadesComposition } from "../../../src/composition/runtime-facades-composition.mjs";
import { CodexTerminalReconciliationService } from "../../../src/providers/codex/codex-terminal-reconciliation-service.mjs";

const identity = { provider: "codex", threadId: "thread-probe", turnId: "turn-probe" };
const evidence = { ...identity, operationKind: "probe", contextProbe: true, status: "failed" };

async function fixture(context) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-probe-reclassification-"));
  const store = new ProviderTurnTerminalStore({ dataDir });
  const terminalCommits = new TerminalTurnCommitService({ store });
  const taskSyncStore = new LocalTaskSyncStore({ filePath: path.join(dataDir, "task-sync.json") });
  await taskSyncStore.load();
  context.after(async () => {
    taskSyncStore.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const completion = {
    ...identity,
    projectRoot: dataDir,
    status: "completed",
    operationKind: "user-turn",
    contextProbe: false,
    prompt: CODEX_CONTEXT_PROBE_PROMPT,
    finalAnswer: "",
    usage: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 },
    usageReported: true,
    model: "gpt-5.6-sol",
    completedAt: "2026-09-08T21:11:41.000Z",
  };
  const managedHistory = new ManagedRunHistoryService({
    taskSyncStore,
    terminalCommits,
    mergeActiveHistory: () => {},
    nowIso: () => completion.completedAt,
    nowMs: () => Date.parse(completion.completedAt),
  });
  const projected = [];
  const notifications = [];
  const delivery = new TurnEndDeliveryService({
    terminalCommits,
    persistHistory: (...args) => managedHistory.persist(...args),
    projectTurn: async (turn) => { projected.push(turn); },
    finalizeRunDelivery: async (...args) => { notifications.push(args); },
    rememberLastMessage: () => {},
    rememberSeenTurn: () => {},
    saveState: async () => {},
  });
  return { store, terminalCommits, taskSyncStore, completion, managedHistory, delivery, projected, notifications };
}

test("exact durable probe repair preserves usage and removes only its history and search projection", async (context) => {
  const setup = await fixture(context);
  const { completion, terminalCommits, taskSyncStore, delivery, projected, notifications } = setup;
  const initial = await terminalCommits.commit(completion, {
    channelIntents: { telegram: { requested: true } },
  });
  taskSyncStore.recordHistory(completion, [
    { id: identity.turnId, prompt: CODEX_CONTEXT_PROBE_PROMPT, answer: "Probephantom", completed: true },
    { id: "real-user", prompt: CODEX_CONTEXT_PROBE_PROMPT, answer: "Ordinaryreply", completed: true,
      messages: [{ itemId: "real-input", role: "user", text: CODEX_CONTEXT_PROBE_PROMPT, clientUserMessageId: "ordinary-user" }] },
  ], { active: true, turnId: "current-active", answer: "Current answer" });
  assert.equal(taskSyncStore.searchMessages({ references: [identity], query: "Probephantom" }).total, 1);
  const repaired = await terminalCommits.reclassifyContextProbe(identity, evidence);
  assert.equal(repaired.reclassified, true);
  assert.equal(repaired.terminal.terminalRevision, initial.terminal.terminalRevision + 1);
  assert.equal(repaired.terminal.status, "failed");
  assert.equal(repaired.terminal.usageIdentity, initial.terminal.usageIdentity);
  assert.deepEqual(repaired.terminal.payload.completion.usage, completion.usage);
  assert.equal(repaired.terminal.payload.history.promptPreview, CODEX_CONTEXT_PROBE_PROMPT);
  assert.equal(repaired.terminal.payload.history.operationKind, "probe");
  assert.equal(repaired.terminal.payload.history.contextProbe, true);
  assert.equal(repaired.terminal.lastMessage, null);
  assert.equal(repaired.outbox.channels.telegram.state, "not-requested");
  await delivery.deliverOutbox(repaired.outbox);
  assert.deepEqual(taskSyncStore.history(completion).map((turn) => turn.id), ["real-user"]);
  assert.equal(taskSyncStore.searchMessages({ references: [identity], query: "Probephantom" }).total, 0);
  assert.equal(taskSyncStore.searchMessages({ references: [identity], query: "Ordinaryreply" }).total, 1);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].contextProbe, true);
  assert.deepEqual(projected[0].usage, completion.usage);
  assert.deepEqual(notifications, []);
  const repeated = await terminalCommits.reclassifyContextProbe(identity, evidence);
  assert.equal(repeated.reclassified, false);
  assert.equal(repeated.terminal.terminalRevision, repaired.terminal.terminalRevision);
  await delivery.deliverOutbox(repeated.outbox);
  assert.equal(projected.length, 1);
});

test("probe repair rejects nonexact evidence, text alone and any ordinary client identity", async (context) => {
  const { completion, terminalCommits } = await fixture(context);
  const initial = await terminalCommits.commit(completion);
  for (const candidate of [
    { ...evidence, threadId: "another-thread" },
    { ...evidence, turnId: "another-turn" },
    { ...identity, prompt: CODEX_CONTEXT_PROBE_PROMPT },
    { ...evidence, contextProbe: false },
    { ...evidence, operationKind: "user-turn" },
    { ...evidence, clientUserMessageId: "ordinary-user" },
    { ...evidence, items: [{ type: "userMessage", clientId: "ordinary-user" }] },
  ]) {
    assert.equal((await terminalCommits.reclassifyContextProbe(identity, candidate)).reclassified, false);
  }
  assert.equal((await terminalCommits.get(identity)).terminalRevision, initial.terminal.terminalRevision);
  for (const retained of [
    { clientUserMessageId: "ordinary-user" },
    { userMessages: [{ role: "user", clientUserMessageId: "ordinary-user", text: CODEX_CONTEXT_PROBE_PROMPT }] },
  ]) {
    const committed = await terminalCommits.commit({ ...completion, ...retained, finalAnswer: JSON.stringify(retained) });
    const refused = await terminalCommits.reclassifyContextProbe(identity, evidence);
    assert.equal(refused.reclassified, false);
    assert.equal(refused.terminal.terminalRevision, committed.terminal.terminalRevision);
  }
});

test("probe reclassification CAS rechecks concurrent ordinary identity without overwriting it", async (context) => {
  const { completion, terminalCommits, store } = await fixture(context);
  await terminalCommits.commit(completion);
  const commit = store.commit.bind(store);
  let raced = false;
  context.mock.method(store, "commit", async (value) => {
    if (!raced && value.expectedTerminalRevision) {
      raced = true;
      await commit({
        ...identity, status: "completed", finalAnswer: "Real user answer", usageIdentity: "new-usage",
        payload: { completion: { ...completion, clientUserMessageId: "real-user" } },
      });
    }
    return commit(value);
  });
  const result = await terminalCommits.reclassifyContextProbe(identity, evidence);
  assert.equal(raced, true);
  assert.equal(result.reclassified, false);
  assert.equal(result.outbox, null);
  assert.equal(result.terminal.finalAnswer, "Real user answer");
  assert.equal(result.terminal.usageIdentity, "new-usage");
  assert.equal(result.terminal.payload.completion.clientUserMessageId, "real-user");
});

test("failed probe projection remains durably retryable across idempotent repair", async (context) => {
  const { completion, terminalCommits, delivery } = await fixture(context);
  await terminalCommits.commit(completion);
  const repaired = await terminalCommits.reclassifyContextProbe(identity, evidence);
  const projectTurn = delivery.projectTurn;
  delivery.projectTurn = async () => { throw new Error("projection unavailable"); };
  await assert.rejects(delivery.deliverOutbox(repaired.outbox), /projection unavailable/u);
  const repeated = await terminalCommits.reclassifyContextProbe(identity, evidence);
  assert.equal(repeated.reclassified, false);
  assert.equal(repeated.outbox.state, "pending");
  assert.equal(repeated.terminal.terminalRevision, repaired.terminal.terminalRevision);
  delivery.projectTurn = projectTurn;
  await delivery.deliverOutbox(repeated.outbox);
  assert.equal((await terminalCommits.pending()).length, 0);
});

test("classification alone creates one terminal revision and survives the history serializer", async (context) => {
  const { completion, terminalCommits } = await fixture(context);
  const initial = await terminalCommits.commit({ ...completion, aggregateOnly: true });
  const classified = await terminalCommits.commit({ ...completion, aggregateOnly: true, operationKind: "probe", contextProbe: true });
  assert.equal(classified.created, true);
  assert.equal(classified.terminal.terminalRevision, initial.terminal.terminalRevision + 1);
  assert.equal(classified.terminal.payload.history.contextProbe, true);
  assert.equal(classified.terminal.payload.history.operationKind, "probe");
  const repeated = await terminalCommits.commit({ ...completion, aggregateOnly: true, operationKind: "probe", contextProbe: true });
  assert.equal(repeated.created, false);
});

test("stale probe history projection cannot erase a newer ordinary terminal", async (context) => {
  const { completion, terminalCommits, taskSyncStore, managedHistory } = await fixture(context);
  await terminalCommits.commit(completion);
  const repaired = await terminalCommits.reclassifyContextProbe(identity, evidence);
  await terminalCommits.commit({ ...completion, clientUserMessageId: "ordinary-user", finalAnswer: "Real answer" });
  taskSyncStore.recordHistory(completion, [{ id: identity.turnId, prompt: CODEX_CONTEXT_PROBE_PROMPT, answer: "Real answer", completed: true }]);
  await managedHistory.persist(repaired.terminal.payload.history, { active: false, terminalRevision: repaired.terminal.terminalRevision });
  assert.equal(taskSyncStore.history(completion).length, 1);
  assert.equal(taskSyncStore.history(completion)[0].answer, "Real answer");
});

test("historical equal-usage fast return still repairs through the runtime facade and durable outbox", async (context) => {
  const { completion, terminalCommits, delivery, taskSyncStore, projected } = await fixture(context);
  await terminalCommits.commit(completion);
  taskSyncStore.recordHistory(completion, [{ id: identity.turnId, prompt: CODEX_CONTEXT_PROBE_PROMPT, answer: "Ghost", completed: true }]);
  delivery.rememberLastMessage = () => assert.fail("Probe cannot revive a last message");
  delivery.rememberSeenTurn = () => assert.fail("Probe cannot replace the seen user turn");
  const facades = createRuntimeFacadesComposition({ turnEndDelivery: delivery });
  const service = new CodexTerminalReconciliationService({
    notifications: { hasDelivered: () => true, get: () => null },
    turnStarts: new Map(),
    workLogStore: { getTurn: async () => ({ ...completion, contextProbe: true }) },
    reclassifyTerminalContextProbe: facades.reclassifyTurnEndContextProbe,
    accountingThread: () => assert.fail("Equal usage should not resolve accounting again"),
    now: () => Date.parse(completion.completedAt) + 60_000,
  });
  const result = await service.reconcile({ id: identity.threadId }, { path: completion.projectRoot }, {
    ...evidence,
    historical: true,
    usageResult: { ...completion, terminal: true, reported: true, contextProbe: true, operationKind: "probe", status: "failed" },
  });
  assert.equal(result, true);
  assert.equal((await terminalCommits.get(identity)).status, "failed");
  assert.equal(taskSyncStore.history(completion).length, 0);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].contextProbe, true);
});

test("reconciliation cannot project a late ordinary client identity as a probe", async (context) => {
  const { completion, terminalCommits, delivery, projected } = await fixture(context);
  await terminalCommits.commit({ ...completion, clientUserMessageId: "ordinary-client" });
  const service = new CodexTerminalReconciliationService({
    notifications: { hasDelivered: () => true, get: () => null },
    turnStarts: new Map(),
    reclassifyTerminalContextProbe: (...args) => delivery.reclassifyContextProbe(...args),
    workLogStore: { getTurn: () => assert.fail("Refused classification must not hide the journal turn") },
    now: () => Date.parse(completion.completedAt) + 60_000,
  });
  assert.equal(await service.reconcile({ id: identity.threadId }, { path: completion.projectRoot }, {
    ...evidence, historical: true,
    usageResult: { ...completion, terminal: true, reported: true, contextProbe: true, operationKind: "probe" },
  }), true);
  assert.deepEqual(projected, []);
  assert.equal((await terminalCommits.get(identity)).payload.completion.clientUserMessageId, "ordinary-client");
});
