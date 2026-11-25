import { NATIVE_MAIN_PROVENANCE, LOCAL_SOURCE_BASELINE_PROVENANCE, releaseBaseProvenanceApprovedBase } from "../domain/release-base-provenance.mjs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { selectedCompositionFields, selectedCompositionIdentity } from "../domain/task-selected-composition.mjs";
import { taskGitIdentityHash } from "../domain/task-git-reference.mjs";

import { TaskPreparationRejectedError } from "../domain/task-preparation-error.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
}

function requiredPlanRevision(value) {
  const revision = String(value ?? "").trim();
  if (!revision || revision.length > 128) throw new Error("release preflight requires the exact release plan revision");
  return revision;
}

function canonicalRoot(value) {
  const source = String(value ?? "").trim();
  let resolved = path.resolve(source);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Some tests use synthetic roots. Fall back to path resolution when the
    // repository is not materialized on disk.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export { canonicalRoot as canonicalReleaseRepositoryRoot };

function repositoryRootOf(value) {
  return String(value?.root ?? value?.projectRoot ?? "").trim();
}

function repositoryRevisionOf(value) {
  return String(value?.revision ?? value?.publishedRevision ?? "").trim();
}

function publicationBaselineFor(repository, publication) {
  const selectedRoot = canonicalRoot(repository.projectRoot);
  const candidates = Array.isArray(publication?.repositories) ? publication.repositories : [];
  for (const candidate of candidates) {
    const candidateRoot = repositoryRootOf(candidate);
    if (!candidateRoot || canonicalRoot(candidateRoot) !== selectedRoot) continue;
    const revision = repositoryRevisionOf(candidate);
    if (!revision) throw new Error(`release preflight publication evidence for ${repository.projectRoot} has no revision`);
    return { publishedRevision: revision, evidence: candidate };
  }
  const publicationRoot = repositoryRootOf(publication);
  if (publicationRoot && canonicalRoot(publicationRoot) === selectedRoot) {
    const revision = repositoryRevisionOf(publication);
    if (!revision) throw new Error(`release preflight publication evidence for ${repository.projectRoot} has no revision`);
    return { publishedRevision: revision, evidence: publication };
  }
  throw new Error(
    `release preflight requires repository-scoped publication evidence for ${repository.projectRoot}; `
      + "unscoped publication revision is not authoritative for this repository",
  );
}

function approvedRepositoryEntries(entries = []) {
  if (!Array.isArray(entries)) throw new Error("approved release main commits must be repository-scoped");
  const approvals = new Map();
  for (const entry of entries) {
    const projectRoot = repositoryRootOf(entry);
    if (!projectRoot) throw new Error("approved release main commits require projectRoot");
    const key = canonicalRoot(projectRoot);
    const approval = {
      projectRoot,
      approvedLocalMainCommit: String(entry?.approvedLocalMainCommit ?? entry?.localMainCommit ?? "").trim(),
      approvedOriginMainCommit: String(entry?.approvedOriginMainCommit ?? entry?.originMainCommit ?? "").trim(),
    };
    if (!approval.approvedLocalMainCommit || !approval.approvedOriginMainCommit) {
      throw new Error(`approved release main commits for ${projectRoot} require both local and origin commits`);
    }
    const existing = approvals.get(key);
    if (existing) throw new Error(`approved release main commits for ${projectRoot} are duplicated or ambiguous`);
    approvals.set(key, approval);
  }
  return approvals;
}

function approvalForRepository(repository, selectedRepositories, {
  approvedLocalMainCommit = null, approvedOriginMainCommit = null, approvedRepositories = [],
} = {}) {
  const approvals = approvedRepositoryEntries(approvedRepositories);
  const selected = new Set(selectedRepositories.map((candidate) => canonicalRoot(candidate.projectRoot)));
  for (const approvalRoot of approvals.keys()) {
    if (!selected.has(approvalRoot)) throw new Error("approved release main commits target an unrelated repository");
  }
  const repositoryApproval = approvals.get(canonicalRoot(repository.projectRoot));
  if (repositoryApproval) return repositoryApproval;
  const approvedLocal = String(approvedLocalMainCommit ?? "").trim();
  const approvedOrigin = String(approvedOriginMainCommit ?? "").trim();
  if (!approvedLocal && !approvedOrigin) return {};
  if (!approvedLocal || !approvedOrigin) {
    throw new Error("approved release main commits require both local and origin commits");
  }
  if (selectedRepositories.length !== 1) {
    throw new Error("top-level approved release main commits are valid only for a single selected repository");
  }
  return { approvedLocalMainCommit: approvedLocal, approvedOriginMainCommit: approvedOrigin };
}

function readyRepositories(ready = [], fallbackProjectRoots = []) {
  const repositories = new Map();
  for (const entry of ready) {
    const projectRoot = path.resolve(String(entry?.projectRoot ?? "").trim());
    const resultCommit = String(entry?.resultCommit ?? "").trim();
    if (!resultCommit) throw new Error(`release Task ${entry?.taskId ?? "unknown"} has no result commit`);
    const key = canonicalRoot(projectRoot);
    const repository = repositories.get(key) ?? { projectRoot, frozenTasks: new Map() };
    const taskId = String(entry.taskId);
    const taskRevision = Number(entry.taskRevision);
    if (!Number.isInteger(taskRevision) || taskRevision < 1) {
      throw new Error(`release Task ${taskId} has no exact revision`);
    }
    const existing = repository.frozenTasks.get(taskId);
    if (existing && (existing.resultCommit !== resultCommit || existing.taskRevision !== taskRevision
        || selectedCompositionIdentity(existing) !== selectedCompositionIdentity(entry))) {
      throw new Error(`release Task ${taskId} has multiple revisions or result commits`);
    }
    repository.frozenTasks.set(taskId, {
      taskId,
      taskRevision,
      taskNumber: entry.taskNumber ?? null,
      projectRoot,
      branch: entry.branch,
      resultCommit,
      ...selectedCompositionFields(entry),
      ...(entry.resultReleaseRevision != null ? { resultReleaseRevision: entry.resultReleaseRevision } : {}),
      ...(entry.squashTransfer ? { squashTransfer: entry.squashTransfer } : {}),
    });
    repositories.set(key, repository);
  }
  for (const value of fallbackProjectRoots) {
    const source = String(value ?? "").trim();
    if (!source) continue;
    const projectRoot = path.resolve(source);
    const key = canonicalRoot(projectRoot);
    if (!repositories.has(key)) repositories.set(key, { projectRoot, frozenTasks: new Map() });
  }
  return [...repositories.values()].map((repository) => ({
    projectRoot: repository.projectRoot,
    frozenTasks: [...repository.frozenTasks.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    resultCommits: [...new Set([...repository.frozenTasks.values()].map((task) => task.resultCommit))].sort(),
    taskIds: [...repository.frozenTasks.keys()].sort(),
  }));
}

function reviewedBaseProvenance({ repository, publishedRevision, approval }) {
  const publishedBaseCommit = String(publishedRevision ?? "").trim();
  const approvedLocalMainCommit = String(approval?.approvedLocalMainCommit ?? "").trim();
  const approvedOriginMainCommit = String(approval?.approvedOriginMainCommit ?? "").trim();
  if (!publishedBaseCommit || !approvedLocalMainCommit || !approvedOriginMainCommit) {
    throw new Error(`explicit reviewed-main preparation requires complete approval for ${repository.projectRoot}`);
  }
  return {
    schemaVersion: 1,
    kind: "explicit-reviewed-main-v1",
    publishedBaseCommit,
    approvedLocalMainCommit,
    approvedOriginMainCommit,
  };
}

export class TaskIntegrationService {
  constructor({
    releasePlanner, taskGitWorkspaces, releaseGitWorkspaces,
    readPublicationState,
    measureOperation = async (_stage, operation) => operation(),
  } = {}) {
    requiredMethod(releasePlanner, "plan");
    requiredMethod(taskGitWorkspaces, "assertExplicitUpstreamAdoption");
    requiredMethod(taskGitWorkspaces, "releaseIntegrationEvidence");
    requiredMethod(releaseGitWorkspaces, "assertPrimaryInvariant");
    requiredMethod(releaseGitWorkspaces, "inspectMainChanges");
    requiredMethod(releaseGitWorkspaces, "prepareCandidate");
    requiredMethod(releaseGitWorkspaces, "withAwaitTransition");
    requiredFunction(readPublicationState, "readPublicationState");
    this.releasePlanner = releasePlanner;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.readPublicationState = readPublicationState;
    requiredFunction(measureOperation, "measureOperation");
    this.measureOperation = measureOperation;
  }

  withAwaitTransition(workspaceId, operation, { changesAwait = null } = {}) {
    return this.releaseGitWorkspaces.withAwaitTransition(workspaceId, operation);
  }

  awaitTransitionAdmissionNoEffect(workspaceId, error) {
    return this.releaseGitWorkspaces.awaitTransitionAdmissionNoEffect?.(workspaceId, error) ?? null;
  }

  async initialNativeTestState({ workspaceId, projectRoot } = {}) {
    const plan = await this.measureOperation("release:planner", async () => this.releasePlanner.plan(workspaceId));
    if (plan.blocked?.length) throw new Error("Initial native Test current release plan is blocked");
    const publication = await this.measureOperation("release:publication", async () => this.readPublicationState());
    publicationBaselineFor({ projectRoot }, publication);
    const candidate = await this.releaseGitWorkspaces.initialNativeTestCandidate(projectRoot);
    return { planRevision: plan.revision, publicationHash: taskGitIdentityHash(publication),
      candidateHash: taskGitIdentityHash(candidate) };
  }

  async validateAwaitAcceptance({ workspaceId, acceptingTask, projectRoot, lease = null } = {}) {
    const plan = await this.measureOperation("release:planner", async () => this.releasePlanner.plan(workspaceId, { acceptingTask }));
    const root = path.resolve(String(projectRoot ?? "").trim());
    const matches = readyRepositories(plan.ready).flatMap((repository) => (
      canonicalRoot(repository.projectRoot) === canonicalRoot(root)
        ? repository.frozenTasks.filter((task) => task.taskId === String(acceptingTask?.id ?? ""))
        : []
    ));
    if (matches.length !== 1) throw new Error("Task has no unique prospective Await result to accept");
    const evidence = await this.taskGitWorkspaces.releaseIntegrationEvidence({
      projectRoot: root,
      tasks: matches,
      ...(lease ? { lease } : {}),
    });
    if (evidence.tasks?.length !== 1
        || evidence.tasks[0].taskId !== String(acceptingTask.id)
        || evidence.tasks[0].resultCommit !== matches[0].resultCommit) {
      throw new Error("Task prospective Await integration evidence changed");
    }
    return { planRevision: plan.revision, task: evidence.tasks[0] };
  }

  async pendingNativeAwaitRecovery({ workspaceId, acceptingTask, projectRoot, lease, original }) {
    const prospective = await this.validateAwaitAcceptance({ workspaceId, acceptingTask, projectRoot, lease });
    if (prospective.task.resultCommit !== original.resultCommit) throw new Error("Original Await source changed");
    return this.releaseGitWorkspaces.inspectNativeAwaitRecovery({ projectRoot, original,
      frozenTasks: [prospective.task] });
  }

  finalizeInterruptedAwait(input) {
    requiredMethod(this.releaseGitWorkspaces, "finalizeInterruptedAwait");
    return this.releaseGitWorkspaces.finalizeInterruptedAwait(input);
  }

  async archivedNativeAwaitOriginal({ projectRoot, operationId }) {
    return this.releaseGitWorkspaces.archivedNativeAwaitOriginal?.({ projectRoot, operationId }) ?? null;
  }

  async prepareAwaitAcceptance({
    workspaceId, acceptingTask, projectRoot, lease = null, operationId, commitPrepared,
    nativeAwaitRecovery = null, validateAwaitOriginal = null, admitAwaitPromotion = null,
  } = {}) {
    if (typeof commitPrepared !== "function") throw new TypeError("commitPrepared is required");
    const root = path.resolve(String(projectRoot ?? "").trim());
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new TypeError("operationId is required");
    // Lifecycle holds Workspace Await -> Task -> repository locks, including
    // recovery and cross-Task cutover. Retain candidate rollback through Task CAS.
    try {
      return await this.#prepareAwaitSet({
        workspaceId, acceptingTask, lease, nativeAwaitRecovery, awaitOperationId: operation,
        validateAwaitOriginal, admitAwaitPromotion,
        commitPrepared: async (prepared) => {
          const matches = prepared.releaseCandidates.flatMap((candidate) => (
            canonicalRoot(candidate.repositoryRoot) === canonicalRoot(root)
              ? candidate.frozenTasks.filter((task) => task.taskId === String(acceptingTask?.id ?? ""))
              : []
          ));
          if (matches.length !== 1) throw new Error("Task has no unique prepared Await result to accept");
          const acceptedCandidate = prepared.releaseCandidates.find(candidate =>
            canonicalRoot(candidate.repositoryRoot) === canonicalRoot(root));
          const needsAuthority = nativeAwaitRecovery
            || acceptedCandidate?.manifest?.baseProvenance?.kind === LOCAL_SOURCE_BASELINE_PROVENANCE;
          if (needsAuthority && typeof acceptedCandidate?.verifyNativeAwaitAuthority !== "function") {
            throw new Error("Native Await candidate authority recheck is unavailable");
          }
          return commitPrepared({ ...prepared, task: matches[0],
            ...(typeof acceptedCandidate?.verifyNativeAwaitAuthority === "function"
              ? { verifyNativeAwaitAuthority: acceptedCandidate.verifyNativeAwaitAuthority } : {}) });
        },
      });
    } catch (error) {
      // A refused continuation does not establish that the prior Git effect
      // went away. Leave its original lifecycle transition pending.
      if (nativeAwaitRecovery?.preparedPromotion && error?.code !== "AWAIT_PREPARATION_UNKNOWN") {
        throw Object.assign(new Error(error.message, { cause: error }), { code: "AWAIT_PREPARATION_UNKNOWN" });
      }
      throw error;
    }
  }

  async prepareAwaitSet(options = {}) {
    return this.#prepareAwaitSet(options);
  }

  async prepareReviewedAwaitSet({
    workspaceId, expectedPlanRevision = null, fallbackProjectRoots = [], preserveFrozen = false,
    approvedLocalMainCommit = null, approvedOriginMainCommit = null, approvedRepositories = [],
  } = {}) {
    return this.withAwaitTransition(workspaceId, () => this.#prepareAwaitSet({
      workspaceId, expectedPlanRevision, fallbackProjectRoots, preserveFrozen,
      reviewedMainApprovals: {
        approvedLocalMainCommit, approvedOriginMainCommit, approvedRepositories,
      },
    }));
  }

  async #prepareAwaitSet({ workspaceId, expectedPlanRevision = null, fallbackProjectRoots = [], preserveFrozen = false,
    acceptingTask = null, commitPrepared = null, lease = null, validateOnly = false,
    reviewedMainApprovals = null, selectedTaskIds = null,
    prospectiveOnly = false,
    previousSelectedResults = [], nativeAwaitRecovery = null, awaitOperationId = null,
    validateAwaitOriginal = null, admitAwaitPromotion = null,
  } = {}) {
    if (validateOnly && commitPrepared) throw new Error("Composition validation cannot commit Task acceptance");
    if (validateOnly) requiredMethod(this.releaseGitWorkspaces, "validateCandidate");
    if (acceptingTask && !validateOnly && !prospectiveOnly && typeof commitPrepared !== "function") {
      throw new Error("Prospective Await preparation requires its lifecycle commit");
    }
    const planOptions = selectedTaskIds ? { selectedTaskIds } : {};
    if (acceptingTask) requiredMethod(this.releasePlanner, "planAcceptance");
    const readPlans = () => this.measureOperation("release:planner", async () => {
      if (acceptingTask) return this.releasePlanner.planAcceptance(workspaceId, { ...planOptions, acceptingTask });
      const current = await this.releasePlanner.plan(workspaceId, planOptions);
      return { baseline: current, prospective: current };
    });
    const { baseline, prospective: plan } = await readPlans();
    const validatePlan = async () => {
      const current = await readPlans();
      if (current.baseline.revision !== baseline.revision) {
        throw new Error("release plan revision changed during PreRelease rebuild");
      }
      if (acceptingTask) {
        if (current.prospective.revision !== plan.revision) throw new Error("Task changed during PreRelease acceptance preparation");
      }
      if (current.prospective.blocked.length) {
        throw new Error(`Await set has blocked Task results: ${current.prospective.blocked.map(item => (
          `${item.taskNumber ?? item.taskId ?? "Task"}: ${item.reason ?? item.gitError ?? "result unavailable"}`
        )).join("; ")}`);
      }
    };
    if (expectedPlanRevision != null && plan.revision !== requiredPlanRevision(expectedPlanRevision)) {
      throw new Error("release plan revision changed; rebuild the current Await set again");
    }
    if (plan.blocked.length) throw new Error(`Await set has blocked Task results: ${plan.blocked.map((item) => (
      `${item.taskNumber ?? item.taskId ?? "Task"}: ${item.reason ?? item.gitError ?? "result unavailable"}`
    )).join("; ")}`);
    const fallbackRepositories = [];
    const checkedPrimaries = new Set();
    for (const projectRoot of fallbackProjectRoots) {
      const primary = await this.measureOperation("release:primary-validation", async () => this.releaseGitWorkspaces.assertPrimaryInvariant(projectRoot, {
        phase: "Await PreRelease rebuild",
      }));
      fallbackRepositories.push(primary.projectRoot);
      checkedPrimaries.add(canonicalRoot(primary.projectRoot));
    }
    const selectedRepositories = readyRepositories(plan.ready, fallbackRepositories);
    if (!selectedRepositories.length) {
      if (acceptingTask) throw new Error("Task has no PreRelease result to accept");
      return { workspaceId: String(workspaceId), planRevision: plan.revision, taskIds: [], releaseCandidates: [] };
    }
    if (nativeAwaitRecovery?.preparedPromotion && (selectedRepositories.length !== 1
        || awaitOperationId !== nativeAwaitRecovery.operationId || typeof validateAwaitOriginal !== "function"
        || typeof admitAwaitPromotion !== "function")) {
      throw new Error("Interrupted Await requires the original operation and its sole repository");
    }
    const releaseCandidates = [];
    requiredMethod(this.taskGitWorkspaces, "releaseBaseEvidence");
    const publication = await this.measureOperation("release:publication", async () => this.readPublicationState());
    const explicitApprovals = reviewedMainApprovals == null ? null : new Map(selectedRepositories.map((repository) => {
      const approval = approvalForRepository(repository, selectedRepositories, reviewedMainApprovals);
      if (!approval.approvedLocalMainCommit || !approval.approvedOriginMainCommit) {
        throw new Error(`explicit reviewed-main preparation is missing approval for ${repository.projectRoot}`);
      }
      return [canonicalRoot(repository.projectRoot), approval];
    }));
    const baseChecks = [];
    const localSourceChecks = [];
    const validateBases = async () => {
      const currentPublication = await this.measureOperation("release:publication", async () => this.readPublicationState());
      for (const { repository, base, reviewed } of baseChecks) {
        const currentBaseline = publicationBaselineFor(repository, currentPublication);
        const current = await this.taskGitWorkspaces.releaseBaseEvidence({
          projectRoot: repository.projectRoot,
          publishedBaseCommit: currentBaseline.publishedRevision,
          tasks: repository.frozenTasks, lease,
        });
        if (JSON.stringify(current) !== JSON.stringify(base)) {
          throw new Error("accepted release base changed during PreRelease preparation");
        }
        if (reviewed) {
          if (currentBaseline.publishedRevision !== reviewed.provenance.publishedBaseCommit) {
            throw new Error("published release base changed during explicit reviewed-main preparation");
          }
          // Candidate promotion already holds release-git. Reentering
          // inspectMainChanges here would wait on that same live lease.
          // Its owner rechecks the pinned origin/main inside its own validate().
          if (current.baseCommit !== reviewed.provenance.approvedLocalMainCommit) {
            throw new Error("reviewed main authority changed during native PreRelease preparation");
          }
        }
      }
      for (const request of localSourceChecks) await this.measureOperation("preparation:local-source-baseline",
        () => this.releaseGitWorkspaces.validateLocalSourceBaseline(request));
    };
    const result = () => ({
      workspaceId: String(workspaceId), planRevision: plan.revision,
      taskIds: [...new Set(plan.ready.map((entry) => String(entry.taskId)))].sort(),
      overlaps: plan.conflicts, releaseCandidates,
    });
    let committedResult;
    // Retain each repository's rollback boundary until every candidate and the
    // one Task status CAS succeed. All callers hold the Workspace Await lock.
    const prepare = async (index) => {
      if (index === selectedRepositories.length) {
        await validatePlan();
        await validateBases();
        if (commitPrepared) committedResult = await commitPrepared(result());
        return;
      }
      const repository = selectedRepositories[index];
      if (!checkedPrimaries.has(canonicalRoot(repository.projectRoot))) {
        await this.measureOperation("release:primary-validation", async () => this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
          phase: "Await PreRelease rebuild",
        }));
      }
      const base = await this.taskGitWorkspaces.releaseBaseEvidence({
        projectRoot: repository.projectRoot,
        publishedBaseCommit: publicationBaselineFor(repository, publication).publishedRevision,
        tasks: repository.frozenTasks, lease,
      });
      let reviewed = null;
      if (explicitApprovals) {
        const baseline = publicationBaselineFor(repository, publication);
        const approval = explicitApprovals.get(canonicalRoot(repository.projectRoot));
        const provenance = reviewedBaseProvenance({
          repository, publishedRevision: baseline.publishedRevision, approval,
        });
        const audit = await this.measureOperation("task:main-validation", async () => this.releaseGitWorkspaces.inspectMainChanges({
          projectRoot: repository.projectRoot,
          publishedRevision: baseline.publishedRevision,
          approvedLocalMainCommit: provenance.approvedLocalMainCommit,
          approvedOriginMainCommit: provenance.approvedOriginMainCommit,
        }));
        if (audit.approvalRequired || !audit.approved
            || canonicalRoot(audit.projectRoot) !== canonicalRoot(repository.projectRoot)
            || audit.publishedRevision !== provenance.publishedBaseCommit
            || audit.localMain !== provenance.approvedLocalMainCommit
            || audit.originMain !== provenance.approvedOriginMainCommit) {
          throw new TaskPreparationRejectedError(`explicit reviewed-main approval is stale for ${repository.projectRoot}`);
        }
        // Native composition starts at the explicitly agreed local main.
        // Reviewing origin does not silently adopt it as a different base.
        reviewed = { provenance, adoption: null };
      }
      baseChecks.push({ repository, base, reviewed });
      if (reviewed && reviewed.provenance.approvedLocalMainCommit !== base.baseCommit) {
        throw new TaskPreparationRejectedError("Native release agreed main changed after its explicit approval");
      }
      const evidence = await this.taskGitWorkspaces.releaseIntegrationEvidence({
        projectRoot: repository.projectRoot,
        tasks: repository.frozenTasks,
        ...(lease ? { lease } : {}),
      });
      let localSource = null;
      if ( (base.adoptions?.length
          || !reviewed && base.baseCommit !== base.publishedBaseCommit)) {
        requiredMethod(this.releaseGitWorkspaces, "deriveInstalledLocalSourceBaselineForSelection");
        localSource = await this.releaseGitWorkspaces.deriveInstalledLocalSourceBaselineForSelection({
          projectRoot: repository.projectRoot, planRevision: plan.revision, tasks: evidence.tasks,
          publishedRevision: base.publishedBaseCommit, adoptions: base.adoptions ?? [],
        });
      }
      if (localSource) {
        const request = { projectRoot: repository.projectRoot, provenance: localSource,
          planRevision: plan.revision, tasks: evidence.tasks };
        const verified = await this.measureOperation("preparation:local-source-baseline",
          () => this.releaseGitWorkspaces.validateLocalSourceBaseline(request));
        localSource = verified.provenance;
        localSourceChecks.push(request);
        if (localSource.compositionBaseCommit !== (localSource.ownGitPublication?.commit ?? base.publishedBaseCommit)) {
          throw new TaskPreparationRejectedError("Installed source is operational only; rebuild the PUBLIC Await candidate from its published base");
        }
      }
      const approvedBaseCommit = localSource ? releaseBaseProvenanceApprovedBase(localSource)
        : reviewed ? base.baseCommit : (base.publishedBaseCommit ?? base.baseCommit);
      const baseProvenance = localSource ?? { schemaVersion: 1, kind: NATIVE_MAIN_PROVENANCE,
        publishedBaseCommit: base.publishedBaseCommit, agreedMainCommit: base.baseCommit,
        ...(!reviewed && base.publishedBaseCommit ? { compositionBaseCommit: base.publishedBaseCommit } : {}),
        ...(reviewed ? { approvedLocalMainCommit: reviewed.provenance.approvedLocalMainCommit,
          approvedOriginMainCommit: reviewed.provenance.approvedOriginMainCommit } : {}) };
      if (validateOnly) {
        releaseCandidates.push(await this.releaseGitWorkspaces.validateCandidate({
          planRevision: plan.revision, workspaceId, projectRoot: repository.projectRoot,
          frozenTasks: evidence.tasks, approvedBaseCommit,
          ...(baseProvenance ? { baseProvenance } : {}),
          validateBeforeCommit: async () => { await validatePlan(); await validateBases(); },
        }));
        await prepare(index + 1);
        return;
      }
      const candidate = await this.measureOperation("task:compose-await", () => this.releaseGitWorkspaces.prepareCandidate({
        planRevision: plan.revision,
        workspaceId,
        projectRoot: repository.projectRoot,
        frozenTasks: evidence.tasks,
        approvedBaseCommit,
        ...(baseProvenance ? { baseProvenance } : {}),
        preserveFrozen,
        ...(awaitOperationId ? { awaitOperationId } : {}),
        ...(nativeAwaitRecovery ? { nativeAwaitRecovery } : {}),
        ...(admitAwaitPromotion ? { admitAwaitPromotion } : {}),

        validateBeforeCommit: async () => {
          await validatePlan(); await validateBases();
          await validateAwaitOriginal?.();
        },
        ...((acceptingTask && !prospectiveOnly) ? { commitPrepared: async (prepared) => {
          if (acceptingTask && localSource && typeof prepared.verifyNativeAwaitAuthority !== "function") {
            throw new Error("Native Await candidate authority recheck is unavailable");
          }
          releaseCandidates.push(prepared);
          await prepare(index + 1);
        } } : {}),
      }));
      if (!acceptingTask || prospectiveOnly) {
        releaseCandidates.push(candidate);
        await prepare(index + 1);
      }
    };
    await prepare(0);
    if (previousSelectedResults.length) {
      requiredMethod(this.releaseGitWorkspaces, "assertSelectedResultLineage");
      for (const candidate of releaseCandidates) {
        await this.releaseGitWorkspaces.assertSelectedResultLineage({ candidate, previousSelectedResults });
      }
    }
    return commitPrepared ? committedResult : result();
  }


}
