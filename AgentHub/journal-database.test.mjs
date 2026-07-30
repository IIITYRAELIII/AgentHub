import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JournalDatabase } from "./journal-database.mjs";

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

test("SQLite journal index survives reopening and replaces stale fragments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-db-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const databaseFile = path.join(root, "data", "journal.sqlite");
  const oldTurn = turn("turn-old", "Старый ход");
  const newTurn = turn("turn-new", "Новый ход");
  const dates = ["01.07.2026", "02.07.2026", "03.07.2026", "04.07.2026", "05.07.2026", "06.07.2026"];
  try {
    await writeFile(
      workLogFile,
      `# Журнал\n${dates.map((date) => day(date, oldTurn)).join("\n")}\n`,
      "utf8",
    );
    const first = new JournalDatabase(databaseFile);
    const initial = await first.ensureFromFile(workLogFile);
    assert.match(initial.html, /data-lazy-day="01\.07\.2026"/u);
    assert.match(await first.fragment("turn", oldTurn.reference), /Старый ход body/u);
    first.close();

    assert.ok((await stat(databaseFile)).size > 0);
    const reopened = new JournalDatabase(databaseFile);
    assert.equal((await reopened.ensureFromFile(workLogFile)).version, initial.version);
    assert.match(await reopened.fragment("day", "01.07.2026"), /Старый ход/u);

    await writeFile(
      workLogFile,
      `# Журнал\n${dates.map((date) => day(date, newTurn)).join("\n")}\n<!-- changed -->\n`,
      "utf8",
    );
    const updated = await reopened.ensureFromFile(workLogFile);
    assert.notEqual(updated.version, initial.version);
    assert.equal(await reopened.fragment("turn", oldTurn.reference), null);
    assert.match(await reopened.fragment("turn", newTurn.reference), /Новый ход body/u);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt SQLite journal index is preserved and rebuilt from WORK_LOG", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-corrupt-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const databaseFile = path.join(root, "data", "journal.sqlite");
  try {
    await writeFile(workLogFile, "# Журнал\nПроверка\n", "utf8");
    await mkdir(path.dirname(databaseFile), { recursive: true });
    await writeFile(databaseFile, "not a sqlite database", "utf8");
    const database = new JournalDatabase(databaseFile);
    assert.match((await database.ensureFromFile(workLogFile)).html, /Проверка/u);
    database.close();
    assert.ok((await readdir(path.dirname(databaseFile)))
      .some((name) => name.startsWith("journal.sqlite.corrupt-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
