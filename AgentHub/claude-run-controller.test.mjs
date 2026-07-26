import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeRunController } from "./claude-run-controller.mjs";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "claude-controller-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

test("ClaudeRunController owns detached output, stream parsing and completion", async () => {
  await withTempDir(async (directory) => {
    const events = [];
    let resolveCompletion;
    const completed = new Promise((resolve) => { resolveCompletion = resolve; });
    const run = { turnId: "turn-one", threadId: "session-one" };
    const controller = new ClaudeRunController({
      dataDir: directory,
      pollIntervalMs: 5,
      isCurrentRun: (candidate) => candidate === run,
      onStreamEvent: (_run, parsed) => events.push(parsed),
      onComplete: (_run, result) => resolveCompletion(result),
    });
    const payload = JSON.stringify({
      type: "result",
      result: "готово",
      session_id: "session-one",
      usage: {},
    });
    await controller.start(run, {
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(`${payload}\n`)})`],
      cwd: directory,
      env: process.env,
    });
    const completion = await completed;
    assert.equal(completion.result.result, "готово");
    assert.equal(events.at(-1).result.result, "готово");
    assert.equal(run.claudeSettled, true);
  });
});

test("ClaudeRunController reattaches from a saved offset and finalizes a result", async () => {
  await withTempDir(async (directory) => {
    const outputPath = path.join(directory, "saved.jsonl");
    const errorPath = path.join(directory, "saved.err.log");
    await writeFile(outputPath, `${JSON.stringify({
      type: "result",
      result: "после рестарта",
      session_id: "session-two",
      usage: {},
    })}\n`, "utf8");
    await writeFile(errorPath, "", "utf8");
    let completion;
    const run = {
      turnId: "turn-two",
      threadId: "session-two",
      pid: process.pid,
      claudeOutputPath: outputPath,
      claudeErrorPath: errorPath,
    };
    const controller = new ClaudeRunController({
      dataDir: directory,
      isCurrentRun: (candidate) => candidate === run,
      onComplete: (_run, value) => { completion = value; },
    });
    const alive = await controller.attachAfterRestart(run);
    assert.equal(alive, true);
    assert.equal(completion.result.result, "после рестарта");
    assert.equal(run.claudeSettled, true);
  });
});
