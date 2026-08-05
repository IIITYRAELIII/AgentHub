import { createReadStream } from "node:fs";
import path from "node:path";
import { open, stat } from "node:fs/promises";
import { displayUserPrompt } from "../../application/task-history.mjs";
import { TASK_EXECUTION_OWNERS } from "../../domain/task-execution-owner.mjs";

const CODEX_ACTIVE_FRESHNESS_MS = 10 * 60 * 1000;
const CODEX_ROLLOUT_TAIL_BYTES = 64 * 1024 * 1024;
const CODEX_ROLLOUT_LINE_BYTES = 4 * 1024 * 1024;
const LEGACY_TURN_ID = "__legacy__";
const codexActivityCache = new Map();

async function rolloutSuffix(filePath, size, maximumBytes = 256) {
  const length = Math.min(Math.max(0, Number(size) || 0), maximumBytes);
  if (!length) return "";
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("base64");
  } finally {
    await handle.close();
  }
}

function applyCodexLifecycleEntry(activeTurnIds, entry) {
  if (entry?.type !== "event_msg") return;
  const event = entry.payload?.type;
  if (!["task_started", "task_complete", "turn_aborted"].includes(event)) return;
  const turnId = String(entry.payload?.turn_id ?? "").trim() || LEGACY_TURN_ID;
  if (event === "task_started") {
    activeTurnIds.add(turnId);
  } else {
    activeTurnIds.delete(turnId);
  }
}

function codexEntryTurnId(entry) {
  return String(
    entry?.payload?.turn_id
      ?? entry?.payload?.internal_chat_message_metadata_passthrough?.turn_id
      ?? "",
  ).trim();
}

