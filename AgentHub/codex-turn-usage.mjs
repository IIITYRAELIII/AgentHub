import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { uuidV7TimestampMs } from "./codex-subagent-accounting.mjs";
import { IMAGE_GENERATION_ESTIMATE_CREDITS } from "./codex-usage-estimate.mjs";
import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "./token-usage.mjs";
import { displayUserPrompt } from "./task-history.mjs";

const rolloutPathIndexPromises = new Map();

function nestedParentThreadId(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return "";
  const direct = String(value.parent_thread_id ?? value.parentThreadId ?? "").trim();
  if (direct) return direct;
  for (const child of Object.values(value)) {
    const parentThreadId = nestedParentThreadId(child, depth + 1);
    if (parentThreadId) return parentThreadId;
  }
  return "";
}

function codexRolloutSession(entry, transcriptPath = "") {
  if (entry?.type !== "session_meta") return null;
  const payload = entry.payload ?? {};
  const threadId = String(payload.id ?? payload.session_id ?? "").trim();
  if (!threadId) return null;
  return {
    id: threadId,
    threadId,
    parentThreadId: nestedParentThreadId(payload),
    cwd: String(payload.cwd ?? "").trim(),
    workspaceRoot: String(payload.cwd ?? "").trim(),
    path: String(transcriptPath ?? "").trim(),
    repositoryUrl: String(
      payload.git?.repository_url
      ?? payload.git?.repositoryUrl
      ?? "",
    ).trim(),
    createdAt: String(payload.timestamp ?? entry.timestamp ?? "").trim(),
    updatedAt: String(payload.timestamp ?? entry.timestamp ?? "").trim(),
    source: payload.source ?? "",
  };
}

export async function readCodexRolloutSession(transcriptPath, {
  createReadStreamImpl = createReadStream,
} = {}) {
  const input = createReadStreamImpl(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        const session = codexRolloutSession(JSON.parse(line), transcriptPath);
        if (session) return session;
      } catch {
        // Keep looking if a damaged preamble record precedes session metadata.
      }
    }
  } finally {
    lines.close();
    input.destroy?.();
  }
  return null;
}

function parsedEntries(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line, index) => {
      try {
        return [{ index, value: JSON.parse(line) }];
      } catch {
        return [];
      }
    });
}

function entryTurnId(entry) {
  return String(
    entry?.payload?.internal_chat_message_metadata_passthrough?.turn_id
      ?? entry?.payload?.turn_id
      ?? "",
  ).trim();
}

function normalizedRolloutUsage(value) {
  return normalizeTokenUsage({
    inputTokens: value?.input_tokens,
    cachedInputTokens: value?.cached_input_tokens,
    outputTokens: value?.output_tokens,
    reasoningOutputTokens: value?.reasoning_output_tokens,
    totalTokens: value?.total_tokens,
  });
}

