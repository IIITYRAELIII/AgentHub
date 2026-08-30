function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredPlanRevision(value) {
  const revision = String(value ?? "").trim();
  if (!revision || revision.length > 128) throw new Error("release completion requires the exact release plan revision");
  return revision;
}

export class WorkspaceReleaseService {
  constructor({ store, verifyPublication } = {}) {
    requiredMethod(store, "releasePlan");
    requiredMethod(store, "completeRelease");
    if (typeof verifyPublication !== "function") throw new TypeError("verifyPublication is required");
    this.store = store;
    this.verifyPublication = verifyPublication;
  }

  async completeRelease({
    workspaceId, expectedRevision = null, expectedPlanRevision, deploymentVerified = false, verificationSummary = "",
    conflictsResolved = false,
  } = {}) {
    const plan = this.store.releasePlan(workspaceId);
    const requestedPlanRevision = requiredPlanRevision(expectedPlanRevision);
    if (plan.revision !== requestedPlanRevision) {
      throw new Error("release plan revision changed; read and verify the current release plan again");
    }
    if (!plan.ready.length) throw new Error("release has no ready changes");
    if (plan.blocked.length) throw new Error("release has blocked changes");
    if (plan.conflicts.length && conflictsResolved !== true) throw new Error("release has overlapping files");
    if (deploymentVerified !== true || !String(verificationSummary ?? "").trim()) {
      throw new Error("release completion requires verified deployment evidence");
    }
    const normalizedSummary = String(verificationSummary).trim().slice(0, 2_000);
    const publication = await this.verifyPublication({ expectedRevision, plan, conflictsResolved });
    if (!Array.isArray(publication?.repositories) || !publication.repositories.length) {
      throw new Error("publication verifier returned no released repository revisions");
    }
    publication.verificationSummary = normalizedSummary;
    publication.planRevision = plan.revision;
    return {
      ...this.store.completeRelease(workspaceId, {
        expectedPlanRevision: plan.revision,
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
      }),
      publication,
    };
  }
}
