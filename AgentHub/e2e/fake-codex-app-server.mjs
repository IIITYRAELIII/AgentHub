import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const stateArgument = process.argv.indexOf("--state");
const statePath = stateArgument >= 0 ? process.argv[stateArgument + 1] : "";
const pidFileArgument = process.argv.indexOf("--pid-file");
const pidFilePath = pidFileArgument >= 0 ? process.argv[pidFileArgument + 1] : "";
const acceptAll = process.argv.includes("--accept-all");
if (process.argv.includes("--require-test-contour")) {
  const runtimeRoot = path.resolve(String(process.env.AGENT_HUB_RUNTIME_ROOT ?? ""));
  const resolvedStatePath = path.resolve(statePath || ".");
  const relativeStatePath = path.relative(runtimeRoot, resolvedStatePath);
  if (process.env.AGENT_HUB_TEST_CONTOUR !== "1"
    || process.env.AGENT_HUB_TEST_CONTOUR_PROFILE !== "fake-codex"
    || !statePath
    || !runtimeRoot
    || relativeStatePath.startsWith("..")
    || path.isAbsolute(relativeStatePath)) {
    throw new Error("Fake Codex is restricted to its owned Test Contour runtime");
  }
}
if (pidFilePath) writeFileSync(pidFilePath, `${process.pid}\n`, "utf8");
const initialState = {
  nextThread: 1,
  nextTurn: 1,
  nextMessage: 1,
  threads: [],
  loadedThreadIds: [],
  crashedOnce: false,
  requestCounts: {},
};
let state = statePath && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : structuredClone(initialState);
state.requestCounts ??= {};
state.nextMessage ??= 1;
const pendingApprovals = new Map();
const timers = new Set();
const loadedThreadIds = new Set(
  (Array.isArray(state.loadedThreadIds) ? state.loadedThreadIds : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean),
);

function save() {
  if (!statePath) return;
  state.loadedThreadIds = [...loadedThreadIds].sort();
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, statePath);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reply(id, result) {
  send({ id, result });
}

function notify(method, params = {}) {
  send({ method, params });
}

function request(id, method, params = {}) {
  send({ id, method, params });
}

function uuid(kind, value) {
  const suffix = String(value).padStart(12, "0");
  return kind === "thread"
    ? `10000000-0000-4000-8000-${suffix}`
    : `20000000-0000-4000-8000-${suffix}`;
}

function threadById(id) {
  return state.threads.find((thread) => thread.id === id && !thread.archived);
}

function publicThread(thread, includeTurns = true) {
  const waitingOnApproval = thread.turns.some((turn) => (
    turn.status === "inProgress" && turn.prompt.startsWith("[orphan-approval]")
  ));
  return {
    id: thread.id,
    cwd: thread.cwd,
    name: thread.name,
    preview: thread.preview,
    updatedAt: thread.updatedAt,
    status: {
      type: thread.turns.some((turn) => turn.status === "inProgress") ? "active" : "idle",
      ...(waitingOnApproval ? { activeFlags: ["waitingOnApproval"] } : {}),
    },
    ...(thread.path ? { path: thread.path } : {}),
    ...(includeTurns ? { turns: thread.turns } : {}),
  };
}

function promptText(input) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text ?? ""))
    .join("\n")
    .trim();
}

function schedule(callback, delayMs) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    callback();
  }, delayMs);
  timers.add(timer);
}

function finishTurn(thread, turn, { status = "completed", answer = null } = {}) {
  if (turn.status !== "inProgress") return;
  const text = answer ?? `Готово: ${turn.prompt}`;
  turn.status = status;
  if (thread.externalRolloutPath && turn.external === true) {
    appendFileSync(thread.externalRolloutPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: status === "interrupted" ? "turn_aborted" : "task_complete",
        turn_id: turn.id,
        ...(status === "interrupted" ? {} : { last_agent_message: text }),
      },
    })}\n`, "utf8");
  }
  const itemId = `${turn.id}:agent:final`;
  turn.items.push({ id: itemId, type: "agentMessage", text, phase: "final_answer" });
  thread.updatedAt = Math.floor(Date.now() / 1000);
  save();
  notify("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: turn.id,
    itemId,
    delta: text,
  });
  notify("thread/tokenUsage/updated", {
    threadId: thread.id,
    turnId: turn.id,
    tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 130 },
      last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 130 },
      modelContextWindow: 200_000,
    },
  });
  notify("turn/diff/updated", { threadId: thread.id, turnId: turn.id, diff: `diff --fake ${turn.id}` });
  notify("turn/completed", {
    threadId: thread.id,
    turn: structuredClone(turn),
  });
}

function finishTurnWithoutNewAnswer(thread, turn) {
  if (turn.status !== "inProgress") return;
  turn.status = "completed";
  if (thread.externalRolloutPath && turn.external === true) {
    appendFileSync(thread.externalRolloutPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_complete", turn_id: turn.id },
    })}\n`, "utf8");
  }
  thread.updatedAt = Math.floor(Date.now() / 1000);
  save();
  notify("turn/completed", {
    threadId: thread.id,
    turn: structuredClone(turn),
  });
}

