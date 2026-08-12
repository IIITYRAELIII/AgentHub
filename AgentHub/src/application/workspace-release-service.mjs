function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
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
    workspaceId, expectedRevision = null, deploymentVerified = false, verificationSummary = "",
  } = {}) {
    const plan = this.store.releasePlan(workspaceId);
    if (!plan.ready.length) throw new Error("release has no ready changes");
    if (plan.blocked.length) throw new Error("release has blocked changes");
    if (plan.conflicts.length) throw new Error("release has overlapping files");
    if (deploymentVerified !== true || !String(verificationSummary ?? "").trim()) {
      throw new Error("release completion requires verified deployment evidence");
    }
    const publication = await this.verifyPublication({ expectedRevision, plan });
    publication.verificationSummary = String(verificationSummary).trim().slice(0, 2_000);
    return { ...this.store.completeRelease(workspaceId), publication };
  }
}
