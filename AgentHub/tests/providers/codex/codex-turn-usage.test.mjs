import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../../src/domain/codex-context-probe.mjs";

import {
  codexRecentTerminalTurnsFromJsonl,
  codexSubagentSpawnFromJsonl,
  codexTurnUsageFromJsonl,
  discoverCodexRollouts,
  discoverCodexSubagentRollouts,
  findCodexRolloutPath,
  readCodexRolloutSession,
  readCodexRolloutTail,
  readCodexTurnUsage,
  scanCodexHistoricalRollout,
  scanCodexTerminalEventsFromOffset,
  scanCodexTurnJsonl,
  scanCodexTurnJsonlIncrementally,
  scanCodexTurnPricingMetadata,
} from "../../../src/providers/codex/codex-turn-usage.mjs";

function line(value) {
  return JSON.stringify(value);
}

function response(turnId, type = "reasoning", extra = {}) {
  return {
    type: "response_item",
    payload: {
      type,
      ...extra,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

function token(input, cache, output, reasoning) {
  return {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cache,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + output,
        },
      },
    },
  };
}

test("Codex rollout usage sums every model response and sees the final token event", () => {
  const startedAt = "2026-07-26T19:03:03.527Z";
  const completedAt = "2026-07-26T19:09:33.227Z";
  const text = [
    line({ type: "event_msg", payload: {
      type: "thread_settings_applied",
      thread_settings: { model: "gpt-5.6-sol", service_tier: "fast" },
    } }),
    line({ timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line({ type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol" } }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line(response("turn-1", "message", {
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Готовый результат" }],
    })),
    line(token(50, 40, 5, 1)),
    line({ timestamp: completedAt, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.equal(result.reported, true);
  assert.equal(result.finalAnswerSeen, true);
  assert.equal(result.finalAnswer, "Готовый результат");
  assert.equal(result.finalTokenSeen, true);
  assert.equal(result.terminal, true);
  assert.equal(result.status, "completed");
  assert.equal(result.startedAt, startedAt);
  assert.equal(result.completedAt, completedAt);
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.serviceTier, "fast");
  assert.deepEqual(result.usage, {
    inputTokens: 150,
    cachedInputTokens: 120,
    outputTokens: 15,
    reasoningOutputTokens: 5,
    totalTokens: 165,
  });
});

test("Codex rollout usage accepts the terminal last agent message", () => {
  const text = [
    line({ timestamp: "2026-08-08T10:00:00Z", type: "event_msg", payload: {
      type: "task_started", turn_id: "turn-terminal-answer",
    } }),
    line(token(50, 40, 5, 1)),
    line({ timestamp: "2026-08-08T10:01:00Z", type: "event_msg", payload: {
      type: "task_complete",
      turn_id: "turn-terminal-answer",
      last_agent_message: "Точный итог из terminal event",
    } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-terminal-answer");
  assert.equal(result.finalAnswerSeen, true);
  assert.equal(result.finalAnswer, "Точный итог из terminal event");
  assert.equal(result.finalTokenSeen, true);
});

test("historical rollout scan extracts all turns in one streaming pass", async () => {
  const first = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const second = "019f1ec9-8de7-7aa3-92b6-045036561c8e";
  const text = [
    line({ type: "session_meta", payload: {
      id: "019f1ec7-8de7-7aa3-92b6-045036561c8e",
      cwd: "D:\\workspace",
      parent_thread_id: "019f1ec6-8de7-7aa3-92b6-045036561c8e",
    } }),
    line({ timestamp: "2026-07-01T10:00:00Z", type: "event_msg", payload: {
      type: "task_started", turn_id: first,
    } }),
    line({ type: "turn_context", payload: {
      turn_id: first, model: "gpt-5.6-sol", service_tier: "fast",
    } }),
    line(response(first, "message", {
      role: "user",
      content: [{ type: "input_text", text: "Первый запрос" }],
    })),
    line(response(first)),
    line(token(100, 80, 10, 4)),
    line(response(first, "message", {
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Первый ответ" }],
    })),
    line({ timestamp: "2026-07-01T10:01:00Z", type: "event_msg", payload: {
      type: "task_complete", turn_id: first,
    } }),
    line({ timestamp: "2026-07-01T11:00:00Z", type: "event_msg", payload: {
      type: "task_started", turn_id: second,
    } }),
    line(response(second, "message", {
      role: "user",
      content: [{ type: "input_text", text: "Второй запрос" }],
    })),
    line(response(second)),
    line(token(50, 40, 5, 1)),
    line({ timestamp: "2026-07-01T11:01:00Z", type: "event_msg", payload: {
      type: "turn_aborted", turn_id: second,
    } }),
  ].join("\n");

  const result = await scanCodexHistoricalRollout("fixture.jsonl", {
    createReadStreamImpl: () => Readable.from([text]),
  });
  assert.equal(result.session.threadId, "019f1ec7-8de7-7aa3-92b6-045036561c8e");
  assert.equal(result.session.parentThreadId, "019f1ec6-8de7-7aa3-92b6-045036561c8e");
  assert.equal(result.turns.length, 2);
  assert.deepEqual(result.turns.map((turn) => ({
    turnId: turn.turnId,
    prompt: turn.prompt,
    finalAnswer: turn.finalAnswer,
    status: turn.status,
    usage: turn.usage,
    model: turn.model,
    serviceTier: turn.serviceTier,
  })), [
    {
      turnId: first,
      prompt: "Первый запрос",
      finalAnswer: "Первый ответ",
      status: "completed",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 10,
        reasoningOutputTokens: 4,
        totalTokens: 110,
      },
      model: "gpt-5.6-sol",
      serviceTier: "fast",
    },
    {
      turnId: second,
      prompt: "Второй запрос",
      finalAnswer: "",
      status: "aborted",
      usage: {
        inputTokens: 50,
        cachedInputTokens: 40,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 55,
      },
      model: "",
      serviceTier: "default",
    },
  ]);
});

test("rollout session reads nested subagent parent metadata", async () => {
  const text = line({
    timestamp: "2026-07-13T14:49:54.071Z",
    type: "session_meta",
    payload: {
      id: "child-thread",
      cwd: "D:\\workspace",
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: "parent-thread" },
        },
      },
      git: {
        repository_url: "D:\\workspace\\origin.git",
      },
    },
  });
  const session = await readCodexRolloutSession("archived.jsonl", {
    createReadStreamImpl: () => Readable.from([`${text}\n`]),
  });
  assert.deepEqual(session, {
    id: "child-thread",
    threadId: "child-thread",
    parentThreadId: "parent-thread",
    cwd: "D:\\workspace",
    workspaceRoot: "D:\\workspace",
    path: "archived.jsonl",
    repositoryUrl: "D:\\workspace\\origin.git",
    createdAt: "2026-07-13T14:49:54.071Z",
    updatedAt: "2026-07-13T14:49:54.071Z",
    source: {
      subagent: {
        thread_spawn: { parent_thread_id: "parent-thread" },
      },
    },
  });
});

test("subagent rollout discovery includes active and archived sessions", async () => {
  const directories = new Map([
    [path.join("C:\\Codex", "sessions"), [{
      name: "active.jsonl", isDirectory: () => false, isFile: () => true,
    }]],
    [path.join("C:\\Codex", "archived_sessions"), [{
      name: "archived.jsonl", isDirectory: () => false, isFile: () => true,
    }]],
  ]);
  const result = await discoverCodexSubagentRollouts({
    codexHome: "C:\\Codex",
    readdirImpl: async (directory) => directories.get(directory) ?? [],
    readSession: async (file) => ({
      threadId: path.basename(file, ".jsonl"),
      parentThreadId: "parent-thread",
      cwd: "D:\\workspace",
      path: file,
    }),
  });
  assert.deepEqual(result.map((value) => value.threadId).sort(), ["active", "archived"]);
});

test("rollout discovery reuses sessions while tracking new deleted and incomplete files", async () => {
  const sessionsDirectory = path.join("C:\\Codex", "sessions");
  const archivedDirectory = path.join("C:\\Codex", "archived_sessions");
  const activeEntries = [{
    name: "active.jsonl", isDirectory: () => false, isFile: () => true,
  }];
  const directories = new Map([
    [sessionsDirectory, activeEntries],
    [archivedDirectory, []],
  ]);
  const sessionCache = new Map();
  const reads = new Map();
  const readSession = async (file) => {
    const name = path.basename(file, ".jsonl");
    reads.set(name, (reads.get(name) ?? 0) + 1);
    if (name === "incomplete" && reads.get(name) === 1) return null;
    return {
      threadId: name,
      parentThreadId: "parent-thread",
      cwd: "D:\\workspace",
      path: file,
    };
  };
  const discover = () => discoverCodexSubagentRollouts({
    codexHome: "C:\\Codex",
    readdirImpl: async (directory) => directories.get(directory) ?? [],
    readSession,
    sessionCache,
  });

  assert.deepEqual((await discover()).map((value) => value.threadId), ["active"]);
  assert.deepEqual((await discover()).map((value) => value.threadId), ["active"]);
  assert.equal(reads.get("active"), 1);

  activeEntries.push({
    name: "incomplete.jsonl", isDirectory: () => false, isFile: () => true,
  });
  assert.deepEqual((await discover()).map((value) => value.threadId), ["active"]);
  assert.deepEqual(
    (await discover()).map((value) => value.threadId).sort(),
    ["active", "incomplete"],
  );
  assert.equal(reads.get("incomplete"), 2);

  activeEntries.shift();
  assert.deepEqual((await discover()).map((value) => value.threadId), ["incomplete"]);
  assert.equal(sessionCache.size, 1);
});

test("historical rollout flags a manual context compaction as non-turn activity", async () => {
  const turnId = "019fc8f7-7215-7760-97a5-13412d91920a";
  const text = [
    line({ timestamp: "2026-08-03T18:51:32.555Z", type: "event_msg", payload: {
      type: "task_started", turn_id: turnId,
    } }),
    // Replacement history belongs to earlier turns; it must not turn this
    // synthetic compaction lifecycle into a final assistant answer.
    line({ timestamp: "2026-08-03T18:52:03.284Z", type: "compacted", payload: {
      replacement_history: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Старый ответ" }],
        internal_chat_message_metadata_passthrough: { turn_id: "old-turn" },
      }],
    } }),
    line({ timestamp: "2026-08-03T18:52:03.340Z", type: "event_msg", payload: {
      type: "task_complete", turn_id: turnId, last_agent_message: null,
    } }),
  ].join("\n");

  const result = await scanCodexHistoricalRollout("fixture.jsonl", {
    createReadStreamImpl: () => Readable.from([text]),
  });

  assert.deepEqual(result.turns.map((turn) => ({
    turnId: turn.turnId,
    finalAnswer: turn.finalAnswer,
    compactionOnly: turn.compactionOnly,
  })), [{
    turnId,
    finalAnswer: "",
    compactionOnly: true,
  }]);
});

