import { realpathSync } from "node:fs";
import path from "node:path";

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
    if (existing && JSON.stringify(existing) !== JSON.stringify(approval)) {
      throw new Error(`approved release main commits for ${projectRoot} are ambiguous`);
    }
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
    if (existing && (existing.resultCommit !== resultCommit || existing.taskRevision !== taskRevision)) {
      throw new Error(`release Task ${taskId} has multiple revisions or result commits`);
    }
    repository.frozenTasks.set(taskId, {
      taskId,
      taskRevision,
      taskNumber: entry.taskNumber ?? null,
      projectRoot,
      branch: entry.branch,
      resultCommit,
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

function sameRepositoryIdentity(left, right) {
  const candidateMatches = right?.frozenCandidate
    ? String(left?.candidateCommit ?? "") === String(right.frozenCandidate.preReleaseHead ?? "")
      && (right.frozenCandidate.tree == null || String(left?.candidateTree ?? "") === String(right.frozenCandidate.tree))
    : true;
  return candidateMatches
    && canonicalRoot(left?.projectRoot) === canonicalRoot(right?.projectRoot)
    && String(left?.headCommit ?? "") === String(right?.headCommit ?? "")
    && JSON.stringify([...(left?.resultCommits ?? [])].sort()) === JSON.stringify([...(right?.resultCommits ?? [])].sort())
    && JSON.stringify([...(left?.taskIds ?? [])].sort()) === JSON.stringify([...(right?.taskIds ?? [])].sort())
    && sameFrozenTasks(left?.frozenTasks ?? [], right?.frozenTasks ?? []);
}

function sameFrozenTasks(left = [], right = []) {
  const normalize = (items) => items.map((item) => ({
    taskId: String(item?.taskId ?? ""),
    taskRevision: Number(item?.taskRevision),
    resultCommit: String(item?.resultCommit ?? ""),
  })).sort((a, b) => a.taskId.localeCompare(b.taskId));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sameFrozenCandidateIdentity(left = {}, right = {}) {
  return String(left.preReleaseHead ?? "") === String(right.preReleaseHead ?? "")
    && String(left.tree ?? "") === String(right.tree ?? "")
    && String(left.manifestHash ?? "") === String(right.manifestHash ?? "")
    && String(left.baseCommit ?? "") === String(right.baseCommit ?? "")
    && String(left.planRevision ?? "") === String(right.planRevision ?? "")
    && sameFrozenTasks(left.manifest?.tasks ?? [], right.manifest?.tasks ?? []);
}

function assertExactProductionValidation({
  validation, workspaceId, planRevision, repositories,
}) {
  if (validation?.status !== "ready") {
    throw new Error(validation?.reason || "repository production validation did not return ready evidence");
  }
  if (String(validation.workspaceId ?? "") !== String(workspaceId)
    || String(validation.planRevision ?? "") !== String(planRevision)) {
    throw new Error("repository production validation evidence does not match Workspace release plan");
  }
  const checked = Array.isArray(validation.repositories) ? validation.repositories : [];
  if (checked.length !== repositories.length) {
    throw new Error("repository production validation evidence does not cover every external repository");
  }
  for (const repository of repositories) {
    const evidence = checked.find((candidate) => canonicalRoot(candidate?.projectRoot) === canonicalRoot(repository.projectRoot));
    if (!sameRepositoryIdentity(evidence, repository)) {
      throw new Error(`repository production validation evidence is stale for ${repository.projectRoot}`);
    }
  }
  if (!validation.check || !String(validation.check.id ?? validation.check.checkId ?? "").trim()
      || !String(validation.check.kind ?? "").trim()) {
    throw new Error("repository production validation requires exact check evidence");
  }
  return validation;
}

function assertOriginalPreflightReceipt(receipt, {
  workspaceId, originalRequestId, expectedArgumentsHash = null,
} = {}) {
  const requestId = String(originalRequestId ?? "").trim();
  if (!receipt) throw new Error("original release preflight MCP receipt was not found");
  if (String(receipt.requestId ?? "") !== requestId) {
    throw new Error("original release preflight MCP receipt does not match the requested id");
  }
  if (String(receipt.toolName ?? "") !== "hub_release_preflight") {
    throw new Error("original MCP receipt is not a release preflight");
  }
  if (String(receipt.workspaceId ?? "") !== String(workspaceId)) {
    throw new Error("original release preflight MCP receipt belongs to another Workspace");
  }
  const status = String(receipt.status ?? "").trim();
  if (!["pending", "reconciling", "unknown"].includes(status)) {
    throw new Error("original release preflight MCP receipt is already terminal");
  }
  const expectedHash = String(expectedArgumentsHash ?? "").trim();
  if (expectedHash && String(receipt.argumentsHash ?? "") !== expectedHash) {
    throw new Error("original release preflight MCP receipt arguments do not match");
  }
  return { ...receipt, status };
}

async function defaultProductionValidation(source) {
  throw new Error(source?.reason || "release preflight requires a repository-owned production validation gate");
}

export class WorkspaceReleasePreflightService {
  constructor({
    releasePlanner, taskGitWorkspaces, releaseGitWorkspaces,
    resolveReleaseValidationSource, readPublicationState,
    validateProductionCandidate = defaultProductionValidation,
  } = {}) {
    requiredMethod(releasePlanner, "plan");
    requiredMethod(taskGitWorkspaces, "assertExplicitUpstreamAdoption");
    requiredMethod(taskGitWorkspaces, "releaseIntegrationEvidence");
    requiredMethod(releaseGitWorkspaces, "assertPrimaryInvariant");
    requiredMethod(releaseGitWorkspaces, "inspectMainChanges");
    requiredMethod(releaseGitWorkspaces, "prepareCandidate");
    requiredMethod(releaseGitWorkspaces, "withAwaitTransition");
    requiredFunction(resolveReleaseValidationSource, "resolveReleaseValidationSource");
    requiredFunction(readPublicationState, "readPublicationState");
    requiredFunction(validateProductionCandidate, "validateProductionCandidate");
    this.releasePlanner = releasePlanner;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.resolveReleaseValidationSource = resolveReleaseValidationSource;
    this.readPublicationState = readPublicationState;
    this.validateProductionCandidate = validateProductionCandidate;
  }

  withAwaitTransition(workspaceId, operation, { changesAwait = null } = {}) {
    return this.releaseGitWorkspaces.withAwaitTransition(workspaceId, async () => {
      if (changesAwait && await changesAwait()) {
        await this.releaseGitWorkspaces.assertAwaitChangesAllowed(workspaceId);
      }
      return operation();
    });
  }

  async prepareAwaitSet({ workspaceId, expectedPlanRevision = null, fallbackProjectRoots = [], preserveFrozen = false,
    acceptingTask = null, commitPrepared = null, lease = null,
  } = {}) {
    if (acceptingTask && typeof commitPrepared !== "function") {
      throw new Error("Prospective Await preparation requires its lifecycle commit");
    }
    const baseline = await this.releasePlanner.plan(workspaceId);
    const plan = acceptingTask ? await this.releasePlanner.plan(workspaceId, { acceptingTask }) : baseline;
    const validatePlan = async () => {
      const current = await this.releasePlanner.plan(workspaceId);
      if (current.revision !== baseline.revision) {
        throw new Error("release plan revision changed during PreRelease rebuild");
      }
      if (acceptingTask) {
        const prospective = await this.releasePlanner.plan(workspaceId, { acceptingTask });
        if (prospective.revision !== plan.revision) throw new Error("Task changed during PreRelease acceptance preparation");
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
      const primary = await this.releaseGitWorkspaces.assertPrimaryInvariant(projectRoot, {
        phase: "Await PreRelease rebuild",
      });
      fallbackRepositories.push(primary.projectRoot);
      checkedPrimaries.add(canonicalRoot(primary.projectRoot));
    }
    const selectedRepositories = readyRepositories(plan.ready, fallbackRepositories);
    if (!selectedRepositories.length) {
      if (acceptingTask) throw new Error("Task has no PreRelease result to accept");
      return { workspaceId: String(workspaceId), planRevision: plan.revision, taskIds: [], releaseCandidates: [] };
    }
    const releaseCandidates = [];
    requiredMethod(this.taskGitWorkspaces, "releaseBaseEvidence");
    const publication = await this.readPublicationState();
    const baseChecks = [];
    const validateBases = async () => {
      const currentPublication = await this.readPublicationState();
      for (const { repository, base } of baseChecks) {
        const current = await this.taskGitWorkspaces.releaseBaseEvidence({
          projectRoot: repository.projectRoot,
          publishedBaseCommit: publicationBaselineFor(repository, currentPublication).publishedRevision,
          tasks: repository.frozenTasks, lease,
        });
        if (JSON.stringify(current) !== JSON.stringify(base)) {
          throw new Error("accepted release base changed during PreRelease preparation");
        }
      }
    };
    const result = () => ({
      workspaceId: String(workspaceId), planRevision: plan.revision,
      taskIds: [...new Set(plan.ready.map((entry) => String(entry.taskId)))].sort(),
      overlaps: plan.conflicts, releaseCandidates,
    });
    // Retain each repository's rollback boundary until every candidate and the
    // one Task status CAS succeed. All callers hold the Workspace Await lock.
    const prepare = async (index) => {
      if (index === selectedRepositories.length) {
        await validatePlan();
        await validateBases();
        if (commitPrepared) await commitPrepared(result());
        return;
      }
      const repository = selectedRepositories[index];
      if (!checkedPrimaries.has(canonicalRoot(repository.projectRoot))) {
        await this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
          phase: "Await PreRelease rebuild",
        });
      }
      const evidence = await this.taskGitWorkspaces.releaseIntegrationEvidence({
        projectRoot: repository.projectRoot,
        tasks: repository.frozenTasks,
        ...(lease ? { lease } : {}),
      });
      const base = await this.taskGitWorkspaces.releaseBaseEvidence({
        projectRoot: repository.projectRoot,
        publishedBaseCommit: publicationBaselineFor(repository, publication).publishedRevision,
        tasks: repository.frozenTasks, lease,
      });
      baseChecks.push({ repository, base });
      const candidate = await this.releaseGitWorkspaces.prepareCandidate({
        planRevision: plan.revision,
        workspaceId,
        projectRoot: repository.projectRoot,
        frozenTasks: evidence.tasks,
        approvedBaseCommit: base.baseCommit,
        preserveFrozen,
        validateBeforeCommit: async () => { await validatePlan(); await validateBases(); },
        ...(acceptingTask ? { commitPrepared: async (prepared) => {
          releaseCandidates.push(prepared);
          await prepare(index + 1);
        } } : {}),
      });
      if (!acceptingTask) {
        releaseCandidates.push(candidate);
        await prepare(index + 1);
      }
    };
    await prepare(0);
    return result();
  }

  async preflight({
    workspaceId, expectedPlanRevision, conflictsResolved = false,
    approvedLocalMainCommit = null, approvedOriginMainCommit = null,
    approvedRepositories = [],
    requestId = null,
  } = {}) {
    return this.withAwaitTransition(workspaceId, () => this.#preflightLocked({
      workspaceId,
      expectedPlanRevision,
      conflictsResolved,
      approvedLocalMainCommit,
      approvedOriginMainCommit,
      approvedRepositories,
      requestId,
    }));
  }

  async reconcilePreflight({
    workspaceId, expectedPlanRevision, expectedRepositories = [], originalRequestId = null,
    errorClass = null, originalReceipt = null,
  } = {}) {
    if (typeof this.releaseGitWorkspaces.frozenCandidate !== "function") {
      throw new Error("release preflight reconciliation requires frozen candidate readback support");
    }
    const receipt = assertOriginalPreflightReceipt(originalReceipt, {
      workspaceId,
      originalRequestId,
      expectedArgumentsHash: originalReceipt?.expectedArgumentsHash,
    });
    const plan = await this.releasePlanner.plan(workspaceId);
    const requestedPlanRevision = requiredPlanRevision(expectedPlanRevision);
    if (plan.revision !== requestedPlanRevision) {
      throw new Error("release plan revision changed; preflight outcome remains unknown");
    }
    const selectedRepositories = readyRepositories(plan.ready);
    const expected = new Map();
    for (const item of expectedRepositories) {
      const projectRoot = repositoryRootOf(item);
      const revision = repositoryRevisionOf(item);
      if (!projectRoot || !revision) throw new Error("preflight reconciliation requires exact repository revisions");
      expected.set(canonicalRoot(projectRoot), { projectRoot, revision });
    }
    if (expected.size !== selectedRepositories.length) {
      throw new Error("preflight reconciliation evidence does not cover the selected repositories");
    }
    const releaseCandidates = [];
    for (const repository of selectedRepositories) {
      const expectedRepository = expected.get(canonicalRoot(repository.projectRoot));
      if (!expectedRepository) throw new Error(`preflight reconciliation is missing ${repository.projectRoot}`);
      const candidate = await this.releaseGitWorkspaces.frozenCandidate(repository.projectRoot);
      if (candidate.planRevision !== plan.revision || candidate.preReleaseHead !== expectedRepository.revision) {
        throw new Error(`preflight reconciliation checkpoint is stale for ${repository.projectRoot}`);
      }
      if (candidate.checkpointPhase !== "prepared") {
        throw new Error(`preflight reconciliation requires a prepared checkpoint for ${repository.projectRoot}`);
      }
      if (candidate.manifest?.planRevision !== plan.revision
          || candidate.manifest?.baseCommit !== candidate.baseCommit
          || candidate.manifestHash !== candidate.manifest?.manifestHash) {
        throw new Error(`preflight reconciliation manifest is stale for ${repository.projectRoot}`);
      }
      if (String(candidate.manifest?.workspaceId ?? "") !== String(workspaceId)) {
        throw new Error(`preflight reconciliation manifest belongs to another Workspace for ${repository.projectRoot}`);
      }
      if (!sameFrozenTasks(candidate.manifest?.tasks ?? [], repository.frozenTasks)) {
        throw new Error(`preflight reconciliation manifest Task evidence is stale for ${repository.projectRoot}`);
      }
      releaseCandidates.push(candidate);
    }
    const current = await this.releasePlanner.plan(workspaceId);
    if (current.revision !== plan.revision) {
      throw new Error("release plan revision changed during preflight readback; outcome remains unknown");
    }
    const causallyBound = releaseCandidates.every((candidate) => (
      String(candidate.preflightRequestId ?? "") === receipt.requestId
    ));
    return {
      workspaceId: String(workspaceId),
      planRevision: plan.revision,
      status: "candidate_snapshot_only",
      originalRequestId: receipt.requestId,
      errorClass: String(errorClass ?? "").trim() || "unknown",
      originalOutcome: "unknown",
      replayed: false,
      reason: causallyBound
        ? "prepared checkpoint is not final preflight outcome evidence"
        : "prepared checkpoint is not causally bound to the original MCP request",
      releaseCandidates,
    };
  }

  async #preflightLocked({
    workspaceId, expectedPlanRevision, conflictsResolved,
    approvedLocalMainCommit, approvedOriginMainCommit, approvedRepositories, requestId,
  }) {
    const plan = await this.releasePlanner.plan(workspaceId);
    const requestedPlanRevision = requiredPlanRevision(expectedPlanRevision);
    if (plan.revision !== requestedPlanRevision) {
      throw new Error("release plan revision changed; read and verify the current release plan again");
    }
    if (!plan.ready.length) throw new Error("release has no ready changes");
    if (plan.blocked.length) throw new Error("release has blocked changes");

    const selectedRepositories = readyRepositories(plan.ready);
    const publication = await this.readPublicationState();
    if (!publication) throw new Error("release preflight has no last published revision");
    const mainAudits = [];
    for (const repository of selectedRepositories) {
      const baseline = publicationBaselineFor(repository, publication);
      const approval = approvalForRepository(repository, selectedRepositories, {
        approvedLocalMainCommit,
        approvedOriginMainCommit,
        approvedRepositories,
      });
      mainAudits.push(await this.releaseGitWorkspaces.inspectMainChanges({
        projectRoot: repository.projectRoot,
        publishedRevision: baseline.publishedRevision,
        approvedLocalMainCommit: approval.approvedLocalMainCommit,
        approvedOriginMainCommit: approval.approvedOriginMainCommit,
      }));
    }
    if (mainAudits.some((audit) => audit.approvalRequired)) {
      return {
        workspaceId: String(workspaceId),
        planRevision: plan.revision,
        status: "main_review_required",
        taskIds: [...new Set(plan.ready.map((entry) => String(entry.taskId)))].sort(),
        mainAudits,
      };
    }
    for (const repository of selectedRepositories) {
      const audit = mainAudits.find((entry) => (
        canonicalRoot(entry.projectRoot) === canonicalRoot(repository.projectRoot)
      ));
      await this.taskGitWorkspaces.assertExplicitUpstreamAdoption({
        projectRoot: repository.projectRoot,
        acceptedLocalMainCommit: audit.localMain,
        approvedUpstreamCommit: audit.originMain,
        frozenTasks: repository.frozenTasks,
      });
    }
    const primaryRepositories = [];
    for (const repository of selectedRepositories) {
      const primary = await this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
        phase: "release preflight",
      });
      const audit = mainAudits.find((entry) => canonicalRoot(entry.projectRoot) === canonicalRoot(repository.projectRoot));
      if (primary.headCommit !== audit.localMain) {
        throw new Error(`reviewed local main changed before candidate verification for ${repository.projectRoot}`);
      }
      primaryRepositories.push(primary);
    }
    requiredMethod(this.releaseGitWorkspaces, "frozenCandidate");
    const releaseCandidates = [];
    const repositories = [];
    for (const repository of selectedRepositories) {
      const candidate = await this.releaseGitWorkspaces.frozenCandidate(repository.projectRoot);
      const audit = mainAudits.find((entry) => canonicalRoot(entry.projectRoot) === canonicalRoot(repository.projectRoot));
      if (candidate.planRevision !== plan.revision
          || candidate.manifest?.planRevision !== plan.revision
          || String(candidate.manifest?.workspaceId ?? "") !== String(workspaceId)
          || canonicalRoot(candidate.repositoryRoot) !== canonicalRoot(repository.projectRoot)
          || !sameFrozenTasks(candidate.manifest?.tasks, repository.frozenTasks)) {
        throw new Error(`prepared PreRelease does not match the accepted release plan for ${repository.projectRoot}`);
      }
      if (candidate.baseCommit !== audit.originMain || candidate.manifest?.baseCommit !== candidate.baseCommit) {
        throw new Error(`prepared PreRelease base does not match reviewed main for ${repository.projectRoot}; integrate the reviewed changes through a Task`);
      }
      if (!["prepared", "frozen"].includes(candidate.checkpointPhase)) {
        throw new Error(`prepared PreRelease has an unfinished operation for ${repository.projectRoot}`);
      }
      releaseCandidates.push({
        ...candidate,
        branch: candidate.checkpointPhase === "frozen" ? "main" : "PreRelease",
        frozenTasks: repository.frozenTasks,
        reused: true,
      });
      repositories.push({
        ...repository,
        worktreeRoot: candidate.releaseRoot,
        branch: candidate.checkpointPhase === "frozen" ? "main" : "PreRelease",
        headCommit: candidate.preReleaseHead,
        frozenCandidate: candidate,
      });
    }

    // Selection of repository-owned validation is independent of the rolling dev
    // contour. All validation receives the already prepared candidate identity.
    const validationSource = await this.resolveReleaseValidationSource(repositories);
    const pipelineRepositoryRoot = validationSource?.kind === "workspace-release-pipeline"
      ? validationSource.projectRoot : null;
    const externalRepositories = pipelineRepositoryRoot
      ? repositories.filter((repository) => canonicalRoot(repository.projectRoot) !== canonicalRoot(pipelineRepositoryRoot))
      : repositories;
    let productionValidation = null;
    if (externalRepositories.length) {
      productionValidation = assertExactProductionValidation({
        workspaceId,
        planRevision: plan.revision,
        repositories: externalRepositories,
        validation: await this.validateProductionCandidate({
          workspaceId,
          planRevision: plan.revision,
          source: validationSource,
          repositories: externalRepositories,
        }),
      });
    }
    for (const [index, repository] of repositories.entries()) {
      const afterPrimary = await this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
        phase: "release preflight completion",
      });
      const beforePrimary = primaryRepositories[index];
      if (afterPrimary.headCommit !== beforePrimary.headCommit
          || afterPrimary.indexFingerprint !== beforePrimary.indexFingerprint
          || afterPrimary.dirtyFingerprint !== beforePrimary.dirtyFingerprint) {
        throw new Error(`primary Workspace changed during release preflight for ${repository.projectRoot}`);
      }
      const afterCandidate = await this.releaseGitWorkspaces.frozenCandidate(repository.projectRoot);
      if (!sameFrozenCandidateIdentity(afterCandidate, repository.frozenCandidate)
          || afterCandidate.checkpointPhase !== repository.frozenCandidate.checkpointPhase
          || String(afterCandidate.manifest?.workspaceId ?? "") !== String(workspaceId)) {
        throw new Error(`prepared release candidate changed during preflight for ${repository.projectRoot}`);
      }
    }
    const current = await this.releasePlanner.plan(workspaceId);
    if (current.revision !== plan.revision) {
      throw new Error("release plan revision changed during release preflight");
    }
    return {
      workspaceId: String(workspaceId),
      planRevision: plan.revision,
      taskIds: [...new Set(plan.ready.map((entry) => String(entry.taskId)))].sort(),
      conflictsResolved: conflictsResolved === true,
      status: "ready",
      mainAudits,
      primaryRepositories,
      repositories,
      releaseCandidates,
      ...(productionValidation ? { productionValidation } : {}),
    };
  }
}
