import { isCodexContextProbeTurn } from "../domain/codex-context-probe.mjs";
import { isClaudeCompactionRun } from "../domain/claude-context-maintenance.mjs";
import { providerTurnTelemetrySnapshot } from "../domain/task-runs.mjs";

export class ManagedRunHistoryService {
  constructor({
    taskSyncStore,
    mergeActiveHistory,
    hubExecutionOwner,
    nowIso,
    nowMs,
    telemetryStore = null,
    terminalCommits = null,
    commandTrace = null,
    logger = console,
  }) {
    this.taskSyncStore = taskSyncStore;
    this.mergeActiveHistory = mergeActiveHistory;
    this.hubExecutionOwner = hubExecutionOwner;
    this.nowIso = nowIso;
    this.nowMs = nowMs;
    this.telemetryStore = telemetryStore;
    this.terminalCommits = terminalCommits;
    this.commandTrace = commandTrace;
    this.logger = logger;
  }

  async persist(run, {
    answer = "",
    status = "inProgress",
    active = true,
    turnId = run?.turnId,
    terminalRevision = null,
  } = {}) {
    if (!run?.threadId || !turnId) return;
    // Служебная свёртка контекста Claude не является ходом разговора.
    if (isClaudeCompactionRun(run)) return;
    const contextProbe = run.provider === "codex" && isCodexContextProbeTurn({
      operationKind: run.operationKind,
      contextProbe: run.contextProbe,
      prompt: run.promptPreview,
      finalAnswer: answer || run.responseText,
      clientUserMessageId: run.clientUserMessageId,
      userMessages: run.userMessages,
    }, { allowTextFallback: false });
    if (contextProbe && (active || !Number.isSafeInteger(terminalRevision))) return;
    try {
      const committedTerminal = await this.terminalCommits?.get({
        provider: run.provider,
        threadId: run.threadId,
        turnId,
      });
      if (contextProbe) {
        if (committedTerminal?.terminalRevision !== terminalRevision
          || committedTerminal?.payload?.completion?.operationKind !== "probe"
          || committedTerminal?.payload?.completion?.contextProbe !== true) return;
        const history = this.taskSyncStore.history(run);
        let current = history.find((item) => String(item?.id ?? "") === String(turnId));
        if (!current) {
          current = { id: turnId };
          history.push(current);
        }
        current.operationKind = "probe";
        current.contextProbe = true;
        current.status = committedTerminal.status;
        current.completed = true;
        await this.taskSyncStore.recordHistory({
          provider: run.provider,
          threadId: run.threadId,
          projectRoot: run.projectRoot,
        }, history);
        await this.taskSyncStore.save();
        return { absorbed: false, terminalRevision };
      }
      if (active && committedTerminal) {
        return {
          absorbed: true,
          terminalRevision: committedTerminal.terminalRevision,
        };
      }
      const resolvedTerminalRevision = Number(terminalRevision)
        || Number(committedTerminal?.terminalRevision)
        || null;
      const activityAtMs = this.nowMs();
      const telemetry = providerTurnTelemetrySnapshot(run, {
        turnId,
        status,
        completedAtMs: active ? null : activityAtMs,
      });
      const history = this.taskSyncStore.history(run);
      this.mergeActiveHistory(history, {
        active: true,
        turnId,
        prompt: run.promptPreview,
        answer: run.responseText,
        clientUserMessageId: run.clientUserMessageId,
        userMessages: run.userMessages,
        responseItemId: run.responseItemId,
        responseAnnotationReferences: run.responseAnnotationReferences,
        activities: run.activities,
        activityGroups: run.activityGroups,
        startedAt: run.startedAt,
        attachments: run.messageAttachments ?? [],
      });
      const current = history.findLast((item) => String(item?.id ?? "") === String(turnId));
      if (current) {
        const responseAttachments = Array.isArray(run.responseAttachments)
          ? run.responseAttachments.map((attachment) => ({ ...attachment }))
          : [];
        current.active = active;
        current.completed = !active;
        current.status = status;
        current.answer = String(answer || run.responseText || "").trim();
        current.activities = Array.isArray(run.activities)
          ? run.activities.map((item) => ({ ...item }))
          : [];
        current.activityGroups = Array.isArray(run.activityGroups)
          ? structuredClone(run.activityGroups)
          : [];
        if (!active) current.completedAt = this.nowIso();
        if (resolvedTerminalRevision) current.terminalRevision = resolvedTerminalRevision;
        if (telemetry) current.telemetry = structuredClone(telemetry);
        if (current.answer || responseAttachments.length) {
          const messages = Array.isArray(current.messages) ? current.messages : [];
          const itemId = String(run.responseItemId ?? "").trim() || `${turnId}:agent:final`;
          const existing = messages.find((message) => (
            message.role === "agent" && String(message.itemId ?? "") === itemId
          ));
          if (existing) {
            existing.text = current.answer || existing.text || "Изображение";
            if (Array.isArray(run.responseAnnotationReferences)
              && run.responseAnnotationReferences.length) {
              existing.responseAnnotationReferences = structuredClone(
                run.responseAnnotationReferences,
              );
            }
            existing.time = current.completedAt ?? existing.time;
            if (responseAttachments.length) existing.attachments = responseAttachments;
          } else {
            messages.push({
              itemId,
              role: "agent",
              text: current.answer || "Изображение",
              ...(Array.isArray(run.responseAnnotationReferences)
                && run.responseAnnotationReferences.length
                ? { responseAnnotationReferences: structuredClone(run.responseAnnotationReferences) }
                : {}),
              ...(responseAttachments.length ? { attachments: responseAttachments } : {}),
              ...(current.completedAt ? { time: current.completedAt } : {}),
            });
          }
          current.messages = messages;
        }
      }
      await this.taskSyncStore.recordHistory(run, history, {
        active,
        turnId: active ? turnId : null,
        activityAtMs,
        stage: run.progressStage,
        answer: String(answer || run.responseText || "").trim(),
        executionOwner: active ? this.hubExecutionOwner : null,
        ...(resolvedTerminalRevision ? { terminalRevision: resolvedTerminalRevision } : {}),
      });
      await this.taskSyncStore.save();
      if (!active && telemetry && this.telemetryStore?.upsert) {
        // The canonical history already retains telemetry. Its optional query
        // index cannot hold terminal delivery or invalidate committed history.
        void Promise.resolve().then(() => this.telemetryStore.upsert(telemetry)).catch((error) => {
          this.logger.error(`Cannot index provider turn telemetry ${run.threadId}/${turnId}:`, error.message);
        });
      }
      if (!active && run.clientUserMessageId) {
        const transport = String(run.clientSource ?? "server-runtime").trim().toLowerCase() || "server-runtime";
        for (const [stage, observedAtMs] of [
          ["first-event", telemetry?.firstEventAtMs],
          ["first-content", telemetry?.firstContentAtMs],
          ["first-visible", telemetry?.firstVisibleAtMs],
        ]) {
          if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) continue;
          this.commandTrace?.recordBestEffort?.({
            commandId: run.clientUserMessageId,
            stage,
            outcome: "succeeded",
            transport,
            observedAtMs,
            metadata: { provider: run.provider, threadId: run.threadId, turnId },
          });
        }
        this.commandTrace?.recordBestEffort?.({
          commandId: run.clientUserMessageId,
          stage: "terminal-history",
          outcome: "succeeded",
          transport,
          metadata: { provider: run.provider, threadId: run.threadId, turnId, terminalRevision: resolvedTerminalRevision },
        });
      }
      return {
        absorbed: false,
        terminalRevision: resolvedTerminalRevision,
      };
    } catch (error) {
      this.logger.error(`Cannot persist managed task history ${run.threadId}:`, error.message);
      return { absorbed: false, failed: true, error: error.message };
    }
  }
}
