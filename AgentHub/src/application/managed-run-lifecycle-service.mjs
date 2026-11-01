import path from "node:path";

import { createManagedTaskRun, taskRunKey, localExecutionIdentity } from "../domain/task-runs.mjs";
import { TASK_EXECUTION_OWNERS, taskExecutionRuntimeLabel } from "../domain/task-execution-owner.mjs";
import {
  interstreamDisplayText,
  interstreamOriginAuthor,
  normalizeInterstreamClientUserMessageId,
  normalizeInterstreamOrigin,
} from "../domain/interstream-message.mjs";
import { providerRunTerminalIdentity, providerRunTerminalStatusSupported } from "../domain/provider-run-terminal.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

async function tracedAdmissionStep(commandTrace, { commandId, transport, stage }, operation) {
  const span = commandTrace?.startBestEffortSpan?.({ commandId, stage, transport });
  try {
    const value = await operation();
    span?.finish({ outcome: "succeeded" });
    return value;
  } catch (error) {
    span?.finish({
      outcome: "failed",
      metadata: {
        errorCode: String(error?.code ?? "").slice(0, 96) || null,
        sqliteErrorCode: Number.isInteger(error?.errcode) ? error.errcode : null,
      },
    });
    throw error;
  }
}

function tracedAdmissionEnqueue(commandTrace, { commandId, transport, stage }, operation) {
  const span = commandTrace?.startBestEffortSpan?.({ commandId, stage, transport });
  try {
    operation();
    span?.finish({ outcome: "succeeded" });
  } catch (error) {
    span?.finish({
      outcome: "failed",
      metadata: {
        errorCode: String(error?.code ?? "").slice(0, 96) || null,
        sqliteErrorCode: Number.isInteger(error?.errcode) ? error.errcode : null,
      },
    });
    throw error;
  }
}

function localRetirementSpan(d, run, stage) {
  let span;
  try {
    span = d.commandTrace?.startBestEffortSpan?.({
      commandId: run.clientUserMessageId, stage, transport: "lifecycle", recordStarted: true,
      metadata: { runId: run.id, threadId: run.threadId, turnId: run.turnId },
    });
  } catch { /* Diagnostics cannot change lifecycle authority. */ }
  return outcome => {
    try { span?.finish({ outcome }); } catch { /* Best effort. */ }
  };
}

export function runInputPreview(input) {
  const text = typeof input === "string"
    ? input
    : input?.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  return String(text ?? "").trim();
}

export class ManagedRunLifecycleService {
  #d;
  #localRetirements = new WeakMap();
  #bootIdentity;

