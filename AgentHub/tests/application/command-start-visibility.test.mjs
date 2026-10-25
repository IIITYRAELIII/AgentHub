import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { messageCommandFixture } from "../fixtures/message-command-ledger.mjs";

const source = process.env.AGENT_HUB_TEST_SOURCE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.AGENT_HUB_TEST_SOURCE_ROOT)}/`)
  : new URL("../../", import.meta.url);
const { MessageCommandLedgerStore } = await import(new URL("src/infrastructure/persistence/message-command-ledger-store.mjs", source));
const { DeferredInputPresentationService } = await import(new URL("src/interfaces/desktop/deferred-input-presentation-service.mjs", source));
const { TerminalTurnCommitService } = await import(new URL("src/application/terminal-turn-commit-service.mjs", source));
const { ProviderTurnTerminalStore } = await import(new URL("src/infrastructure/persistence/provider-turn-terminal-store.mjs", source));

// An unrelated queue enumeration can be slow or unavailable. Saving one known
// command must not depend on that enumeration; reopening still uses all records.
class PointReadLedger extends MessageCommandLedgerStore {
  activeRecords() { throw new Error("unrelated active-lane enumeration unavailable"); }
  projectionRecords() { throw new Error("unrelated history enumeration unavailable"); }
}

async function ledger(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "start-visible-"));
  const store = new PointReadLedger({ dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const command = messageCommandFixture({ clientUserMessageId: "target", itemId: "target-item", fingerprint: "target-fp" });
  const other = messageCommandFixture({ clientUserMessageId: "other", itemId: "other-item", fingerprint: "other-fp" });
  store.accept({ ...command, destination: "queued" });
  store.accept({ ...other, destination: "queued" });
  return { store, command, other };
}

test("saving one command snapshot does not enumerate unrelated lanes or change their revision", async t => {
  const { store, command, other } = await ledger(t);
  const unchanged = store.get(other.item.clientUserMessageId);
  assert.deepEqual(store.projectSnapshot({ queuedInputs: [command.item], desktopMessageReceipts: [command.receipt] }), { scanned: 1, changed: 1 });
  assert.deepEqual(store.get(other.item.clientUserMessageId), unchanged);
  assert.equal(store.get(command.item.clientUserMessageId).state, "queued");
  assert.deepEqual(store.projectSnapshot({}), { scanned: 0, changed: 0 });
});

test("snapshot compaction point-reads owned identities and keeps unowned legacy payloads", async t => {
  const { store, command } = await ledger(t);
  store.transition({ clientUserMessageId: command.item.clientUserMessageId, state: "completed", result: { completed: true, accepted: true } });
  const foreign = { id: "unowned", clientUserMessageId: "unowned", input: "legacy payload" };
  const snapshot = { queuedInputs: [command.item, foreign], desktopMessageReceipts: [command.receipt], activeRuns: [{ id: "live-run" }] };
  const compacted = store.withoutOwnedProjections(snapshot);
  assert.deepEqual(compacted.queuedInputs, [foreign]);
  assert.deepEqual(compacted.desktopMessageReceipts, []);
  assert.deepEqual(compacted.activeRuns, snapshot.activeRuns);
  assert.equal(snapshot.queuedInputs.length, 2);
});

const admittedAt = "2026-10-20T23:50:40.151Z";
const acceptedAt = "2026-10-20T23:51:11.587Z";
function presentation(run) {
  let result;
  const service = new DeferredInputPresentationService({ telegram: async () => {},
    receipts: { updateResult: (_identity, value) => { result = value; } }, describeAttachments: () => [] });
  service.updateDesktopReceipt({ id: "item", provider: "codex", threadId: "thread", clientUserMessageId: "command" }, "started", run);
  return result;
}

test("receipt delivery time follows exact provider acceptance rather than internal run creation", () => {
  const result = presentation({ id: "run", turnId: "turn", startedAt: admittedAt,
    providerStart: { state: "accepted-awaiting-first-event", turnId: "turn", acceptedAt } });
  assert.equal(result.providerAccepted, true);
  assert.equal(result.deliveredAt, acceptedAt);
  assert.equal(result.startedAt, acceptedAt);
  assert.equal(result.admittedAt, admittedAt);
});

test("slow requesting or foreign provider turn cannot supply a delivered timestamp", () => {
  for (const providerStart of [{ state: "requesting", turnId: null },
    { state: "observed", turnId: "different-turn", acceptedAt }]) {
    const result = presentation({ id: "run", turnId: "turn", startedAt: admittedAt, providerStart });
    assert.equal(result.providerAccepted, false);
    assert.equal(result.deliveredAt, null);
    assert.equal(result.startedAt, null);
    assert.equal(result.admittedAt, admittedAt);
  }
});

test("durable terminal and reopen preserve actual command start separately from accounting start", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "accepted-terminal-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const transitions = [];
  const messageCommands = { transitionMessageCommand: async value => { transitions.push(value); return { changed: true }; } };
  const store = new ProviderTurnTerminalStore({ dataDir });
  const identity = { provider: "codex", threadId: "thread", turnId: "turn" };
  const run = { ...identity, id: "run", clientUserMessageId: "command", startedAt: admittedAt,
    providerStart: { state: "observed", turnId: "turn", acceptedAt } };
  const service = new TerminalTurnCommitService({ store, messageCommands });
  await service.commit({ ...identity, clientUserMessageId: "command", startedAt: admittedAt,
    completedAt: "2026-10-20T23:51:28.167Z", status: "completed", finalAnswer: "finished" }, { run });
  assert.equal(transitions.at(-1).result.startedAt, acceptedAt);
  assert.equal(transitions.at(-1).result.admittedAt, admittedAt);
  const terminal = await store.get(identity);
  assert.equal(terminal.payload.completion.startedAt, admittedAt);
  assert.equal(terminal.payload.completion.providerAcceptedAt, acceptedAt);
  const reopened = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }), messageCommands });
  await reopened.get(identity);
  assert.equal(transitions.at(-1).result.startedAt, acceptedAt);
});

test("explicit unknown provider time cannot inherit a stale delivery timestamp on reopen", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "unknown-provider-time-"));
  const store = new MessageCommandLedgerStore({ dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const command = messageCommandFixture({ clientUserMessageId: "unknown-time", fingerprint: "unknown-time-fp" });
  store.accept({ ...command, destination: "queued" });
  store.transition({ clientUserMessageId: "unknown-time", state: "completed", result: {
    accepted: true, completed: true, providerAcceptedAt: null, startedAt: null, deliveredAt: admittedAt,
  } });
  const receipt = store.overlay({}).desktopMessageReceipts[0].result;
  assert.equal(receipt.completed, true);
  assert.equal(receipt.startedAt, null);
  assert.equal(receipt.deliveredAt, null);
});

test("terminal acceptance time cannot come from a different provider turn", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "foreign-acceptance-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const transitions = [];
  const service = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir }),
    messageCommands: { transitionMessageCommand: async value => { transitions.push(value); return {}; } } });
  const identity = { provider: "codex", threadId: "thread", turnId: "terminal-turn" };
  const result = await service.commit({ ...identity, clientUserMessageId: "command", startedAt: admittedAt,
    status: "completed", finalAnswer: "finished" }, { run: {
    ...identity, turnId: "different-turn", id: "run", clientUserMessageId: "command",
    providerStart: { state: "observed", turnId: "different-turn", acceptedAt },
  } });
  assert.equal(result.terminal.payload.completion.providerAcceptedAt, null);
  assert.equal(transitions.at(-1).result.startedAt, null);
});

for (const timing of ["known", "unknown", "legacy"]) {
  test(`terminal retry tombstone retains ${timing} timing semantics after default retention and reopen`, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "retained-start-"));
    let store;
    t.after(async () => { store?.close(); await rm(dataDir, { recursive: true, force: true }); });
    let clock = Date.parse("2026-10-21T01:00:20.000Z");
    const command = messageCommandFixture({ clientUserMessageId: "retained", fingerprint: "retained-fp" });
    store = new MessageCommandLedgerStore({ dataDir, now: () => clock });
    store.accept({ ...command, destination: "queued" });
    store.transition({ clientUserMessageId: "retained", state: "completed", result: {
      accepted: true, completed: true, provider: "codex", threadId: "thread", turnId: "turn",
      terminalRevision: 1, displayText: "payload must leave the hot row", attachments: [{ id: "payload" }],
      startedAt: admittedAt, deliveredAt: admittedAt,
      ...(timing === "legacy" ? {} : { providerAcceptedAt: timing === "known" ? acceptedAt : null, admittedAt }),
    } });
    store.close();
    clock += 31 * 24 * 60 * 60 * 1000;
    store = new MessageCommandLedgerStore({ dataDir, now: () => clock });
    const row = store.get("retained");
    assert.ok(row.archivedAtMs);
    assert.equal(row.item, null);
    assert.equal(row.receipt, null);
    assert.equal(Object.hasOwn(row.result, "displayText"), false);
    assert.equal(Object.hasOwn(row.result, "attachments"), false);
    const projected = store.projectReceipt(command.receipt).result;
    assert.equal(Object.hasOwn(projected, "providerAcceptedAt"), timing !== "legacy");
    assert.equal(Object.hasOwn(projected, "admittedAt"), timing !== "legacy");
    assert.equal(projected.startedAt, timing === "known" ? acceptedAt : null);
    assert.equal(projected.deliveredAt ?? null, timing === "known" ? acceptedAt : null);
    if (timing !== "legacy") {
      assert.equal(projected.providerAcceptedAt, timing === "known" ? acceptedAt : null);
      assert.equal(projected.admittedAt, admittedAt);
    }
    const retry = store.accept({ ...command, destination: "queued" });
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.retryResult, projected);
    assert.equal(store.get("retained").revision, row.revision);
    assert.equal(projected.completed, true);
    assert.equal(projected.terminalRevision, 1);
  });
}