test("subagent activity identifies its exact parent turn", async () => {
  const parentTurnId = "019f1ec8-8de7-7aa3-92b6-045036561c8e";
  const childThreadId = "019f1ec9-8de7-7aa3-92b6-045036561c8e";
  const text = [
    line({ timestamp: "2026-07-01T10:00:00Z", type: "event_msg", payload: {
      type: "task_started", turn_id: parentTurnId,
    } }),
    line({ timestamp: "2026-07-01T10:00:05Z", type: "event_msg", payload: {
      type: "sub_agent_activity",
      event_id: "call-child",
      occurred_at_ms: 1_788_000_005_000,
      agent_thread_id: childThreadId,
      agent_path: "/root/child",
      kind: "started",
    } }),
    line({ timestamp: "2026-07-01T10:01:00Z", type: "event_msg", payload: {
      type: "task_complete", turn_id: parentTurnId,
    } }),
  ].join("\n");

  assert.deepEqual(codexSubagentSpawnFromJsonl(text, childThreadId), {
    threadId: childThreadId,
    eventId: "call-child",
    agentPath: "/root/child",
    occurredAt: 1_788_000_005_000,
    parentTurnId,
  });
  const historical = await scanCodexHistoricalRollout("fixture.jsonl", {
    createReadStreamImpl: () => Readable.from([text]),
  });
  assert.deepEqual(historical.turns[0].spawnedSubagents, [{
    threadId: childThreadId,
    eventId: "call-child",
    agentPath: "/root/child",
    occurredAt: 1_788_000_005_000,
  }]);
});

