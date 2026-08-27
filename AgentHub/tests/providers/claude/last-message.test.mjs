import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, open, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeTranscriptCacheStats,
  listClaudeSessionSnapshots,
  parseClaudeTranscript,
  readClaudeSessionSnapshot,
  resetClaudeTranscriptCache,
} from "../../../src/providers/claude/claude-session-reader.mjs";
import {
  codexFinalTurnAnswer,
} from "../../../src/application/task-history.mjs";
import {
  codexTurnAnswer,
  lastCompletedCodexAnswer,
} from "../../../src/providers/codex/codex-turn-answers.mjs";

function line(value) {
  return JSON.stringify(value);
}

test("codexTurnAnswer preserves every visible agent message in the turn", () => {
  assert.equal(codexTurnAnswer({
    items: [
      { type: "reasoning", text: "hidden" },
      { type: "agentMessage", text: "Первое сообщение" },
      { type: "commandExecution", command: "test" },
      { type: "agentMessage", text: "Второе сообщение" },
      { type: "agentMessage", text: "Последний абзац" },
    ],
  }), "Первое сообщение\n\nВторое сообщение\n\nПоследний абзац");
});

test("codexTurnAnswer includes the final Plan item", () => {
  assert.equal(codexTurnAnswer({
    items: [
      { type: "agentMessage", phase: "commentary", text: "Уточняю требования." },
      { type: "plan", text: "1. Исправить\n2. Проверить" },
    ],
  }), "Уточняю требования.\n\n1. Исправить\n2. Проверить");
});

test("codexFinalTurnAnswer returns the explicit final answer instead of commentary", () => {
  assert.equal(codexFinalTurnAnswer({
    items: [
      { type: "agentMessage", phase: "commentary", text: "Проверяю." },
      { type: "agentMessage", phase: "commentary", text: "Почти готово." },
      { type: "agentMessage", phase: "final_answer", text: "Готовый итог." },
    ],
  }), "Готовый итог.");
});

test("codexFinalTurnAnswer falls back to the last agent message for legacy turns", () => {
  assert.equal(codexFinalTurnAnswer({
    items: [
      { type: "agentMessage", text: "Промежуточный текст" },
      { type: "agentMessage", text: "Последний ответ" },
    ],
  }), "Последний ответ");
});

test("lastCompletedCodexAnswer ignores the currently running partial answer", () => {
  const turns = [{
    id: "completed",
    status: "completed",
    items: [{ type: "agentMessage", text: "Готовый ответ" }],
  }, {
    id: "running",
    status: "inProgress",
    items: [{ type: "agentMessage", text: "Незавершённый ответ" }],
  }];
  assert.equal(lastCompletedCodexAnswer(turns), "Готовый ответ");
});

test("parseClaudeTranscript returns the current partial answer", () => {
  const transcript = [
    line({ type: "user", message: { role: "user", content: "Сделай задачу" } }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Проверяю." }, { type: "tool_use", name: "Read" }],
      },
    }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: null,
        content: [{ type: "text", text: "Ответ почти готов" }],
      },
    }),
  ].join("\n");

  assert.deepEqual(parseClaudeTranscript(transcript), {
    answer: "Проверяю.\n\nОтвет почти готов",
    reasoning: "",
    completed: false,
    active: true,
    stage: "Claude использует инструмент Read…",
    startedAt: null,
    updatedAt: null,
    transcriptActivityAtMs: null,
    entrypoint: null,
    sessionId: null,
    cwd: null,
    sessionRoot: null,
    title: "Сделай задачу",
    catalogTitle: "Сделай задачу",
    isSidechain: false,
  });
});

test("Claude VS Code last-prompt keeps the current turn active and identifies VS Code", () => {
  const result = parseClaudeTranscript([
    line({
      type: "user",
      timestamp: "2026-08-03T18:04:42.815Z",
      entrypoint: "claude-vscode",
      message: { role: "user", content: "Продолжай" },
    }),
    line({
      type: "last-prompt",
      timestamp: "2026-08-03T18:04:42.900Z",
      entrypoint: "claude-vscode",
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-03T18:04:52.321Z",
      entrypoint: "claude-vscode",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "Bash" }],
      },
    }),
  ].join("\n"));
  assert.equal(result.active, true);
  assert.equal(result.completed, false);
  assert.equal(result.entrypoint, "claude-vscode");
  assert.equal(result.updatedAt, "2026-08-03T18:04:52.321Z");
});

