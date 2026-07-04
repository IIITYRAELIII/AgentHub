import path from "node:path";

export const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
]);

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

  const args = ["--print", "--output-format", "json"];
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

export function formatClaudeUsage(result) {
  const usage = result?.usage ?? {};
  const uncachedInput = Number(usage.input_tokens ?? 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
  const cached = Number(usage.cache_read_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const input = uncachedInput + cacheCreation + cached;
  const total = input + output;
  const number = (value) => value.toLocaleString("ru-RU");
  const lines = [`📊 Токены за задачу: ${number(total)}`, `Вход: ${number(input)}`];
  if (cached) lines.push(`Из кэша: ${number(cached)}`);
  if (cacheCreation) lines.push(`Записано в кэш: ${number(cacheCreation)}`);
  lines.push(`Выход: ${number(output)}`);
  if (Number.isFinite(Number(result?.total_cost_usd))) {
    lines.push(`Стоимость API: $${Number(result.total_cost_usd).toFixed(4)}`);
  }
  return lines.join("\n");
}