test("complete rollout discovery also includes ordinary sessions", async () => {
  const directories = new Map([
    [path.join("C:\\Codex", "sessions"), [{
      name: "ordinary.jsonl", isDirectory: () => false, isFile: () => true,
    }]],
    [path.join("C:\\Codex", "archived_sessions"), []],
  ]);
  const result = await discoverCodexRollouts({
    codexHome: "C:\\Codex",
    readdirImpl: async (directory) => directories.get(directory) ?? [],
    readSession: async (file) => ({
      threadId: "ordinary",
      parentThreadId: "",
      cwd: "D:\\workspace",
      path: file,
    }),
  });
  assert.deepEqual(result.map((value) => value.threadId), ["ordinary"]);
});

test("streaming rollout scan extracts the exact prompt, terminal status and changed files", async () => {
  const startedAt = "2026-07-26T19:03:03.527Z";
  const completedAt = "2026-07-26T19:04:03.527Z";
  const text = [
    line({ timestamp: startedAt, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-other", "message", {
      role: "user",
      content: [{ type: "input_text", text: "Чужой запрос" }],
    })),
    line(response("turn-1", "message", {
      role: "user",
      content: [{
        type: "input_text",
        text: "Служебное начало\n<environment_context>скрыть</environment_context>\nТочный запрос",
      }],
    })),
    line({
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        turn_id: "turn-1",
        changes: {
          "D:\\repo\\first.mjs": { type: "update" },
          "D:\\repo\\second.mjs": { type: "add" },
        },
      },
    }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line({ timestamp: completedAt, type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } }),
  ].join("\n");

  const result = await scanCodexTurnJsonl("large-rollout.jsonl", "turn-1", {
    createReadStreamImpl: () => Readable.from(text.split("\n").map((value) => `${value}\n`)),
  });

  assert.equal(result.prompt, "Служебное начало\n\nТочный запрос");
  assert.equal(result.status, "aborted");
  assert.equal(result.terminal, true);
  assert.equal(result.startedAt, startedAt);
  assert.equal(result.completedAt, completedAt);
  assert.deepEqual(result.changedFiles, [
    "D:\\repo\\first.mjs",
    "D:\\repo\\second.mjs",
  ]);
  assert.equal(result.usage.inputTokens, 100);
});

