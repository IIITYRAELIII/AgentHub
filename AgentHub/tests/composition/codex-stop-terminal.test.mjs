import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import { CodexCompletionService } from "../../src/providers/provider-completion-services.mjs";
import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";
import { TurnEndDeliveryService } from "../../src/application/turn-end-delivery-service.mjs";
import { RunJournalService } from "../../src/application/run-journal-service.mjs";
import { mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { ProviderTurnTerminalStore } from "../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { MessageCommandLedgerStore } from "../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { messageCommandFixture } from "../fixtures/message-command-ledger.mjs";

test("Codex interrupted event remains cancelled through terminal, receipt, last-message history and reload", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-codex-stop-"));
  let ledger = new MessageCommandLedgerStore({ dataDir });
  const store = new ProviderTurnTerminalStore({ dataDir });
  t.after(async () => { ledger.close(); await rm(dataDir, { recursive: true, force: true }); });
  const command = messageCommandFixture();
  ledger.accept({ ...command, destination: "queued" });
  ledger.transition({ clientUserMessageId: command.item.clientUserMessageId, expectedStates: ["queued"], state: "started" });
  const run = { id: "run-stop", provider: "codex", threadId: command.item.threadId, turnId: "turn-stop",
    clientUserMessageId: command.item.clientUserMessageId, status: "running", responseText: "HUB_STOP_READY_20261016",
    startedAt: "2026-10-15T21:18:04.505Z" };
  const terminal = new TerminalTurnCommitService({ store,
    messageCommands: { transitionMessageCommand: async transition => ledger.transition(transition) } });
  const journal = new RunJournalService({});
  const delivery = new TurnEndDeliveryService({ notifications: {},
    rememberLastMessage: (...args) => journal.rememberLastMessage(...args), rememberSeenTurn: () => {} });
  let committed;
  const provider = new CodexCompletionService({
    runForTask: () => run, consumeTracker: () => null, waitForCompletion: async () => null,
    completedAnswer: async () => run.responseText, finishProgress: async () => {}, rememberSeenTurn: () => {},
    rememberLastMessage: (...args) => journal.rememberLastMessage(...args),
    temporaryFiles: new Map(), speechButtons: new Map(),
    finalizeDelivery: async (_run, result) => {
      committed = await terminal.commit({ provider: run.provider, threadId: run.threadId, turnId: run.turnId,
        clientUserMessageId: run.clientUserMessageId, status: result.status, finalAnswer: result.answer,
        startedAt: run.startedAt, completedAt: "2026-10-15T21:18:45.435Z" }, { run });
      delivery.rememberCompletion(committed.terminal.payload.completion, result.answer);
    },
  });
  // Actual App Server turn/completed shape observed after successful turn/interrupt.
  const event = { method: "turn/completed", params: { threadId: run.threadId,
    turn: { id: run.turnId, status: "interrupted", items: [
      { type: "agentMessage", id: "commentary", phase: "commentary", text: run.responseText },
    ] } } };
  await provider.completeManaged(run, { eventTurn: event.params.turn });
  assert.equal(committed.terminal.status, "aborted");
  assert.equal(committed.terminal.payload.completion.status, "aborted");
  assert.equal(committed.terminal.lastMessage.status, "aborted");
  const receipt = ledger.projectReceipt(command.receipt).result;
  assert.equal(receipt.commandState, "cancelled"); assert.equal(receipt.cancelled, true);
  assert.equal(receipt.failed, false); assert.equal(receipt.completed, false);
  const last = journal.lastMessageRecord(run);
  assert.equal(last.status, "aborted");
  const history = [{ id: run.turnId, status: "interrupted", answer: run.responseText, active: false, completed: true }];
  mergeCompletedTaskHistory(history, { ...last, answer: last.text });
  assert.equal(history[0].status, "aborted"); assert.equal(history[0].active, false);
  mergeCompletedTaskHistory(history, { turnId: run.turnId, answer: last.text });
  assert.equal(history[0].status, "aborted", "a legacy text-only last answer cannot imply success");
  const browser = vm.createContext({});
  vm.runInContext(await readFile(new URL("../../assets/web-app/messages/projection.js", import.meta.url), "utf8"), browser);
  assert.equal(browser.AgentHubMessageProjection.projectionState({
    status: history[0].status, terminalRevision: committed.terminal.terminalRevision,
    running: history[0].active, operationKind: "user-turn",
  }), "cancelled", "reload of canonical aborted history keeps the stopped UI state");
  ledger.close(); ledger = new MessageCommandLedgerStore({ dataDir });
  assert.equal(ledger.projectReceipt(command.receipt).result.commandState, "cancelled");
  assert.equal((await terminal.get(run)).status, "aborted");
});