test("Claude API error is terminal even without end_turn", () => {
  const result = parseClaudeTranscript([
    line({
      type: "user",
      timestamp: "2026-08-05T05:43:51.349Z",
      message: { role: "user", content: "Продолжай" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-05T05:43:52.748Z",
      isApiErrorMessage: true,
      error: "oauth_org_not_allowed",
      message: {
        role: "assistant",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: "Claude subscription access disabled" }],
      },
    }),
  ].join("\n"));

  assert.equal(result.completed, true);
  assert.equal(result.active, false);
  assert.equal(result.stage, "Claude завершился с ошибкой.");
  assert.equal(result.answer, "Claude subscription access disabled");
});

test("parseClaudeTranscript uses only the latest user turn and detects completion", () => {
  const transcript = [
    line({ type: "user", message: { role: "user", content: "Первый вопрос" } }),
    line({
      type: "assistant",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Старый ответ" }] },
    }),
    line({ type: "user", message: { role: "user", content: "Второй вопрос" } }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "Готово" }, { type: "text", text: "Новый полный ответ" }],
      },
    }),
  ].join("\n");

  const result = parseClaudeTranscript(transcript);
  assert.equal(result.answer, "Новый полный ответ");
  assert.equal(result.reasoning, "Готово");
  assert.equal(result.completed, true);
  assert.equal(result.active, false);
});

test("Claude compaction records cannot revive a terminal user turn", () => {
  const result = parseClaudeTranscript([
    line({
      type: "user",
      uuid: "user-turn",
      timestamp: "2026-08-26T20:52:00.080Z",
      message: { role: "user", content: "Исправь совместимость" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-26T21:04:27.283Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Готово" }],
      },
    }),
    line({ type: "last-prompt" }),
    line({ type: "queue-operation", timestamp: "2026-08-26T21:12:58.836Z" }),
    line({
      type: "user",
      timestamp: "2026-08-26T21:16:04.286Z",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation that ran out of context.",
      },
    }),
    line({
      type: "user",
      timestamp: "2026-08-26T21:16:05.094Z",
      message: {
        role: "user",
        content: "<command-name>/compact</command-name><command-message>compact</command-message>",
      },
    }),
    line({ type: "mode", timestamp: "2026-08-26T21:16:05.500Z" }),
  ].join("\n"));

  assert.equal(result.completed, true);
  assert.equal(result.active, false);
  assert.equal(result.answer, "Готово");
  assert.equal(result.startedAt, "2026-08-26T20:52:00.080Z");
  assert.equal(result.updatedAt, "2026-08-26T21:04:27.283Z");
  assert.equal(result.transcriptActivityAtMs, Date.parse("2026-08-26T21:04:27.283Z"));
});

test("Claude compaction metadata does not refresh an abandoned active turn", () => {
  const result = parseClaudeTranscript([
    line({
      type: "user",
      timestamp: "2026-08-26T20:00:00.000Z",
      message: { role: "user", content: "Незавершённый ход" },
    }),
    line({
      type: "assistant",
      timestamp: "2026-08-26T20:01:00.000Z",
      message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Read" }] },
    }),
    line({
      type: "user",
      timestamp: "2026-08-26T21:00:00.000Z",
      isCompactSummary: true,
      message: { role: "user", content: "synthetic summary" },
    }),
  ].join("\n"));

  assert.equal(result.active, true);
  assert.equal(result.updatedAt, "2026-08-26T20:01:00.000Z");
  assert.equal(result.transcriptActivityAtMs, Date.parse("2026-08-26T20:01:00.000Z"));
});

test("parseClaudeTranscript exposes the latest Claude context usage", () => {
  const result = parseClaudeTranscript([
    JSON.stringify({
      type: "user",
      uuid: "prompt-context",
      timestamp: "2026-08-17T10:00:00.000Z",
      message: { role: "user", content: "Проверить контекст" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-17T10:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Проверяю" }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 182_227,
          cache_read_input_tokens: 12_725,
          output_tokens: 448,
        },
      },
    }),
  ].join("\n"));

  assert.deepEqual(result.contextUsage, {
    provider: "claude",
    model: "claude-opus-5",
    modelContextWindow: 1_000_000,
    usedTokens: 195_402,
    turnId: "prompt-context",
    updatedAt: "2026-08-17T10:00:01.000Z",
  });
});

