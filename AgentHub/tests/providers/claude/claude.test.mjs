import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildClaudeArgs,
  buildClaudePrompt,
  claudeEstimatedCostUsd,
  claudeFailureMessage,
  formatClaudeUsage,
  parseClaudeLimits,
  parseClaudeResult,
  parseClaudeStreamEvent,
  resolveClaudeSessionCwd,
} from "../../../src/providers/claude/claude.mjs";

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

test("buildClaudeArgs recreates a missing local session under the same UUID", () => {
  const args = buildClaudeArgs({
    prompt: "continue safely",
    sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    resumeSession: false,
    model: "opus",
  });
  assert.deepEqual(args.slice(-5), [
    "--model", "opus",
    "--session-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "continue safely",
  ]);
  assert.equal(args.includes("--resume"), false);
});

test("Claude image directories cannot consume a resumed prompt", () => {
  const imageDirectory = path.resolve("C:/runtime/DesktopApp/attachments");
  const args = buildClaudeArgs({
    prompt: "Проверь приложенное изображение",
    sessionId: "session-image",
    model: "opus",
    permissionMode: "acceptEdits",
    additionalDirectories: [imageDirectory, imageDirectory],
  });
  assert.deepEqual(args, [
    "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--add-dir", imageDirectory,
    "--permission-mode", "acceptEdits",
    "--model", "opus",
    "--resume", "session-image",
    "Проверь приложенное изображение",
  ]);
  assert.ok(
    args.indexOf("--permission-mode") > args.indexOf("--add-dir"),
    "a scalar option must terminate Claude's variadic --add-dir before the prompt",
  );
});

test("auto approval maps only to bypassPermissions", () => {
  const args = buildClaudeArgs({ prompt: "run", autoApprove: true });
  assert.deepEqual(args.slice(0, 7), [
    "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "bypassPermissions",
  ]);
});

test("resolveClaudeSessionCwd keeps a nested Claude session inside its configured project", () => {
  const projectRoot = path.resolve("project");
  const sessionCwd = path.join(projectRoot, "Utilities", "AgentHub");
  assert.equal(resolveClaudeSessionCwd(projectRoot, sessionCwd), sessionCwd);
  assert.equal(resolveClaudeSessionCwd(projectRoot), projectRoot);
  assert.throws(
    () => resolveClaudeSessionCwd(projectRoot, path.resolve("outside")),
    /outside the allowed project/,
  );
});

test("claudeFailureMessage preserves stderr for an empty error result", () => {
  assert.equal(claudeFailureMessage({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "",
  }, {
    errorText: "No conversation found with session ID session-1",
    exitCode: 1,
  }), "No conversation found with session ID session-1");
  assert.equal(claudeFailureMessage({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
  }), "Claude Code завершился с ошибкой error_during_execution.");
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

test("parseClaudeResult and formatClaudeUsage convert the whole Claude run to shared credits", () => {
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
    total_cost_usd: 4.5783,
  }));
  assert.equal(result.result, "done");
  assert.equal(claudeEstimatedCostUsd(result), 4.5783);
  const formatted = formatClaudeUsage(result);
  assert.equal(formatted, "📊 За задачу: 114,5 cr");
  assert.doesNotMatch(formatted, /кТЭ/);
});

test("Claude credits fall back to the complete per-model estimate and never guess from tokens", () => {
  const result = {
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    },
    modelUsage: {
      "claude-sonnet-5": { costUSD: 1.25 },
      "claude-haiku-4-5": { costUSD: 0.75 },
    },
  };
  assert.equal(claudeEstimatedCostUsd(result), 2);
  assert.equal(formatClaudeUsage(result), "📊 За задачу: 50 cr");
  assert.equal(
    formatClaudeUsage({ usage: result.usage }),
    "📊 Кредиты за задачу: нет данных.",
  );
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
