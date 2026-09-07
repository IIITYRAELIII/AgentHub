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
  claudeTranscriptEstimatedCredits,
  scanClaudeHistoricalTranscript,
  scanClaudeHistoricalTranscriptFile,
} from "../../../src/providers/claude/claude-work-log.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";

const line = (value) => JSON.stringify(value);

test("Claude transcript scanner ignores the synthetic resume exchange", () => {
  const result = scanClaudeHistoricalTranscript([
    line({ type: "user", uuid: "u1", timestamp: "2026-08-17T09:53:40.000Z", message: { role: "user", content: "Первый" } }),
    line({ type: "assistant", timestamp: "2026-08-17T09:55:18.000Z", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: "Failed" }], stop_reason: "stop_sequence", usage: {} } }),
    line({ type: "user", uuid: "resume", timestamp: "2026-08-17T09:55:47.000Z", message: { role: "user", content: "Continue from where you left off." } }),
    line({ type: "assistant", timestamp: "2026-08-17T09:55:47.001Z", message: { role: "assistant", content: [{ type: "text", text: "No response requested." }], stop_reason: "stop_sequence", usage: {} } }),
    line({ type: "user", uuid: "u2", timestamp: "2026-08-17T09:55:47.002Z", message: { role: "user", content: "Второй" } }),
    line({ type: "assistant", timestamp: "2026-08-17T09:56:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Готово" }], stop_reason: "end_turn", usage: {} } }),
  ].join("\n"), { transcriptPath: "session-resume.jsonl" });

  assert.deepEqual(result.turns.map((turn) => turn.prompt), ["Первый", "Второй"]);
});

test("Claude transcript file scanner preserves the pure scanner result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-worker-scan-"));
  const transcriptPath = path.join(root, "worker-session.jsonl");
  const transcript = [
    line({
      type: "user",
      uuid: "u1",
      sessionId: "worker-session",
      timestamp: "2026-08-27T10:00:00.000Z",
      message: { role: "user", content: "Проверить worker" },
    }),
    line({
      type: "assistant",
      uuid: "a1",
      sessionId: "worker-session",
      timestamp: "2026-08-27T10:00:01.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Worker работает" }],
      },
    }),
  ].join("\n");
  await writeFile(transcriptPath, transcript, "utf8");

  assert.deepEqual(
    await scanClaudeHistoricalTranscriptFile(transcriptPath),
    scanClaudeHistoricalTranscript(transcript, { transcriptPath }),
  );
});

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
    estimatedCredits: 0.00515625,
    estimateKind: "claude-api-token-pricing",
    model: "claude-opus-4-8",
    serviceTier: "standard",
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:00:02.000Z",
    status: "completed",
    cwd: "D:\\projects\\Utilities",
    skillsUsed: [],
    mcpCalls: [],
    toolMetricsKnown: true,
  });
});

test("Claude transcript scanner records skills and completed MCP calls", () => {
  const text = [
    line({
      type: "user",
      uuid: "prompt-tools",
      timestamp: "2026-07-29T10:00:00.000Z",
      cwd: "D:\\projects\\Utilities",
      sessionId: "session-tools",
      message: { role: "user", content: "Используй инструменты" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-29T10:00:01.000Z",
      message: {
        id: "message-skill",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "skill-1",
          name: "Skill",
          input: { skill: "openai-docs", args: "private request" },
        }],
      },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "skill-1", content: "loaded" }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-29T10:00:02.000Z",
      message: {
        id: "message-mcp-ok",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "mcp-1",
          name: "mcp__1c-access__onec_infobases",
          input: { secret: "not persisted" },
        }],
      },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "mcp-1", content: "private result" }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-29T10:00:03.000Z",
      message: {
        id: "message-mcp-failed",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "mcp-2",
          name: "mcp__docs__search_api",
          input: { query: "private query" },
        }, {
          type: "tool_use",
          id: "mcp-unfinished",
          name: "mcp__docs__unfinished",
          input: {},
        }],
      },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "mcp-2",
          is_error: true,
          content: "private failure",
        }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-29T10:00:04.000Z",
      message: {
        id: "message-final",
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Готово" }],
      },
    }),
  ].join("\n");

  const result = scanClaudeHistoricalTranscript(text, { transcriptPath: "session-tools.jsonl" });
  assert.equal(result.turns.length, 1);
  assert.deepEqual(result.turns[0].skillsUsed, ["openai-docs"]);
  assert.deepEqual(result.turns[0].mcpCalls, [{
    id: "mcp-1",
    server: "1c-access",
    tool: "onec_infobases",
    status: "completed",
  }, {
    id: "mcp-2",
    server: "docs",
    tool: "search_api",
    status: "failed",
  }]);
  assert.equal(result.turns[0].toolMetricsKnown, true);
  assert.doesNotMatch(JSON.stringify(result.turns[0].mcpCalls), /private|secret|query/u);
});