test("readClaudeSessionSnapshot finds a nested session transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-"));
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "session-1.jsonl"), [
    line({ type: "user", message: { role: "user", content: "Вопрос" } }),
    line({
      type: "assistant",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Ответ" }] },
    }),
  ].join("\n"), "utf8");

  const result = await readClaudeSessionSnapshot("session-1", { projectsRoot: root });
  assert.equal(result.answer, "Ответ");
  assert.equal(result.completed, true);
  assert.equal(path.basename(result.transcriptPath), "session-1.jsonl");
});

test("readClaudeSessionSnapshot streams history beyond the bounded live tail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-large-history-"));
  const project = path.join(root, "project");
  await mkdir(project);
  const transcriptPath = path.join(project, "large-session.jsonl");
  await writeFile(transcriptPath, [
    line({
      type: "user",
      uuid: "user-turn-1",
      timestamp: "2026-07-31T08:00:00.000Z",
      message: { role: "user", content: "Покажи старый запрос" },
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "x".repeat(4 * 1024 * 1024 + 1024) }],
      },
    }),
    line({
      type: "assistant",
      uuid: "assistant-turn-1",
      timestamp: "2026-07-31T08:01:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Старый ответ доступен" }],
      },
    }),
  ].join("\n"), "utf8");

  const result = await readClaudeSessionSnapshot("large-session", { projectsRoot: root });

  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].prompt, "Покажи старый запрос");
  assert.equal(result.history[0].answer, "Старый ответ доступен");
});

test("listClaudeSessionSnapshots discovers independent sessions but skips subagents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-catalog-"));
  const project = path.join(root, "project");
  const subagents = path.join(project, "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(project, "session-2.jsonl"), [
    line({
      type: "user",
      cwd: "C:\\Projects\\Main",
      sessionId: "session-2",
      message: { role: "user", content: "Проверить каталог задач" },
    }),
    line({
      type: "assistant",
      sessionId: "session-2",
      message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "Проверяю" }] },
    }),
  ].join("\n"), "utf8");
  await writeFile(path.join(subagents, "agent-1.jsonl"), line({
    type: "user",
    isSidechain: true,
    sessionId: "agent-1",
    message: { role: "user", content: "Подзадача" },
  }), "utf8");

  const snapshots = await listClaudeSessionSnapshots({ projectsRoot: root });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sessionId, "session-2");
  assert.equal(snapshots[0].cwd, "C:\\Projects\\Main");
  assert.equal(snapshots[0].title, "Проверить каталог задач");
  assert.equal(snapshots[0].catalogTitle, "Проверить каталог задач");
  assert.equal(snapshots[0].active, true);
});

test("Claude transcript cache reuses unchanged files and invalidates on size change", async () => {
  resetClaudeTranscriptCache();
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-cache-"));
  const project = path.join(root, "project");
  const transcriptPath = path.join(project, "cached-session.jsonl");
  await mkdir(project);
  const first = line({
    type: "user",
    cwd: "C:\\Projects\\Main",
    sessionId: "cached-session",
    message: { role: "user", content: "Название A" },
  });
  await writeFile(transcriptPath, first, "utf8");

  assert.equal((await listClaudeSessionSnapshots({ projectsRoot: root }))[0].title, "Название A");
  assert.deepEqual(claudeTranscriptCacheStats(), {
    entries: 1,
    hits: 0,
    misses: 1,
    fullHistoryReads: 0,
    incrementalHistoryReads: 0,
  });
  assert.equal((await listClaudeSessionSnapshots({ projectsRoot: root }))[0].title, "Название A");
  assert.deepEqual(claudeTranscriptCacheStats(), {
    entries: 1,
    hits: 1,
    misses: 1,
    fullHistoryReads: 0,
    incrementalHistoryReads: 0,
  });

  await appendFile(transcriptPath, `\n${line({ type: "ai-title", aiTitle: "Название C" })}`, "utf8");
  assert.equal((await listClaudeSessionSnapshots({ projectsRoot: root }))[0].title, "Название C");
  assert.deepEqual(claudeTranscriptCacheStats(), {
    entries: 1,
    hits: 1,
    misses: 2,
    fullHistoryReads: 0,
    incrementalHistoryReads: 0,
  });
});

