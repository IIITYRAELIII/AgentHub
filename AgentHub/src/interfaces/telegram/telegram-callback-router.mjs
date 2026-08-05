import { resolveContextualCallback } from "./callback-context.mjs";
import { parsePendingInputCallback } from "../../domain/deferred-input.mjs";
import { parseForwardBundleCallback } from "./telegram-forward-bundle.mjs";
import { parseTaskCatalogCallback } from "./task-catalog-presentation.mjs";
import { parseTaskViewCallbackData } from "./task-view-callback.mjs";

function match(pattern, value, names) {
  const result = pattern.exec(value);
  if (!result) return null;
  return Object.fromEntries(names.map((name, index) => [name, result[index + 1]]));
}

export function routeTelegramCallback(rawData, contextToken, parseApproval = () => null) {
  const contextual = resolveContextualCallback(rawData, contextToken);
  if (contextual.stale) return { kind: "stale", data: contextual.action };
  const data = contextual.action;
  const pending = parsePendingInputCallback(data);
  if (pending) return { kind: "pending-input", data, ...pending };
  const forwardBundle = parseForwardBundleCallback(data);
  if (forwardBundle) return { kind: "forward-bundle", data, ...forwardBundle };
  const speech = match(/^speech:([0-9a-f]+)$/, data, ["id"]);
  if (speech) return { kind: "speech", data, ...speech };
  const taskView = parseTaskViewCallbackData(data);
  if (taskView) return {
    kind: taskView.action === "diff"
      ? "task-diff"
      : taskView.action.startsWith("history-") ? "task-history" : "task-view",
    data,
    taskView,
  };
  const history = match(/^history-more:([al]):(\d+)$/, data, ["scope", "count"]);
  if (history) return { kind: "task-history", data, legacyHistory: history };
  if (data === "show-message" || data === "show-last-message") {
    return { kind: "task-view", data, legacy: true };
  }
  if (data === "task-diff") return { kind: "task-diff", data, legacy: true };
  const approvalMode = match(/^approval-mode:(manual|auto)$/, data, ["mode"]);
  if (approvalMode) return { kind: "approval-mode", data, ...approvalMode };
  const project = match(/^p:(\d+)$/, data, ["index"]);
  if (project) return { kind: "project", data, index: Number(project.index) };
  const engine = match(/^engine:(codex|claude)$/, data, ["provider"]);
  if (engine) return { kind: "engine", data, ...engine };
  const codexModel = match(/^codex-model:(.+)$/, data, ["model"]);
  if (codexModel) return { kind: "codex-model", data, ...codexModel };
  const codexReasoning = match(/^codex-reasoning:(low|medium|high|xhigh|max|ultra)$/, data, ["value"]);
  if (codexReasoning) return { kind: "codex-reasoning", data, ...codexReasoning };
  const codexMode = match(/^codex-mode:(default|plan)$/, data, ["value"]);
  if (codexMode) return { kind: "codex-mode", data, ...codexMode };
  const claudeReasoning = match(/^claude-reasoning:(low|medium|high|xhigh|max|ultra)$/, data, ["value"]);
  if (claudeReasoning) return { kind: "claude-reasoning", data, ...claudeReasoning };
  const claudeMode = match(/^claude-mode:(default|plan)$/, data, ["value"]);
  if (claudeMode) return { kind: "claude-mode", data, ...claudeMode };
  const claudeModel = match(/^model:(sonnet|opus|haiku)$/, data, ["model"]);
  if (claudeModel) return { kind: "claude-model", data, ...claudeModel };
  const taskPage = match(/^tasks-page:(\d+)$/, data, ["page"]);
  if (taskPage) return { kind: "task-page", data, page: Number(taskPage.page) };
  const catalogTask = parseTaskCatalogCallback(data);
  if (catalogTask) return { kind: "catalog-task", data, catalogTask };
  if (data === "thread:new") return { kind: "thread-new", data };
  if (data === "thread:archive") return { kind: "thread-archive", data };
  const approval = parseApproval(data);
  if (approval) return { kind: "approval", data, approval };
  return { kind: "unknown", data };
}
