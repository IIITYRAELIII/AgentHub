import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeArgs, buildClaudePrompt, formatClaudeUsage, parseClaudeResult } from "./claude.mjs";

test("buildClaudeArgs creates a resumable safe invocation", () => {
  assert.deepEqual(buildClaudeArgs({
    prompt: "fix it",
    sessionId: "session-1",
    model: "sonnet",
    permissionMode: "acceptEdits",
  }), [
    "--print", "--output-format", "json",
    "--permission-mode", "acceptEdits",
    "--model", "sonnet",
    "--resume", "session-1",
    "fix it",
  ]);
});

test("auto approval maps only to bypassPermissions", () => {
  const args = buildClaudeArgs({ prompt: "run", autoApprove: true });
  assert.deepEqual(args.slice(0, 5), [
    "--print", "--output-format", "json", "--permission-mode", "bypassPermissions",
  ]);
});

test("buildClaudePrompt includes local image paths", () => {
  const prompt = buildClaudePrompt([
    { type: "text", text: "Что на картинке?" },
    { type: "localImage", path: "data/image.png" },
  ]);
  assert.match(prompt, /Что на картинке/);
  assert.match(prompt, /image\.png/);
});

test("parseClaudeResult and formatClaudeUsage handle CLI JSON", () => {
  const result = parseClaudeResult(JSON.stringify({
    type: "result",
    result: "done",
    session_id: "session-1",
    usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 },
    total_cost_usd: 0.01,
  }));
  assert.equal(result.result, "done");
  assert.match(formatClaudeUsage(result), /17/);
  assert.match(formatClaudeUsage(result), /\$0\.0100/);
});
