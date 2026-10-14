function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

export class ReleaseOperationCommandService {
  constructor({ releaseOperations, workspaceCatalog, taskBoard } = {}) {
    for (const name of ["start", "get", "continue"]) requiredMethod(releaseOperations, name);
    for (const name of ["workspace", "hierarchy"]) requiredMethod(workspaceCatalog, name);
    requiredMethod(taskBoard, "task");
    this.releaseOperations = releaseOperations;
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
  }

  start({ requestId, workspaceId, streamId, threadId, taskIds, validationMode, approvedTargets, releaseMetadata = null } = {}) {
    const targetWorkspaceId = requiredText(workspaceId, "workspaceId");
    if (!this.workspaceCatalog.workspace(targetWorkspaceId)) throw new Error("Workspace not found");
    const selectedTaskIds = [...new Set((Array.isArray(taskIds) ? taskIds : [])
      .map((value) => requiredText(value, "taskId")))].sort();
    if (!selectedTaskIds.length) throw new Error("release operation requires selected Tasks");
    selectedTaskIds.map((taskId) => {
      const task = this.taskBoard.task(taskId);
      if (!task || task.workspaceId !== targetWorkspaceId) {
        throw new Error(`Task ${taskId} is not available in the release Workspace`);
      }
    });
    const workspace = this.workspaceCatalog.hierarchy().find((item) => item.id === targetWorkspaceId);
    const initiatorStreamId = requiredText(streamId, "streamId");
    const initiatorThreadId = requiredText(threadId, "threadId");
    const stream = workspace?.streams?.find((item) => item.id === initiatorStreamId);
    const thread = stream?.threads?.find((item) => item.threadId === initiatorThreadId);
    if (!stream || !thread) throw new Error("release operation requires the exact initiating Stream and Thread");
    return this.releaseOperations.start({
      requestId: requiredText(requestId, "requestId"),
      workspaceId: targetWorkspaceId,
      streamId: initiatorStreamId,
      threadId: initiatorThreadId,
      authorization: {
        taskIds: selectedTaskIds,
        validationMode: requiredText(validationMode, "validationMode"),
        approvedTargets: Array.isArray(approvedTargets) ? approvedTargets : [],
        ...(releaseMetadata ? { releaseMetadata } : {}),
      },
    });
  }

  get({ operationId } = {}) {
    return this.releaseOperations.get(requiredText(operationId, "operationId"));
  }

  continue({ operationId } = {}) {
    return this.releaseOperations.continue(requiredText(operationId, "operationId"));
  }
}
