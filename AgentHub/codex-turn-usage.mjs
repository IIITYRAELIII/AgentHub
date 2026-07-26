import { open } from "node:fs/promises";

import { addTokenUsage, emptyTokenUsage, normalizeTokenUsage } from "./token-usage.mjs";

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

export function codexTurnUsageFromJsonl(text, turnId) {
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

  for (const { index, value: entry } of parsedEntries(text)) {
    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const lifecycleTurnId = lifecycle ? String(entry.payload?.turn_id ?? "").trim() : "";
    if (lifecycle === "task_started" && lifecycleTurnId) {
      activeTurnIds.add(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) {
        started = true;
        startedAt ||= String(entry?.timestamp ?? "");
      }
    } else if (["task_complete", "turn_aborted"].includes(lifecycle) && lifecycleTurnId) {
      activeTurnIds.delete(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) {
        terminal = true;
        completedAt ||= String(entry?.timestamp ?? "");
      }
    }

    const exactTurnId = entryTurnId(entry);
    if (exactTurnId && ["response_item", "turn_context"].includes(String(entry?.type ?? ""))) {
      latestResponseTurnId = exactTurnId;
      if (exactTurnId === requestedTurnId) started = true;
    }
    if (isFinalAssistantItem(entry, requestedTurnId)) finalAnswerIndex = index;

    if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
    const attributedTurnId = latestResponseTurnId
      || (activeTurnIds.size === 1 ? [...activeTurnIds][0] : "");
    if (attributedTurnId === requestedTurnId) {
      usage = addTokenUsage(usage, normalizedRolloutUsage(entry.payload?.info?.last_token_usage));
      reported = true;
      finalTokenIndex = index;
    }
    latestResponseTurnId = "";
  }

  return {
    turnId: requestedTurnId,
    usage,
    reported,
    started,
    terminal,
    finalAnswerSeen: finalAnswerIndex >= 0,
    finalTokenSeen: finalAnswerIndex < 0 ? reported : finalTokenIndex > finalAnswerIndex,
    startedAt,
    completedAt,
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_ROLLOUT_TAIL_BYTES = 64 * 1024 * 1024;

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

export async function readCodexTurnUsage(transcriptPath, turnId, {
  readFileImpl = null,
  readTailImpl = readCodexRolloutTail,
  attempts = 5,
  retryDelayMs = 40,
} = {}) {
  let result = null;
  let error = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      const text = readFileImpl
        ? await readFileImpl(transcriptPath, "utf8")
        : await readTailImpl(transcriptPath);
      result = codexTurnUsageFromJsonl(text, turnId);
      if (result.reported && result.finalTokenSeen) return result;
    } catch (currentError) {
      error = currentError;
    }
    if (attempt + 1 < attempts) await delay(retryDelayMs);
  }
  if (result?.reported) return result;
  if (error) throw error;
  throw new Error(`Token usage was not found for Codex turn ${turnId}`);
}
