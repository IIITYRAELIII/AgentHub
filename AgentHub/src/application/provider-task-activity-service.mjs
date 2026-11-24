import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";

const DEFERRED_ACTIVITY_TIMEOUT_MS = 5_000;
const ROLLOUT_PAUSE_REASONS = Object.freeze({
  missing: "codex-rollout-missing",
  invalid: "codex-rollout-corrupt",
  "thread-mismatch": "codex-rollout-mismatch",
  "decoder-unavailable": "codex-rollout-decoder-unavailable",
});

function codexArchiveMetadataFailure(error, threadId) {
  const message = String(error?.message ?? "");
  return Number(error?.code) === -32603 && message.startsWith("failed to read thread:")
    && message.includes("failed to read session metadata ") && message.includes(threadId + ".jsonl:")
    && /(?:Unknown frame descriptor|Src size is incorrect|Restored data doesn't match checksum|Corrupted block detected)$/iu.test(message);
}

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
    let sourceIssue = null;
    const discover = async () => {
      if (!this.codexRunning()) await step("deferred-provider-ready", () => this.ensureCodex());
      let result;
      sourceIssue = null;
      try {
        result = await step("deferred-thread-read", () => this.readCodexThread(target.threadId, {
          fresh: true,
          includeTurns: false,
          ...(admission ? { priority: "interactive" } : {}),
        }));
      } catch (error) {
        // An invalid compressed header can prevent Codex from returning the path at all.
        if (!admission || !codexArchiveMetadataFailure(error, target.threadId)) throw error;
        rolloutPath = "";
        sourceIssue = "invalid";
        return;
      }
      rolloutPath = String(result.thread?.path ?? "").trim();
      threadStatus = result.thread?.status;
      if (admission && result.thread?.id && result.thread.id !== target.threadId) {
        rolloutPath = "";
        threadStatus = null;
      }
    };
    const discovered = !rolloutPath || forceFresh;
    if (discovered) await discover();
    const readAdmission = (path) => path
      ? step("deferred-rollout-read", () => this.readAdmissionRolloutActivity(path, target.threadId, performance.timeOrigin + deadline), (observation) => ({
        queueWaitMs: observation?.timing?.queueWaitMs,
        readMs: observation?.timing?.readMs,
        readBytes: observation?.activity?.scanBytes,
        sourceKind: observation?.activity?.sourceKind,
        sourceIssue: observation?.activity?.sourceIssue,
      })).then((observation) => observation.activity)
      : { sourceUnavailable: true, sourceIssue };
    let activity = admission ? await readAdmission(rolloutPath) : await this.readRolloutActivity(rolloutPath);
    const unknown = { state: "unknown", executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL };
    if (admission && (activity.sourceUnavailable || activity.sourceKind === "compressed") && !discovered) {
      const previousPath = rolloutPath;
      await discover();
      if (rolloutPath !== previousPath) activity = await readAdmission(rolloutPath);
    }
    if (admission && (activity.sourceUnavailable || activity.sourceKind === "compressed")) {
      if (threadStatus?.type === "active") return { ...unknown, state: "active" };
      if (activity.sourceUnavailable) {
        const waitReason = ROLLOUT_PAUSE_REASONS[activity.sourceIssue];
        return waitReason ? { ...unknown, waitReason } : unknown;
      }
      if (!["idle", "notLoaded"].includes(threadStatus?.type)) return unknown;
      const state = await step("deferred-runtime-owner", async () => {
        // The compressed file describes history; check the live owner of both paths.
        const owners = await Promise.all([activity.rolloutPath, activity.archivePath].map((path) => (
          this.resolveActivity({ threadStatus }, { rolloutPath: path, agentHubPid: this.codexPid(), forceFresh: true })
        )));
        return owners.find((owner) => owner.state === "active")
          ?? (owners.every((owner) => owner.state === "inactive") ? { state: "inactive", executionOwner: null } : unknown);
      }, (result) => ({ activityState: result.state }));
      if (state.state !== "inactive") return state;
      const current = await readAdmission(rolloutPath);
      // An external resume may have materialized the plain file during the probes.
      if (current.sourceKind === "compressed" && current.sourceGeneration === activity.sourceGeneration) return state;
      if (current.sourceUnavailable || current.sourceKind !== "plain") return unknown;
      const previousPath = rolloutPath;
      await discover();
      if (threadStatus?.type === "active" || current.running) return { ...unknown, state: "active" };
      if (rolloutPath !== previousPath || !["idle", "notLoaded"].includes(threadStatus?.type)) return unknown;
      return step("deferred-runtime-owner", () => this.resolveActivity({ threadStatus, activity: current }, {
        rolloutPath: activity.rolloutPath, agentHubPid: this.codexPid(), forceFresh: true,
      }), (resolved) => ({ activityState: resolved.state }));
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
