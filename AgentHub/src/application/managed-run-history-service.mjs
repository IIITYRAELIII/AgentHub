import { isCodexContextProbeTurn } from "../domain/codex-context-probe.mjs";
import { providerTurnTelemetrySnapshot } from "../domain/task-runs.mjs";

export class ManagedRunHistoryService {
  constructor({
    taskSyncStore,
    mergeActiveHistory,
    hubExecutionOwner,
    nowIso,
    nowMs,
    telemetryStore = null,
    logger = console,
  }) {
    this.taskSyncStore = taskSyncStore;
    this.mergeActiveHistory = mergeActiveHistory;
    this.hubExecutionOwner = hubExecutionOwner;
    this.nowIso = nowIso;
    this.nowMs = nowMs;
    this.telemetryStore = telemetryStore;
    this.logger = logger;
  }

  async persist(run, {
    answer = "",
    status = "inProgress",
    active = true,
    turnId = run?.turnId,
  } = {}) {
    if (!run?.threadId || !turnId) return;
    if (run.provider === "codex" && isCodexContextProbeTurn({
      contextProbe: run.contextProbe,
      prompt: run.promptPreview,
      finalAnswer: answer || run.responseText,
      clientUserMessageId: run.clientUserMessageId,
      userMessages: run.userMessages,
    }, { allowTextFallback: false })) return;
    try {
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
        activities: run.activities,
        activityGroups: run.activityGroups,
        startedAt: run.startedAt,
        attachments: run.messageAttachments ?? [],
      });
      const current = history.findLast((item) => String(item?.id ?? "") === String(turnId));
      if (current) {
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
        if (telemetry) current.telemetry = structuredClone(telemetry);
        if (current.answer) {
          const messages = Array.isArray(current.messages) ? current.messages : [];
          const itemId = String(run.responseItemId ?? "").trim() || `${turnId}:agent:final`;
          const existing = messages.find((message) => (
            message.role === "agent" && String(message.itemId ?? "") === itemId
          ));
          if (existing) {
            existing.text = current.answer;
            existing.time = current.completedAt ?? existing.time;
          } else {
            messages.push({
              itemId,
              role: "agent",
              text: current.answer,
              ...(current.completedAt ? { time: current.completedAt } : {}),
            });
          }
          current.messages = messages;
        }
      }
      this.taskSyncStore.recordHistory(run, history, {
        active,
        turnId: active ? turnId : null,
        activityAtMs,
        stage: run.progressStage,
        answer: String(answer || run.responseText || "").trim(),
        executionOwner: active ? this.hubExecutionOwner : null,
      });
      await this.taskSyncStore.save();
      if (!active && telemetry && this.telemetryStore?.upsert) {
        await this.telemetryStore.upsert(telemetry);
      }
    } catch (error) {
      this.logger.error(`Cannot persist managed task history ${run.threadId}:`, error.message);
    }
  }
}