test("streaming rollout scan extracts files from the apply_patch tool call", async () => {
  const text = [
    line({ type: "session_meta", payload: { cwd: "D:\\repo" } }),
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "custom_tool_call", {
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src/one.mjs\n@@\n-old\n+new\n*** Add File: D:\\repo\\src\\two.mjs\n+two\n*** End Patch",
    })),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");
  const result = await scanCodexTurnJsonl("rollout.jsonl", "turn-1", {
    createReadStreamImpl: () => Readable.from(text.split("\n").map((value) => `${value}\n`)),
  });
  assert.deepEqual(result.changedFiles, [
    "D:\\repo\\src\\one.mjs",
    "D:\\repo\\src\\two.mjs",
  ]);
  assert.match(result.diff, /^\*\*\* Begin Patch/mu);
  assert.match(result.diff, /^\*\*\* Update File: src\/one\.mjs$/mu);
  assert.match(result.diff, /^\+new$/mu);
});

test("rollout scan counts completed imagegen calls for the exact turn", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "function_call", {
      name: "imagegen",
      call_id: "call-image-1",
    })),
    line({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "call-image-1",
        status: "completed",
      },
    }),
    line(response("turn-other", "function_call", {
      name: "imagegen",
      call_id: "call-image-other",
    })),
    line({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "call-image-other",
        status: "completed",
      },
    }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.equal(result.reported, true);
  assert.equal(result.imageGenerationCount, 1);
  assert.equal(result.estimatedCredits, 90);
  assert.equal(result.estimateKind, "imagegen-default");
});

test("rollout scan records explicit skills and completed MCP calls without payload data", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", {
      role: "developer",
      content: [{
        type: "input_text",
        text: "### Available skills\n- openai-docs: Read docs\n- plugin:review: Review code\n",
      }],
    })),
    line(response("turn-1", "message", {
      role: "user",
      content: [{
        type: "input_text",
        text: "$openai-docs и $plugin:review проверь API; цена $100 не является навыком",
      }],
    })),
    line(response("turn-1")),
    line(response("turn-1", "custom_tool_call", {
      name: "shell_command",
      input: JSON.stringify({
        command: "Get-Content C:\\Users\\me\\.agents\\skills\\openai-docs\\SKILL.md",
      }),
    })),
    line({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "call-mcp-1",
        invocation: {
          server: "openaiDeveloperDocs",
          tool: "search_openai_docs",
          arguments: { query: "secret request details" },
        },
        result: { Ok: { content: [{ type: "text", text: "large private result" }] } },
      },
    }),
    line({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "call-mcp-2",
        invocation: { server: "github", tool: "get_pull_request", arguments: { number: 42 } },
        result: { Err: "failed details" },
      },
    }),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.deepEqual(result.skillsUsed, ["openai-docs", "plugin:review"]);
  assert.deepEqual(result.mcpCalls, [
    {
      id: "call-mcp-1",
      server: "openaiDeveloperDocs",
      tool: "search_openai_docs",
      status: "completed",
    },
    {
      id: "call-mcp-2",
      server: "github",
      tool: "get_pull_request",
      status: "failed",
    },
  ]);
  assert.equal(result.toolMetricsKnown, true);
  assert.doesNotMatch(JSON.stringify(result.mcpCalls), /secret|private|number/u);
});

test("rollout scan recognizes a skill read through a JSON-escaped Windows path", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", {
      role: "developer",
      content: [{
        type: "input_text",
        text: "### Available skills\n- visualize: Build visualizations\n",
      }],
    })),
    line(response("turn-1", "custom_tool_call", {
      name: "exec",
      input: JSON.stringify({
        command: String.raw`Get-Content C:\Users\me\.codex\skills\visualize\SKILL.md`,
      }),
    })),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.deepEqual(result.skillsUsed, ["visualize"]);
  assert.deepEqual(result.mcpCalls, []);
});

test("rollout scan records numeric and lazily routed skills without counting path mentions", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", {
      role: "developer",
      content: [{
        type: "input_text",
        text: "### Available skills\n- 1c-skills: Route 1C workflows\n- handoff: Save context\n",
      }],
    })),
    line(response("turn-1", "message", {
      role: "user",
      content: [{ type: "input_text", text: "$1c-skills собери CF" }],
    })),
    line(response("turn-1", "custom_tool_call", {
      name: "exec",
      input: JSON.stringify({
        command: String.raw`Get-Content -Raw D:\projects\Utilities\Import\1C_SKILLS\db-dump-cf\SKILL.md`,
      }),
    })),
    line(response("turn-1", "custom_tool_call", {
      name: "exec",
      input: "apply_patch mentions C:/Users/me/.agents/skills/handoff/SKILL.md and "
        + "D:/projects/Utilities/Import/1C_SKILLS/composing-1c-queries/SKILL.md",
    })),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.deepEqual(result.skillsUsed, ["1c-skills", "db-dump-cf"]);
});