function startTurn(params) {
  const thread = threadById(params.threadId);
  if (!thread) throw new Error(`thread not found: ${params.threadId}`);
  const prompt = promptText(params.input);
  const turn = {
    id: uuid("turn", state.nextTurn++),
    status: "inProgress",
    prompt,
    items: [{
      id: `${uuid("message", state.nextMessage++)}:user`,
      clientId: String(params.clientUserMessageId ?? ""),
      type: "userMessage",
      content: [{ type: "text", text: prompt }],
    }],
  };
  thread.turns.push(turn);
  thread.preview = prompt || thread.preview;
  thread.updatedAt = Math.floor(Date.now() / 1000);
  save();
  schedule(() => notify("turn/started", { threadId: thread.id, turn: structuredClone(turn) }), 10);
  schedule(() => notify("item/reasoning/summaryTextDelta", {
    threadId: thread.id,
    turnId: turn.id,
    delta: `Проверяю сценарий: ${prompt}`,
  }), 25);

  if (acceptAll) {
    schedule(() => finishTurn(thread, turn, { answer: "Принято" }), 120);
    return turn;
  }

  if (prompt.includes("[auto-compact]")) {
    const compactionItem = { id: `${turn.id}:context-compaction`, type: "contextCompaction" };
    schedule(() => notify("item/started", {
      threadId: thread.id,
      turnId: turn.id,
      item: compactionItem,
      startedAtMs: Date.now(),
    }), 35);
    schedule(() => notify("thread/tokenUsage/updated", {
      threadId: thread.id,
      turnId: turn.id,
      tokenUsage: {
        total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 130 },
        last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 92_592 },
        modelContextWindow: 200_000,
      },
    }), 220);
    schedule(() => notify("item/completed", {
      threadId: thread.id,
      turnId: turn.id,
      item: compactionItem,
      completedAtMs: Date.now(),
    }), 260);
  }

  if (prompt.includes("[hold]")) return turn;
  if (prompt.startsWith("[orphan-approval]")) return turn;
  if (prompt.includes("[approval]")) {
    const approvalId = 10_000 + state.nextTurn;
    pendingApprovals.set(approvalId, { thread, turn });
    schedule(() => request(approvalId, "item/commandExecution/requestApproval", {
      threadId: thread.id,
      turnId: turn.id,
      command: "fake-command --safe",
      cwd: thread.cwd,
      reason: "E2E approval",
    }), 50);
    return turn;
  }
  if (prompt.includes("[elicitation]")) {
    const approvalId = 20_000 + state.nextTurn;
    pendingApprovals.set(approvalId, { thread, turn, kind: "elicitation" });
    schedule(() => request(approvalId, "mcpServer/elicitation/request", {
      serverName: "fake-permission-mcp",
      threadId: thread.id,
      turnId: turn.id,
      mode: "form",
      message: "Разрешить безопасное тестовое действие?",
      requestedSchema: {
        type: "object",
        required: ["approved"],
        properties: { approved: { type: "boolean", title: "Разрешить" } },
      },
    }), 50);
    return turn;
  }
  if (prompt.includes("[crash-once]") && !state.crashedOnce) {
    state.crashedOnce = true;
    save();
    schedule(() => process.exit(23), 80);
    return turn;
  }
  const failed = prompt.includes("[fail]");
  const completedAnswer = prompt.includes("[long-final]")
    ? `Готово: ${prompt}\n${"длинный-фрагмент ".repeat(400)}\nФИНАЛ_НЕ_ОБРЕЗАН`
    : null;
  schedule(() => finishTurn(thread, turn, {
    status: failed ? "failed" : "completed",
    answer: failed ? "Имитированная ошибка хода" : completedAnswer,
  }), prompt.includes("[slow]") ? 3_000 : 120);
  return turn;
}

