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

function readinessAssessment(context) {
  const outcome = String(context.contour?.readback?.outcome ?? "missing");
  if (!exactContourIdentityReadback(context)) {
    return {
      status: "failed",
      reason: outcome === "exact" ? "contour-identity-mismatch" : `operation-readback-${outcome}`,
    };
  }
  if (exactReadyContourReadback(context)) return { status: "ready", reason: "ready" };
  const observed = context.contour?.readiness;
  if (context.contour?.status === "not-ready"
      && context.contour?.running === false
      && observed?.ready === false
      && observed?.retryable === true) {
    return { status: "retry", reason: String(observed.reason ?? "health-not-ready") };
  }
  return {
    status: "failed",
    reason: String(observed?.reason ?? `contour-${context.contour?.status ?? "missing"}`),
  };
}

function readinessFailure(reason, { attempts, elapsedMs, deadlineMs, deadline = false } = {}) {
  const readbackOutcome = reason.startsWith("operation-readback-")
    ? reason.slice("operation-readback-".length)
    : null;
  const summary = readbackOutcome
    ? `refreshed Test Contour readback is not exact-ready: ${readbackOutcome}`
    : reason === "contour-identity-mismatch"
      ? "refreshed Test Contour readback is not exact-ready: exact; it does not match dev HEAD or the exact operation target"
      : `refreshed Test Contour readiness ${deadline ? "deadline exceeded" : "failed"}: ${reason}`;
  const error = new Error(
    `${summary}; reason=${reason}; attempts=${attempts}; elapsedMs=${elapsedMs}; deadlineMs=${deadlineMs}`,
  );
  error.code = deadline ? "TEST_CONTOUR_READINESS_DEADLINE" : "TEST_CONTOUR_READINESS_FAILED";
  error.reason = reason;
  return error;
}

async function readExactReadyContour({
  readTestContourStatus, refreshed, expectedHeadCommit,
  deadlineMs, pollIntervalMs, now, delay,
}) {
  const request = {
    expectedOperationId: refreshed?.operationId ?? null,
    expectedHeadCommit,
  };
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  let attempts = 0;
  let lastReason = "health-not-ready";
  while (attempts === 0 || now() < deadlineAt) {
    const remainingMs = Math.max(1, deadlineAt - now());
    let contour;
    try {
      contour = await readTestContourStatus({
        ...request,
        healthTimeoutMs: Math.min(2_000, remainingMs),
      });
    } catch {
      throw readinessFailure("readback-error", {
        attempts: attempts + 1,
        elapsedMs: Math.max(0, now() - startedAt),
        deadlineMs,
      });
    }
    attempts += 1;
    const assessment = readinessAssessment({ refreshed, contour, expectedHeadCommit });
    lastReason = assessment.reason;
    const elapsedMs = Math.max(0, now() - startedAt);
    if (assessment.status === "ready" && elapsedMs <= deadlineMs) return contour;
    if (assessment.status === "failed") {
      throw readinessFailure(assessment.reason, { attempts, elapsedMs, deadlineMs });
    }
    const remainingAfterReadMs = deadlineAt - now();
    if (remainingAfterReadMs <= 0) break;
    await delay(Math.min(pollIntervalMs, remainingAfterReadMs));
  }
  throw readinessFailure(lastReason, {
    attempts,
    elapsedMs: Math.max(0, now() - startedAt),
    deadlineMs,
    deadline: true,
  });
}

export class WorkspaceReleasePreflightService {
  constructor({
    releasePlanner, taskGitWorkspaces, releaseGitWorkspaces,
    resolveTestContourSource, refreshTestContour, readTestContourStatus, readPublicationState,
    readinessDeadlineMs = 10_000,
    readinessPollIntervalMs = 100,
    now = () => Date.now(),
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
    requiredFunction(now, "now");
    requiredFunction(delay, "delay");
    if (!Number.isFinite(readinessDeadlineMs) || readinessDeadlineMs <= 0) {
      throw new TypeError("readinessDeadlineMs must be a positive number");
    }
    if (!Number.isFinite(readinessPollIntervalMs) || readinessPollIntervalMs <= 0) {
      throw new TypeError("readinessPollIntervalMs must be a positive number");
    }
    this.releasePlanner = releasePlanner;
    this.taskGitWorkspaces = taskGitWorkspaces;
    this.releaseGitWorkspaces = releaseGitWorkspaces;
    this.resolveTestContourSource = resolveTestContourSource;
    this.refreshTestContour = refreshTestContour;
    this.readTestContourStatus = readTestContourStatus;
    this.readPublicationState = readPublicationState;
    this.readinessDeadlineMs = readinessDeadlineMs;
    this.readinessPollIntervalMs = readinessPollIntervalMs;
    this.now = now;
    this.delay = delay;
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
  } = {}) {
    return this.withAwaitTransition(workspaceId, () => this.#preflightLocked({
      workspaceId,
      expectedPlanRevision,
      conflictsResolved,
      approvedLocalMainCommit,
      approvedOriginMainCommit,
    }));
  }

  async #preflightLocked({
    workspaceId, expectedPlanRevision, conflictsResolved,
    approvedLocalMainCommit, approvedOriginMainCommit,
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
    const publishedRevision = String(publication?.revision ?? "").trim();
    if (!publishedRevision) throw new Error("release preflight has no last published revision");
    const mainAudits = [];
    for (const repository of selectedRepositories) {
      mainAudits.push(await this.releaseGitWorkspaces.inspectMainChanges({
        projectRoot: repository.projectRoot,
        publishedRevision,
        approvedLocalMainCommit,
        approvedOriginMainCommit,
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
    const refreshed = await this.refreshTestContour({
      sourceRoot: contourSource.sourceRoot,
      forceFreshCandidate: true,
    });
    const expectedContourHead = contourSource.headCommit ?? null;
    const contour = await readExactReadyContour({
      readTestContourStatus: this.readTestContourStatus,
      refreshed,
      expectedHeadCommit: expectedContourHead,
      deadlineMs: this.readinessDeadlineMs,
      pollIntervalMs: this.readinessPollIntervalMs,
      now: this.now,
      delay: this.delay,
    });
    if (!exactReadyContourReadback({ refreshed, contour, expectedHeadCommit: expectedContourHead })) {
      throw new Error(
        `refreshed Test Contour readback is not exact-ready: ${contour?.readback?.outcome ?? "missing"}; `
          + "it does not match dev HEAD or the exact operation target",
      );
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
    const contourRepository = repositories.find((repository) => (
      canonicalRoot(repository.projectRoot) === canonicalRoot(contourSource.projectRoot)
    ));
    if (!contourRepository || String(contour.source?.headCommit ?? "") !== contourRepository.headCommit) {
      throw new Error("refreshed Test Contour source does not match dev HEAD");
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
      testContour: {
        root: contour.root,
        running: true,
        branch: contour.source?.branch ?? null,
        headCommit: contour.source.headCommit,
      },
    };
  }
}
