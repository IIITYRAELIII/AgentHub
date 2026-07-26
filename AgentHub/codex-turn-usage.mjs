import { readFile } from "node:fs/promises";

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

  for (const { index, value: entry } of parsedEntries(text)) {
    const lifecycle = entry?.type === "event_msg" ? String(entry.payload?.type ?? "") : "";
    const lifecycleTurnId = lifecycle ? String(entry.payload?.turn_id ?? "").trim() : "";
    if (lifecycle === "task_started" && lifecycleTurnId) {
      activeTurnIds.add(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) started = true;
    } else if (["task_complete", "turn_aborted"].includes(lifecycle) && lifecycleTurnId) {
      activeTurnIds.delete(lifecycleTurnId);
      if (lifecycleTurnId === requestedTurnId) terminal = true;
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
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readCodexTurnUsage(transcriptPath, turnId, {
  readFileImpl = readFile,
  attempts = 5,
  retryDelayMs = 40,
} = {}) {
  let result = null;
  let error = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      result = codexTurnUsageFromJsonl(await readFileImpl(transcriptPath, "utf8"), turnId);
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
