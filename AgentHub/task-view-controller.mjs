import {
  codexThreadHistory,
  mergeActiveTaskHistory,
  visibleTaskHistory,
} from "./task-history.mjs";
import { taskViewCallbackData } from "./task-view-callback.mjs";
import { updateTaskRunTitle } from "./task-runs.mjs";

export class TaskViewController {
  constructor(deps) {
    this.deps = deps;
  }

  task(binding, targetChatId) {
    return {
      provider: binding.provider,
      projectRoot: binding.projectRoot,
      threadId: binding.threadId,
      chatId: targetChatId,
      taskTitle: binding.taskTitle,
    };
  }

  identityMatches(binding, identity) {
    return binding?.provider === identity?.provider
      && String(binding?.threadId ?? "").toLowerCase()
        === String(identity?.threadId ?? "").toLowerCase();
  }

  async readHistory(binding, { completedOnly = false } = {}) {
    const d = this.deps;
    const task = this.task(binding, binding.chatId);
    try {
      if (binding.provider === "codex") {
        await d.ensureCodex();
        const result = await d.readCodexThread(binding.threadId, { fresh: true });
        const history = codexThreadHistory(result.thread?.turns);
        const snapshot = completedOnly ? null : await d.readCodexSnapshot({
          ...task,
          turnId: null,
          observer: true,
        }, { threadResult: result });
        mergeActiveTaskHistory(history, snapshot);
        d.taskSyncStore.recordHistory(task, history, snapshot);
        await d.taskSyncStore.save();
        return { history, snapshot };
      }
      const snapshot = await d.readClaudeSnapshot(binding.threadId, { includeHistory: true });
      const history = snapshot?.history ?? [];
      d.taskSyncStore.recordHistory(task, history, completedOnly ? null : snapshot);
      await d.taskSyncStore.save();
      return { history, snapshot: completedOnly ? null : snapshot };
    } catch (error) {
      const history = d.taskSyncStore.history(task)
        .filter((item) => !completedOnly || item.completed);
      if (!history.length) throw error;
      d.logger.warn(`Using cached local history for ${binding.provider} task ${binding.threadId}:`, error.message);
      return {
        history,
        snapshot: completedOnly ? null : d.taskSyncStore.snapshot(task),
      };
    }
  }

  async render(binding, targetChatId, { count = 1, completedOnly = false } = {}) {
    const d = this.deps;
    const task = this.task(binding, targetChatId);
    const { history, snapshot } = await this.readHistory(binding, { completedOnly });
    const running = d.taskRuns.forTask(task);
    if (running) {
      mergeActiveTaskHistory(history, {
        active: true,
        turnId: running.turnId ?? running.id,
        prompt: running.promptPreview,
        answer: running.responseText,
      });
    }
    const view = visibleTaskHistory(history, count, { completedOnly });
    await d.deleteTaskMessages(task, targetChatId);
    const historyButton = view.hasMore
      ? {
        reply_markup: {
          inline_keyboard: [[{
            text: `👀 Показать ещё · ${view.shown}/${view.total}`,
            callback_data: taskViewCallbackData({
              action: completedOnly ? "history-last" : "history-all",
              provider: task.provider,
              threadId: task.threadId,
              count: view.nextCount,
            }) ?? `history-more:${completedOnly ? "l" : "a"}:${view.nextCount}`,
          }]],
        },
      }
      : {};
    await d.sendRunMessage(
      task,
      `🧵 ${d.runTaskTitle(task)}\n\n`
        + (view.total
          ? `Показано сообщений: ${view.shown} из ${view.total}.`
          : "История этой задачи пока пуста."),
      historyButton,
      { kind: "task-view-navigation" },
    );
    let rendered = false;
    for (const exchange of view.items) {
      if (exchange.prompt) {
        await d.sendTaskViewText(task, "👤 Вы", exchange.prompt, "task-view-user");
        rendered = true;
      }
      if (!exchange.active && exchange.answer) {
        await d.sendTaskViewText(
          task,
          binding.provider === "claude" ? "🤖 Claude" : "🤖 Codex",
          exchange.answer,
          "task-view-assistant",
        );
        rendered = true;
      }
    }
    if (!rendered && completedOnly) {
      const answer = d.savedLastTaskMessage(task);
      if (answer) {
        await d.sendTaskViewText(
          task,
          binding.provider === "claude" ? "🤖 Claude" : "🤖 Codex",
          answer,
          "task-view-assistant",
        );
        rendered = true;
      }
    }
    return { snapshot, rendered };
  }

  async show(binding, targetChatId, { count = 1 } = {}) {
    const d = this.deps;
    const task = {
      provider: binding.provider,
      projectRoot: binding.projectRoot,
      threadId: binding.threadId,
    };
    if (d.dismissedExternalTasks.delete(task)) await d.saveState();
    const view = await this.render(binding, targetChatId, { count });
    const running = d.taskRuns.forTask(task);
    if (running) {
      const title = d.resolveRunningTitle(running, binding);
      if (updateTaskRunTitle(running, title)) await d.saveState();
      running.chatId = targetChatId;
      if (running.observer) running.displayRequested = true;
      await d.startProgressMessage(running, { forceNew: true });
      return;
    }
    if (view.snapshot?.active) {
      const run = d.createObservedRun(
        binding,
        targetChatId,
        view.snapshot,
        binding.provider === "codex" ? view.snapshot.turnId : null,
      );
      run.displayRequested = true;
      await d.startProgressMessage(run, { forceNew: true });
      d.scheduleObservedRun(run);
      await d.saveState();
      return;
    }
    if (view.snapshot?.activityUnknown) {
      await d.sendRunMessage(
        { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
        "❔ Активность Claude неизвестна: транскрипт не завершён, но давно не обновлялся. Новое сообщение не будет запущено в этом треде без явного подтверждения.",
      );
      await d.saveState();
      return;
    }
    if (!view.rendered) {
      await d.sendRunMessage(
        { ...task, chatId: targetChatId, taskTitle: binding.taskTitle },
        "У этой задачи пока нет выполняющегося хода или сохранённого ответа.",
      );
    }
    await d.saveState();
  }

  async showLast(binding, targetChatId, { count = 1 } = {}) {
    const view = await this.render(binding, targetChatId, { count, completedOnly: true });
    if (!view.rendered) {
      await this.deps.sendRunMessage(
        { ...binding, chatId: targetChatId },
        "У этой задачи пока нет сохранённого завершённого ответа.",
      );
    }
    await this.deps.saveState();
  }

  async resolveBinding(identity, targetChatId, sourceMessageId) {
    const d = this.deps;
    const stored = await d.findMessageBinding(targetChatId, sourceMessageId);
    if (!identity) return stored;
    if (this.identityMatches(stored, identity)) return stored;
    const entry = await d.findCatalogEntry(identity);
    if (entry) {
      return {
        chatId: targetChatId,
        messageId: sourceMessageId,
        provider: entry.provider,
        threadId: entry.threadId,
        projectRoot: entry.projectRoot,
        taskTitle: entry.title,
        createdAt: new Date().toISOString(),
      };
    }
    const selected = d.selectedTask();
    if (!this.identityMatches(selected, identity)) return null;
    return {
      chatId: targetChatId,
      messageId: sourceMessageId,
      ...selected,
      taskTitle: d.activeThreadTitle(),
      createdAt: new Date().toISOString(),
    };
  }
}