test("Claude session history incrementally parses appended turns", async () => {
  resetClaudeTranscriptCache();
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-incremental-"));
  const project = path.join(root, "project");
  const transcriptPath = path.join(project, "incremental-session.jsonl");
  await mkdir(project);
  await writeFile(transcriptPath, [
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Первый вопрос" } }),
    line({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", stop_reason: "end_turn", content: "Первый ответ" },
    }),
  ].join("\n"), "utf8");

  const first = await readClaudeSessionSnapshot("incremental-session", { projectsRoot: root });
  assert.equal(first.history.length, 1);
  assert.equal(claudeTranscriptCacheStats().fullHistoryReads, 1);

  await appendFile(transcriptPath, `\n${[
    line({ type: "user", uuid: "u2", message: { role: "user", content: "Второй вопрос" } }),
    line({
      type: "assistant",
      uuid: "a2",
      message: { role: "assistant", stop_reason: "end_turn", content: "Второй ответ" },
    }),
  ].join("\n")}`, "utf8");

  const second = await readClaudeSessionSnapshot("incremental-session", { projectsRoot: root });
  assert.deepEqual(second.history.map((turn) => turn.answer), ["Первый ответ", "Второй ответ"]);
  assert.equal(claudeTranscriptCacheStats().fullHistoryReads, 1);
  assert.equal(claudeTranscriptCacheStats().incrementalHistoryReads, 1);
});

test("Claude session history fully rescans a truncated transcript", async () => {
  resetClaudeTranscriptCache();
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-truncated-"));
  const project = path.join(root, "project");
  const transcriptPath = path.join(project, "truncated-session.jsonl");
  await mkdir(project);
  await writeFile(transcriptPath, [
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Старый вопрос" } }),
    line({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", stop_reason: "end_turn", content: "Старый длинный ответ" },
    }),
  ].join("\n"), "utf8");
  await readClaudeSessionSnapshot("truncated-session", { projectsRoot: root });

  await writeFile(transcriptPath, [
    line({ type: "user", uuid: "u2", message: { role: "user", content: "Новый" } }),
    line({
      type: "assistant",
      uuid: "a2",
      message: { role: "assistant", stop_reason: "end_turn", content: "Готово" },
    }),
  ].join("\n"), "utf8");

  const snapshot = await readClaudeSessionSnapshot("truncated-session", { projectsRoot: root });
  assert.deepEqual(snapshot.history.map((turn) => turn.answer), ["Готово"]);
  assert.equal(claudeTranscriptCacheStats().fullHistoryReads, 2);
  assert.equal(claudeTranscriptCacheStats().incrementalHistoryReads, 0);
});

test("Claude session history rejects an append cache after prefix mutation", async () => {
  resetClaudeTranscriptCache();
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-mutated-"));
  const project = path.join(root, "project");
  const transcriptPath = path.join(project, "mutated-session.jsonl");
  await mkdir(project);
  const initial = [
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Первый" } }),
    line({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", stop_reason: "end_turn", content: "OLD-ANSWER" },
    }),
  ].join("\n");
  await writeFile(transcriptPath, initial, "utf8");
  await readClaudeSessionSnapshot("mutated-session", { projectsRoot: root });

  const handle = await open(transcriptPath, "r+");
  try {
    await handle.write(Buffer.from("NEW-ANSWER"), 0, 10, Buffer.from(initial).indexOf("OLD-ANSWER"));
  } finally {
    await handle.close();
  }
  await appendFile(transcriptPath, `\n${[
    line({ type: "user", uuid: "u2", message: { role: "user", content: "Второй" } }),
    line({
      type: "assistant",
      uuid: "a2",
      message: { role: "assistant", stop_reason: "end_turn", content: "SECOND" },
    }),
  ].join("\n")}`, "utf8");

  const snapshot = await readClaudeSessionSnapshot("mutated-session", { projectsRoot: root });
  assert.deepEqual(snapshot.history.map((turn) => turn.answer), ["NEW-ANSWER", "SECOND"]);
  assert.equal(claudeTranscriptCacheStats().fullHistoryReads, 2);
  assert.equal(claudeTranscriptCacheStats().incrementalHistoryReads, 0);
});

