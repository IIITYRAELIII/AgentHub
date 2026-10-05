import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";
import { TurnEndDeliveryService } from "../../src/application/turn-end-delivery-service.mjs";
import { ProviderTurnTerminalStore } from "../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";
import { PersistentDeliveryOutbox } from "../../src/infrastructure/persistence/delivery-outbox.mjs";

test("exact later provider abort corrects one committed revision without replaying a turn", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-terminal-correction-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  const transitions = [];
  const messages = { transitionMessageCommand: async (value) => {
    transitions.push(value);
    return { changed: true };
  } };
  const service = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }), messageCommands: messages,
  });
  const runTerminals = new ProviderRunTerminalStore({ dataDir });
  await service.commit({ ...identity, status: "completed", completedAt: "2026-09-29T11:45:44.000Z",
    finalAnswer: "Premature answer", clientUserMessageId: "client-1" }, {
    run: { id: "run-1", clientUserMessageId: "client-1" },
  });
  await runTerminals.record({ ...identity, status: "completed" });
  const projections = [];
  const history = [];
  const delivery = new TurnEndDeliveryService({
    terminalCommits: service, runLifecycleTerminals: runTerminals,
    taskRuns: { forEvent: () => null }, notifications: { markDelivered: () => {} },
    persistHistory: async (...args) => history.push(args),
    projectTurn: async (...args) => { projections.push(args); return {}; },
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
  });
  const corrected = await delivery.correctFromExactProviderTerminal(identity, {
    status: "aborted", completedAt: "2026-09-29T11:58:02.936Z", finalAnswer: "",
  });
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.terminal.terminalRevision, 2);
  assert.equal(corrected.terminal.status, "aborted");
  assert.equal(corrected.terminal.payload.completion.status, "aborted");
  assert.equal(corrected.terminal.payload.history.id, "run-1");
  assert.equal(corrected.outbox.channels.telegram.state, "not-requested");
  assert.equal(transitions.at(-1).state, "cancelled");
  assert.equal(transitions.at(-1).result.terminalRevision, 2);
  assert.equal(runTerminals.get(identity).status, "aborted");
  assert.equal(projections.length, 1);
  assert.equal(projections[0][0].status, "aborted");
  assert.equal(projections[0][0].terminalRevision, 2);
  assert.equal(history[0][1].status, "aborted");
  assert.equal((await service.store.get(identity)).terminalRevision, 2);
  assert.equal((await service.store.pending({ limit: 10 })).length, 0);

  const reopened = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }), messageCommands: messages,
  });
  assert.equal((await reopened.get(identity)).status, "aborted");
  assert.equal((await reopened.correctFromExactProviderTerminal(identity, {
    status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
  })).corrected, false);
  assert.equal((await reopened.correctFromExactProviderTerminal(identity, {
    status: "completed", completedAt: "2026-09-29T11:45:44.000Z",
  })).stale, true);
  assert.equal((await reopened.get(identity)).terminalRevision, 2);
  await delivery.correctFromExactProviderTerminal(identity, {
    status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
  });
  assert.equal(projections.length, 1);
});

test("status correction never creates a new Telegram identity or revokes uncertain old delivery", async (t) => {
  for (const state of ["intent", "uncertain", "acked"]) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), `hub-correction-${state}-`));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const identity = { provider: "codex", threadId: "thread-1", turnId: `turn-${state}` };
    const store = new ProviderTurnTerminalStore({ dataDir });
    const service = new TerminalTurnCommitService({ store });
    const first = await service.commit({ ...identity, status: "completed",
      completedAt: "2026-09-29T11:45:44.000Z", finalAnswer: "Earlier answer" }, {
      channelIntents: { telegram: { requested: true, message: "Earlier answer" } },
    });
    if (state !== "intent") await store.updateChannel(first.outbox, "telegram", state, {
      deliveryId: "original-delivery",
    });
    const corrected = await service.correctFromExactProviderTerminal(identity, {
      status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
    });
    assert.equal(corrected.terminal.terminalRevision, 2);
    assert.equal(corrected.outbox.channels.telegram.state, "not-requested");
    const old = await store.pending({ limit: 10 });
    assert.equal(old.some((item) => ["intent", "uncertain"].includes(item.channels.telegram.state)), false);
    if (state === "uncertain") {
      const database = new DatabaseSync(path.join(dataDir, "runtime.sqlite"), { readOnly: true });
      try {
        assert.equal(database.prepare(`SELECT telegram_state FROM provider_turn_terminal_outbox
          WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = 1`).get(
          identity.provider, identity.threadId, identity.turnId,
        ).telegram_state, "superseded-uncertain");
      } finally { database.close(); }
      const lateAck = await store.updateChannel(first.outbox, "telegram", "acked", {
        deliveryId: "original-delivery",
      });
      assert.equal(lateAck.channels.telegram.state, "acked");
    }
    const sends = [];
    const delivery = new TurnEndDeliveryService({
      terminalCommits: service,
      finalizeRunDelivery: async (...args) => sends.push(args),
    });
    assert.deepEqual(await delivery.retryPendingTelegram(), { processed: 0 });
    assert.deepEqual(sends, [], "superseded old answer cannot be retried");
    const replay = await new TerminalTurnCommitService({
      store: new ProviderTurnTerminalStore({ dataDir }),
    }).correctFromExactProviderTerminal(identity, {
      status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
    });
    assert.equal(replay.corrected, false);
    assert.equal(replay.terminal.terminalRevision, 2);
  }
});