function isFinalAssistantItem(entry, turnId) {
  if (entry?.type !== "response_item" || entryTurnId(entry) !== turnId) return false;
  const payload = entry.payload;
  return payload?.type === "message"
    && payload?.role === "assistant"
    && ["final", "final_answer", "finalAnswer"].includes(String(payload?.phase ?? ""));
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return String(payload?.text ?? "").trim();
  return payload.content
    .map((item) => String(item?.text ?? item?.input_text ?? item?.output_text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function lifecycleTerminalStatus(value) {
  if (value === "task_complete") return "completed";
  if (value === "turn_aborted") return "aborted";
  if (["turn_cancelled", "task_cancelled"].includes(value)) return "cancelled";
  if (["turn_failed", "task_failed"].includes(value)) return "failed";
  return "";
}

function patchInputFiles(value, workspaceRoot = "") {
  const files = [];
  const text = String(value ?? "");
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    const candidate = String(match[1] ?? "").trim();
    if (!candidate) continue;
    files.push(path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : workspaceRoot
        ? path.resolve(workspaceRoot, candidate)
        : candidate);
  }
  return files;
}

function normalizedApplyPatch(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("*** Begin Patch") || !text.endsWith("*** End Patch")) return "";
  return text;
}

function availableSkillNames(value) {
  const text = String(value ?? "");
  const heading = /^### Available skills\s*$/mu.exec(text);
  if (!heading) return [];
  const section = text.slice(heading.index + heading[0].length).split(/^###?\s/mu, 1)[0];
  return [...section.matchAll(/^- ([A-Za-z][A-Za-z0-9_.:-]*):\s+\S/gmu)]
    .map((match) => match[1]);
}

function explicitSkillNames(value, knownSkills) {
  const names = new Set();
  for (const match of String(value ?? "").matchAll(/(?:^|[\s([{])\$([A-Za-z][A-Za-z0-9_.:-]*)/gu)) {
    if (knownSkills.has(match[1])) names.add(match[1]);
  }
  return [...names];
}

function skillReads(entry, knownSkills) {
  const sources = [];
  if (entry?.type === "response_item"
    && ["custom_tool_call", "function_call"].includes(entry.payload?.type)) {
    sources.push(entry.payload?.input, entry.payload?.arguments);
  }
  if (entry?.type === "event_msg" && entry.payload?.type === "mcp_tool_call_end") {
    sources.push(entry.payload?.invocation?.arguments);
  }
  const names = new Set();
  for (const source of sources) {
    const text = (typeof source === "string" ? source : JSON.stringify(source ?? ""))
      .replaceAll("\\", "/")
      .replace(/\/{2,}/gu, "/");
    for (const match of text.matchAll(/(?:^|\/)([^/"']+)\/SKILL\.md\b/giu)) {
      const directoryName = match[1];
      const resolved = [...knownSkills].find((name) => (
        name === directoryName || name.endsWith(`:${directoryName}`)
      ));
      if (resolved) names.add(resolved);
    }
  }
  return [...names];
}

function completedMcpCall(entry) {
  if (entry?.type !== "event_msg" || entry.payload?.type !== "mcp_tool_call_end") return null;
  const callId = String(entry.payload?.call_id ?? "").trim();
  if (!callId) return null;
  const invocation = entry.payload?.invocation ?? {};
  const result = entry.payload?.result;
  return {
    id: callId,
    server: String(invocation.server ?? "").trim(),
    tool: String(invocation.tool ?? "").trim(),
    status: result?.Err != null || result?.isError === true ? "failed" : "completed",
  };
}

function subagentActivity(entry) {
  if (entry?.type !== "event_msg" || entry.payload?.type !== "sub_agent_activity") return null;
  const childThreadId = String(entry.payload?.agent_thread_id ?? "").trim();
  if (!childThreadId || String(entry.payload?.kind ?? "") !== "started") return null;
  return {
    threadId: childThreadId,
    eventId: String(entry.payload?.event_id ?? "").trim(),
    agentPath: String(entry.payload?.agent_path ?? "").trim(),
    occurredAt: Number(entry.payload?.occurred_at_ms) || 0,
  };
}

function activityTurnId(entry, activeTurnIds, latestResponseTurnId = "") {
  const exact = entryTurnId(entry);
  if (exact) return exact;
  if (latestResponseTurnId) return latestResponseTurnId;
  return activeTurnIds.size === 1 ? [...activeTurnIds][0] : "";
}

function createTurnAccumulator(turnId) {
  const requestedTurnId = String(turnId ?? "").trim();
  if (!requestedTurnId) throw new Error("Codex turn id is required");

  const activeTurnIds = new Set();
  let latestResponseTurnId = "";
  let usage = emptyTokenUsage();
  let reported = false;
  let started = false;
  let terminal = false;
  let finalAnswerIndex = -1;
  let finalTokenIndex = -1;
  let finalAnswer = "";
  let startedAt = "";
  let completedAt = "";
  let prompt = "";
  let status = "";
  let workspaceRoot = "";
  let latestModel = "";
  let latestServiceTier = "default";
  let model = "";
  let serviceTier = "default";
  let index = -1;
  const changedFiles = new Set();
  const knownSkills = new Set();
  const skillsUsed = new Set();
  const mcpCalls = new Map();
  const patches = [];
  const imageGenerationCalls = new Map();
  const completedImageGenerationCalls = new Set();
  const spawnedSubagents = new Map();

  const accept = (entry) => {
    index += 1;
    if (entry?.type === "session_meta") {
      workspaceRoot ||= String(entry.payload?.cwd ?? "").trim();
    }
    if (entry?.type === "response_item"
      && entry.payload?.type === "message"
      && ["developer", "system"].includes(entry.payload?.role)) {
      for (const name of availableSkillNames(messageText(entry.payload))) knownSkills.add(name);
    }
    if (entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied") {
      latestModel = String(entry.payload?.thread_settings?.model ?? latestModel).trim();
      latestServiceTier = String(
        entry.payload?.thread_settings?.service_tier ?? latestServiceTier,
      ).trim() || "default";
    }
    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const lifecycleTurnId = lifecycle ? String(entry.payload?.turn_id ?? "").trim() : "";
    if (lifecycle === "task_started" && lifecycleTurnId) {
      activeTurnIds.add(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) {
        started = true;
        startedAt ||= String(entry?.timestamp ?? "");
      }
    } else if (lifecycleTerminalStatus(lifecycle) && lifecycleTurnId) {
      activeTurnIds.delete(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) {
        terminal = true;
        completedAt ||= String(entry?.timestamp ?? "");
        status = lifecycleTerminalStatus(lifecycle);
      }
    }
    if (lifecycle === "patch_apply_end" && lifecycleTurnId === requestedTurnId) {
      for (const file of Object.keys(entry.payload?.changes ?? {})) {
        if (String(file).trim()) changedFiles.add(String(file).trim());
      }
    }

    const exactTurnId = entryTurnId(entry);
    if (exactTurnId && ["response_item", "turn_context"].includes(String(entry?.type ?? ""))) {
      latestResponseTurnId = exactTurnId;
      if (exactTurnId === requestedTurnId) started = true;
    }
    if (entry?.type === "turn_context" && exactTurnId === requestedTurnId) {
      model = String(entry.payload?.model ?? latestModel).trim();
      serviceTier = String(entry.payload?.service_tier ?? latestServiceTier).trim() || "default";
    }
    if (entry?.type === "response_item"
      && entry.payload?.type === "function_call"
      && entry.payload?.name === "imagegen"
      && entry.payload?.call_id
      && exactTurnId) {
      imageGenerationCalls.set(String(entry.payload.call_id), exactTurnId);
    }
    if (entry?.type === "event_msg"
      && entry.payload?.type === "image_generation_end"
      && entry.payload?.status === "completed") {
      const callId = String(entry.payload?.call_id ?? "").trim();
      const attributedTurnId = imageGenerationCalls.get(callId)
        || latestResponseTurnId
        || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
      if (callId && attributedTurnId === requestedTurnId) {
        completedImageGenerationCalls.add(callId);
      }
    }
    const spawned = subagentActivity(entry);
    if (spawned && activityTurnId(entry, activeTurnIds, latestResponseTurnId) === requestedTurnId) {
      spawnedSubagents.set(spawned.threadId, spawned);
    }
    if (exactTurnId === requestedTurnId) {
      for (const name of skillReads(entry, knownSkills)) skillsUsed.add(name);
    }
    const mcpCall = completedMcpCall(entry);
    if (mcpCall) {
      const attributedTurnId = String(entry.payload?.turn_id ?? "").trim()
        || latestResponseTurnId
        || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
      if (attributedTurnId === requestedTurnId) mcpCalls.set(mcpCall.id, mcpCall);
    }
    if (entry?.type === "response_item"
      && exactTurnId === requestedTurnId
      && entry.payload?.type === "message"
      && entry.payload?.role === "user") {
      const rawPrompt = messageText(entry.payload);
      const candidate = displayUserPrompt(rawPrompt);
      if (candidate) prompt = candidate;
      for (const name of explicitSkillNames(rawPrompt, knownSkills)) skillsUsed.add(name);
    }
    if (entry?.type === "response_item"
      && exactTurnId === requestedTurnId
      && entry.payload?.type === "custom_tool_call"
      && entry.payload?.name === "apply_patch") {
      for (const file of patchInputFiles(entry.payload.input, workspaceRoot)) changedFiles.add(file);
      const patch = normalizedApplyPatch(entry.payload.input);
      if (patch) patches.push(patch);
    }
    if (isFinalAssistantItem(entry, requestedTurnId)) {
      finalAnswerIndex = index;
      finalAnswer = messageText(entry.payload) || finalAnswer;
    }

    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") return;
    const attributedTurnId = latestResponseTurnId
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    if (attributedTurnId === requestedTurnId) {
      usage = addTokenUsage(usage, normalizedRolloutUsage(entry.payload?.info?.last_token_usage));
      reported = true;
      finalTokenIndex = index;
    }
    latestResponseTurnId = "";
  };

  const result = () => {
    const imageGenerationCount = completedImageGenerationCalls.size;
    return {
      turnId: requestedTurnId,
      usage,
      reported,
      started,
      terminal,
      finalAnswerSeen: finalAnswerIndex >= 0,
      finalAnswer,
      finalTokenSeen: finalAnswerIndex < 0 ? reported : finalTokenIndex > finalAnswerIndex,
      startedAt,
      completedAt,
      prompt,
      changedFiles: [...changedFiles],
      diff: patches.join("\n\n"),
      skillsUsed: [...skillsUsed],
      mcpCalls: [...mcpCalls.values()],
      spawnedSubagents: [...spawnedSubagents.values()],
      toolMetricsKnown: true,
      imageGenerationCount,
      estimatedCredits: imageGenerationCount * IMAGE_GENERATION_ESTIMATE_CREDITS,
      estimateKind: imageGenerationCount > 0 ? "imagegen-default" : "",
      model: model || latestModel,
      serviceTier,
      status: status || (terminal ? "completed" : started ? "inProgress" : ""),
    };
  };

  return { accept, result };
}

export function codexTurnUsageFromJsonl(text, turnId) {
  const accumulator = createTurnAccumulator(turnId);
  for (const { value } of parsedEntries(text)) accumulator.accept(value);
  return accumulator.result();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_ROLLOUT_TAIL_BYTES = 64 * 1024 * 1024;
const DEFAULT_TERMINAL_TAIL_BYTES = 16 * 1024 * 1024;

export async function readCodexRolloutTail(transcriptPath, {
  openImpl = open,
  maxBytes = DEFAULT_ROLLOUT_TAIL_BYTES,
} = {}) {
  const handle = await openImpl(transcriptPath, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, Math.max(1, Number(maxBytes) || DEFAULT_ROLLOUT_TAIL_BYTES));
    const position = Math.max(0, info.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (position > 0) {
      const firstLineEnd = text.indexOf("\n");
      text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

export function codexRecentTerminalTurnsFromJsonl(text) {
  const values = new Map();
  for (const { value: entry } of parsedEntries(text)) {
    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const status = lifecycleTerminalStatus(lifecycle);
    const turnId = String(entry?.payload?.turn_id ?? "").trim();
    if (!status || !turnId) continue;
    values.set(turnId, {
      turnId,
      status,
      completedAt: String(entry?.timestamp ?? ""),
    });
  }
  return [...values.values()].slice(-16);
}

export async function readCodexRecentTerminalTurns(transcriptPath, {
  readTailImpl = readCodexRolloutTail,
  maxBytes = DEFAULT_TERMINAL_TAIL_BYTES,
} = {}) {
  return codexRecentTerminalTurnsFromJsonl(
    await readTailImpl(transcriptPath, { maxBytes }),
  );
}

export async function scanCodexTerminalEventsFromOffset(transcriptPath, {
  startOffset = 0,
  maxBytes = Number.POSITIVE_INFINITY,
  rolloutId = "",
  initialActiveTurns = [],
  createReadStreamImpl = createReadStream,
} = {}) {
  const terminals = new Map();
  const activeTurns = new Map((initialActiveTurns ?? []).flatMap((turn) => {
    const turnId = String(turn?.turnId ?? "").trim();
    return turnId ? [[turnId, {
      turnId,
      startedAt: String(turn?.startedAt ?? ""),
      lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
    }]] : [];
  }));
  const start = Math.max(0, Number(startOffset) || 0);
  const input = createReadStreamImpl(transcriptPath, { start });
  let pending = Buffer.alloc(0);
  let bytesRead = 0;
  let rolloutCreatedAt = uuidV7TimestampMs(rolloutId);
  const byteLimit = Number.isFinite(Number(maxBytes))
    ? Math.max(1, Number(maxBytes))
    : Number.POSITIVE_INFINITY;

  function acceptEntry(entry) {
    if (!rolloutCreatedAt && entry?.type === "session_meta") {
      rolloutCreatedAt = uuidV7TimestampMs(entry?.payload?.id);
    }
    const lifecycle = entry?.type === "event_msg"
      ? String(entry.payload?.type ?? "")
      : "";
    const timestamp = String(entry?.timestamp ?? "");
    const turnId = String(
      entry?.payload?.turn_id
      ?? entry?.payload?.internal_chat_message_metadata_passthrough?.turn_id
      ?? "",
    ).trim();
    if (!turnId) return;
    const turnCreatedAt = uuidV7TimestampMs(turnId);
    if (rolloutCreatedAt > 0 && turnCreatedAt > 0 && turnCreatedAt < rolloutCreatedAt) return;
    if (lifecycle === "task_started") {
      activeTurns.set(turnId, {
        turnId,
        startedAt: timestamp,
        lastActivityAt: timestamp,
      });
      return;
    }
    const active = activeTurns.get(turnId);
    if (active) active.lastActivityAt = timestamp;
    const status = lifecycleTerminalStatus(lifecycle);
    if (!status) return;
    activeTurns.delete(turnId);
    terminals.set(turnId, {
      turnId,
      status,
      completedAt: String(entry?.timestamp ?? ""),
    });
  }

  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
    let newline;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      try {
        acceptEntry(JSON.parse(line));
      } catch {
        // Ignore one malformed complete line without losing later terminal events.
      }
    }
    const completeBytesRead = bytesRead - pending.length;
    if (completeBytesRead >= byteLimit) break;
  }

  if (pending.length) {
    try {
      acceptEntry(JSON.parse(pending.toString("utf8").replace(/\r$/u, "")));
      return {
        terminals: [...terminals.values()],
        activeTurns: [...activeTurns.values()],
        nextOffset: start + bytesRead,
      };
    } catch {
      // Preserve an incomplete final JSONL record for the next audit.
    }
  }

  return {
    terminals: [...terminals.values()],
    activeTurns: [...activeTurns.values()],
    nextOffset: start + bytesRead - pending.length,
  };
}

export async function scanCodexTurnJsonl(transcriptPath, turnId, {
  createReadStreamImpl = createReadStream,
} = {}) {
  const accumulator = createTurnAccumulator(turnId);
  const input = createReadStreamImpl(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        accumulator.accept(JSON.parse(line));
      } catch {
        // A corrupt or partially flushed line must not discard the rest of a large rollout.
      }
    }
  } finally {
    lines.close();
  }
  return accumulator.result();
}

function createHistoricalTurn(turnId) {
  return {
    turnId,
    usage: emptyTokenUsage(),
    reported: false,
    started: false,
    terminal: false,
    finalAnswer: "",
    startedAt: "",
    completedAt: "",
    lastActivityAt: "",
    prompt: "",
    changedFiles: new Set(),
    patches: [],
    skillsUsed: new Set(),
    mcpCalls: new Map(),
    spawnedSubagents: new Map(),
    imageGenerationCalls: new Set(),
    estimatedCredits: 0,
    estimateKind: "",
    model: "",
    serviceTier: "default",
    status: "",
  };
}

/**
 * Streams one rollout once and returns every native turn recorded in it.
 * The caller still decides whether a turn is inherited parent history in a
 * subagent rollout because that needs the session/thread relationship.
 */
export async function scanCodexHistoricalRollout(transcriptPath, {
  createReadStreamImpl = createReadStream,
} = {}) {
  const turns = new Map();
  const activeTurnIds = new Set();
  const imageGenerationCalls = new Map();
  const knownSkills = new Set();
  let latestResponseTurnId = "";
  let latestModel = "";
  let latestServiceTier = "default";
  let workspaceRoot = "";
  let session = null;

  const ensureTurn = (turnId) => {
    const normalized = String(turnId ?? "").trim();
    if (!normalized) return null;
    if (!turns.has(normalized)) turns.set(normalized, createHistoricalTurn(normalized));
    return turns.get(normalized);
  };
  const touch = (turn, timestamp) => {
    if (!turn) return;
    const value = String(timestamp ?? "").trim();
    if (value) turn.lastActivityAt = value;
  };

  const accept = (entry) => {
    const timestamp = String(entry?.timestamp ?? "").trim();
    if (entry?.type === "session_meta") {
      workspaceRoot ||= String(entry.payload?.cwd ?? "").trim();
      const rolloutSession = codexRolloutSession(entry, transcriptPath);
      session ||= rolloutSession ? {
        threadId: rolloutSession.threadId,
        parentThreadId: rolloutSession.parentThreadId,
        workspaceRoot,
        createdAt: rolloutSession.createdAt || timestamp,
        source: rolloutSession.source,
      } : null;
    }
    if (entry?.type === "response_item"
      && entry.payload?.type === "message"
      && ["developer", "system"].includes(entry.payload?.role)) {
      for (const name of availableSkillNames(messageText(entry.payload))) knownSkills.add(name);
    }
    if (entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied") {
      latestModel = String(entry.payload?.thread_settings?.model ?? latestModel).trim();
      latestServiceTier = String(
        entry.payload?.thread_settings?.service_tier ?? latestServiceTier,
      ).trim() || "default";
    }

    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const lifecycleTurnId = lifecycle ? String(entry.payload?.turn_id ?? "").trim() : "";
    if (lifecycle === "task_started" && lifecycleTurnId) {
      const turn = ensureTurn(lifecycleTurnId);
      activeTurnIds.add(lifecycleTurnId);
      turn.started = true;
      turn.startedAt ||= timestamp;
      touch(turn, timestamp);
    } else if (lifecycleTerminalStatus(lifecycle) && lifecycleTurnId) {
      const turn = ensureTurn(lifecycleTurnId);
      activeTurnIds.delete(lifecycleTurnId);
      turn.terminal = true;
      turn.completedAt = timestamp || turn.completedAt;
      turn.status = lifecycleTerminalStatus(lifecycle);
      touch(turn, timestamp);
    }
    if (lifecycle === "patch_apply_end" && lifecycleTurnId) {
      const turn = ensureTurn(lifecycleTurnId);
      for (const file of Object.keys(entry.payload?.changes ?? {})) {
        if (String(file).trim()) turn.changedFiles.add(String(file).trim());
      }
      touch(turn, timestamp);
    }

    const exactTurnId = entryTurnId(entry);
    const exactTurn = ensureTurn(exactTurnId);
    if (exactTurnId && ["response_item", "turn_context"].includes(String(entry?.type ?? ""))) {
      latestResponseTurnId = exactTurnId;
      exactTurn.started = true;
      touch(exactTurn, timestamp);
    }
    if (entry?.type === "turn_context" && exactTurn) {
      exactTurn.model = String(entry.payload?.model ?? latestModel).trim();
      exactTurn.serviceTier = String(
        entry.payload?.service_tier ?? latestServiceTier,
      ).trim() || "default";
    }
    if (entry?.type === "response_item"
      && entry.payload?.type === "function_call"
      && entry.payload?.name === "imagegen"
      && entry.payload?.call_id
      && exactTurnId) {
      imageGenerationCalls.set(String(entry.payload.call_id), exactTurnId);
    }
    if (entry?.type === "event_msg"
      && entry.payload?.type === "image_generation_end"
      && entry.payload?.status === "completed") {
      const callId = String(entry.payload?.call_id ?? "").trim();
      const attributedTurnId = imageGenerationCalls.get(callId)
        || latestResponseTurnId
        || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
      const turn = ensureTurn(attributedTurnId);
      if (turn && callId) turn.imageGenerationCalls.add(callId);
      touch(turn, timestamp);
    }
    if (exactTurn) {
      for (const name of skillReads(entry, knownSkills)) exactTurn.skillsUsed.add(name);
    }
    const mcpCall = completedMcpCall(entry);
    if (mcpCall) {
      const attributedTurnId = String(entry.payload?.turn_id ?? "").trim()
        || latestResponseTurnId
        || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
      const turn = ensureTurn(attributedTurnId);
      if (turn) turn.mcpCalls.set(mcpCall.id, mcpCall);
      touch(turn, timestamp);
    }
    const spawned = subagentActivity(entry);
    if (spawned) {
      const attributedTurnId = activityTurnId(entry, activeTurnIds, latestResponseTurnId);
      const turn = ensureTurn(attributedTurnId);
      if (turn) turn.spawnedSubagents.set(spawned.threadId, spawned);
      touch(turn, timestamp);
    }
    if (entry?.type === "response_item"
      && exactTurn
      && entry.payload?.type === "message"
      && entry.payload?.role === "user") {
      const rawPrompt = messageText(entry.payload);
      const candidate = displayUserPrompt(rawPrompt);
      if (candidate) exactTurn.prompt = candidate;
      for (const name of explicitSkillNames(rawPrompt, knownSkills)) exactTurn.skillsUsed.add(name);
    }
    if (entry?.type === "response_item"
      && exactTurn
      && entry.payload?.type === "custom_tool_call"
      && entry.payload?.name === "apply_patch") {
      for (const file of patchInputFiles(entry.payload.input, workspaceRoot)) {
        exactTurn.changedFiles.add(file);
      }
      const patch = normalizedApplyPatch(entry.payload.input);
      if (patch) exactTurn.patches.push(patch);
    }
    if (exactTurn && isFinalAssistantItem(entry, exactTurnId)) {
      exactTurn.finalAnswer = messageText(entry.payload) || exactTurn.finalAnswer;
    }

    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") return;
    const attributedTurnId = latestResponseTurnId
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    const attributedTurn = ensureTurn(attributedTurnId);
    if (attributedTurn) {
      attributedTurn.usage = addTokenUsage(
        attributedTurn.usage,
        normalizedRolloutUsage(entry.payload?.info?.last_token_usage),
      );
      attributedTurn.reported = true;
      touch(attributedTurn, timestamp);
    }
    latestResponseTurnId = "";
  };

  const input = createReadStreamImpl(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        accept(JSON.parse(line));
      } catch {
        // One malformed JSONL record must not hide the rest of the history.
      }
    }
  } finally {
    lines.close();
  }

  return {
    session: session ?? {
      threadId: "",
      parentThreadId: "",
      workspaceRoot,
      createdAt: "",
      source: "",
    },
    turns: [...turns.values()].map((turn) => {
      const imageGenerationCount = turn.imageGenerationCalls.size;
      return {
        ...turn,
        changedFiles: [...turn.changedFiles],
        diff: turn.patches.join("\n\n"),
        skillsUsed: [...turn.skillsUsed],
        mcpCalls: [...turn.mcpCalls.values()],
        spawnedSubagents: [...turn.spawnedSubagents.values()],
        toolMetricsKnown: true,
        imageGenerationCount,
        estimatedCredits: imageGenerationCount * IMAGE_GENERATION_ESTIMATE_CREDITS,
        estimateKind: imageGenerationCount > 0 ? "imagegen-default" : "",
        model: turn.model || latestModel,
        serviceTier: turn.serviceTier || latestServiceTier,
      };
    }),
  };
}

export function codexSubagentSpawnFromJsonl(text, childThreadId) {
  const childId = String(childThreadId ?? "").trim();
  if (!childId) return null;
  const activeTurnIds = new Set();
  let latestResponseTurnId = "";
  let matched = null;
  for (const { value: entry } of parsedEntries(text)) {
    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const lifecycleTurnId = lifecycle ? String(entry.payload?.turn_id ?? "").trim() : "";
    if (lifecycle === "task_started" && lifecycleTurnId) activeTurnIds.add(lifecycleTurnId);
    else if (lifecycleTerminalStatus(lifecycle) && lifecycleTurnId) activeTurnIds.delete(lifecycleTurnId);
    const exactTurnId = entryTurnId(entry);
    if (exactTurnId && ["response_item", "turn_context"].includes(String(entry?.type ?? ""))) {
      latestResponseTurnId = exactTurnId;
    }
    const spawned = subagentActivity(entry);
    if (spawned?.threadId === childId) {
      const parentTurnId = activityTurnId(entry, activeTurnIds, latestResponseTurnId);
      if (parentTurnId) matched = { ...spawned, parentTurnId };
    }
    if (entry?.type === "event_msg" && entry.payload?.type === "token_count") {
      latestResponseTurnId = "";
    }
  }
  return matched;
}

export async function readCodexSubagentSpawn(transcriptPath, childThreadId, {
  readTailImpl = readCodexRolloutTail,
  maxBytes = DEFAULT_ROLLOUT_TAIL_BYTES,
} = {}) {
  return codexSubagentSpawnFromJsonl(
    await readTailImpl(transcriptPath, { maxBytes }),
    childThreadId,
  );
}

export async function scanCodexTurnPricingMetadata(transcriptPath, turnIds, {
  createReadStreamImpl = createReadStream,
} = {}) {
  const requested = new Set(
    [...(turnIds ?? [])].map((value) => String(value ?? "").trim()).filter(Boolean),
  );
  const result = new Map();
  if (!requested.size) return result;
  let latestModel = "";
  let latestServiceTier = "default";
  const input = createReadStreamImpl(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied") {
        latestModel = String(entry.payload?.thread_settings?.model ?? latestModel).trim();
        latestServiceTier = String(
          entry.payload?.thread_settings?.service_tier ?? latestServiceTier,
        ).trim() || "default";
        continue;
      }
      if (entry?.type === "event_msg" && entry.payload?.type === "task_started") {
        const turnId = String(entry.payload?.turn_id ?? "").trim();
        if (requested.has(turnId) && latestModel) {
          result.set(turnId, {
            model: latestModel,
            serviceTier: latestServiceTier,
          });
        }
        if (result.size === requested.size) break;
        continue;
      }
      if (entry?.type !== "turn_context") continue;
      const turnId = entryTurnId(entry);
      if (!requested.has(turnId)) continue;
      result.set(turnId, {
        model: String(entry.payload?.model ?? latestModel).trim(),
        serviceTier: String(
          entry.payload?.service_tier ?? latestServiceTier,
        ).trim() || "default",
      });
      if (result.size === requested.size) break;
    }
  } finally {
    lines.close();
  }
  return result;
}

async function buildCodexRolloutPathIndex(codexHome, readdirImpl) {
  const paths = new Map();
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdirImpl(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
        .exec(entry.name);
      if (match) paths.set(match[1].toLowerCase(), candidate);
    }
  };
  await visit(path.join(codexHome, "sessions"));
  await visit(path.join(codexHome, "archived_sessions"));
  return paths;
}

export async function discoverCodexRollouts({
  codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  readdirImpl = readdir,
  readSession = readCodexRolloutSession,
} = {}) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdirImpl(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(candidate);
      }
    }
  };
  await visit(path.join(codexHome, "sessions"));
  await visit(path.join(codexHome, "archived_sessions"));

  const result = [];
  for (const file of files) {
    const session = await readSession(file);
    if (session?.threadId) result.push(session);
  }
  return result;
}

