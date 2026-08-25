import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TurnEndDeliveryService } from "../../../src/application/turn-end-delivery-service.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { MessageCommandLedgerStore } from "../../../src/infrastructure/persistence/message-command-ledger-store.mjs";

function completion(overrides = {}) {
  return {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAnswer: "Final answer",
    usage: { inputTokens: 3, outputTokens: 5 },
    usageReported: true,
    completedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

test("terminal commit is idempotent and revisions supersede pending projections", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });

  const first = await terminal.commit(completion());
  const duplicate = await terminal.commit(completion());
  assert.equal(first.created, true);
  assert.equal(first.terminal.terminalRevision, 1);
  assert.equal(first.outbox.state, "pending");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.terminal.terminalRevision, 1);
  const replayedAfterRestart = await terminal.commit(completion({
    completedAt: "2026-08-25T12:00:01.000Z",
  }));
  assert.equal(replayedAfterRestart.terminal.terminalRevision, 1);

  const claimed = await terminal.claim(first.outbox);
  assert.equal(claimed.state, "projecting");
  assert.equal(claimed.attempts, 1);
  assert.equal(await terminal.recoverProjecting(), 1);
  assert.equal((await terminal.pending())[0].terminalRevision, 1);

  const lateActive = await terminal.commit(completion({
    status: "inProgress",
    finalAnswer: "late progress",
  }));
  assert.equal(lateActive.absorbed, true);
  assert.equal(lateActive.terminal.terminalRevision, 1);

  const revised = await terminal.commit(completion({ finalAnswer: "Corrected final answer" }));
  assert.equal(revised.terminal.terminalRevision, 2);
  assert.deepEqual((await terminal.pending()).map((item) => item.terminalRevision), [2]);
});

test("missing projection ACK repeats one revision without repeating provider effect", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-outbox-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  let providerEffects = 0;
  let projections = 0;
  const providerCompletion = async () => {
    providerEffects += 1;
    return terminal.commit(completion());
  };
  const committed = await providerCompletion();

  const dependencies = {
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: terminal,
    taskRuns: { forEvent: () => null },
    persistHistory: async (_run, options) => {
      assert.equal(options.terminalRevision, 1);
    },
    projectTurn: async (value) => {
      projections += 1;
      assert.equal(value.terminalRevision, 1);
    },
    rememberLastMessage() {},
    rememberSeenTurn() {},
    logger: { error() {} },
  };
  const interrupted = new TurnEndDeliveryService({
    ...dependencies,
    saveState: async () => { throw new Error("crash before ACK"); },
  });
  await assert.rejects(interrupted.deliverOutbox(committed.outbox), /crash before ACK/u);
  assert.equal((await terminal.pending())[0].attempts, 1);

  const restarted = new TurnEndDeliveryService({
    ...dependencies,
    saveState: async () => {},
  });
  await restarted.retryPending();

  assert.equal(providerEffects, 1);
  assert.equal(projections, 2);
  assert.deepEqual(await terminal.pending(), []);
});

test("startup pending reconciliation repairs a command left started after terminal commit", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-command-"));
  const ledger = new MessageCommandLedgerStore({ dataDir });
  context.after(async () => {
    ledger.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  ledger.accept({
    item: { clientUserMessageId: "message-1", createdAt: "2026-08-25T12:00:00.000Z" },
    destination: "queued",
    receipt: { clientUserMessageId: "message-1", fingerprint: "fingerprint-1" },
  });
  ledger.transition({ clientUserMessageId: "message-1", state: "started" });
  let transitionUnavailable = true;
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
    messageCommands: {
      transitionMessageCommand: (value) => {
        if (transitionUnavailable) throw new Error("simulated cross-database crash");
        return ledger.transition(value);
      },
    },
    logger: { error() {} },
  });

  const committed = await terminal.commit(completion(), {
    run: { id: "run-1", clientUserMessageId: "message-1" },
  });
  assert.equal(committed.commandReconciled, false);
  assert.equal(ledger.get("message-1").state, "started");

  transitionUnavailable = false;
  await terminal.pending();
  assert.equal(ledger.get("message-1").state, "completed");
  assert.equal(ledger.get("message-1").result.terminalRevision, 1);
});

test("Telegram channel intent survives projection ACK and records uncertain then acked", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-channel-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const committed = await terminal.commit(completion(), {
    channelIntents: {
      telegram: {
        requested: true,
        run: { provider: "codex", threadId: "thread-1", turnId: "turn-1", chatId: 7 },
        message: "Final answer",
      },
    },
  });
  assert.equal(committed.outbox.channels.telegram.state, "intent");

  const projection = await terminal.claim(committed.outbox);
  await terminal.acknowledge(projection);
  assert.equal((await terminal.pending())[0].channels.projection.state, "delivered");
  assert.equal((await terminal.pending())[0].channels.telegram.state, "intent");

  const materialized = [];
  const restarted = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: terminal,
    taskRuns: { forEvent: () => null },
    persistHistory: async () => assert.fail("delivered projection must not repeat"),
    projectTurn: async () => assert.fail("delivered projection must not repeat"),
    finalizeRunDelivery: async (run, options) => materialized.push({ run, options }),
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    logger: { error() {} },
  });
  await restarted.retryPending();
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0].options.terminalIntent.terminalRevision, 1);

  const uncertain = await terminal.markChannelUncertain(committed.outbox, { deliveryId: "delivery-1" });
  assert.equal(uncertain.channels.telegram.state, "uncertain");
  const acked = await terminal.acknowledgeChannel(committed.outbox, { deliveryId: "delivery-1" });
  assert.equal(acked.channels.telegram.state, "acked");
  assert.deepEqual(await terminal.pending(), []);
});
