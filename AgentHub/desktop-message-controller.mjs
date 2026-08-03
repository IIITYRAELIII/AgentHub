import { randomUUID } from "node:crypto";
import {
  messageReceiptKey,
  messageRequestFingerprint,
} from "./message-receipts.mjs";
import { TASK_EXECUTION_OWNERS } from "./task-catalog.mjs";

function activeTurnNotSteerable(error) {
  const details = `${String(error?.message ?? "")} ${JSON.stringify(error?.data ?? {})}`.toLowerCase();
  return details.includes("activeturnnotsteerable")
    || details.includes("active turn not steerable")
    || details.includes("no active turn")
    || details.includes("expectedturnid");
}

export function createDesktopMessageController({
  attachmentPaths,
  describeAttachments = (files) => files.map((file) => ({ id: String(file) })),
  resolveTarget,
  receipts,
  persistReceipts,
  snapshot,
  taskRuns,
  taskExternalActivity,
  readCodexThread,
  deferConflictingInput,
  hasDeferredBacklog = () => false,
  scheduleQueuedInput,
  sendRpc,
  setProgressStage,
  noteRunActivity,
  scheduleProgressUpdate,
  activeRepositoryConflict,
  beginRun,
  launchTurn,
}) {
  const inflightReceipts = new Map();

  async function exactCodexTurnId(target, existingRun) {
    const registered = String(existingRun?.turnId ?? "").trim();
    if (registered) return registered;
    const result = await readCodexThread(target.threadId, { fresh: true });
    const active = (Array.isArray(result.thread?.turns) ? result.thread.turns : [])
      .filter((turn) => ["inProgress", "in_progress", "running"].includes(String(turn?.status ?? "")))
      .map((turn) => String(turn.id ?? "").trim())
      .filter(Boolean);
    if (active.length === 1) return active[0];
    if (active.length > 1) {
      throw new Error("В задаче выполняется несколько ходов; выбрать ход для изменения нельзя");
    }
    return null;
  }

  async function deferQueue(input, attachments, {
    target,
    executionOwner,
    clientUserMessageId,
    reason = "task-running",
  }) {
    const deferred = await deferConflictingInput(input, attachments, {
      executionOwner,
      target,
      conflictKind: reason,
      clientUserMessageId,
      destination: "queued",
      notify: false,
      persistentFiles: attachments.length > 0,
    });
    scheduleQueuedInput(deferred.item, 500);
    return {
      accepted: false,
      deferred: true,
      queued: true,
      id: deferred.id,
      clientUserMessageId,
      reason,
      message: reason === "steer-unavailable"
        ? "Текущий ход уже нельзя изменить; сообщение сохранено в очереди."
        : "Сообщение поставлено в очередь и будет отправлено после текущего хода.",
    };
  }

  async function steerActiveInput({ input, target, clientUserMessageId }) {
    if (target.provider !== "codex") {
      throw new Error("Отправка в текущий ход доступна только для Codex");
    }
    const existingRun = taskRuns.forTask(target);
    const externalActivity = existingRun
      ? { state: "active", executionOwner: existingRun.executionOwner }
      : await taskExternalActivity(target);
    if (!existingRun && externalActivity.state === "inactive") {
      throw new Error("Текущий ход уже завершён; сообщение осталось в очереди");
    }
    const exactTurnId = await exactCodexTurnId(target, existingRun);
    if (!exactTurnId) {
      throw new Error("Текущий ход уже нельзя изменить; сообщение осталось в очереди");
    }
    try {
      const result = await sendRpc("turn/steer", {
        threadId: target.threadId,
        expectedTurnId: exactTurnId,
        input: typeof input === "string" ? [{ type: "text", text: input }] : input,
        clientUserMessageId,
      });
      if (existingRun) {
        const userMessages = Array.isArray(existingRun.userMessages)
          ? existingRun.userMessages
          : [];
        if (!userMessages.some((message) => (
          String(message?.clientUserMessageId ?? "") === clientUserMessageId
        ))) {
          userMessages.push({
            role: "user",
            clientUserMessageId,
            text: typeof input === "string"
              ? input
              : input.filter((item) => item?.type === "text")
                .map((item) => String(item.text ?? ""))
                .filter(Boolean)
                .join("\n"),
          });
          existingRun.userMessages = userMessages;
        }
        setProgressStage(existingRun, "Уточнение принято.");
        noteRunActivity(existingRun);
        scheduleProgressUpdate(existingRun, 0);
      }
      return {
        accepted: true,
        steered: true,
        runId: existingRun?.id ?? null,
        threadId: target.threadId,
        turnId: String(result?.turnId ?? exactTurnId),
        clientUserMessageId,
        message: "Сообщение добавлено в текущий ход.",
      };
    } catch (error) {
      if (!activeTurnNotSteerable(error)) throw error;
      throw new Error("Текущий ход уже нельзя изменить; сообщение осталось в очереди", {
        cause: error,
      });
    }
  }

  async function sendMessageOnce({
    input,
    attachments,
    target,
    clientUserMessageId,
    followUpMode,
  }) {
    const existingRun = taskRuns.forTask(target);
    const externalActivity = existingRun
      ? { state: "active", executionOwner: existingRun.executionOwner }
      : await taskExternalActivity(target);
    if (existingRun || externalActivity.state !== "inactive") {
      if (followUpMode === "steer") {
        try {
          return await steerActiveInput({ input, target, clientUserMessageId });
        } catch (error) {
          if (!activeTurnNotSteerable(error) && !/текущий ход уже/i.test(error.message)) throw error;
          return deferQueue(input, attachments, {
            target,
            executionOwner: existingRun?.executionOwner
              ?? externalActivity.executionOwner
              ?? TASK_EXECUTION_OWNERS.EXTERNAL,
            clientUserMessageId,
            reason: "steer-unavailable",
          });
        }
      }
      if (followUpMode === "queue") {
        return deferQueue(input, attachments, {
          target,
          executionOwner: existingRun?.executionOwner
            ?? externalActivity.executionOwner
            ?? TASK_EXECUTION_OWNERS.EXTERNAL,
          clientUserMessageId,
        });
      }
      const deferred = await deferConflictingInput(input, attachments, {
        executionOwner: existingRun?.executionOwner
          ?? externalActivity.executionOwner
          ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: externalActivity.state === "unknown" && !existingRun,
        conflictKind: externalActivity.state === "unknown" && !existingRun
          ? "activity-unknown"
          : "task-running",
        clientUserMessageId,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        reason: externalActivity.state === "unknown" ? "activity-unknown" : "task-running",
        message: externalActivity.state === "unknown"
          ? "Сообщение сохранено: нельзя надёжно определить, завершён ли предыдущий ход."
          : "Сообщение сохранено: выберите новую задачу, очередь или отмену справа.",
      };
    }
    // A newly submitted message must not jump ahead of durable inputs that
    // were accepted earlier while the task was busy.
    if (hasDeferredBacklog(target)) {
      return deferQueue(input, attachments, {
        target,
        executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
        clientUserMessageId,
        reason: "queue-backlog",
      });
    }
    const repositoryConflict = await activeRepositoryConflict(target);
    if (repositoryConflict) {
      const deferred = await deferConflictingInput(input, attachments, {
        executionOwner: repositoryConflict.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
        target,
        allowForce: true,
        conflictKind: "repository",
        conflictTask: repositoryConflict,
        clientUserMessageId,
        persistentFiles: attachments.length > 0,
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        reason: "repository-conflict",
        message: `Сообщение сохранено: задача «${repositoryConflict.taskTitle ?? "Без названия"}» уже изменяет тот же Git-репозиторий.`,
      };
    }
    const run = await beginRun(input, { ...target, clientUserMessageId });
    run.messageAttachments = describeAttachments(attachments);
    // Desktop attachments are durable message data. The agent receives the
    // same files, but turn cleanup must not remove the history originals.
    await launchTurn(run, input, []);
    return {
      accepted: true,
      runId: run.id,
      threadId: run.threadId,
      turnId: run.turnId,
      clientUserMessageId,
    };
  }

  async function sendMessage(params) {
    const text = String(params.text ?? "").trim();
    const attachments = await attachmentPaths(params.attachments);
    if (!text && !attachments.length) throw new Error("Введите сообщение или добавьте изображение");
    if (text.length > 100_000) throw new Error("Сообщение слишком длинное");
    const clientUserMessageId = String(
      params.clientUserMessageId ?? params.requestId ?? randomUUID(),
    ).trim().slice(0, 200);
    if (!clientUserMessageId) throw new Error("Сообщение не содержит идентификатор доставки");
    const followUpMode = String(params.followUpMode ?? "").trim().toLowerCase();
    if (followUpMode && !["queue", "steer"].includes(followUpMode)) {
      throw new Error("Неизвестный режим следующего сообщения");
    }
    const input = attachments.length
      ? [
        { type: "text", text: text || "Проанализируй приложенное изображение." },
        ...attachments.map((file) => ({ type: "localImage", path: file })),
      ]
      : text;
    const target = await resolveTarget(params);
    if (!target.threadId) throw new Error("Сначала выберите или создайте задачу");
    const receiptIdentity = {
      provider: target.provider,
      threadId: target.threadId,
      clientUserMessageId,
    };
    const fingerprint = await messageRequestFingerprint({ text, attachments, followUpMode });
    const previous = receipts.find(receiptIdentity, fingerprint);
    if (previous) return previous;

    const receiptKey = messageReceiptKey(receiptIdentity);
    const inflight = inflightReceipts.get(receiptKey);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) {
        const error = new Error("Идентификатор сообщения уже используется для другого содержимого");
        error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
        throw error;
      }
      const result = await inflight.promise;
      return result;
    }

    const promise = (async () => {
      const result = await sendMessageOnce({
        input,
        attachments,
        target,
        clientUserMessageId,
        followUpMode,
      });
      const { snapshot: _snapshot, ...storedResult } = result;
      if (attachments.length) storedResult.attachments = describeAttachments(attachments);
      receipts.remember(receiptIdentity, fingerprint, storedResult);
      await persistReceipts();
      return storedResult;
    })();
    inflightReceipts.set(receiptKey, { fingerprint, promise });
    try {
      const result = await promise;
      return result;
    } finally {
      inflightReceipts.delete(receiptKey);
    }
  }

  return {
    sendMessage,
    steerActiveInput,
  };
}
