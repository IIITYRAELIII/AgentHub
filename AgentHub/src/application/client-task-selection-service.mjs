import { createHash, randomUUID } from "node:crypto";

function telegramClientId(chatId) {
  return Number.isSafeInteger(chatId) ? `telegram:${chatId}` : "telegram:unknown";
}

export function retargetTelegramClientSelections(sessionState, {
  provider,
  sourceThreadId,
  threadId,
  streamId = null,
  projectRoot = null,
  taskTitle = "",
} = {}) {
  const normalizedProvider = String(provider ?? "").trim();
  const normalizedSourceThreadId = String(sourceThreadId ?? "").trim();
  const normalizedThreadId = String(threadId ?? "").trim();
  if (!normalizedProvider || !normalizedSourceThreadId || !normalizedThreadId) return 0;
  let changed = 0;
  for (const [clientId, binding] of sessionState.clientTaskSelectionsSnapshot()) {
    if (!/^telegram:-?\d+$/u.test(clientId)
      || binding?.provider !== normalizedProvider
      || binding?.threadId !== normalizedSourceThreadId) continue;
    sessionState.setClientTaskSelection(clientId, {
      ...binding,
      streamId: String(streamId ?? binding.streamId ?? "").trim() || null,
      projectRoot: String(projectRoot ?? binding.projectRoot ?? "").trim() || null,
      threadId: normalizedThreadId,
      taskTitle: String(taskTitle ?? "").trim() || String(binding.taskTitle ?? "").trim(),
    });
    changed += 1;
  }
  return changed;
}

export class ClientTaskSelectionService {
  constructor({
    sessionState,
    fallbackSelection,
    fallbackTitle,
    findProject,
    catalogEntries,
    catalogEntryIsSelected,
    preferences,
    samePath,
    save,
    contextNonce = randomUUID(),
  }) {
    Object.assign(this, {
      sessionState,
      fallbackSelection,
      fallbackTitle,
      findProject,
      catalogEntries,
      catalogEntryIsSelected,
      preferences,
      samePath,
      save,
      contextNonce,
    });
    this.initialFallbackBinding = this.fallbackBinding();
    if (Number.isSafeInteger(this.sessionState.chatId)) {
      const clientId = this.clientId(this.sessionState.chatId);
      if (!this.sessionState.clientTaskSelection(clientId)) {
        this.sessionState.setClientTaskSelection(clientId, this.initialFallbackBinding);
      }
    }
  }

  clientId(chatId = this.sessionState.chatId) {
    return telegramClientId(chatId);
  }

  fallbackBinding() {
    return { ...this.fallbackSelection(), taskTitle: this.fallbackTitle() };
  }

  binding(chatId = this.sessionState.chatId) {
    return this.sessionState.clientTaskSelection(this.clientId(chatId))
      ?? structuredClone(this.initialFallbackBinding);
  }

  selectedTask(chatId = this.sessionState.chatId) {
    const { taskTitle: _taskTitle, ...task } = this.binding(chatId);
    return task;
  }

  title(chatId = this.sessionState.chatId) {
    return String(this.binding(chatId).taskTitle ?? "").trim();
  }

  currentUiContextToken(chatId = this.sessionState.chatId) {
    const binding = this.binding(chatId);
    return createHash("sha256")
      .update(`${this.contextNonce}\0${this.clientId(chatId)}\0${binding.provider}\0${binding.projectRoot}\0${binding.threadId ?? ""}`)
      .digest("hex")
      .slice(0, 12);
  }

  uiCallback(action, chatId = this.sessionState.chatId) {
    const value = `${String(action)}:u:${this.currentUiContextToken(chatId)}`;
    if (value.length > 64) throw new Error(`Telegram callback_data exceeds 64 bytes: ${action}`);
    return value;
  }

  turnTarget(chatId = this.sessionState.chatId) {
    const clientId = this.clientId(chatId);
    const explicitBinding = this.sessionState.clientTaskSelection(clientId);
    let binding = explicitBinding ?? structuredClone(this.initialFallbackBinding);
    let entry = this.catalogEntries().find((candidate) => (
      this.catalogEntryIsSelected(candidate, binding)
    ));
    if (explicitBinding && binding.threadId && !entry) {
      binding = this.fallbackBinding();
      entry = this.catalogEntries().find((candidate) => (
        this.catalogEntryIsSelected(candidate, binding)
      ));
    }
    const preferences = this.preferences.current(binding.provider);
    return {
      streamId: binding.streamId ?? entry?.streamId ?? null,
      provider: binding.provider,
      projectRoot: binding.projectRoot,
      sessionCwd: entry?.sessionCwd ?? null,
      threadId: binding.threadId,
      taskTitle: String(binding.taskTitle ?? "").trim(),
      chatId,
      modelId: entry?.model ?? preferences.model,
      reasoningId: entry?.reasoning ?? preferences.reasoningEffort,
      collaborationMode: preferences.collaborationMode,
    };
  }

  async select(binding, context = {}) {
    const project = this.findProject(binding?.projectRoot);
    if (!project) throw new Error("проект привязанного сообщения больше не разрешён");
    if (!["codex", "claude"].includes(binding?.provider)) {
      throw new Error("неизвестный агент привязанного сообщения");
    }
    const threadId = String(binding?.threadId ?? "").trim();
    if (!threadId && binding.provider !== "claude") throw new Error("задача не содержит Thread ID");
    const entry = threadId ? this.catalogEntries().find((candidate) => (
      candidate.provider === binding.provider
      && candidate.threadId === threadId
      && this.samePath(candidate.projectRoot, project.path)
    )) : null;
    const clientId = String(context?.clientId ?? "").trim()
      || this.clientId(binding?.chatId ?? this.sessionState.chatId);
    const previous = this.sessionState.clientTaskSelection(clientId)
      ?? structuredClone(this.initialFallbackBinding);
    const next = {
      streamId: String(binding?.streamId ?? entry?.streamId ?? "").trim() || null,
      provider: binding.provider,
      projectRoot: project.path,
      threadId: threadId || null,
      taskTitle: String(binding?.taskTitle ?? "").trim()
        || String(entry?.title ?? "").trim()
        || (threadId
          ? `${binding.provider === "codex" ? "Codex" : "Claude"} · ${threadId.slice(0, 8)}`
          : "Новая задача Claude"),
    };
    const changed = previous.provider !== next.provider
      || previous.threadId !== next.threadId
      || !this.samePath(previous.projectRoot, next.projectRoot);
    this.sessionState.setClientTaskSelection(clientId, next);
    await this.save();
    return { changed, selectionChanged: changed, activeTitle: next.taskTitle };
  }

  async clear(context = {}) {
    const clientId = String(context?.clientId ?? "").trim()
      || this.clientId(context?.chatId ?? this.sessionState.chatId);
    const changed = this.sessionState.deleteClientTaskSelection(clientId);
    if (changed) await this.save();
    return changed;
  }
}
