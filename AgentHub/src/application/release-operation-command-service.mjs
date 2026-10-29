function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

// One membership normalizer for the existing command and authenticated MCP
// intake. The durable capture still rechecks the full set under Await ownership.
export function preparedAwaitTaskIds(taskBoard, workspaceId, expectedTaskIds = null) {
  requiredMethod(taskBoard, "releaseTasks");
  const taskIds = taskBoard.releaseTasks(workspaceId)
    .filter(task => task.status !== "done" && task.workflowStatus === "awaiting_implementation")
    .map(task => task.id).sort();
  if (!taskIds.length) throw new Error("release operation requires a prepared Await set");
  if (expectedTaskIds != null && expectedTaskIds.length
      && JSON.stringify([...new Set(expectedTaskIds.map(value => requiredText(value, "taskId")))].sort()) !== JSON.stringify(taskIds)) {
    throw new Error("Release membership must equal the whole current Await set");
  }
  return taskIds;
}

export class ReleaseOperationCommandService {
  constructor({ releaseOperations, workspaceCatalog, taskBoard } = {}) {
    for (const name of ["start", "get", "continue"]) requiredMethod(releaseOperations, name);
    for (const name of ["workspace", "hierarchy"]) requiredMethod(workspaceCatalog, name);
    requiredMethod(taskBoard, "task");
    requiredMethod(taskBoard, "releaseTasks");
    this.releaseOperations = releaseOperations;
    this.workspaceCatalog = workspaceCatalog;
    this.taskBoard = taskBoard;
  }

  start({ requestId, workspaceId, streamId, threadId, taskIds, validationMode, approvedTargets, releaseMetadata = null, testSelection = null, releaseVersion = undefined } = {}) {
    const targetWorkspaceId = requiredText(workspaceId, "workspaceId");
    if (!this.workspaceCatalog.workspace(targetWorkspaceId)) throw new Error("Workspace not found");
    const selectedTaskIds = preparedAwaitTaskIds(this.taskBoard, targetWorkspaceId, taskIds);
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
        taskScope: "all_await",
        validationMode: requiredText(validationMode, "validationMode"),
        approvedTargets: Array.isArray(approvedTargets) ? approvedTargets : [],
        ...(testSelection != null ? { testSelection } : {}),
        ...(releaseMetadata ? { releaseMetadata } : {}),
        ...(releaseVersion === undefined ? {} : { releaseVersion }),
      },
    });
  }

  get({ operationId } = {}) {
    return this.releaseOperations.get(requiredText(operationId, "operationId"));
  }

  continue({ operationId, ...options } = {}) {
    return this.releaseOperations.continue(requiredText(operationId, "operationId"), options);
  }
}
