import {
  catalogEntryIsSelected,
  taskCatalogCallback,
  taskExecutionRuntimeShortLabel,
} from "./task-catalog.mjs";

export function taskPickerButtonText(entry, selectedTask, {
  showProject = false,
} = {}) {
  const selected = selectedTask && catalogEntryIsSelected(entry, selectedTask) ? "✓ " : "";
  const running = entry.running ? "⏳ " : entry.activityUnknown ? "❔ " : "";
  const runtime = entry.running ? `${taskExecutionRuntimeShortLabel(entry.executionOwner)} · ` : "";
  const provider = entry.provider === "codex" ? "Codex" : "Claude";
  const project = showProject ? `${entry.projectName} · ` : "";
  return `${selected}${running}${runtime}${provider} · ${project}${entry.title}`.slice(0, 90);
}

export function buildTaskPicker({
  catalog,
  selectedTask,
  page = 0,
  pageSize = 8,
  showProject = false,
  providerTitle,
  projectName,
  newTaskCallback,
  archiveCallback = null,
}) {
  const pageCount = Math.max(1, Math.ceil(catalog.length / pageSize));
  const safePage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
  const visible = catalog.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard = visible.map((entry) => [{
    text: taskPickerButtonText(entry, selectedTask, { showProject }),
    callback_data: taskCatalogCallback(entry),
  }]);
  if (pageCount > 1) {
    const navigation = [];
    if (safePage > 0) navigation.push({ text: "←", callback_data: `tasks-page:${safePage - 1}` });
    navigation.push({ text: `${safePage + 1}/${pageCount}`, callback_data: `tasks-page:${safePage}` });
    if (safePage + 1 < pageCount) navigation.push({ text: "→", callback_data: `tasks-page:${safePage + 1}` });
    keyboard.push(navigation);
  }
  keyboard.push([{
    text: `🆕 Новая задача: ${providerTitle} · ${projectName}`,
    callback_data: newTaskCallback,
  }]);
  if (archiveCallback) {
    keyboard.push([{
      text: "❌ Архивировать текущую задачу",
      callback_data: archiveCallback,
    }]);
  }
  const runningCount = catalog.filter((entry) => entry.running).length;
  return {
    text: catalog.length
      ? `Все задачи Codex и Claude в разрешённых папках: ${catalog.length}\nВыполняются: ${runningCount}\n\nВыберите задачу:`
      : "В разрешённых папках пока нет задач Codex или Claude.",
    replyMarkup: { inline_keyboard: keyboard },
    page: safePage,
    pageCount,
  };
}
