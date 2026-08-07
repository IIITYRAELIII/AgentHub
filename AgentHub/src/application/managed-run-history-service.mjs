import { isCodexContextProbeTurn } from "../domain/codex-context-probe.mjs";

export class ManagedRunHistoryService {
  constructor({ taskSyncStore, mergeActiveHistory, hubExecutionOwner, nowIso, nowMs, logger = console }) {
    this.taskSyncStore = taskSyncStore;
    this.mergeActiveHistory = mergeActiveHistory;
    this.hubExecutionOwner = hubExecutionOwner;
    this.nowIso = nowIso;
    this.nowMs = nowMs;
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
      prompt: run.promptPreview,
      finalAnswer: answer || run.responseText,
      clientUserMessageId: run.clientUserMessageId,
      userMessages: run.userMessages,
    })) return;
    try {
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
        if (!active) current.completedAt = this.nowIso();
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
        activityAtMs: this.nowMs(),
        stage: run.progressStage,
        answer: String(answer || run.responseText || "").trim(),
        executionOwner: active ? this.hubExecutionOwner : null,
      });
      await this.taskSyncStore.save();
    } catch (error) {
      this.logger.error(`Cannot persist managed task history ${run.threadId}:`, error.message);
    }
  }
}
