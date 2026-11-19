import { TaskObservationService } from "../../src/application/task-observation-service.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";
import { CodexTaskSnapshotService, codexTurnSnapshot, codexTurnStartedAt,
  describeCodexItem } from "../../src/providers/codex/codex-task-snapshot-service.mjs";
import { parseCodexRolloutActivity, codexRolloutTurnState,
  selectCodexTurn } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { createDesktopSnapshotFactory } from "../../src/interfaces/desktop/desktop-snapshot.mjs";
import { DesktopReadModelService } from "../../src/interfaces/desktop/desktop-read-model-service.mjs";

// Only the external provider read is controlled. Registry, exact native-turn
// selection, observation, publication and desktop projection are real owners.
export function currentLiveProgress({ readThread: readThreadImpl = null } = {}) {
  const run = { id: "run-live", provider: "codex", streamId: "stream-a", threadId: "thread-a",
    turnId: "turn-live", projectRoot: "D:/synthetic-progress", status: "running", observer: false,
    providerStart: { state: "observed", turnId: "turn-live", acceptedAt: "2026-11-20T00:00:00.000Z" },
    clientUserMessageId: "client-live", startedAt: "2026-11-20T00:00:00.000Z",
    promptPreview: "Current request", userMessages: [{ role: "user", itemId: "user-live",
      clientUserMessageId: "client-live", text: "Current request" }],
    activities: [], activityGroups: [{ id: "comment-live", sourceItemId: "comment-live",
      reasoning: "Current progress continues", activities: [] }],
    responseText: "", progressReasoning: "", activityUnknown: false };
  const taskRuns = new TaskRunRegistry([run]);
  const reads = [], publications = [], scheduled = [], completed = [], errors = [];
  const turn = { id: run.turnId, status: "inProgress", startedAt: run.startedAt,
    items: [{ id: "command-live", type: "commandExecution", command: "synthetic-check", status: "inProgress" }] };
  const line = (payload) => JSON.stringify({ timestamp: "2026-11-20T00:00:01.000Z", type: "event_msg", payload }) + "\n";
  const item = (payload) => JSON.stringify({ timestamp: "2026-11-20T00:00:02.000Z", type: "response_item",
    payload: { ...payload, internal_chat_message_metadata_passthrough: { turn_id: run.turnId } } }) + "\n";
  const native = line({ type: "task_started", turn_id: run.turnId })
    + item({ type: "message", role: "assistant", phase: "commentary", id: "comment-live",
      content: [{ type: "output_text", text: "Current progress continues" }] })
    + item({ type: "function_call", name: "shell_command", call_id: "command-live", status: "in_progress",
      arguments: JSON.stringify({ command: "synthetic-check" }) });
  let activity = parseCodexRolloutActivity(native);
  let readError = null, holdRead = null;
  const snapshots = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "controlled-rollout", readRolloutActivity: async () => activity,
    rolloutTurnState: codexRolloutTurnState, capturedOwner: () => null,
    runtimeActive: async () => true, resolveOwner: async () => "hub",
    readThread: async (threadId, options) => {
      reads.push({ threadId, ...options });
      if (readThreadImpl) return readThreadImpl(threadId, options);
      if (holdRead) await holdRead;
      if (readError) throw readError;
      return { thread: { id: threadId, path: "controlled-rollout", status: { type: "active" },
        turns: options.includeTurns ? [structuredClone(turn)] : [] } };
    },
    selectTurn: selectCodexTurn, turnSnapshot: codexTurnSnapshot, turnStartedAt: codexTurnStartedAt,
    describeItem: describeCodexItem, hubOwner: () => "hub", agentHubPid: () => 1,
    modelLabel: value => value, runtimeLabel: value => value, delay: async () => {},
    reindexRun: item => taskRuns.reindex(item),
  });
  const service = new TaskObservationService({
    providers: { get: () => ({ name: "Codex" }), call(_provider, method, ...args) {
      if (method === "shouldObserveRun") return true;
      if (method === "readRunSnapshot") return snapshots.read(...args);
      if (method === "applyObservedSnapshot") return snapshots.applyObserved(...args);
      if (method === "applyActiveSnapshot") return snapshots.applyActive(...args);
      throw new Error(`Unexpected provider operation ${method}`);
    } }, taskRuns,
    runCoordinator: { completeManaged: async item => {
      completed.push(item.turnId); item.status = "completed"; taskRuns.remove(item);
    } },
    syncTaskRun: (_run, state) => publications.push(structuredClone(state)),
    noteRunActivity: () => {}, scheduleProgressUpdate: () => {},
    setProgressStage: (item, stage) => { item.progressStage = stage; },
    markProgressHeartbeat: () => false, progressHeartbeatState: () => "active",
    managedPollIntervalMs: 20, externalPollIntervalMs: 20,
    logger: { error: (...args) => errors.push(args), log() {} },
    setTimeoutImpl: callback => { scheduled.push(callback); return scheduled.length; }, clearTimeoutImpl() {},
  });
  const entry = { ...run, title: "Current live progress", workspaceId: "workspace-1", running: false };
  const desktop = createDesktopSnapshotFactory({
    clock: { nowMs: Date.now, nowIso: () => new Date().toISOString() },
    context: { latestUsage: () => null, isCompacting: () => false, compactionFor: () => null },
    runs: { forTask: target => taskRuns.forTask(target), titleFor: () => "Current live progress" },
    tasks: { savedLastMessage: () => ({ turnId: "previous-turn", text: "Previous final" }),
      projectNameFor: () => "Synthetic", entryIsSelected: () => true,
      executionRuntimeLabel: () => "Hub", orderingActivityAtMs: () => 0 },
    selection: { selectedTask: () => entry },
  });
  const readModel = new DesktopReadModelService({
    snapshot: async () => ({}), resolveReadTask: () => entry,
    readStateStore: { markRead: async () => null }, trustedDeviceUserId: () => "synthetic",
    lastTaskMessage: () => null, hasUnread: () => false,
  });
  return { run, turn, taskRuns, snapshots, service, reads, publications, scheduled, completed, errors,
    project: () => readModel.projectTask(desktop.desktopTaskSnapshot(entry)),
    poll: async () => { run.observerTimer = null; await service.poll(run); },
    fail: (error = new Error("controlled provider read failure")) => { readError = error; },
    resume: () => { readError = null; },
    hold: promise => { holdRead = promise; },
    terminal: () => { activity = parseCodexRolloutActivity(line({ type: "task_started", turn_id: run.turnId })
      + line({ type: "task_complete", turn_id: run.turnId, last_agent_message: "Final" })); },
  };
}
