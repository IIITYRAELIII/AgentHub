import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import {
  ensureJournalProjectionFromFile,
  replaceJournalProjectionFromHtml,
  replaceJournalProjectionFromMarkdown,
} from "../../../src/application/journal-projection-service.mjs";

function turn(id, text) {
  const reference = Buffer.from(JSON.stringify(["codex", "thread-1", id]), "utf8")
    .toString("base64url");
  return {
    reference,
    html: [
      `<div data-work-log-turn-entry data-work-log-turn-id="${id}"`,
      ' data-work-log-turn-provider="codex" data-work-log-turn-thread-id="thread-1">',
      '<details data-work-log-turn-details>',
      `<summary>${text}</summary>`,
      `<div data-work-log-turn-expanded>${text} body</div>`,
      "</details></div>",
    ].join(""),
  };
}

function day(date, item) {
  return [
    "<details data-work-log-day-section>",
    `<summary data-work-log-day><strong>${date}</strong></summary>`,
    item.html,
    "</details>",
  ].join("");
}

function accountPanel() {
  return [
    "<!-- work-log-account-panel:start -->",
    '<section data-work-log-account-panel>',
    '<div data-work-log-account-panel-head>Расход по аккаунтам</div>',
    "</section>",
    "<!-- work-log-account-panel:end -->",
  ].join("");
}

function indexedDay(date, {
  turnRef,
  turnId,
  credits,
  completedAt,
} = {}) {
  return [
    '<details data-work-log-day-section><summary data-work-log-day>',
    `<strong>${date}</strong></summary>`,
    '<details data-work-log-workspace data-work-log-workspace-id="workspace-1"',
    ' data-work-log-workspace-kind="catalog"><summary><strong>Agent HUB</strong></summary>',
    '<details data-work-log-stream data-work-log-stream-id="stream-1">',
    '<summary><span data-work-log-stream-title>Architect</span></summary>',
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-1"',
    ' data-work-log-workspace-id="workspace-1" data-work-log-stream-id="stream-1">',
    '<div data-work-log-task-content>Задача</div><div data-work-log-turn-list>',
    '<div data-work-log-turn-entry data-work-log-turn-provider="codex"',
    ' data-work-log-turn-thread-id="thread-1" data-work-log-turn-depth="0"',
    ` data-work-log-turn-id="${turnId}" data-work-log-turn-credits="${credits}"`,
    ` data-work-log-turn-duration-seconds="60" data-work-log-turn-completed-at="${completedAt}">`,
    `<details data-work-log-turn-details data-lazy-turn-id="${turnRef}">`,
    `<summary>${turnId}</summary><div data-lazy-turn-content></div></details>`,
    "</div></div></div></details></details></details>",
  ].join("");
}

