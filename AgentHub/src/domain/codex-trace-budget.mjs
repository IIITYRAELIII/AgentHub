import { createHash } from "node:crypto";

// Derived activity is a recent UI preview. The provider transcript and
// canonical user/assistant messages remain the source of truth.
export const CODEX_TRACE_GROUP_LIMIT = 256;
export const CODEX_TRACE_ACTIVITIES_PER_GROUP_LIMIT = 128;
export const CODEX_TRACE_ACTIVITIES_PER_TURN_LIMIT = 1_024;
export const CODEX_TRACE_REASONING_TOTAL_CHARS = 1_000_000;

export function boundedTraceId(value) {
  const id = String(value ?? "").trim();
  return id.length <= 200 ? id : `${id.slice(0, 160)}:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}
