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
    for (const name of ["workspace", "hierarchy", "activeThread"]) requiredMethod(workspaceCatalog, name);
    requiredMethod(taskBoard, "task");
    this.releaseOperations = releaseOperations;
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
  }

  start({ requestId, workspaceId, taskIds, validationMode, approvedTargets } = {}) {
    const targetWorkspaceId = requiredText(workspaceId, "workspaceId");
    if (!this.workspaceCatalog.workspace(targetWorkspaceId)) throw new Error("Workspace not found");
    const selectedTaskIds = [...new Set((Array.isArray(taskIds) ? taskIds : [])
      .map((value) => requiredText(value, "taskId")))].sort();
    if (!selectedTaskIds.length) throw new Error("release operation requires selected Tasks");
    const tasks = selectedTaskIds.map((taskId) => {
      const task = this.taskBoard.task(taskId);
      if (!task || task.workspaceId !== targetWorkspaceId) {
        throw new Error(`Task ${taskId} is not available in the release Workspace`);
      }
      return task;
    });
    const workspace = this.workspaceCatalog.hierarchy().find((item) => item.id === targetWorkspaceId);
    const stream = tasks.map((task) => task.streamId).filter(Boolean)
      .map((streamId) => workspace?.streams?.find((item) => item.id === streamId)).find(Boolean)
      ?? workspace?.streams?.find((item) => item.threads?.length);
    const thread = stream ? this.workspaceCatalog.activeThread(stream.id) ?? stream.threads?.[0] : null;
    if (!stream || !thread) throw new Error("release operation requires a real initiating Stream and Thread");
    return this.releaseOperations.start({
      requestId: requiredText(requestId, "requestId"),
      workspaceId: targetWorkspaceId,
      streamId: stream.id,
      threadId: thread.threadId,
      authorization: {
        taskIds: selectedTaskIds,
        validationMode: requiredText(validationMode, "validationMode"),
        approvedTargets: Array.isArray(approvedTargets) ? approvedTargets : [],
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
