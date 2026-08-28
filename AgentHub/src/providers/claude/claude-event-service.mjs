import { claudeStreamContextUsage } from "./claude.mjs";
import { claudeCompactionEvent } from "../../domain/claude-context-maintenance.mjs";
import {
  markProviderFirstEvent,
  markProviderTurnAccepted,
  markProviderTurnCompleted,
  markProviderTurnContent,
  markProviderTurnEvent,
} from "../../domain/task-runs.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function saveStateBestEffort(dependencies) {
  try {
    void Promise.resolve(dependencies.saveState()).catch((error) => {
      dependencies.logError?.("Cannot persist Claude event state:", error.message);
    });
  } catch (error) {
    dependencies.logError?.("Cannot persist Claude event state:", error.message);
  }
}

function claudeToolBlockStart(event) {
  const streamEvent = event?.type === "stream_event" ? event.event : null;
  return streamEvent?.type === "content_block_start"
    && streamEvent.content_block?.type === "tool_use";
}

/* Claude CLI не нумерует ходы RPC-методами, поэтому имя события собирается из
   его собственного типа. Оно попадает в телеметрию как firstEventMethod. */
function claudeEventMethod(event) {
  const type = String(event?.type ?? "").trim();
  if (!type) return "";
  if (type === "system") {
    const subtype = String(event.subtype ?? "").trim();
    return subtype ? `claude/system/${subtype}` : "claude/system";
  }
  if (type === "stream_event") {
    const inner = String(event.event?.type ?? "").trim();
    return inner ? `claude/stream/${inner}` : "claude/stream";
  }
  return `claude/${type}`;
}

/* Пустая фаза оставляет предыдущую: рядовое служебное событие не должно
   затирать «инструмент» или «ответ». */
function claudeTelemetryPhase(parsed) {
  if (claudeToolBlockStart(parsed.event)) return "tool";
  if (parsed.textDelta) return "answering";
  if (parsed.thinkingDelta || parsed.thinkingTokens != null) return "reasoning";
  return "";
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
    if (this.#trackTelemetry(run, parsed)) saveStateBestEffort(d);
    const compaction = claudeCompactionEvent(parsed.event);
    if (compaction) {
      d.observeCompaction?.(run, compaction);
      if (compaction.stage === "started") d.setStage(run, "Claude сворачивает контекст…");
      saveStateBestEffort(d);
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
      saveStateBestEffort(d);
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
    if (claudeToolBlockStart(parsed.event)) {
      const toolName = String(streamEvent.content_block.name ?? "");
      d.setStage(run, `Claude использует инструмент ${toolName}…`);
      d.appendActivity(run, {
        id: `claude-tool:${streamEvent.content_block.id ?? toolName}`,
        type: "tool", label: "Используется инструмент", detail: toolName, status: "running",
      });
    }
  }

  /* Замер связи с моделью для Claude. Codex получает приём хода отдельным
     ответом RPC, у CLI такого подтверждения нет: приёмом считается его первое
     событие (обычно system/init), а первым событием ответа — всё, что приходит
     после него. Возвращает true, когда состояние хода изменилось и его стоит
     сохранить. */
  #trackTelemetry(run, parsed) {
    const turnId = String(run?.turnId ?? "").trim();
    const method = claudeEventMethod(parsed.event);
    if (!turnId || !method) return false;
    let changed = false;
    if (String(run.providerStart?.state ?? "") === "requesting") {
      markProviderTurnAccepted(run, { turnId, provider: "claude" });
      changed = true;
    }
    if (parsed.event?.type === "system" && parsed.event?.subtype === "init") {
      markProviderTurnEvent(run, { turnId, method, phase: "starting" });
      return changed;
    }
    if (markProviderFirstEvent(run, { turnId, method, provider: "claude" })) changed = true;
    if (parsed.thinkingDelta || parsed.thinkingTokens != null) {
      markProviderTurnContent(run, { turnId, kind: "reasoning" });
    }
    if (parsed.textDelta) {
      markProviderTurnContent(run, { turnId, kind: "answer", visible: true });
    }
    if (parsed.event?.type === "result") {
      markProviderTurnCompleted(run, { turnId });
      return true;
    }
    markProviderTurnEvent(run, { turnId, method, phase: claudeTelemetryPhase(parsed) });
    return changed;
  }
}
