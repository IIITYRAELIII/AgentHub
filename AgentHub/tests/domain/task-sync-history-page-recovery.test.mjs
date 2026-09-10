import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { mergeCachedTaskHistory } from "../../src/interfaces/desktop/desktop-task-history.mjs";

const task = { provider: "codex", threadId: "old-page-thread", title: "Old history" };

function legacyTurn(id, minute = "00") {
  return {
    id,
    prompt: "Повторённое сообщение",
    answer: "Ответ",
    status: "completed",
    completed: true,
    active: false,
    startedAt: `2026-09-01T12:${minute}:00.000Z`,
    messages: [
      { role: "user", itemId: `${id}:rollout-user:0`, text: "Повторённое сообщение" },
      { role: "user", itemId: `${id}:rollout-user:0`, text: "Повторённое сообщение" },
      { role: "agent", itemId: `${id}:final`, text: "Ответ" },
    ],
  };
}

async function fixture(t, histories, terminals) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-history-page-recovery-"));
  const options = {
    filePath: path.join(directory, "task-sync.json"),
    databaseFile: path.join(directory, "journal.sqlite"),
    terminalDatabaseFile: path.join(directory, "runtime.sqlite"),
    messageCommandDatabaseFile: path.join(directory, "message-command-ledger.sqlite"),
  };
  let store = new LocalTaskSyncStore(options);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.load();
  for (const [reference, turns] of histories) await store.recordHistory(reference, turns);
  store.close();

  const terminalDb = new DatabaseSync(options.terminalDatabaseFile);
  const ledgerDb = new DatabaseSync(options.messageCommandDatabaseFile);
  try {
    terminalDb.exec(`
      CREATE TABLE provider_turn_terminals (
        provider TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, payload_bytes INTEGER NOT NULL, committed_at TEXT NOT NULL,
        PRIMARY KEY (provider, thread_id, turn_id)
      ) WITHOUT ROWID;
      CREATE INDEX provider_turn_terminals_recovery_idx
        ON provider_turn_terminals(committed_at DESC, provider, thread_id, turn_id, payload_bytes);
    `);
    ledgerDb.exec(`
      CREATE TABLE message_commands (
        client_user_message_id TEXT PRIMARY KEY, state TEXT NOT NULL,
        item_json TEXT, receipt_json TEXT, result_json TEXT
      ) WITHOUT ROWID;
    `);
    const insertTerminal = terminalDb.prepare("INSERT INTO provider_turn_terminals VALUES (?, ?, ?, ?, ?, ?)");
    const insertLedger = ledgerDb.prepare("INSERT INTO message_commands VALUES (?, 'completed', ?, ?, ?)");
    for (const terminal of terminals) {
      const { reference = task, turnId, users, invalid, padding = "" } = terminal;
      const runId = `run-${turnId}`;
      const payload = JSON.stringify({
        history: {
          id: runId, provider: reference.provider, threadId: reference.threadId,
          turnId, promptPreview: "Канонический вопрос", userMessages: users,
        },
        padding,
      });
      insertTerminal.run(reference.provider, reference.threadId, turnId, payload,
        Buffer.byteLength(payload), "2026-09-01T13:00:00.000Z");
      for (const user of users) {
        if (!user.clientUserMessageId || invalid === "missing") continue;
        const exact = {
          provider: reference.provider, threadId: reference.threadId, turnId, runId,
          clientUserMessageId: user.clientUserMessageId,
        };
        const result = invalid === "conflict" ? { ...exact, runId: "another-run" } : exact;
        insertLedger.run(user.clientUserMessageId, JSON.stringify(exact),
          JSON.stringify({ ...exact, result }), JSON.stringify(result));
      }
    }
    // The requested turn is older than the bounded startup recovery window.
    for (let index = 0; index < 201; index += 1) {
      insertTerminal.run("codex", "unrelated-new-thread", `new-${index}`, "{}", 2,
        "2026-09-09T00:00:00.000Z");
    }
  } finally {
    terminalDb.close();
    ledgerDb.close();
  }
  store = new LocalTaskSyncStore(options);
  await store.load();
  return {
    get store() { return store; },
    options,
    async reopen() {
      store.close();
      store = new LocalTaskSyncStore(options);
      await store.load();
      return store;
    },
  };
}