  constructor(dependencies = {}) {
    for (const name of [
      "currentTarget", "findProject", "codexSettings", "currentPreferences",
      "normalizeCodexModel", "modelLabel", "persistTaskDiff", "syncRun",
      "invalidateCatalog", "saveState", "scheduleProgressStart", "clearSelectedDiff",
      "clearApprovals", "pauseObservation", "pauseClaude", "stopTyping",
      "prepareAdmission", "revokeAdmission", "beforeCompletion", "completionAborted", "afterCompletion",
    ]) requiredFunction(dependencies[name], name);
    if (dependencies.recordProviderTerminal != null) {
      requiredFunction(dependencies.recordProviderTerminal, "recordProviderTerminal");
    }
    if (dependencies.readProviderTerminal != null) {
      requiredFunction(dependencies.readProviderTerminal, "readProviderTerminal");
    }
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
    const transport = String(target?.clientSource ?? "desktop-control").trim().toLowerCase()
      || "desktop-control";
    const admissionSpan = d.commandTrace?.startBestEffortSpan?.({
      commandId,
      stage: "admission",
      transport,
    });
    const current = d.currentTarget();
    const provider = target?.provider ?? current.provider;
    const projectRoot = target?.projectRoot ?? current.projectRoot;
    const project = d.findProject(projectRoot);
    const targetThreadId = target?.threadId ?? current.threadId;
    const taskTitle = target?.taskTitle ?? current.taskTitle;
    const admission = authorize ? await tracedAdmissionStep(d.commandTrace, {
      commandId, transport, stage: "admission-prepare",
    }, () => d.prepareAdmission({
      ...target,
      provider,
      projectRoot,
      threadId: targetThreadId,
      taskTitle,
    })) : null;
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
    const rawPrompt = runInputPreview(input);
    const run = createManagedTaskRun({
      streamId: target?.streamId ?? current.streamId ?? null,
      provider,
      chatId: target?.chatId ?? current.chatId,
      projectRoot,
      projectName: project?.name ?? path.basename(projectRoot),
      sessionCwd: target?.sessionCwd ?? null,
      threadId: targetThreadId,
      taskTitle,
      promptPreview: rawPrompt,
      rawPrompt,
      clientUserMessageId: normalizeInterstreamClientUserMessageId(target?.clientUserMessageId),
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
        text: interstreamDisplayText(run.promptPreview, {
          origin: messageOrigin,
          clientUserMessageId: run.clientUserMessageId,
        }),
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
    const deferredInput = target?.deferredInput;
    const previousDispatchingRunId = deferredInput?.dispatchingRunId;
    let admissionOperation = "invalidate-catalog";
    try {
      d.invalidateCatalog();
      admissionOperation = "persist-task-diff";
      await tracedAdmissionStep(d.commandTrace, {
        commandId, transport, stage: "admission-task-diff",
      }, () => d.persistTaskDiff(taskRunKey(run), "", {
        admission: true, commandId, transport, commandTrace: d.commandTrace,
      }));
      admissionOperation = "sync-run";
      d.clearSelectedDiff(run);
      run.gitBaseline = null;
      tracedAdmissionEnqueue(d.commandTrace, {
        commandId, transport, stage: "admission-sync-run-enqueue",
      }, () => {
        d.syncRun(run);
      });
      if (deferredInput) deferredInput.dispatchingRunId = run.id;
      admissionOperation = "save-state";
      await tracedAdmissionStep(d.commandTrace, {
        commandId, transport, stage: "admission-state-save",
      }, () => d.saveState());
    } catch (error) {
      admissionSpan?.finish({
        outcome: "failed",
        metadata: {
          operation: admissionOperation,
          errorCode: String(error?.code ?? "").slice(0, 96) || null,
          sqliteErrorCode: Number.isInteger(error?.errcode) ? error.errcode : null,
          runId: run.id,
        },
      });
      if (run.turnId) throw error;
      run.status = "failed";
      d.revokeAdmission(run);
      d.taskRuns.remove(run);
      if (deferredInput?.dispatchingRunId === run.id) {
        if (previousDispatchingRunId === undefined) delete deferredInput.dispatchingRunId;
        else deferredInput.dispatchingRunId = previousDispatchingRunId;
      }
      d.syncRun(run, { active: false });
      d.invalidateCatalog();
      try {
        await d.saveState();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Cannot persist failed run admission rollback", { cause: error });
      }
      throw error;
    }
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

  async retireLocalExecutionAfterReboot(run) {
    const d = this.#d;
    const provenance = d.taskRuns.restoredLocalExecution?.(run);
    if (!provenance || !d.localRetirementStore || !d.readSystemBootIdentity) return false;
    if (run.localAdmissionReleased === true) return true;
    if (this.#localRetirements.has(run)) return this.#localRetirements.get(run);
    const expected = JSON.stringify(provenance.identity);
    const current = () => d.taskRuns.forTask(run) === run
      && !run.completionPreparing && !run.completionPrepared
      && JSON.stringify(localExecutionIdentity(run)) === expected;
    if (!current()) return false;
    const pending = (async () => {
      const finishProof = localRetirementSpan(d, run, "local-execution-boot-proof");
      let boot;
      try {
        this.#bootIdentity ??= Promise.resolve().then(() => d.readSystemBootIdentity());
        boot = await this.#bootIdentity;
      } catch {
        this.#bootIdentity = null;
        finishProof("failed");
        return false; // Unavailable boot authority never clears a lane.
      }
      const bootTime = Date.parse(boot?.bootTime);
      const restoredAt = Date.parse(provenance.restoredAt);
      const times = [provenance.identity.startedAt, provenance.identity.requestedAt,
        provenance.identity.acceptedAt].map(Date.parse);
      if (boot?.source !== "Win32_OperatingSystem.LastBootUpTime"
        || !Number.isFinite(bootTime) || bootTime > restoredAt
        || times.some(time => !Number.isFinite(time) || time >= bootTime)
        || !current()) { finishProof("refused"); return false; }
      finishProof("succeeded");
      const finish = localRetirementSpan(d, run, "local-execution-retirement");
      try {
        const disposition = await d.localRetirementStore.recordLocalExecutionRetirement({
          identity: provenance.identity,
          proof: { kind: "system-restart-after-local-execution", source: boot.source,
            bootTime: new Date(bootTime).toISOString(), restoredAt: provenance.restoredAt },
        });
        if (!current() || !d.taskRuns.releaseLocalAdmission(run, disposition)) {
          finish("superseded");
          return false;
        }
        // The disposition is already durable. No provider terminal, command
        // outcome, accepted payload, raw history or after-turn maintenance changes.
        d.revokeAdmission(run);
        d.pauseObservation(run);
        d.invalidateCatalog();
        try { await d.saveState(); }
        finally { await d.afterLocalRetirement?.(run); }
        finish("succeeded");
        return true;
      } catch (error) {
        finish("failed");
        throw error;
      }
    })();
    this.#localRetirements.set(run, pending);
    try { return await pending; }
    finally { this.#localRetirements.delete(run); }
  }

  async releaseAdmission(run) {
    if (!run || run.admissionReleased === true) return;
    if (run.admissionReleasing) return run.admissionReleasing;
    const d = this.#d;
    d.revokeAdmission(run);
    const locallyRetired = run.localAdmissionReleased === true;
    run.admissionReleasing = (async () => {
      await this.markCompleted(run);
      if (run.completionPrepared !== true) return;
      d.taskRuns.remove(run);
      if (!d.taskRuns.size) d.stopTyping();
      try {
        await d.saveState();
      } finally {
        if (!locallyRetired && run.afterCompletionApplied !== true) {
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
      const locallyRetired = run.localAdmissionReleased === true;
      try {
        if (locallyRetired) {
          const identity = { provider: run.provider, threadId: run.threadId, turnId: run.turnId };
          const runId = run.id;
          const commandId = run.clientUserMessageId;
          const finish = localRetirementSpan(d, run, "local-retired-terminal-read");
          let terminal;
          try { terminal = await d.readProviderTerminal?.(identity); }
          catch (error) { finish("failed"); throw error; }
          if (run.localAdmissionReleased !== true || run.id !== runId || run.clientUserMessageId !== commandId
            || Object.keys(identity).some(key => run[key] !== identity[key])
            || d.taskRuns.forEvent?.({ ...identity }) !== run
            || Object.keys(identity).some(key => terminal?.[key] !== identity[key])
            || terminal?.payload?.completion?.runId !== runId
            || !Number.isSafeInteger(terminal?.terminalRevision) || terminal.terminalRevision < 1
            || !Number.isFinite(Date.parse(terminal?.committedAt ?? ""))
            || !providerRunTerminalStatusSupported(terminal?.status)) {
            finish("refused");
            return false;
          }
          finish("succeeded");
          run.providerTerminalStatus = terminal.status;
        } else await d.beforeCompletion(run);
        const terminal = providerRunTerminalIdentity(run);
        if (terminal) await d.recordProviderTerminal?.(terminal);
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
        if (!locallyRetired) await d.completionAborted(run);
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
