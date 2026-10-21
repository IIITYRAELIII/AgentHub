import { TASK_EXECUTION_OWNERS } from "../domain/task-execution-owner.mjs";

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
    this.selectActiveTurnId = selectActiveTurnId;
    this.resolveActivity = resolveActivity;
  }

  async readCodex(target, { forceFresh = false } = {}) {
    let rolloutPath = await this.knownCodexRolloutPath(target.threadId);
    let threadStatus = null;
    if (!rolloutPath || forceFresh) {
      if (!this.codexRunning()) await this.ensureCodex();
      const result = await this.readCodexThread(target.threadId, {
        fresh: true,
        includeTurns: false,
      });
      rolloutPath = String(result.thread?.path ?? "").trim();
      threadStatus = result.thread?.status;
    }
    const activity = await this.readRolloutActivity(rolloutPath);
    const activeTurnId = this.selectActiveTurnId(activity);
    return this.resolveActivity({ threadStatus, activity }, {
      turnId: activeTurnId,
      rolloutPath,
      agentHubPid: this.codexPid(),
      capturedOwner: this.capturedCodexExecutionOwner(target.threadId, activeTurnId),
      forceFresh,
    });
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
