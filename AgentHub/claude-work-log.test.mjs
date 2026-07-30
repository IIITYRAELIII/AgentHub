import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyClaudeWorkLogBackfill,
  buildClaudeWorkLogBackfill,
  claudeResultEstimatedCredits,
  claudeResultTokenUsage,
  scanClaudeHistoricalTranscript,
} from "./claude-work-log.mjs";

const line = (value) => JSON.stringify(value);

test("Claude transcript scanner returns stable completed turns and deduplicates message updates", () => {
  const text = [
    line({
      type: "user",
      uuid: "prompt-1",
      timestamp: "2026-07-29T10:00:00.000Z",
      cwd: "D:\\projects\\Utilities",
      sessionId: "session-1",
      message: { role: "user", content: "Первый запрос" },
    }),
    line({
      type: "assistant",
      requestId: "request-1",
      timestamp: "2026-07-29T10:00:01.000Z",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Промежуточно" }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 5,
          output_tokens: 7,
        },
      },
    }),
    line({
      type: "assistant",
      requestId: "request-1",
      timestamp: "2026-07-29T10:00:02.000Z",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Готовый ответ" }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 5,
          output_tokens: 7,
          service_tier: "standard",
        },
      },
    }),
    line({ type: "ai-title", aiTitle: "Работа с журналом" }),
    line({
      type: "user",
      uuid: "command-1",
      message: {
        role: "user",
        content: "<command-name>/usage</command-name><command-message>usage</command-message>",
      },
    }),
  ].join("\n");

  const result = scanClaudeHistoricalTranscript(text, { transcriptPath: "session-1.jsonl" });
  assert.equal(result.session.title, "Работа с журналом");
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0], {
    provider: "claude",
    threadId: "session-1",
    turnId: "prompt-1",
    taskTitle: "Работа с журналом",
    title: "Ход завершён",
    body: "Готовый ответ",
    prompt: "Первый запрос",
    usage: {
      inputTokens: 10,
      cachedInputTokens: 5,
      outputTokens: 7,
      reasoningOutputTokens: 0,
      totalTokens: 17,
    },
    usageReported: true,
    estimatedCredits: 0,
    estimateKind: "",
    model: "claude-opus-4-8",
    serviceTier: "standard",
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:00:02.000Z",
    status: "completed",
    cwd: "D:\\projects\\Utilities",
  });
});

test("Claude result accounting uses CLI cost and token totals", () => {
  assert.deepEqual(claudeResultTokenUsage({
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40,
    },
  }), {
    usage: {
      inputTokens: 60,
      cachedInputTokens: 30,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 100,
    },
    reported: true,
  });
  assert.equal(claudeResultEstimatedCredits({ total_cost_usd: 2 }), 50);
  assert.equal(claudeResultEstimatedCredits({
    modelUsage: {
      opus: { costUSD: 1.5 },
      haiku: { costUSD: 0.5 },
    },
  }), 50);
});

test("Claude backfill is additive, idempotent and keeps recoverable backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-work-log-"));
  const transcriptRoot = path.join(root, "transcripts", "project");
  const projectRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const ledgerFile = path.join(dataDir, "work-log-usage.json");
  const workLogFile = path.join(root, "WORK_LOG.md");
  await mkdir(transcriptRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(ledgerFile, `${JSON.stringify({
    version: 7,
    turns: {
      "codex\u0000thread\u0000turn": {
        provider: "codex",
        threadId: "thread",
        turnId: "turn",
        projectRoot,
        completedAt: "2026-07-28T10:00:00.000Z",
      },
    },
  })}\n`, "utf8");
  await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
  await writeFile(path.join(transcriptRoot, "session-1.jsonl"), [
    line({
      type: "user",
      uuid: "prompt-1",
      timestamp: "2026-07-29T10:00:00.000Z",
      cwd: projectRoot,
      sessionId: "session-1",
      message: { role: "user", content: "Запрос" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-29T10:01:00.000Z",
      message: {
        id: "answer-1",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: "Ответ",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ].join("\n"), "utf8");

  const options = {
    transcriptRoot: path.join(root, "transcripts"),
    ledgerFile,
    projects: [{ name: "Workspace", path: projectRoot }],
  };
  const first = await buildClaudeWorkLogBackfill(options);
  assert.equal(first.report.importedTurns, 1);
  assert.equal(Object.keys(first.ledger.turns).length, 2);
  const applied = await applyClaudeWorkLogBackfill({
    migration: first,
    ledgerFile,
    workLogFile,
    now: new Date("2026-07-30T10:00:00.000Z"),
  });
  assert.match(applied.backupDirectory, /claude-2026-07-30T10-00-00-000Z$/u);
  assert.match(await readFile(workLogFile, "utf8"), /Claude - Работа с журналом|Claude - Запрос/u);

  const second = await buildClaudeWorkLogBackfill(options);
  assert.equal(second.report.importedTurns, 0);
  assert.equal(second.report.existingTurns, 1);
  assert.equal(second.report.updatedTurns, 0);
  assert.equal(Object.keys(second.ledger.turns).length, 2);
});