test("opening an old page recovers exact terminal users without repairing unopened turns or replaying aliases", async (t) => {
  const origin = {
    kind: "interstream", workspaceId: "source", workspaceName: "Source",
    streamId: "review", streamName: "Review", provider: "codex", requestId: "request",
  };
  const users = [
    { role: "user", itemId: "accepted-a", clientUserMessageId: "accepted-a", text: "Одинаково", origin },
    { role: "user", itemId: "accepted-b", clientUserMessageId: "accepted-b", text: "Одинаково" },
    { role: "user", itemId: "external-a", text: "Одинаково" },
    { role: "user", itemId: "external-b", text: "Одинаково" },
  ];
  const unopened = legacyTurn("unopened");
  const target = legacyTurn("requested", "01");
  const f = await fixture(t, [[task, [unopened, target]]], [
    { turnId: target.id, users },
    { turnId: unopened.id, users: [{ role: "user", clientUserMessageId: "unopened-command", text: "Не открывали" }] },
  ]);
  const before = f.store.history(task);
  assert.equal(before.every((turn) => !turn.userMessageAuthority), true);
  const untouched = structuredClone(before.find((turn) => turn.id === unopened.id));
  const cached = structuredClone(before.find((turn) => turn.id === target.id));
  const page = await f.store.readHistoryPage([task], { limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  const repaired = page.items[0].turn;
  assert.equal(repaired.id, target.id);
  assert.equal(repaired.userMessageAuthority, "terminal-ledger");
  assert.deepEqual(repaired.messages.filter((message) => message.role === "user")
    .map((message) => message.clientUserMessageId ?? message.itemId),
  ["accepted-a", "accepted-b", "external-a", "external-b"]);
  assert.deepEqual(repaired.messages[0].origin, origin);
  assert.equal(repaired.messages.filter((message) => message.role === "agent").length, 1);
  assert.deepEqual(f.store.history(task).find((turn) => turn.id === unopened.id), untouched);
  assert.equal(page.messageTotal, 8);

  const search = new DatabaseSync(f.options.databaseFile, { readOnly: true });
  try {
    const documents = search.prepare(`
      SELECT item_id FROM task_message_search_documents
      WHERE provider = ? AND thread_id = ? AND turn_id = ? AND role = 'user' AND source = 'history'
      ORDER BY item_id
    `).all(task.provider, task.threadId, target.id);
    assert.deepEqual(documents.map((row) => row.item_id), ["accepted-a", "accepted-b", "external-a", "external-b"]);
  } finally {
    search.close();
  }
  assert.deepEqual(await f.store.readHistoryPage([task], { limit: 1 }), page);
  const merged = mergeCachedTaskHistory([cached], [repaired]);
  assert.deepEqual(merged[0].messages.filter((message) => message.role === "user"),
    repaired.messages.filter((message) => message.role === "user"));

  await f.store.recordHistory(task, [unopened, target]);
  const refreshed = await f.store.readHistoryPage([task], { limit: 1 });
  assert.deepEqual(refreshed.items[0].turn.messages.filter((message) => message.role === "user"),
    repaired.messages.filter((message) => message.role === "user"));
  await f.reopen();
  assert.deepEqual(await f.store.readHistoryPage([task], { limit: 1 }), refreshed);
  assert.deepEqual(f.store.history(task).find((turn) => turn.id === unopened.id), untouched);
});

for (const invalid of ["missing", "conflict", "oversized"]) {
  test(`old history page remains unchanged with ${invalid} terminal evidence`, async (t) => {
    const turn = legacyTurn(`invalid-${invalid}`);
    const f = await fixture(t, [[task, [turn]]], [{
      turnId: turn.id,
      users: [{ role: "user", clientUserMessageId: `${invalid}-command`, text: "Не заменять" }],
      invalid,
      ...(invalid === "oversized" ? { padding: "x".repeat(2 * 1024 * 1024) } : {}),
    }]);
    const before = f.store.historyPage([task], { limit: 1 });
    assert.equal(before.items[0].turn.userMessageAuthority, undefined);
    assert.deepEqual(await f.store.readHistoryPage([task], { limit: 1 }), before);
    assert.deepEqual(await f.store.readHistoryPage([task], { limit: 1 }), before);
    await f.reopen();
    assert.deepEqual(await f.store.readHistoryPage([task], { limit: 1 }), before);
  });
}
