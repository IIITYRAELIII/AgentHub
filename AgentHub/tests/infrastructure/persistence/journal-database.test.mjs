import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  const dates = ["01.07.2026", "02.07.2026", "03.07.2026", "04.07.2026", "05.07.2026", "06.07.2026"];
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
    assert.match(snapshot.days["01.07.2026"], /Старый ход/u);
    assert.match(snapshot.turns[item.reference], /Старый ход body/u);
    assert.match(await database.fragment("turn", item.reference), /Старый ход body/u);
    const dayFragments = await database.fragments("day");
    assert.match(dayFragments["01.07.2026"], /Старый ход/u);
    assert.deepEqual(await database.exportPayload(), snapshot);
  } finally {
    database.close();
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
    });
    const current = await database.payload();
    const conflict = await database.replaceIndexProjection("<main>Устаревшее</main>", {
      expectedRevision: current.revision - 1,
    });
    assert.equal(conflict.conflict, true);

    const replaced = await database.replaceIndexProjection(
      '<aside data-work-log-account-panel></aside><details data-lazy-day="01.07.2026"></details>',
      { expectedRevision: current.revision, version: "sha256:index" },
    );
    assert.equal(replaced.projected, true);
    assert.equal((await database.payload()).version, "sha256:index");
    assert.equal(await database.fragment("day", "01.07.2026"), "<section>День</section>");
    assert.equal(await database.fragment("turn", "turn"), "<article>Ход</article>");
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