test("rollout scan counts imagegen completed inside an exec orchestration call", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "custom_tool_call", {
      name: "exec",
      call_id: "call-exec-1",
      input: "await tools.image_gen__imagegen({ prompt: 'night forest' })",
    })),
    line({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "exec-image-1",
        status: "completed",
      },
    }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }),
  ].join("\n");

  const result = codexTurnUsageFromJsonl(text, "turn-1");
  assert.equal(result.imageGenerationCount, 1);
  assert.equal(result.estimatedCredits, 90);
  assert.equal(result.estimateKind, "imagegen-default");
});

test("pricing metadata scan resolves each turn model and Fast tier in one pass", async () => {
  const text = [
    line({ type: "event_msg", payload: {
      type: "thread_settings_applied",
      thread_settings: { model: "gpt-5.6-sol", service_tier: "default" },
    } }),
    line({ type: "turn_context", payload: {
      turn_id: "turn-sol",
      model: "gpt-5.6-sol",
    } }),
    line({ type: "event_msg", payload: {
      type: "thread_settings_applied",
      thread_settings: { model: "gpt-5.4", service_tier: "priority" },
    } }),
    line({ type: "event_msg", payload: {
      type: "task_started",
      turn_id: "turn-aborted-before-context",
    } }),
    line({ type: "turn_context", payload: {
      turn_id: "turn-terra-fast",
      model: "gpt-5.4",
    } }),
  ].join("\n");

  const metadata = await scanCodexTurnPricingMetadata(
    "rollout.jsonl",
    ["turn-sol", "turn-terra-fast", "turn-aborted-before-context"],
    {
      createReadStreamImpl: () => Readable.from(text.split("\n").map((value) => `${value}\n`)),
    },
  );
  assert.deepEqual(metadata.get("turn-sol"), {
    model: "gpt-5.6-sol",
    serviceTier: "default",
  });
  assert.deepEqual(metadata.get("turn-terra-fast"), {
    model: "gpt-5.4",
    serviceTier: "priority",
  });
  assert.deepEqual(metadata.get("turn-aborted-before-context"), {
    model: "gpt-5.4",
    serviceTier: "priority",
  });
});

test("rollout discovery finds threads omitted by the Codex thread list", async () => {
  const calls = [];
  const result = await findCodexRolloutPath(
    "019fa8bb-9466-7612-a8b3-38670f24b6c6",
    "2026-07-28T12:38:13.614Z",
    {
      codexHome: "C:\\Codex",
      readdirImpl: async (directory) => {
        calls.push(directory);
        if (!directory.endsWith(path.join("2026", "07", "28"))) return [];
        return [{
          name: "rollout-2026-07-28T17-38-13-019fa8bb-9466-7612-a8b3-38670f24b6c6.jsonl",
          isFile: () => true,
        }];
      },
    },
  );
  assert.equal(
    result,
    path.join(
      "C:\\Codex",
      "sessions",
      "2026",
      "07",
      "28",
      "rollout-2026-07-28T17-38-13-019fa8bb-9466-7612-a8b3-38670f24b6c6.jsonl",
    ),
  );
  assert.equal(calls.length, 3);
});

test("rollout discovery indexes long-lived threads outside the turn date", async () => {
  const threadId = "019f2373-d20b-7880-b672-aad3040ccc52";
  const fileName = `rollout-2026-07-02T20-30-20-${threadId}.jsonl`;
  const directories = new Map([
    [path.join("C:\\Codex", "sessions"), [{
      name: "2026",
      isDirectory: () => true,
      isFile: () => false,
    }]],
    [path.join("C:\\Codex", "sessions", "2026"), [{
      name: "07",
      isDirectory: () => true,
      isFile: () => false,
    }]],
    [path.join("C:\\Codex", "sessions", "2026", "07"), [{
      name: "02",
      isDirectory: () => true,
      isFile: () => false,
    }]],
    [path.join("C:\\Codex", "sessions", "2026", "07", "02"), [{
      name: fileName,
      isDirectory: () => false,
      isFile: () => true,
    }]],
    [path.join("C:\\Codex", "archived_sessions"), []],
  ]);
  const result = await findCodexRolloutPath(threadId, "2026-07-10T12:00:00.000Z", {
    codexHome: "C:\\Codex",
    readdirImpl: async (directory) => directories.get(directory) ?? [],
  });
  assert.equal(
    result,
    path.join("C:\\Codex", "sessions", "2026", "07", "02", fileName),
  );
});

