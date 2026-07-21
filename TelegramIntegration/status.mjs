import { parseClaudeLimits } from "./claude.mjs";

function escapeTelegramHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatResetRemaining(resetsAtSeconds, nowMs = Date.now()) {
  const resetsAtMs = Number(resetsAtSeconds) * 1000;
  if (!Number.isFinite(resetsAtMs)) return "";
  const diffMs = resetsAtMs - nowMs;
  if (diffMs <= 0) return "сейчас";

  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} дн.`);
  if (hours) parts.push(`${hours} ч.`);
  if (!days && minutes) parts.push(`${minutes} мин.`);
  return parts.join(" ") || "меньше минуты";
}

function formatWindow(window, nowMs) {
  const used = Number(window?.usedPercent ?? 0);
  const remaining = Math.max(0, 100 - used);
  const reset = window?.resetsAt ? formatResetRemaining(window.resetsAt, nowMs) : "неизвестно";
  return `${remaining.toFixed(1)}% - ${reset}`;
}

function codexLimitName(bucket) {
  const name = bucket.limitName || bucket.limitId || "CODEX";
  const id = String(bucket.limitId ?? name).toLowerCase();
  if (id === "codex") return "CODEX";
  if (id === "spark" || String(name).toLowerCase().includes("spark")) return "Spark";
  return name;
}

export function formatCodexRateLimits(result, nowMs = Date.now()) {
  const buckets = result.rateLimitsByLimitId
    ? Object.values(result.rateLimitsByLimitId)
    : result.rateLimits
      ? [result.rateLimits]
      : [];
  if (!buckets.length) return "Codex не вернул сведения о лимитах.";

  buckets.sort((left, right) => (left.limitId === "codex" ? -1 : right.limitId === "codex" ? 1 : 0));
  const lines = [];
  for (const bucket of buckets) {
    const window = bucket.secondary ?? bucket.primary;
    if (window) lines.push(`${codexLimitName(bucket)} - ${formatWindow(window, nowMs)}`);
    else lines.push(codexLimitName(bucket));
    if (bucket.rateLimitReachedType) lines.push(`Ограничение достигнуто: ${bucket.rateLimitReachedType}`);
  }
  const resetCredits = result.rateLimitResetCredits?.availableCount;
  if (resetCredits != null) lines.push(`Доступно сбросов: ${resetCredits}`);
  return lines.join("\n");
}

export function parseClaudeResetTime(value, nowMs = Date.now()) {
  const match = String(value ?? "").match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2})(am|pm)/);
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
  if (month < 0) return null;
  let hour = Number(match[3]) % 12;
  if (match[5] === "pm") hour += 12;
  const now = new Date(nowMs);
  let reset = new Date(now.getFullYear(), month, Number(match[2]), hour, Number(match[4]));
  if (reset.getTime() < now.getTime() - 86400000) {
    reset = new Date(now.getFullYear() + 1, month, Number(match[2]), hour, Number(match[4]));
  }
  return Math.floor(reset.getTime() / 1000);
}

function formatClaudeWindow(limit, nowMs) {
  const remaining = Math.max(0, 100 - limit.usedPercent);
  const resetAt = parseClaudeResetTime(limit.resetsText, nowMs);
  return `${remaining.toFixed(1)}% - ${resetAt ? formatResetRemaining(resetAt, nowMs) : "неизвестно"}`;
}

export function formatClaudeRateLimits(text, nowMs = Date.now()) {
  const limits = parseClaudeLimits(text);
  if (!limits.length) return "Не удалось распознать данные о лимитах Claude.";

  const sharedLimits = limits.filter((item) => !item.model);
  const sharedLimit = sharedLimits.find((item) => item.kind === "week (all models)")
    ?? sharedLimits.at(-1);
  const sessionLimit = sharedLimits.find((item) => item.kind === "session");
  const lines = sharedLimit
    ? [`CLAUDE - ${formatClaudeWindow(sharedLimit, nowMs)}`]
    : ["CLAUDE"];
  if (sessionLimit && sessionLimit !== sharedLimit) {
    lines.push(`Session - ${formatClaudeWindow(sessionLimit, nowMs)}`);
  }
  for (const limit of limits.filter((item) => item.model)) {
    const modelLimit = limit.resetsText || !sharedLimit
      ? limit
      : { ...limit, resetsText: sharedLimit.resetsText };
    lines.push(`${limit.model} - ${formatClaudeWindow(modelLimit, nowMs)}`);
  }
  return lines.join("\n");
}

export function formatStatusMessage({
  provider,
  busy,
  runningTasks = [],
  model,
  reasoning,
  mode,
  task,
  project,
  limits,
}) {
  const running = Array.isArray(runningTasks)
    ? runningTasks
    : Array.from({ length: Number(runningTasks) || 0 }, () => "");
  const activeHeading = running.length ? "\n\n<b>🧵АКТИВНЫЕ ЗАДАЧИ🧵</b>" : "";
  const projectLine = project ? `\nКаталог: ${escapeTelegramHtml(project)}` : "";
  return `${escapeTelegramHtml(provider)}: ${escapeTelegramHtml(model)} - ${escapeTelegramHtml(reasoning)}\n` +
    `${escapeTelegramHtml(mode)} | ${busy ? "Выполняет выбранную задачу" : "Готов"}\n\n` +
    `Текущая задача: ${escapeTelegramHtml(task)}${projectLine}\n\n` +
    `Выполняется задач: ${running.length}\n\n` +
    `Лимиты:\n${escapeTelegramHtml(limits)}${activeHeading}`;
}

export function formatProgressHeading({
  done = false,
  provider,
  model,
  reasoning,
  runtime = null,
  task,
  project = null,
}) {
  const projectSuffix = project ? ` ${project}` : "";
  const runtimeLine = runtime ? `\n⚙ ${runtime}` : "";
  const modelText = String(model ?? "").trim();
  const reasoningText = String(reasoning ?? "").trim();
  const details = modelText
    ? ` · ${modelText}${reasoningText ? ` - ${reasoningText}` : ""}`
    : reasoningText ? ` · ${reasoningText}` : "";
  return `${done ? "✅" : "⏳"} ${provider}${details}${projectSuffix}\n` +
    `🧵 ${task}${runtimeLine}`;
}

export function statusHeaderFileName(provider) {
  return String(provider).toLowerCase() === "codex"
    ? "codex-header.png"
    : "claude-header.png";
}

export function formatRestartCompleteMessage({
  provider,
  task,
  runningTasks = 0,
}) {
  const count = Math.max(0, Number(runningTasks) || 0);
  return "✅ <b>БОТ ПЕРЕЗАПУЩЕН</b>\n\n" +
    `Агент: ${escapeTelegramHtml(provider)}\n` +
    `Текущая задача: ${escapeTelegramHtml(task || "Не выбрана")}\n` +
    `Активных задач восстановлено: ${count}`;
}

export function formatArchiveMessage({ archivedTask, activeTask }) {
  const archived = `❌ Задача "${archivedTask}" архивирована.`;
  const active = activeTask
    ? `🟢 Задача "${activeTask}" активна.`
    : "⚪ Активных задач нет.";
  return `${archived}\n${active}`;
}

export function formatTaskSwitchMessage({ task, project, showProject, model, reasoning }) {
  const taskText = escapeTelegramHtml(task);
  const settingsText = model && reasoning
    ? `\n${escapeTelegramHtml(model)} - ${escapeTelegramHtml(reasoning)}`
    : "";
  if (!showProject) return `🔄 Текущая задача изменена.\n\n<b>${taskText}</b>${settingsText}`;
  return `🔄 Текущая задача изменена.\n\n<b>${escapeTelegramHtml(project)}</b>\n<i>${taskText}</i>${settingsText}`;
}

export function formatTaskAlreadySelectedMessage({ task, project, showProject, model, reasoning }) {
  const taskText = escapeTelegramHtml(task);
  const settingsText = model && reasoning
    ? `\n${escapeTelegramHtml(model)} - ${escapeTelegramHtml(reasoning)}`
    : "";
  if (!showProject) return `✅ Текущая задача уже выбрана.\n\n<b>${taskText}</b>${settingsText}`;
  return `✅ Текущая задача уже выбрана.\n\n<b>${escapeTelegramHtml(project)}</b>\n<i>${taskText}</i>${settingsText}`;
}

export function showLastMessageReplyMarkup() {
  return {
    inline_keyboard: [[{
      text: "👀 Показать сообщение",
      callback_data: "show-message",
    }]],
  };
}
