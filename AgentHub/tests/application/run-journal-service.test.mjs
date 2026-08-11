import assert from "node:assert/strict";
import test from "node:test";

import { RunJournalService } from "../../src/application/run-journal-service.mjs";

function fixture({ statImpl = async () => ({}) } = {}) {
  const calls = [];
  const usageStore = {
    recordAutomaticAndProject: async (value) => { calls.push(["automatic", value]); return value; },
    recordAndProject: async (value) => { calls.push(["explicit", value]); return value; },
    mergeTurnTexts: async (value) => calls.push(["merge", value]),
    project: async (...args) => calls.push(["project", ...args]),
    retireLegacyStorage: async (value) => { calls.push(["retire", value]); return { removed: ["old"] }; },
  };
  const service = new RunJournalService({
    usageStore,
    findProject: (root) => root === "C:/workspace" ? { path: root } : null,
    defaultProjectRoot: "C:/workspace",
    projectionProjectRoots: ["C:/workspace"],
    legacyLedgerFile: "legacy-ledger.json",
    legacyWorkLogFile: "WORK_LOG.md",
    messageLimit: 2,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    statImpl,
    logger: { log: (...args) => calls.push(["log", ...args]), error: (...args) => calls.push(["error", ...args]) },
  });
  return { service, calls };
}

test("RunJournalService owns bounded last-message state by task identity", () => {
  const { service } = fixture();
  const task = (threadId) => ({ provider: "codex", projectRoot: "C:/workspace", threadId });
  service.rememberLastMessage(task("one"), "First");
  service.rememberLastMessage({ ...task("one"), turnId: "turn-2" }, "Updated");
  service.rememberLastMessage(task("two"), "Second");
  service.rememberLastMessage(task("three"), "Third");
  assert.equal(service.lastMessage(task("one")), "");
  assert.equal(service.lastMessage(task("two")), "Second");
  assert.equal(service.lastMessageRecord(task("three")).updatedAt, "2026-08-04T12:00:00.000Z");
  assert.equal(service.lastMessageRecord(task("three")).threadId, "three");
  assert.equal(service.lastMessageRecord(task("three")).provider, "codex");
  assert.equal(service.lastMessageSnapshot().length, 2);
});

test("RunJournalService preserves authoritative answer time during repeated observation", () => {
  const { service } = fixture();
  const task = { provider: "codex", projectRoot: "C:/workspace", threadId: "thread", turnId: "turn-1" };
  service.rememberLastMessage(task, "Answer", { updatedAt: "2026-08-04T03:52:00.000Z" });

  service.rememberLastMessage(task, "Answer");
  assert.equal(service.lastMessageRecord(task).updatedAt, "2026-08-04T03:52:00.000Z");

  service.rememberLastMessage(task, "Answer", { updatedAt: "2026-08-04T01:53:46.371Z" });
  assert.equal(service.lastMessageRecord(task).updatedAt, "2026-08-04T01:53:46.371Z");

  service.rememberLastMessage({ ...task, turnId: "older-turn" }, "Old answer", {
    updatedAt: "2026-08-04T01:00:00.000Z",
  });
  assert.equal(service.lastMessageRecord(task).text, "Answer");
});

test("RunJournalService restores only valid bounded message records", () => {
  const { service } = fixture();
  const restored = service.restoreLastMessages([
    ["old", { text: "Old" }],
    ["bad", {}],
    ["new-1", { text: "One" }],
    ["new-2", { text: "Two" }],
  ]);
  assert.equal(restored, 2);
  assert.deepEqual(service.lastMessageSnapshot().map(([key]) => key), ["new-1", "new-2"]);
});

test("RunJournalService selects automatic and explicit journal projection paths", async () => {
  const { service, calls } = fixture();
  const completion = {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "turn",
    taskTitle: "Task",
    status: "completed",
  };
  await service.projectTurn(completion, { body: "Useful final answer" });
  await service.projectTurn({ ...completion, message: { workLogId: "row-1" } }, { title: "Title" });
  assert.equal(calls[0][0], "automatic");
  assert.equal(calls[0][1].title, "Useful final answer");
  assert.equal(calls[1][0], "explicit");
  assert.equal(calls[1][1].workLogId, "row-1");
});

test("RunJournalService projects the initial and every steered message", async () => {
  const { service, calls } = fixture();
  await service.projectTurn({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread",
    turnId: "turn",
    prompts: ["Изначальный запрос", "Первое уточнение", "Второе уточнение"],
    status: "completed",
  }, { body: "Готово" });

  assert.equal(
    calls[0][1].prompt,
    "Изначальный запрос\n\nПервое уточнение\n\nВторое уточнение",
  );
});

test("RunJournalService initializes projection before retiring verified legacy storage", async () => {
  const { service, calls } = fixture();
  const retirement = await service.initialize({
    pending: [{ workLogId: "pending" }],
    completions: [{ message: { workLogId: "completed" } }],
  });
  assert.deepEqual(calls.slice(0, 3).map(([name]) => name), ["merge", "project", "retire"]);
  assert.deepEqual(retirement.removed, ["old"]);
});

test("RunJournalService keeps legacy files when no ledger exists", async () => {
  const missing = new Error("missing");
  missing.code = "ENOENT";
  const { service, calls } = fixture({ statImpl: async () => { throw missing; } });
  assert.equal(await service.initialize(), null);
  assert.equal(calls.some(([name]) => name === "retire"), false);
});
