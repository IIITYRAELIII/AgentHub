import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const context = vm.createContext({ window: {} });
vm.runInContext(await readFile(new URL("../../assets/web-app/stream-tabs-controller.js", import.meta.url), "utf8"), context);
const api = context.window.AgentHubStreamTabs;

for (const flags of [{ activityUnknown: true }, { preparing: true }]) test(`compact status preserves canonical ${Object.keys(flags)[0]} before live content`, () => {
  const live = { provider: "codex", threadId: "thread", turnId: "turn", operationKind: "user-turn", projectionState: "active", text: "stale answer" };
  const task = { provider: "codex", threadId: "thread", running: true, ...flags };
  assert.equal(api.dialogListPresentation(task, { live }).status, api.streamStatusPresentation(task).statusLabel);
});

test("another turn's live text cannot label the selected turn as answering", () => {
  const task = { provider: "codex", threadId: "thread", running: true, run: { turnId: "current" } };
  const live = { provider: "codex", threadId: "thread", turnId: "previous", operationKind: "user-turn", projectionState: "active", text: "old answer" };
  assert.equal(api.dialogListPresentation(task, { live }).status, "Готовит ответ");
  assert.equal(api.dialogListPresentation(task, { live: { ...live, turnId: "current" } }).status, "Отвечает");
});
