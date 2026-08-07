import {
  codexThreadHistory,
  displayUserPrompt,
  mergeActiveTaskHistory,
  responseAnnotationDetails,
  visibleTaskHistory,
} from "../../application/task-history.mjs";
import { taskViewCallbackData } from "./task-view-callback.mjs";
import { updateTaskRunTitle } from "../../domain/task-runs.mjs";

function mergeDurableHistory(cachedHistory, sourceHistory) {
  const merged = (Array.isArray(cachedHistory) ? cachedHistory : [])
    .map((item) => structuredClone(item));
  const positions = new Map(merged.map((item, index) => [String(item?.id ?? ""), index]));
  for (const item of Array.isArray(sourceHistory) ? sourceHistory : []) {
    const id = String(item?.id ?? "");
    const index = id ? positions.get(id) : undefined;
    if (index === undefined) {
      if (id) positions.set(id, merged.length);
      merged.push(structuredClone(item));
    } else {
      merged[index] = structuredClone(item);
    }
  }
  return merged;
}

function mergeAttachmentSources(currentMessages, rolloutMessages) {
  const messages = Array.isArray(currentMessages)
    ? currentMessages.map((message) => structuredClone(message))
    : [];
  let changed = false;
  for (const rolloutMessage of Array.isArray(rolloutMessages) ? rolloutMessages : []) {
    const sources = Array.isArray(rolloutMessage?.attachmentSources)
      ? rolloutMessage.attachmentSources
      : [];
    if (rolloutMessage?.role !== "agent" || !sources.length) continue;
    let targetIndex = messages.findIndex((message) => (
      message?.role === "agent"
      && String(message?.text ?? "").trim() === String(rolloutMessage.text ?? "").trim()
    ));
    if (targetIndex < 0) targetIndex = messages.findLastIndex((message) => message?.role === "agent");
    if (targetIndex < 0) {
      messages.push(structuredClone(rolloutMessage));
      changed = true;
      continue;
    }
    const target = messages[targetIndex];
    const mergedSources = Array.isArray(target.attachmentSources)
      ? target.attachmentSources.map((source) => ({ ...source }))
      : [];
    const known = new Set(mergedSources.map((source) => `${source.type}:${source.value}`));
    for (const source of sources) {
      const key = `${source?.type}:${source?.value}`;
      if (!known.has(key)) {
        mergedSources.push({ ...source });
        known.add(key);
        changed = true;
      }
    }
    if (mergedSources.length) target.attachmentSources = mergedSources;
  }
  return changed ? messages : currentMessages;
}

function mergeMessageAttachments(target, source) {
  const merged = { ...target };
  for (const field of ["attachments", "attachmentSources"]) {
    const values = Array.isArray(target?.[field])
      ? target[field].map((item) => ({ ...item }))
      : [];
    const keyFor = field === "attachments"
      ? (item) => String(item?.id ?? item?.path ?? item?.name ?? "")
      : (item) => `${item?.type}:${item?.value}`;
    const known = new Set(values.map(keyFor));
    for (const item of Array.isArray(source?.[field]) ? source[field] : []) {
      const key = keyFor(item);
      if (!key || known.has(key)) continue;
      values.push({ ...item });
      known.add(key);
    }
    if (values.length) merged[field] = values;
  }
  return merged;
}

function mergeAuthoritativeRolloutTurn(current, rollout) {
  const currentMessages = Array.isArray(current?.messages) ? current.messages : [];
  const rolloutMessages = Array.isArray(rollout?.messages) ? rollout.messages : [];
  const rolloutUsers = rolloutMessages.filter((message) => message?.role === "user");
  const rolloutAgents = rolloutMessages.filter((message) => message?.role === "agent");
  const currentUsers = currentMessages.filter((message) => message?.role === "user");
  const currentAgents = currentMessages.filter((message) => message?.role === "agent");
  const hasActualRolloutUser = rolloutUsers.some((message) => (
    !String(message?.itemId ?? "").endsWith(":rollout-user:placeholder")
  ));
  const users = hasActualRolloutUser
    ? rolloutUsers.map((message, index) => mergeMessageAttachments(message, currentUsers[index]))
    : currentUsers.map((message) => structuredClone(message));
  const agents = rolloutAgents.length
    ? rolloutAgents.map((message, index) => mergeMessageAttachments(
      message,
      currentAgents[index] ?? currentAgents.at(-1),
    ))
    : currentAgents.map((message) => structuredClone(message));
  return {
    ...current,
    ...(hasActualRolloutUser && rollout.prompt ? { prompt: rollout.prompt } : {}),
    ...(rollout.answer ? { answer: rollout.answer } : {}),
    status: rollout.status || current?.status,
    active: Boolean(rollout.active),
    completed: Boolean(rollout.completed),
    messages: [...users, ...agents],
    ...(rollout.promptAnnotations?.length
      ? {
        promptAnnotations: rollout.promptAnnotations.map((annotation) => ({ ...annotation })),
        promptRequest: rollout.promptRequest ?? "",
      }
      : {}),
  };
}

