import { assertCodexRolloutReadAllowed } from "../../infrastructure/filesystem/test-contour-rollout-policy.mjs";
import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";

import { uuidV7TimestampMs } from "./codex-subagent-accounting.mjs";
import { IMAGE_GENERATION_ESTIMATE_CREDITS } from "../../domain/codex-usage-estimate.mjs";
import { isCodexContextProbeClientId } from "../../domain/codex-service-usage-identity.mjs";
import {
  codexAssistantResponseProjection,
} from "../../domain/codex-response-annotation.mjs";
import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "../../domain/token-usage.mjs";
import { mergeUsageLimitSamples } from "../../domain/usage-facts.mjs";
import { displayUserPrompt } from "../../application/task-history.mjs";

const rolloutPathIndexPromises = new Map();
const rolloutSessionCache = new Map();
const DEFAULT_ROLLOUT_SESSION_CACHE_LIMIT = 128;
const DEFAULT_ROLLOUT_SESSION_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_ROLLOUT_SESSION_SCAN_BYTES = 1024 * 1024;
const DEFAULT_ROLLOUT_SESSION_SCAN_LINES = 4_096;
const DEFAULT_ROLLOUT_SESSION_LINE_BYTES = 256 * 1024;
const DEFAULT_ROLLOUT_SESSION_SCAN_MS = 1_000;
const IMAGE_GENERATION_CALL_OWNER_LIMIT = 128;
const AMBIGUOUS_IMAGE_GENERATION_CALL_OWNER = Object.freeze({ state: "ambiguous" });

function rememberImageGenerationCallOwner(owners, callId, turnId) {
  const normalizedCallId = String(callId ?? "").trim();
  const normalizedTurnId = String(turnId ?? "").trim();
  if (!normalizedCallId || !normalizedTurnId) return;
  const currentOwner = owners.get(normalizedCallId);
  const nextOwner = currentOwner === undefined || currentOwner === normalizedTurnId
    ? normalizedTurnId
    : AMBIGUOUS_IMAGE_GENERATION_CALL_OWNER;
  owners.delete(normalizedCallId);
  owners.set(normalizedCallId, nextOwner);
  while (owners.size > IMAGE_GENERATION_CALL_OWNER_LIMIT) {
    owners.delete(owners.keys().next().value);
  }
}

function imageGenerationCallOwnerTurnId(owners, callId) {
  const normalizedCallId = String(callId ?? "").trim();
  const owner = normalizedCallId ? owners.get(normalizedCallId) : null;
  return typeof owner === "string" ? owner : "";
}

function consumeImageGenerationCallOwner(owners, callId, turnId) {
  const normalizedCallId = String(callId ?? "").trim();
  const normalizedTurnId = String(turnId ?? "").trim();
  if (!normalizedCallId || !normalizedTurnId) return;
  const currentOwner = owners.get(normalizedCallId);
  if (currentOwner === normalizedTurnId) {
    owners.delete(normalizedCallId);
  } else if (currentOwner !== undefined
    && currentOwner?.state !== AMBIGUOUS_IMAGE_GENERATION_CALL_OWNER.state) {
    owners.delete(normalizedCallId);
    owners.set(normalizedCallId, AMBIGUOUS_IMAGE_GENERATION_CALL_OWNER);
  }
}

function restoredImageGenerationCallOwners(value) {
  const owners = new Map();
  const entries = Array.isArray(value)
    ? value.slice(-IMAGE_GENERATION_CALL_OWNER_LIMIT)
    : [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    if (entry[1]?.state === AMBIGUOUS_IMAGE_GENERATION_CALL_OWNER.state) {
      const callId = String(entry[0] ?? "").trim();
      if (callId) owners.set(callId, AMBIGUOUS_IMAGE_GENERATION_CALL_OWNER);
    } else {
      rememberImageGenerationCallOwner(owners, entry[0], entry[1]);
    }
  }
  return owners;
}

function rolloutSessionCacheKey(file) {
  return path.resolve(file).toLowerCase();
}

function rolloutSessionBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return DEFAULT_ROLLOUT_SESSION_CACHE_BYTES;
  }
}

function trimRolloutSessionCache(cache, limit, maxBytes = DEFAULT_ROLLOUT_SESSION_CACHE_BYTES) {
  const normalizedLimit = Math.max(1, Number(limit) || DEFAULT_ROLLOUT_SESSION_CACHE_LIMIT);
  let retainedBytes = [...cache.values()].reduce((total, value) => total + rolloutSessionBytes(value), 0);
  while (cache.size > normalizedLimit || retainedBytes > maxBytes) {
    const oldestKey = cache.keys().next().value;
    retainedBytes -= rolloutSessionBytes(cache.get(oldestKey));
    cache.delete(oldestKey);
  }
}