test("a persisted uncertain old Telegram attempt cannot resend after exact status correction and reopen", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-correct-telegram-reopen-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  const commits = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) });
  const first = await commits.commit({ ...identity, status: "completed",
    completedAt: "2026-09-29T11:45:44.000Z", finalAnswer: "Wrong old answer" }, {
    channelIntents: { telegram: { requested: true, message: "Wrong old answer" } },
  });
  const directoryPath = path.join(dataDir, "telegram-outbox");
  let sends = 0;
  const deliveryOptions = {
    directoryPath,
    onUncertain: (item) => commits.authorizeTelegramOutboxAttempt(item.intent, { deliveryId: item.id }),
    retryDelay: () => 0,
  };
  const original = new PersistentDeliveryOutbox({ ...deliveryOptions,
    deliver: async () => {
      sends += 1;
      const error = new Error("external outcome unknown");
      error.retryable = true;
      error.uncertain = true;
      throw error;
    },
  });
  await original.enqueue({ method: "sendMessage", body: { text: "Wrong old answer" },
    intent: { ...identity, terminalRevision: first.terminal.terminalRevision, final: true } });
  await original.flush();
  assert.equal(sends, 1);
  const corrected = await commits.correctFromExactProviderTerminal(identity, {
    status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
  });
  assert.equal(corrected.terminal.terminalRevision, 2);
  const reopenedCommits = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) });
  const reopened = new PersistentDeliveryOutbox({ ...deliveryOptions,
    onUncertain: (item) => reopenedCommits.authorizeTelegramOutboxAttempt(item.intent, { deliveryId: item.id }),
    deliver: async () => { sends += 1; return { message_id: 9 }; },
  });
  assert.deepEqual(await reopened.flush(), { delivered: 0, remaining: 0 });
  assert.equal(sends, 1);
  assert.equal((await reopenedCommits.get(identity)).terminalRevision, 2);
  assert.equal((await reopenedCommits.pending({ limit: 10 })).some((item) =>
    ["intent", "uncertain"].includes(item.channels.telegram.state)), false);
});

test("an in-flight same-turn Telegram attempt and exact correction share one authority lane", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-correct-telegram-race-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  const commits = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) });
  await commits.commit({ ...identity, status: "completed",
    completedAt: "2026-09-29T11:45:44.000Z", finalAnswer: "Wrong old answer" });
  const delivery = new TurnEndDeliveryService({ terminalCommits: commits,
    taskRuns: { forEvent: () => null }, notifications: { markDelivered: () => {} },
    persistHistory: async () => {}, projectTurn: async () => ({}),
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
  });
  let releaseAttempt;
  const held = new Promise((resolve) => { releaseAttempt = resolve; });
  let enteredAttempt;
  const entered = new Promise((resolve) => { enteredAttempt = resolve; });
  const attempt = delivery.withTelegramOutboxAttempt({ intent: { ...identity, terminalRevision: 1 } }, async () => {
    assert.equal((await commits.get(identity)).terminalRevision, 1);
    enteredAttempt();
    await held;
  });
  await entered;
  const correction = delivery.correctFromExactProviderTerminal(identity, {
    status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await commits.get(identity)).terminalRevision, 1,
    "correction cannot pass an already-started external attempt");
  releaseAttempt();
  await attempt;
  await correction;
  assert.equal((await commits.get(identity)).terminalRevision, 2);
});