async function materializeHistoryAttachments(history, importer) {
  if (typeof importer !== "function") return;
  await Promise.all((Array.isArray(history) ? history : []).flatMap((turn) => (
    (Array.isArray(turn?.messages) ? turn.messages : []).map(async (message) => {
      const sources = Array.isArray(message?.attachmentSources) ? message.attachmentSources : [];
      if (!sources.length) return;
      const imported = await importer(sources);
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({ ...attachment }))
        : [];
      const known = new Set(attachments.map((attachment) => String(attachment?.id ?? "")));
      for (const attachment of Array.isArray(imported) ? imported : []) {
        const id = String(attachment?.id ?? "");
        if (id && !known.has(id)) {
          attachments.push({ ...attachment });
          known.add(id);
        }
      }
      if (attachments.length) message.attachments = attachments;
      delete message.attachmentSources;
    })
  )));
}

const CODEX_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function codexRolloutHistory(activity = {}) {
  const userMessages = activity?.userMessages ?? {};
  const latestMessages = activity?.latestMessages ?? {};
  const finalMessages = activity?.finalMessages ?? {};
  const generatedImageSources = activity?.generatedImageSources ?? {};
  const activeTurnIds = new Set(activity?.activeTurnIds ?? []);
  const ids = [...new Set([
    ...Object.keys(userMessages),
    ...Object.keys(latestMessages),
    ...Object.keys(finalMessages),
    ...Object.keys(generatedImageSources),
  ])];
  return ids.flatMap((id) => {
    const users = (Array.isArray(userMessages[id]) ? userMessages[id] : [])
      .filter((message) => String(message?.text ?? "").trim())
      .map((message, index) => {
        const rawText = String(message.text).trim();
        const responseAnnotations = responseAnnotationDetails(rawText);
        return {
          itemId: String(message.itemId ?? `${id}:rollout-user:${index}`),
          ...(String(message.clientUserMessageId ?? "").trim()
            ? { clientUserMessageId: String(message.clientUserMessageId).trim() }
            : {}),
          role: "user",
          text: displayUserPrompt(rawText),
          ...(responseAnnotations?.items.length
            ? {
              responseAnnotations: responseAnnotations.items.map((annotation) => ({ ...annotation })),
              responseAnnotationRequest: responseAnnotations.request,
            }
            : {}),
        };
      })
      .filter((message) => message.text);
    const finalAnswer = String(finalMessages[id] ?? "").trim();
    const latestAnswer = String(latestMessages[id] ?? "").trim();
    const answer = finalAnswer || latestAnswer;
    const generatedImages = Array.isArray(generatedImageSources[id])
      ? generatedImageSources[id].map((item) => ({ ...item }))
      : [];
    if (!users.length && !answer && !generatedImages.length) return [];
    const active = activeTurnIds.has(id);
    const completed = Boolean(finalAnswer);
    const prompt = users[0]?.text ?? "Сообщение с вложением";
    const messages = users.length
    ? [...users]
      : [{ itemId: `${id}:rollout-user:placeholder`, role: "user", text: prompt }];
    if (answer) {
      messages.push({
        itemId: `${id}:rollout-agent:${completed ? "final" : "latest"}`,
        role: "agent",
        text: answer,
        ...(completed ? { phase: "final_answer" } : {}),
        ...(generatedImages.length ? { attachmentSources: generatedImages } : {}),
      });
    } else if (generatedImages.length) {
      messages.push({
        itemId: `${id}:rollout-agent:image`,
        role: "agent",
        text: "Изображение",
        attachmentSources: generatedImages,
      });
    }
    const firstUser = users[0];
    const responseAnnotations = firstUser?.responseAnnotations ?? [];
    return [{
      id,
      prompt,
      answer,
      status: completed ? "completed" : active ? "inProgress" : "stopped",
      active,
      completed,
      ...(responseAnnotations.length
        ? {
          promptAnnotations: responseAnnotations.map((annotation) => ({ ...annotation })),
          promptRequest: firstUser.responseAnnotationRequest ?? "",
        }
        : {}),
      messages,
      activities: [],
    }];
  });
}

