import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkLogRolloutBackfill,
  buildWorkLogRolloutBackfill,
} from "./work-log-rollout-backfill.mjs";

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
          finalAnswer: "Ответ",
          startedAt: "2026-07-25T09:00:00Z",
          completedAt: "2026-07-25T09:01:00Z",
          changedFiles: [],
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
    assert.doesNotMatch(migration.workLog, /Старый длинный итог|Старый текст/u);
    assert.match(migration.workLog, /Историческая задача/u);
    assert.match(migration.workLog, /Ход завершён/u);
    assert.match(migration.workLog, /Ход отменён/u);
    assert.match(migration.workLog, /Новая задача/u);
    assert.match(migration.workLog, /Claude задача/u);

    const applied = await applyWorkLogRolloutBackfill({
      migration,
      ledgerFile,
      workLogFile,
      backupRoot: path.join(root, "backups"),
      now: new Date("2026-07-29T12:00:00Z"),
    });
    assert.equal(
      await readFile(path.join(applied.backupDirectory, "WORK_LOG.md"), "utf8"),
      "# Глобальный журнал работ\n\nСтарый длинный итог\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(ledgerFile, "utf8")),
      migration.ledger,
    );
    assert.equal(await readFile(workLogFile, "utf8"), migration.workLog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