function startExternalTurn(thread, {
  prompt,
  answer,
  delayMs,
  initialAnswer = "",
}) {
  if (thread.turns.some((turn) => turn.status === "inProgress")) return;
  const turn = {
    id: uuid("turn", state.nextTurn++),
    status: "inProgress",
    prompt,
    external: true,
    items: [
      { type: "userMessage", content: [{ type: "text", text: prompt }] },
      ...(initialAnswer ? [{ type: "agentMessage", text: initialAnswer, phase: "commentary" }] : []),
    ],
  };
  thread.turns.push(turn);
  thread.preview = prompt;
  thread.updatedAt = Math.floor(Date.now() / 1000);
  thread.externalRolloutPath = path.join(path.dirname(statePath), `${thread.id}-vscode-rollout.jsonl`);
  thread.path = thread.externalRolloutPath;
  writeFileSync(thread.externalRolloutPath, [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { originator: "codex_vscode", source: "vscode" },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: turn.id },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
        internal_chat_message_metadata_passthrough: { turn_id: turn.id },
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: `fake-vscode-${turn.id}`,
        message: prompt,
      },
    }),
    ...(initialAnswer ? [JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: initialAnswer,
        phase: "commentary",
      },
    })] : []),
    "",
  ].join("\n"), "utf8");
  save();
  schedule(() => finishTurn(thread, turn, { answer }), delayMs);
}

function startSilentExternalTurn(thread) {
  startExternalTurn(thread, {
    prompt: "[external-hold] VSCode task",
    answer: "Внешний VSCode-ход завершён",
    delayMs: 20_000,
  });
}

function startShortExternalTurn(thread) {
  startExternalTurn(thread, {
    prompt: "[external-short] VSCode task",
    answer: "Короткий внешний VSCode-ход завершён",
    delayMs: 100,
  });
}

function startUnchangedExternalTurn(thread) {
  startExternalTurn(thread, {
    prompt: "[external-unchanged] VSCode task",
    answer: "Накопленный внешний текст",
    initialAnswer: "Накопленный внешний текст",
    delayMs: 20_000,
  });
}

