function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredPlanRevision(value) {
  const revision = String(value ?? "").trim();
  if (!revision || revision.length > 128) throw new Error("release completion requires the exact release plan revision");
  return revision;
}

export class WorkspaceReleaseService {
  constructor({ store, releasePlanner, releaseGitWorkspaces, releasePreflight, verifyPublication } = {}) {
    requiredMethod(store, "completeRelease");
    requiredMethod(store, "awaitRebuildPending");
    requiredMethod(store, "clearAwaitRebuildPending");
    requiredMethod(releasePlanner, "plan");
    requiredMethod(releaseGitWorkspaces, "synchronizePublishedPrimary");
    requiredMethod(releasePreflight, "prepareAwaitSet");
    requiredMethod(releasePreflight, "withAwaitTransition");
    if (typeof verifyPublication !== "function") throw new TypeError("verifyPublication is required");
    this.store = store;
    this.releasePlanner = releasePlanner;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.releasePreflight = releasePreflight;
    this.verifyPublication = verifyPublication;
  }

  async completeRelease({
    workspaceId, expectedRevision = null, expectedPlanRevision, deploymentVerified = false, verificationSummary = "",
    conflictsResolved = false,
  } = {}) {
    if (deploymentVerified !== true || !String(verificationSummary ?? "").trim()) {
      throw new Error("release completion requires verified deployment evidence");
    }
    return this.releasePreflight.withAwaitTransition(workspaceId, async () => {
      const pending = this.store.awaitRebuildPending(workspaceId);
      if (pending) {
        let preReleaseIntegration;
        try {
          preReleaseIntegration = await this.releasePreflight.prepareAwaitSet({
            workspaceId,
            fallbackProjectRoots: pending.fallbackProjectRoots,
          });
          this.store.clearAwaitRebuildPending(workspaceId);
        } catch (error) {
          preReleaseIntegration = {
            status: "retry_required",
            planRevision: pending.planRevision,
            reason: error.message,
          };
        }
        return {
          workspaceId: String(workspaceId),
          releaseAlreadyCompleted: true,
          recoveredPlanRevision: pending.planRevision,
          preReleaseIntegration,
        };
      }
      const plan = await this.releasePlanner.plan(workspaceId);
      const requestedPlanRevision = requiredPlanRevision(expectedPlanRevision);
      if (plan.revision !== requestedPlanRevision) {
        throw new Error("release plan revision changed; read and verify the current release plan again");
      }
      if (!plan.ready.length) throw new Error("release has no ready changes");
      if (plan.blocked.length) throw new Error("release has blocked changes");
      const normalizedSummary = String(verificationSummary).trim().slice(0, 2_000);
      const publication = await this.verifyPublication({ expectedRevision, plan, conflictsResolved });
      if (!Array.isArray(publication?.repositories) || !publication.repositories.length) {
        throw new Error("publication verifier returned no released repository revisions");
      }
      publication.primarySynchronization = [];
      for (const repository of publication.repositories) {
        try {
          publication.primarySynchronization.push(await this.releaseGitWorkspaces.synchronizePublishedPrimary({
            projectRoot: repository.root,
            publishedRevision: repository.revision,
            planRevision: plan.revision,
          }));
        } catch (error) {
          publication.primarySynchronization.push({
            status: "manual_required",
            projectRoot: repository.root,
            reason: error.message,
          });
        }
      }
      publication.verificationSummary = normalizedSummary;
      publication.planRevision = plan.revision;
      const completed = this.store.completeRelease(workspaceId, {
        expectedPlanRevision: plan.revision,
        plan,
        conflictsResolved,
        verificationEvidence: {
          planRevision: plan.revision,
          expectedRevision,
          verificationSummary: normalizedSummary,
          conflictsResolved: conflictsResolved === true,
          publication,
          deployment: {
            verified: true,
            summary: normalizedSummary,
          },
        },
        awaitRebuild: {
          planRevision: plan.revision,
          fallbackProjectRoots: publication.repositories.map((repository) => repository.root),
        },
      });
      let preReleaseIntegration;
      try {
        preReleaseIntegration = await this.releasePreflight.prepareAwaitSet({
          workspaceId,
          fallbackProjectRoots: publication.repositories.map((repository) => repository.root),
        });
        this.store.clearAwaitRebuildPending(workspaceId);
      } catch (error) {
        preReleaseIntegration = {
          status: "retry_required",
          planRevision: plan.revision,
          reason: error.message,
        };
      }
      return {
        ...completed,
        publication,
        preReleaseIntegration,
      };
    });
  }
}
