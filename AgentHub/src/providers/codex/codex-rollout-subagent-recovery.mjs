import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { codexSubagentNotificationDetails } from "../../application/task-history.mjs";
import {
  rolloutObservationGeneration,
  rolloutRecordFingerprint,
  rolloutSourceByteOccurrenceId,
} from "./codex-rollout-activity.mjs";
import { findCodexTurnStartOffsetFromTail } from "./codex-turn-usage.mjs";

const MAX_LINE_BYTES = 4 * 1024 * 1024;

export async function recoverCodexRolloutSubagentsOnCurrentThread(rolloutPath, candidates) {
  if (!Array.isArray(candidates) || candidates.length > 1000) throw new Error("Invalid recovery candidates");
  const wanted = new Set(candidates.map((item) => item.sourceOccurrenceId));
  if (!wanted.size) return [];
  const turnIds = [...new Set(candidates.map((item) => item.turnId))];
  if (turnIds.length > 20 || turnIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("Invalid recovery turns");
  }
  if ([...wanted].some((id) => !/^codex-rollout:[0-9a-f]{64}$/u.test(id))) {
    throw new Error("Invalid recovery occurrence");
  }
  const info = await stat(rolloutPath);
  const generation = await rolloutObservationGeneration(rolloutPath, info);
  if (!generation) return [];
  const starts = [];
  for (const turnId of turnIds) {
    const offset = await findCodexTurnStartOffsetFromTail(rolloutPath, turnId);
    if (Number.isSafeInteger(offset) && offset >= 0) starts.push(offset);
  }
  if (!starts.length) return [];
  const start = Math.min(...starts);
  const stream = createReadStream(rolloutPath, { start, end: info.size - 1, highWaterMark: 64 * 1024 });
  const recovered = [];
  let offset = start;
  let pending = Buffer.alloc(0);
  let oversized = false;
  let currentTurnId = "";
  try {
    for await (const chunk of stream) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        const end = newline < 0 ? chunk.length : newline;
        const fragment = chunk.subarray(cursor, end);
        if (!oversized && pending.length + fragment.length <= MAX_LINE_BYTES) {
          pending = pending.length ? Buffer.concat([pending, fragment]) : Buffer.from(fragment);
        } else {
          oversized = true;
          pending = Buffer.alloc(0);
        }
        if (newline >= 0) {
          if (!oversized) {
            let entry;
            try { entry = JSON.parse(pending.toString("utf8")); } catch {}
            if (entry?.type === "event_msg" && entry.payload?.type === "task_started") {
              currentTurnId = String(entry.payload.turn_id ?? "");
            }
            if (entry?.type === "response_item" && entry.payload?.type === "message"
              && entry.payload.role === "user") {
              const sourceOccurrenceId = rolloutSourceByteOccurrenceId(
                generation, rolloutRecordFingerprint(entry), offset - pending.length + fragment.length,
              );
              if (wanted.has(sourceOccurrenceId)) {
                const text = (Array.isArray(entry.payload.content) ? entry.payload.content : [])
                  .filter((part) => part.type === "input_text" || part.type === "text")
                  .map((part) => String(part.text ?? "")).join("\n");
                const notification = codexSubagentNotificationDetails(text);
                const metadata = entry.payload.internal_chat_message_metadata_passthrough;
                const clientId = entry.payload.client_id || metadata?.client_id;
                const turnId = String(metadata?.turn_id ?? currentTurnId);
                if (notification?.agentThreadId && !clientId
                  && candidates.some((item) => item.turnId === turnId && item.sourceOccurrenceId === sourceOccurrenceId)) {
                  recovered.push({
                    ...notification, sourceOccurrenceId, role: "agent",
                    ...(entry.timestamp ? { time: entry.timestamp } : {}),
                  });
                }
                wanted.delete(sourceOccurrenceId);
              }
            }
          }
          pending = Buffer.alloc(0);
          oversized = false;
        }
        offset += end - cursor + (newline < 0 ? 0 : 1);
        cursor = newline < 0 ? chunk.length : newline + 1;
        if (!wanted.size) break;
      }
      if (!wanted.size) break;
    }
  } finally {
    stream.destroy();
  }
  const after = await stat(rolloutPath);
  if (after.size < info.size || generation !== await rolloutObservationGeneration(rolloutPath, after)) return [];
  return recovered;
}