export async function discoverCodexSubagentRollouts(options = {}) {
  return (await discoverCodexRollouts(options))
    .filter((session) => session.parentThreadId);
}

async function codexRolloutPathIndex(codexHome, readdirImpl) {
  if (readdirImpl !== readdir) return buildCodexRolloutPathIndex(codexHome, readdirImpl);
  const key = path.resolve(codexHome).toLowerCase();
  if (!rolloutPathIndexPromises.has(key)) {
    rolloutPathIndexPromises.set(key, buildCodexRolloutPathIndex(codexHome, readdirImpl));
  }
  return rolloutPathIndexPromises.get(key);
}

export async function findCodexRolloutPath(threadId, startedAt, {
  codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  readdirImpl = readdir,
} = {}) {
  const normalizedThreadId = String(threadId ?? "").trim();
  const timestamp = Date.parse(String(startedAt ?? ""));
  if (!normalizedThreadId) return "";
  const candidates = [];
  if (Number.isFinite(timestamp)) {
    for (const offsetDays of [0, -1, 1]) {
      const date = new Date(timestamp + offsetDays * 86_400_000);
      const directory = path.join(
        codexHome,
        "sessions",
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
      );
      let entries;
      try {
        entries = await readdirImpl(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      const suffix = `-${normalizedThreadId}.jsonl`.toLowerCase();
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
          candidates.push(path.join(directory, entry.name));
        }
      }
    }
  }
  if (candidates.length) return candidates.at(-1);
  const index = await codexRolloutPathIndex(codexHome, readdirImpl);
  return index.get(normalizedThreadId.toLowerCase()) ?? "";
}

