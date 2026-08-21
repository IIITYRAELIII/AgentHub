import path from "node:path";
import { CLAUDE_PERMISSION_MODES } from "../../domain/agent-runtime-settings.mjs";
import { creditsFromUsd, formatCredits } from "../../domain/token-usage.mjs";

export { CLAUDE_PERMISSION_MODES } from "../../domain/agent-runtime-settings.mjs";

export function buildClaudePrompt(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) throw new Error("Claude input must be text or an array of content items");

  return input.map((item) => {
    if (item?.type === "text") return String(item.text ?? "");
    if (item?.type === "localImage" && item.path) {
      return `Проанализируй также изображение по абсолютному пути: ${path.resolve(item.path)}`;
    }
    if (item?.type === "localFile" && item.path) {
      return `Приложенный файл доступен по абсолютному пути: ${path.resolve(item.path)}`;
    }
    throw new Error(`Claude does not support input item type: ${item?.type ?? "unknown"}`);
  }).filter(Boolean).join("\n\n");
}

export function buildClaudeArgs({
  prompt,
  sessionId,
  resumeSession = true,
  model,
  effort,
  permissionMode = "acceptEdits",
  autoApprove = false,
  additionalDirectories = [],
  mcpConfig = null,
  appendSystemPrompt = null,
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
  const directories = [...new Set(
    additionalDirectories.filter(Boolean).map((item) => path.resolve(item)),
  )];
  if (directories.length) args.push("--add-dir", ...directories);
  if (String(mcpConfig ?? "").trim()) args.push("--mcp-config", String(mcpConfig));
  if (String(appendSystemPrompt ?? "").trim()) {
    args.push("--append-system-prompt", String(appendSystemPrompt));
  }
  if (autoApprove) args.push("--permission-mode", "bypassPermissions");
  else args.push("--permission-mode", permissionMode);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (sessionId) {
    args.push(resumeSession ? "--resume" : "--session-id", sessionId);
  }
  args.push(prompt);
  return args;
}

export function resolveClaudeSessionCwd(projectRoot, sessionCwd = null) {
  const rootText = String(projectRoot ?? "").trim();
  if (!rootText) throw new Error("Claude project root is required");
  const root = path.resolve(rootText);
  const candidateText = String(sessionCwd ?? "").trim();
  const candidate = candidateText ? path.resolve(candidateText) : root;
  const relative = path.relative(root, candidate);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`Claude session directory is outside the allowed project: ${candidate}`);
  }
  return candidate;
}

export function claudeFailureMessage(result, {
  streamFailureText = "",
  errorText = "",
  exitCode = null,
} = {}) {
  const resultError = typeof result?.error === "string"
    ? result.error
    : result?.error?.message;
  const candidates = [
    result?.result,
    streamFailureText,
    resultError,
    result?.message,
    errorText,
  ];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }
  const subtype = String(result?.subtype ?? "").trim();
  if (subtype && subtype !== "success") {
    return `Claude Code завершился с ошибкой ${subtype}.`;
  }
  if (Number.isInteger(exitCode) && exitCode !== 0) {
    return `Claude Code завершился с кодом ${exitCode}.`;
  }
  return "Claude Code завершил поток с ошибкой.";
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

export function claudeModelContextWindow(model) {
  const normalized = String(model ?? "").trim().toLowerCase();
  if (!normalized) return 0;
  if (
    /^claude-(?:fable|mythos|opus|sonnet)-5(?:-|$)/u.test(normalized)
    || /^claude-opus-4-(?:6|7|8)(?:-|$)/u.test(normalized)
    || /^claude-sonnet-4-6(?:-|$)/u.test(normalized)
  ) return 1_000_000;
  if (/^claude-/u.test(normalized)) return 200_000;
  return 0;
}

function nonNegativeTokens(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function claudeStreamContextUsage(event, { fallbackModel = "" } = {}) {
  const streamEvent = event?.type === "stream_event" ? event.event : null;
  const message = streamEvent?.type === "message_start"
    ? streamEvent.message
    : event?.type === "assistant"
      ? event.message
      : null;
  const usage = message?.usage
    ?? (streamEvent?.type === "message_delta" ? streamEvent.usage : null);
  if (!usage || typeof usage !== "object") return null;
  const model = String(message?.model ?? fallbackModel ?? "").trim();
  const modelContextWindow = claudeModelContextWindow(model);
  if (!modelContextWindow) return null;
  return {
    model,
    modelContextWindow,
    usedTokens: nonNegativeTokens(usage.input_tokens)
      + nonNegativeTokens(usage.cache_creation_input_tokens)
      + nonNegativeTokens(usage.cache_read_input_tokens)
      + nonNegativeTokens(usage.output_tokens),
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

function nonNegativeCost(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export function claudeEstimatedCostUsd(result) {
  const total = nonNegativeCost(result?.total_cost_usd ?? result?.totalCostUsd);
  if (total !== null) return total;

  const modelUsage = result?.modelUsage ?? result?.model_usage;
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return null;
  let found = false;
  let sum = 0;
  for (const usage of Object.values(modelUsage)) {
    const cost = nonNegativeCost(usage?.costUSD ?? usage?.cost_usd);
    if (cost === null) continue;
    found = true;
    sum += cost;
  }
  return found ? sum : null;
}

export function formatClaudeUsage(result) {
  const credits = creditsFromUsd(claudeEstimatedCostUsd(result));
  return credits === null
    ? "📊 Кредиты за поток: нет данных."
    : `📊 За поток: ${formatCredits(credits)}`;
}