test("Claude transcript scanner records a slash-expanded skill prompt", () => {
  const text = [
    line({
      type: "user",
      uuid: "prompt-expanded-skill",
      timestamp: "2026-08-03T05:00:00.000Z",
      cwd: "D:\\projects\\Utilities",
      sessionId: "session-expanded-skill",
      message: {
        role: "user",
        content: [{
          type: "text",
          text: "Base directory for this skill: C:\\Users\\Test\\.claude\\skills\\handoff\n\n# Handoff",
        }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-03T05:00:01.000Z",
      message: {
        id: "message-expanded-skill",
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Готово" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }),
  ].join("\n");

  const result = scanClaudeHistoricalTranscript(text, {
    transcriptPath: "session-expanded-skill.jsonl",
  });
  assert.deepEqual(result.turns[0].skillsUsed, ["handoff"]);
});

test("Claude transcript accounting prices cache categories, model changes and dated rates", () => {
  assert.equal(claudeTranscriptEstimatedCredits([{
    type: "assistant",
    timestamp: "2026-07-30T10:00:00.000Z",
    message: {
      id: "sonnet-intro",
      role: "assistant",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      },
    },
  }]), 467.5);
  assert.equal(claudeTranscriptEstimatedCredits([{
    type: "assistant",
    timestamp: "2026-09-01T00:00:00.000Z",
    message: {
      id: "sonnet-standard",
      role: "assistant",
      model: "claude-sonnet-5",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    },
  }]), 450);
  assert.equal(claudeTranscriptEstimatedCredits([{
    type: "assistant",
    timestamp: "2026-07-30T10:00:00.000Z",
    message: {
      id: "opus-fast-us",
      role: "assistant",
      model: "claude-opus-5",
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        speed: "fast",
        inference_geo: "us",
      },
    },
  }]), 1_650);
  assert.equal(claudeTranscriptEstimatedCredits([{
    type: "assistant",
    timestamp: "2026-07-30T10:00:00.000Z",
    message: {
      id: "unknown",
      role: "assistant",
      model: "claude-unknown",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }]), 0);
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
  const databaseFile = path.join(dataDir, "journal.sqlite");
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
  await writeFile(`${ledgerFile}.delta.jsonl`, `${JSON.stringify({
    op: "upsert",
    key: "codex\u0000delta-thread\u0000delta-turn",
    record: {
      provider: "codex",
      threadId: "delta-thread",
      turnId: "delta-turn",
      projectRoot,
      completedAt: "2026-07-28T11:00:00.000Z",
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
    databaseFile,
    ledgerFile,
    projects: [{ name: "Workspace", path: projectRoot }],
  };
  const first = await buildClaudeWorkLogBackfill(options);
  assert.equal(first.report.importedTurns, 1);
  assert.equal(Object.keys(first.ledger.turns).length, 3);
  const imported = first.ledger.turns["claude\u0000session-1\u0000prompt-1"];
  assert.equal(imported.estimatedCredits, 0.002625);
  assert.equal(imported.estimateKind, "claude-api-token-pricing");
  const applied = await applyClaudeWorkLogBackfill({
    migration: first,
    databaseFile,
    ledgerFile,
    workLogFile,
    projectRoot,
    projectionProjectRoots: [projectRoot],
    now: new Date("2026-07-30T10:00:00.000Z"),
  });
  assert.match(applied.backupDirectory, /claude-2026-07-30T10-00-00-000Z$/u);
  assert.equal(await readFile(workLogFile, "utf8"), "# Глобальный журнал работ\n");
  const database = new JournalDatabase(databaseFile);
  const stored = await database.loadLedger();
  const snapshot = await database.snapshot();
  database.close();
  assert.equal(Object.keys(stored.turns).length, 3);
  assert.match(
    Object.values(snapshot.days).join("\n"),
    /Claude - Работа с журналом|Claude - Запрос/u,
  );

  const second = await buildClaudeWorkLogBackfill(options);
  assert.equal(second.report.importedTurns, 0);
  assert.equal(second.report.existingTurns, 1);
  assert.equal(second.report.updatedTurns, 0);
  assert.equal(Object.keys(second.ledger.turns).length, 3);
});

test("Claude backfill adds token pricing to existing unpriced turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-work-log-pricing-"));
  const transcriptRoot = path.join(root, "transcripts");
  const projectRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const ledgerFile = path.join(dataDir, "work-log-usage.json");
  await mkdir(transcriptRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const key = "claude\u0000session-1\u0000prompt-1";
  await writeFile(ledgerFile, `${JSON.stringify({
    version: 7,
    turns: {
      [key]: {
        provider: "claude",
        threadId: "session-1",
        turnId: "prompt-1",
        projectRoot,
        estimatedCredits: 0,
        estimateKind: "",
      },
    },
  })}\n`, "utf8");
  await writeFile(path.join(transcriptRoot, "session-1.jsonl"), [
    line({
      type: "user",
      uuid: "prompt-1",
      timestamp: "2026-07-30T10:00:00.000Z",
      cwd: projectRoot,
      sessionId: "session-1",
      message: { role: "user", content: "Запрос" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-30T10:00:30.000Z",
      message: {
        id: "tools-1",
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "skill-1",
          name: "Skill",
          input: { skill: "openai-docs" },
        }],
      },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "skill-1", content: "loaded" }],
      },
    }),
    line({
      type: "assistant",
      timestamp: "2026-07-30T10:01:00.000Z",
      message: {
        id: "answer-1",
        role: "assistant",
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: "Ответ",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
    }),
  ].join("\n"), "utf8");

  const result = await buildClaudeWorkLogBackfill({
    transcriptRoot,
    ledgerFile,
    projects: [{ name: "Workspace", path: projectRoot }],
  });
  assert.equal(result.report.importedTurns, 0);
  assert.equal(result.report.existingTurns, 1);
  assert.equal(result.report.updatedTurns, 1);
  assert.equal(result.ledger.version, 8);
  assert.equal(result.ledger.turns[key].estimatedCredits, 750);
  assert.equal(result.ledger.turns[key].estimateKind, "claude-api-token-pricing");
  assert.deepEqual(result.ledger.turns[key].skillsUsed, ["openai-docs"]);
  assert.deepEqual(result.ledger.turns[key].mcpCalls, []);
  assert.equal(result.ledger.turns[key].toolMetricsKnown, true);
});
