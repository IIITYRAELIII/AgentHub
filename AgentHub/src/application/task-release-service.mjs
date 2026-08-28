import { frozenTaskReleaseManifest } from "../domain/task-release-snapshot.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`task release ${name} is required`);
}

export class TaskReleaseService {
  constructor({ taskBoard, verifyFreezeEvidence, buildTreeEvidence } = {}) {
    for (const name of ["task", "freezeTaskRelease"]) requiredMethod(taskBoard, name);
    if (typeof verifyFreezeEvidence !== "function") throw new TypeError("verifyFreezeEvidence is required");
    if (typeof buildTreeEvidence !== "function") throw new TypeError("buildTreeEvidence is required");
    this.taskBoard = taskBoard;
    this.verifyFreezeEvidence = verifyFreezeEvidence;
    this.buildTreeEvidence = buildTreeEvidence;
  }

  async freeze({
    workspaceId, actorStreamId, taskId, expectedTaskRevision, repositories = [], files = [],
  } = {}) {
    const task = this.taskBoard.task(taskId);
    if (task.workspaceId !== String(workspaceId ?? "")) throw new Error("Task is outside the current Workspace");
    if (task.streamId !== String(actorStreamId ?? "")) {
      throw new Error("only the Task executor Stream can freeze its release revision");
    }
    const expected = Number(expectedTaskRevision);
    if (!Number.isSafeInteger(expected) || expected !== task.revision) {
      throw new Error("Task revision changed; read the Task again");
    }
    const manifest = frozenTaskReleaseManifest({
      revision: expected + 1,
      repositories,
      files,
    });
    const verification = await this.verifyFreezeEvidence(manifest);
    return this.taskBoard.freezeTaskRelease(task.id, {
      expectedTaskRevision: expected,
      manifest,
      verification,
      actorStreamId,
    });
  }

  async freezeRecorded({ taskId, workspaceId, actorStreamId } = {}) {
    const task = this.taskBoard.task(taskId);
    if (task.workspaceId !== String(workspaceId ?? "") || task.streamId !== String(actorStreamId ?? "")) {
      throw new Error("recorded Task release owner changed");
    }
    const evidence = await this.buildTreeEvidence({
      repositoryRevisions: task.repositoryRevisions,
      changedFiles: task.changedFiles,
    });
    return this.freeze({
      workspaceId,
      actorStreamId,
      taskId,
      expectedTaskRevision: task.revision,
      repositories: evidence.repositories,
      files: evidence.files,
    });
  }
}