test("run-terminal CAS refusal cannot be reported as a successful correction", async () => {
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  const delivery = new TurnEndDeliveryService({
    terminalCommits: { correctFromExactProviderTerminal: async () => ({
      corrected: true, terminal: { ...identity, status: "aborted", terminalRevision: 2 }, outbox: {},
    }) },
    runLifecycleTerminals: {
      get: () => ({ status: "completed", committedAt: "2026-09-29T11:45:44.000Z" }),
      correctFromExactTerminal: async () => ({ corrected: false, current: { status: "completed" } }),
    },
    taskRuns: null, notifications: null,
  });
  delivery.deliverOutbox = async () => assert.fail("Cannot project a partially corrected terminal");
  await assert.rejects(delivery.correctFromExactProviderTerminal(identity, {
    status: "aborted", completedAt: "2026-09-29T11:58:02.936Z",
  }), /run terminal correction did not settle/u);
});

test("restart resumes the same correction after the terminal CAS but before run-state and projection", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-terminal-correction-restart-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  const firstCommits = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) });
  const runTerminals = new ProviderRunTerminalStore({ dataDir });
  await firstCommits.commit({ ...identity, status: "completed",
    completedAt: "2026-09-29T11:45:44.000Z", finalAnswer: "Earlier answer" });
  await runTerminals.record({ ...identity, status: "completed" });
  const interrupted = new TurnEndDeliveryService({
    terminalCommits: firstCommits,
    runLifecycleTerminals: {
      get: (key) => runTerminals.get(key),
      correctFromExactTerminal: () => { throw new Error("process stopped between stores"); },
    },
  });
  const exactTerminal = { status: "aborted", completedAt: "2026-09-29T11:58:02.936Z" };
  await assert.rejects(interrupted.correctFromExactProviderTerminal(identity, exactTerminal),
    /process stopped between stores/u);
  assert.equal((await firstCommits.get(identity)).terminalRevision, 2);
  assert.equal(runTerminals.get(identity).status, "completed");

  const projections = [];
  const resumed = new TurnEndDeliveryService({
    terminalCommits: new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }) }),
    runLifecycleTerminals: new ProviderRunTerminalStore({ dataDir }),
    taskRuns: { forEvent: () => null }, notifications: { markDelivered: () => {} },
    persistHistory: async () => {},
    projectTurn: async (completion) => { projections.push(completion.terminalRevision); return {}; },
    rememberLastMessage: () => {}, rememberSeenTurn: () => {}, saveState: async () => {},
  });
  assert.equal((await resumed.correctFromExactProviderTerminal(identity, exactTerminal)).corrected, false);
  assert.equal(runTerminals.get(identity).status, "aborted");
  assert.deepEqual(projections, []);
  await resumed.retryPendingProjections();
  assert.deepEqual(projections, [2]);
  await resumed.retryPendingProjections();
  assert.deepEqual(projections, [2]);
});

test("terminal commit closes the matching message command through idempotent CAS", async () => {
  const transitions = [];
  let committed = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        committed = value;
        return ({
        terminal: {
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalRevision: 3,
          status: "completed",
          payload: { history: { id: "run-1", clientUserMessageId: "message-1" } },
        },
        outbox: {},
        });
      },
      get: async () => null,
    },
    messageCommands: {
      transitionMessageCommand: async (transition) => transitions.push(transition),
    },
  });

  await service.commit({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAnswer: "готово",
  }, {
    run: { id: "run-1", clientUserMessageId: "message-1" },
  });

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].clientUserMessageId, "message-1");
  assert.equal(transitions[0].state, "completed");
  assert.equal(transitions[0].result.terminalRevision, 3);
  assert.equal(committed.payload.completion.runId, "run-1");
  assert.equal(committed.payload.history.id, "run-1");
});

