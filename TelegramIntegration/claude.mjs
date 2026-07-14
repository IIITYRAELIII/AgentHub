import path from "node:path";
import { formatTaskTokenUsage } from "./token-usage.mjs";

export const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
]);

// Бюджет «расширенного мышления» Claude Code для каждого уровня «силы дум».
// Значение передаётся процессу через переменную окружения MAX_THINKING_TOKENS
// и одновременно включает вывод блоков рассуждения в потоке.
export const CLAUDE_THINKING_TOKENS = {
  low: 2000,
  medium: 4000,
  high: 8000,
  xhigh: 16000,
  max: 24000,
  ultra: 32000,
};

export function claudeThinkingTokens(level) {
  return CLAUDE_THINKING_TOKENS[level] ?? CLAUDE_THINKING_TOKENS.high;
}

export function buildClaudePrompt(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) throw new Error("Claude input must be text or an array of content items");

  return input.map((item) => {
    if (item?.type === "text") return String(item.text ?? "");
    if (item?.type === "localImage" && item.path) {
      return `Проанализируй также изображение по абсолютному пути: ${path.resolve(item.path)}`;
    }
    throw new Error(`Claude does not support input item type: ${item?.type ?? "unknown"}`);
  }).filter(Boolean).join("\n\n");
}

export function buildClaudeArgs({
  prompt,
  sessionId,
  model,
  permissionMode = "acceptEdits",
  autoApprove = false,
  additionalDirectories = [],
}) {
  if (!autoApprove && !CLAUDE_PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`Unsupported Claude permission mode: ${permissionMode}`);
  }

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (autoApprove) args.push("--permission-mode", "bypassPermissions");
  else args.push("--permission-mode", permissionMode);
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  for (const directory of new Set(additionalDirectories.filter(Boolean).map((item) => path.resolve(item)))) {
    args.push("--add-dir", directory);
  }
  args.push(prompt);
  return args;
}

export function parseClaudeStreamEvent(line) {
  const text = String(line ?? "").trim();
  if (!text) return null;

  let event;
  try {
    event = JSON.parse(text);
  } catch {
    return null;
  }

  const streamDelta = event?.type === "stream_event" && event.event?.type === "content_block_delta"
    ? event.event.delta
    : null;
  const textDelta = streamDelta?.type === "text_delta" ? String(streamDelta.text ?? "") : "";
  // Claude Code в headless-режиме отдаёт thinking-блоки без текста рассуждений
  // (только сигнатуру и оценку числа токенов). Текст (thinking) обычно пустой,
  // поэтому для индикатора прогресса ориентируемся на estimated_tokens.
  const thinkingDelta = streamDelta?.type === "thinking_delta" ? String(streamDelta.thinking ?? "") : "";
  const thinkingTokens = streamDelta?.type === "thinking_delta" && Number.isFinite(Number(streamDelta.estimated_tokens))
    ? Number(streamDelta.estimated_tokens)
    : null;
  return {
    event,
    sessionId: typeof event.session_id === "string" ? event.session_id : null,
    textDelta,
    thinkingDelta,
    thinkingTokens,
    result: event?.type === "result" ? event : null,
  };
}

export function parseClaudeLimits(text) {
  const limits = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^Current (session|week \(all models\)|week \((.+)\)):\s+([\d.]+)% used(?:\s+·\s+resets (.+))?$/i);
    if (!match) continue;
    limits.push({
      kind: match[1].toLowerCase(),
      model: match[2] || null,
      usedPercent: Number(match[3]),
      resetsText: match[4] || null,
    });
  }
  return limits;
}

export function parseClaudeResult(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("Claude Code returned an empty response");

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const candidate = JSON.parse(lines[index]);
        if (candidate?.type === "result" || candidate?.result != null) {
          result = candidate;
          break;
        }
      } catch {
        // Ignore diagnostics printed before the JSON result.
      }
    }
  }
  if (!result || typeof result !== "object") {
    throw new Error(`Cannot parse Claude Code response: ${text.slice(0, 300)}`);
  }
  return result;
}

export function formatClaudeUsage(result, estimatedReasoning = 0) {
  const usage = result?.usage ?? {};
  const uncachedInput = Number(usage.input_tokens ?? 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
  const cached = Number(usage.cache_read_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  // Claude не отдаёт thinking-токены отдельным полем usage (они внутри output_tokens),
  // поэтому при отсутствии точного значения используем оценку из потока (estimated_tokens).
  const reportedReasoning = Number(
    usage.reasoning_output_tokens ?? usage.thinking_tokens ?? usage.reasoning_tokens ?? 0,
  );
  const reasoning = reportedReasoning > 0 ? reportedReasoning : Math.max(0, Number(estimatedReasoning) || 0);
  return formatTaskTokenUsage({
    totalTokens: uncachedInput + cacheCreation + cached + output,
    inputTokens: uncachedInput,
    cachedInputTokens: cacheCreation + cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  });
}
