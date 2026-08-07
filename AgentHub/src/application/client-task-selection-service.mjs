import { createHash, randomUUID } from "node:crypto";

function telegramClientId(chatId) {
  return Number.isSafeInteger(chatId) ? `telegram:${chatId}` : "telegram:unknown";
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
  }

  clientId(chatId = this.sessionState.chatId) {
    return telegramClientId(chatId);
  }

  fallbackBinding() {
    return { ...this.fallbackSelection(), taskTitle: this.fallbackTitle() };
  }

  binding(chatId = this.sessionState.chatId) {
    return this.sessionState.clientTaskSelection(this.clientId(chatId)) ?? this.fallbackBinding();
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
    const binding = this.binding(chatId);
    const entry = this.catalogEntries().find((candidate) => (
      this.catalogEntryIsSelected(candidate, binding)
    ));
    const preferences = this.preferences.current(binding.provider);
    return {
      streamId: binding.streamId ?? entry?.streamId ?? null,
      provider: binding.provider,
      projectRoot: binding.projectRoot,
      sessionCwd: entry?.sessionCwd ?? null,
      threadId: binding.threadId,
      taskTitle: this.title(chatId),
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
    const previous = this.sessionState.clientTaskSelection(clientId) ?? this.fallbackBinding();
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
