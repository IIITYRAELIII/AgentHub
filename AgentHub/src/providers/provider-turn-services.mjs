import { unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildCodexApplicationContext, buildCodexCollaborationMode } from "./codex/codex-settings.mjs";
import {
  activeTurnMissing,
  interruptCodexTurnWithRecovery,
  startCodexTurnWithRecovery,
  steerCodexTurnWithRecovery,
} from "./codex/codex-recovery.mjs";
import { codexThreadSandboxSettings, codexTurnSandboxSettings } from "./codex/codex-sandbox.mjs";
import { emptyTokenUsage } from "../domain/token-usage.mjs";
import { estimateCodexContextBreakdown } from "../domain/context-usage-breakdown.mjs";
import { markProviderTurnAccepted, markProviderTurnRequested } from "../domain/task-runs.mjs";
import { rememberProviderRunTerminalStatus } from "../domain/provider-run-terminal.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function codexInputItems(input) {
  const values = typeof input === "string" ? [{ type: "text", text: input }] : input;
  return (Array.isArray(values) ? values : []).filter((item) => item?.type !== "localFile");
}

function codexTurnHasUserInput(turn) {
  if ((Array.isArray(turn?.userMessages) ? turn.userMessages : []).length) return true;
  if (String(turn?.prompt ?? "").trim()) return true;
  return (Array.isArray(turn?.items) ? turn.items : [])
    .some((item) => item?.type === "userMessage");
}

export const CODEX_TURN_NOT_MATERIALIZED = "ERR_CODEX_TURN_NOT_MATERIALIZED";
export const CODEX_TURN_START_UNCONFIRMED = "ERR_CODEX_TURN_START_UNCONFIRMED";

function turnNotMaterializedError(turnId) {
  const error = new Error(
    turnId
      ? `Codex App Server принял запуск Turn ${turnId}, но не добавил его в Thread`
      : "Codex App Server принял запуск, но не вернул Turn",
  );
  error.code = CODEX_TURN_NOT_MATERIALIZED;
  return error;
}

function acceptedProviderTurn(run) {
  const turnId = String(run?.turnId ?? "").trim();
  const receiptTurnId = String(run?.providerStart?.turnId ?? "").trim();
  return Boolean(
    turnId
      && receiptTurnId === turnId
      && ["accepted-awaiting-first-event", "observed"].includes(run.providerStart?.state),
  );
}

function runAcceptsProviderResult(run) {
  return run?.admissionReleased !== true
    && !["completed", "failed", "cancelled"].includes(String(run?.status ?? "running"));
}