function pruneRolloutSessionCache(cache, codexHome, seenKeys) {
  const roots = ["sessions", "archived_sessions"]
    .map((name) => `${rolloutSessionCacheKey(path.join(codexHome, name))}${path.sep}`);
  for (const key of cache.keys()) {
    if (roots.some((root) => key.startsWith(root)) && !seenKeys.has(key)) {
      cache.delete(key);
    }
  }
}

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
  maxBytes = DEFAULT_ROLLOUT_SESSION_SCAN_BYTES,
  maxLines = DEFAULT_ROLLOUT_SESSION_SCAN_LINES,
  maxLineBytes = DEFAULT_ROLLOUT_SESSION_LINE_BYTES,
  maxDurationMs = DEFAULT_ROLLOUT_SESSION_SCAN_MS,
} = {}) {
  assertCodexRolloutReadAllowed("readCodexRolloutSession");
  const byteLimit = Math.max(1, Number(maxBytes) || DEFAULT_ROLLOUT_SESSION_SCAN_BYTES);
  const lineLimit = Math.max(1, Number(maxLines) || DEFAULT_ROLLOUT_SESSION_SCAN_LINES);
  const lineByteLimit = Math.max(1, Number(maxLineBytes) || DEFAULT_ROLLOUT_SESSION_LINE_BYTES);
  const durationLimit = Math.max(1, Number(maxDurationMs) || DEFAULT_ROLLOUT_SESSION_SCAN_MS);
  const input = createReadStreamImpl(transcriptPath, { start: 0, end: byteLimit - 1 });
  const iterator = input[Symbol.asyncIterator]();
  const deadline = Date.now() + durationLimit;
  let bytesRead = 0;
  let linesRead = 0;
  let pendingParts = [];
  let pendingLength = 0;
  let droppingLongLine = false;
  let reachedEof = false;

  const acceptLine = (parts, length) => {
    if (!length) return null;
    try {
      const line = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
      return codexRolloutSession(JSON.parse(line.toString("utf8").replace(/\r$/u, "")), transcriptPath);
    } catch {
      return null;
    }
  };

  try {
    while (bytesRead < byteLimit && linesRead < lineLimit) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      let timer;
      const next = await Promise.race([
        iterator.next().then((value) => ({ value })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
        }),
      ]);
      clearTimeout(timer);
      if (next.timedOut) break;
      if (next.value.done) {
        reachedEof = true;
        break;
      }
      const source = Buffer.isBuffer(next.value.value)
        ? next.value.value
        : Buffer.from(next.value.value);
      const chunk = source.subarray(0, Math.min(source.length, byteLimit - bytesRead));
      bytesRead += chunk.length;
      let start = 0;
      let newline = chunk.indexOf(0x0a);
      while (newline >= 0 && linesRead < lineLimit) {
        const part = chunk.subarray(start, newline);
        linesRead += 1;
        if (!droppingLongLine && pendingLength + part.length <= lineByteLimit) {
          const session = acceptLine([...pendingParts, part], pendingLength + part.length);
          if (session) return session;
        }
        pendingParts = [];
        pendingLength = 0;
        droppingLongLine = false;
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length && linesRead < lineLimit) {
        const part = chunk.subarray(start);
        if (!droppingLongLine && pendingLength + part.length <= lineByteLimit) {
          pendingParts.push(part);
          pendingLength += part.length;
        } else {
          pendingParts = [];
          pendingLength = 0;
          droppingLongLine = true;
        }
      }
    }
    if (reachedEof && !droppingLongLine && pendingLength && linesRead < lineLimit) {
      return acceptLine(pendingParts, pendingLength);
    }
  } catch {
    return null;
  } finally {
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

function imageGenerationCallId(entry) {
  const payload = entry?.payload ?? {};
  const payloadType = String(payload.type ?? "");
  if (entry?.type !== "response_item"
    || !payloadType.endsWith("_call")
    || payloadType.endsWith("_call_output")) return "";
  const callId = String(payload.call_id ?? "").trim();
  const name = String(payload.name ?? "").trim().toLowerCase();
  const input = String(payload.input ?? payload.arguments ?? "");
  return callId && (
    name === "imagegen"
    || name === "image_gen__imagegen"
    || /\btools\.image_gen__imagegen\s*\(/u.test(input)
  ) ? callId : "";
}

function generatedImagePathsFromText(value) {
  const paths = [];
  const pattern = /Generated images are saved to[\s\S]*?\sas\s+((?:[A-Za-z]:)?(?:\\|\/)[^"\r\n]+?\.(?:png|jpe?g|webp|gif|bmp))/giu;
  for (const match of String(value ?? "").matchAll(pattern)) {
    const candidate = String(match[1] ?? "").replace(/\\\\/gu, "\\").trim();
    if (candidate) paths.push(candidate);
  }
  return [...new Set(paths)];
}

function generatedImageOutputPaths(entry) {
  const payload = entry?.payload ?? {};
  if (entry?.type === "event_msg" && payload.type === "item_completed") {
    const item = payload.item;
    if (item?.type !== "Extension" || item.kind !== "image_gen.generation"
      || item.status !== "completed" || item.failure != null) return [];
    const value = String(item.savedPath ?? "").trim();
    return value ? [value] : [];
  }
  if (entry?.type === "event_msg" && payload.type === "image_generation_end") {
    const value = String(payload.saved_path ?? "").trim();
    return value ? [value] : [];
  }
  if (entry?.type !== "response_item" || ![
    "custom_tool_call_output",
    "customToolCallOutput",
    "function_call_output",
    "functionCallOutput",
  ].includes(String(payload.type ?? ""))) return [];
  const blocks = Array.isArray(payload.output)
    ? payload.output
    : Array.isArray(payload.content) ? payload.content : [];
  return generatedImagePathsFromText(blocks
    .filter((block) => ["input_text", "output_text", "text"].includes(String(block?.type ?? "")))
    .map((block) => String(block?.text ?? ""))
    .join("\n"));
}

function completedImageGenerationId(entry) {
  const payload = entry?.payload ?? {};
  if (entry?.type !== "event_msg") return "";
  if (payload.type === "item_completed") {
    const item = payload.item;
    if (item?.type !== "Extension" || item.kind !== "image_gen.generation"
      || item.status !== "completed" || item.failure != null) return "";
    const id = String(item.id ?? "").trim();
    return id;
  }
  if (payload.type !== "image_generation_end" || payload.status !== "completed") return "";
  const callId = String(payload.call_id ?? "").trim();
  return callId;
}

const LONG_CONTEXT_USAGE_FIELDS = [
  "longContextInputTokens",
  "longContextCachedInputTokens",
  "longContextCacheWriteInputTokens",
  "longContextOutputTokens",
  "longContextReasoningOutputTokens",
];
const GPT_6_1_LONG_CONTEXT_THRESHOLD = 272_000;

function normalizedRolloutUsage(value, { request = false } = {}) {
  const usage = normalizeTokenUsage({
    inputTokens: value?.input_tokens,
    cachedInputTokens: value?.cached_input_tokens,
    cacheWriteInputTokens: value?.cache_write_input_tokens,
    outputTokens: value?.output_tokens,
    reasoningOutputTokens: value?.reasoning_output_tokens,
    totalTokens: value?.total_tokens,
  });
  if (request && usage.inputTokens > GPT_6_1_LONG_CONTEXT_THRESHOLD) {
    usage.longContextInputTokens = usage.inputTokens;
    usage.longContextCachedInputTokens = usage.cachedInputTokens;
    usage.longContextCacheWriteInputTokens = usage.cacheWriteInputTokens;
    usage.longContextOutputTokens = usage.outputTokens;
    usage.longContextReasoningOutputTokens = usage.reasoningOutputTokens;
  }
  return usage;
}

function preserveRequestPricingUsage(exact, previous) {
  const merged = { ...exact };
  for (const field of LONG_CONTEXT_USAGE_FIELDS) {
    if ((previous?.[field] ?? 0) > 0) merged[field] = previous[field];
  }
  return merged;
}

function addRequestPricingUsage(exact, request) {
  const merged = { ...exact };
  for (const field of LONG_CONTEXT_USAGE_FIELDS) {
    if ((request?.[field] ?? 0) > 0) merged[field] = (merged[field] ?? 0) + request[field];
  }
  return merged;
}

function exactTurnTokenUsage(entry) {
  if (entry?.type !== "token_usage_record" || !entryTurnId(entry)) return null;
  const usage = entry.payload?.turn_token_usage;
  if (!usage || !["input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"]
    .every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null;
  return normalizedRolloutUsage(usage);
}

function isoFromEpochSeconds(value) {
  const milliseconds = Number(value) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "";
  return new Date(milliseconds).toISOString();
}

function timestamp(value) {
  const candidate = String(value ?? "").trim();
  return Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function codexLimitSamplesFromTokenEvent(entry) {
  const observedAt = timestamp(entry?.timestamp);
  const source = entry?.payload?.rate_limits ?? entry?.rate_limits;
  if (!observedAt || !source || typeof source !== "object") return [];
  const buckets = source.limit_id || source.limitId
    ? [source]
    : Object.values(source.rateLimitsByLimitId ?? source).filter((value) => (
      value && typeof value === "object"
    ));
  const samples = [];
  for (const bucket of buckets) {
    const limitId = String(bucket?.limit_id ?? bucket?.limitId ?? bucket?.limitName ?? "").trim();
    if (!limitId) continue;
    for (const [window, value] of Object.entries(bucket)) {
      if (["limit_id", "limitId", "limitName", "plan_type", "planType"].includes(window)) continue;
      if (!value || typeof value !== "object") continue;
      const usedPercent = Number(value.used_percent ?? value.usedPercent);
      if (!Number.isFinite(usedPercent)) continue;
      samples.push({
        observedAt,
        limitId,
        window,
        windowMinutes: Number(value.window_minutes ?? value.windowDurationMins) || null,
        usedPercent,
        resetsAt: timestamp(value.resets_at ?? value.resetsAt)
          || isoFromEpochSeconds(value.resets_at ?? value.resetsAt),
        planType: String(bucket.plan_type ?? bucket.planType ?? "").trim(),
      });
    }
  }
  return mergeUsageLimitSamples(samples);
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

function lifecycleTerminalStatus(value, payload) {
  if (value === "task_complete") return payload?.error ? "failed" : "completed";
  if (value === "turn_aborted") return "aborted";
  if (["turn_cancelled", "task_cancelled"].includes(value)) return "cancelled";
  if (["turn_failed", "task_failed"].includes(value)) return "failed";
  return "";
}

function acceptUserOperationIdentity(turn, entry) {
  if (!turn) return;
  const payload = entry?.payload;
  const clientId = String(payload?.client_id ?? payload?.clientUserMessageId ?? "").trim();
  if (clientId) turn.clientUserMessageId = clientId;
  if (entry?.type === "response_item" && payload?.type === "message" && payload?.role === "user") {
    turn.prompt ||= displayUserPrompt(messageText(payload));
  }
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
  return [...section.matchAll(/^- ([A-Za-z0-9][A-Za-z0-9_.:-]*):\s+\S/gmu)]
    .map((match) => match[1]);
}

function explicitSkillNames(value, knownSkills) {
  const names = new Set();
  for (const match of String(value ?? "").matchAll(/(?:^|[\s([{])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/gu)) {
    if (knownSkills.has(match[1])) names.add(match[1]);
  }
  return [...names];
}

function trustedSkillCatalogPath(value) {
  return /(?:^|\/)(?:skills|[^/]+_skills)(?:\/|$)/iu.test(value);
}

function explicitSkillFileRead(entry, source, matchIndex) {
  const toolName = String(
    entry?.payload?.name
    ?? entry?.payload?.invocation?.tool
    ?? "",
  ).trim();
  if (/^(?:read_file|read_text_file)$/iu.test(toolName)) return true;
  const prefix = source.slice(Math.max(0, matchIndex - 512), matchIndex);
  return /(?:\bGet-Content\b|\bcat\s+(?:-[A-Za-z]+\s+)*|\breadFile(?:Sync)?\s*\()/iu.test(prefix);
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
      if (resolved && explicitSkillFileRead(entry, text, match.index)) {
        names.add(resolved);
      } else if (/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(directoryName)
        && trustedSkillCatalogPath(text.slice(0, match.index + match[0].length))
        && explicitSkillFileRead(entry, text, match.index)) {
        names.add(directoryName);
      }
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
  let exactUsageReported = false;
  let reported = false;
  let started = false;
  let terminal = false;
  let finalAnswerIndex = -1;
  let terminalAnswerSeen = false;
  let finalTokenIndex = -1;
  let finalAnswer = "";
  let responseAnnotationReferences = [];
  let startedAt = "";
  let completedAt = "";
  let limitSamples = [];
  let prompt = "";
  const prompts = [];
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
  const generatedImageSources = new Set();
  const spawnedSubagents = new Map();
  const userOperation = {};

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
    } else if (lifecycleTerminalStatus(lifecycle, entry.payload) && lifecycleTurnId) {
      activeTurnIds.delete(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) {
        terminal = true;
        completedAt ||= String(entry?.timestamp ?? "");
        status = lifecycleTerminalStatus(lifecycle, entry.payload);
        const terminalProjection = codexAssistantResponseProjection(entry.payload?.last_agent_message);
        const terminalAnswer = terminalProjection.text.trim();
        if (terminalAnswer && !finalAnswer) {
          finalAnswer = terminalAnswer;
          responseAnnotationReferences = terminalProjection.responseAnnotationReferences;
          terminalAnswerSeen = true;
        }
      }
    }
    if (lifecycle === "patch_apply_end" && lifecycleTurnId === requestedTurnId) {
      for (const file of Object.keys(entry.payload?.changes ?? {})) {
        if (String(file).trim()) changedFiles.add(String(file).trim());
      }
    }

    const exactTurnId = entryTurnId(entry);
    if (exactTurnId === requestedTurnId) acceptUserOperationIdentity(userOperation, entry);
    const exactUsage = exactTurnTokenUsage(entry);
    if (exactUsage && exactTurnId === requestedTurnId) {
      usage = preserveRequestPricingUsage(exactUsage, usage);
      exactUsageReported = true;
      reported = true;
      finalTokenIndex = index;
      latestResponseTurnId = exactTurnId;
    }
    if (exactTurnId && ["response_item", "turn_context"].includes(String(entry?.type ?? ""))) {
      latestResponseTurnId = exactTurnId;
      if (exactTurnId === requestedTurnId) started = true;
    }
    if (entry?.type === "turn_context" && exactTurnId === requestedTurnId) {
      model = String(entry.payload?.model ?? latestModel).trim();
      serviceTier = String(entry.payload?.service_tier ?? latestServiceTier).trim() || "default";
    }
    const imageCallId = imageGenerationCallId(entry);
    if (imageCallId && exactTurnId) {
      rememberImageGenerationCallOwner(imageGenerationCalls, imageCallId, exactTurnId);
    }
    const completedImageId = completedImageGenerationId(entry);
    if (completedImageId) {
      const callId = String(entry.payload?.call_id ?? "").trim();
      const attributedTurnId = exactTurnId
        || imageGenerationCallOwnerTurnId(imageGenerationCalls, callId);
      if (attributedTurnId === requestedTurnId) {
        completedImageGenerationCalls.add(completedImageId);
      }
    }
    const generatedPaths = generatedImageOutputPaths(entry);
    if (generatedPaths.length) {
      const callId = String(entry.payload?.call_id ?? "").trim();
      const attributedTurnId = exactTurnId
        || imageGenerationCallOwnerTurnId(imageGenerationCalls, callId);
      if (attributedTurnId === requestedTurnId) {
        for (const generatedPath of generatedPaths) generatedImageSources.add(generatedPath);
        consumeImageGenerationCallOwner(imageGenerationCalls, callId, attributedTurnId);
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
      if (candidate) {
        prompt ||= candidate;
        prompts.push(candidate);
      }
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
      const projection = codexAssistantResponseProjection(messageText(entry.payload));
      finalAnswer = projection.text.trim() || finalAnswer;
      if (projection.responseAnnotationReferences.length) {
        responseAnnotationReferences = projection.responseAnnotationReferences;
      }
    }

    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") return;
    const attributedTurnId = latestResponseTurnId
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    if (attributedTurnId === requestedTurnId) {
      const requestUsage = normalizedRolloutUsage(entry.payload?.info?.last_token_usage, {
        request: true,
      });
      if (!exactUsageReported) {
        usage = addTokenUsage(usage, requestUsage);
      } else {
        usage = addRequestPricingUsage(usage, requestUsage);
      }
      limitSamples = mergeUsageLimitSamples(limitSamples, codexLimitSamplesFromTokenEvent(entry));
      reported = true;
      finalTokenIndex = index;
    }
    latestResponseTurnId = "";
  };

  const result = () => {
    const imageGenerationCount = completedImageGenerationCalls.size;
    return {
      turnId: requestedTurnId,
      ...(userOperation.clientUserMessageId ? { clientUserMessageId: userOperation.clientUserMessageId } : {}),
      serviceUsageKind: isCodexContextProbeClientId(userOperation.clientUserMessageId)
        ? "context-probe" : "",
      usage,
      reported,
      started,
      terminal,
      finalAnswerSeen: finalAnswerIndex >= 0 || terminalAnswerSeen,
      finalAnswer,
      responseAnnotationReferences,
      finalTokenSeen: terminalAnswerSeen || finalAnswerIndex < 0
        ? reported
        : finalTokenIndex > finalAnswerIndex,
      startedAt,
      completedAt,
      prompt,
      prompts,
      changedFiles: [...changedFiles],
      diff: patches.join("\n\n"),
      skillsUsed: [...skillsUsed],
      mcpCalls: [...mcpCalls.values()],
      spawnedSubagents: [...spawnedSubagents.values()],
      toolMetricsKnown: true,
      imageGenerationCount,
      generatedImageSources: [...generatedImageSources].map((value) => ({
        type: "generated-path",
        value,
      })),
      estimatedCredits: imageGenerationCount * IMAGE_GENERATION_ESTIMATE_CREDITS,
      estimateKind: imageGenerationCount > 0 ? "imagegen-default" : "",
      limitSamples,
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
const DEFAULT_TURN_START_SEARCH_BYTES = 1024 * 1024;

export async function readCodexRolloutTail(transcriptPath, {
  openImpl = open,
  maxBytes = DEFAULT_ROLLOUT_TAIL_BYTES,
} = {}) {
  assertCodexRolloutReadAllowed("readCodexRolloutTail");
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

export async function findCodexTurnStartOffsetFromTail(transcriptPath, turnId, {
  openImpl = open,
  chunkBytes = DEFAULT_TURN_START_SEARCH_BYTES,
} = {}) {
  assertCodexRolloutReadAllowed("findCodexTurnStartOffsetFromTail");
  const requestedTurnId = String(turnId ?? "").trim();
  if (!requestedTurnId) throw new Error("Codex turn id is required");
  const handle = await openImpl(transcriptPath, "r");
  try {
    const info = await handle.stat();
    const requestedChunkBytes = Math.max(1, Number(chunkBytes) || DEFAULT_TURN_START_SEARCH_BYTES);
    let cursor = info.size;
    let rightPartial = Buffer.alloc(0);

    while (cursor > 0) {
      const start = Math.max(0, cursor - requestedChunkBytes);
      const buffer = Buffer.allocUnsafe(cursor - start);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const current = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          start + bytesRead,
        );
        if (!current.bytesRead) break;
        bytesRead += current.bytesRead;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const combined = rightPartial.length ? Buffer.concat([chunk, rightPartial]) : chunk;
      const firstNewline = combined.indexOf(0x0a);
      const completeStart = start > 0 ? firstNewline + 1 : 0;

      if (start === 0 || firstNewline >= 0) {
        let lineEnd = combined.length;
        while (lineEnd > completeStart) {
          const newline = combined.lastIndexOf(0x0a, lineEnd - 1);
          const lineStart = Math.max(completeStart, newline + 1);
          const line = combined.subarray(lineStart, lineEnd).toString("utf8").replace(/\r$/u, "");
          if (line) {
            try {
              const entry = JSON.parse(line);
              if (entry?.type === "event_msg"
                && entry.payload?.type === "task_started"
                && String(entry.payload?.turn_id ?? "").trim() === requestedTurnId) {
                return start + lineStart;
              }
            } catch {
              // Continue toward the beginning; only complete JSONL records are candidates.
            }
          }
          if (newline < completeStart) break;
          lineEnd = newline;
        }
      }

      rightPartial = start > 0 && firstNewline >= 0
        ? combined.subarray(0, firstNewline)
        : combined;
      cursor = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

export function codexRecentTerminalTurnsFromJsonl(text) {
  const values = new Map();
  for (const { value: entry } of parsedEntries(text)) {
    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const status = lifecycleTerminalStatus(lifecycle, entry.payload);
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
  assertCodexRolloutReadAllowed("readCodexRecentTerminalTurns");
  return codexRecentTerminalTurnsFromJsonl(
    await readTailImpl(transcriptPath, { maxBytes }),
  );
}

async function scanJsonlChunks(input, acceptEntry, byteLimit = Number.POSITIVE_INFINITY, { signal } = {}) {
  let pendingParts = [];
  let pendingLength = 0;
  let bytesRead = 0;

  const acceptLine = (parts, length) => {
    if (!length) return;
    const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    const line = buffer.toString("utf8").replace(/\r$/u, "");
    if (!line) return;
    try {
      acceptEntry(JSON.parse(line));
    } catch {
      // Ignore one malformed complete line without losing later JSONL records.
    }
  };

  for await (const chunk of input) {
    if (signal) await setImmediate(undefined, { signal });
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    let start = 0;
    let newline = buffer.indexOf(0x0a, start);
    while (newline >= 0) {
      const part = buffer.subarray(start, newline);
      if (pendingLength) {
        pendingParts.push(part);
        pendingLength += part.length;
        acceptLine(pendingParts, pendingLength);
        pendingParts = [];
        pendingLength = 0;
      } else {
        acceptLine([part], part.length);
      }
      start = newline + 1;
      newline = buffer.indexOf(0x0a, start);
    }
    if (start < buffer.length) {
      const part = buffer.subarray(start);
      pendingParts.push(part);
      pendingLength += part.length;
    }
    if (bytesRead - pendingLength >= byteLimit) break;
  }

  return {
    bytesRead,
    pending: pendingParts.length === 1
      ? pendingParts[0]
      : Buffer.concat(pendingParts, pendingLength),
  };
}

export async function scanCodexTerminalEventsFromOffset(transcriptPath, {
  startOffset = 0,
  maxBytes = Number.POSITIVE_INFINITY,
  rolloutId = "",
  initialActiveTurns = [],
  createReadStreamImpl = createReadStream,
} = {}) {
  assertCodexRolloutReadAllowed("scanCodexTerminalEventsFromOffset");
  const terminals = new Map();
  const activeTurns = new Map((initialActiveTurns ?? []).flatMap((turn) => {
    const turnId = String(turn?.turnId ?? "").trim();
    return turnId ? [[turnId, {
      turnId,
      startedAt: String(turn?.startedAt ?? ""),
      lastActivityAt: String(turn?.lastActivityAt ?? turn?.startedAt ?? ""),
      ...(turn?.prompt ? { prompt: turn.prompt } : {}),
      ...(turn?.clientUserMessageId ? { clientUserMessageId: turn.clientUserMessageId } : {}),
    }]] : [];
  }));
  const start = Math.max(0, Number(startOffset) || 0);
  const input = createReadStreamImpl(transcriptPath, { start });
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
    if (active) {
      active.lastActivityAt = timestamp;
      acceptUserOperationIdentity(active, entry);
    }
    const status = lifecycleTerminalStatus(lifecycle, entry.payload);
    if (!status) return;
    activeTurns.delete(turnId);
    terminals.set(turnId, {
      turnId,
      status,
      completedAt: String(entry?.timestamp ?? ""),
    });
  }

  const { bytesRead, pending } = await scanJsonlChunks(input, acceptEntry, byteLimit);

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
  assertCodexRolloutReadAllowed("scanCodexTurnJsonl");
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
    responseAnnotationReferences: [],
    startedAt: "",
    completedAt: "",
    lastActivityAt: "",
    prompt: "",
    prompts: [],
    changedFiles: new Set(),
    patches: [],
    skillsUsed: new Set(),
    mcpCalls: new Map(),
    spawnedSubagents: new Map(),
    imageGenerationCalls: new Set(),
    generatedImageSources: new Set(),
    estimatedCredits: 0,
    estimateKind: "",
    model: "",
    serviceTier: "default",
    status: "",
    contextCompacted: false,
    hasOwnTurnContent: false,
    limitSamples: [],
  };
}

function restoreHistoricalTurn(value) {
  const turnId = String(value?.turnId ?? "").trim();
  if (!turnId) return null;
  return {
    ...createHistoricalTurn(turnId),
    ...value,
    turnId,
    usage: {
      ...emptyTokenUsage(),
      ...(value?.usage ?? {}),
    },
    prompts: Array.isArray(value?.prompts) ? [...value.prompts] : [],
    changedFiles: new Set(value?.changedFiles ?? []),
    patches: Array.isArray(value?.patches) ? [...value.patches] : [],
    skillsUsed: new Set(value?.skillsUsed ?? []),
    mcpCalls: new Map((value?.mcpCalls ?? []).flatMap((call) => (
      call?.id ? [[String(call.id), call]] : []
    ))),
    spawnedSubagents: new Map((value?.spawnedSubagents ?? []).flatMap((spawned) => (
      spawned?.threadId ? [[String(spawned.threadId), spawned]] : []
    ))),
    imageGenerationCalls: new Set(value?.imageGenerationCalls ?? []),
    generatedImageSources: new Set((value?.generatedImageSources ?? []).flatMap((source) => {
      const candidate = typeof source === "string"
        ? source
        : source?.type === "generated-path" ? source.value : "";
      const normalized = String(candidate ?? "").trim();
      return normalized ? [normalized] : [];
    })),
    limitSamples: mergeUsageLimitSamples(value?.limitSamples),
  };
}

function historicalTurnResult(turn, latestModel, latestServiceTier) {
  const imageGenerationCount = turn.imageGenerationCalls.size;
  const compactionOnly = turn.contextCompacted
    && !turn.hasOwnTurnContent
    && !turn.prompt
    && !turn.finalAnswer
    && !turn.changedFiles.size
    && !turn.patches.length
    && !turn.mcpCalls.size
    && !turn.spawnedSubagents.size
    && !turn.imageGenerationCalls.size
    && !turn.generatedImageSources.size;
  return {
    ...turn,
    changedFiles: [...turn.changedFiles],
    diff: turn.patches.join("\n\n"),
    skillsUsed: [...turn.skillsUsed],
    mcpCalls: [...turn.mcpCalls.values()],
    spawnedSubagents: [...turn.spawnedSubagents.values()],
    imageGenerationCalls: [...turn.imageGenerationCalls],
    generatedImageSources: [...turn.generatedImageSources].map((value) => ({
      type: "generated-path",
      value,
    })),
    toolMetricsKnown: true,
    imageGenerationCount,
    estimatedCredits: imageGenerationCount * IMAGE_GENERATION_ESTIMATE_CREDITS,
    estimateKind: imageGenerationCount > 0 ? "imagegen-default" : "",
    model: turn.model || latestModel,
    serviceTier: turn.serviceTier || latestServiceTier,
    compactionOnly,
    serviceUsageKind: compactionOnly ? "context-compaction"
      : isCodexContextProbeClientId(turn.clientUserMessageId)
        ? "context-probe" : "",
  };
}

/**
 * Streams a rollout or one bounded byte range and returns its native turns.
 * resumeState carries unfinished turns across byte checkpoints; the caller
 * still decides whether a turn is inherited parent history because that needs
 * the session/thread relationship.
 */
export async function scanCodexHistoricalRollout(transcriptPath, {
  startOffset = 0,
  maxBytes = Number.POSITIVE_INFINITY,
  resumeState = null,
  createReadStreamImpl = createReadStream,
} = {}) {
  assertCodexRolloutReadAllowed("scanCodexHistoricalRollout");
  const restoredTurns = (resumeState?.turns ?? [])
    .map(restoreHistoricalTurn)
    .filter(Boolean);
  const turns = new Map(restoredTurns.map((turn) => [turn.turnId, turn]));
  const activeTurnIds = new Set(resumeState?.activeTurnIds ?? restoredTurns.map((turn) => turn.turnId));
  const imageGenerationCalls = restoredImageGenerationCallOwners(
    resumeState?.imageGenerationCalls,
  );
  const observedGeneratedImages = new Map();
  const knownSkills = new Set(resumeState?.knownSkills ?? []);
  let latestResponseTurnId = String(resumeState?.latestResponseTurnId ?? "").trim();
  let latestStartedTurnId = String(resumeState?.latestStartedTurnId ?? "").trim();
  let latestModel = String(resumeState?.latestModel ?? "").trim();
  let latestServiceTier = String(resumeState?.latestServiceTier ?? "default").trim() || "default";
  let workspaceRoot = String(resumeState?.workspaceRoot ?? "").trim();
  let session = resumeState?.session ?? null;

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
      latestStartedTurnId = lifecycleTurnId;
      turn.started = true;
      turn.startedAt ||= timestamp;
      touch(turn, timestamp);
    } else if (lifecycleTerminalStatus(lifecycle, entry.payload) && lifecycleTurnId) {
      const turn = ensureTurn(lifecycleTurnId);
      activeTurnIds.delete(lifecycleTurnId);
      turn.terminal = true;
      turn.completedAt = timestamp || turn.completedAt;
      turn.status = lifecycleTerminalStatus(lifecycle, entry.payload);
      touch(turn, timestamp);
    }
    if (lifecycle === "patch_apply_end" && lifecycleTurnId) {
      const turn = ensureTurn(lifecycleTurnId);
      for (const file of Object.keys(entry.payload?.changes ?? {})) {
        if (String(file).trim()) turn.changedFiles.add(String(file).trim());
      }
      touch(turn, timestamp);
    }

    // A manual `thread/compact/start` creates a synthetic task_started entry
    // in some App Server versions, followed only by this compaction marker.
    // It has no user input and is not an agent turn, even though the
    // replacement history contains messages from earlier real turns.
    if (entry?.type === "compacted" && latestStartedTurnId) {
      const turn = ensureTurn(latestStartedTurnId);
      if (turn) {
        turn.contextCompacted = true;
        touch(turn, timestamp);
      }
      return;
    }

    const exactTurnId = entryTurnId(entry);
    const exactTurn = ensureTurn(exactTurnId);
    acceptUserOperationIdentity(exactTurn, entry);
    const exactUsage = exactTurnTokenUsage(entry);
    if (exactUsage && exactTurn) {
      exactTurn.usage = preserveRequestPricingUsage(exactUsage, exactTurn.usage);
      exactTurn.exactUsageReported = true;
      exactTurn.reported = true;
      latestResponseTurnId = exactTurnId;
      touch(exactTurn, timestamp);
    }
    if (exactTurnId && ["response_item", "turn_context"].includes(String(entry?.type ?? ""))) {
      latestResponseTurnId = exactTurnId;
      exactTurn.started = true;
      if (entry.type === "response_item") exactTurn.hasOwnTurnContent = true;
      touch(exactTurn, timestamp);
    }
    if (entry?.type === "turn_context" && exactTurn) {
      exactTurn.model = String(entry.payload?.model ?? latestModel).trim();
      exactTurn.serviceTier = String(
        entry.payload?.service_tier ?? latestServiceTier,
      ).trim() || "default";
    }
    const imageCallId = imageGenerationCallId(entry);
    if (imageCallId && exactTurnId) {
      rememberImageGenerationCallOwner(imageGenerationCalls, imageCallId, exactTurnId);
    }
    const completedImageId = completedImageGenerationId(entry);
    if (completedImageId) {
      const callId = String(entry.payload?.call_id ?? "").trim();
      const attributedTurnId = exactTurnId
        || imageGenerationCallOwnerTurnId(imageGenerationCalls, callId);
      const turn = turns.get(attributedTurnId) ?? (exactTurnId ? ensureTurn(exactTurnId) : null);
      if (turn) turn.imageGenerationCalls.add(completedImageId);
      touch(turn, timestamp);
    }
    const generatedPaths = generatedImageOutputPaths(entry);
    if (generatedPaths.length) {
      const callId = String(entry.payload?.call_id ?? "").trim();
      const ownerTurnId = exactTurnId
        || imageGenerationCallOwnerTurnId(imageGenerationCalls, callId)
        || "";
      const ownerTurn = turns.get(ownerTurnId) ?? (exactTurnId ? ensureTurn(exactTurnId) : null);
      if (ownerTurnId) {
        const observed = observedGeneratedImages.get(ownerTurnId) ?? new Set();
        for (const generatedPath of generatedPaths) {
          ownerTurn?.generatedImageSources.add(generatedPath);
          observed.add(generatedPath);
        }
        observedGeneratedImages.set(ownerTurnId, observed);
        touch(ownerTurn, timestamp);
        consumeImageGenerationCallOwner(imageGenerationCalls, callId, ownerTurnId);
      }
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
      if (candidate) {
        exactTurn.prompt ||= candidate;
        exactTurn.prompts.push(candidate);
      }
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
      const projection = codexAssistantResponseProjection(messageText(entry.payload));
      exactTurn.finalAnswer = projection.text.trim() || exactTurn.finalAnswer;
      if (projection.responseAnnotationReferences.length) {
        exactTurn.responseAnnotationReferences = projection.responseAnnotationReferences;
      }
    }

    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") return;
    const attributedTurnId = latestResponseTurnId
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    const attributedTurn = ensureTurn(attributedTurnId);
    if (attributedTurn) {
      const requestUsage = normalizedRolloutUsage(entry.payload?.info?.last_token_usage, {
        request: true,
      });
      if (!attributedTurn.exactUsageReported) {
        attributedTurn.usage = addTokenUsage(
          attributedTurn.usage,
          requestUsage,
        );
      } else {
        attributedTurn.usage = addRequestPricingUsage(attributedTurn.usage, requestUsage);
      }
      attributedTurn.limitSamples = mergeUsageLimitSamples(
        attributedTurn.limitSamples,
        codexLimitSamplesFromTokenEvent(entry),
      );
      attributedTurn.reported = true;
      touch(attributedTurn, timestamp);
    }
    latestResponseTurnId = "";
  };

  const start = Math.max(0, Number(startOffset) || 0);
  const byteLimit = Number.isFinite(Number(maxBytes))
    ? Math.max(1, Number(maxBytes))
    : Number.POSITIVE_INFINITY;
  const input = createReadStreamImpl(transcriptPath, { start });
  const { bytesRead, pending } = await scanJsonlChunks(input, accept, byteLimit);
  let nextOffset = start + bytesRead - pending.length;
  if (pending.length) {
    try {
      accept(JSON.parse(pending.toString("utf8").replace(/\r$/u, "")));
      nextOffset = start + bytesRead;
    } catch {
      // Preserve an incomplete final JSONL record for the next bounded scan.
    }
  }

  const turnResults = [...turns.values()].map((turn) => (
    historicalTurnResult(turn, latestModel, latestServiceTier)
  ));
  const activeResults = turnResults.filter((turn) => turn.terminal !== true);

  return {
    session: session ?? {
      threadId: "",
      parentThreadId: "",
      workspaceRoot,
      createdAt: "",
      source: "",
    },
    turns: turnResults,
    attachmentCandidates: [...observedGeneratedImages].map(([turnId, paths]) => ({
      turnId,
      generatedImageSources: [...paths].map((value) => ({ type: "generated-path", value })),
    })),
    nextOffset,
    resumeState: {
      turns: activeResults,
      activeTurnIds: [...activeTurnIds],
      imageGenerationCalls: [...imageGenerationCalls.entries()],
      knownSkills: [...knownSkills],
      latestResponseTurnId,
      latestStartedTurnId,
      latestModel,
      latestServiceTier,
      workspaceRoot,
      session,
    },
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
    else if (lifecycleTerminalStatus(lifecycle, entry.payload) && lifecycleTurnId) activeTurnIds.delete(lifecycleTurnId);
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
  assertCodexRolloutReadAllowed("readCodexSubagentSpawn");
  return codexSubagentSpawnFromJsonl(
    await readTailImpl(transcriptPath, { maxBytes }),
    childThreadId,
  );
}

export async function scanCodexTurnPricingMetadata(transcriptPath, turnIds, {
  createReadStreamImpl = createReadStream,
  signal,
} = {}) {
  assertCodexRolloutReadAllowed("scanCodexTurnPricingMetadata");
  const requested = new Set(
    [...(turnIds ?? [])].map((value) => String(value ?? "").trim()).filter(Boolean),
  );
  const result = new Map();
  if (!requested.size) return result;
  let latestModel = "";
  let latestServiceTier = "default";
  signal?.throwIfAborted();
  const input = createReadStreamImpl(transcriptPath, { encoding: "utf8", signal });
  let processedLines = 0;
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (++processedLines % 256 === 0) await setImmediate(undefined, { signal });
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
  sessionCache = readSession === readCodexRolloutSession ? rolloutSessionCache : null,
  sessionCacheLimit = DEFAULT_ROLLOUT_SESSION_CACHE_LIMIT,
} = {}) {
  assertCodexRolloutReadAllowed("discoverCodexRollouts");
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
  const seenKeys = new Set();
  for (const file of files) {
    const key = rolloutSessionCacheKey(file);
    seenKeys.add(key);
    const cached = sessionCache?.get(key);
    const session = cached ?? await readSession(file);
    if (!cached && session?.threadId && sessionCache) {
      sessionCache.set(key, session);
      trimRolloutSessionCache(sessionCache, sessionCacheLimit);
    }
    if (session?.threadId) result.push(session);
  }
  if (sessionCache) pruneRolloutSessionCache(sessionCache, codexHome, seenKeys);
  return result;
}

export async function discoverCodexSubagentRollouts(options = {}) {
  assertCodexRolloutReadAllowed("discoverCodexSubagentRollouts");
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
  assertCodexRolloutReadAllowed("findCodexRolloutPath");
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
  { createReadStreamImpl = createReadStream, signal } = {},
) {
  const input = createReadStreamImpl(transcriptPath, { start, signal });
  const { bytesRead, pending } = await scanJsonlChunks(input, (entry) => {
    accumulator.accept(entry);
  }, Number.POSITIVE_INFINITY, { signal });
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
  findTurnStartImpl = findCodexTurnStartOffsetFromTail,
  attempts = 5,
  retryDelayMs = 40,
  signal,
} = {}) {
  assertCodexRolloutReadAllowed("scanCodexTurnJsonlIncrementally");
  signal?.throwIfAborted();
  const accumulator = createTurnAccumulator(turnId);
  let position;
  try {
    position = await findTurnStartImpl(transcriptPath, turnId);
  } catch {
    position = 0;
  }
  let result = null;
  let error = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    signal?.throwIfAborted();
    try {
      position = await scanCodexTurnJsonlFromOffset(
        transcriptPath,
        accumulator,
        position,
        { createReadStreamImpl, signal },
      );
      result = accumulator.result();
      if (result.reported && result.finalTokenSeen && result.terminal) return result;
    } catch (currentError) {
      signal?.throwIfAborted();
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
  signal,
} = {}) {
  assertCodexRolloutReadAllowed("readCodexTurnUsage");
  if (!readFileImpl && !readTailImpl && !scanImpl) {
    return scanIncrementalImpl(transcriptPath, turnId, { attempts, retryDelayMs, ...(signal ? { signal } : {}) });
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