test("recent terminal scan distinguishes completed and aborted turns", () => {
  const values = codexRecentTerminalTurnsFromJsonl([
    line({ timestamp: "2026-07-26T19:04:03.527Z", type: "event_msg", payload: {
      type: "turn_aborted",
      turn_id: "turn-aborted",
    } }),
    line({ timestamp: "2026-07-26T19:05:03.527Z", type: "event_msg", payload: {
      type: "task_complete",
      turn_id: "turn-completed",
    } }),
  ].join("\n"));
  assert.deepEqual(values, [
    {
      turnId: "turn-aborted",
      status: "aborted",
      completedAt: "2026-07-26T19:04:03.527Z",
    },
    {
      turnId: "turn-completed",
      status: "completed",
      completedAt: "2026-07-26T19:05:03.527Z",
    },
  ]);
});

test("terminal event scanner resumes from the last complete JSONL byte", async () => {
  const first = `${line({
    timestamp: "2026-07-27T03:00:00.000Z",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1" },
  })}\n`;
  const incomplete = line({
    timestamp: "2026-07-27T03:01:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-2" },
  });
  const partialLength = Math.floor(Buffer.byteLength(incomplete) / 2);
  const starts = [];
  let source = `${first}${Buffer.from(incomplete).subarray(0, partialLength).toString("utf8")}`;
  const createReadStreamImpl = (_path, { start }) => {
    starts.push(start);
    return Readable.from([Buffer.from(source).subarray(start)]);
  };

  const firstResult = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    createReadStreamImpl,
  });
  assert.deepEqual(firstResult.terminals.map((value) => value.turnId), ["turn-1"]);
  assert.equal(firstResult.nextOffset, Buffer.byteLength(first));

  source = `${first}${incomplete}\n`;
  const secondResult = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    startOffset: firstResult.nextOffset,
    createReadStreamImpl,
  });
  assert.deepEqual(secondResult.terminals.map((value) => value.turnId), ["turn-2"]);
  assert.equal(secondResult.nextOffset, Buffer.byteLength(source));
  assert.deepEqual(starts, [0, Buffer.byteLength(first)]);
});

test("terminal event scanner stops at a complete line after its byte budget", async () => {
  const entries = ["turn-1", "turn-2", "turn-3"].map((turnId, index) => `${line({
    timestamp: `2026-07-27T03:0${index}:00.000Z`,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId },
  })}\n`);
  const source = Buffer.from(entries.join(""));
  const createReadStreamImpl = (_path, { start }) => {
    const tail = source.subarray(start);
    const chunks = [];
    let offset = 0;
    for (const entry of entries) {
      const length = Buffer.byteLength(entry);
      if (offset + length > start) {
        const localStart = Math.max(0, start - offset);
        chunks.push(Buffer.from(entry).subarray(localStart));
      }
      offset += length;
    }
    return Readable.from(chunks.length ? chunks : [tail]);
  };

  const first = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    maxBytes: Buffer.byteLength(entries[0]),
    createReadStreamImpl,
  });
  assert.deepEqual(first.terminals.map((value) => value.turnId), ["turn-1"]);
  assert.equal(first.nextOffset, Buffer.byteLength(entries[0]));

  const second = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    startOffset: first.nextOffset,
    maxBytes: Buffer.byteLength(entries[1]),
    createReadStreamImpl,
  });
  assert.deepEqual(second.terminals.map((value) => value.turnId), ["turn-2"]);
  assert.equal(second.nextOffset, Buffer.byteLength(entries[0]) + Buffer.byteLength(entries[1]));
});

test("resumed subagent scans keep filtering inherited parent turns", async () => {
  const childThreadId = "019fa366-e7a9-7aa1-b38a-6823c3a67e77";
  const inheritedTurnId = "019fa362-ffaf-7cd3-9c8f-480d9724657a";
  const childTurnId = "019fa366-e87d-7933-8ae8-f33a5200b24e";
  const source = [
    line({
      timestamp: "2026-07-27T11:47:38.192Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: inheritedTurnId },
    }),
    line({
      timestamp: "2026-07-27T11:50:38.875Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: childTurnId },
    }),
  ].join("\n");

  const result = await scanCodexTerminalEventsFromOffset("forked-rollout.jsonl", {
    rolloutId: childThreadId,
    createReadStreamImpl: () => Readable.from([source]),
  });

  assert.deepEqual(result.terminals.map((value) => value.turnId), [childTurnId]);
});

test("terminal event scanner carries active turns across bounded chunks", async () => {
  const first = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    createReadStreamImpl: () => Readable.from([line({
      timestamp: "2026-07-27T03:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-across-chunks" },
    })]),
  });
  assert.equal(first.activeTurns.length, 1);

  const second = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    initialActiveTurns: first.activeTurns,
    createReadStreamImpl: () => Readable.from([line({
      timestamp: "2026-07-27T03:01:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-across-chunks" },
    })]),
  });
  assert.deepEqual(second.activeTurns, []);
  assert.deepEqual(second.terminals.map((value) => value.turnId), ["turn-across-chunks"]);
});