function codexResponseItemMessage(entry, role) {
  if (entry?.type !== "response_item"
    || entry.payload?.type !== "message"
    || entry.payload?.role !== role) return "";
  return (entry.payload?.content ?? [])
    .filter((item) => ["input_text", "output_text", "text"].includes(item?.type))
    .map((item) => String(item?.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function rememberCodexTurnMessage(metadata, turnId, message) {
  const value = String(message ?? "").trim();
  if (!turnId || !value) return;
  const previous = String(metadata.latestMessages.get(turnId) ?? "").trim();
  const combined = !previous
    ? value
    : previous === value || previous.endsWith(`\n\n${value}`)
      ? previous
      : `${previous}\n\n${value}`;
  metadata.latestMessages.set(turnId, combined.slice(-40_000));
  while (metadata.latestMessages.size > 8) {
    metadata.latestMessages.delete(metadata.latestMessages.keys().next().value);
  }
}

function rememberCodexUserMessage(metadata, turnId, {
  clientUserMessageId = "",
  text = "",
} = {}) {
  const value = displayUserPrompt(text);
  if (!turnId || !value) return;
  const clientId = String(clientUserMessageId ?? "").trim();
  const messages = metadata.userMessages.get(turnId) ?? [];
  if (clientId && messages.some((item) => item.clientUserMessageId === clientId)) return;
  messages.push({
    itemId: clientId || `${turnId}:rollout-user:${messages.length}`,
    ...(clientId ? { clientUserMessageId: clientId } : {}),
    role: "user",
    text: value,
  });
  metadata.userMessages.set(turnId, messages.slice(-20));
  while (metadata.userMessages.size > 8) {
    metadata.userMessages.delete(metadata.userMessages.keys().next().value);
  }
}

function decodedJsonString(value) {
  try {
    return JSON.parse(`"${String(value ?? "")}"`);
  } catch {
    return "";
  }
}

function viewImagePaths(entry) {
  const payload = entry?.payload ?? {};
  if (
    entry?.type !== "response_item"
    || !["custom_tool_call", "customToolCall"].includes(String(payload.type ?? ""))
    || String(payload.name ?? "") !== "exec"
  ) return [];
  const input = String(payload.input ?? "");
  const paths = [];
  const pattern = /tools\.view_image\s*\(\s*\{[\s\S]{0,2000}?\bpath\s*:\s*("(?:\\.|[^"\\])*")/gu;
  for (const match of input.matchAll(pattern)) {
    try {
      const value = String(JSON.parse(match[1]) ?? "").trim();
      if (value) paths.push(value);
    } catch {
      // Tool input is data, not executable JavaScript.
    }
  }
  return [...new Set(paths)];
}

function responseItemImageCount(entry) {
  const payload = entry?.payload ?? {};
  if (entry?.type !== "response_item" || ![
    "custom_tool_call_output",
    "customToolCallOutput",
    "function_call_output",
    "functionCallOutput",
  ].includes(String(payload.type ?? ""))) return 0;
  const blocks = Array.isArray(payload.output)
    ? payload.output
    : Array.isArray(payload.content)
      ? payload.content
      : [];
  return blocks.filter((block) => (
    ["image", "input_image", "output_image"].includes(String(block?.type ?? ""))
      && String(block?.image_url ?? block?.url ?? "").startsWith("data:image/")
  )).length;
}

function generatedImagePaths(entry) {
  const payload = entry?.payload ?? {};
  if (entry?.type === "event_msg" && payload.type === "image_generation_end") {
    const value = String(payload.saved_path ?? "").trim();
    return value ? [value] : [];
  }
  if (entry?.type !== "response_item" || ![
    "function_call_output",
    "functionCallOutput",
  ].includes(String(payload.type ?? ""))) return [];
  const blocks = Array.isArray(payload.output)
    ? payload.output
    : Array.isArray(payload.content)
      ? payload.content
      : [];
  const text = blocks
    .filter((block) => ["input_text", "output_text", "text"].includes(String(block?.type ?? "")))
    .map((block) => String(block?.text ?? ""))
    .join("\n");
  const paths = [];
  const pattern = /Generated images are saved to[\s\S]*?\sas\s+((?:[A-Za-z]:)?(?:\\|\/)[^"\r\n]+?\.(?:png|jpe?g|webp|gif|bmp))/giu;
  for (const match of text.matchAll(pattern)) {
    const value = String(match[1] ?? "").replace(/\\\\/gu, "\\").trim();
    if (value) paths.push(value);
  }
  return [...new Set(paths)];
}

function rememberCodexImagePaths(metadata, turnId, paths, type = "generated-path") {
  if (!turnId || !paths.length) return;
  const current = metadata.generatedImageSources.get(turnId) ?? [];
  const known = new Set(current.map((item) => `${item.type}:${item.value}`));
  for (const value of paths) {
    const key = `${type}:${value}`;
    if (!known.has(key)) {
      current.push({ type, value });
      known.add(key);
    }
  }
  metadata.generatedImageSources.set(turnId, current.slice(-8));
  while (metadata.generatedImageSources.size > 8) {
    metadata.generatedImageSources.delete(metadata.generatedImageSources.keys().next().value);
  }
}

function rememberCodexGeneratedImages(metadata, turnId, entry) {
  rememberCodexImagePaths(metadata, turnId, generatedImagePaths(entry));
}

function rememberPendingViewImageCall(metadata, turnId, entry) {
  const callId = String(entry?.payload?.call_id ?? "").trim();
  const paths = viewImagePaths(entry);
  if (!callId || !turnId || !paths.length) return;
  metadata.pendingViewImageCalls.set(callId, { turnId, paths });
  while (metadata.pendingViewImageCalls.size > 32) {
    metadata.pendingViewImageCalls.delete(metadata.pendingViewImageCalls.keys().next().value);
  }
}

function completePendingViewImageCall(metadata, turnId, entry) {
  if (entry?.type !== "response_item" || ![
    "custom_tool_call_output",
    "customToolCallOutput",
    "function_call_output",
    "functionCallOutput",
  ].includes(String(entry?.payload?.type ?? ""))) return;
  const callId = String(entry?.payload?.call_id ?? "").trim();
  if (!callId) return;
  const pending = metadata.pendingViewImageCalls.get(callId);
  if (!pending) return;
  if (responseItemImageCount(entry) > 0) {
    rememberCodexImagePaths(metadata, turnId || pending.turnId, pending.paths, "view-path");
  }
  metadata.pendingViewImageCalls.delete(callId);
}

function observeOversizedCodexLine(metadata, activeTurnIds, { head = "", tail = "" } = {}) {
  const sample = `${head}\n${tail}`;
  if (/"type"\s*:\s*"image_generation_end"/u.test(sample)) {
    const pathMatch = /"saved_path"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(sample);
    const savedPath = decodedJsonString(pathMatch?.[1]);
    const turnMatch = /"turn_id"\s*:\s*"([^"\\]+)"/u.exec(sample);
    const turnId = String(turnMatch?.[1] ?? "").trim()
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    if (savedPath) rememberCodexImagePaths(metadata, turnId, [savedPath]);
  }
  if (
    /"type"\s*:\s*"(?:custom_tool_call_output|customToolCallOutput|function_call_output|functionCallOutput)"/u.test(sample)
    && /"type"\s*:\s*"(?:input_image|output_image|image)"/u.test(sample)
  ) {
    const callId = decodedJsonString(/"call_id"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(sample)?.[1]);
    const pending = metadata.pendingViewImageCalls.get(callId);
    if (pending) {
      const turnId = decodedJsonString(/"turn_id"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(sample)?.[1])
        || pending.turnId;
      rememberCodexImagePaths(metadata, turnId, pending.paths, "view-path");
      metadata.pendingViewImageCalls.delete(callId);
    }
  }
}

function rememberPendingCodexUserMessage(metadata, entry, provisionalTurnId = "") {
  const text = String(entry?.payload?.message ?? "");
  const value = displayUserPrompt(text);
  if (!value) return;
  const clientUserMessageId = String(entry?.payload?.client_id ?? "").trim();
  metadata.pendingUserMessages.push({
    clientUserMessageId,
    text,
    provisionalTurnId,
  });
  metadata.pendingUserMessages = metadata.pendingUserMessages.slice(-20);
}

function assignPendingCodexUserMessages(metadata, turnId) {
  if (!turnId || !metadata.pendingUserMessages.length) return;
  for (const message of metadata.pendingUserMessages) {
    const previousTurnId = String(message.provisionalTurnId ?? "");
    if (previousTurnId && previousTurnId !== turnId) {
      const previousMessages = (metadata.userMessages.get(previousTurnId) ?? [])
        .filter((item) => (
          !message.clientUserMessageId
          || item.clientUserMessageId !== message.clientUserMessageId
        ));
      if (previousMessages.length) metadata.userMessages.set(previousTurnId, previousMessages);
      else metadata.userMessages.delete(previousTurnId);
      if (!previousMessages.some((item) => item.clientUserMessageId)) {
        metadata.vscodeTurnIds.delete(previousTurnId);
      }
    }
    rememberCodexUserMessage(metadata, turnId, message);
    if (message.clientUserMessageId) metadata.vscodeTurnIds.add(turnId);
  }
  metadata.pendingUserMessages = [];
}

function observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, entry) {
  if (entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied") {
    metadata.model = String(entry.payload?.thread_settings?.model ?? "").trim();
    metadata.reasoningEffort = String(
      entry.payload?.thread_settings?.reasoning_effort ?? "",
    ).trim();
  }
  const lifecycle = entry?.type === "event_msg"
    && ["task_started", "task_complete", "turn_aborted"].includes(entry.payload?.type);
  const turnId = codexEntryTurnId(entry) || (lifecycle ? LEGACY_TURN_ID : "");
  const isUserMessage = entry?.type === "event_msg" && entry.payload?.type === "user_message";
  if (
    metadata.pendingUserMessages.length
    && isUserMessage
    && activeTurnIds.size === 1
    && metadata.pendingUserMessages.every((message) => message.provisionalTurnId)
  ) {
    // A second VSC submission cannot retroactively turn an earlier steer into
    // the prompt of a future concurrent turn. Finalize the earlier provisional
    // assignment and keep only the newest submission eligible for reassignment.
    assignPendingCodexUserMessages(metadata, [...activeTurnIds][0]);
  }
  if (metadata.pendingUserMessages.length && !isUserMessage) {
    const pendingTurnId = turnId
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    if (pendingTurnId) assignPendingCodexUserMessages(metadata, pendingTurnId);
  }
  if ((entry?.type === "turn_context" || entry?.type === "response_item" || lifecycle) && turnId) {
    metadata.latestTurnId = turnId;
  }
  const responseItemMessage = codexResponseItemMessage(entry, "assistant");
  if (turnId && responseItemMessage) {
    // response_item duplicates the neighbouring unscoped agent_message, but it
    // carries the real turn_id. It is therefore the authoritative source when
    // VS Code has concurrent turns in one thread.
    rememberCodexTurnMessage(metadata, turnId, responseItemMessage);
  }
  const generatedImageTurnId = turnId
    || (entry?.type === "event_msg" && entry.payload?.type === "image_generation_end"
      && activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
  if (generatedImageTurnId) rememberCodexGeneratedImages(metadata, generatedImageTurnId, entry);
  if (turnId) rememberPendingViewImageCall(metadata, turnId, entry);
  completePendingViewImageCall(metadata, turnId, entry);
  const responseItemUserContent = entry?.type === "response_item"
    && entry.payload?.type === "message"
    && entry.payload?.role === "user"
    ? entry.payload?.content ?? []
    : [];
  const responseItemHasImage = responseItemUserContent.some((item) => (
    ["image", "input_image", "localImage"].includes(item?.type)
  ));
  if (turnId && responseItemHasImage && !codexResponseItemMessage(entry, "user")) {
    rememberCodexUserMessage(metadata, turnId, { text: "Изображение" });
  }
  if (entry?.type === "event_msg" && entry.payload?.type === "agent_message") {
    const messageTurnId = turnId || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    const message = String(entry.payload?.message ?? "").trim();
    if (messageTurnId && message) {
      rememberCodexTurnMessage(metadata, messageTurnId, message);
    } else if (message) {
      metadata.unscopedLatestMessage = message.slice(-40_000);
    }
  }
  if (entry?.type === "event_msg" && entry.payload?.type === "task_complete" && turnId) {
    const message = String(entry.payload?.last_agent_message ?? "").trim();
    if (message) {
      metadata.finalMessages.set(turnId, message.slice(-40_000));
      while (metadata.finalMessages.size > 8) {
        metadata.finalMessages.delete(metadata.finalMessages.keys().next().value);
      }
    }
  }
  if (isUserMessage) {
    const messageTurnId = turnId;
    if (messageTurnId) {
      const clientId = String(entry.payload?.client_id ?? "").trim();
      rememberCodexUserMessage(metadata, messageTurnId, {
        clientUserMessageId: clientId,
        text: entry.payload?.message,
      });
      if (clientId) metadata.vscodeTurnIds.add(messageTurnId);
      else metadata.vscodeTurnIds.delete(messageTurnId);
    } else {
      // Codex writes the initial VSC user_message immediately before
      // task_started and does not include turn_id in that event. Keep it
      // pending until the next event identifies whether this is a new
      // concurrent turn or steering for the sole active turn.
      const provisionalTurnId = activeTurnIds.size === 1 ? [...activeTurnIds][0] : "";
      if (provisionalTurnId) {
        const clientId = String(entry.payload?.client_id ?? "").trim();
        rememberCodexUserMessage(metadata, provisionalTurnId, {
          clientUserMessageId: clientId,
          text: entry.payload?.message,
        });
        if (clientId) metadata.vscodeTurnIds.add(provisionalTurnId);
      }
      rememberPendingCodexUserMessage(metadata, entry, provisionalTurnId);
    }
  }
  const timestamp = Date.parse(entry?.timestamp);
  if (
    entry?.type === "event_msg"
    && entry.payload?.type === "task_started"
    && turnId
    && turnId !== LEGACY_TURN_ID
    && Number.isFinite(timestamp)
  ) {
    metadata.startedAtMsByTurnId.set(turnId, timestamp);
  }
  if (turnId && Number.isFinite(timestamp)) lastSeenAtByTurnId.set(turnId, timestamp);
  applyCodexLifecycleEntry(activeTurnIds, entry);
}

function codexActivity(
  activeTurnIds,
  lastSeenAtByTurnId = new Map(),
  {
    nowMs = null,
    freshnessMs = null,
    vscodeTurnIds = new Set(),
    startedAtMsByTurnId = new Map(),
  } = {},
) {
  const useFreshness = Number.isFinite(nowMs) && Number.isFinite(freshnessMs);
  const activeIds = [...activeTurnIds].filter((turnId) => {
    if (!useFreshness) return true;
    const lastSeenAt = lastSeenAtByTurnId.get(turnId);
    if (turnId === LEGACY_TURN_ID && !Number.isFinite(lastSeenAt)) return true;
    return Number.isFinite(lastSeenAt) && nowMs - lastSeenAt <= freshnessMs;
  }).sort((left, right) => (
    Number(lastSeenAtByTurnId.get(left) ?? 0) - Number(lastSeenAtByTurnId.get(right) ?? 0)
  ));
  return {
    running: activeIds.length > 0,
    activeTurnIds: activeIds.filter((turnId) => turnId !== LEGACY_TURN_ID),
    activeVscodeTurnIds: activeIds.filter((turnId) => vscodeTurnIds.has(turnId)),
    activityAtMsByTurnId: Object.fromEntries(activeIds
      .filter((turnId) => turnId !== LEGACY_TURN_ID && Number.isFinite(lastSeenAtByTurnId.get(turnId)))
      .map((turnId) => [turnId, lastSeenAtByTurnId.get(turnId)])),
    startedAtMsByTurnId: Object.fromEntries(activeIds
      .filter((turnId) => turnId !== LEGACY_TURN_ID && Number.isFinite(startedAtMsByTurnId.get(turnId)))
      .map((turnId) => [turnId, startedAtMsByTurnId.get(turnId)])),
  };
}

export function parseCodexRolloutActivity(text, options = {}) {
  const activeTurnIds = new Set();
  const lastSeenAtByTurnId = new Map();
  const metadata = {
    latestTurnId: "",
    vscodeTurnIds: new Set(),
    model: "",
    reasoningEffort: "",
    latestMessages: new Map(),
    finalMessages: new Map(),
    userMessages: new Map(),
    generatedImageSources: new Map(),
    pendingViewImageCalls: new Map(),
    pendingUserMessages: [],
    unscopedLatestMessage: "",
    startedAtMsByTurnId: new Map(),
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    try {
      observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, JSON.parse(line));
    } catch {
      // Ignore incomplete or unrelated JSONL lines.
    }
  }
  return {
    ...codexActivity(activeTurnIds, lastSeenAtByTurnId, {
      ...options,
      vscodeTurnIds: metadata.vscodeTurnIds,
      startedAtMsByTurnId: metadata.startedAtMsByTurnId,
    }),
    model: metadata.model || null,
    reasoningEffort: metadata.reasoningEffort || null,
    latestTurnId: metadata.latestTurnId || null,
    latestMessages: Object.fromEntries(metadata.latestMessages),
    finalMessages: Object.fromEntries(metadata.finalMessages),
    userMessages: Object.fromEntries(metadata.userMessages),
    ...(metadata.generatedImageSources.size
      ? { generatedImageSources: Object.fromEntries(metadata.generatedImageSources) }
      : {}),
    unscopedLatestMessage: metadata.unscopedLatestMessage || null,
  };
}

export function parseCodexRolloutRunning(text) {
  return parseCodexRolloutActivity(text).running;
}

export async function readCodexRolloutActivity(
  rolloutPath,
  {
    nowMs = Date.now(),
    freshnessMs = CODEX_ACTIVE_FRESHNESS_MS,
    tailBytes = CODEX_ROLLOUT_TAIL_BYTES,
    maximumLineBytes = CODEX_ROLLOUT_LINE_BYTES,
  } = {},
) {
  const normalized = String(rolloutPath ?? "").trim();
  if (!normalized) {
    return {
      running: false,
      activeTurnIds: [],
      activeVscodeTurnIds: [],
      activityAtMsByTurnId: {},
      startedAtMsByTurnId: {},
      lastActivityAtMs: null,
      model: null,
      reasoningEffort: null,
      latestTurnId: null,
      latestMessages: {},
      finalMessages: {},
      userMessages: {},
      generatedImageSources: {},
      unscopedLatestMessage: null,
    };
  }
  let info;
  try {
    info = await stat(normalized);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        running: false,
        activeTurnIds: [],
        activeVscodeTurnIds: [],
        activityAtMsByTurnId: {},
        startedAtMsByTurnId: {},
        lastActivityAtMs: null,
        model: null,
        reasoningEffort: null,
        latestTurnId: null,
        latestMessages: {},
        finalMessages: {},
        userMessages: {},
        generatedImageSources: {},
        unscopedLatestMessage: null,
      };
    }
    throw error;
  }
  if (nowMs - info.mtimeMs > freshnessMs) {
    const cached = codexActivityCache.get(normalized);
    return {
      running: false,
      activeTurnIds: [],
      activeVscodeTurnIds: [],
      activityAtMsByTurnId: {},
      startedAtMsByTurnId: {},
      lastActivityAtMs: info.mtimeMs,
      model: cached?.model || null,
      reasoningEffort: cached?.reasoningEffort || null,
      latestTurnId: cached?.latestTurnId || null,
      latestMessages: Object.fromEntries(cached?.latestMessages ?? []),
      finalMessages: Object.fromEntries(cached?.finalMessages ?? []),
      userMessages: Object.fromEntries(cached?.userMessages ?? []),
      generatedImageSources: Object.fromEntries(cached?.generatedImageSources ?? []),
      unscopedLatestMessage: cached?.unscopedLatestMessage || null,
    };
  }
  const cached = codexActivityCache.get(normalized);
  if (cached?.size === info.size && cached?.mtimeMs === info.mtimeMs) {
    return {
      ...codexActivity(
        new Set(cached.activeTurnIds),
        new Map(cached.lastSeenAtByTurnId),
        {
          nowMs,
          freshnessMs,
          vscodeTurnIds: new Set(cached.vscodeTurnIds ?? []),
          startedAtMsByTurnId: new Map(cached.startedAtMsByTurnId ?? []),
        },
      ),
      lastActivityAtMs: info.mtimeMs,
      model: cached.model || null,
      reasoningEffort: cached.reasoningEffort || null,
      latestTurnId: cached.latestTurnId || null,
      latestMessages: Object.fromEntries(cached.latestMessages ?? []),
      finalMessages: Object.fromEntries(cached.finalMessages ?? []),
      userMessages: Object.fromEntries(cached.userMessages ?? []),
      generatedImageSources: Object.fromEntries(cached.generatedImageSources ?? []),
      unscopedLatestMessage: cached.unscopedLatestMessage || null,
    };
  }

  const appendOnly = Boolean(
    cached
      && info.size > cached.size
      && cached.suffix === await rolloutSuffix(normalized, cached.size),
  );
  const activeTurnIds = new Set(appendOnly ? cached.activeTurnIds : []);
  const lastSeenAtByTurnId = new Map(appendOnly ? cached.lastSeenAtByTurnId : []);
  const metadata = {
    latestTurnId: appendOnly ? String(cached.latestTurnId ?? "") : "",
    vscodeTurnIds: new Set(appendOnly ? cached.vscodeTurnIds ?? [] : []),
    model: appendOnly ? String(cached.model ?? "") : "",
    reasoningEffort: appendOnly ? String(cached.reasoningEffort ?? "") : "",
    latestMessages: new Map(appendOnly ? cached.latestMessages ?? [] : []),
    finalMessages: new Map(appendOnly ? cached.finalMessages ?? [] : []),
    userMessages: new Map(appendOnly ? cached.userMessages ?? [] : []),
    generatedImageSources: new Map(appendOnly ? cached.generatedImageSources ?? [] : []),
    pendingViewImageCalls: new Map(appendOnly ? cached.pendingViewImageCalls ?? [] : []),
    pendingUserMessages: appendOnly
      ? (cached.pendingUserMessages ?? []).map((message) => ({ ...message }))
      : [],
    unscopedLatestMessage: appendOnly ? String(cached.unscopedLatestMessage ?? "") : "",
    startedAtMsByTurnId: new Map(appendOnly ? cached.startedAtMsByTurnId ?? [] : []),
  };
  const start = appendOnly
    ? cached.size
    : Math.max(0, info.size - Math.max(1, Number(tailBytes) || CODEX_ROLLOUT_TAIL_BYTES));
  const input = createReadStream(normalized, {
    encoding: "utf8",
    ...(start > 0 ? { start } : {}),
    end: Math.max(0, info.size - 1),
  });
  let text = appendOnly ? String(cached.trailingText ?? "") : "";
  let oversizedLine = null;
  const oversizedSampleLimit = 128 * 1024;
  const appendOversizedTail = (value) => {
    if (!oversizedLine) return;
    oversizedLine.tail = `${oversizedLine.tail}${value}`.slice(-oversizedSampleLimit);
  };
  let discardUntilNewline = appendOnly
    ? cached.discardUntilNewline === true
    : start > 0;
  const observeLine = (line) => {
    if (!line) return;
    try {
      observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, JSON.parse(line));
    } catch {
      // Ignore an unrelated complete JSONL line.
    }
  };
  try {
    for await (const chunk of input) {
      text += chunk;
      let newline;
      while ((newline = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, newline).replace(/\r$/, "");
        text = text.slice(newline + 1);
        if (discardUntilNewline) {
          appendOversizedTail(line);
          observeOversizedCodexLine(metadata, activeTurnIds, oversizedLine ?? {});
          oversizedLine = null;
          discardUntilNewline = false;
          continue;
        }
        observeLine(line);
      }
      if (Buffer.byteLength(text, "utf8") > maximumLineBytes) {
        if (!oversizedLine) {
          oversizedLine = {
            head: text.slice(0, oversizedSampleLimit),
            tail: "",
          };
        }
        appendOversizedTail(text);
        text = "";
        discardUntilNewline = true;
      }
    }
  } finally {
    input.destroy();
  }
  if (discardUntilNewline && oversizedLine?.tail.trimEnd().endsWith("}")) {
    observeOversizedCodexLine(metadata, activeTurnIds, oversizedLine);
    oversizedLine = null;
    discardUntilNewline = false;
  }
  let trailingText = discardUntilNewline ? "" : text;
  if (trailingText) {
    try {
      observeCodexEntry(activeTurnIds, lastSeenAtByTurnId, metadata, JSON.parse(trailingText));
      trailingText = "";
    } catch {
      // Preserve a line caught in the middle of an append for the next read.
    }
  }
  const activity = codexActivity(activeTurnIds, lastSeenAtByTurnId, {
    nowMs,
    freshnessMs,
    vscodeTurnIds: metadata.vscodeTurnIds,
    startedAtMsByTurnId: metadata.startedAtMsByTurnId,
  });
  codexActivityCache.set(normalized, {
    size: info.size,
    mtimeMs: info.mtimeMs,
    activeTurnIds: [...activeTurnIds],
    lastSeenAtByTurnId: [...lastSeenAtByTurnId],
    startedAtMsByTurnId: [...metadata.startedAtMsByTurnId],
    trailingText,
    latestTurnId: metadata.latestTurnId,
    vscodeTurnIds: [...metadata.vscodeTurnIds],
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    latestMessages: [...metadata.latestMessages],
    finalMessages: [...metadata.finalMessages],
    userMessages: [...metadata.userMessages],
    generatedImageSources: [...metadata.generatedImageSources],
    pendingViewImageCalls: [...metadata.pendingViewImageCalls],
    pendingUserMessages: metadata.pendingUserMessages.map((message) => ({ ...message })),
    unscopedLatestMessage: metadata.unscopedLatestMessage,
    discardUntilNewline,
    suffix: await rolloutSuffix(normalized, info.size),
  });
  if (codexActivityCache.size > 200) codexActivityCache.delete(codexActivityCache.keys().next().value);
  return {
    ...activity,
    lastActivityAtMs: info.mtimeMs,
    model: metadata.model || null,
    reasoningEffort: metadata.reasoningEffort || null,
    latestTurnId: metadata.latestTurnId || null,
    latestMessages: Object.fromEntries(metadata.latestMessages),
    finalMessages: Object.fromEntries(metadata.finalMessages),
    userMessages: Object.fromEntries(metadata.userMessages),
    generatedImageSources: Object.fromEntries(metadata.generatedImageSources),
    unscopedLatestMessage: metadata.unscopedLatestMessage || null,
  };
}

