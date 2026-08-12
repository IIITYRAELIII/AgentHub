import path from "node:path";

import { createManagedTaskRun, taskRunKey } from "../domain/task-runs.mjs";
import { TASK_EXECUTION_OWNERS, taskExecutionRuntimeLabel } from "../domain/task-execution-owner.mjs";

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
      "modelLabel", "captureGitBaseline", "persistTaskDiff", "syncRun",
      "invalidateCatalog", "saveState", "scheduleProgressStart", "clearSelectedDiff",
      "clearApprovals", "pauseObservation", "pauseClaude", "stopTyping",
      "beforeCompletion", "afterCompletion",
    ]) requiredFunction(dependencies[name], name);
    if (!dependencies.taskRuns?.add || !dependencies.taskRuns?.remove) {
      throw new TypeError("taskRuns registry is required");
    }
    this.#d = dependencies;
  }

  async begin(input, target = null) {
    const d = this.#d;
    const current = d.currentTarget();
    const provider = target?.provider ?? current.provider;
    const projectRoot = target?.projectRoot ?? current.projectRoot;
    const project = d.findProject(projectRoot);
    const targetThreadId = target?.threadId ?? current.threadId;
    const taskTitle = target?.taskTitle ?? current.taskTitle;
    if (provider === "claude" && targetThreadId) {
      d.clearClaudeCancellation?.({ provider, threadId: targetThreadId });
    }

    const savedCodexSettings = provider === "codex" ? d.codexSettings(target) ?? {} : {};
    const preferences = d.currentPreferences(provider);
    const modelId = target?.modelId ?? (provider === "codex"
      ? savedCodexSettings.model ?? (targetThreadId === current.threadId ? preferences.model : preferences.defaultModel)
      : preferences.model);
    const reasoningId = target?.reasoningId ?? (provider === "codex"
      ? savedCodexSettings.reasoningEffort
        ?? (targetThreadId === current.threadId ? preferences.reasoningEffort : preferences.defaultReasoningEffort)
      : preferences.reasoningEffort);
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
    });
    if (run.promptPreview) {
      run.userMessages = [{
        role: "user",
        ...(run.clientUserMessageId
          ? { clientUserMessageId: run.clientUserMessageId }
          : {}),
        text: run.promptPreview,
        time: run.startedAt,
      }];
    }
    d.taskRuns.add(run);
    d.invalidateCatalog();
    await d.persistTaskDiff(taskRunKey(run), "");
    d.clearSelectedDiff(run);
    run.gitBaseline = provider === "codex"
      ? null
      : await d.captureGitBaseline(run.projectRoot, run.id);
    d.syncRun(run);
    if (target?.deferredInput) target.deferredInput.dispatchingRunId = run.id;
    await d.saveState();
    if (run.displayRequested) d.scheduleProgressStart(run);
    return run;
  }

  async complete(run) {
    if (!run) return;
    const d = this.#d;
    await d.beforeCompletion(run);
    d.clearApprovals(run);
    d.pauseObservation(run);
    d.pauseClaude(run);
    d.taskRuns.remove(run);
    d.invalidateCatalog();
    run.status = "completed";
    run.process = null;
    d.syncRun(run, { active: false });
    if (!d.taskRuns.size) d.stopTyping();
    await d.saveState();
    await d.afterCompletion(run);
  }
}
