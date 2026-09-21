import { unlink } from "node:fs/promises";
import { emptyTokenUsage } from "../../domain/token-usage.mjs";
import {
  appendCodexAgentMessageDelta,
  completeCodexAgentMessage,
  hydrateCodexAgentMessages,
  startCodexAgentMessage,
} from "./codex-agent-message-reducer.mjs";
import {
  markProviderFirstEvent,
  markProviderTurnAccepted,
  markProviderTurnCompleted,
  markProviderTurnCompaction,
  markProviderTurnContent,
  markProviderTurnEvent,
} from "../../domain/task-runs.mjs";

function startsProviderResponse(method) {
  return String(method ?? "").startsWith("item/")
    || method === "turn/diff/updated"
    || method === "turn/completed";
}

function itemTelemetryPhase(item, compaction = false) {
  if (compaction) return "compaction";
  const type = String(item?.type ?? "").toLowerCase();
  const phase = String(item?.phase ?? "").toLowerCase();
  if (["analysis", "commentary", "reasoning"].includes(phase)) return "reasoning";
  if (type === "agentmessage") return "answering";
  if (/(command|tool|mcp|file|search|browser)/u.test(type)) return "tool";
  return "working";
}

function eventTelemetryPhase(method, params, isCompactionItem) {
  if (method === "turn/diff/updated") return "tool";
  if (method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") return "reasoning";
  if (method === "item/started") return itemTelemetryPhase(params.item, isCompactionItem(params.item));
  if (/requestApproval|requestUserInput|elicitation\/request/u.test(String(method ?? ""))) return "waiting-user";
  return "";
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function saveStateBestEffort(dependencies) {
  try {
    void Promise.resolve(dependencies.saveState()).catch((error) => {
      dependencies.logError?.("Cannot persist Codex event state:", error.message);
    });
  } catch (error) {
    dependencies.logError?.("Cannot persist Codex event state:", error.message);
  }
}

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function isCompactionOnlyContextMeasurement(params, compaction) {
  const turnId = String(params?.turnId ?? "").trim();
  const compactionTurnId = String(compaction?.turnId ?? "").trim();
  if (!turnId || !compactionTurnId || turnId !== compactionTurnId) return false;
  const last = params?.tokenUsage?.last ?? {};
  const billableTokens = [
    last.inputTokens,
    last.cachedInputTokens,
    last.outputTokens,
    last.reasoningOutputTokens,
  ].reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  return typeof last.totalTokens === "number"
    && Number.isFinite(last.totalTokens) && last.totalTokens >= 0
    && billableTokens === 0;
}

function contextUsagePercent(context) {
  const usedTokens = Math.max(0, Number(context?.usedTokens) || 0);
  const windowTokens = Math.max(0, Number(context?.modelContextWindow) || 0);
  return windowTokens ? (usedTokens / windowTokens) * 100 : null;
}

export class CodexEventService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "invalidateThreadRead", "forEvent", "reindexRun", "applyThreadSettings", "saveState",
      "trackTokenUsage", "mutateCompaction", "taskKey", "isSelectedRun", "setSelectedDiff", "appendActivity",
      "noteActivity", "scheduleProgress", "appendReasoning", "isCompactionItem",
      "upsertReasoningBlock", "replaceActivityGroups", "turnActivityGroups",
      "contextUsage", "beginCompaction", "getCompaction", "settleCompactionTurn",
      "rememberRawCompactionItem",
      "beginCompactionCleanup", "setStage", "describeItem",
      "itemActivity", "requestApproval", "formatCommandApproval", "formatFileApproval",
      "formatPermissionsApproval", "requestMcpElicitation", "discardContextCompaction",
      "requestUserInput", "reduceLiveItemEvent", "startLiveItem", "completeLiveItem",
      "consumeTracker", "finishObserved", "turnSnapshot", "completeManaged",
      "observeMcpProgress",
      "observeHubMcpBridge",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async handle(message) {
    const d = this.#d;
    const receivedAt = Date.now();
    const { method, params = {}, id } = message;
    if (params.threadId) d.invalidateThreadRead(params.threadId);
    if (method === "rawResponseItem/completed") {
      d.rememberRawCompactionItem(params.threadId, {
        turnId: params.turnId,
        item: params.item,
      });
    }
    if (id !== undefined && method) d.logError?.(`Codex server request received: ${method}`);
    const eventTurnId = params.turn?.id ?? params.turnId ?? null;
    const run = d.forEvent({
      turnId: eventTurnId,
      threadId: params.threadId,
      provider: "codex",
      allowThreadFallback: method === "turn/started",
    });
    if (run) {
      // A terminal snapshot can recover an item whose individual notification
      // was lost. Both observations share the durable question identity.
      const questionItems = method === "item/completed" ? [params.item]
        : method === "turn/completed" ? params.turn?.items ?? [] : [];
      for (const item of questionItems) {
        if (item?.type !== "agentMessage" || !item.questions?.length) continue;
        await d.requestUserInput(item.id, {
          asyncItem: item, threadId: params.threadId, turnId: eventTurnId,
        }, run);
      }
    }
    if (method !== "mcpServer/elicitation/request" && [
      "item/started",
      "item/completed",
      "turn/diff/updated",
      "turn/completed",
    ].includes(method)) {
      d.observeMcpProgress({
        threadId: params.threadId,
        turnId: eventTurnId,
        method,
      });
    }
    if (run && startsProviderResponse(method)) {
      const firstEvent = markProviderFirstEvent(run, {
        turnId: eventTurnId,
        method,
        occurredAt: params.startedAtMs ?? params.completedAtMs ?? Date.now(),
        provider: "codex",
      });
      if (firstEvent) saveStateBestEffort(d);
    }
    if (method === "thread/settings/updated") {
      d.applyThreadSettings(params.threadId, params.threadSettings);
      saveStateBestEffort(d);
    }
    if (method === "thread/status/changed" && run) {
      run.threadStatus = params.status ?? null;
      const flags = Array.isArray(params.status?.activeFlags) ? params.status.activeFlags : [];
      if (flags.includes("waitingOnApproval")) d.setStage(run, "Ожидается ответ пользователя…");
      saveStateBestEffort(d);
    }
    if (method === "turn/started") {
      const pendingCompaction = d.getCompaction(params.threadId);
      if (
        !run
        && eventTurnId
        && pendingCompaction?.status === "running"
        && !String(pendingCompaction.turnId ?? "").trim()
      ) {
        await d.beginCompaction(params.threadId, {
          origin: pendingCompaction.origin,
          turnId: eventTurnId,
          startedAt: params.startedAtMs,
          beforePercent: pendingCompaction.beforePercent,
        });
      }
      if (run && eventTurnId) {
        const previous = { turnId: run.turnId, threadId: run.threadId };
        run.turnId = eventTurnId;
        run.threadId = params.threadId ?? run.threadId;
        markProviderTurnAccepted(run, {
          turnId: eventTurnId,
          acceptedAt: params.startedAtMs ?? Date.now(),
          provider: "codex",
        });
        markProviderTurnEvent(run, {
          turnId: eventTurnId,
          method,
          occurredAt: params.startedAtMs ?? Date.now(),
          phase: "starting",
        });
        d.reindexRun(run, previous);
      }
      if (eventTurnId && !d.turnTokenUsage.has(eventTurnId)) {
        rememberBounded(d.turnTokenUsage, eventTurnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      if (run && eventTurnId) saveStateBestEffort(d);
    }
    if (
      run
      && eventTurnId
      && method !== "turn/started"
      && method !== "turn/completed"
      && params.agentHubHydrationReplay !== true
    ) {
      markProviderTurnEvent(run, {
        turnId: eventTurnId,
        method,
        occurredAt: params.startedAtMs ?? params.completedAtMs ?? Date.now(),
        phase: eventTelemetryPhase(method, params, d.isCompactionItem),
      });
    }
    if (method === "thread/tokenUsage/updated") {
      await d.mutateCompaction(params.threadId, () => {
        const compaction = d.getCompaction(params.threadId);
        d.trackTokenUsage(params, {
          // A standalone compaction reports an intermediate token count with no
          // billable input/output. It still belongs in turn accounting, but it
          // is a preliminary size estimate rather than exact model usage.
          // The compaction owner retains it separately from later user usage.
          provisionalContext: isCompactionOnlyContextMeasurement(params, compaction),
        });
      });
      saveStateBestEffort(d);
    }
    if (method === "turn/diff/updated" && run) {
      run.latestDiff = params.diff ?? run.latestDiff;
      d.taskDiffs.remember(d.taskKey(run), run.latestDiff);
      if (d.isSelectedRun(run)) d.setSelectedDiff(run.latestDiff);
      d.appendActivity(run, {
        id: `diff:${eventTurnId ?? run.turnId ?? run.id}`,
        type: "file",
        label: "Diff обновлён",
        detail: String(params.diff ?? "").split(/\r?\n/u).filter(Boolean).slice(0, 3).join(" · ").slice(0, 500),
        status: "completed",
      });
    }
    if (method === "item/agentMessage/delta" && run) {
      const delta = params.delta ?? "";
      const item = appendCodexAgentMessageDelta(run, {
        turnId: eventTurnId,
        itemId: params.itemId,
        delta,
        hydrationReplay: params.agentHubHydrationReplay === true,
      });
      if (["analysis", "commentary", "reasoning"].includes(String(item?.phase ?? ""))) {
        d.upsertReasoningBlock(run, { id: item.id, text: item.text });
      }
      if (delta && params.agentHubHydrationReplay !== true) {
        const reasoning = ["analysis", "commentary", "reasoning"].includes(String(item?.phase ?? ""));
        markProviderTurnContent(run, {
          turnId: eventTurnId,
          kind: reasoning ? "reasoning" : "answer",
          visible: !reasoning,
        });
      }
      if (delta) d.noteActivity(run);
      d.scheduleProgress(run);
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") && run) {
      d.appendReasoning(run, params.delta);
      d.upsertReasoningBlock(run, { id: params.itemId, delta: params.delta });
      if (params.delta && params.agentHubHydrationReplay !== true) {
        markProviderTurnContent(run, { turnId: eventTurnId, kind: "reasoning" });
      }
    }
    if (run) {
      const liveActivity = d.reduceLiveItemEvent(run, method, params);
      if (liveActivity) {
        d.appendActivity(run, liveActivity);
        d.noteActivity(run);
        d.scheduleProgress(run);
      }
    }
    if (method === "item/started") {
      if (d.isCompactionItem(params.item)) {
        if (run) markProviderTurnCompaction(run, {
          turnId: eventTurnId,
          stage: "started",
          occurredAt: params.startedAtMs ?? Date.now(),
        });
        await d.beginCompaction(params.threadId, {
          origin: "automatic",
          turnId: eventTurnId,
          itemId: params.item?.id,
          startedAt: params.startedAtMs,
          beforePercent: contextUsagePercent(d.contextUsage(params.threadId)),
        });
      }
      if (run) {
        const item = startCodexAgentMessage(run, { turnId: eventTurnId, item: params.item });
        if (["analysis", "commentary", "reasoning"].includes(String(item?.phase ?? ""))) {
          d.upsertReasoningBlock(run, { id: item.id, text: item.text });
        }
        d.startLiveItem(run, params.item);
        d.setStage(run, d.describeItem(params.item, false));
        const activity = d.itemActivity(params.item, false);
        if (activity) d.appendActivity(run, activity);
      }
    }
    if (method === "item/completed") {
      if (d.isCompactionItem(params.item)) {
        if (run) markProviderTurnCompaction(run, {
          turnId: eventTurnId,
          stage: "completed",
          occurredAt: params.completedAtMs ?? Date.now(),
        });
        await d.beginCompactionCleanup(params.threadId, {
          turnId: eventTurnId, itemId: params.item?.id, compactedAt: params.completedAtMs ?? receivedAt,
        });
      }
      if (run) {
        const item = completeCodexAgentMessage(run, { turnId: eventTurnId, item: params.item });
        if (["analysis", "commentary", "reasoning"].includes(String(item?.phase ?? ""))) {
          d.upsertReasoningBlock(run, { id: item.id, text: item.text });
        }
        d.completeLiveItem(run, params.item);
        d.setStage(run, d.describeItem(params.item, true));
        const activity = d.itemActivity(params.item, true);
        if (activity) d.appendActivity(run, activity);
        if (params.item?.type === "mcpToolCall") {
          const call = {
            id: String(params.item.id ?? "").trim(),
            server: String(params.item.server ?? "").trim(),
            tool: String(params.item.tool ?? "").trim(),
            status: params.item.error ? "failed" : "completed",
          };
          const calls = new Map((run.mcpCalls ?? []).map((item) => [item.id, item]));
          if (call.id) calls.set(call.id, call);
          run.mcpCalls = [...calls.values()];
          run.toolMetricsKnown = true;
        }
      }
      await d.observeHubMcpBridge({ method, item: params.item, run });
    }
    if (method === "thread/compacted") {
      const threadId = String(params.threadId ?? run?.threadId ?? "").trim();
      const modernItemAlreadyHandled = Boolean(d.getCompaction(threadId)?.itemId);
      await d.beginCompactionCleanup(threadId, { turnId: eventTurnId });
      if (run && !modernItemAlreadyHandled) d.appendActivity(run, {
        id: `compaction:${eventTurnId ?? run.turnId ?? run.id}`,
        type: "compaction", label: "Контекст свёрнут", status: "completed",
      });
    }

    if (method === "item/commandExecution/requestApproval") {
      d.appendActivity(run, {
        id: `approval:${id}`, type: "approval", label: "Ожидается разрешение на команду",
        detail: String(params.command ?? "").replace(/\s+/g, " ").slice(0, 500), status: "waiting",
      });
      await d.requestApproval(id, "command", params, d.formatCommandApproval(params, run), run);
    } else if (method === "item/fileChange/requestApproval") {
      d.appendActivity(run, {
        id: `approval:${id}`, type: "approval", label: "Ожидается разрешение на изменение файлов", status: "waiting",
      });
      await d.requestApproval(id, "file", params, d.formatFileApproval(params), run);
    } else if (method === "item/permissions/requestApproval") {
      d.appendActivity(run, {
        id: `approval:${id}`, type: "approval", label: "Ожидается разрешение",
        detail: String(params.reason ?? "").slice(0, 500), status: "waiting",
      });
      await d.requestApproval(id, "permissions", params, d.formatPermissionsApproval(params), run);
    } else if (method === "mcpServer/elicitation/request") {
      await d.requestMcpElicitation(id, params, run);
    } else if (method === "item/tool/requestUserInput") {
      d.appendActivity(run, {
        id: `input:${id}`,
        type: "approval",
        label: "Codex ожидает ответ пользователя",
        status: "waiting",
      });
      await d.requestUserInput(id, params, run);
    } else if (method === "turn/completed") {
      if (run) {
        markProviderTurnCompleted(run, {
          turnId: eventTurnId,
          completedAt: params.completedAtMs ?? Date.now(),
        });
      }
      const completedCompaction = params.turn?.items?.findLast?.((item) => d.isCompactionItem(item));
      if (completedCompaction) {
        await d.beginCompactionCleanup(params.threadId, {
          turnId: eventTurnId, itemId: completedCompaction.id, compactedAt: params.completedAtMs ?? receivedAt,
        });
      }
      await d.settleCompactionTurn(params.threadId, {
        turnId: eventTurnId,
        status: params.turn?.status,
      });
      if (run) {
        hydrateCodexAgentMessages(run, params.turn?.items, { turnId: eventTurnId });
        d.replaceActivityGroups(run, d.turnActivityGroups(params.turn));
      }
      if (!run) {
        d.turnTokenUsage.delete(eventTurnId);
        d.speechButtons.delete(eventTurnId);
        const temporaryFiles = d.temporaryFiles.get(eventTurnId) ?? [];
        d.temporaryFiles.delete(eventTurnId);
        await Promise.all(temporaryFiles.map((file) => (d.removeFile ?? ((value) => unlink(value).catch(() => {})))(file)));
        d.logWarn?.(`Completed Codex turn ${eventTurnId ?? "unknown"} has no registered task run`);
        return;
      }
      if (run.status !== "running") return;
      const completedTurnId = eventTurnId ?? run.turnId;
      if (await d.discardContextCompaction(run, completedTurnId)) return;
      if (run.observer === true) {
        const tracker = d.consumeTracker(completedTurnId);
        d.speechButtons.delete(completedTurnId);
        const temporaryFiles = d.temporaryFiles.get(completedTurnId) ?? [];
        d.temporaryFiles.delete(completedTurnId);
        await Promise.all(temporaryFiles.map((file) => (d.removeFile ?? ((value) => unlink(value).catch(() => {})))(file)));
        await d.finishObserved(run, {
          ...d.turnSnapshot(params.turn), turnId: completedTurnId,
          executionOwner: run.executionOwner, tokenTracker: tracker,
        });
        return;
      }
      await d.completeManaged(run, { eventTurn: params.turn, completedTurnId });
    }
  }
}
