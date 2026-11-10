import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";
import { createDesktopTaskHistoryFactory, mergeCachedTaskHistory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";

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
          ...(terminal.rootClientUserMessageId ? { clientUserMessageId: terminal.rootClientUserMessageId } : {}),
          ...(terminal.rootAttachments ? { messageAttachments: terminal.rootAttachments } : {}),
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
        const attachments = terminal.attachmentsByCommand?.[user.clientUserMessageId];
        insertLedger.run(user.clientUserMessageId, JSON.stringify(exact),
          JSON.stringify({ ...exact, result: { ...result,
            ...(attachments ? { attachments } : {}) } }), JSON.stringify(result));
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

test("terminal recovery preserves accepted attachments and repairs the prior recovery version once", async (t) => {
  const image = { id: "original-screen.png", name: "image.png", type: "image/png" };
  const turns = [legacyTurn("intact"), { ...legacyTurn("previously-recovered", "01"),
    userMessageAuthority: "terminal-ledger" }];
  turns[0].messages[0] = { role: "user", clientUserMessageId: "intact-command", text: "Screenshot", attachments: [image] };
  const f = await fixture(t, [[task, turns]], turns.map((turn) => ({
    turnId: turn.id,
    users: [{ role: "user", clientUserMessageId: `${turn.id}-command`, text: "Screenshot" }],
    attachmentsByCommand: { [`${turn.id}-command`]: [image] },
  })));
  const first = await f.store.readHistoryPage([task], { limit: 2 });
  for (const { turn } of first.items) {
    assert.equal(turn.userMessageAuthority, "terminal-ledger");
    assert.equal(turn.userMessageRecoveryVersion, 2);
    assert.deepEqual(turn.messages.find((message) => message.role === "user").attachments, [image]);
  }
  const observer = new DatabaseSync(f.options.databaseFile, { readOnly: true });
  try {
    const beforeVersion = observer.prepare("PRAGMA data_version").get();
    assert.deepEqual(await f.store.readHistoryPage([task], { limit: 2 }), first);
    assert.deepEqual(observer.prepare("PRAGMA data_version").get(), beforeVersion);
  } finally { observer.close(); }
  await f.reopen();
  assert.deepEqual(await f.store.readHistoryPage([task], { limit: 2 }), first);
  await f.store.recordHistory(task, turns);
  assert.deepEqual(await f.store.readHistoryPage([task], { limit: 2 }), first);
  // A fresh Desktop owner has no receipt/cache fallback after reopening.
  const desktopHistory = createDesktopTaskHistoryFactory({
    selection: { activeProvider: () => task.provider, threadId: () => task.threadId, chatId: () => null },
    catalog: { entries: () => [{ ...task, streamId: "attachment-stream" }] },
    historyReader: { readPage: (references, options) => f.store.readHistoryPage(references, options) },
    runs: { forTask: () => null },
    historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
    receipts: { forMessage: () => null, forTurn: () => [] },
    responseBudget: { fit: (payload) => payload },
    attachmentImporter: async () => { assert.fail("accepted attachments need no provider reimport"); },
  });
  const projected = await desktopHistory({ ...task, streamId: "attachment-stream", includeActive: false, limit: 2 });
  for (const turn of projected.items) {
    assert.deepEqual(turn.messages.find((message) => message.role === "user").attachments, [image]);
  }
});

test("exact command receipts keep root, steer and external attachments separate", async (t) => {
  const rootImage = { id: "root.png", name: "same.png", type: "image/png" };
  const steerImage = { id: "steer.png", name: "same.png", type: "image/png" };
  const externalImage = { id: "external.png", name: "same.png", type: "image/png" };
  const turn = legacyTurn("mixed-attachments");
  const f = await fixture(t, [[task, [turn]]], [{
    turnId: turn.id, rootClientUserMessageId: "root-command", rootAttachments: [rootImage],
    users: [
      { role: "user", clientUserMessageId: "root-command", text: "Same" },
      { role: "user", clientUserMessageId: "steer-command", text: "Same" },
      { role: "user", clientUserMessageId: "text-command", text: "Same" },
      { role: "user", itemId: "external", text: "Same", attachments: [externalImage] },
    ],
    attachmentsByCommand: { "steer-command": [steerImage], "text-command": [] },
  }]);
  const page = await f.store.readHistoryPage([task], { limit: 1 });
  const users = page.items[0].turn.messages.filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => message.attachments), [[rootImage], [steerImage], [], [externalImage]]);
});

