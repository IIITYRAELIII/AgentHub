import { isTaskBoardMutationOwner } from "./sqlite-mutation-owner.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredPlanRevision(value) {
  const revision = String(value ?? "").trim();
  if (!revision || revision.length > 128) throw new Error("release completion requires the exact release plan revision");
  return revision;
}

export class WorkspaceReleaseService {
  constructor({
    store, releasePlanner, releaseGitWorkspaces, taskGitWorkspaces, releasePreflight, verifyPublication,
  } = {}) {
    requiredMethod(store, "completeRelease");
    requiredMethod(store, "awaitRebuildPending");
    requiredMethod(store, "clearAwaitRebuildPending");
    if (!isTaskBoardMutationOwner(store)) {
      throw new TypeError("WorkspaceReleaseService requires the Task mutation owner facade");
    }
    requiredMethod(releasePlanner, "plan");
    requiredMethod(releaseGitWorkspaces, "synchronizePublishedPrimary");
    requiredMethod(releaseGitWorkspaces, "frozenCandidate");
    requiredMethod(taskGitWorkspaces, "synchronizeMainIntoDev");
    requiredMethod(releasePreflight, "prepareAwaitSet");
    requiredMethod(releasePreflight, "withAwaitTransition");
    if (typeof verifyPublication !== "function") throw new TypeError("verifyPublication is required");
    this.store = store;
    this.releasePlanner = releasePlanner;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releasePreflight = releasePreflight;
    this.verifyPublication = verifyPublication;
  }

  async completeRelease({
    workspaceId, expectedRepositories = [], expectedPlanRevision, deploymentVerified = false, verificationSummary = "",
    conflictsResolved = false,
  } = {}) {
    if (deploymentVerified !== true || !String(verificationSummary ?? "").trim()) {
      throw new Error("release completion requires verified deployment evidence");
    }
    return this.releasePreflight.withAwaitTransition(workspaceId, async () => {
      const pending = await this.store.awaitRebuildPending(workspaceId);
      if (pending) {
        let preReleaseIntegration;
        try {
          preReleaseIntegration = await this.releasePreflight.prepareAwaitSet({
            workspaceId,
            fallbackProjectRoots: pending.fallbackProjectRoots,
          });
          await this.store.clearAwaitRebuildPending(workspaceId);
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
      if (!Array.isArray(expectedRepositories) || !expectedRepositories.length) {
        throw new Error("release completion requires expected_revision for every repository");
      }
      const roots = [...new Set(plan.candidates.flatMap((candidate) => (
        candidate.gitReferences ?? []
      )).map((reference) => String(reference.projectRoot ?? "").trim()).filter(Boolean))];
      const frozenCandidates = [];
      for (const root of roots) frozenCandidates.push(await this.releaseGitWorkspaces.frozenCandidate(root));
      const verificationRequest = { expectedRepositories, frozenCandidates, plan, conflictsResolved };
      const publication = await this.verifyPublication(verificationRequest);
      if (!Array.isArray(publication?.repositories) || !publication.repositories.length) {
        throw new Error("publication verifier returned no released repository revisions");
      }
      const readback = await this.verifyPublication(verificationRequest);
      const publicationIdentity = (value) => JSON.stringify({
        repositories: value.repositories?.map((item) => ({
          root: item.root, revision: item.revision, planRevision: item.planRevision,
          manifestHash: item.manifestHash, baseCommit: item.baseCommit, preReleaseHead: item.preReleaseHead,
        })),
        generation: value.agentHubPublication?.generation ?? null,
      });
      if (publicationIdentity(publication) !== publicationIdentity(readback)) {
        throw new Error("publication generation or exact repository revision changed before Task closure");
      }
      publication.verificationSummary = normalizedSummary;
      publication.planRevision = plan.revision;
      const fallbackProjectRoots = publication.repositories.map((repository) => repository.root);
      const completed = await this.store.completeRelease(workspaceId, {
        expectedPlanRevision: plan.revision,
        plan,
        conflictsResolved,
        verificationEvidence: {
          planRevision: plan.revision,
          expectedRepositories,
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
          fallbackProjectRoots,
        },
      });
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
            status: "manual_required", projectRoot: repository.root, reason: error.message,
          });
        }
      }
      publication.devSynchronization = [];
      for (const repository of publication.repositories) {
        try {
          publication.devSynchronization.push(await this.taskGitWorkspaces.synchronizeMainIntoDev({
            projectRoot: repository.root,
            publishedRevision: repository.revision,
          }));
        } catch (error) {
          publication.devSynchronization.push({
            status: "manual_required",
            integrated: false,
            projectRoot: repository.root,
            reason: error.message,
          });
        }
      }
      let preReleaseIntegration;
      try {
        preReleaseIntegration = await this.releasePreflight.prepareAwaitSet({
          workspaceId,
          fallbackProjectRoots,
        });
        await this.store.clearAwaitRebuildPending(workspaceId);
      } catch (error) {
        preReleaseIntegration = {
          status: "retry_required",
          planRevision: plan.revision,
          reason: error.message,
        };
      }
      return { ...completed, publication, preReleaseIntegration };
    });
  }
}