test("historical rollout keeps the initial prompt when a turn is steered", async () => {
  const turnId = "019f1eca-8de7-7aa3-92b6-045036561c8e";
  const text = [
    line({ timestamp: "2026-08-09T21:30:00Z", type: "event_msg", payload: {
      type: "task_started", turn_id: turnId,
    } }),
    line(response(turnId, "message", {
      role: "user",
      content: [{ type: "input_text", text: "Изначальный запрос" }],
    })),
    line(response(turnId, "message", {
      role: "user",
      content: [{ type: "input_text", text: "Докинутое уточнение" }],
    })),
    line({ timestamp: "2026-08-09T21:31:00Z", type: "event_msg", payload: {
      type: "task_complete", turn_id: turnId,
    } }),
  ].join("\n");

  const result = await scanCodexHistoricalRollout("fixture.jsonl", {
    createReadStreamImpl: () => Readable.from([text]),
  });

  assert.equal(result.turns[0].prompt, "Изначальный запрос");
  assert.deepEqual(result.turns[0].prompts, ["Изначальный запрос", "Докинутое уточнение"]);
});

test("terminal event scanner marks the real rollout shape of a context probe", async () => {
  const turnId = "probe-turn";
  const source = [
    line({
      timestamp: "2026-08-07T23:43:44.542Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    line({
      timestamp: "2026-08-07T23:43:45.744Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        client_id: "agent-hub-context-probe:test",
        content: [{ type: "input_text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    line({
      timestamp: "2026-08-07T23:43:51.644Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: CODEX_CONTEXT_PROBE_RESPONSE }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    line({
      timestamp: "2026-08-07T23:43:52.306Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId },
    }),
  ].join("\n");

  const result = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    createReadStreamImpl: () => Readable.from([source]),
  });

  assert.deepEqual(result.terminals, [{
    turnId,
    status: "completed",
    completedAt: "2026-08-07T23:43:52.306Z",
    contextProbe: true,
  }]);
});

test("terminal event scanner preserves a user turn equal to probe text without probe id", async () => {
  const turnId = "user-turn";
  const source = [
    line({
      timestamp: "2026-08-07T23:43:44.542Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId },
    }),
    line({
      timestamp: "2026-08-07T23:43:45.744Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_CONTEXT_PROBE_PROMPT }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }),
    line({
      timestamp: "2026-08-07T23:43:52.306Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId },
    }),
  ].join("\n");

  const result = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    createReadStreamImpl: () => Readable.from([source]),
  });

  assert.equal(result.terminals[0].contextProbe, undefined);
});

test("terminal event scanner preserves turns that started without a lifecycle terminal", async () => {
  const source = [
    line({
      timestamp: "2026-07-27T03:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-interrupted-without-event" },
    }),
    line({
      timestamp: "2026-07-27T03:01:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-completed" },
    }),
    line({
      timestamp: "2026-07-27T03:02:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-completed" },
    }),
  ].join("\n");
  const result = await scanCodexTerminalEventsFromOffset("rollout.jsonl", {
    createReadStreamImpl: () => Readable.from([source]),
  });

  assert.deepEqual(result.activeTurns, [{
    turnId: "turn-interrupted-without-event",
    startedAt: "2026-07-27T03:00:00.000Z",
    lastActivityAt: "2026-07-27T03:00:00.000Z",
  }]);
  assert.deepEqual(result.terminals.map((value) => value.turnId), ["turn-completed"]);
});

test("terminal event scanner skips parent history copied into a subagent fork", async () => {
  const childThreadId = "019fa366-e7a9-7aa1-b38a-6823c3a67e77";
  const inheritedTurnId = "019fa362-ffaf-7cd3-9c8f-480d9724657a";
  const childTurnId = "019fa366-e87d-7933-8ae8-f33a5200b24e";
  const source = [
    line({
      timestamp: "2026-07-27T11:47:38.191Z",
      type: "session_meta",
      payload: { id: childThreadId, parent_thread_id: "019f865d-0a7f-7c01-b61c-543d38995372" },
    }),
    line({
      timestamp: "2026-07-27T11:47:38.192Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: inheritedTurnId },
    }),
    line({
      timestamp: "2026-07-27T11:47:38.192Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: inheritedTurnId },
    }),
    line({
      timestamp: "2026-07-27T11:47:38.300Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: childTurnId },
    }),
    line({
      timestamp: "2026-07-27T11:50:38.875Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: childTurnId },
    }),
  ].join("\n");
  const result = await scanCodexTerminalEventsFromOffset("forked-rollout.jsonl", {
    createReadStreamImpl: () => Readable.from([source]),
  });

  assert.deepEqual(result.terminals.map((value) => value.turnId), [childTurnId]);
  assert.deepEqual(result.activeTurns, []);
});

test("Codex usage reader uses the incremental streaming scanner by default", async () => {
  let scans = 0;
  const result = await readCodexTurnUsage("large-rollout.jsonl", "turn-1", {
    attempts: 1,
    scanIncrementalImpl: async () => {
      scans += 1;
      return {
        reported: true,
        finalTokenSeen: true,
        usage: { inputTokens: 10 },
      };
    },
  });
  assert.equal(scans, 1);
  assert.equal(result.usage.inputTokens, 10);
});

