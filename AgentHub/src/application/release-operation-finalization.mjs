function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}
export class ReleaseOperationFinalization {
  constructor({ taskBoard, releaseGitWorkspaces, taskGitWorkspaces } = {}) {
    requiredMethod(taskBoard, "completeReleaseOperation");
    requiredMethod(releaseGitWorkspaces, "synchronizePublishedPrimary");
    requiredMethod(taskGitWorkspaces, "synchronizeMainIntoDev");
    this.taskBoard = taskBoard;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.taskGitWorkspaces = taskGitWorkspaces;
  }

  async finalize({ operation, generation }) {
    const effects = operation.publicationEffects?.targets ?? {};
    const missing = operation.authorization.approvedTargets
      .filter((target) => !["applied", "already_applied"].includes(effects[target.targetId]?.status))
      .map((target) => target.targetId);
    if (missing.length) throw new Error(`release finalization is missing target effects: ${missing.join(", ")}`);
    const repositories = [];
    for (const candidate of generation.candidates) {
      const primary = await this.releaseGitWorkspaces.synchronizePublishedPrimary({
        projectRoot: candidate.repositoryRoot,
        publishedRevision: candidate.commit,
        planRevision: candidate.planRevision,
      });
      if (!["already_current", "fast_forwarded"].includes(primary?.status)) {
        const error = new Error(primary?.reason || `primary synchronization failed for ${candidate.repositoryRoot}`);
        error.code = "RELEASE_EXTERNAL_CONDITION";
        throw error;
      }
      const dev = await this.taskGitWorkspaces.synchronizeMainIntoDev({
        projectRoot: candidate.repositoryRoot,
        publishedRevision: candidate.commit,
      });
      if (dev?.integrated !== true) {
        const error = new Error(dev?.reason || `dev synchronization failed for ${candidate.repositoryRoot}`);
        error.code = "RELEASE_EXTERNAL_CONDITION";
        throw error;
      }
      repositories.push({ projectRoot: candidate.repositoryRoot, revision: candidate.commit, primary, dev });
    }
    const tasks = this.taskBoard.completeReleaseOperation(operation.workspaceId, {
      operationId: operation.operationId,
      generation: generation.generation,
      selectedResults: generation.selectedResults,
      publicationEffects: operation.publicationEffects,
    });
    return { status: "completed", repositories, tasks };
  }
}
