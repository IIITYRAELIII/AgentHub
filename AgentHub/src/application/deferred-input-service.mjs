import { randomUUID } from "node:crypto";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class DeferredInputService {
  #d;

  constructor(dependencies = {}) {
    for (const name of ["persist", "removeFiles", "notify"]) {
      requiredFunction(dependencies[name], name);
    }
    if (!dependencies.store?.put) throw new TypeError("deferred input store is required");
    this.#d = {
      maxItems: 100,
      now: Date.now,
      createId: randomUUID,
      ...dependencies,
    };
  }

  async defer(input, temporaryFiles = [], {
    forceSpeechButton = false,
    executionOwner = "external",
    target,
    allowForce = false,
    conflictKind = "task-running",
    conflictTask = null,
    clientUserMessageId = null,
    destination = "pending",
    notify = true,
    persistentFiles = false,
  } = {}) {
    const d = this.#d;
    if (!target?.provider) throw new Error("deferred input target requires provider");
    if (d.store.size >= d.maxItems) {
      await d.removeFiles(temporaryFiles);
      throw new Error("очередь сохранённых сообщений переполнена; сначала обработайте или отмените старые сообщения");
    }
    const item = {
      id: d.createId(),
      streamId: String(target.streamId ?? "").trim() || null,
      chatId: target.chatId,
      provider: target.provider,
      projectRoot: target.projectRoot,
      threadId: target.threadId,
      taskTitle: target.taskTitle,
      modelId: target.modelId,
      reasoningId: target.reasoningId,
      collaborationMode: target.collaborationMode,
      input,
      temporaryFiles,
      persistentFiles: persistentFiles === true,
      forceSpeechButton,
      allowForce,
      conflictKind,
      clientUserMessageId: String(clientUserMessageId ?? "").trim() || null,
      createdAt: new Date(d.now()).toISOString(),
    };
    d.store.put(item, destination);
    await d.persist();
    if (notify) {
      const message = await d.notify(item, { executionOwner, conflictTask });
      item.messageId = message?.message_id ?? null;
      await d.persist();
    }
    return { deferred: true, id: item.id, item };
  }
}