test("incremental retries scan only bytes appended after the first large pass", async () => {
  const base = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
  ].join("\n") + "\n";
  const complete = `${base}${line(token(50, 40, 5, 1))}\n${line({
    timestamp: "2026-07-27T01:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1" },
  })}\n`;
  const starts = [];
  let reads = 0;
  const result = await scanCodexTurnJsonlIncrementally("growing-rollout.jsonl", "turn-1", {
    attempts: 2,
    retryDelayMs: 0,
    createReadStreamImpl: (_file, options) => {
      starts.push(options.start);
      reads += 1;
      const current = reads === 1 ? base : complete;
      return Readable.from([Buffer.from(current).subarray(options.start)]);
    },
  });

  assert.deepEqual(starts, [0, Buffer.byteLength(base)]);
  assert.equal(result.finalTokenSeen, true);
  assert.equal(result.completedAt, "2026-07-27T01:00:00.000Z");
  assert.equal(result.usage.inputTokens, 50);
});

test("incremental scanner handles a large JSONL record split into tiny chunks", async () => {
  const largeEntry = `${line({
    type: "event_msg",
    payload: { type: "unrelated", padding: "x".repeat(2 * 1024 * 1024) },
  })}\n`;
  const terminal = `${line({
    timestamp: "2026-07-27T01:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-after-large-line" },
  })}\n`;
  const source = Buffer.from(`${largeEntry}${terminal}`);
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += 512) {
    chunks.push(source.subarray(offset, offset + 512));
  }

  const result = await scanCodexTerminalEventsFromOffset("large-line-rollout.jsonl", {
    createReadStreamImpl: () => Readable.from(chunks),
  });

  assert.deepEqual(result.terminals.map((value) => value.turnId), ["turn-after-large-line"]);
  assert.equal(result.nextOffset, source.length);
});

test("streaming scan finds an exact turn beyond the former 64 MiB tail boundary", async () => {
  const padding = `${line({
    type: "event_msg",
    payload: { type: "unrelated", padding: "x".repeat(64 * 1024) },
  })}\n`;
  const chunks = Array.from({ length: 1_040 }, () => padding);
  chunks.push(
    `${line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-large" } })}\n`,
    `${line(response("turn-large"))}\n`,
    `${line(token(321, 300, 21, 8))}\n`,
    `${line({
      timestamp: "2026-07-27T01:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-large" },
    })}\n`,
  );

  const result = await scanCodexTurnJsonl("huge-rollout.jsonl", "turn-large", {
    createReadStreamImpl: () => Readable.from(chunks),
  });

  assert.equal(Buffer.byteLength(padding) * 1_040 > 64 * 1024 * 1024, true);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.inputTokens, 321);
});

test("Codex rollout usage keeps interleaved turns separate", () => {
  const text = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } }),
    line(response("turn-1")),
    line(token(100, 80, 10, 4)),
    line(response("turn-2")),
    line(token(200, 150, 20, 8)),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
    line(token(50, 40, 5, 1)),
  ].join("\n");

  assert.deepEqual(codexTurnUsageFromJsonl(text, "turn-1").usage, {
    inputTokens: 150,
    cachedInputTokens: 120,
    outputTokens: 15,
    reasoningOutputTokens: 5,
    totalTokens: 165,
  });
  assert.deepEqual(codexTurnUsageFromJsonl(text, "turn-2").usage, {
    inputTokens: 200,
    cachedInputTokens: 150,
    outputTokens: 20,
    reasoningOutputTokens: 8,
    totalTokens: 220,
  });
});

test("Codex rollout reader retries until the final token event is flushed", async () => {
  let reads = 0;
  const base = [
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line(response("turn-1", "message", { role: "assistant", phase: "final_answer" })),
  ].join("\n");
  const result = await readCodexTurnUsage("rollout.jsonl", "turn-1", {
    attempts: 2,
    retryDelayMs: 0,
    readFileImpl: async () => {
      reads += 1;
      return reads === 1 ? base : `${base}\n${line(token(50, 40, 5, 1))}`;
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.finalTokenSeen, true);
});

test("Codex rollout tail reads only the bounded suffix and drops its partial first line", async () => {
  const source = Buffer.from(`ignored-prefix\n${line(response("turn-1"))}\n${line(token(50, 40, 5, 1))}`);
  let requested = null;
  let closed = false;
  const text = await readCodexRolloutTail("large-rollout.jsonl", {
    maxBytes: source.length - 5,
    openImpl: async () => ({
      stat: async () => ({ size: source.length }),
      read: async (buffer, offset, length, position) => {
        requested = { length, position };
        const chunk = source.subarray(position, position + length);
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length };
      },
      close: async () => {
        closed = true;
      },
    }),
  });

  assert.deepEqual(requested, { length: source.length - 5, position: 5 });
  assert.equal(text, `${line(response("turn-1"))}\n${line(token(50, 40, 5, 1))}`);
  assert.equal(closed, true);
});
