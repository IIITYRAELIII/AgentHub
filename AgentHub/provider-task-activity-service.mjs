import {
  readCodexRolloutActivity,
  selectExactActiveCodexTurnId,
  TASK_EXECUTION_OWNERS,
} from "./task-catalog.mjs";
import { resolveCodexTaskActivity } from "./codex-runtime-owner.mjs";

export class ProviderTaskActivityService {
  constructor({
    knownCodexRolloutPath,
    codexRunning,
    codexPid,
    ensureCodex,
    readCodexThread,
    capturedCodexExecutionOwner,
    claudeTaskSnapshots,
    readRolloutActivity = readCodexRolloutActivity,
    selectActiveTurnId = selectExactActiveCodexTurnId,
    resolveActivity = resolveCodexTaskActivity,
  }) {
    this.knownCodexRolloutPath = knownCodexRolloutPath;
    this.codexRunning = codexRunning;
    this.codexPid = codexPid;
    this.ensureCodex = ensureCodex;
    this.readCodexThread = readCodexThread;
    this.capturedCodexExecutionOwner = capturedCodexExecutionOwner;
    this.claudeTaskSnapshots = claudeTaskSnapshots;
    this.readRolloutActivity = readRolloutActivity;
    this.selectActiveTurnId = selectActiveTurnId;
    this.resolveActivity = resolveActivity;
  }

  async readCodex(target) {
    let rolloutPath = await this.knownCodexRolloutPath(target.threadId);
    let threadStatus = null;
    if (!rolloutPath) {
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
    });
  }

  async readClaude(target) {
    const snapshot = await this.claudeTaskSnapshots.read(target.threadId);
    return {
      state: snapshot?.activityUnknown ? "unknown" : snapshot?.active ? "active" : "inactive",
      executionOwner: TASK_EXECUTION_OWNERS.EXTERNAL,
    };
  }
}
