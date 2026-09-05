import path from "node:path";

import { createManagedTaskRun, taskRunKey } from "../domain/task-runs.mjs";
import { TASK_EXECUTION_OWNERS, taskExecutionRuntimeLabel } from "../domain/task-execution-owner.mjs";
import {
  interstreamOriginAuthor,
  normalizeInterstreamOrigin,
} from "../domain/interstream-message.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export function runInputPreview(input) {
  const text = typeof input === "string"
    ? input
    : input?.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  return String(text ?? "").trim();
}

export class ManagedRunLifecycleService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "currentTarget", "findProject", "codexSettings", "currentPreferences",
      "normalizeCodexModel", "modelLabel", "persistTaskDiff", "syncRun",
      "invalidateCatalog", "saveState", "scheduleProgressStart", "clearSelectedDiff",
      "clearApprovals", "pauseObservation", "pauseClaude", "stopTyping",
      "prepareAdmission", "revokeAdmission", "beforeCompletion", "completionAborted", "afterCompletion",
    ]) requiredFunction(dependencies[name], name);
    if (!dependencies.taskRuns?.add || !dependencies.taskRuns?.remove) {
      throw new TypeError("taskRuns registry is required");
    }
    this.#d = dependencies;
  }

  async begin(input, target = null) {
    return this.#begin(input, target, { authorize: true });
  }

  async adopt(input, target = null) {
    return this.#begin(input, target, { authorize: false });
  }

  async #begin(input, target, { authorize }) {
    const d = this.#d;
    const commandId = String(target?.clientUserMessageId ?? "").trim();
    const admissionSpan = d.commandTrace?.startBestEffortSpan?.({
      commandId,
      stage: "admission",
      transport: String(target?.clientSource ?? "desktop-control").trim().toLowerCase() || "desktop-control",
    });
    const current = d.currentTarget();
    const provider = target?.provider ?? current.provider;
    const projectRoot = target?.projectRoot ?? current.projectRoot;
    const project = d.findProject(projectRoot);
    const targetThreadId = target?.threadId ?? current.threadId;
    const taskTitle = target?.taskTitle ?? current.taskTitle;
    const admission = authorize ? await d.prepareAdmission({
      ...target,
      provider,
      projectRoot,
      threadId: targetThreadId,
      taskTitle,
    }) : null;
    if (provider === "claude" && targetThreadId) {
      d.clearClaudeCancellation?.({ provider, threadId: targetThreadId });
    }

    const savedCodexSettings = provider === "codex" ? d.codexSettings(target) ?? {} : {};
    const preferences = d.currentPreferences(provider);
    const requestedModelId = target?.modelId ?? (provider === "codex"
      ? savedCodexSettings.model ?? (targetThreadId === current.threadId ? preferences.model : preferences.defaultModel)
      : preferences.model);
    const modelId = provider === "codex" ? d.normalizeCodexModel(requestedModelId) : requestedModelId;
    const reasoningId = target?.reasoningId ?? (provider === "codex"
      ? savedCodexSettings.reasoningEffort
        ?? (targetThreadId === current.threadId ? preferences.reasoningEffort : preferences.defaultReasoningEffort)
      : preferences.reasoningEffort);
    const messageOrigin = normalizeInterstreamOrigin(target?.messageOrigin);
    const run = createManagedTaskRun({
      streamId: target?.streamId ?? current.streamId ?? null,
      provider,
      chatId: target?.chatId ?? current.chatId,
      projectRoot,
      projectName: project?.name ?? path.basename(projectRoot),
      sessionCwd: target?.sessionCwd ?? null,
      threadId: targetThreadId,
      taskTitle,
      promptPreview: runInputPreview(input),
      clientUserMessageId: String(target?.clientUserMessageId ?? "").trim() || null,
      model: provider === "codex" ? d.modelLabel(modelId) : d.claudeModelLabels?.[modelId],
      modelId,
      reasoning: d.reasoningLabels?.[reasoningId],
      reasoningId,
      executionOwner: TASK_EXECUTION_OWNERS.HUB,
      appServer: taskExecutionRuntimeLabel(TASK_EXECUTION_OWNERS.HUB),
      collaborationMode: target?.collaborationMode ?? preferences.collaborationMode,
      telegramDeliveryRequested: target?.telegramDeliveryRequested !== false,
      clientSource: String(target?.clientSource ?? "telegram").trim() || "telegram",
      ...(messageOrigin ? { messageOrigin } : {}),
    });
    admission?.commit?.(run);
    run.submittedAt = target?.deferredInput?.createdAt ?? target?.submittedAt ?? run.startedAt;
    if (run.promptPreview) {
      run.userMessages = [{
        role: "user",
        ...(run.clientUserMessageId
          ? { clientUserMessageId: run.clientUserMessageId }
          : {}),
        text: run.promptPreview,
        ...(messageOrigin ? {
          kind: "interstream",
          origin: structuredClone(messageOrigin),
          author: interstreamOriginAuthor(messageOrigin),
        } : {}),
        submittedAt: run.submittedAt,
        startedAt: run.startedAt,
        time: run.submittedAt,
      }];
    }
    d.taskRuns.add(run);
    d.invalidateCatalog();
    await d.persistTaskDiff(taskRunKey(run), "");
    d.clearSelectedDiff(run);
    run.gitBaseline = null;
    d.syncRun(run);
    if (target?.deferredInput) target.deferredInput.dispatchingRunId = run.id;
    await d.saveState();
    admissionSpan?.finish({
      outcome: "succeeded",
      metadata: { runId: run.id, provider: run.provider, threadId: run.threadId },
    });
    if (run.displayRequested) d.scheduleProgressStart(run);
    return run;
  }

  async complete(run) {
    return this.releaseAdmission(run);
  }

  async releaseAdmission(run) {
    if (!run || run.admissionReleased === true) return;
    if (run.admissionReleasing) return run.admissionReleasing;
    const d = this.#d;
    d.revokeAdmission(run);
    run.admissionReleasing = (async () => {
      await this.markCompleted(run);
      d.taskRuns.remove(run);
      if (!d.taskRuns.size) d.stopTyping();
      try {
        await d.saveState();
      } finally {
        if (run.afterCompletionApplied !== true) {
          run.afterCompletionApplied = true;
          await d.afterCompletion(run);
        }
      }
      run.admissionReleased = true;
    })();
    try {
      await run.admissionReleasing;
    } finally {
      delete run.admissionReleasing;
    }
  }

  async markCompleted(run) {
    if (!run || run.completionPrepared === true) return;
    if (run.completionPreparing) return run.completionPreparing;
    const d = this.#d;
    run.completionPreparing = (async () => {
      try {
        await d.beforeCompletion(run);
        d.clearApprovals(run);
        d.pauseObservation(run);
        d.pauseClaude(run);
        run.status = "completed";
        run.process = null;
        d.syncRun(run, { active: false });
        d.invalidateCatalog();
        await d.saveState();
        run.completionPrepared = true;
      } catch (error) {
        await d.completionAborted(run);
        throw error;
      }
    })();
    try {
      await run.completionPreparing;
    } finally {
      delete run.completionPreparing;
    }
  }
}