test("attachment recovery fails closed for a receipt bound to a different run", async (t) => {
  const turn = { ...legacyTurn("foreign-attachment"), userMessageAuthority: "terminal-ledger" };
  const image = { id: "foreign.png", name: "image.png", type: "image/png" };
  const f = await fixture(t, [[task, [turn]]], [{ turnId: turn.id, invalid: "conflict",
    users: [{ role: "user", clientUserMessageId: "foreign-command", text: "Screenshot" }],
    attachmentsByCommand: { "foreign-command": [image] } }]);
  const before = f.store.historyPage([task], { limit: 1 });
  assert.deepEqual(await f.store.readHistoryPage([task], { limit: 1 }), before);
});

test("legacy root attachments require the exact root command identity", async (t) => {
  const image = { id: "root-only.png", name: "image.png", type: "image/png" };
  const turn = legacyTurn("unknown-root");
  const f = await fixture(t, [[task, [turn]]], [{
    turnId: turn.id, rootAttachments: [image],
    users: [{ role: "user", clientUserMessageId: "known-command", text: "Screenshot" }],
  }]);
  const page = await f.store.readHistoryPage([task], { limit: 1 });
  assert.deepEqual(page.items[0].turn.messages.find((message) => message.role === "user").attachments, []);
});

test("attachment upgrade repairs recent custody without repeating the completed global journal backfill", async (t) => {
  const image = { id: "recent.png", name: "image.png", type: "image/png" };
  const unrelated = { ...task, threadId: "unopened-journal-thread" };
  const old = legacyTurn("unopened-journal-turn");
  const target = { ...legacyTurn("recent-custody"), userMessageAuthority: "terminal-ledger" };
  const f = await fixture(t, [[task, [target]], [unrelated, [old]]], [{
    turnId: target.id,
    users: [{ role: "user", clientUserMessageId: "recent-command", text: "Screenshot" }],
    attachmentsByCommand: { "recent-command": [image] },
  }]);
  const before = f.store.history(unrelated);
  f.store.close();
  const terminal = new DatabaseSync(f.options.terminalDatabaseFile);
  try { terminal.prepare("DELETE FROM provider_turn_terminals WHERE thread_id = ?").run("unrelated-new-thread"); }
  finally { terminal.close(); }
  const database = new DatabaseSync(f.options.databaseFile);
  try {
    database.exec(`
      CREATE TABLE journal_records (provider TEXT, thread_id TEXT, task_thread_id TEXT,
        turn_id TEXT, record_json TEXT, PRIMARY KEY(provider, thread_id, turn_id));
      CREATE TABLE journal_store_meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO journal_store_meta VALUES ('revision', '1');
      CREATE TABLE unrelated_history_write_audit (event TEXT);
      CREATE TRIGGER audit_unopened_history_delete BEFORE DELETE ON task_read_model_turns
        WHEN old.thread_id = 'unopened-journal-thread'
        BEGIN INSERT INTO unrelated_history_write_audit VALUES ('delete'); END;
    `);
    database.prepare("INSERT INTO journal_records VALUES (?, ?, ?, ?, ?)").run(
      unrelated.provider, unrelated.threadId, unrelated.threadId, old.id,
      JSON.stringify({ status: "completed", prompt: "Unrelated canonical journal prompt", body: "Answer" }),
    );
    const meta = database.prepare("INSERT OR REPLACE INTO task_read_model_meta VALUES (?, ?)");
    meta.run("backfill_terminal_task_history_version", "4");
    meta.run("backfill_models_from_journal_version", "1:revision:1");
    meta.run("backfill_subagent_models_from_journal_version", "1:revision:1");
    meta.run("backfill_journal_message_search_version", "5:revision:1");
  } finally { database.close(); }
  await f.reopen();
  const observer = new DatabaseSync(f.options.databaseFile, { readOnly: true });
  try {
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM unrelated_history_write_audit").get().count, 0);
    assert.equal(observer.prepare("SELECT value FROM task_read_model_meta WHERE key = ?")
      .get("backfill_terminal_task_history_version").value, "4");
  } finally { observer.close(); }
  assert.deepEqual(f.store.history(unrelated), before);
  const recovered = f.store.history(task)[0];
  assert.equal(recovered.userMessageRecoveryVersion, 2);
  assert.deepEqual(recovered.messages.find((message) => message.clientUserMessageId === "recent-command").attachments, [image]);
});
