import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "./token-usage.mjs";
import { displayUserPrompt } from "./task-history.mjs";

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
  let startedAt = "";
  let completedAt = "";
  let prompt = "";
  let status = "";
  let index = -1;
  const changedFiles = new Set();

  const accept = (entry) => {
    index += 1;
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
    if (entry?.type === "response_item"
      && exactTurnId === requestedTurnId
      && entry.payload?.type === "message"
      && entry.payload?.role === "user") {
      const candidate = displayUserPrompt(messageText(entry.payload));
      if (candidate) prompt = candidate;
    }
    if (isFinalAssistantItem(entry, requestedTurnId)) finalAnswerIndex = index;

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

  const result = () => ({
    turnId: requestedTurnId,
    usage,
    reported,
    started,
    terminal,
    finalAnswerSeen: finalAnswerIndex >= 0,
    finalTokenSeen: finalAnswerIndex < 0 ? reported : finalTokenIndex > finalAnswerIndex,
    startedAt,
    completedAt,
    prompt,
    changedFiles: [...changedFiles],
    status: status || (terminal ? "completed" : started ? "inProgress" : ""),
  });

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