function turnClientMessageIds(turn) {
  return [
    turn?.clientUserMessageId,
    turn?.clientId,
    ...(Array.isArray(turn?.userMessages) ? turn.userMessages.flatMap((message) => [
      message?.clientUserMessageId,
      message?.clientId,
    ]) : []),
    ...(Array.isArray(turn?.items) ? turn.items.flatMap((item) => (
      item?.type === "userMessage" ? [item?.clientUserMessageId, item?.clientId] : []
    )) : []),
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
}

export function exactTurnForClientMessage(result, clientUserMessageId) {
  const expected = String(clientUserMessageId ?? "").trim();
  if (!expected) return null;
  const thread = result?.thread ?? result;
  return (Array.isArray(thread?.turns) ? thread.turns : [])
    .find((turn) => turnClientMessageIds(turn).includes(expected)) ?? null;
}

function unconfirmedTurnStartError(error) {
  const failure = new Error(
    "Codex мог принять сообщение, но подтверждение запуска потеряно. Автоматический повтор запрещён.",
    { cause: error },
  );
  failure.code = CODEX_TURN_START_UNCONFIRMED;
  failure.deliveryOutcome = "unknown";
  failure.uncertain = true;
  return failure;
}

function ambiguousTurnStart(error) {
  return error?.deliveryOutcome === "unknown" || error?.uncertain === true;
}

function activeTurnIdentityChanged(error) {
  const details = `${String(error?.message ?? "")} ${JSON.stringify(error?.data ?? {})}`.toLowerCase();
  return details.includes("expected active turn id") || details.includes("expectedturnid");
}

export async function waitForCodexTurnMaterialization({
  readThread,
  threadId,
  turnId,
  timeoutMs = 10_000,
  pollMs = 1_000,
  sleep = delay,
}) {
  const expectedTurnId = String(turnId ?? "").trim();
  if (!expectedTurnId) throw turnNotMaterializedError("");
  const intervalMs = Math.max(1, Number(pollMs) || 1_000);
  const attempts = Math.max(1, Math.ceil(Math.max(0, Number(timeoutMs) || 0) / intervalMs) + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await readThread(threadId, {
        fresh: true,
        includeTurns: true,
        priority: "interactive",
        turnLimit: 8,
        turnPageSize: 8,
      });
      const thread = response?.thread ?? response;
      const materialized = (Array.isArray(thread?.turns) ? thread.turns : [])
        .some((turn) => (
          String(turn?.id ?? "").trim() === expectedTurnId
          && codexTurnHasUserInput(turn)
        ));
      if (materialized) return expectedTurnId;
    } catch {
      // A transient read failure is indistinguishable from delayed materialization here.
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw turnNotMaterializedError(expectedTurnId);
}

export class CodexTurnService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "sendRpc", "sandboxMode", "compactionRecycle", "resolvedSkillNames", "reindexRun",
      "saveState", "startTyping", "scheduleObservedRun", "finishProgress", "completeRun",
      "readThread", "developerInstructions",
    ]) requiredFunction(dependencies[name], name);
    this.#d = { ...dependencies };
  }

  async launch(run, input, temporaryFiles = [], { forceSpeechButton = false } = {}) {
    const d = this.#d;
    let providerAccepted = false;
    let turnStartAttempted = false;
    let rpcSpan = null;
    const recycle = d.compactionRecycle();
    if (recycle) await recycle;
    const items = codexInputItems(input);
    run.skillsUsed = await d.resolvedSkillNames(input, run.projectRoot);
    run.mcpCalls = [];
    run.toolMetricsKnown = true;
    try {
      const namedTitle = await d.ensureThreadNamed?.({ provider: "codex", threadId: run.threadId });
      if (namedTitle) run.taskTitle = namedTitle;
      const developerInstructions = await d.developerInstructions({
        provider: "codex",
        threadId: run.threadId,
        streamId: run.streamId,
      });
      const applicationContext = buildCodexApplicationContext(developerInstructions, run.id);
      markProviderTurnRequested(run, { provider: "codex" });
      await d.saveState();
      rpcSpan = d.commandTrace?.startBestEffortSpan?.({
        commandId: String(run.clientUserMessageId ?? ""),
        stage: "provider-rpc",
        transport: "codex-app-server",
        metadata: { provider: "codex", runId: run.id, threadId: run.threadId },
      });
      const result = await startCodexTurnWithRecovery({
        threadId: run.threadId,
        startTurn: () => {
          turnStartAttempted = true;
          return d.sendRpc("turn/start", {
            threadId: run.threadId,
            input: items,
            clientUserMessageId: run.clientUserMessageId ?? undefined,
            model: run.modelId,
            effort: run.reasoningId,
            additionalContext: applicationContext,
            collaborationMode: buildCodexCollaborationMode({
              mode: run.collaborationMode,
              model: run.modelId,
              reasoningEffort: run.reasoningId,
            }),
            ...codexTurnSandboxSettings(d.sandboxMode(), run.projectRoot),
          });
        },
        resume: (params) => d.sendRpc("thread/resume", {
          ...params,
          ...codexThreadSandboxSettings(d.sandboxMode()),
        }),
        rollback: (params) => d.sendRpc("thread/rollback", params),
      });
      const turnId = String(result?.turn?.id ?? result?.turnId ?? "").trim();
      if (!turnId) throw turnNotMaterializedError("");
      rpcSpan?.finish({ outcome: "succeeded", metadata: { turnId } });
      if (!runAcceptsProviderResult(run)) return;
      const previousTurnId = run.turnId;
      run.turnId = turnId;
      markProviderTurnAccepted(run, { turnId, provider: "codex" });
      d.commandTrace?.recordBestEffort?.({
        commandId: String(run.clientUserMessageId ?? ""),
        stage: "provider-accept",
        outcome: "succeeded",
        transport: "codex-app-server",
        metadata: { provider: "codex", runId: run.id, threadId: run.threadId, turnId },
      });
      providerAccepted = true;
      d.reindexRun(run, { turnId: previousTurnId });
      d.speechButtons.set(run.turnId, forceSpeechButton);
      if (temporaryFiles.length) d.temporaryFiles.set(run.turnId, temporaryFiles);
      if (!d.turnTokenUsage.has(run.turnId)) {
        rememberBounded(d.turnTokenUsage, run.turnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      d.turnTokenUsage.get(run.turnId).contextBreakdown = {
        ...estimateCodexContextBreakdown({
          developerInstructions,
          input,
          skills: run.skillsUsed,
        }),
        threadId: run.threadId,
        turnId: run.turnId,
      };
      await d.saveState();
      if (run.displayRequested) d.startTyping();
      d.scheduleObservedRun(run);
      void waitForCodexTurnMaterialization({
        readThread: d.readThread,
        threadId: run.threadId,
        turnId,
        timeoutMs: d.turnMaterializationTimeoutMs,
        pollMs: d.turnMaterializationPollMs,
        sleep: d.sleep,
      }).then(async () => {
        if (String(run.providerStart?.turnId ?? "") !== turnId) return;
        run.providerStart = { ...run.providerStart, materializedAt: new Date().toISOString() };
        await d.saveState();
      }).catch((error) => {
        d.logWarn?.(`Codex Turn ${turnId} принят, но его Thread-проекция пока не подтверждена:`, error);
      });
    } catch (error) {
      rpcSpan?.finish({
        outcome: turnStartAttempted && ambiguousTurnStart(error) ? "unknown" : "failed",
        metadata: { errorCode: error?.code ?? null },
      });
      if (providerAccepted || acceptedProviderTurn(run)) {
        d.logError?.(`Codex Turn ${run.turnId} уже принят; повторный запуск запрещён:`, error);
        try {
          await d.saveState();
        } catch (saveError) {
          d.logError?.(`Не удалось повторно сохранить принятый Codex Turn ${run.turnId}:`, saveError);
        }
        if (run.status === "running") {
          if (run.displayRequested) d.startTyping();
          d.scheduleObservedRun(run);
        }
        return;
      }
      if (turnStartAttempted && ambiguousTurnStart(error)) {
        let exactTurn = null;
        try {
          exactTurn = exactTurnForClientMessage(
            await d.readThread(run.threadId, {
              fresh: true,
              includeTurns: true,
              priority: "interactive",
              turnLimit: 8,
              turnPageSize: 8,
            }),
            run.clientUserMessageId,
          );
        } catch (reconciliationError) {
          d.logWarn?.("Не удалось сверить неопределённый запуск Codex:", reconciliationError);
        }
        if (acceptedProviderTurn(run)) {
          if (run.status === "running") d.scheduleObservedRun(run);
          return;
        }
        if (exactTurn?.id && runAcceptsProviderResult(run)) {
          const previousTurnId = run.turnId;
          run.turnId = String(exactTurn.id);
          markProviderTurnAccepted(run, { turnId: run.turnId, provider: "codex" });
          d.commandTrace?.recordBestEffort?.({
            commandId: String(run.clientUserMessageId ?? ""),
            stage: "provider-accept",
            outcome: "succeeded",
            transport: "codex-app-server",
            metadata: { provider: "codex", runId: run.id, threadId: run.threadId, turnId: run.turnId, reconciled: true },
          });
          d.reindexRun(run, { turnId: previousTurnId });
          await d.saveState();
          if (run.displayRequested) d.startTyping();
          d.scheduleObservedRun(run);
          return;
        }
        run.providerStart = {
          ...run.providerStart,
          state: "unconfirmed",
          failedAt: new Date().toISOString(),
        };
        await d.saveState();
        error = unconfirmedTurnStartError(error);
      }
      await Promise.all(temporaryFiles.map((file) => (d.removeFile ?? ((value) => unlink(value).catch(() => {})))(file)));
      await d.finishProgress(run, `Ошибка запуска: ${error.message}`);
      await d.completeRun(run);
      throw error;
    }
  }

  async steer({ run, target, input, clientUserMessageId }) {
    let turnId = await this.#registeredTurnId(target, run) ?? await this.#exactTurnId(target);
    if (!turnId) throw new Error("Текущий ход уже нельзя изменить; сообщение осталось в очереди");
    let request = {
      threadId: target.threadId,
      expectedTurnId: turnId,
      input: codexInputItems(input),
      clientUserMessageId,
    };
    let result;
    try {
      result = await this.#steerRequest(target, request);
    } catch (error) {
      if (!activeTurnIdentityChanged(error)) throw error;
      const refreshedTurnId = await this.#exactTurnId(target);
      if (!refreshedTurnId || refreshedTurnId === turnId) throw error;
      turnId = refreshedTurnId;
      request = { ...request, expectedTurnId: turnId };
      result = await this.#steerRequest(target, request);
    }
    const acceptedTurnId = String(result?.turnId ?? turnId).trim() || turnId;
    if (run && String(run.turnId ?? "").trim() !== acceptedTurnId) {
      const previousTurnId = run.turnId;
      run.turnId = acceptedTurnId;
      this.#d.reindexRun(run, { turnId: previousTurnId });
      await this.#d.saveState();
    }
    return { turnId: acceptedTurnId };
  }

  async #registeredTurnId(target, run) {
    const turnId = String(run?.turnId ?? "").trim();
    if (!turnId) return null;
    return turnId;
  }

  #steerRequest(target, request) {
    return steerCodexTurnWithRecovery({
      threadId: target.threadId,
      steer: () => this.#d.sendRpc("turn/steer", request),
      resume: ({ threadId }) => this.#d.sendRpc("thread/resume", {
        threadId,
        ...codexThreadSandboxSettings(this.#d.sandboxMode()),
      }),
    });
  }

  async findByClientMessage(target, clientUserMessageId) {
    const result = await this.#d.readThread(target.threadId, {
      fresh: true,
      includeTurns: true,
      priority: "interactive",
      turnLimit: 8,
      turnPageSize: 8,
    });
    return exactTurnForClientMessage(result, clientUserMessageId);
  }

  async interrupt(run) {
    return interruptCodexTurnWithRecovery({
      threadId: run.threadId,
      turnId: run.turnId,
      interrupt: (params) => this.#d.sendRpc("turn/interrupt", params),
      resume: ({ threadId }) => this.#d.sendRpc("thread/resume", {
        threadId,
        ...codexThreadSandboxSettings(this.#d.sandboxMode()),
      }),
    });
  }

  async #exactTurnId(target) {
    const result = await this.#d.readThread(target.threadId, {
      fresh: true,
      includeTurns: true,
      priority: "interactive",
      turnLimit: 8,
      turnPageSize: 8,
    });
    const thread = result?.thread ?? result;
    const active = (Array.isArray(thread?.turns) ? thread.turns : [])
      .filter((turn) => ["inProgress", "in_progress", "running"].includes(String(turn?.status ?? "")));
    if (active.length === 1) {
      const turnId = String(active[0]?.id ?? "").trim();
      return turnId || null;
    }
    if (active.length > 1) throw new Error("В потоке выполняется несколько ходов; выбрать ход для изменения нельзя");
    return null;
  }
}

