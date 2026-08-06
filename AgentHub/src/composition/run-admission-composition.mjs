import { unlink } from "node:fs/promises";
import {
  deferredInputMatchesRun,
  pendingInputKeyboard,
} from "../domain/deferred-input.mjs";
import { DeferredInputController } from "../application/deferred-input-controller.mjs";

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
  logger = console,
}) {
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

  async function discardManualContextCompactionRun(run, turnId = run?.turnId) {
    if (!run || !contextCompactions.isManualTurn(run.threadId, turnId)) return false;
    const normalizedTurnId = String(turnId ?? "").trim();
    codexUsageTracker.deleteTurn(normalizedTurnId);
    turnSpeechButtons.delete(normalizedTurnId);
    const temporaryFiles = turnTemporaryFiles.get(normalizedTurnId) ?? [];
    turnTemporaryFiles.delete(normalizedTurnId);
    await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
    await taskProgress.clear(run);
    await managedRunLifecycle.complete(run);
    return true;
  }

  async function taskExternalActivity(target) {
    if (!target?.threadId) return { state: "inactive", executionOwner: null };
    try {
      return await agentProviders.call(target.provider, "readTaskActivity", target);
    } catch (error) {
      logger.error(`Cannot check ${target.provider} task activity:`, error.message);
      return { state: "unknown", executionOwner: taskExecutionOwners.EXTERNAL };
    }
  }

  async function launchTurn(run, input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
    return agentProviders.call(
      run.provider,
      "launchTurn",
      run,
      input,
      temporaryFiles,
      { forceSpeechButton },
    );
  }

  async function startTurn(input, temporaryFiles = [], {
    forceSpeechButton = false,
    target = null,
    allowRepositoryConflict = false,
    allowUnknownExternalActivity = false,
    persistentFiles = false,
    telegramDeliveryRequested = true,
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
    const result = await runCoordinator.start(input, temporaryFiles, {
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
    await Promise.all((item?.temporaryFiles ?? []).map((file) => unlink(file).catch(() => {})));
  }

  function updateDeferredMessage(...args) {
    return deferredInputPresentation.updateTelegramMessage(...args);
  }

  function updateDeferredDesktopReceipt(...args) {
    return deferredInputPresentation.updateDesktopReceipt(...args);
  }

  const deferredInputController = new DeferredInputController({
    pendingInputs,
    queuedInputs,
    findStarted: async (item) => {
      const run = taskRuns.forTask({
        provider: item.provider,
        projectRoot: item.projectRoot,
        threadId: item.threadId,
      });
      return deferredInputMatchesRun(item, run) ? run : null;
    },
    isBlocked: async (item) => {
      const target = {
        provider: item.provider,
        projectRoot: item.projectRoot,
        threadId: item.threadId,
        taskTitle: item.taskTitle,
        chatId: item.chatId,
        modelId: item.modelId,
        reasoningId: item.reasoningId,
        collaborationMode: item.collaborationMode,
      };
      const externalActivity = taskRuns.forTask(target)
        ? { state: "active" }
        : await taskExternalActivity(target);
      return Boolean(taskRuns.forTask(target)
        || externalActivity.state !== "inactive"
        || await runConflictPolicy.check(target));
    },
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
        `⌛ Сохранённое сообщение для задачи «${item.taskTitle}» удалено: срок ожидания истёк.`,
      );
    },
    maxAgeMs: config.deferredInputTtlHours * 60 * 60 * 1000,
  });

  function scheduleQueuedInput(item, delayMs = 2000) {
    deferredInputController.schedule(item, delayMs);
  }

  async function processQueuedInput(id) {
    return deferredInputController.process(id);
  }

  return {
    resolvedExplicitSkillNames,
    discardManualContextCompactionRun,
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