export async function readCodexRolloutRunning(rolloutPath, options = {}) {
  return (await readCodexRolloutActivity(rolloutPath, options)).running;
}

export function codexThreadRunning(thread, { rolloutRunning = false } = {}) {
  return Boolean(rolloutRunning)
    || (thread?.turns ?? []).some((turn) => turn?.status === "inProgress");
}

export function catalogEntriesWithoutLiveActivity(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    running: false,
    activityUnknown: entry?.running === true,
    executionOwner: null,
    turnId: null,
    startedAt: null,
  }));
}

export function codexObservedExecutionOwner(activity = {}, turnId = null) {
  const vscodeTurnIds = new Set(activity.activeVscodeTurnIds ?? []);
  if (turnId) {
    return vscodeTurnIds.has(String(turnId))
      ? TASK_EXECUTION_OWNERS.VSCODE
      : TASK_EXECUTION_OWNERS.EXTERNAL;
  }
  return vscodeTurnIds.size > 0
    ? TASK_EXECUTION_OWNERS.VSCODE
    : TASK_EXECUTION_OWNERS.EXTERNAL;
}

export function selectCodexTurn(
  turns,
  { requestedTurnId = null, rolloutActiveTurnIds = [], strictRequested = false } = {},
) {
  const values = Array.isArray(turns) ? turns : [];
  const requested = values.find((turn) => turn?.id === requestedTurnId);
  if (strictRequested && requested) return requested;
  if (requested?.status === "inProgress") return requested;
  const rolloutIds = new Set(rolloutActiveTurnIds);
  return values.findLast((turn) => (
    turn?.status === "inProgress" && rolloutIds.has(turn.id)
  )) ?? values.findLast((turn) => turn?.status === "inProgress")
    ?? requested
    ?? values.at(-1)
    ?? null;
}

