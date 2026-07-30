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
  resolveTarget,
  receipts,
  persistReceipts,
  snapshot,
  taskRuns,
  taskExternalActivity,
  readCodexThread,
  deferConflictingInput,
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
      snapshot: await snapshot(),
    };
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
        if (target.provider !== "codex") {
          throw new Error("Изменение текущего хода доступно только для Codex");
        }
        const exactTurnId = await exactCodexTurnId(target, existingRun);
        if (!exactTurnId) {
          return deferQueue(input, attachments, {
            target,
            executionOwner: externalActivity.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
            clientUserMessageId,
            reason: "steer-unavailable",
          });
        }
        try {
          const result = await sendRpc("turn/steer", {
            threadId: target.threadId,
            expectedTurnId: exactTurnId,
            input: typeof input === "string" ? [{ type: "text", text: input }] : input,
            clientUserMessageId,
          });
          if (existingRun) {
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
            snapshot: await snapshot(),
          };
        } catch (error) {
          if (!activeTurnNotSteerable(error)) throw error;
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
        snapshot: await snapshot(),
      };
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
      });
      return {
        accepted: false,
        deferred: true,
        id: deferred.id,
        clientUserMessageId,
        reason: "repository-conflict",
        message: `Сообщение сохранено: задача «${repositoryConflict.taskTitle ?? "Без названия"}» уже изменяет тот же Git-репозиторий.`,
        snapshot: await snapshot(),
      };
    }
    const run = await beginRun(input, { ...target, clientUserMessageId });
    await launchTurn(run, input, attachments);
    return {
      accepted: true,
      runId: run.id,
      threadId: run.threadId,
      turnId: run.turnId,
      clientUserMessageId,
      snapshot: await snapshot(),
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
    if (previous) return { ...previous, snapshot: await snapshot() };

    const receiptKey = messageReceiptKey(receiptIdentity);
    const inflight = inflightReceipts.get(receiptKey);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) {
        const error = new Error("Идентификатор сообщения уже используется для другого содержимого");
        error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
        throw error;
      }
      const result = await inflight.promise;
      return { ...result, snapshot: await snapshot() };
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
      receipts.remember(receiptIdentity, fingerprint, storedResult);
      await persistReceipts();
      return storedResult;
    })();
    inflightReceipts.set(receiptKey, { fingerprint, promise });
    try {
      const result = await promise;
      return { ...result, snapshot: await snapshot() };
    } finally {
      inflightReceipts.delete(receiptKey);
    }
  }

  return {
    sendMessage,
  };
}
