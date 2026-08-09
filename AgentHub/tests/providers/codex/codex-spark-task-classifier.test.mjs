import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTaskClassifierResult,
  taskClassifierPrompt,
} from "../../../src/providers/codex/codex-spark-task-classifier.mjs";

test("Spark Task classifier validates structured output", () => {
  assert.deepEqual(parseTaskClassifierResult(JSON.stringify({
    correctedText: "Посмотреть «Дюну»",
    category: "note",
    workspaceId: null,
    confidence: 0.91,
    reason: "Фильм",
  })), {
    correctedText: "Посмотреть «Дюну»",
    category: "note",
    workspaceId: null,
    confidence: 0.91,
    reason: "Фильм",
  });
  assert.throws(() => parseTaskClassifierResult('{"confidence":2}'));
});

test("Spark Task prompt contains only the supplied Workspace catalog", () => {
  const prompt = taskClassifierPrompt({
    text: "починить хаб",
    workspaces: [{ id: "hub", name: "Agent Hub" }],
  });
  assert.match(prompt, /"id":"hub"/u);
  assert.match(prompt, /починить хаб/u);
});
