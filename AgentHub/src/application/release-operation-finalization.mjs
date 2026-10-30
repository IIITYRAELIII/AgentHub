function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}
export class ReleaseOperationFinalization {
  constructor({ taskBoard, releaseGitWorkspaces, taskGitWorkspaces } = {}) {
    requiredMethod(taskBoard, "completeReleaseOperation");
    requiredMethod(releaseGitWorkspaces, "verifyPublishedPrimary");
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
      const primary = await this.releaseGitWorkspaces.verifyPublishedPrimary({
        projectRoot: candidate.repositoryRoot,
        publishedRevision: candidate.commit,
        planRevision: candidate.planRevision,
      });
      if (primary?.status !== "preserved") {
        const error = new Error(primary?.reason || `published primary verification failed for ${candidate.repositoryRoot}`);
        error.code = "RELEASE_EXTERNAL_CONDITION";
        throw error;
      }
      repositories.push({ projectRoot: candidate.repositoryRoot, revision: candidate.commit, primary });
    }
    const tasks = await this.taskBoard.completeReleaseOperation(operation.workspaceId, {
      operationId: operation.operationId,
      generation: generation.generation,
      selectedResults: generation.selectedResults,
      publicationEffects: operation.publicationEffects,
    });
    for (const repository of repositories) {
      try {
        repository.dev = await this.taskGitWorkspaces.synchronizeMainIntoDev({
          projectRoot: repository.projectRoot, publishedRevision: repository.revision,
        });
      } catch (error) {
        repository.dev = { integrated: false, reason: error.message, code: error.code ?? null };
      }
    }
    const pending = repositories.filter(repository => repository.dev?.integrated !== true);
    if (pending.length) {
      const error = new Error(pending.map(repository => repository.dev?.reason
        || `dev synchronization pending for ${repository.projectRoot}`).join("; "));
      error.code = "RELEASE_EXTERNAL_CONDITION";
      error.finalization = { status: "awaiting_dev_sync", repositories, tasks };
      throw error;
    }
    return { status: "completed", repositories, tasks };
  }

  // Repair only the already-published original's dev integration. Task delivery
  // remains owned by ordinary finalize and is never repeated by this command.
  async synchronizePublishedDev({ operation, generation, projectRoot, expectedDevCommit,
    nativeResolutionReview = null, validate }) {
    const candidate = generation.candidates.find(item => item.repositoryRoot === projectRoot);
    if (!candidate) throw new Error("Published dev sync repository is not in the frozen generation");
    await validate();
    const primary = await this.releaseGitWorkspaces.verifyPublishedPrimary({
      projectRoot, publishedRevision: candidate.commit, planRevision: candidate.planRevision,
    });
    if (primary?.status !== "preserved") throw new Error("Published dev sync primary verification failed");
    await validate();
    return this.taskGitWorkspaces.synchronizeMainIntoDev({ projectRoot, publishedRevision: candidate.commit,
      publishedSync: { operationId: operation.operationId, workspaceId: operation.workspaceId,
        generation: generation.generation, candidateIdentity: generation.identitySha256,
        expectedDevCommit, tasks: [...new Set(generation.selectedResults.map(item => item.taskId))].sort().map(taskId => ({ taskId })) },
      nativeResolutionReview, validatePublishedSync: validate });
  }
}
