import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";

test("title metadata seeks the exact task, including subagent rows, without scanning its provider", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-title-seek-"));
  const journal = new JournalDatabase(path.join(root, "journal.sqlite"));
  t.after(async () => { journal.close(); await rm(root, { recursive: true, force: true }); });
  await journal.upsertRecords([
    { provider: "codex", threadId: "task", turnId: "root", taskTitle: "Root", projectRoot: root },
    { provider: "codex", threadId: "child", taskThreadId: "task", turnId: "child-turn", taskTitle: "Child", projectRoot: root },
    { provider: "claude", threadId: "task", turnId: "other-provider", taskTitle: "Other provider", projectRoot: root },
    ...Array.from({ length: 200 }, (_, i) => ({
      provider: "codex", threadId: `unrelated-${i}`, turnId: "turn", projectRoot: root,
      taskTitle: "Unrelated", body: "retained answer".repeat(100),
    })),
  ]);
  // Observe SQLite's plan for the actual executed metadata statement, rather
  // than reading source text or asserting an elapsed-time threshold on CI.
  const prepare = DatabaseSync.prototype.prepare;
  const plans = [];
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    const connection = this;
    const statement = prepare.call(this, sql);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") return (...args) => {
          plans.push(...prepare.call(connection, `EXPLAIN QUERY PLAN ${sql}`).all(...args));
          return target.all(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const rows = await journal.taskTitleMetadata({ provider: "codex", threadId: "task" });
  assert.deepEqual(rows.map(({ threadId, turnId, taskTitle }) => ({ threadId, turnId, taskTitle }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId)), [
    { threadId: "child", turnId: "child-turn", taskTitle: "Child" },
    { threadId: "task", turnId: "root", taskTitle: "Root" },
  ]);
  assert.ok(plans.some(({ detail }) => detail.includes("provider=? AND task_thread_id=?")),
    JSON.stringify(plans));
  assert.ok(plans.every(({ detail }) => !detail.startsWith("SCAN ")), JSON.stringify(plans));
});
