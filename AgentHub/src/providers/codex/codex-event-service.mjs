import { unlink } from "node:fs/promises";
import { emptyTokenUsage } from "../../domain/token-usage.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import {
  appendCodexAgentMessageDelta,
  completeCodexAgentMessage,
  hydrateCodexAgentMessages,
  startCodexAgentMessage,
} from "./codex-agent-message-reducer.mjs";
import { markProviderFirstEvent, markProviderTurnAccepted } from "../../domain/task-runs.mjs";

function startsProviderResponse(method) {
  return String(method ?? "").startsWith("item/")
    || method === "turn/diff/updated"
    || method === "turn/completed";
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
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
  return Math.max(0, Number(last.totalTokens) || 0) > 0 && billableTokens === 0;
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
      "trackTokenUsage", "completeTurn", "taskKey", "isSelectedRun", "setSelectedDiff", "appendActivity",
      "noteActivity", "scheduleProgress", "appendReasoning", "isCompactionItem",
      "upsertReasoningBlock", "replaceActivityGroups", "turnActivityGroups",
      "contextUsage", "beginCompaction", "getCompaction", "rememberRawCompactionItem",
      "beginCompactionCleanup", "setStage", "describeItem",
      "itemActivity", "requestApproval", "formatCommandApproval", "formatFileApproval",
      "formatPermissionsApproval", "requestMcpElicitation", "discardContextCompaction",
      "requestUserInput", "reduceLiveItemEvent", "startLiveItem", "completeLiveItem",
      "consumeTracker", "finishObserved", "turnSnapshot", "completeManaged",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async handle(message) {
    const d = this.#d;
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
    const contextProbe = isCodexContextProbeTurn(params.turn);
    const run = contextProbe
      ? null
      : d.forEvent({
        turnId: eventTurnId,
        threadId: params.threadId,
        provider: "codex",
        allowThreadFallback: method === "turn/started",
      });
    if (run && startsProviderResponse(method)) {
      const firstEvent = markProviderFirstEvent(run, {
        turnId: eventTurnId,
        method,
        occurredAt: params.startedAtMs ?? params.completedAtMs ?? Date.now(),
        provider: "codex",
      });
      if (firstEvent) void d.saveState();
    }
    if (method === "thread/settings/updated") {
      d.applyThreadSettings(params.threadId, params.threadSettings);
      void d.saveState();
    }
    if (method === "thread/status/changed" && run) {
      run.threadStatus = params.status ?? null;
      const flags = Array.isArray(params.status?.activeFlags) ? params.status.activeFlags : [];
      if (flags.includes("waitingOnApproval")) d.setStage(run, "Ожидается ответ пользователя…");
      void d.saveState();
    }
    if (method === "turn/started") {
      if (run && eventTurnId) {
        const previous = { turnId: run.turnId, threadId: run.threadId };
        run.turnId = eventTurnId;
        run.threadId = params.threadId ?? run.threadId;
        markProviderTurnAccepted(run, {
          turnId: eventTurnId,
          acceptedAt: params.startedAtMs ?? Date.now(),
          provider: "codex",
        });
        d.reindexRun(run, previous);
      }
      if (eventTurnId && !d.turnTokenUsage.has(eventTurnId)) {
        rememberBounded(d.turnTokenUsage, eventTurnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      if (run && eventTurnId) void d.saveState();
    }
    if (method === "thread/tokenUsage/updated") {
      const compaction = d.getCompaction(params.threadId);
      d.trackTokenUsage(params, {
        // A standalone compaction reports an intermediate token count with no
        // billable input/output. It still belongs in turn accounting, but it
        // is not the compacted prompt size. The first ordinary model turn is
        // the first exact post-compaction context measurement.
        provisionalContext: isCompactionOnlyContextMeasurement(params, compaction),
      });
      void d.saveState();
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
      if (delta) d.noteActivity(run);
      d.scheduleProgress(run);
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") && run) {
      d.appendReasoning(run, params.delta);
      d.upsertReasoningBlock(run, { id: params.itemId, delta: params.delta });
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
        d.beginCompaction(params.threadId, {
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
        d.beginCompactionCleanup(params.threadId, {
          turnId: eventTurnId, itemId: params.item?.id, compactedAt: params.completedAtMs,
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
    }
    if (method === "thread/compacted") {
      const threadId = String(params.threadId ?? run?.threadId ?? "").trim();
      const modernItemAlreadyHandled = Boolean(d.getCompaction(threadId)?.itemId);
      d.beginCompactionCleanup(threadId, { turnId: eventTurnId });
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
        hydrateCodexAgentMessages(run, params.turn?.items, { turnId: eventTurnId });
        d.replaceActivityGroups(run, d.turnActivityGroups(params.turn));
      }
      d.completeTurn(eventTurnId, params.turn?.status);
      if (!run) {
        d.turnTokenUsage.delete(eventTurnId);
        d.speechButtons.delete(eventTurnId);
        const temporaryFiles = d.temporaryFiles.get(eventTurnId) ?? [];
        d.temporaryFiles.delete(eventTurnId);
        await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
        if (!contextProbe) {
          d.logWarn?.(`Completed Codex turn ${eventTurnId ?? "unknown"} has no registered task run`);
        }
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
        await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
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