function mergeCodexHistory(cachedHistory, sourceHistory, rolloutHistory) {
  const merged = mergeDurableHistory(cachedHistory, sourceHistory);
  const positions = new Map(merged.map((item, index) => [String(item?.id ?? ""), index]));
  for (const item of Array.isArray(rolloutHistory) ? rolloutHistory : []) {
    const id = String(item?.id ?? "");
    const index = id ? positions.get(id) : undefined;
    if (index === undefined) {
      if (id) positions.set(id, merged.length);
      merged.push(structuredClone(item));
      continue;
    }
    let current = merged[index];
    const hasAuthoritativeContent = Boolean(
      item.answer
      || item.messages?.some((message) => message?.role === "agent"),
    );
    if (hasAuthoritativeContent) {
      current = mergeAuthoritativeRolloutTurn(current, item);
      merged[index] = current;
    }
    const messagesWithImages = mergeAttachmentSources(current?.messages, item.messages);
    if (messagesWithImages !== current?.messages) {
      current = { ...current, messages: messagesWithImages };
      merged[index] = current;
    }
    if (item.completed && !current?.completed) {
      merged[index] = {
        ...current,
        prompt: item.prompt || current.prompt,
        answer: item.answer || current.answer,
        status: "completed",
        active: false,
        completed: true,
        messages: mergeAttachmentSources(item.messages, current.messages),
        ...(item.promptAnnotations?.length
          ? {
            promptAnnotations: item.promptAnnotations.map((annotation) => ({ ...annotation })),
            promptRequest: item.promptRequest ?? "",
          }
          : {}),
      };
      continue;
    }
    if (item.promptAnnotations?.length) {
      const annotations = item.promptAnnotations.map((annotation) => ({ ...annotation }));
      const request = item.promptRequest ?? item.prompt ?? "";
      const rolloutUser = item.messages?.find(
        (message) => message?.role === "user" && message?.responseAnnotations?.length,
      );
      const messages = Array.isArray(current?.messages)
        ? current.messages.map((message) => ({ ...message }))
        : [];
      const userIndex = messages.findIndex((message) => message?.role === "user");
      if (userIndex >= 0) {
        messages[userIndex] = {
          ...messages[userIndex],
          ...(rolloutUser ?? {}),
          responseAnnotations: annotations,
          responseAnnotationRequest: request,
        };
      } else if (Array.isArray(item.messages)) {
        messages.push(...item.messages.map((message) => structuredClone(message)));
      }
      merged[index] = {
        ...current,
        prompt: item.prompt || current.prompt,
        promptAnnotations: annotations,
        promptRequest: request,
        messages,
      };
    }
  }
  return merged
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftId = String(left.item?.id ?? "");
      const rightId = String(right.item?.id ?? "");
      return CODEX_TURN_ID.test(leftId) && CODEX_TURN_ID.test(rightId)
        ? leftId.localeCompare(rightId)
        : left.index - right.index;
    })
    .map(({ item }) => item);
}

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

  async readHistory(binding, { completedOnly = false, cachedOnly = false } = {}) {
    const d = this.deps;
    const task = this.task(binding, binding.chatId);
    if (cachedOnly) {
      return {
        history: d.taskSyncStore.history(task)
          .filter((item) => !completedOnly || item.completed),
        snapshot: completedOnly ? null : d.taskSyncStore.snapshot(task),
      };
    }
    try {
      if (binding.provider === "codex") {
        const directRolloutPath = await d.findCodexRolloutPath?.(binding.threadId, "");
        if (directRolloutPath) {
          const cached = d.taskSyncStore.history(task);
          const rolloutActivity = await d.readCodexRolloutActivity(
            directRolloutPath,
            { freshnessMs: Number.POSITIVE_INFINITY },
          );
          const history = mergeCodexHistory(cached, [], codexRolloutHistory(rolloutActivity));
          const snapshot = completedOnly ? null : await d.readCodexSnapshot({
            ...task,
            turnId: null,
            observer: true,
            rolloutPath: directRolloutPath,
          }, { threadResult: { thread: { id: binding.threadId, path: directRolloutPath } } });
          mergeActiveTaskHistory(history, snapshot);
          await materializeHistoryAttachments(history, d.attachmentImporter);
          d.taskSyncStore.recordHistory(task, history, snapshot);
          await d.taskSyncStore.save();
          return { history, snapshot };
        }
        await d.ensureCodex();
        const result = await d.readCodexThread(binding.threadId, { fresh: true });
        const cached = d.taskSyncStore.history(task);
        const rolloutActivity = result.thread?.path
          ? await d.readCodexRolloutActivity(result.thread.path, {
            freshnessMs: Number.POSITIVE_INFINITY,
          })
          : null;
        const history = mergeCodexHistory(
          cached,
          codexThreadHistory(result.thread?.turns),
          codexRolloutHistory(rolloutActivity),
        );
        const snapshot = completedOnly ? null : await d.readCodexSnapshot({
          ...task,
          turnId: null,
          observer: true,
        }, { threadResult: result });
        mergeActiveTaskHistory(history, snapshot);
        await materializeHistoryAttachments(history, d.attachmentImporter);
        d.taskSyncStore.recordHistory(task, history, snapshot);
        await d.taskSyncStore.save();
        return { history, snapshot };
      }
      const snapshot = await d.readClaudeSnapshot(binding.threadId, { includeHistory: true });
      const cached = d.taskSyncStore.history(task);
      const history = mergeDurableHistory(cached, snapshot?.history ?? []);
      const running = completedOnly ? null : d.taskRuns.forTask(task);
      if (running) {
        mergeActiveTaskHistory(history, {
          active: true,
          turnId: running.turnId ?? running.id,
          prompt: running.promptPreview,
          answer: running.responseText,
          clientUserMessageId: running.clientUserMessageId,
          responseItemId: running.responseItemId,
          activities: running.activities,
          startedAt: running.startedAt,
          attachments: running.messageAttachments ?? [],
        });
      } else if (!snapshot) {
        for (const item of history) {
          if (item?.active !== true) continue;
          item.active = false;
          item.completed = true;
          item.status = "stopped";
        }
        const latest = history.at(-1);
        const savedAnswer = String(d.savedLastTaskMessage?.(task) ?? "").trim();
        if (latest && !String(latest.answer ?? "").trim() && savedAnswer) {
          latest.answer = savedAnswer;
          latest.status = "failed";
          latest.active = false;
          latest.completed = true;
          const messages = Array.isArray(latest.messages) ? latest.messages : [];
          messages.push({
            itemId: `${latest.id || "cached"}:agent:fallback`,
            role: "agent",
            text: savedAnswer,
          });
          latest.messages = messages;
        }
      }
      const persistenceSnapshot = completedOnly
        ? null
        : snapshot ?? (running ? {
          active: true,
          turnId: running.turnId ?? null,
          activityAtMs: Date.now(),
          stage: running.progressStage ?? "",
          answer: running.responseText ?? "",
        } : null);
      d.taskSyncStore.recordHistory(task, history, persistenceSnapshot);
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
      running.displayRequested = true;
      running.telegramDeliveryRequested = true;
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
      run.telegramDeliveryRequested = true;
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
    const reference = identity ?? stored;
    const entry = reference ? await d.findCatalogEntry(reference) : null;
    if (!identity && stored) return entry ? {
      ...stored,
      streamId: entry.streamId ?? stored.streamId ?? null,
      projectRoot: entry.projectRoot ?? stored.projectRoot,
      taskTitle: entry.title ?? stored.taskTitle,
    } : stored;
    if (this.identityMatches(stored, identity)) return entry ? {
      ...stored,
      streamId: entry.streamId ?? stored.streamId ?? null,
      projectRoot: entry.projectRoot ?? stored.projectRoot,
      taskTitle: entry.title ?? stored.taskTitle,
    } : stored;
    if (entry) {
      return {
        chatId: targetChatId,
        messageId: sourceMessageId,
        streamId: entry.streamId ?? null,
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
