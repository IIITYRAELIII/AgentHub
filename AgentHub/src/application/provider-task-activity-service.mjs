import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";

const DEFERRED_ACTIVITY_TIMEOUT_MS = 5_000;

function withinAdmissionDeadline(operation, deadline) {
  const remainingMs = deadline - performance.now();
  const timeoutError = () => Object.assign(new Error("Deferred activity read timed out"), {
    code: "ERR_DEFERRED_ACTIVITY_TIMEOUT",
  });
  if (remainingMs <= 0) return Promise.reject(timeoutError());
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), remainingMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).then((value) => {
    if (performance.now() > deadline) throw timeoutError();
    return value;
  }).finally(() => clearTimeout(timer));
}

export class ProviderTaskActivityService {
  constructor({
    knownCodexRolloutPath,
    codexRunning,
    codexPid,
    ensureCodex,
    readCodexThread,
    capturedCodexExecutionOwner,
    claudeTaskSnapshots,
    claudeRuntimeState,
    readRolloutActivity,
    readAdmissionRolloutActivity = null,
    selectActiveTurnId,
    resolveActivity,
  }) {
    this.knownCodexRolloutPath = knownCodexRolloutPath;
    this.codexRunning = codexRunning;
    this.codexPid = codexPid;
    this.ensureCodex = ensureCodex;
    this.readCodexThread = readCodexThread;
    this.capturedCodexExecutionOwner = capturedCodexExecutionOwner;
    this.claudeTaskSnapshots = claudeTaskSnapshots;
    this.claudeRuntimeState = typeof claudeRuntimeState === "function"
      ? claudeRuntimeState
      : async () => ({ known: false, hasLiveProcess: true });
    this.readRolloutActivity = readRolloutActivity;
    this.readAdmissionRolloutActivity = readAdmissionRolloutActivity;
    this.selectActiveTurnId = selectActiveTurnId;
    this.resolveActivity = resolveActivity;
  }

  async readCodex(target, { forceFresh = false, admissionTrace = null } = {}) {
    const admission = !forceFresh && admissionTrace && this.readAdmissionRolloutActivity;
    const deadline = performance.now() + DEFERRED_ACTIVITY_TIMEOUT_MS;
    const step = (stage, operation, metadata) => admission
      ? admissionTrace(stage, () => withinAdmissionDeadline(operation, deadline), metadata)
      : operation();
    let rolloutPath = await step("deferred-rollout-path", () => this.knownCodexRolloutPath(target.threadId));
    let threadStatus = null;
    const discover = async () => {
      if (!this.codexRunning()) await step("deferred-provider-ready", () => this.ensureCodex());
      const result = await step("deferred-thread-read", () => this.readCodexThread(target.threadId, {
        fresh: true,
        includeTurns: false,
        ...(admission ? { priority: "interactive" } : {}),
      }));
      rolloutPath = String(result.thread?.path ?? "").trim();
      threadStatus = result.thread?.status;
    };
    const discovered = !rolloutPath || forceFresh;
    if (discovered) await discover();
    const readAdmission = (path) => path
      ? step("deferred-rollout-read", () => this.readAdmissionRolloutActivity(path), (observation) => ({
        queueWaitMs: observation?.timing?.queueWaitMs,
        readMs: observation?.timing?.readMs,
        readBytes: observation?.activity?.scanBytes,
      })).then((observation) => observation.activity)
      : { sourceUnavailable: true };
    let activity = admission ? await readAdmission(rolloutPath) : await this.readRolloutActivity(rolloutPath);
    if (admission && activity.sourceUnavailable && !discovered) {
      const missingPath = rolloutPath;
      await discover();
      if (rolloutPath !== missingPath) activity = await readAdmission(rolloutPath);
    }
    if (admission && activity.sourceUnavailable) {
      return {
        state: threadStatus?.type === "active" ? "active" : "unknown",
        executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
      };
    }
    const activeTurnId = this.selectActiveTurnId(activity);
    return step("deferred-runtime-owner", () => this.resolveActivity({ threadStatus, activity }, {
      turnId: activeTurnId,
      rolloutPath,
      agentHubPid: this.codexPid(),
      capturedOwner: this.capturedCodexExecutionOwner(target.threadId, activeTurnId),
      forceFresh,
    }), (result) => ({ activityState: result.state }));
  }

  async readClaude(target) {
    const {
      forceFresh = false,
      notBeforeMs = 0,
    } = arguments[1] ?? {};
    const snapshot = await this.claudeTaskSnapshots.read(target.threadId);
    if (!forceFresh && !snapshot?.activityUnknown) {
      return {
        state: snapshot?.active ? "active" : "inactive",
        executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
      };
    }
    const runtime = await this.claudeRuntimeState({
      ...snapshot,
      sessionId: target.threadId,
    }, { forceFresh, notBeforeMs });
    return {
      state: runtime?.known
        ? runtime.hasLiveProcess ? "active" : "inactive"
        : "unknown",
      executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
      processEvidence: {
        complete: runtime?.complete === true,
        generation: runtime?.generation ?? null,
        scannedAt: runtime?.scannedAt ?? null,
        requestedAfterMs: runtime?.requestedAfterMs ?? 0,
      },
    };
  }
}
