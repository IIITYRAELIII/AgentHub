import path from "node:path";
import { isTaskBoardMutationOwner } from "./sqlite-mutation-owner.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredPlanRevision(value) {
  const revision = String(value ?? "").trim();
  if (!revision || revision.length > 128) throw new Error("release completion requires the exact release plan revision");
  return revision;
}

function assertFinalizationRepositories(expectedRepositories, repositories) {
  const canonical = (root) => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  if (!Array.isArray(expectedRepositories) || !expectedRepositories.length) throw new Error("release repository identity is required");
  const expected = expectedRepositories.map((item) => [canonical(item.projectRoot), item.revision]).sort();
  const observed = repositories.map((item) => [canonical(item.projectRoot), item.publishedRevision]).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) throw new Error("completed release repository identity mismatch");
}

export class WorkspaceReleaseService {
  constructor({
    store, releasePlanner, releaseGitWorkspaces, taskGitWorkspaces, releasePreflight, verifyPublication,
  } = {}) {
    requiredMethod(store, "completeRelease");
    requiredMethod(store, "awaitRebuildPending");
    requiredMethod(store, "clearAwaitRebuildPending");
    requiredMethod(store, "recordReleaseFinalizationStage");
    requiredMethod(store, "releaseFinalizationOutcome");
    if (!isTaskBoardMutationOwner(store)) {
      throw new TypeError("WorkspaceReleaseService requires the Task mutation owner facade");
    }
    requiredMethod(releasePlanner, "plan");
    requiredMethod(releaseGitWorkspaces, "synchronizePublishedPrimary");
    requiredMethod(releaseGitWorkspaces, "frozenCandidate");
    requiredMethod(taskGitWorkspaces, "synchronizeMainIntoDev");
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
    conflictsResolved = false, reconcileOnly = false,
  } = {}) {
    if (deploymentVerified !== true || !String(verificationSummary ?? "").trim()) {
      throw new Error("release completion requires verified deployment evidence");
    }
    return this.releasePreflight.withAwaitTransition(workspaceId, async () => {
      const requestedRevision = requiredPlanRevision(expectedPlanRevision);
      const completedOutcome = await this.store.releaseFinalizationOutcome(workspaceId, requestedRevision);
      if (completedOutcome) {
        assertFinalizationRepositories(expectedRepositories, completedOutcome.repositories);
        return { workspaceId: String(workspaceId), releaseAlreadyCompleted: true,
          recoveredPlanRevision: requestedRevision,
          finalization: { status: "completed", planRevision: requestedRevision },
          releaseCandidate: { status: "invalidated", reason: "released Task membership changed" } };
      }
      const pending = await this.store.awaitRebuildPending(workspaceId);
      if (pending) {
        if (pending.planRevision !== requiredPlanRevision(expectedPlanRevision)) {
          throw new Error("pending release finalization belongs to another plan revision");
        }
        if (pending.version === 2) assertFinalizationRepositories(expectedRepositories, pending.repositories);
        return {
          workspaceId: String(workspaceId),
          releaseAlreadyCompleted: true,
          recoveredPlanRevision: pending.planRevision,
          ...await this.finalizeRelease(workspaceId, pending),
        };
      }

      if (reconcileOnly) throw new Error("no durable release finalization evidence for interrupted command");
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
          version: 2,
          repositories: publication.repositories.map((repository) => ({
            projectRoot: repository.root,
            publishedRevision: repository.revision,
            primary: null,
            dev: null,
          })),
          awaitResult: null,
        },
      });
      const finalization = await this.finalizeRelease(
        workspaceId, await this.store.awaitRebuildPending(workspaceId),
      );
      Object.assign(publication, finalization.publication);
      return { ...completed, ...finalization, publication };
    }).catch(async (error) => {
      // A definitive command result can authorize another finalization attempt.
      // Only the durable post-closure marker proves that no fresh closure will
      // be repeated; pre-closure or unproven failures keep their original error.
      const pending = await Promise.resolve().then(() => this.store.awaitRebuildPending(workspaceId)).catch(() => null);
      if (pending?.version !== 2 || pending.planRevision !== expectedPlanRevision) throw error;
      assertFinalizationRepositories(expectedRepositories, pending.repositories);
      return { workspaceId: String(workspaceId), releaseAlreadyCompleted: true,
        recoveredPlanRevision: pending.planRevision,
        finalization: { status: "retry_required", planRevision: pending.planRevision, reason: error.message } };
    });
  }

  async finalizeRelease(workspaceId, pending) {
    if (!pending) throw new Error("durable release finalization is missing");
    const publication = { primarySynchronization: [], devSynchronization: [] };
    let synchronizationPending = false;
    // Pre-v2 markers contain no exact published revisions. Recover only their
    // original Await action; never guess revisions from today's moving refs.
    const legacy = pending.version !== 2;
    if (!legacy) {
      for (const repository of pending.repositories) {
        for (const stage of ["primary", "dev"]) {
          let receipt = repository[stage];
          if (!receipt?.completed) {
            let result;
            try {
              result = stage === "primary"
                ? await this.releaseGitWorkspaces.synchronizePublishedPrimary({
                    projectRoot: repository.projectRoot,
                    publishedRevision: repository.publishedRevision,
                    planRevision: pending.planRevision,
                  })
                : await this.taskGitWorkspaces.synchronizeMainIntoDev({
                    projectRoot: repository.projectRoot,
                    publishedRevision: repository.publishedRevision,
                  });
            } catch (error) {
              result = { status: "manual_required", projectRoot: repository.projectRoot, reason: error.message };
            }
            const completed = stage === "primary"
              ? ["already_current", "fast_forwarded"].includes(result?.status)
              : result?.integrated === true;
            receipt = { completed, result };
            // The Git owners reconcile repeated effects with the same exact
            // revision if a process dies before this durable acknowledgment.
            await this.store.recordReleaseFinalizationStage(workspaceId, {
              planRevision: pending.planRevision, stage,
              projectRoot: repository.projectRoot, receipt,
            });
          }
          publication[stage === "primary" ? "primarySynchronization" : "devSynchronization"].push(receipt.result);
          if (!receipt.completed) synchronizationPending = true;
        }
      }
    }
    const releaseCandidate = {
      status: "invalidated",
      planRevision: pending.planRevision,
      reason: "released Task membership changed; explicit prepare is required for the next release",
    };
    if (!legacy && !pending.awaitResult?.completed) {
      await this.store.recordReleaseFinalizationStage(workspaceId, {
        planRevision: pending.planRevision, stage: "await",
        receipt: { completed: true, result: releaseCandidate },
      });
    }
    const complete = !synchronizationPending;
    if (complete) await this.store.clearAwaitRebuildPending(workspaceId, pending.planRevision);
    return {
      publication,
      releaseCandidate,
      finalization: {
        status: complete ? "completed" : "retry_required",
        planRevision: pending.planRevision,
        ...(legacy ? { synchronization: "legacy_evidence_unavailable" } : {}),
      },
    };
  }

}
