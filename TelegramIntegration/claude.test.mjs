import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeArgs,
  buildClaudePrompt,
  formatClaudeUsage,
  parseClaudeLimits,
  parseClaudeResult,
  parseClaudeStreamEvent,
} from "./claude.mjs";

test("buildClaudeArgs creates a resumable safe invocation", () => {
  assert.deepEqual(buildClaudeArgs({
    prompt: "fix it",
    sessionId: "session-1",
    model: "sonnet",
    permissionMode: "acceptEdits",
  }), [
    "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "acceptEdits",
    "--model", "sonnet",
    "--resume", "session-1",
    "fix it",
  ]);
});

test("auto approval maps only to bypassPermissions", () => {
  const args = buildClaudeArgs({ prompt: "run", autoApprove: true });
  assert.deepEqual(args.slice(0, 7), [
    "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
  ]);
});

test("parseClaudeStreamEvent extracts session and text deltas", () => {
  const init = parseClaudeStreamEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }));
  assert.equal(init.sessionId, "session-1");
  const delta = parseClaudeStreamEvent(JSON.stringify({
    type: "stream_event",
    session_id: "session-1",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "часть" } },
  }));
  assert.equal(delta.textDelta, "часть");
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
    usage: {
      input_tokens: 17678,
      cache_creation_input_tokens: 100000,
      cache_read_input_tokens: 622432,
      output_tokens: 3059,
      reasoning_output_tokens: 974,
    },
    total_cost_usd: 0.01,
  }));
  assert.equal(result.result, "done");
  const formatted = formatClaudeUsage(result);
  assert.match(formatted, /За задачу: 108 К у\.е\./);
  assert.doesNotMatch(formatted, /743.169/);
  assert.match(formatted, /Вход: 18 К/);
  assert.match(formatted, /Кэш: 72 К/);
  assert.match(formatted, /Выход: 13 К/);
  assert.match(formatted, /Думы: 6 К/);
});

test("parseClaudeLimits reads session, weekly, and model limits", () => {
  const limits = parseClaudeLimits([
    "Current session: 2% used · resets Jul 10, 5:40pm (Asia/Yekaterinburg)",
    "Current week (all models): 6% used · resets Jul 17, 1:59am (Asia/Yekaterinburg)",
    "Current week (Fable): 0% used",
  ].join("\n"));
  assert.deepEqual(limits.map(({ model, usedPercent }) => ({ model, usedPercent })), [
    { model: null, usedPercent: 2 },
    { model: null, usedPercent: 6 },
    { model: "Fable", usedPercent: 0 },
  ]);
});
