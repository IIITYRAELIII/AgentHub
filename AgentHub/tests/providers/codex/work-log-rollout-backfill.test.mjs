import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkLogRolloutBackfill,
  buildWorkLogRolloutBackfill,
} from "../../../src/providers/codex/work-log-rollout-backfill.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { createWorkLogUsageStore } from "../../../src/application/work-log-usage-store.mjs";
import { WorkLogUsageRepository } from "../../../src/infrastructure/persistence/work-log-usage-repository.mjs";

function WorkLogUsageStore(options) {
  return createWorkLogUsageStore({
    ...options,
    repositoryFactory: (repositoryOptions) => new WorkLogUsageRepository(repositoryOptions),
  });
}

const ROOT_THREAD = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
const CHILD_THREAD = "019f1ec9-8de7-7aa3-92b6-045036561c8e";
const OLD_TURN = "019f1eca-8de7-7aa3-92b6-045036561c8e";
const CHILD_TURN = "019f1ecb-8de7-7aa3-92b6-045036561c8e";
const INHERITED_TURN = "019f1ec7-8de7-7aa3-92b6-045036561c8e";

function usage(value) {
  return {
    inputTokens: value,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: value,
  };
}

test("rollout backfill replaces old ledger history, preserves newer records and creates backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-backfill-"));
  try {
    const sessions = path.join(root, "sessions");
    const archived = path.join(root, "archived");
    const databaseFile = path.join(root, "data", "journal.sqlite");
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const sessionIndexFile = path.join(root, "session_index.jsonl");
    await mkdir(sessions, { recursive: true });
    await mkdir(archived, { recursive: true });
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(path.join(sessions, "root.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(archived, "child.jsonl"), "{}\n", "utf8");
    await writeFile(sessionIndexFile, `${JSON.stringify({
      id: ROOT_THREAD,
      thread_name: "Историческая задача",
    })}\n`, "utf8");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 6,
      turns: {
        legacy: {
          provider: "codex",
          threadId: "legacy",
          turnId: "legacy",
          completedAt: "2026-07-26T10:00:00Z",
          title: "Старый текст",
        },
        newer: {
          provider: "codex",
          threadId: "newer-thread",
          taskThreadId: "newer-thread",
          turnId: "newer-turn",
          projectRoot: root,
          taskTitle: "Новая задача",
          title: "Новый ход",
          completedAt: "2026-07-27T10:00:00Z",
          usage: usage(1),
        },
        claude: {
          provider: "claude",
          threadId: "claude-thread",
          taskThreadId: "claude-thread",
          turnId: "claude-turn",
          projectRoot: root,
          taskTitle: "Claude задача",
          title: "Claude ход",
          completedAt: "2026-07-25T11:00:00Z",
          usage: usage(2),
        },
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n\nСтарый длинный итог\n", "utf8");

    const scans = new Map([
      ["root.jsonl", {
        session: { threadId: ROOT_THREAD, parentThreadId: "" },
        turns: [{
          turnId: OLD_TURN,
          usage: usage(100),
          reported: true,
          started: true,
          terminal: true,
          status: "completed",
          prompt: "Запрос",
          finalAnswer: "Проблему нашли и исправили.\n\nПодробности проверки.",
          startedAt: "2026-07-25T09:00:00Z",
          completedAt: "2026-07-25T09:01:00Z",
          changedFiles: [],
          spawnedSubagents: [{ threadId: CHILD_THREAD }],
        }],
      }],
      ["child.jsonl", {
        session: { threadId: CHILD_THREAD, parentThreadId: ROOT_THREAD },
        turns: [
          {
            turnId: INHERITED_TURN,
            usage: usage(999),
            reported: true,
            started: true,
            terminal: true,
            status: "completed",
            completedAt: "2026-07-25T09:02:00Z",
            changedFiles: [],
          },
          {
            turnId: CHILD_TURN,
            usage: usage(50),
            reported: true,
            started: true,
            terminal: false,
            status: "",
            prompt: "Запрос субагента",
            finalAnswer: "",
            startedAt: "2026-07-25T09:03:00Z",
            lastActivityAt: "2026-07-25T09:04:00Z",
            changedFiles: [],
          },
        ],
      }],
    ]);
    const migration = await buildWorkLogRolloutBackfill({
      rolloutRoots: [sessions, archived],
      sessionIndexFile,
      databaseFile,
      ledgerFile,
      projectRoot: root,
      through: "2026-07-26",
      scanRollout: async (file) => scans.get(path.basename(file)),
    });

    assert.equal(migration.report.importedRecords, 2);
    assert.equal(migration.report.inheritedTurns, 1);
    assert.equal(migration.report.removedRecords, 1);
    assert.equal(migration.report.preservedRecords, 2);
    assert.equal(migration.report.preservedNonCodexRecords, 1);
    assert.equal(
      migration.ledger.turns[`codex\u0000${ROOT_THREAD}\u0000${OLD_TURN}`].title,
      "Проблему нашли и исправили",
    );
    assert.equal(
      migration.ledger.turns[`codex\u0000${CHILD_THREAD}\u0000${CHILD_TURN}`].parentTurnId,
      OLD_TURN,
    );
    const applied = await applyWorkLogRolloutBackfill({
      migration,
      databaseFile,
      ledgerFile,
      workLogFile,
      projectRoot: root,
      projectionProjectRoots: [root],
      backupRoot: path.join(root, "backups"),
      now: new Date("2026-07-29T12:00:00Z"),
    });
    assert.equal(
      await readFile(path.join(applied.backupDirectory, "WORK_LOG.md"), "utf8"),
      "# Глобальный журнал работ\n\nСтарый длинный итог\n",
    );
    const database = new JournalDatabase(databaseFile);
    const storedLedger = await database.loadLedger();
    const snapshot = await database.snapshot();
    database.close();
    assert.deepEqual(storedLedger, migration.ledger);
    assert.doesNotMatch(snapshot.html, /Старый длинный итог|Старый текст/u);
    assert.match(snapshot.html, /Историческая задача/u);
    assert.match(snapshot.html, /Новая задача/u);
    assert.match(snapshot.html, /Claude задача/u);
    assert.equal(
      await readFile(workLogFile, "utf8"),
      "# Глобальный журнал работ\n\nСтарый длинный итог\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollout backfill merges a live ledger turn committed after its stale plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-backfill-live-race-"));
  try {
    const databaseFile = path.join(root, "data", "journal.sqlite");
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    const staleMigration = {
      ledger: {
        version: 8,
        turns: {
          historical: {
            provider: "codex",
            threadId: "historical-thread",
            taskThreadId: "historical-thread",
            turnId: "historical-turn",
            projectRoot: root,
            taskTitle: "История",
            title: "Ход завершён",
            completedAt: "2026-07-25T10:00:00.000Z",
            usage: usage(10),
          },
        },
      },
      report: { cutoff: "2026-07-26", replacedCodexKeys: [] },
    };
    const live = new WorkLogUsageStore({
      ledgerFile,
      databaseFile,
      defaultProjectRoot: root,
    });
    await live.recordAutomaticAndProject({
      threadId: "live-thread",
      turnId: "live-turn",
      projectRoot: root,
      usageReported: true,
      usage: usage(20),
      completedAt: "2026-07-27T10:00:00.000Z",
      text: "Новый ход",
      workLogFile: null,
    });
    await live.close();

    await applyWorkLogRolloutBackfill({
      migration: staleMigration,
      databaseFile,
      ledgerFile,
      workLogFile,
      projectRoot: root,
      projectionProjectRoots: [root],
      backupRoot: path.join(root, "backups"),
    });

    const database = new JournalDatabase(databaseFile);
    const ledger = await database.loadLedger();
    database.close();
    assert.ok(ledger.turns["codex\u0000historical-thread\u0000historical-turn"]);
    assert.ok(ledger.turns["codex\u0000live-thread\u0000live-turn"]);
    await assert.rejects(readFile(ledgerFile, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(workLogFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

