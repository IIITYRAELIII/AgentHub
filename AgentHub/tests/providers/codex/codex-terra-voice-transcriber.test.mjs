import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import {
  CodexTerraVoiceTranscriber,
  ensureDashBotTerraStream,
  parseVoiceTranscriptResult,
  voiceTranscriptPrompt,
} from "../../../src/providers/codex/codex-terra-voice-transcriber.mjs";

test("Terra voice transcript parser requires one non-empty transcript", () => {
  assert.equal(parseVoiceTranscriptResult('{"transcript":"Исправить фильтр."}'), "Исправить фильтр.");
  assert.throws(() => parseVoiceTranscriptResult('{"transcript":""}'));
  assert.match(voiceTranscriptPrompt("исправит филтр"), /не меняй смысл/u);
});

test("DashBot Terra stays second in Other and reuses its visible Thread", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-dashbot-terra-"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(directory, "journal.sqlite") });
  await catalog.load();
  t.after(async () => {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  const other = catalog.ensureExperiments();
  const dashBot = catalog.createStream({ workspaceId: other.id, name: "DashBot" });
  catalog.createStream({ workspaceId: other.id, name: "Existing" });
  const terra = ensureDashBotTerraStream(catalog, {
    firstStreamId: dashBot.id,
    projectRoot: "D:/Workspace",
  });
  assert.deepEqual(
    catalog.hierarchy().find((workspace) => workspace.id === other.id).streams.map((stream) => stream.name),
    ["DashBot", "DashBot Terra", "Existing"],
  );

  const calls = [];
  const transcriber = new CodexTerraVoiceTranscriber({
    pythonExe: "python",
    transcribeScript: "transcribe.py",
    projectRoot: "D:/Workspace",
    workspaceCatalog: catalog,
    streamId: terra.id,
    resolveExecutable: async () => "codex",
    runProcess: async (command, args, options) => {
      calls.push([command, args, options]);
      if (command === "python") return { code: 0, stdout: "исправит филтр", stderr: "" };
      const outputFile = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputFile, '{"transcript":"Исправить фильтр."}', "utf8");
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "thread-terra" })}\n`,
        stderr: "",
      };
    },
  });

  assert.equal(await transcriber.transcribe("D:/voice.ogg"), "Исправить фильтр.");
  assert.equal(await transcriber.transcribe("D:/voice-2.ogg"), "Исправить фильтр.");
  assert.equal(calls[0][2].env.WHISPER_MODEL, "large-v3-turbo");
  assert.equal(calls[0][2].env.WHISPER_DEVICE, "cuda");
  assert.equal(calls[1][1].includes("gpt-5.6-terra"), true);
  assert.deepEqual(calls[3][1].slice(0, 3), ["exec", "resume", "--ignore-user-config"]);
  assert.equal(calls[3][1].includes("thread-terra"), true);
  assert.equal(catalog.resolveThread({ provider: "codex", threadId: "thread-terra" }).streamName, "DashBot Terra");
});