async function scanCodexTurnJsonlFromOffset(
  transcriptPath,
  accumulator,
  start,
  { createReadStreamImpl = createReadStream } = {},
) {
  const input = createReadStreamImpl(transcriptPath, { start });
  let pending = Buffer.alloc(0);
  let bytesRead = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    pending = pending.length ? Buffer.concat([pending, buffer]) : buffer;
    let newline;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      pending = pending.subarray(newline + 1);
      if (!line) continue;
      try {
        accumulator.accept(JSON.parse(line));
      } catch {
        // Ignore one malformed complete line without losing later exact-turn events.
      }
    }
  }
  if (pending.length) {
    try {
      accumulator.accept(JSON.parse(pending.toString("utf8").replace(/\r$/u, "")));
      return start + bytesRead;
    } catch {
      // The writer may still be flushing this final JSONL record; retry from its start.
    }
  }
  return start + bytesRead - pending.length;
}

export async function scanCodexTurnJsonlIncrementally(transcriptPath, turnId, {
  createReadStreamImpl = createReadStream,
  attempts = 5,
  retryDelayMs = 40,
} = {}) {
  const accumulator = createTurnAccumulator(turnId);
  let position = 0;
  let result = null;
  let error = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      position = await scanCodexTurnJsonlFromOffset(
        transcriptPath,
        accumulator,
        position,
        { createReadStreamImpl },
      );
      result = accumulator.result();
      if (result.reported && result.finalTokenSeen && result.terminal) return result;
    } catch (currentError) {
      error = currentError;
    }
    if (attempt + 1 < attempts) await delay(retryDelayMs);
  }
  if (result?.reported || result?.started || result?.terminal) return result;
  if (error) throw error;
  throw new Error(`Token usage was not found for Codex turn ${turnId}`);
}

export async function readCodexTurnUsage(transcriptPath, turnId, {
  readFileImpl = null,
  readTailImpl = null,
  scanImpl = null,
  scanIncrementalImpl = scanCodexTurnJsonlIncrementally,
  attempts = 5,
  retryDelayMs = 40,
} = {}) {
  if (!readFileImpl && !readTailImpl && !scanImpl) {
    return scanIncrementalImpl(transcriptPath, turnId, { attempts, retryDelayMs });
  }
  let result = null;
  let error = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      if (readFileImpl || readTailImpl) {
        const text = readFileImpl
          ? await readFileImpl(transcriptPath, "utf8")
          : await readTailImpl(transcriptPath);
        result = codexTurnUsageFromJsonl(text, turnId);
      } else {
        result = await scanImpl(transcriptPath, turnId);
      }
      if (result.reported && result.finalTokenSeen && result.terminal) return result;
    } catch (currentError) {
      error = currentError;
    }
    if (attempt + 1 < attempts) await delay(retryDelayMs);
  }
  if (result?.reported) return result;
  if (result?.started || result?.terminal) return result;
  if (error) throw error;
  throw new Error(`Token usage was not found for Codex turn ${turnId}`);
}
