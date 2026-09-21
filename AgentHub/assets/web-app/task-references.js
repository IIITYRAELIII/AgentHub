(function taskReferencesBootstrap(global) {
  "use strict";

  const MIME = "application/x-agent-hub-board-task";
  const WORKFLOW_STATUSES = new Set([
    "new", "in_progress", "blocked", "testing", "awaiting_implementation", "done",
  ]);
  const INTENTS = new Set(["context", "start"]);
  const TASK_URI_PATTERN = /^agent-hub:\/\/task\/([^/?#]+)$/iu;
  const TASK_OPEN_EVENT = "agenthub:task-reference-open";
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
      taskNumber: String(source?.taskNumber ?? source?.number ?? "").trim().slice(0, 80) || null,
      title: String(source?.title ?? source?.name ?? "Task").replace(/\s+/gu, " ").trim().slice(0, 160) || "Task",
      workflowStatus: WORKFLOW_STATUSES.has(workflowStatus) ? workflowStatus : "new",
      workspaceId: String(source?.workspaceId ?? "").trim() || null,
      intent: INTENTS.has(requestedIntent) ? requestedIntent : "context",
    };
  }

  function fromTask(task, options = {}) {
    return normalize({
      taskId: task?.id,
      taskNumber: task?.taskNumber,
      title: task?.title || task?.text,
      workflowStatus: task?.workflowStatus,
      workspaceId: task?.workspaceId,
      intent: options.intent,
    });
  }

  function fromUri(value) {
    const match = String(value ?? "").trim().match(TASK_URI_PATTERN);
    if (!match) return null;
    try {
      const taskId = decodeURIComponent(match[1]).trim();
      if (!taskId || /[\\/]/u.test(taskId)) return null;
      return normalize({ taskId });
    } catch {
      return null;
    }
  }

  function taskUri(value) {
    const reference = typeof value === "string" ? fromUri(value) : normalize(value);
    return reference ? `agent-hub://task/${encodeURIComponent(reference.taskId)}` : "";
  }

  function link(value) {
    const reference = fromUri(value);
    return reference ? { href: taskUri(reference), taskId: reference.taskId } : null;
  }

  function open(value, { dispatch } = {}) {
    const source = typeof value === "string" ? value.trim() : value;
    const reference = typeof source === "string" && /^agent-hub:/iu.test(source)
      ? fromUri(source)
      : normalize(source);
    if (!reference) return false;
    const detail = { taskId: reference.taskId };
    if (typeof dispatch === "function") {
      dispatch(TASK_OPEN_EVENT, detail);
      return true;
    }
    if (!global.document?.dispatchEvent || typeof global.CustomEvent !== "function") return false;
    global.document.dispatchEvent(new global.CustomEvent(TASK_OPEN_EVENT, { detail }));
    return true;
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

  function presentation(value) {
    const reference = normalize(value);
    if (!reference) return null;
    return {
      badge: reference.taskNumber || "TASK",
      title: reference.title,
    };
  }

  global.AgentHubTaskReferences = Object.freeze({
    MIME,
    beginDrag,
    endDrag,
    fromTask,
    fromTransfer,
    fromUri,
    hasTransfer,
    isTaskReference,
    link,
    merge,
    normalize,
    open,
    presentation,
    taskUri,
    transferText,
  });
})(window);
