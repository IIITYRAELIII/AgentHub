import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
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

test("same-size WORK_LOG replacement is detected even with the same timestamp", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-same-version-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const replacementFile = path.join(root, "WORK_LOG.replacement.md");
  const database = new JournalDatabase(path.join(root, "data", "journal.sqlite"), {
    // Model a missed fs.watch notification. The stat identity must still
    // notice that atomic rename installed a different file.
    watchSource: () => ({ close() {}, on() { return this; }, unref() {} }),
  });
  const fixedTime = new Date("2026-08-01T12:00:00.000Z");
  try {
    await writeFile(workLogFile, "# Журнал\nAAAA\n", "utf8");
    await utimes(workLogFile, fixedTime, fixedTime);
    const first = await database.ensureFromFile(workLogFile);
    await writeFile(replacementFile, "# Журнал\nBBBB\n", "utf8");
    await utimes(replacementFile, fixedTime, fixedTime);
    await rename(replacementFile, workLogFile);
    const second = await database.ensureFromFile(workLogFile);
    assert.notEqual(second.version, first.version);
    assert.match(second.html, /BBBB/u);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged ensures avoid full reads while watcher generation detects metadata-identical replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-generation-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const replacementFile = path.join(root, "WORK_LOG.replacement.md");
  const fixedTime = new Date("2026-08-01T12:00:00.000Z");
  let notifyChange = () => {};
  let readCalls = 0;
  let hashCalls = 0;
  const database = new JournalDatabase(path.join(root, "data", "journal.sqlite"), {
    readSource: async (...args) => {
      readCalls += 1;
      return readFile(...args);
    },
    hashSource: (markdown) => {
      hashCalls += 1;
      return `test-version:${markdown}`;
    },
    // Normalize every stat field used by the fast path. The replacement can
    // therefore be observed only through this monotonic watcher generation.
    statSource: async (file) => {
      const info = await stat(file);
      return {
        dev: 1,
        ino: 1,
        size: info.size,
        mtimeMs: fixedTime.getTime(),
        ctimeMs: 1,
        birthtimeMs: 1,
        mtime: fixedTime,
      };
    },
    watchSource: (_directory, callback) => {
      notifyChange = callback;
      return { close() {}, on() { return this; }, unref() {} };
    },
  });
  try {
    await writeFile(workLogFile, "# Журнал\nAAAA\n", "utf8");
    await utimes(workLogFile, fixedTime, fixedTime);
    const first = await database.ensureFromFile(workLogFile);
    assert.equal(readCalls, 1);
    assert.equal(hashCalls, 1);

    assert.equal((await database.ensureFromFile(workLogFile)).version, first.version);
    assert.equal((await database.ensureFromFile(workLogFile)).version, first.version);
    assert.equal(readCalls, 1);
    assert.equal(hashCalls, 1);

    await writeFile(replacementFile, "# Журнал\nBBBB\n", "utf8");
    await utimes(replacementFile, fixedTime, fixedTime);
    await rename(replacementFile, workLogFile);
    notifyChange("rename", path.basename(workLogFile));
    const second = await database.ensureFromFile(workLogFile);
    assert.notEqual(second.version, first.version);
    assert.match(second.html, /BBBB/u);
    assert.equal(readCalls, 2);
    assert.equal(hashCalls, 2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
