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
  const resolved = path.resolve(String(value ?? "").trim());
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

function sameContourTarget(left, right) {
  return Boolean(left && right)
    && canonicalRoot(left.root) === canonicalRoot(right.root)
    && String(left.contourId ?? "") === String(right.contourId ?? "")
    && Number(left.port) === Number(right.port)
    && String(left.model ?? "") === String(right.model ?? "");
}

function exactContourIdentityReadback({ refreshed, contour, expectedHeadCommit }) {
  const requested = refreshed?.operation;
  const readback = contour?.readback;
  const observed = readback?.operation;
  const state = contour?.state;
  const expectedHead = String(expectedHeadCommit ?? "").trim();
  return Boolean(requested?.operationId)
    && refreshed?.refreshOutcome === "refreshed"
    && requested.status === "ready"
    && requested.phase === "ready"
    && requested.source?.headCommit === expectedHead
    && readback?.outcome === "exact"
    && observed?.operationId === requested.operationId
    && observed?.status === "ready"
    && observed?.phase === "ready"
    && observed?.releaseId === requested.releaseId
    && observed?.source?.headCommit === expectedHead
    && sameContourTarget(observed?.target, requested.target)
    && canonicalRoot(contour?.root) === canonicalRoot(requested.target?.root)
    && contour?.planned === false
    && contour?.operation?.operationId === requested.operationId
    && state?.operationId === requested.operationId
    && state?.releaseId === requested.releaseId
    && state?.contourId === requested.target?.contourId
    && Number(state?.port) === Number(requested.target?.port)
    && state?.model === requested.target?.model
    && contour?.source?.headCommit === expectedHead;
}

function exactReadyContourReadback(context) {
  return exactContourIdentityReadback(context)
    && context.contour?.running === true
    && context.contour?.status === "ready";
}

async function readExactReadyContour({
  readTestContourStatus, refreshed, expectedHeadCommit,
}) {
  const request = {
    expectedOperationId: refreshed?.operationId ?? null,
    expectedHeadCommit,
  };
  let contour = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    contour = await readTestContourStatus(request);
    const context = { refreshed, contour, expectedHeadCommit };
    if (exactReadyContourReadback(context)) return contour;
    if (!exactContourIdentityReadback(context)
        || contour?.running !== false
        || contour?.status !== "not-ready") return contour;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return contour;
}

async function defaultProductionValidation(source) {
  throw new Error(source?.reason || "release preflight requires a repository-owned production validation gate");
}

export class WorkspaceReleasePreflightService {
  constructor({
    releasePlanner, taskGitWorkspaces, releaseGitWorkspaces,
    resolveTestContourSource, refreshTestContour, readTestContourStatus, readPublicationState,
    validateProductionCandidate = defaultProductionValidation,
  } = {}) {
    requiredMethod(releasePlanner, "plan");
    requiredMethod(taskGitWorkspaces, "prepareDev");
    requiredMethod(taskGitWorkspaces, "verifyReleaseResultsInDev");
    requiredMethod(taskGitWorkspaces, "releaseIntegrationEvidence");
    requiredMethod(releaseGitWorkspaces, "assertPrimaryInvariant");
    requiredMethod(releaseGitWorkspaces, "inspectMainChanges");
    requiredMethod(releaseGitWorkspaces, "prepareCandidate");
    requiredMethod(releaseGitWorkspaces, "withAwaitTransition");
    requiredFunction(resolveTestContourSource, "resolveTestContourSource");
    requiredFunction(refreshTestContour, "refreshTestContour");
    requiredFunction(readTestContourStatus, "readTestContourStatus");
    requiredFunction(readPublicationState, "readPublicationState");
    requiredFunction(validateProductionCandidate, "validateProductionCandidate");
    this.releasePlanner = releasePlanner;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.resolveTestContourSource = resolveTestContourSource;
    this.refreshTestContour = refreshTestContour;
    this.readTestContourStatus = readTestContourStatus;
    this.readPublicationState = readPublicationState;
    this.validateProductionCandidate = validateProductionCandidate;
  }

  withAwaitTransition(workspaceId, operation) {
    return this.releaseGitWorkspaces.withAwaitTransition(workspaceId, operation);
  }

