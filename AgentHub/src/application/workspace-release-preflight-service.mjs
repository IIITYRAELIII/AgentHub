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

function readyRepositories(ready = []) {
  const repositories = new Map();
  for (const entry of ready) {
    const projectRoot = path.resolve(String(entry?.projectRoot ?? "").trim());
    const resultCommit = String(entry?.resultCommit ?? "").trim();
    if (!resultCommit) throw new Error(`release Task ${entry?.taskId ?? "unknown"} has no result commit`);
    const key = canonicalRoot(projectRoot);
    const repository = repositories.get(key) ?? { projectRoot, resultCommits: new Set(), taskIds: new Set() };
    repository.resultCommits.add(resultCommit);
    repository.taskIds.add(String(entry.taskId));
    repositories.set(key, repository);
  }
  return [...repositories.values()].map((repository) => ({
    projectRoot: repository.projectRoot,
    resultCommits: [...repository.resultCommits].sort(),
    taskIds: [...repository.taskIds].sort(),
  }));
}

function sameContourTarget(left, right) {
  return Boolean(left && right)
    && canonicalRoot(left.root) === canonicalRoot(right.root)
    && String(left.contourId ?? "") === String(right.contourId ?? "")
    && Number(left.port) === Number(right.port)
    && String(left.model ?? "") === String(right.model ?? "");
}

function exactReadyContourReadback({ refreshed, contour, expectedHeadCommit }) {
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
    && contour?.running === true
    && canonicalRoot(contour?.root) === canonicalRoot(requested.target?.root)
    && contour?.planned === false
    && contour?.status === "ready"
    && contour?.operation?.operationId === requested.operationId
    && state?.operationId === requested.operationId
    && state?.releaseId === requested.releaseId
    && state?.contourId === requested.target?.contourId
    && Number(state?.port) === Number(requested.target?.port)
    && state?.model === requested.target?.model
    && contour?.source?.headCommit === expectedHead;
}

export class WorkspaceReleasePreflightService {
  constructor({
    releasePlanner, taskGitWorkspaces, resolveTestContourSource, refreshTestContour, readTestContourStatus,
  } = {}) {
    requiredMethod(releasePlanner, "plan");
    requiredMethod(taskGitWorkspaces, "prepareDev");
    requiredMethod(taskGitWorkspaces, "verifyReleaseResultsInDev");
    requiredFunction(resolveTestContourSource, "resolveTestContourSource");
    requiredFunction(refreshTestContour, "refreshTestContour");
    requiredFunction(readTestContourStatus, "readTestContourStatus");
    this.releasePlanner = releasePlanner;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.resolveTestContourSource = resolveTestContourSource;
    this.refreshTestContour = refreshTestContour;
    this.readTestContourStatus = readTestContourStatus;
  }

  async preflight({ workspaceId, expectedPlanRevision, conflictsResolved = false } = {}) {
    const plan = await this.releasePlanner.plan(workspaceId);
    const requestedPlanRevision = requiredPlanRevision(expectedPlanRevision);
    if (plan.revision !== requestedPlanRevision) {
      throw new Error("release plan revision changed; read and verify the current release plan again");
    }
    if (!plan.ready.length) throw new Error("release has no ready changes");
    if (plan.blocked.length) throw new Error("release has blocked changes");
    if (plan.conflicts.length && conflictsResolved !== true) throw new Error("release has overlapping files");

    const selectedRepositories = readyRepositories(plan.ready);
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
    const refreshed = await this.refreshTestContour({
      sourceRoot: contourSource.sourceRoot,
      forceFreshCandidate: true,
    });
    const expectedContourHead = contourSource.headCommit ?? null;
    const contour = await this.readTestContourStatus({
      expectedOperationId: refreshed?.operationId ?? null,
      expectedHeadCommit: expectedContourHead,
    });
    if (!exactReadyContourReadback({ refreshed, contour, expectedHeadCommit: expectedContourHead })) {
      throw new Error(
        `refreshed Test Contour readback is not exact-ready: ${contour?.readback?.outcome ?? "missing"}`,
      );
    }

    const repositories = [];
    for (const repository of selectedRepositories) {
      const dev = await this.taskGitWorkspaces.verifyReleaseResultsInDev(repository);
      repositories.push({
        projectRoot: dev.repositoryRoot,
        worktreeRoot: dev.projectRoot,
        branch: dev.branch,
        headCommit: dev.headCommit,
        resultCommits: dev.resultCommits,
        taskIds: repository.taskIds,
      });
    }
    const contourRepository = repositories.find((repository) => (
      canonicalRoot(repository.projectRoot) === canonicalRoot(contourSource.projectRoot)
    ));
    if (!contourRepository || String(contour.source?.headCommit ?? "") !== contourRepository.headCommit) {
      throw new Error("refreshed Test Contour source does not match dev HEAD");
    }

    return {
      workspaceId: String(workspaceId),
      planRevision: plan.revision,
      taskIds: [...new Set(plan.ready.map((entry) => String(entry.taskId)))].sort(),
      conflictsResolved: conflictsResolved === true,
      repositories,
      testContour: {
        root: contour.root,
        running: true,
        branch: contour.source?.branch ?? null,
        headCommit: contour.source.headCommit,
      },
    };
  }
}
