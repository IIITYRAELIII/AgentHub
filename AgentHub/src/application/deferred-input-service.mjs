import { randomUUID } from "node:crypto";
import { rapidDeferredInputDuplicate } from "../domain/deferred-input.mjs";
import { normalizeInterstreamOrigin } from "../domain/interstream-message.mjs";

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
    const normalizedTargetClientUserMessageId = String(
      target.clientUserMessageId ?? "",
    ).trim() || null;
    const normalizedClientUserMessageId = String(
      clientUserMessageId ?? normalizedTargetClientUserMessageId ?? "",
    ).trim() || null;
    const existing = normalizedClientUserMessageId && typeof d.store.values === "function"
      ? d.store.values().find((item) => (
        String(item.clientUserMessageId ?? "").trim() === normalizedClientUserMessageId
        && String(item.provider ?? "").trim().toLowerCase() === String(target.provider ?? "").trim().toLowerCase()
        && String(item.threadId ?? "").trim() === String(target.threadId ?? "").trim()
        && String(item.streamId ?? "").trim() === String(target.streamId ?? "").trim()
      ))
      : null;
    if (existing) return { deferred: true, id: existing.id, item: existing, duplicate: true };
    const createdAt = new Date(d.now()).toISOString();
    const duplicateCandidate = {
      streamId: String(target.streamId ?? "").trim() || null,
      provider: target.provider,
      projectRoot: target.projectRoot,
      threadId: target.threadId,
      input,
      temporaryFiles,
      conflictKind,
      clientUserMessageId: normalizedClientUserMessageId,
      createdAt,
    };
    const rapidDuplicate = destination === "queued" && typeof d.store.values === "function"
      ? d.store.values().find((item) => rapidDeferredInputDuplicate(item, duplicateCandidate))
      : null;
    const messageOrigin = normalizeInterstreamOrigin(target.messageOrigin);
    if (rapidDuplicate) {
      await d.removeFiles(temporaryFiles);
      return {
        deferred: true,
        id: rapidDuplicate.id,
        item: rapidDuplicate,
        duplicate: true,
        duplicateOfClientUserMessageId: rapidDuplicate.clientUserMessageId ?? null,
      };
    }
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
      clientUserMessageId: normalizedClientUserMessageId,
      telegramDeliveryRequested: target.telegramDeliveryRequested !== false,
      clientSource: String(target.clientSource ?? "telegram").trim() || "telegram",
      ...(messageOrigin ? { messageOrigin } : {}),
      createdAt,
    };
    const usesDurableIntake = conflictKind === "message-intake"
      && typeof d.persistIntake === "function";
    if (usesDurableIntake) {
      d.commandTrace?.recordBestEffort?.({
        commandId: normalizedClientUserMessageId,
        stage: "durable-intake-enqueue",
        outcome: "queued",
        transport: String(target.clientSource ?? "desktop-control").trim().toLowerCase() || "desktop-control",
        metadata: { destination, itemId: item.id },
      });
      const intake = await d.persistIntake(item, destination);
      if (intake?.duplicate) {
        return {
          deferred: Boolean(intake.record?.item),
          id: intake.record?.item?.id ?? null,
          item: intake.record?.item ?? null,
          duplicate: true,
          durableResult: intake.retryResult ?? null,
        };
      }
      if (intake?.record?.item) Object.assign(item, intake.record.item);
    } else {
      d.store.put(item, destination);
      await d.persist();
    }
    if (usesDurableIntake) d.store.put(item, destination);
    if (notify && item.telegramDeliveryRequested) {
      const message = await d.notify(item, { executionOwner, conflictTask });
      item.messageId = message?.message_id ?? null;
      await d.persist();
    }
    return { deferred: true, id: item.id, item };
  }
}