test("terminal commit keeps structured response annotations beside the canonical answer", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return {
          terminal: {
            provider: "codex",
            threadId: "thread-annotation",
            turnId: "turn-annotation",
            terminalRevision: 1,
            status: "completed",
            payload: value.payload,
          },
          outbox: {},
        };
      },
      get: async () => null,
    },
  });
  const responseAnnotations = [{ text: "Фрагмент", annotation: "Почему?" }];

  await service.commit({
    provider: "codex",
    threadId: "thread-annotation",
    turnId: "turn-annotation",
    status: "completed",
    finalAnswer: "Связь сохранена",
    responseAnnotationReferences: [{ index: 1 }],
  }, {
    run: {
      id: "run-annotation",
      userMessages: [{ role: "user", text: "Комментарий", responseAnnotations }],
    },
  });

  assert.equal(stored.finalAnswer, "Связь сохранена");
  assert.deepEqual(stored.payload.history.responseAnnotationReferences, [{ index: 1 }]);
  assert.deepEqual(stored.payload.history.userMessages[0].responseAnnotations, responseAnnotations);
});

test("terminal commit keeps live citation refs when completion tracking is empty", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return {
          terminal: {
            provider: "codex",
            threadId: "thread-annotation",
            turnId: "turn-annotation",
            terminalRevision: 1,
            status: "completed",
            payload: value.payload,
          },
          outbox: {},
        };
      },
      get: async () => null,
    },
  });

  await service.commit({
    provider: "codex",
    threadId: "thread-annotation",
    turnId: "turn-annotation",
    status: "completed",
    finalAnswer: "Цитата 1\nСвязь сохранена",
    responseAnnotationReferences: [],
  }, {
    run: {
      id: "run-annotation",
      responseItemId: "provider-final-item",
      responseAnnotationReferences: [{ index: 1 }],
    },
  });

  assert.deepEqual(stored.payload.history.responseAnnotationReferences, [{ index: 1 }]);
});

test("terminal commit persists raw prompt and drops oversized provider message identity", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return {
          terminal: {
            provider: value.provider,
            threadId: value.threadId,
            turnId: value.turnId,
            terminalRevision: 1,
            status: value.status,
            payload: value.payload,
          },
          outbox: {},
        };
      },
      get: async () => null,
    },
  });
  const oversized = "x".repeat(201);

  await service.commit({
    provider: "codex",
    threadId: "thread-bounded",
    turnId: "turn-bounded",
    status: "completed",
    finalAnswer: "Done",
    clientUserMessageId: oversized,
  }, {
    run: {
      id: "run-bounded",
      rawPrompt: "raw transport prompt",
      promptPreview: "display body",
      clientUserMessageId: oversized,
      userMessages: [{ role: "user", text: "display body", clientUserMessageId: oversized }],
    },
  });

  assert.equal(stored.payload.history.promptPreview, "raw transport prompt");
  assert.equal(stored.payload.history.clientUserMessageId, null);
  assert.equal(stored.payload.history.userMessages[0].clientUserMessageId, undefined);
  assert.equal(stored.payload.completion.clientUserMessageId, undefined);
});

test("terminal commit drops conflicting top-level and root interstream identity", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return { terminal: { ...value, terminalRevision: 1, payload: value.payload }, outbox: {} };
      },
      get: async () => null,
    },
  });
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-1",
    streamName: "Release Manager",
    provider: "codex",
    sourceThreadId: "thread-source",
    requestId: "request-a",
  };

  await service.commit({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-conflict",
    status: "completed",
    finalAnswer: "Done",
    clientUserMessageId: "mcp:request-a",
    messageOrigin: origin,
    userMessages: [{
      role: "user",
      text: "raw",
      clientUserMessageId: "mcp:request-b",
      origin: { ...origin, requestId: "request-b" },
    }],
  }, {
    run: {
      id: "run-conflict",
      rawPrompt: "raw",
      clientUserMessageId: "mcp:request-a",
      messageOrigin: origin,
      userMessages: [{
        role: "user",
        text: "raw",
        clientUserMessageId: "mcp:request-b",
        origin: { ...origin, requestId: "request-b" },
      }],
    },
  });

  assert.equal(stored.payload.completion.clientUserMessageId, undefined);
  assert.equal(stored.payload.completion.messageOrigin, undefined);
  assert.equal(stored.payload.completion.userMessages[0].clientUserMessageId, undefined);
  assert.equal(stored.payload.history.clientUserMessageId, null);
  assert.equal(stored.payload.history.messageOrigin, undefined);
  assert.equal(stored.payload.history.userMessages[0].clientUserMessageId, undefined);
});
