import { isClaudeSyntheticUserEntry } from "../../domain/claude-transcript.mjs";

function contentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function isUserPrompt(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return false;
  if (isClaudeSyntheticUserEntry(entry)) return false;
  return contentBlocks(entry.message).some((block) => (
    block?.type === "text" && String(block.text ?? "").trim()
  ));
}

export function compactClaudeHistoryEntry(entry) {
  if (isUserPrompt(entry)) {
    return {
      type: "user",
      uuid: entry.uuid,
      timestamp: entry.timestamp,
      message: {
        role: "user",
        content: contentBlocks(entry.message)
          .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
          .map((block) => ({ type: "text", text: String(block.text) })),
      },
    };
  }
  if (entry?.type === "assistant" && entry.message?.role === "assistant") {
    const content = contentBlocks(entry.message).flatMap((block) => {
      if (block?.type === "text" && String(block.text ?? "").trim()) {
        return [{ type: "text", text: String(block.text) }];
      }
      if (block?.type === "tool_use") {
        return [{
          type: "tool_use",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
        }];
      }
      return [];
    });
    if (!content.length && entry.message.stop_reason !== "end_turn") return null;
    return {
      type: "assistant",
      uuid: entry.uuid,
      timestamp: entry.timestamp,
      message: {
        role: "assistant",
        stop_reason: entry.message.stop_reason ?? null,
        content,
      },
    };
  }
  if (entry?.type === "last-prompt") {
    return { type: "last-prompt", timestamp: entry.timestamp };
  }
  return null;
}

export function compactClaudeHistoryLine(value) {
  try {
    const entry = compactClaudeHistoryEntry(JSON.parse(String(value)));
    return {
      valid: true,
      compactLine: entry ? JSON.stringify(entry) : null,
    };
  } catch {
    return { valid: false, compactLine: null };
  }
}

export function compactClaudeHistoryBuffer(buffer, { startOffset = 0 } = {}) {
  const compactLines = [];
  let lineStart = 0;
  let parsedBytes = startOffset;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0A) continue;
    const result = compactClaudeHistoryLine(buffer.subarray(lineStart, index).toString("utf8"));
    if (result.compactLine) compactLines.push(result.compactLine);
    parsedBytes = startOffset + index + 1;
    lineStart = index + 1;
  }
  if (lineStart < buffer.length) {
    const result = compactClaudeHistoryLine(buffer.subarray(lineStart).toString("utf8"));
    if (result.valid) {
      if (result.compactLine) compactLines.push(result.compactLine);
      parsedBytes = startOffset + buffer.length;
    }
  }
  return { compactLines, parsedBytes };
}
