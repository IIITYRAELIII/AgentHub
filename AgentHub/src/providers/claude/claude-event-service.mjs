import { claudeStreamContextUsage } from "./claude.mjs";
import { claudeCompactionEvent } from "../../domain/claude-context-maintenance.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class ClaudeEventService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "isSelectedRun", "reindexRun", "setSelectedThread", "runTitle", "bindRunMessage",
      "retargetClientSelection", "saveState", "noteActivity", "scheduleProgress", "appendReasoning", "setStage",
      "appendActivity", "invalidateCatalog", "trackContextUsage",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  handle(run, parsed) {
    const d = this.#d;
    const compaction = claudeCompactionEvent(parsed.event);
    if (compaction) {
      d.observeCompaction?.(run, compaction);
      if (compaction.stage === "started") d.setStage(run, "Claude сворачивает контекст…");
      void d.saveState();
    }
    if (parsed.sessionId && parsed.sessionId !== run.threadId) {
      const previousThreadId = run.threadId;
      const wasSelected = d.isSelectedRun(run);
      run.sessionId = parsed.sessionId;
      run.threadId = parsed.sessionId;
      if (!run.taskTitle || ["Новая задача Claude", "Новый поток Claude"].includes(run.taskTitle)) {
        run.taskTitle = `Сессия Claude · ${parsed.sessionId.slice(0, 8)}`;
      }
      d.reindexRun(run, { threadId: previousThreadId });
      d.invalidateCatalog();
      d.retargetClientSelection(run, parsed.sessionId, d.runTitle(run));
      if (wasSelected) d.setSelectedThread(parsed.sessionId, d.runTitle(run));
      for (const messageId of run.progressMessageIds) {
        void d.bindRunMessage(run, { message_id: messageId }).catch((error) => {
          d.logError?.("Cannot bind Claude progress message:", error.message);
        });
      }
      void d.saveState();
    }
    if (parsed.textDelta) {
      run.responseText += parsed.textDelta;
      d.noteActivity(run);
      d.scheduleProgress(run);
    }
    const contextUsage = claudeStreamContextUsage(parsed.event, {
      fallbackModel: run.claudeObservedModel,
    });
    if (contextUsage) {
      run.claudeObservedModel = contextUsage.model;
      d.trackContextUsage(run, contextUsage);
    }
    if (parsed.thinkingDelta) d.appendReasoning(run, parsed.thinkingDelta);
    if (parsed.thinkingTokens != null) {
      run.claudeThinkingPeak = Math.max(Number(run.claudeThinkingPeak ?? 0), parsed.thinkingTokens);
      if (!run.responseText.trim()) d.setStage(run, `🧠 Claude размышляет (~${parsed.thinkingTokens} токенов)…`);
    }
    if (parsed.event?.type === "system" && parsed.event?.subtype === "api_retry") {
      const reason = parsed.event.error ? `: ${parsed.event.error}` : "";
      d.setStage(run, `Claude повторяет запрос (${parsed.event.attempt}/${parsed.event.max_retries})${reason}…`);
    }
    if (parsed.event?.type === "rate_limit_event" && parsed.event.rate_limit_info?.status === "rejected") {
      const resetAt = Number(parsed.event.rate_limit_info.resetsAt);
      const resetText = Number.isFinite(resetAt)
        ? new Date(resetAt * 1000).toLocaleString("ru-RU")
        : "неизвестно";
      run.claudeFailureText = `Исчерпан лимит Claude. Сброс: ${resetText}.`;
      d.setStage(run, run.claudeFailureText);
    }
    if (parsed.event?.type === "assistant" && parsed.event.error) {
      const messageText = parsed.event.message?.content
        ?.filter((item) => item?.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (messageText) run.claudeFailureText = messageText;
    }
    const streamEvent = parsed.event?.type === "stream_event" ? parsed.event.event : null;
    if (streamEvent?.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
      const toolName = String(streamEvent.content_block.name ?? "");
      d.setStage(run, `Claude использует инструмент ${toolName}…`);
      d.appendActivity(run, {
        id: `claude-tool:${streamEvent.content_block.id ?? toolName}`,
        type: "tool", label: "Используется инструмент", detail: toolName, status: "running",
      });
    }
  }
}
