import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexFinalTurnAnswer,
  codexTurnAnswer,
  claudeTranscriptCacheStats,
  lastCompletedCodexAnswer,
  listClaudeSessionSnapshots,
  parseClaudeTranscript,
  readClaudeSessionSnapshot,
  resetClaudeTranscriptCache,
} from "./last-message.mjs";

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
    sessionId: null,
    cwd: null,
    title: "Сделай задачу",
    catalogTitle: "Сделай задачу",
    isSidechain: false,
  });
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
  assert.deepEqual(claudeTranscriptCacheStats(), { entries: 1, hits: 0, misses: 1 });
  assert.equal((await listClaudeSessionSnapshots({ projectsRoot: root }))[0].title, "Название A");
  assert.deepEqual(claudeTranscriptCacheStats(), { entries: 1, hits: 1, misses: 1 });

  await appendFile(transcriptPath, `\n${line({ type: "ai-title", aiTitle: "Название C" })}`, "utf8");
  assert.equal((await listClaudeSessionSnapshots({ projectsRoot: root }))[0].title, "Название C");
  assert.deepEqual(claudeTranscriptCacheStats(), { entries: 1, hits: 1, misses: 2 });
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

test("Claude catalog keeps a real task even when its latest prompt is a command", () => {
  const result = parseClaudeTranscript([
    line({ type: "user", message: { role: "user", content: "Настроить проект" } }),
    line({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: "Готово" } }),
    line({
      type: "user",
      message: { role: "user", content: "<command-name>/usage</command-name><command-message>usage</command-message>" },
    }),
  ].join("\n"));

  assert.equal(result.title.startsWith("<command-name>"), true);
  assert.equal(result.catalogTitle, "Настроить проект");
});
