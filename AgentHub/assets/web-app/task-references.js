(function taskReferencesBootstrap(global) {
  "use strict";

  const MIME = "application/x-agent-hub-board-task";
  const WORKFLOW_STATUSES = new Set([
    "new", "in_progress", "testing", "awaiting_implementation", "done",
  ]);
  const INTENTS = new Set(["context", "start"]);
  let activeDragReference = null;

  function normalize(value, { intent = null } = {}) {
    let source = value;
    if (typeof source === "string") {
      const text = source.trim();
      if (!text) return null;
      try {
        source = JSON.parse(text);
      } catch {
        source = { taskId: text };
      }
    }
    const taskId = String(source?.taskId ?? source?.id ?? "").trim();
    if (!taskId) return null;
    const requestedIntent = String(intent ?? source?.intent ?? "context").trim().toLowerCase();
    const workflowStatus = String(source?.workflowStatus ?? "new").trim().toLowerCase();
    return {
      kind: "task",
      taskId,
      title: String(source?.title ?? source?.name ?? "Task").replace(/\s+/gu, " ").trim().slice(0, 160) || "Task",
      workflowStatus: WORKFLOW_STATUSES.has(workflowStatus) ? workflowStatus : "new",
      workspaceId: String(source?.workspaceId ?? "").trim() || null,
      intent: INTENTS.has(requestedIntent) ? requestedIntent : "context",
    };
  }

  function fromTask(task, options = {}) {
    return normalize({
      taskId: task?.id,
      title: task?.title || task?.text,
      workflowStatus: task?.workflowStatus,
      workspaceId: task?.workspaceId,
      intent: options.intent,
    });
  }

  function transferText(task, options = {}) {
    const reference = fromTask(task, options);
    return reference ? JSON.stringify(reference) : "";
  }

  function beginDrag(dataTransfer, task, options = {}) {
    activeDragReference = fromTask(task, options);
    if (!activeDragReference) return null;
    dataTransfer?.setData?.(MIME, JSON.stringify(activeDragReference));
    if (dataTransfer) dataTransfer.effectAllowed = "copyMove";
    return activeDragReference;
  }

  function endDrag() {
    activeDragReference = null;
  }

  function fromTransfer(dataTransfer, options = {}) {
    const transferred = normalize(dataTransfer?.getData?.(MIME), options);
    return transferred ?? normalize(activeDragReference, options);
  }

  function hasTransfer(dataTransfer) {
    return Boolean(activeDragReference)
      || Array.from(dataTransfer?.types ?? []).includes(MIME);
  }

  function merge(values, reference, { limit = 8 } = {}) {
    const next = (Array.isArray(values) ? values : []).map((value) => normalize(value)).filter(Boolean);
    const normalized = normalize(reference);
    if (!normalized) return next;
    const existing = next.findIndex((value) => value.taskId === normalized.taskId);
    if (existing >= 0) next[existing] = normalized;
    else if (next.length < limit) next.push(normalized);
    return next;
  }

  function isTaskReference(value) {
    return value?.kind === "task" && Boolean(String(value?.taskId ?? "").trim());
  }

  global.AgentHubTaskReferences = Object.freeze({
    MIME,
    beginDrag,
    endDrag,
    fromTask,
    fromTransfer,
    hasTransfer,
    isTaskReference,
    merge,
    normalize,
    transferText,
  });
})(window);
