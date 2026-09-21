import { createRuntimeFileRemoval } from "../runtime/test-contour-runtime-effects.mjs";
import {
  deferredInputMatchesRun,
  pendingInputKeyboard,
} from "../domain/deferred-input.mjs";
import { DeferredInputController } from "../application/deferred-input-controller.mjs";
import { activeTurnNotSteerable } from "../application/run-coordinator.mjs";
import { prependStreamHandoff } from "../domain/stream-handoff.mjs";
import { isClaudeCompactionRun } from "../domain/claude-context-maintenance.mjs";
import { markProviderTurnAccepted } from "../domain/task-runs.mjs";
import { messageCommandMatchesRun } from "../domain/message-command-expiry.mjs";

function explicitSkillCandidatesFromInput(input) {
  const text = typeof input === "string"
    ? input
    : (Array.isArray(input) ? input : [])
      .filter((item) => item?.type === "text")
      .map((item) => String(item.text ?? ""))
      .join("\n");
  return [...new Set(
    [...text.matchAll(/(?:^|[\s([{])\$([A-Za-z0-9][A-Za-z0-9_.:-]*)/gu)]
      .map((match) => match[1]),
  )];
}

export function contextCompactionRunIsInternal(run, compaction, turnId = run?.turnId) {
  const normalizedTurnId = String(turnId ?? "").trim();
  const compactionTurnId = String(compaction?.turnId ?? "").trim();
  if (
    !run
    || !normalizedTurnId
    || compactionTurnId !== normalizedTurnId
  ) return false;
  if (compaction?.origin === "manual") return true;
  const hasUserInput = Boolean(
    String(run.promptPreview ?? "").trim()
    || String(run.clientUserMessageId ?? "").trim()
    || (Array.isArray(run.userMessages) && run.userMessages.some((message) => (
      String(message?.text ?? "").trim()
      || (Array.isArray(message?.attachments) && message.attachments.length)
    )))
    || (Array.isArray(run.messageAttachments) && run.messageAttachments.length)
  );
  return !hasUserInput && !String(run.responseText ?? "").trim();
}

export function createRunAdmissionComposition({
  config,
  samePath,
  sendRpc,
  contextCompactions,
  codexUsageTracker,
  turnSpeechButtons,
  turnTemporaryFiles,
  taskProgress,
  managedRunLifecycle,
  agentProviders,
  taskRuns,
  scheduleObservedRun,
  runCoordinator,
  runConflictPolicy,
  pendingInputs,
  queuedInputs,
  getSelectedTask,
  getActiveThreadTitle,
  getChatId,
  taskExecutionOwners,
  deferredInputPresentation,
  sendMessageTo,
  saveState,
  streamHandoff = null,
  stageLaunchAdmission,
  abortLaunchAdmission,
  logger = console,
  commandTrace = null,
  runtimeStateStore = null,
}) {
  const removeRuntimeFile = createRuntimeFileRemoval(config);
  if (typeof stageLaunchAdmission !== "function") {
    throw new TypeError("stageLaunchAdmission is required");
  }
  if (typeof abortLaunchAdmission !== "function") {
    throw new TypeError("abortLaunchAdmission is required");
  }
  async function resolvedExplicitSkillNames(input, cwd) {
    const candidates = explicitSkillCandidatesFromInput(input);
    if (!candidates.length) return [];
    try {
      const result = await sendRpc("skills/list", { cwds: [cwd] });
      const available = new Set(
        (result?.data ?? [])
          .filter((entry) => samePath(entry?.cwd, cwd))
          .flatMap((entry) => entry?.skills ?? [])
          .filter((skill) => skill?.enabled !== false)
          .map((skill) => String(skill?.name ?? "").trim())
          .filter(Boolean),
      );
      return candidates.filter((name) => available.has(name));
    } catch (error) {
      logger.warn(`Cannot resolve explicit skills for ${cwd}: ${error.message}`);
      return [];
    }
  }

  async function discardContextCompactionRun(run, turnId = run?.turnId) {
    if (!contextCompactionRunIsInternal(run, contextCompactions.get(run?.threadId), turnId)) {
      return false;
    }
    const normalizedTurnId = String(turnId ?? "").trim();
    codexUsageTracker.deleteTurn(normalizedTurnId);
    turnSpeechButtons.delete(normalizedTurnId);
    const temporaryFiles = turnTemporaryFiles.get(normalizedTurnId) ?? [];
    turnTemporaryFiles.delete(normalizedTurnId);
    await Promise.all(temporaryFiles.map((file) => removeRuntimeFile(file)));
    await taskProgress.clear(run);
    await managedRunLifecycle.complete(run);
    return true;
  }

  async function taskExternalActivity(target, options = {}) {
    if (!target?.threadId) return { state: "inactive", executionOwner: null };
    try {
      return await agentProviders.call(target.provider, "readTaskActivity", target, options);
    } catch (error) {
      logger.error(`Cannot check ${target.provider} task activity:`, error.message);
      return { state: "unknown", executionOwner: taskExecutionOwners.EXTERNAL };
    }
  }

  // Свёртка контекста Claude — служебная команда CLI: любой префикс превратил
  // бы её в обычный текст и команда не выполнилась бы.
  async function streamHandoffPrefix(run) {
    if (!streamHandoff || !run?.streamId) return "";
    if (isClaudeCompactionRun(run)) return "";
    try {
      return await streamHandoff.consume({
        streamId: run.streamId,
        provider: run.provider,
        threadId: run.threadId,
      });
    } catch (error) {
      logger.warn(`Cannot build Stream handoff for ${run.streamId}: ${error.message}`);
      return "";
    }
  }

  async function launchTurn(run, input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
    const launchAdmission = stageLaunchAdmission(run);
    try {
      const preparedInput = prependStreamHandoff(input, await streamHandoffPrefix(run));
      if (run.provider === "codex") {
        return agentProviders.call(run.provider, "launchTurn", run, preparedInput, temporaryFiles, { forceSpeechButton });
      }
      const trace = commandTrace?.startBestEffortSpan?.({
        commandId: String(run.clientUserMessageId ?? ""),
        stage: "provider-rpc",
        transport: "claude-process",
        metadata: { provider: run.provider, runId: run.id, threadId: run.threadId },
      });
      try {
        const result = await agentProviders.call(
          run.provider,
          "launchTurn",
          run,
          preparedInput,
          temporaryFiles,
          { forceSpeechButton, launchAdmission },
        );
        trace?.finish({ outcome: "succeeded", metadata: { pid: Number(run.pid ?? run.process?.pid) || null } });
        commandTrace?.recordBestEffort?.({
          commandId: String(run.clientUserMessageId ?? ""),
          stage: "provider-accept",
          outcome: "succeeded",
          transport: "claude-process",
          metadata: { provider: run.provider, runId: run.id, threadId: run.threadId, pid: Number(run.pid ?? run.process?.pid) || null },
        });
        return result;
      } catch (error) {
        trace?.finish({ outcome: "failed", metadata: { errorCode: error?.code ?? null } });
        throw error;
      }
    } catch (error) {
      abortLaunchAdmission(run, launchAdmission);
      throw error;
    }
  }

  async function startTurn(input, temporaryFiles = [], {
    forceSpeechButton = false,
    target = null,
    allowRepositoryConflict = false,
    allowUnknownExternalActivity = false,
    persistentFiles = false,
    telegramDeliveryRequested = true,
    clientUserMessageId = null,
    messageFingerprint = null,
    followUpMode = "",
  } = {}) {
    target ??= {
      ...getSelectedTask(),
      taskTitle: getActiveThreadTitle(),
      chatId: getChatId(),
    };
    target = {
      ...target,
      telegramDeliveryRequested: target.telegramDeliveryRequested
        ?? telegramDeliveryRequested,
      clientSource: target.clientSource
        ?? (telegramDeliveryRequested ? "telegram" : "desktop"),
    };
    const result = clientUserMessageId
      ? await runCoordinator.acceptClientInput({
          input,
          attachments: temporaryFiles,
          target,
          clientUserMessageId,
          messageFingerprint,
          followUpMode,
        })
      : await runCoordinator.start(input, temporaryFiles, {
          forceSpeechButton,
          target,
          allowRepositoryConflict,
          allowUnknownExternalActivity,
          persistentFiles,
        });
    if (!result?.run) return result;
    const { run: _run, ...publicResult } = result;
    return publicResult;
  }

  async function cleanupDeferredFiles(item) {
    await Promise.all((item?.temporaryFiles ?? []).map((file) => removeRuntimeFile(file)));
  }

  function updateDeferredMessage(...args) {
    return deferredInputPresentation.updateTelegramMessage(...args);
  }

  function updateDeferredDesktopReceipt(...args) {
    return deferredInputPresentation.updateDesktopReceipt(...args);
  }

  function deferredTarget(item) {
    return {
      streamId: item.streamId,
      provider: item.provider,
      projectRoot: item.projectRoot,
      threadId: item.threadId,
      taskTitle: item.taskTitle,
      chatId: item.chatId,
      modelId: item.modelId,
      reasoningId: item.reasoningId,
      collaborationMode: item.collaborationMode,
      steerTargetRunId: item.steerTargetRunId,
      steerTargetTurnId: item.steerTargetTurnId,
      ...(item.messageOrigin ? { messageOrigin: item.messageOrigin } : {}),
    };
  }

  const deferredInputController = new DeferredInputController({
    pendingInputs,
    queuedInputs,
    findStarted: async (item) => {
      const run = runCoordinator.activeRun({
        provider: item.provider,
        projectRoot: item.projectRoot,
        threadId: item.threadId,
      });
      if (deferredInputMatchesRun(item, run)) return run;
      if (!item.dispatchingAt || !item.clientUserMessageId) return null;
      const exactTurn = await agentProviders.call(
        item.provider,
        "findTurnByClientMessage",
        deferredTarget(item),
        item.clientUserMessageId,
      ).catch((error) => {
        logger.warn(`Cannot reconcile deferred provider turn ${item.clientUserMessageId}: ${error.message}`);
        return null;
      });
      const turnId = String(exactTurn?.id ?? exactTurn?.turnId ?? "").trim();
      if (!turnId) return null;
      let adopted;
      try {
        adopted = await managedRunLifecycle.adopt(item.input, {
          ...deferredTarget(item),
          clientUserMessageId: item.clientUserMessageId,
          telegramDeliveryRequested: item.telegramDeliveryRequested !== false,
          clientSource: item.clientSource,
          deferredInput: item,
        });
      } catch (error) {
        const concurrent = runCoordinator.activeRun(deferredTarget(item));
        if (deferredInputMatchesRun(item, concurrent)) return concurrent;
        throw error;
      }
      const previousTurnId = adopted.turnId;
      adopted.turnId = turnId;
      markProviderTurnAccepted(adopted, { turnId, provider: item.provider });
      taskRuns.reindex(adopted, { turnId: previousTurnId });
      await saveState();
      scheduleObservedRun(adopted);
      return adopted;
    },
    findSteered: async (item) => {
      if (!item.dispatchingAt || !item.clientUserMessageId) return null;
      const exactTurn = await agentProviders.call(
        item.provider,
        "findTurnByClientMessage",
        deferredTarget(item),
        item.clientUserMessageId,
      ).catch((error) => {
        logger.warn(`Cannot reconcile deferred provider steer ${item.clientUserMessageId}: ${error.message}`);
        return null;
      });
      const turnId = String(exactTurn?.id ?? exactTurn?.turnId ?? "").trim();
      if (!turnId) return null;
      const run = runCoordinator.activeRun(deferredTarget(item));
      return {
        accepted: true,
        steered: true,
        runId: run?.id ?? null,
        threadId: item.threadId,
        turnId,
        clientUserMessageId: item.clientUserMessageId,
      };
    },
    isSteerDispatchBlocked: (item) => Boolean(
      runCoordinator.admissionBarrier(deferredTarget(item)),
    ),
    steer: async (item) => {
      const target = deferredTarget(item);
      const existingRun = runCoordinator.activeRun(target);
      const externalActivity = existingRun
        ? { state: "active" }
        : await taskExternalActivity(target);
      if (!existingRun && externalActivity.state !== "active") return null;
      try {
        return await runCoordinator.steer({
          input: item.input,
          target,
          clientUserMessageId: item.clientUserMessageId,
        });
      } catch (error) {
        if (activeTurnNotSteerable(error)) return null;
        throw error;
      }
    },
    isBlocked: async (item) => {
      const target = deferredTarget(item);
      const occupancy = await runCoordinator.deferredOccupancy(target);
      return Boolean(runCoordinator.admissionBarrier(target)
        || occupancy.occupied
        || await runConflictPolicy.check(target));
    },
    occupancy: (item) => runCoordinator.deferredOccupancy(deferredTarget(item)),
    laneKey: (item) => runCoordinator.taskLane(deferredTarget(item)),
    // The queued item remains durable while RunCoordinator creates and persists
    // the exact managed run before invoking the provider launch operation.
    start: (item) => runCoordinator.startDeferred(item),
    onStateChange: updateDeferredDesktopReceipt,
    persist: () => saveState(),
    updateMessage: updateDeferredMessage,
    pendingKeyboard: (item) => pendingInputKeyboard(item.id, { allowForce: item.allowForce === true }),
    notifyReturned: (item) => item.telegramDeliveryRequested
      ? sendMessageTo(
        item.chatId,
        "Сообщение не потеряно и возвращено в сохранённые после ошибки запуска.",
      )
      : Promise.resolve(null),
    expire: async (item) => {
      await cleanupDeferredFiles(item);
      await updateDeferredMessage(
        item,
        `⌛ Сохранённое сообщение для потока «${item.taskTitle}» удалено: срок ожидания истёк.`,
      );
    },
    maxAgeMs: config.deferredInputTtlHours * 60 * 60 * 1000,
    expireCommands: runtimeStateStore ? () => runtimeStateStore.expireMessageCommands() : null,
    commandTrace,
  });

  if (runtimeStateStore) {
    runtimeStateStore.configureMessageCommandExpiry({
      isProtected: (record) => (
        runCoordinator.dispatchingClientMessageIds.has(record.clientUserMessageId)
        || [...pendingInputs.values(), ...queuedInputs.values()].some((item) => (
          item.clientUserMessageId === record.clientUserMessageId
          && deferredInputController.isProcessing(item.id)
        ))
        || taskRuns.values().some((run) => messageCommandMatchesRun(record, run))
      ),
      onExpired: (record) => deferredInputController.removeExpiredCommand(record),
    });
    runCoordinator.beforeDeferredDispatch = (item) => {
      runtimeStateStore.expireMessageCommands();
      if (item && runtimeStateStore.messageCommand(item.clientUserMessageId)?.result?.expired === true) {
        throw Object.assign(new Error("Срок жизни команды истёк (72 часа)."), {
          code: "MESSAGE_COMMAND_EXPIRED",
        });
      }
    };
  }

  function scheduleQueuedInput(item, delayMs = 2000) {
    deferredInputController.schedule(item, delayMs);
  }

  async function processQueuedInput(id) {
    return deferredInputController.process(id);
  }

  return {
    resolvedExplicitSkillNames,
    discardContextCompactionRun,
    taskExternalActivity,
    launchTurn,
    startTurn,
    cleanupDeferredFiles,
    updateDeferredMessage,
    updateDeferredDesktopReceipt,
    deferredInputController,
    scheduleQueuedInput,
    processQueuedInput,
  };
}