export function codexRolloutTurnState(
  activity = {},
  requestedTurnId = null,
  { exact = false, threadActive = false } = {},
) {
  const requested = String(requestedTurnId ?? "").trim();
  const activeTurnIds = [...new Set(
    (activity.activeTurnIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean),
  )];
  const requestedActive = Boolean(requested) && activeTurnIds.includes(requested);
  const activeTurnId = requestedActive
    ? requested
    : exact ? null : activeTurnIds.at(-1) ?? null;
  const turnId = exact && requested
    ? requested
    : activeTurnId || requested || String(activity.latestTurnId ?? "").trim() || null;
  const active = exact
    ? requestedActive
    : Boolean(activeTurnId) || Boolean(threadActive);
  const latestAnswer = turnId
    ? String(activity.latestMessages?.[turnId] ?? "").trim()
    : String(activity.unscopedLatestMessage ?? "").trim();
  const finalAnswer = turnId
    ? String(activity.finalMessages?.[turnId] ?? "").trim()
    : "";
  const userMessages = turnId && Array.isArray(activity.userMessages?.[turnId])
    ? activity.userMessages[turnId].map((message) => ({ ...message }))
    : [];
  const startedAtMs = Number(activity.startedAtMsByTurnId?.[turnId]);
  return {
    turnId,
    active,
    completed: !active,
    latestAnswer,
    finalAnswer,
    userMessages,
    startedAt: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : null,
  };
}

