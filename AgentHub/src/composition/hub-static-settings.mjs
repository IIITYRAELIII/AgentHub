import path from "node:path";

import { CODEX_REASONING_EFFORTS } from "../providers/codex/codex-settings.mjs";
import {
  CLAUDE_MODEL_ALIASES,
  CLAUDE_MODEL_LABELS,
  claudeModelLabel,
  CLAUDE_REASONING_EFFORTS,
  CLAUDE_REASONING_LABELS,
} from "../domain/agent-runtime-settings.mjs";

const AGENT_ICONS = ["👾", "🦉", "🐙", "🕶️", "🚀", "⚡", "💻", "🔮", "🛰️", "🔥", "✨"];

export function createHubStaticSettings(config, agentHubRoot) {
  const claudeModels = CLAUDE_MODEL_ALIASES;
  const claudeModelLabels = CLAUDE_MODEL_LABELS;
  const codexModels = config.codexModels;
  const codexModelAliases = new Map(codexModels.flatMap((model) => ([
    [String(model.value).toLowerCase(), model.value],
    [String(model.label).toLowerCase(), model.value],
  ])));
  const normalizeCodexModel = (value) => (
    codexModelAliases.get(String(value ?? "").toLowerCase()) ?? codexModels[0].value
  );
  const codexModelLabel = (value) => (
    codexModels.find((model) => model.value === value)?.label ?? value
  );
  const defaultCodexModel = normalizeCodexModel(config.codexModel);
  const defaultCodexReasoningEffort = CODEX_REASONING_EFFORTS.includes(config.codexReasoningEffort)
    ? config.codexReasoningEffort
    : "high";
  const agentIcon = AGENT_ICONS[Math.floor(Math.random() * AGENT_ICONS.length)];
  const botCommands = [
    { command: "menu", description: "Показать панель кнопок" },
    { command: "agent", description: "Переключить Claude Code/Codex" },
    { command: "model", description: "Сменить модель" },
    { command: "reasoning", description: "Сменить мощь дум (Codex/Claude)" },
    { command: "mode", description: "Переключить Plan/Work (Codex/Claude)" },
    { command: "projects", description: "Сменить активный проект" },
    { command: "new", description: "Новый контекст" },
    { command: "task", description: "Добавить Task или включить режим бэклога" },
    { command: "tasks", description: "Список задач" },
    { command: "resume", description: "Выбрать существующую задачу" },
    { command: "rename", description: "Закрепить название текущей задачи" },
    { command: "archive", description: "Архивировать текущую задачу" },
    { command: "status", description: "Статус и текущая задача" },
    { command: "approvals", description: "Режим подтверждений" },
    { command: "restart", description: "Перезапустить бота" },
    { command: "diff", description: "Последние изменения" },
    { command: "cancel", description: "Остановить текущую задачу" },
    { command: "help", description: "Справка" },
  ];
  const botMenu = {
    keyboard: [
      [{ text: `${agentIcon} Агент` }, { text: "🎛 Модель" }, ...(config.showProjectButton ? [{ text: "📁 Проект" }] : [])],
      [{ text: "🧠 Мощь дум" }, { text: "🛠 Plan/Work" }],
      [{ text: "📥 Задача" }, { text: "📋 Задачи" }, { text: "ℹ️ Статус" }, { text: "🔐 Доступ" }],
      [{ text: "⛔ Стоп" }, { text: "❓ Помощь" }, { text: "🔄 Рестарт" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
  const menuCommands = new Map([
    ...AGENT_ICONS.map((icon) => [`${icon} Агент`, "/agent"]),
    ["🧑‍💻 Агент", "/agent"], ["🤖 Движок", "/agent"],
    ["🎛 Модель", "/model"], ["🧠 Мощь дум", "/reasoning"],
    ["🧠 Сила дум", "/reasoning"], ["🛠 Plan/Work", "/mode"],
    ["📁 Папка", "/projects"], ["📁 Проект", "/projects"],
    ["🆕 Новая", "/new"], ["🆕 Новая задача", "/new"],
    ["📥 Задача", "/task"],
    ["📋 Задачи", "/tasks"], ["🎯 Текущая", "/current"],
    ["🧵 Поток", "/thread"], ["🧵 Поток Codex", "/thread"],
    ["ℹ️ Статус", "/status"], ["📝 Изменения", "/diff"],
    ["🔐 Доступ", "/approvals"], ["🔐 Подтверждения", "/approvals"],
    ["🔄 Перезапустить", "/restart"], ["🔄 Рестарт", "/restart"],
    ["⛔ Стоп", "/cancel"], ["⛔ Остановить", "/cancel"],
    ["❓ Помощь", "/help"],
  ]);

  return {
    globalWorkLogProjectRoots: config.projects.map((project) => project.path),
    journalDatabaseFile: path.join(config.dataDir, "journal.sqlite"),
    legacyWorkLogLedgerFile: path.join(config.dataDir, "work-log-usage.json"),
    legacyWorkLogFile: path.join(config.projectRoot, "WORK_LOG.md"),
    claudeModels,
    claudeModelLabels,
    claudeModelLabel,
    claudeReasoningEfforts: CLAUDE_REASONING_EFFORTS,
    claudeReasoningLabels: CLAUDE_REASONING_LABELS,
    codexModels,
    normalizeCodexModel,
    codexModelLabel,
    defaultCodexModel,
    defaultCodexReasoningEffort,
    projects: config.projects,
    defaultProjectRoot: config.projectRoot,
    stateFile: config.stateFile,
    stateBackupFile: `${config.stateFile}.bak`,
    deliveryOutboxDirectory: config.deliveryOutboxDir,
    backgroundJobsDirectory: path.join(config.dataDir, "background-jobs"),
    failedUpdatesDirectory: path.join(config.dataDir, "failed-updates"),
    instanceLockFile: path.join(config.dataDir, "bot.lock"),
    pinnedTaskTitlesFile: path.join(config.dataDir, "pinned-task-titles.json"),
    taskSyncFile: path.join(config.dataDir, "task-sync.json"),
    taskDiffsFile: path.join(config.dataDir, "task-diffs.json"),
    exchangeRatesFile: path.join(config.dataDir, "exchange-rates.json"),
    statusHeaderDirectory: path.join(agentHubRoot, "assets", "status"),
    telegramLimit: 3900,
    threadListLimit: 10,
    taskPickerPageSize: 8,
    maxDeferredInputs: 500,
    maxBackgroundMediaJobs: 20,
    maxBackgroundSpeechJobs: 10,
    maxInteractiveJobs: 10,
    botCommands,
    botMenu,
    menuCommands,
  };
}