function resumeInterruptedTurns() {
  for (const thread of state.threads) {
    for (const turn of thread.turns.filter((item) => (
      item.status === "inProgress"
      && (acceptAll || (
        item.prompt.includes("[crash-once]")
        || item.prompt === "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1"
      ))
    ))) {
      schedule(() => finishTurn(thread, turn, {
        answer: acceptAll ? "Принято" : `Восстановлено: ${turn.prompt}`,
      }), 250);
    }
  }
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  state.requestCounts[method] = Number(state.requestCounts[method] ?? 0) + 1;
  if (method === "initialize") {
    const completeInitialize = () => {
      state.initializeCompletedAt = Date.now();
      save();
      reply(id, { userAgent: "fake-codex-e2e" });
      resumeInterruptedTurns();
    };
    const delayMs = Math.max(0, Number(state.initializeDelayMs) || 0);
    if (delayMs) schedule(completeInitialize, delayMs);
    else completeInitialize();
    return;
  }
  if (method === "thread/start") {
    const thread = {
      id: uuid("thread", state.nextThread++),
      cwd: params.cwd,
      name: "Новая тестовая задача",
      preview: "",
      updatedAt: Math.floor(Date.now() / 1000),
      turns: [],
      model: String(params.model ?? "fake-codex"),
      reasoningEffort: String(params.effort ?? "medium"),
      archived: false,
    };
    state.threads.push(thread);
    loadedThreadIds.add(thread.id);
    save();
    reply(id, { thread: publicThread(thread) });
    return;
  }
  if (method === "thread/ensure") {
    const threadId = String(params.threadId ?? "").trim();
    if (!threadId) return send({ id, error: { message: "threadId is required" } });
    let thread = threadById(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        cwd: params.cwd,
        name: String(params.name ?? "Новая тестовая задача"),
        preview: "",
        updatedAt: Math.floor(Date.now() / 1000),
        turns: [],
        model: String(params.model ?? "fake-codex"),
        reasoningEffort: String(params.effort ?? "medium"),
        archived: false,
      };
      state.threads.push(thread);
      save();
    }
    loadedThreadIds.add(thread.id);
    save();
    reply(id, { thread: publicThread(thread) });
    return;
  }
  if (method === "thread/resume") {
    const thread = threadById(params.threadId);
    if (!thread) return send({ id, error: { message: `thread not found: ${params.threadId}` } });
    if (thread.failResumeOnce) {
      delete thread.failResumeOnce;
      save();
      return send({
        id,
        error: { message: "Custom tool call output is missing for call id: fake-resume-race" },
      });
    }
    loadedThreadIds.add(thread.id);
    save();
    reply(id, {
      thread: publicThread(thread),
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
    });
    return;
  }
  if (method === "thread/list") {
    reply(id, {
      data: state.threads.filter((thread) => !thread.archived).map((thread) => publicThread(thread, false)),
      nextCursor: null,
    });
    return;
  }
  if (method === "thread/read") {
    const thread = threadById(params.threadId);
    if (!thread) return send({ id, error: { message: `thread not found: ${params.threadId}` } });
    save();
    reply(id, { thread: publicThread(thread, params.includeTurns !== false) });
    return;
  }
  if (method === "thread/loaded/list") {
    reply(id, {
      data: state.threads
        .filter((thread) => !thread.archived && loadedThreadIds.has(thread.id))
        .map((thread) => thread.id),
      nextCursor: null,
    });
    return;
  }
  if (method === "thread/turns/list") {
    const thread = threadById(params.threadId);
    if (!thread) return send({ id, error: { message: `thread not found: ${params.threadId}` } });
    const limit = Math.max(1, Number(params.limit) || 50);
    const offset = Math.max(0, Number(String(params.cursor ?? "").replace(/^turns:/u, "")) || 0);
    const ordered = params.sortDirection === "asc" ? thread.turns : [...thread.turns].reverse();
    const data = ordered.slice(offset, offset + limit).map((turn) => structuredClone(turn));
    const nextOffset = offset + data.length;
    reply(id, {
      data,
      nextCursor: nextOffset < ordered.length ? `turns:${nextOffset}` : null,
      backwardsCursor: offset > 0 ? `turns:${Math.max(0, offset - limit)}` : null,
    });
    return;
  }
  if (method === "thread/name/set") {
    const thread = threadById(params.threadId);
    if (thread) {
      thread.name = params.name;
      if (params.name === "__E2E_EXTERNAL_HOLD__") startSilentExternalTurn(thread);
      if (params.name === "__E2E_EXTERNAL_SHORT__") startShortExternalTurn(thread);
      if (params.name === "__E2E_EXTERNAL_UNCHANGED__") startUnchangedExternalTurn(thread);
      if (params.name === "__E2E_EXTERNAL_RELEASE__") {
        const externalTurn = thread.turns.find((turn) => (
          turn.status === "inProgress" && turn.prompt === "[external-hold] VSCode task"
        ));
        if (externalTurn) finishTurn(thread, externalTurn, {
          status: "completed",
          answer: "Внешний ход завершён тестом",
        });
      }
      if (params.name === "__E2E_EXTERNAL_UNCHANGED_RELEASE__") {
        const externalTurn = thread.turns.find((turn) => (
          turn.status === "inProgress" && turn.prompt === "[external-unchanged] VSCode task"
        ));
        if (externalTurn) finishTurnWithoutNewAnswer(thread, externalTurn);
      }
    }
    save();
    reply(id, {});
    return;
  }
  if (method === "thread/settings/update") {
    const thread = threadById(params.threadId);
    if (!thread) return send({ id, error: { message: `thread not found: ${params.threadId}` } });
    thread.model = params.model;
    thread.reasoningEffort = params.effort;
    save();
    reply(id, { threadSettings: { model: params.model, reasoningEffort: params.effort } });
    return;
  }
  if (method === "thread/archive") {
    const thread = threadById(params.threadId);
    if (thread) thread.archived = true;
    save();
    reply(id, {});
    return;
  }
  if (method === "thread/unsubscribe") {
    loadedThreadIds.delete(params.threadId);
    save();
    reply(id, {});
    return;
  }
  if (method === "thread/delete") {
    const index = state.threads.findIndex((thread) => thread.id === params.threadId);
    if (index >= 0) state.threads.splice(index, 1);
    loadedThreadIds.delete(params.threadId);
    save();
    reply(id, {});
    return;
  }
  if (method === "thread/rollback") {
    const thread = threadById(params.threadId);
    if (thread) thread.turns.splice(Math.max(0, thread.turns.length - Number(params.numTurns ?? 1)));
    save();
    reply(id, { thread: publicThread(thread) });
    return;
  }
  if (method === "thread/compact/start") {
    const thread = threadById(params.threadId);
    if (!thread || !loadedThreadIds.has(params.threadId)) {
      return send({ id, error: { message: `thread not found: ${params.threadId}` } });
    }
    reply(id, {});
    const turnId = thread?.turns?.at(-1)?.id ?? null;
    const item = { id: `${turnId ?? thread.id}:manual-context-compaction`, type: "contextCompaction" };
    schedule(() => notify("item/started", {
      threadId: thread.id,
      turnId,
      item,
      startedAtMs: Date.now(),
    }), 10);
    schedule(() => notify("thread/tokenUsage/updated", {
      threadId: thread.id,
      turnId,
      tokenUsage: {
        total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 130 },
        last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 92_592 },
        modelContextWindow: 200_000,
      },
    }), 20);
    const completionDelayMs = Math.max(150, Number(state.manualCompactionDelayMs) || 150);
    schedule(() => notify("item/completed", {
      threadId: thread.id,
      turnId,
      item,
      completedAtMs: Date.now(),
    }), completionDelayMs);
    return;
  }
  if (method === "turn/start") {
    try {
      const thread = threadById(params.threadId);
      if (thread?.turns.at(-1)?.status === "inProgress"
        && thread.turns.at(-1).prompt.startsWith("[orphan-approval]")) {
        throw new Error("Custom tool call output is missing for call id: fake-orphaned-elicitation");
      }
      const turn = startTurn(params);
      if (turn.prompt.includes("[resume-error]")) {
        thread.failResumeOnce = true;
        save();
      }
      reply(id, { turn });
    } catch (error) {
      send({ id, error: { message: error.message } });
    }
    return;
  }
  if (method === "turn/steer") {
    const thread = threadById(params.threadId);
    const turn = thread?.turns.find((item) => item.id === params.expectedTurnId);
    if (!turn || turn.status !== "inProgress") {
      send({
        id,
        error: {
          code: -32602,
          message: "active turn not steerable",
          data: { kind: "activeTurnNotSteerable" },
        },
      });
      return;
    }
    const prompt = promptText(params.input);
    turn.items.push({
      id: `${uuid("message", state.nextMessage++)}:user`,
      clientId: String(params.clientUserMessageId ?? ""),
      type: "userMessage",
      content: [{ type: "text", text: prompt }],
    });
    turn.steeredPrompts ??= [];
    turn.steeredPrompts.push(prompt);
    save();
    reply(id, { turnId: turn.id });
    return;
  }
  if (method === "turn/interrupt") {
    const thread = threadById(params.threadId);
    const turn = thread?.turns.find((item) => item.id === params.turnId);
    if (turn?.prompt === "[external-hold] VSCode task") {
      send({ id, error: { message: "no active turn to interrupt" } });
      return;
    }
    if (turn?.status === "inProgress") finishTurn(thread, turn, { status: "interrupted", answer: "Ход остановлен тестом" });
    reply(id, {});
    return;
  }
  reply(id, {});
}

function handleApprovalResponse(message) {
  const pending = pendingApprovals.get(message.id);
  if (!pending) return;
  pendingApprovals.delete(message.id);
  if (pending.kind === "elicitation") {
    const accepted = message.result?.action === "accept"
      && message.result?.content?.approved === true;
    finishTurn(pending.thread, pending.turn, {
      status: accepted ? "completed" : "failed",
      answer: `MCP elicitation: ${message.result?.action ?? "missing"}:${accepted}`,
    });
    return;
  }
  const decision = message.result?.decision ?? "decline";
  finishTurn(pending.thread, pending.turn, {
    status: decision === "decline" ? "failed" : "completed",
    answer: `Подтверждение: ${decision}`,
  });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) handleRequest(message);
    else if (message.id !== undefined && message.result !== undefined) handleApprovalResponse(message);
  } catch (error) {
    send({ method: "fake/error", params: { message: error.message } });
  }
});

process.on("exit", () => {
  for (const timer of timers) clearTimeout(timer);
});