export function selectExactActiveCodexTurnId(activity = {}) {
  const vscodeTurnIds = [...new Set(
    (activity.activeVscodeTurnIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean),
  )];
  if (vscodeTurnIds.length === 1) return vscodeTurnIds[0];
  if (vscodeTurnIds.length > 1) {
    throw new Error("Cannot bind the notification: several VS Code turns are active in this task");
  }
  const activeTurnIds = [...new Set(
    (activity.activeTurnIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean),
  )];
  if (activeTurnIds.length === 1) return activeTurnIds[0];
  if (activeTurnIds.length > 1) {
    throw new Error("Cannot bind the notification: several Codex turns are active in this task");
  }
  return null;
}

export function codexCatalogEntry(thread, project, {
  rolloutRunning = false,
  executionOwner = null,
  model = null,
  lastActivityAtMs = null,
  startedAtMs = null,
} = {}) {
  const title = String(thread?.name ?? thread?.preview ?? "Без названия")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return {
    provider: "codex",
    threadId: String(thread.id),
    projectRoot: project.path,
    projectName: project.name,
    title: title || "Без названия",
    model,
    updatedAtMs: Number(thread.updatedAt ?? 0) * 1000,
    running: codexThreadRunning(thread, { rolloutRunning }),
    executionOwner,
    lastActivityAtMs,
    startedAt: startedAtMs !== null
      && startedAtMs !== ""
      && Number.isFinite(Number(startedAtMs))
      ? new Date(Number(startedAtMs)).toISOString()
      : null,
  };
}
