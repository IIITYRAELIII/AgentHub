import { unlink } from "node:fs/promises";
import { emptyTokenUsage } from "./token-usage.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export class CodexEventService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "invalidateThreadRead", "forEvent", "reindexRun", "applyThreadSettings", "saveState",
      "trackTokenUsage", "taskKey", "isSelectedRun", "setSelectedDiff", "appendActivity",
      "noteActivity", "scheduleProgress", "appendReasoning", "isCompactionItem",
      "beginCompaction", "getCompaction", "beginCompactionCleanup", "setStage", "describeItem",
      "itemActivity", "requestApproval", "formatCommandApproval", "formatFileApproval",
      "formatPermissionsApproval", "requestMcpElicitation", "discardManualCompaction",
      "consumeTracker", "finishObserved", "turnSnapshot", "completeManaged",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async handle(message) {
    const d = this.#d;
    const { method, params = {}, id } = message;
    if (params.threadId) d.invalidateThreadRead(params.threadId);
    if (id !== undefined && method) d.logError?.(`Codex server request received: ${method}`);
    const eventTurnId = params.turn?.id ?? params.turnId ?? null;
    const run = d.forEvent({
      turnId: eventTurnId,
      threadId: params.threadId,
      provider: "codex",
      allowThreadFallback: method === "turn/started",
    });
    if (method === "thread/settings/updated") {
      d.applyThreadSettings(params.threadId, params.threadSettings);
      void d.saveState();
    }
    if (method === "turn/started") {
      if (run && eventTurnId) {
        const previous = { turnId: run.turnId, threadId: run.threadId };
        run.turnId = eventTurnId;
        run.threadId = params.threadId ?? run.threadId;
        d.reindexRun(run, previous);
      }
      if (eventTurnId && !d.turnTokenUsage.has(eventTurnId)) {
        rememberBounded(d.turnTokenUsage, eventTurnId, { usage: emptyTokenUsage(), reported: false }, 200);
      }
      if (run && eventTurnId) void d.saveState();
    }
    if (method === "thread/tokenUsage/updated") {
      d.trackTokenUsage(params);
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
      if (params.itemId) run.responseItemId = String(params.itemId);
      run.responseText += delta;
      if (delta) d.noteActivity(run);
      d.scheduleProgress(run);
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/plan/delta") && run) {
      d.appendReasoning(run, params.delta);
    }
    if (method === "item/started") {
      if (d.isCompactionItem(params.item)) {
        d.beginCompaction(params.threadId, {
          origin: "automatic", turnId: eventTurnId, itemId: params.item?.id, startedAt: params.startedAtMs,
        });
      }
      if (run) {
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
    } else if (method === "turn/completed") {
      if (!run) {
        d.turnTokenUsage.delete(eventTurnId);
        d.speechButtons.delete(eventTurnId);
        const temporaryFiles = d.temporaryFiles.get(eventTurnId) ?? [];
        d.temporaryFiles.delete(eventTurnId);
        await Promise.all(temporaryFiles.map((file) => unlink(file).catch(() => {})));
        d.logWarn?.(`Completed Codex turn ${eventTurnId ?? "unknown"} has no registered task run`);
        return;
      }
      if (run.status !== "running") return;
      const completedTurnId = eventTurnId ?? run.turnId;
      if (await d.discardManualCompaction(run, completedTurnId)) return;
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

