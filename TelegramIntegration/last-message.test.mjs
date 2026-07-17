import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  codexTurnAnswer,
  listClaudeSessionSnapshots,
  parseClaudeTranscript,
  readClaudeSessionSnapshot,
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
    updatedAt: null,
    sessionId: null,
    cwd: null,
    title: "Сделай задачу",
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
  assert.equal(snapshots[0].active, true);
});