  async prepareAwaitSet({ workspaceId, expectedPlanRevision = null, fallbackProjectRoots = [] } = {}) {
    const plan = await this.releasePlanner.plan(workspaceId);
    if (expectedPlanRevision != null && plan.revision !== requiredPlanRevision(expectedPlanRevision)) {
      throw new Error("release plan revision changed; rebuild the current Await set again");
    }
    if (plan.blocked.length) throw new Error("Await set has blocked Task results");
    const selectedRepositories = readyRepositories(plan.ready, fallbackProjectRoots);
    if (!selectedRepositories.length) {
      return { workspaceId: String(workspaceId), planRevision: plan.revision, taskIds: [], releaseCandidates: [] };
    }
    const releaseCandidates = [];
    for (const repository of selectedRepositories) {
      await this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
        phase: "Await PreRelease rebuild",
      });
      const evidence = await this.taskGitWorkspaces.releaseIntegrationEvidence({
        projectRoot: repository.projectRoot,
        tasks: repository.frozenTasks,
      });
      releaseCandidates.push(await this.releaseGitWorkspaces.prepareCandidate({
        planRevision: plan.revision,
        workspaceId,
        projectRoot: repository.projectRoot,
        frozenTasks: evidence.tasks,
        validateBeforeCommit: async () => {
          const current = await this.releasePlanner.plan(workspaceId);
          if (current.revision !== plan.revision) {
            throw new Error("release plan revision changed during PreRelease rebuild");
          }
        },
      }));
    }
    const current = await this.releasePlanner.plan(workspaceId);
    if (current.revision !== plan.revision) {
      throw new Error("release plan revision changed during PreRelease rebuild");
    }
    return {
      workspaceId: String(workspaceId),
      planRevision: plan.revision,
      taskIds: [...new Set(plan.ready.map((entry) => String(entry.taskId)))].sort(),
      overlaps: plan.conflicts,
      releaseCandidates,
    };
  }

  async preflight({
    workspaceId, expectedPlanRevision, conflictsResolved = false,
    approvedLocalMainCommit = null, approvedOriginMainCommit = null,
    approvedRepositories = [],
  } = {}) {
    return this.withAwaitTransition(workspaceId, () => this.#preflightLocked({
      workspaceId,
      expectedPlanRevision,
      conflictsResolved,
      approvedLocalMainCommit,
      approvedOriginMainCommit,
      approvedRepositories,
    }));
  }

  async #preflightLocked({
    workspaceId, expectedPlanRevision, conflictsResolved,
    approvedLocalMainCommit, approvedOriginMainCommit, approvedRepositories,
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
    const primaryRepositories = [];
    for (const repository of selectedRepositories) {
      primaryRepositories.push(await this.releaseGitWorkspaces.assertPrimaryInvariant(repository.projectRoot, {
        phase: "release preflight",
      }));
    }
    const preparedRepositories = [];
    for (const repository of selectedRepositories) {
      const dev = await this.taskGitWorkspaces.prepareDev(repository.projectRoot);
      preparedRepositories.push({
        projectRoot: dev.repositoryRoot,
        worktreeRoot: dev.projectRoot,
        branch: dev.branch,
        headCommit: dev.headCommit,
        resultCommits: repository.resultCommits,
        taskIds: repository.taskIds,
      });
    }

    const contourSource = await this.resolveTestContourSource(preparedRepositories);
    let productionValidation = null;
    let contour = null;
    if (contourSource?.kind === "external-validation-required") {
      productionValidation = await this.validateProductionCandidate({
        workspaceId,
        planRevision: plan.revision,
        source: contourSource,
        repositories: preparedRepositories,
      });
      if (productionValidation?.status !== "ready") {
        throw new Error(productionValidation?.reason || "repository production validation did not return ready evidence");
      }
    } else {
      const refreshed = await this.refreshTestContour({
        sourceRoot: contourSource.sourceRoot,
        forceFreshCandidate: true,
      });
      const expectedContourHead = contourSource.headCommit ?? null;
      contour = await readExactReadyContour({
        readTestContourStatus: this.readTestContourStatus,
        refreshed,
        expectedHeadCommit: expectedContourHead,
      });
      if (!exactReadyContourReadback({ refreshed, contour, expectedHeadCommit: expectedContourHead })) {
        throw new Error(
          `refreshed Test Contour readback is not exact-ready: ${contour?.readback?.outcome ?? "missing"}; `
            + "it does not match dev HEAD or the exact operation target",
        );
      }
    }

    const repositories = [];
    for (const repository of selectedRepositories) {
      const dev = await this.taskGitWorkspaces.verifyReleaseResultsInDev({
        projectRoot: repository.projectRoot,
        resultCommits: repository.resultCommits,
        taskIds: repository.taskIds,
      });
      repositories.push({
        projectRoot: dev.repositoryRoot,
        worktreeRoot: dev.projectRoot,
        branch: dev.branch,
        headCommit: dev.headCommit,
        resultCommits: dev.resultCommits,
        taskIds: repository.taskIds,
      });
    }
    if (!productionValidation) {
      const contourRepository = repositories.find((repository) => (
        canonicalRoot(repository.projectRoot) === canonicalRoot(contourSource.projectRoot)
      ));
      if (!contourRepository || String(contour.source?.headCommit ?? "") !== contourRepository.headCommit) {
        throw new Error("refreshed Test Contour source does not match dev HEAD");
      }
    }

    const releaseCandidates = [];
    for (const repository of selectedRepositories) {
      const evidence = await this.taskGitWorkspaces.releaseIntegrationEvidence({
        projectRoot: repository.projectRoot,
        tasks: repository.frozenTasks,
      });
      releaseCandidates.push(await this.releaseGitWorkspaces.prepareCandidate({
        planRevision: plan.revision,
        workspaceId,
        projectRoot: repository.projectRoot,
        frozenTasks: evidence.tasks,
        approvedBaseCommit: mainAudits.find((audit) => (
          canonicalRoot(audit.projectRoot) === canonicalRoot(repository.projectRoot)
        ))?.originMain ?? null,
        validateBeforeCommit: async () => {
          const current = await this.releasePlanner.plan(workspaceId);
          if (current.revision !== plan.revision) {
            throw new Error("release plan revision changed during release candidate preparation");
          }
        },
      }));
    }
    const current = await this.releasePlanner.plan(workspaceId);
    if (current.revision !== plan.revision) {
      throw new Error("release plan revision changed during release candidate preparation");
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
      ...(productionValidation ? { productionValidation } : { testContour: {
        root: contour.root,
        running: true,
        branch: contour.source?.branch ?? null,
        headCommit: contour.source.headCommit,
      } }),
    };
  }
}
