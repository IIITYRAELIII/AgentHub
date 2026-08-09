import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import {
  CodexSparkTaskClassifier,
  ensureDashBotStream,
  parseTaskClassifierResult,
  parseTaskClassifierThreadId,
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

test("Spark Task classifier keeps one visible DashBot Thread first in Other", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-dashbot-"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(directory, "journal.sqlite") });
  await catalog.load();
  t.after(async () => {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  const other = catalog.ensureExperiments();
  catalog.createStream({ workspaceId: other.id, name: "Existing" });
  const stream = ensureDashBotStream(catalog, {
    model: "gpt-5.3-codex-spark",
    projectRoot: "D:/Workspace",
  });
  const calls = [];
  const classifier = new CodexSparkTaskClassifier({
    projectRoot: "D:/Workspace",
    workspaceCatalog: catalog,
    streamId: stream.id,
    resolveExecutable: async () => "codex",
    runProcess: async (_command, args) => {
      calls.push(args);
      const outputFile = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputFile, JSON.stringify({
        correctedText: "Посмотреть «Дюну»",
        category: "note",
        workspaceId: null,
        confidence: 0.91,
        reason: "Фильм",
      }), "utf8");
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "thread-dashbot" })}\n`,
        stderr: "",
      };
    },
  });

  await classifier.classify({ text: "дюна", workspaces: [] });
  await classifier.classify({ text: "дюна 2", workspaces: [] });

  assert.equal(calls[0].includes("--ephemeral"), false);
  assert.equal(calls[0].includes("--json"), true);
  assert.deepEqual(calls[1].slice(0, 3), ["exec", "resume", "--ignore-user-config"]);
  assert.equal(calls[1].includes("thread-dashbot"), true);
  const resolved = catalog.resolveThread({ provider: "codex", threadId: "thread-dashbot" });
  assert.equal(resolved.workspaceName, "Other");
  assert.equal(resolved.streamName, "DashBot");
  const streams = catalog.hierarchy().find((workspace) => workspace.name === "Other").streams;
  assert.deepEqual(streams.map((item) => item.name), ["DashBot", "Existing"]);
  assert.deepEqual(streams.map((item) => item.ordinal), [1, 2]);
});

test("Spark Task classifier extracts the persisted Thread from Codex JSONL", () => {
  assert.equal(parseTaskClassifierThreadId([
    "diagnostic",
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n")), "thread-1");
});