export class ProviderCancellationService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "interruptCodex", "runForTask", "completeRun", "readCodexSnapshot",
      "finishObserved", "completeManaged", "taskExternalActivity", "stopClaudeRun",
      "processIsAlive", "claudeCancellationKey", "saveState",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async cancelCodex(run) {
    try {
      await this.#d.interruptCodex(run);
      return { accepted: true, stopRequested: true, message: "Запрошена остановка этого потока." };
    } catch (error) {
      this.#d.logWarn?.(`Cannot interrupt Codex task ${run.threadId}:`, error.message);
      return {
        ...await this.#codexInterruptFailure(run, error),
        interruptFailed: true,
        stopRequested: false,
      };
    }
  }

  async cancelClaude(run) {
    const d = this.#d;
    if (run.observer) return { accepted: true, stopRequested: false };
    if (run.process || d.processIsAlive(run.pid)) {
      if (!await d.stopClaudeRun(run)) throw new Error("Не удалось остановить дерево процессов Claude");
      rememberProviderRunTerminalStatus(run, "aborted");
      rememberBounded(d.cancelledClaudeTasks, d.claudeCancellationKey(run), Date.now(), 200);
      await d.saveState();
      return { accepted: true, stopRequested: true, message: "Запрошена остановка этого потока." };
    }
    return {
      accepted: false,
      detach: true,
      stopRequested: false,
      message: "Отключил наблюдение. Остановить внешний процесс Claude из этой сессии Agent Hub не может.",
    };
  }

  async #codexInterruptFailure(run, error) {
    const d = this.#d;
    const activity = await d.taskExternalActivity(run);
    if (activity.state === "inactive") {
      const reconciled = await this.#reconcileInactiveCodexRun(run);
      return {
        accepted: reconciled,
        message: reconciled
          ? "Ход уже завершён или остановлен; состояние синхронизировано"
          : "Ход уже завершён или остановлен; состояние обновляется",
      };
    }
    if (run.observer || activeTurnMissing(error)) {
      return {
        accepted: false,
        message: "Ход выполняется в другом окне Codex. Остановите его в том окне; наблюдение Agent Hub сохранено",
      };
    }
    return { accepted: false, message: "Codex не подтвердил остановку. Наблюдение и блокировка потока сохранены" };
  }

  async #reconcileInactiveCodexRun(run) {
    const d = this.#d;
    if (d.runForTask(run) !== run) return true;
    if (["finishing", "completed"].includes(run.status)) {
      await d.completeRun(run);
      return true;
    }
    try {
      const snapshot = await d.readCodexSnapshot(run, { fresh: true });
      if (d.runForTask(run) !== run) return true;
      if (snapshot) {
        const terminal = {
          ...snapshot,
          active: false,
          completed: true,
          status: snapshot.completed ? snapshot.status : "interrupted",
          stage: snapshot.completed ? snapshot.stage ?? "Поток завершён." : "Поток остановлен или неактивен.",
        };
        if (run.observer) await d.finishObserved(run, terminal);
        else await d.completeManaged(run, { snapshot: terminal });
      }
    } catch (error) {
      d.logError?.(`Cannot reconcile inactive Codex task ${run.threadId}:`, error.message);
    } finally {
      if (d.runForTask(run) === run) await d.completeRun(run);
    }
    return d.runForTask(run) !== run;
  }
}

export function unsupportedProviderSteer() {
  throw new Error("Отправка в текущий ход недоступна для выбранного агента");
}
