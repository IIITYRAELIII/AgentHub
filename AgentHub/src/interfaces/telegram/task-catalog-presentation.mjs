import { catalogEntryIsSelected } from "../../domain/task-catalog-identity.mjs";
import { taskDisplayTitle } from "../../domain/task-display-title.mjs";
import {
  TASK_EXECUTION_OWNERS,
  taskExecutionRunningEmoji,
  taskExecutionRuntimeShortLabel,
} from "../../domain/task-execution-owner.mjs";

export function taskCatalogCallback(entry) {
  const provider = entry.provider === "claude" ? "l" : "c";
  return `task:${provider}:${entry.threadId}`;
}

function taskActivityAtMs(entry) {
  const calculated = Number(entry?.orderingActivityAtMs);
  if (Number.isFinite(calculated) && calculated > 0) return calculated;
  const values = [Number(entry?.messageActivityAtMs)]
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : 0;
}

export function statusTaskEntries(entries, limit = 4) {
  const count = Math.max(0, Number(limit) || 0);
  return [...entries]
    .sort((left, right) => (
      Number(right.running) - Number(left.running)
      || taskActivityAtMs(right) - taskActivityAtMs(left)
      || taskDisplayTitle(left).localeCompare(taskDisplayTitle(right), "ru")
    ))
    .slice(0, count);
}

export function runningTaskReplyMarkup(entries, selected = null, { showProject = false, limit = 4 } = {}) {
  return {
    inline_keyboard: statusTaskEntries(entries, limit)
      .map((entry) => {
        const isSelected = selected && catalogEntryIsSelected(entry, selected);
        const runningEmoji = taskExecutionRunningEmoji(entry.executionOwner);
        const runtimeEmoji = isSelected
          && entry.running
          && entry.executionOwner === TASK_EXECUTION_OWNERS.HUB
          ? `${runningEmoji} `
          : "";
        return [{
          text: (
            `${isSelected ? "✅ ТЕКУЩАЯ" : entry.running ? runningEmoji : entry.activityUnknown ? "❔" : "🕘"} · `
            + `${entry.running ? `${runtimeEmoji}${taskExecutionRuntimeShortLabel(entry.executionOwner)} · ` : ""}`
            + `${entry.provider === "codex" ? "Codex" : "Claude"} · `
            + `${showProject ? `${entry.projectName} · ` : ""}${taskDisplayTitle(entry)}`
          ).slice(0, 90),
          callback_data: taskCatalogCallback(entry),
        }];
      }),
  };
}

export function parseTaskCatalogCallback(value) {
  const match = /^task:([cl]):([0-9a-f-]+)$/i.exec(String(value ?? ""));
  if (!match) return null;
  return {
    provider: match[1].toLowerCase() === "l" ? "claude" : "codex",
    threadId: match[2],
  };
}