function record(turnId, overrides = {}) {
  return {
    provider: "codex",
    threadId: "thread-1",
    turnId,
    taskThreadId: "thread-1",
    projectRoot: "D:/workspace",
    taskTitle: "Задача",
    title: `Ход ${turnId}`,
    body: `Ответ ${turnId}`,
    prompt: `Запрос ${turnId}`,
    completedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

async function eventually(operation, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test("canonical SQLite ledger replaces, upserts and deletes records transactionally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-ledger-"));
  const file = path.join(root, "journal.sqlite");
  const first = new JournalDatabase(file);
  try {
    const replaced = await first.replaceLedger({
      version: 8,
      turns: {
        "codex\0thread-1\0turn-1": record("turn-1"),
        "claude\0thread-2\0turn-2": record("turn-2", {
          provider: "claude",
          threadId: "thread-2",
          taskThreadId: "thread-2",
        }),
      },
    });
    assert.equal(replaced.replaced, 2);
    assert.equal(replaced.revision, 1);

    await assert.rejects(
      first.replaceLedger({ version: 8, turns: {} }, { expectedRevision: 0 }),
      /revision conflict/u,
    );
    assert.equal(Object.keys((await first.loadLedger()).turns).length, 2);

    await first.upsertRecords([record("turn-1", { body: "Исправленный ответ" }), record("turn-3")]);
    const deletion = await first.deleteRecords(["claude\0thread-2\0turn-2"]);
    assert.equal(deletion.deleted, 1);
    assert.equal(deletion.revision, 3);
    first.close();

    const reopened = new JournalDatabase(file);
    const ledger = await reopened.loadLedger();
    assert.equal(ledger.version, 8);
    assert.deepEqual(Object.keys(ledger.turns).sort(), [
      "codex\0thread-1\0turn-1",
      "codex\0thread-1\0turn-3",
    ]);
    assert.equal(ledger.turns["codex\0thread-1\0turn-1"].body, "Исправленный ответ");
    assert.equal((await reopened.getRecord({
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    })).body, "Исправленный ответ");
    assert.deepEqual(
      (await reopened.threadRecords([{ provider: "codex", threadId: "thread-1" }], { limit: 2 }))
        .map((entry) => entry.turnId).sort(),
      ["turn-1", "turn-3"],
    );
    assert.equal(await reopened.currentRevision(), 3);
    reopened.close();
  } finally {
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy ledger primary, backup and delta are incrementally merged and verified", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-import-"));
  const ledgerFile = path.join(root, "work-log-usage.json");
  const database = new JournalDatabase(path.join(root, "journal.sqlite"));
  try {
    await writeFile(`${ledgerFile}.bak`, `${JSON.stringify({
      version: 8,
      turns: {
        "codex\0thread-1\0turn-old": record("turn-old"),
        "codex\0thread-1\0turn-delete": record("turn-delete"),
      },
    })}\n`, "utf8");
    await writeFile(`${ledgerFile}.delta.jsonl`, [
      JSON.stringify({ op: "delete", key: "codex\0thread-1\0turn-delete" }),
      JSON.stringify({
        op: "upsert",
        key: "codex\0thread-1\0turn-new",
        record: record("turn-new"),
      }),
      "",
    ].join("\n"), "utf8");

    const imported = await database.importLegacyLedger(ledgerFile);
    assert.deepEqual({
      imported: imported.imported,
      records: imported.records,
      invalid: imported.invalid,
      recovered: imported.recovered,
      deltaApplied: imported.deltaApplied,
    }, {
      imported: true,
      records: 2,
      invalid: 0,
      recovered: true,
      deltaApplied: 2,
    });
    assert.deepEqual(Object.keys((await database.loadLedger()).turns).sort(), [
      "codex\0thread-1\0turn-new",
      "codex\0thread-1\0turn-old",
    ]);
    assert.equal((await database.verifyLegacyLedger(ledgerFile)).verified, true);

    await writeFile(ledgerFile, `${JSON.stringify({
      version: 8,
      turns: { "codex\0thread-1\0turn-late": record("turn-late") },
    })}\n`, "utf8");
    const repeated = await database.importLegacyLedger(ledgerFile);
    assert.equal(repeated.imported, true);
    assert.equal(repeated.records, 2);
    assert.deepEqual(Object.keys((await database.loadLedger()).turns).sort(), [
      "codex\0thread-1\0turn-late",
      "codex\0thread-1\0turn-new",
    ]);
    assert.equal((await database.verifyLegacyLedger(ledgerFile)).verified, true);

    const unchanged = await database.importLegacyLedger(ledgerFile);
    assert.equal(unchanged.imported, false);
    assert.equal(unchanged.reason, "unchanged");

    await database.upsertRecords([record("database-only")]);
    const diverged = await database.verifyLegacyLedger(ledgerFile);
    assert.equal(diverged.verified, false);
    assert.deepEqual(diverged.extra, ["codex\0thread-1\0database-only"]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy import preserves pre-identity records under a deterministic synthetic thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-legacy-identity-"));
  const ledgerFile = path.join(root, "work-log-usage.json");
  const database = new JournalDatabase(path.join(root, "journal.sqlite"));
  try {
    const workLogId = "123e4567-e89b-42d3-a456-426614174000";
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        "turn-old": {
          workLogId,
          body: "Старый ответ",
          completedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    })}\n`, "utf8");

    const imported = await database.importLegacyLedger(ledgerFile);
    assert.equal(imported.records, 1);
    const ledger = await database.loadLedger();
    const key = `codex\0legacy:${workLogId}\0turn-old`;
    assert.deepEqual(Object.keys(ledger.turns), [key]);
    assert.equal(ledger.turns[key].threadId, `legacy:${workLogId}`);
    assert.equal(ledger.turns[key].body, "Старый ответ");
    assert.equal((await database.verifyLegacyLedger(ledgerFile)).verified, true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("direct projection snapshot preserves lazy journal HTTP contract without a source file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-projection-"));
  const database = new JournalDatabase(path.join(root, "journal.sqlite"));
  const item = turn("turn-old", "Старый ход");
  const dates = ["01.07.2026", "02.07.2026", "31.07.2026", "01.08.2026", "02.08.2026", "03.08.2026"];
  try {
    const change = await replaceJournalProjectionFromMarkdown(database,
      `# Журнал\n${accountPanel()}\n${dates.map((date) => day(date, item)).join("\n")}\n`,
      { updatedAt: "2026-08-01T12:00:00.000Z" },
    );
    assert.equal(change.projected, true);
    const snapshot = await database.snapshot();
    assert.equal(snapshot.updatedAt, "2026-08-01T12:00:00.000Z");
    assert.match(snapshot.version, /^sha256:/u);
    assert.match(snapshot.html, /data-work-log-account-panel/u);
    assert.match(snapshot.html, /data-lazy-day="01\.07\.2026"/u);
    for (const date of dates) {
      assert.match(snapshot.html, new RegExp(`data-lazy-day="${date.replaceAll(".", "\\.")}"`, "u"));
    }
    assert.match(snapshot.days["01.07.2026"], /Старый ход/u);
    assert.deepEqual(Object.keys(snapshot.days), dates);
    assert.match(snapshot.turns[item.reference], /Старый ход body/u);
    assert.match(await database.fragment("turn", item.reference), /Старый ход body/u);
    const dayFragments = await database.fragments("day");
    assert.match(dayFragments["01.07.2026"], /Старый ход/u);
    assert.deepEqual(Object.keys(dayFragments), dates);
    assert.deepEqual(await database.exportPayload(), snapshot);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("materialized journal summary and turn pages survive SQLite reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-virtual-"));
  const file = path.join(root, "journal.sqlite");
  const summary = {
    version: 1,
    buckets: [{
      date: "01.08.2026",
      workspaceId: "workspace-1",
      streamId: "stream-1",
      provider: "codex",
      turnCount: 2,
      credits: 30,
      knownCredits: 2,
      unknownCredits: 0,
      durationSeconds: 90,
      knownDurations: 2,
      unknownDurations: 0,
      latestAt: Date.UTC(2026, 7, 1, 12),
      fileTouches: 2,
      knownFileTouches: 2,
    }, {
      date: "01.08.2026",
      workspaceId: "workspace-2",
      streamId: "stream-2",
      provider: "codex",
      turnCount: 1,
      credits: 10,
      knownCredits: 1,
      unknownCredits: 0,
      durationSeconds: 30,
      knownDurations: 1,
      unknownDurations: 0,
      latestAt: Date.UTC(2026, 7, 1, 11),
      fileTouches: 9,
      knownFileTouches: 1,
    }],
  };
  const entries = [
    {
      turnRef: "turn-ref-new",
      date: "01.08.2026",
      dayMs: Date.UTC(2026, 7, 1),
      workspaceId: "workspace-1",
      streamId: "stream-1",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-new",
      completedAtMs: Date.UTC(2026, 7, 1, 12),
      html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-new">Новый</div>',
    },
    {
      turnRef: "turn-ref-old",
      date: "31.07.2026",
      dayMs: Date.UTC(2026, 6, 31),
      workspaceId: "workspace-1",
      streamId: "stream-1",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-old",
      completedAtMs: Date.UTC(2026, 6, 31, 12),
      html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-old">Старый</div>',
    },
    {
      turnRef: "turn-ref-other",
      date: "01.08.2026",
      dayMs: Date.UTC(2026, 7, 1),
      workspaceId: "workspace-2",
      streamId: "stream-2",
      provider: "claude",
      threadId: "thread-2",
      turnId: "turn-other",
      completedAtMs: Date.UTC(2026, 7, 1, 13),
      html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-other">Другой</div>',
    },
  ];
  const database = new JournalDatabase(file);
  try {
    await database.replaceProjection({ html: "<main>Итоги</main>", summary, entries });
    assert.deepEqual((await database.payload()).summary, summary);
    const first = await database.turnPage({ workspaceId: "workspace-1", limit: 1 });
    assert.deepEqual(first.turns.map((entry) => entry.turnRef), ["turn-ref-new"]);
    assert.equal(first.nextOffset, 1);
    const profiled = await database.turnPage({
      workspaceId: "workspace-1",
      streamId: "stream-1",
      profileMode: "stream",
      limit: 1,
    });
    assert.deepEqual(
      profiled.profileSummary.buckets.map((bucket) => bucket.fileTouches),
      [2, 9],
    );
    const second = await database.turnPage({
      workspaceId: "workspace-1",
      fromMs: Date.UTC(2026, 6, 31),
      toMs: Date.UTC(2026, 7, 1),
      limit: 50,
    });
    assert.deepEqual(second.turns.map((entry) => entry.turnRef), ["turn-ref-old"]);
    database.close();

    const reopened = new JournalDatabase(file);
    assert.deepEqual((await reopened.payload()).summary, summary);
    assert.deepEqual(
      (await reopened.turnPage({ workspaceId: "workspace-1", streamId: "stream-1" }))
        .turns.map((entry) => entry.turnRef),
      ["turn-ref-new", "turn-ref-old"],
    );
    assert.deepEqual(
      (await reopened.turnPage({ provider: "claude" })).turns.map((entry) => entry.turnRef),
      ["turn-ref-other"],
    );
    await reopened.replaceProjection({
      html: '<details data-lazy-day="01.08.2026"></details>',
      summary: { version: 1, buckets: [] },
      entries: [],
      virtualDates: [],
      virtualComplete: false,
    });
    assert.deepEqual((await reopened.payload()).summary, summary);
    assert.deepEqual(
      (await reopened.turnPage({ workspaceId: "workspace-1" })).turns
        .map((entry) => entry.turnRef),
      ["turn-ref-new", "turn-ref-old"],
    );
    reopened.close();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("turn paging validates and reads one immutable SQLite version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-page-version-"));
  const file = path.join(root, "journal.sqlite");
  const writer = new JournalDatabase(file);
  let replacement = null;
  let interleaved = false;
  const reader = new JournalDatabase(file, {
    turnPageSnapshotHook: async () => {
      if (interleaved) return;
      interleaved = true;
      replacement = await writer.replaceProjection({
        html: "<main>B</main>",
        summary: { version: 1, buckets: [] },
        entries: [{
          turnRef: "turn-ref-b",
          date: "02.08.2026",
          dayMs: Date.UTC(2026, 7, 2),
          workspaceId: "workspace-1",
          streamId: "stream-1",
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-b",
          completedAtMs: Date.UTC(2026, 7, 2, 12),
          html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-b">B</div>',
        }],
      });
    },
  });
  try {
    const first = await writer.replaceProjection({
      html: "<main>A</main>",
      summary: { version: 1, buckets: [] },
      entries: [{
        turnRef: "turn-ref-a",
        date: "01.08.2026",
        dayMs: Date.UTC(2026, 7, 1),
        workspaceId: "workspace-1",
        streamId: "stream-1",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-a",
        completedAtMs: Date.UTC(2026, 7, 1, 12),
        html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-a">A</div>',
      }],
    });
    const page = await reader.turnPage({
      expectedVersion: first.version,
      workspaceId: "workspace-1",
    });
    assert.equal(page.conflict, false);
    assert.equal(page.version, first.version);
    assert.deepEqual(page.turns.map((entry) => entry.turnRef), ["turn-ref-a"]);
    assert.notEqual(replacement.version, first.version);
    const stale = await reader.turnPage({
      expectedVersion: first.version,
      workspaceId: "workspace-1",
    });
    assert.equal(stale.conflict, true);
    assert.equal(stale.version, replacement.version);
    assert.deepEqual(stale.turns, []);
  } finally {
    reader.close();
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v2 upgrades existing day shells into one complete virtual index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-v2-"));
  const file = path.join(root, "journal.sqlite");
  const currentDay = indexedDay("02.08.2026", {
    turnRef: "ref-current",
    turnId: "turn-current",
    credits: 20,
    completedAt: "2026-08-02T12:00:00.000Z",
  });
  const oldDay = indexedDay("01.08.2026", {
    turnRef: "ref-old",
    turnId: "turn-old",
    credits: 10,
    completedAt: "2026-08-01T12:00:00.000Z",
  });
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE journal_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      html TEXT NOT NULL
    );
    CREATE TABLE journal_days (date TEXT PRIMARY KEY, html TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE journal_turns (id TEXT PRIMARY KEY, html TEXT NOT NULL) WITHOUT ROWID;
  `);
  legacy.prepare(`
    INSERT INTO journal_meta (id, schema_version, source_version, updated_at, html)
    VALUES (1, 2, 'sha256:legacy', '2026-08-02T12:00:00.000Z', ?)
  `).run(`${currentDay}<details data-work-log-day-section data-lazy-day="01.08.2026">`
    + '<summary data-work-log-day><strong>01.08.2026</strong></summary>'
    + '<div data-lazy-day-content></div></details>');
  legacy.prepare("INSERT INTO journal_days (date, html) VALUES (?, ?)")
    .run("01.08.2026", oldDay);
  legacy.close();

  const database = new JournalDatabase(file);
  try {
    const payload = await database.payload();
    assert.notEqual(payload.version, "sha256:legacy");
    assert.match(payload.html, /data-lazy-day="02\.08\.2026"/u);
    assert.doesNotMatch(payload.html, /turn-current|turn-old/u);
    assert.equal(payload.summary.buckets.length, 2);
    assert.equal(payload.summary.buckets.reduce((total, bucket) => total + bucket.credits, 0), 30);
    assert.deepEqual(
      (await database.turnPage({ workspaceId: "workspace-1" })).turns
        .map((entry) => entry.turnRef),
      ["ref-current", "ref-old"],
    );
    database.close();
    const reopened = new JournalDatabase(file);
    assert.equal((await reopened.payload()).summary.buckets.length, 2);
    assert.equal((await reopened.turnPage({ workspaceId: "workspace-1" })).turns.length, 2);
    reopened.close();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v2 migration rolls back DDL data and version after an injected failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-v2-rollback-"));
  const file = path.join(root, "journal.sqlite");
  const sourceDay = indexedDay("02.08.2026", {
    turnRef: "ref-current",
    turnId: "turn-current",
    credits: 20,
    completedAt: "2026-08-02T12:00:00.000Z",
  });
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE journal_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      html TEXT NOT NULL
    );
    CREATE TABLE journal_days (date TEXT PRIMARY KEY, html TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE journal_turns (id TEXT PRIMARY KEY, html TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO journal_meta
      (id, schema_version, source_version, updated_at, html)
    VALUES
      (1, 2, 'sha256:legacy', '2026-08-02T12:00:00.000Z', '${sourceDay.replaceAll("'", "''")}');
    CREATE TRIGGER fail_virtual_migration
    BEFORE UPDATE OF schema_version ON journal_meta
    WHEN NEW.schema_version = 3
    BEGIN
      SELECT RAISE(ABORT, 'injected virtual migration failure');
    END;
  `);
  legacy.close();

  const failed = new JournalDatabase(file);
  await assert.rejects(failed.payload(), /injected virtual migration failure/u);
  failed.close();
  const inspected = new DatabaseSync(file);
  assert.equal(
    inspected.prepare("PRAGMA table_info(journal_meta)").all()
      .some((column) => column.name === "summary_json"),
    false,
  );
  assert.equal(
    inspected.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'journal_turn_index'")
      .get(),
    undefined,
  );
  assert.equal(inspected.prepare("SELECT schema_version FROM journal_meta WHERE id = 1").get().schema_version, 2);
  inspected.exec("DROP TRIGGER fail_virtual_migration");
  inspected.close();

  const reopened = new JournalDatabase(file);
  try {
    assert.equal((await reopened.payload()).summary.buckets.length, 1);
    assert.deepEqual(
      (await reopened.turnPage({ workspaceId: "workspace-1" })).turns
        .map((entry) => entry.turnRef),
      ["ref-current"],
    );
    const upgraded = new DatabaseSync(file, { readOnly: true });
    assert.equal(upgraded.prepare("SELECT schema_version FROM journal_meta WHERE id = 1").get().schema_version, 3);
    assert.equal(
      upgraded.prepare("PRAGMA table_info(journal_meta)").all()
        .some((column) => column.name === "summary_json"),
      true,
    );
    upgraded.close();
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions observe revisions committed through another SQLite connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-subscribe-"));
  const file = path.join(root, "journal.sqlite");
  const reader = new JournalDatabase(file);
  const writer = new JournalDatabase(file);
  const changes = [];
  const unsubscribe = reader.subscribe((change) => changes.push(change), { pollMs: 100 });
  try {
    await eventually(() => changes.some((change) => change.initial), "initial revision was not observed");
    await writer.upsertRecords([record("turn-external")]);
    await eventually(
      () => changes.some((change) => change.initial === false && change.revision === 1),
      "external revision was not observed",
    );
  } finally {
    unsubscribe();
    reader.close();
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureFromFile remains a compatibility adapter and replaces stale fragments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-compat-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const databaseFile = path.join(root, "data", "journal.sqlite");
  const oldTurn = turn("turn-old", "Старый ход");
  const newTurn = turn("turn-new", "Новый ход");
  const dates = ["01.07.2026", "02.07.2026", "03.07.2026", "04.07.2026", "05.07.2026", "06.07.2026"];
  try {
    await writeFile(workLogFile, `# Журнал\n${dates.map((date) => day(date, oldTurn)).join("\n")}\n`, "utf8");
    const database = new JournalDatabase(databaseFile);
    const initial = await ensureJournalProjectionFromFile(database, workLogFile);
    assert.match(initial.html, /data-lazy-day="01\.07\.2026"/u);
    assert.match(await database.fragment("turn", oldTurn.reference), /Старый ход body/u);

    await writeFile(workLogFile, `# Журнал\n${dates.map((date) => day(date, newTurn)).join("\n")}\n`, "utf8");
    const updated = await ensureJournalProjectionFromFile(database, workLogFile);
    assert.notEqual(updated.version, initial.version);
    assert.equal(await database.fragment("turn", oldTurn.reference), null);
    assert.match(await database.fragment("turn", newTurn.reference), /Новый ход body/u);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("index-only projection uses revision CAS and preserves lazy fragments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-index-"));
  const database = new JournalDatabase(path.join(root, "data", "journal.sqlite"));
  try {
    await database.replaceProjection({
      html: '<details data-lazy-day="01.07.2026"></details>',
      days: { "01.07.2026": "<section>День</section>" },
      turns: { turn: "<article>Ход</article>" },
    }, { accountUsageProjectionVersion: "legacy-v0" });
    const current = await database.payload();
    const conflict = await database.replaceIndexProjection("<main>Устаревшее</main>", {
      expectedRevision: current.revision - 1,
      accountUsageProjectionVersion: "current-v1",
    });
    assert.equal(conflict.conflict, true);
    assert.equal(await database.accountUsageProjectionVersion(), "legacy-v0");

    const replaced = await database.replaceIndexProjection(
      '<aside data-work-log-account-panel></aside><details data-lazy-day="01.07.2026"></details>',
      {
        expectedRevision: current.revision,
        version: "sha256:index",
        accountUsageProjectionVersion: "current-v1",
      },
    );
    assert.equal(replaced.projected, true);
    assert.equal((await database.payload()).version, "sha256:index");
    assert.equal(await database.accountUsageProjectionVersion(), "current-v1");
    assert.deepEqual((await database.payload()).summary, { version: 1, buckets: [] });
    assert.equal(await database.fragment("day", "01.07.2026"), "<section>День</section>");
    assert.equal(await database.fragment("turn", "turn"), "<article>Ход</article>");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("account usage projection version migration survives restart without deleting facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-projection-version-"));
  const databaseFile = path.join(root, "data", "journal.sqlite");
  let database = new JournalDatabase(databaseFile);
  try {
    await database.replaceLedger({
      version: 9,
      turns: { "codex\0thread-1\0turn-1": record("turn-1") },
    });
    await database.replaceProjection({
      html: '<details data-lazy-day="01.07.2026"></details>',
      days: { "01.07.2026": "<section>День</section>" },
      turns: { turn: "<article>Ход</article>" },
    }, { accountUsageProjectionVersion: "legacy-v0" });
    database.close();

    database = new JournalDatabase(databaseFile);
    assert.equal(await database.accountUsageProjectionVersion(), "legacy-v0");
    assert.equal(Object.keys((await database.loadLedger()).turns).length, 1);
    assert.equal(await database.fragment("day", "01.07.2026"), "<section>День</section>");
    assert.equal(await database.fragment("turn", "turn"), "<article>Ход</article>");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("journal metadata and fragment pages stay bounded without loading index HTML", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-page-"));
  const database = new JournalDatabase(path.join(root, "data", "journal.sqlite"));
  try {
    const days = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
      const date = `${String(index + 1).padStart(2, "0")}.07.2026`;
      return [date, `<section>${date}</section>`];
    }));
    await database.replaceProjection({ html: "X".repeat(2_000_000), days, turns: {} });
    const metadata = await database.metadata();
    assert.equal(Object.hasOwn(metadata, "html"), false);
    assert.match(metadata.version, /^sha256:/u);

    const first = await database.fragmentPage("day", { limit: 7 });
    assert.equal(Object.keys(first.fragments).length, 7);
    assert.equal(first.nextOffset, 7);
    const second = await database.fragmentPage("day", { offset: first.nextOffset, limit: 7 });
    assert.equal(Object.keys(second.fragments).length, 7);
    assert.equal(second.nextOffset, 14);
    assert.equal(
      new Set([...Object.keys(first.fragments), ...Object.keys(second.fragments)]).size,
      14,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt SQLite journal fails closed without creating a clean store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-corrupt-"));
  const databaseFile = path.join(root, "data", "journal.sqlite");
  try {
    await mkdir(path.dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, "not a sqlite database", "utf8");
    const database = new JournalDatabase(databaseFile);
    await assert.rejects(
      replaceJournalProjectionFromHtml(database, "<p>Проверка</p>"),
      /not a database/iu,
    );
    database.close();
    assert.equal(await readFile(databaseFile, "utf8"), "not a sqlite database");
    assert.equal((await readdir(path.dirname(databaseFile)))
      .some((name) => name.startsWith("journal.sqlite.corrupt-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility adapter detects same-size updates with the same timestamp", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-same-version-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const database = new JournalDatabase(path.join(root, "data", "journal.sqlite"));
  const fixedTime = new Date("2026-08-01T12:00:00.000Z");
  try {
    await writeFile(workLogFile, "# Журнал\nAAAA\n", "utf8");
    await utimes(workLogFile, fixedTime, fixedTime);
    const first = await ensureJournalProjectionFromFile(database, workLogFile);
    await writeFile(workLogFile, "# Журнал\nBBBB\n", "utf8");
    await utimes(workLogFile, fixedTime, fixedTime);
    const second = await ensureJournalProjectionFromFile(database, workLogFile);
    assert.notEqual(second.version, first.version);
    assert.match(second.html, /BBBB/u);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