test("Claude session history retries an appended partial JSON line", async () => {
  resetClaudeTranscriptCache();
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-partial-"));
  const project = path.join(root, "project");
  const transcriptPath = path.join(project, "partial-session.jsonl");
  await mkdir(project);
  const partialUser = '{"type":"user","uuid":"u2","message":{"role":"user","content":"Второй';
  await writeFile(transcriptPath, `${[
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Первый" } }),
    line({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", stop_reason: "end_turn", content: "Первый ответ" },
    }),
  ].join("\n")}\n${partialUser}`, "utf8");

  const first = await readClaudeSessionSnapshot("partial-session", { projectsRoot: root });
  assert.deepEqual(first.history.map((turn) => turn.answer), ["Первый ответ"]);

  await appendFile(transcriptPath, ` вопрос"}}\n${line({
    type: "assistant",
    uuid: "a2",
    message: { role: "assistant", stop_reason: "end_turn", content: "Второй ответ" },
  })}`, "utf8");

  const second = await readClaudeSessionSnapshot("partial-session", { projectsRoot: root });
  assert.deepEqual(second.history.map((turn) => turn.answer), ["Первый ответ", "Второй ответ"]);
  assert.equal(claudeTranscriptCacheStats().incrementalHistoryReads, 1);
});

test("listClaudeSessionSnapshots excludes command-only utility sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-commands-"));
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "usage-session.jsonl"), [
    line({
      type: "user",
      cwd: "C:\\Projects\\Main",
      sessionId: "usage-session",
      message: {
        role: "user",
        content: "<local-command-caveat>Caveat: generated locally</local-command-caveat>",
      },
    }),
    line({
      type: "user",
      cwd: "C:\\Projects\\Main",
      sessionId: "usage-session",
      message: {
        role: "user",
        content: "<command-name>/usage</command-name><command-message>usage</command-message>",
      },
    }),
  ].join("\n"), "utf8");

  assert.deepEqual(await listClaudeSessionSnapshots({ projectsRoot: root }), []);
});

test("parseClaudeTranscript prefers the Claude-generated ai-title over the last prompt", () => {
  const result = parseClaudeTranscript([
    line({ type: "user", message: { role: "user", content: "Собери обработку из расширения" } }),
    line({ type: "ai-title", aiTitle: "Сборка агрегатной обработки 1С", sessionId: "s1" }),
    line({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: "Готово" } }),
    line({ type: "user", message: { role: "user", content: "продолжай" } }),
  ].join("\n"));

  assert.equal(result.title, "Сборка агрегатной обработки 1С");
  assert.equal(result.catalogTitle, "Сборка агрегатной обработки 1С");
});

test("parseClaudeTranscript uses the freshest ai-title when several are present", () => {
  const result = parseClaudeTranscript([
    line({ type: "ai-title", aiTitle: "Старое название", sessionId: "s1" }),
    line({ type: "user", message: { role: "user", content: "шаг" } }),
    line({ type: "ai-title", aiTitle: "Актуальное название задачи", sessionId: "s1" }),
  ].join("\n"));

  assert.equal(result.catalogTitle, "Актуальное название задачи");
});

test("parseClaudeTranscript prefers a user custom-title and preserves the session root", () => {
  const result = parseClaudeTranscript([
    line({
      type: "user",
      cwd: "C:\\Projects\\Main",
      message: { role: "user", content: "Начальная задача" },
    }),
    line({ type: "ai-title", aiTitle: "Автоматическое имя", cwd: "C:\\Projects\\Main" }),
    line({
      type: "custom-title",
      customTitle: "Ручное имя",
      cwd: "C:\\Projects\\Main\\Utilities\\AgentHub",
    }),
    line({ type: "ai-title", aiTitle: "Автоматическое имя", cwd: "C:\\Projects\\Main\\Utilities" }),
  ].join("\n"));

  assert.equal(result.catalogTitle, "Ручное имя");
  assert.equal(result.title, "Ручное имя");
  assert.equal(result.sessionRoot, "C:\\Projects\\Main");
  assert.equal(result.cwd, "C:\\Projects\\Main\\Utilities");
});

test("Claude catalog keeps a real task even when its latest prompt is a command", () => {
  const result = parseClaudeTranscript([
    line({ type: "user", message: { role: "user", content: "Настроить проект" } }),
    line({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: "Готово" } }),
    line({
      type: "user",
      message: { role: "user", content: "<command-name>/usage</command-name><command-message>usage</command-message>" },
    }),
  ].join("\n"));

  assert.equal(result.title, "Настроить проект");
  assert.equal(result.catalogTitle, "Настроить проект");
  assert.equal(result.completed, true);
  assert.equal(result.active, false);
});
