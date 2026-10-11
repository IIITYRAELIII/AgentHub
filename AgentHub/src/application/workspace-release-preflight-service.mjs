import {
  assertReleaseBaseProvenance,
  EXPLICIT_REVIEWED_MAIN_PROVENANCE,
  NATIVE_MAIN_PROVENANCE,
  normalizedReleaseBaseProvenance,
  SELECTED_TASK_ADOPTION_PROVENANCE,
} from "../domain/release-base-provenance.mjs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { selectedCompositionFields, selectedCompositionIdentity } from "../domain/task-selected-composition.mjs";
import { taskGitIdentityHash } from "../domain/task-git-reference.mjs";

import { preparationHash, ReleasePreparationRejectedError } from "./release-preparation-admission.mjs";

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
    resultReleaseRevision: item?.resultReleaseRevision == null ? null : Number(item.resultReleaseRevision),
    resultCommit: String(item?.resultCommit ?? ""),
    squashTransferHash: String(item?.squashTransfer?.transferHash ?? ""),
    selectedCompositionIdentity: selectedCompositionIdentity(item),
  })).sort((a, b) => a.taskId.localeCompare(b.taskId));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sameFrozenCandidateIdentity(left = {}, right = {}) {
  return String(left.preReleaseHead ?? "") === String(right.preReleaseHead ?? "")
    && String(left.tree ?? "") === String(right.tree ?? "")
    && String(left.manifestHash ?? "") === String(right.manifestHash ?? "")
    && String(left.baseCommit ?? "") === String(right.baseCommit ?? "")
    && String(left.planRevision ?? "") === String(right.planRevision ?? "")
    && JSON.stringify(left.manifest?.baseProvenance ?? null)
      === JSON.stringify(right.manifest?.baseProvenance ?? null)
    && sameFrozenTasks(left.manifest?.tasks ?? [], right.manifest?.tasks ?? []);
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

function sameReviewedBaseProvenance(actual, expected) {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}

// Ordinary Await preparation may advance its base only through immutable
// selected Task adoption receipts. The owner's exact evidence becomes the
// candidate's discriminated provenance envelope.
function selectedTaskAdoptionProvenance(base) {
  // The owner advances a base only through receipts. Anything else carries no
  // envelope here and is rejected by the candidate owner's own guard.
  if (base.baseCommit === base.publishedBaseCommit || !base.adoptions?.length) return null;
  return normalizedReleaseBaseProvenance({
    schemaVersion: 1,
    kind: SELECTED_TASK_ADOPTION_PROVENANCE,
    publishedBaseCommit: base.publishedBaseCommit,
    adoptedBaseCommit: base.baseCommit,
    adoptions: base.adoptions,
  }, base.baseCommit);
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
    measureOperation = async (_stage, operation) => operation(),
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
    requiredFunction(measureOperation, "measureOperation");
    this.measureOperation = measureOperation;
  }

  withAwaitTransition(workspaceId, operation, { changesAwait = null } = {}) {
    return this.releaseGitWorkspaces.withAwaitTransition(workspaceId, operation);
  }

  async initialNativeTestState({ workspaceId, projectRoot } = {}) {
    const plan = await this.releasePlanner.plan(workspaceId);
    if (plan.blocked?.length) throw new Error("Initial native Test current release plan is blocked");
    const publication = await this.readPublicationState();
    publicationBaselineFor({ projectRoot }, publication);
    const candidate = await this.releaseGitWorkspaces.initialNativeTestCandidate(projectRoot);
    return { planRevision: plan.revision, publicationHash: taskGitIdentityHash(publication),
      candidateHash: taskGitIdentityHash(candidate) };
  }

  async prepareCurrentAwaitSet({ workspaceId, envelope, requestId, argumentsHash, validate, commitPrepared }) {
    requiredFunction(validate, "preparation validator");
    requiredFunction(commitPrepared, "preparation terminal receipt");
    requiredMethod(this.taskGitWorkspaces, "withTaskLocks");
    requiredMethod(this.taskGitWorkspaces, "withTaskRepositoryRecoveryLock");
    const verify = async () => {
      await validate();
      const plan = await this.releasePlanner.plan(workspaceId);
      const expected = envelope.tasks.map(({ taskId, taskRevision, resultCommit, projectRoot }) => (
        { taskId, taskRevision, resultCommit, projectRoot: canonicalRoot(projectRoot) }
      )).sort((a, b) => a.taskId.localeCompare(b.taskId));
      const actual = plan.ready.map(({ taskId, taskRevision, resultCommit, projectRoot }) => (
        { taskId: String(taskId), taskRevision, resultCommit, projectRoot: canonicalRoot(projectRoot) }
      )).sort((a, b) => a.taskId.localeCompare(b.taskId));
      const roots = readyRepositories(plan.ready).map((item) => canonicalRoot(item.projectRoot)).sort();
      if (plan.revision !== envelope.planRevision || plan.blocked.length
          || JSON.stringify(expected) !== JSON.stringify(actual)
          || JSON.stringify(roots) !== JSON.stringify(envelope.repositories.map((item) => canonicalRoot(item.projectRoot)).sort())
          || preparationHash(await this.readPublicationState()) !== envelope.publicationHash) {
        throw new ReleasePreparationRejectedError("Preparation plan, full selection or publication changed");
      }
    };
    // Existing lock order: Workspace Await -> all selected Tasks -> repository.
    return this.measureOperation("preparation:await-boundary", () => this.withAwaitTransition(workspaceId, () => (
      this.measureOperation("preparation:task-boundary", () => this.taskGitWorkspaces.withTaskLocks(
        envelope.tasks.map((item) => item.taskId), async (lease) => {
          const repositories = [...envelope.repositories].sort((a, b) => (
            canonicalRoot(a.projectRoot).localeCompare(canonicalRoot(b.projectRoot))
          ));
          const ownRepository = async (index, ownedLease) => {
            if (index < repositories.length) return this.taskGitWorkspaces.withTaskRepositoryRecoveryLock(
              envelope.tasks[0].taskId, repositories[index].projectRoot, ownedLease,
              (repositoryLease) => ownRepository(index + 1, repositoryLease),
            );
            await verify();
            return this.#prepareAwaitSet({ workspaceId, expectedPlanRevision: envelope.planRevision,
              preserveFrozen: true, lease: ownedLease,
              preparation: { envelope, requestId, argumentsHash, validate: verify },
              commitPrepared: async (prepared) => {
                await verify();
                return commitPrepared(prepared);
              } });
          };
          return this.measureOperation("preparation:repository-boundary", () => ownRepository(0, lease));
        },
      ))
    )));
  }

  async validateAwaitAcceptance({ workspaceId, acceptingTask, projectRoot, lease = null } = {}) {
    const plan = await this.releasePlanner.plan(workspaceId, { acceptingTask });
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

  async prepareAwaitAcceptance({
    workspaceId, acceptingTask, projectRoot, lease = null, operationId, commitPrepared,
  } = {}) {
    if (typeof commitPrepared !== "function") throw new TypeError("commitPrepared is required");
    const root = path.resolve(String(projectRoot ?? "").trim());
    const operation = String(operationId ?? "").trim();
    if (!operation) throw new TypeError("operationId is required");
    // Lifecycle holds Workspace Await -> Task -> repository locks, including
    // recovery and cross-Task cutover. Retain candidate rollback through Task CAS.
    return this.#prepareAwaitSet({
      workspaceId, acceptingTask, lease,
      commitPrepared: async (prepared) => {
        const matches = prepared.releaseCandidates.flatMap((candidate) => (
          canonicalRoot(candidate.repositoryRoot) === canonicalRoot(root)
            ? candidate.frozenTasks.filter((task) => task.taskId === String(acceptingTask?.id ?? ""))
            : []
        ));
        if (matches.length !== 1) throw new Error("Task has no unique prepared Await result to accept");
        return commitPrepared({ ...prepared, task: matches[0] });
      },
    });
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

  async prepareOperationGeneration({
    workspaceId, operationId, generation, taskIds, approvedRepositories = [], changelogContent = undefined,
    previousSelectedResults = [],
  } = {}) {
    if (typeof this.releaseGitWorkspaces.prepareGeneration !== "function") {
      throw new Error("immutable release generation preparation is unavailable");
    }
    return this.withAwaitTransition(workspaceId, () => this.#prepareAwaitSet({
      workspaceId,
      selectedTaskIds: taskIds,
      generationIdentity: { operationId, generation },
      previousSelectedResults,
      ...(changelogContent === undefined ? {} : { changelogContent }),
      ...(approvedRepositories.length ? { reviewedMainApprovals: { approvedRepositories } } : {}),
    }));
  }

  async discardOperationGeneration(generation) {
    requiredMethod(this.releaseGitWorkspaces, "discardGenerationCandidate");
    const cleanupWarnings = [];
    for (const candidate of generation?.candidates ?? []) {
      if (!candidate.generationRoot) continue;
      try {
        await this.releaseGitWorkspaces.discardGenerationCandidate({
          ...candidate,
          operationId: generation.operationId,
          generation: generation.generation,
        });
      } catch (error) {
        cleanupWarnings.push(error);
      }
    }
    return cleanupWarnings;
  }

  async operationSelection({ workspaceId, taskIds } = {}) {
    const plan = await this.releasePlanner.plan(workspaceId, { selectedTaskIds: taskIds });
    return readyRepositories(plan.ready).flatMap((repository) => (
      repository.frozenTasks.map((task) => ({
        taskId: task.taskId,
        resultCommit: task.resultCommit,
        ...selectedCompositionFields(task),
        acceptanceRevision: task.resultReleaseRevision ?? task.taskRevision,
      }))
    )).sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  async validateOperationGeneration({ workspaceId, generation } = {}) {
    if (!generation?.candidates?.length) throw new Error("release operation generation has no candidates");
    const planRevision = String(generation.candidates[0].planRevision ?? "").trim();
    if (!planRevision || generation.candidates.some((candidate) => candidate.planRevision !== planRevision)) {
      throw new Error("release operation generation has no single exact plan revision");
    }
    const repositories = generation.candidates.map((candidate) => {
      const frozenTasks = Array.isArray(candidate.frozenTasks) ? candidate.frozenTasks : [];
      return {
        projectRoot: candidate.repositoryRoot,
        worktreeRoot: candidate.releaseRoot,
        branch: "PreRelease",
        headCommit: candidate.commit,
        resultCommits: frozenTasks.map((task) => task.resultCommit),
        taskIds: frozenTasks.map((task) => task.taskId),
        frozenTasks,
        frozenCandidate: {
          repositoryRoot: candidate.repositoryRoot,
          releaseRoot: candidate.releaseRoot,
          preReleaseHead: candidate.commit,
          tree: candidate.tree,
          manifestHash: candidate.manifestHash,
          baseCommit: candidate.baseCommit,
          planRevision,
          manifest: candidate.manifest,
        },
      };
    });
    const source = await this.resolveReleaseValidationSource(repositories);
    const pipelineRoot = source?.kind === "workspace-release-pipeline"
      ? canonicalRoot(source.projectRoot)
      : null;
    const externalRepositories = pipelineRoot
      ? repositories.filter((repository) => canonicalRoot(repository.projectRoot) !== pipelineRoot)
      : repositories;
    const external = externalRepositories.length
      ? assertExactProductionValidation({
          workspaceId,
          planRevision,
          repositories: externalRepositories,
          validation: await this.validateProductionCandidate({
            workspaceId, planRevision, source, repositories: externalRepositories,
          }),
        })
      : null;
    return {
      status: "ready",
      workspaceId: String(workspaceId),
      planRevision,
      source,
      repositories,
      ...(external ? { productionValidation: external } : {}),
      pipelineValidationRequired: source?.kind === "workspace-release-pipeline",
    };
  }

  async #prepareAwaitSet({ workspaceId, expectedPlanRevision = null, fallbackProjectRoots = [], preserveFrozen = false,
    acceptingTask = null, commitPrepared = null, lease = null, validateOnly = false,
    reviewedMainApprovals = null, selectedTaskIds = null, generationIdentity = null, changelogContent = undefined,
    prospectiveOnly = false, freezeGeneration = true, ephemeralGeneration = false,
    previousSelectedResults = [], preparation = null,
  } = {}) {
    if (validateOnly && commitPrepared) throw new Error("Composition validation cannot commit Task acceptance");
    if (validateOnly) requiredMethod(this.releaseGitWorkspaces, "validateCandidate");
    if (acceptingTask && !validateOnly && !prospectiveOnly && typeof commitPrepared !== "function") {
      throw new Error("Prospective Await preparation requires its lifecycle commit");
    }
    const planOptions = selectedTaskIds ? { selectedTaskIds } : {};
    const baseline = await this.releasePlanner.plan(workspaceId, planOptions);
    const plan = acceptingTask
      ? await this.releasePlanner.plan(workspaceId, { ...planOptions, acceptingTask })
      : baseline;
    const validatePlan = async () => {
      const current = await this.releasePlanner.plan(workspaceId, planOptions);
      if (current.revision !== baseline.revision) {
        throw new Error("release plan revision changed during PreRelease rebuild");
      }
      if (acceptingTask) {
        const prospective = await this.releasePlanner.plan(workspaceId, { ...planOptions, acceptingTask });
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
    const explicitApprovals = reviewedMainApprovals == null ? null : new Map(selectedRepositories.map((repository) => {
      const approval = approvalForRepository(repository, selectedRepositories, reviewedMainApprovals);
      if (!approval.approvedLocalMainCommit || !approval.approvedOriginMainCommit) {
        throw new Error(`explicit reviewed-main preparation is missing approval for ${repository.projectRoot}`);
      }
      return [canonicalRoot(repository.projectRoot), approval];
    }));
    const baseChecks = [];
    const validateBases = async () => {
      const currentPublication = await this.readPublicationState();
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
          const currentAudit = await this.releaseGitWorkspaces.inspectMainChanges({
            projectRoot: repository.projectRoot,
            publishedRevision: currentBaseline.publishedRevision,
            approvedLocalMainCommit: reviewed.provenance.approvedLocalMainCommit,
            approvedOriginMainCommit: reviewed.provenance.approvedOriginMainCommit,
          });
          if (currentAudit.approvalRequired || !currentAudit.approved
              || currentAudit.localMain !== reviewed.provenance.approvedLocalMainCommit
              || currentAudit.originMain !== reviewed.provenance.approvedOriginMainCommit) {
            throw new Error("reviewed main authority changed during native PreRelease preparation");
          }
        }
      }
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
        await this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
          phase: "Await PreRelease rebuild",
        });
      }
      const evidence = await this.taskGitWorkspaces.releaseIntegrationEvidence({
        projectRoot: repository.projectRoot,
        tasks: repository.frozenTasks,
        ...(lease ? { lease } : {}),
      });
      if (preparation) {
        const bound = preparation.envelope.tasks.filter((item) => (
          canonicalRoot(item.projectRoot) === canonicalRoot(repository.projectRoot)
        )).map(({ taskId, taskRevision, baseCommit, resultCommit }) => (
          { taskId, taskRevision, baseCommit, resultCommit }
        )).sort((a, b) => a.taskId.localeCompare(b.taskId));
        const actual = evidence.tasks.map(({ taskId, taskRevision, baseCommit, resultCommit }) => (
          { taskId, taskRevision, baseCommit, resultCommit }
        )).sort((a, b) => a.taskId.localeCompare(b.taskId));
        if (JSON.stringify(actual) !== JSON.stringify(bound)) {
          throw new ReleasePreparationRejectedError("Preparation registered Task base/result evidence changed");
        }
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
        const audit = await this.releaseGitWorkspaces.inspectMainChanges({
          projectRoot: repository.projectRoot,
          publishedRevision: baseline.publishedRevision,
          approvedLocalMainCommit: provenance.approvedLocalMainCommit,
          approvedOriginMainCommit: provenance.approvedOriginMainCommit,
        });
        if (audit.approvalRequired || !audit.approved
            || canonicalRoot(audit.projectRoot) !== canonicalRoot(repository.projectRoot)
            || audit.publishedRevision !== provenance.publishedBaseCommit
            || audit.localMain !== provenance.approvedLocalMainCommit
            || audit.originMain !== provenance.approvedOriginMainCommit) {
          throw new Error(`explicit reviewed-main approval is stale for ${repository.projectRoot}`);
        }
        // Native composition starts at the explicitly agreed local main.
        // Reviewing origin does not silently adopt it as a different base.
        reviewed = { provenance, adoption: null };
      }
      baseChecks.push({ repository, base, reviewed });
      if (reviewed && reviewed.provenance.approvedLocalMainCommit !== base.baseCommit) {
        throw new Error("Native release agreed main changed after its explicit approval");
      }
      const approvedBaseCommit = base.baseCommit;
      const preparationRepository = preparation?.envelope.repositories.find((item) => (
        canonicalRoot(item.projectRoot) === canonicalRoot(repository.projectRoot)
      ));
      if (preparation && (preparationRepository?.approvedBaseCommit !== approvedBaseCommit
          || preparationRepository?.publishedRevision !== base.publishedBaseCommit)) {
        throw new ReleasePreparationRejectedError("Approved preparation base changed");
      }
      const baseProvenance = { schemaVersion: 1, kind: NATIVE_MAIN_PROVENANCE,
        publishedBaseCommit: base.publishedBaseCommit, agreedMainCommit: base.baseCommit,
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
      const prepareCandidate = generationIdentity
        ? this.releaseGitWorkspaces.prepareGeneration.bind(this.releaseGitWorkspaces)
        : this.releaseGitWorkspaces.prepareCandidate.bind(this.releaseGitWorkspaces);
      const candidate = await this.measureOperation(preparation ? "preparation:compose" : "release:compose", () => prepareCandidate({
        planRevision: plan.revision,
        workspaceId,
        projectRoot: repository.projectRoot,
        frozenTasks: evidence.tasks,
        approvedBaseCommit,
        ...(baseProvenance ? { baseProvenance } : {}),
        preserveFrozen,
        ...(preparation ? { preflightRequestId: preparation.requestId, preparationGuard: {
          ...preparationRepository, argumentsHash: preparation.argumentsHash,
          sourceCommit: preparation.envelope.sourceCommit, sourceTree: preparation.envelope.sourceTree,
          sourceClosureHash: preparation.envelope.sourceClosureHash,
          publicationHash: preparation.envelope.publicationHash,
        } } : {}),
        ...(generationIdentity ?? {}),
        ...(generationIdentity ? { freezePublication: freezeGeneration } : {}),
        ...(generationIdentity ? { ephemeral: ephemeralGeneration } : {}),
        ...(generationIdentity ? { changelogContent } : {}),
        validateBeforeCommit: async () => {
          await validatePlan(); await validateBases();
          if (preparation) await this.measureOperation("preparation:precommit-pins", preparation.validate);
        },
        ...((acceptingTask && !prospectiveOnly) || preparation ? { commitPrepared: async (prepared) => {
          releaseCandidates.push(prepared);
          await prepare(index + 1);
        } } : {}),
      }));
      if ((!acceptingTask || prospectiveOnly) && !preparation) {
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
    const mainAuthorities = [];
    for (const repository of selectedRepositories) {
      const baseline = publicationBaselineFor(repository, publication);
      const approval = approvalForRepository(repository, selectedRepositories, {
        approvedLocalMainCommit,
        approvedOriginMainCommit,
        approvedRepositories,
      });
      const audit = await this.releaseGitWorkspaces.inspectMainChanges({
        projectRoot: repository.projectRoot,
        publishedRevision: baseline.publishedRevision,
        approvedLocalMainCommit: approval.approvedLocalMainCommit,
        approvedOriginMainCommit: approval.approvedOriginMainCommit,
      });
      mainAudits.push(audit);
      mainAuthorities.push({ repository, baseline, approval, audit });
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
      const authority = mainAuthorities.find((entry) => (
        canonicalRoot(entry.repository.projectRoot) === canonicalRoot(repository.projectRoot)
      ));
      const { audit, baseline, approval } = authority;
      if (candidate.planRevision !== plan.revision
          || candidate.manifest?.planRevision !== plan.revision
          || String(candidate.manifest?.workspaceId ?? "") !== String(workspaceId)
          || canonicalRoot(candidate.repositoryRoot) !== canonicalRoot(repository.projectRoot)
          || !sameFrozenTasks(candidate.manifest?.tasks, repository.frozenTasks)) {
        throw new Error(`prepared PreRelease does not match the accepted release plan for ${repository.projectRoot}`);
      }
      const native = candidate.manifest?.compositionPolicy === "main-selected-git-merge-v1";
      if (!native) authority.adoption = await this.taskGitWorkspaces.assertExplicitUpstreamAdoption({
        projectRoot: repository.projectRoot, acceptedLocalMainCommit: audit.localMain,
        approvedUpstreamCommit: audit.originMain, frozenTasks: repository.frozenTasks,
      });
      const reviewedBase = native ? audit.localMain : audit.originMain;
      if (candidate.baseCommit !== reviewedBase || candidate.manifest?.baseCommit !== candidate.baseCommit) {
        throw new Error(`prepared PreRelease base does not match reviewed main for ${repository.projectRoot}; integrate the reviewed changes through a Task`);
      }
      const actualProvenance = normalizedReleaseBaseProvenance(
        candidate.manifest?.baseProvenance ?? null, candidate.baseCommit,
      );
      // Independent gate: an advanced base needs its own immutable envelope;
      // this later audit cannot retroactively supply the missing authority.
      try {
        assertReleaseBaseProvenance({
          publishedBaseCommit: baseline.publishedRevision,
          baseCommit: candidate.baseCommit,
          provenance: actualProvenance,
          phase: "prepared PreRelease",
        });
      } catch (error) {
        throw new Error(`${error.message} for ${repository.projectRoot}`, { cause: error });
      }
      const explicitApprovalSupplied = Boolean(
        approval.approvedLocalMainCommit && approval.approvedOriginMainCommit,
      );
      if (native && actualProvenance?.approvedOriginMainCommit
          && (actualProvenance.agreedMainCommit !== audit.localMain
            || actualProvenance.approvedLocalMainCommit !== audit.localMain
            || actualProvenance.approvedOriginMainCommit !== audit.originMain)) {
        throw new Error(`prepared native main approval is stale for ${repository.projectRoot}`);
      }
      let provenanceRequired = false;
      let releaseBase = null;
      const currentReleaseBase = async () => {
        requiredMethod(this.taskGitWorkspaces, "releaseBaseEvidence");
        releaseBase ??= await this.taskGitWorkspaces.releaseBaseEvidence({
          projectRoot: repository.projectRoot,
          publishedBaseCommit: baseline.publishedRevision,
          tasks: repository.frozenTasks,
        });
        return releaseBase;
      };
      if ((actualProvenance?.kind === EXPLICIT_REVIEWED_MAIN_PROVENANCE || explicitApprovalSupplied)
          && baseline.publishedRevision !== audit.originMain && audit.localMain === audit.originMain) {
        provenanceRequired = explicitApprovalSupplied
          && (await currentReleaseBase()).baseCommit !== audit.originMain;
      }
      if (actualProvenance?.kind === SELECTED_TASK_ADOPTION_PROVENANCE) {
        const current = selectedTaskAdoptionProvenance(await currentReleaseBase());
        if (!sameReviewedBaseProvenance(actualProvenance, current)) {
          throw new Error(`prepared PreRelease selected Task adoption authority is stale for ${repository.projectRoot}`);
        }
      }
      const explicitProvenance = actualProvenance?.kind === EXPLICIT_REVIEWED_MAIN_PROVENANCE
        ? actualProvenance : null;
      const expectedProvenance = explicitProvenance || provenanceRequired
        ? reviewedBaseProvenance({ repository, publishedRevision: baseline.publishedRevision, approval })
        : null;
      if ((provenanceRequired && !sameReviewedBaseProvenance(explicitProvenance, expectedProvenance))
          || (explicitProvenance && !sameReviewedBaseProvenance(explicitProvenance, expectedProvenance))) {
        throw new Error(`prepared PreRelease reviewed-main authority is stale for ${repository.projectRoot}`);
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
