import {
  shouldAutoObserveTask,
  taskRunKey,
} from "../domain/task-runs.mjs";

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function taskIdentity(task) {
  return [
    String(task?.provider ?? "").trim(),
    String(task?.projectRoot ?? "").trim().toLowerCase(),
    String(task?.threadId ?? "").trim(),
  ].join("\0");
}

export class SelectedTaskWatchService {
  constructor({
    providers,
    taskRuns,
    dismissedTasks,
    lastSeenTurnIds,
    timers,
    intervalMs,
    isStopping,
    selectedTask,
    selectedTasks = null,
    chatId,
    activeTaskTitle,
    rememberLastTaskMessage,
    createObservedRun,
    scheduleObservedRun,
    saveState,
    autoObserve = shouldAutoObserveTask,
    shouldWatchTask = () => true,
    taskKey = taskRunKey,
    logger = console,
  }) {
    this.providers = providers;
    this.taskRuns = taskRuns;
    this.dismissedTasks = dismissedTasks;
    this.lastSeenTurnIds = lastSeenTurnIds;
    this.timers = timers;
    this.intervalMs = intervalMs;
    this.isStopping = isStopping;
    this.selectedTask = selectedTask;
    this.selectedTasks = selectedTasks;
    this.chatId = chatId;
    this.activeTaskTitle = activeTaskTitle;
    this.rememberLastTaskMessage = rememberLastTaskMessage;
    this.createObservedRun = createObservedRun;
    this.scheduleObservedRun = scheduleObservedRun;
    this.saveState = saveState;
    this.autoObserve = autoObserve;
    this.shouldWatchTask = shouldWatchTask;
    this.taskKey = taskKey;
    this.logger = logger;
    this.inFlight = false;
    this.cursor = 0;
  }

  #candidates() {
    const supplied = typeof this.selectedTasks === "function"
      ? this.selectedTasks()
      : [{
        clientId: "global",
        task: this.selectedTask(),
        chatId: this.chatId(),
        taskTitle: this.activeTaskTitle(),
      }];
    const unique = new Map();
    for (const candidate of Array.isArray(supplied) ? supplied : []) {
      const task = candidate?.task;
      const identity = taskIdentity(task);
      if (!task?.threadId || !identity || unique.has(identity) || !this.shouldWatchTask(task)) continue;
      unique.set(identity, {
        clientId: String(candidate?.clientId ?? "").trim() || "global",
        task,
        chatId: candidate?.chatId ?? null,
        taskTitle: String(candidate?.taskTitle ?? "").trim(),
        identity,
      });
    }
    return [...unique.values()];
  }

  schedule(delayMs = this.intervalMs) {
    if (this.isStopping()) return;
    this.timers.schedule("selected-task-watch", () => {
      void this.watch();
    }, Math.max(0, Number(delayMs) || 0));
  }

  async watch() {
    if (this.inFlight || this.isStopping()) return false;
    this.inFlight = true;
    try {
      const candidates = this.#candidates().filter(({ task }) => !this.taskRuns.forTask(task));
      if (!candidates.length) return false;
      const candidate = candidates[this.cursor % candidates.length];
      this.cursor = (this.cursor + 1) % Math.max(1, candidates.length);
      const { task } = candidate;

      const snapshot = await this.providers.call(
        task.provider,
        "readRunSnapshot",
        { ...task, turnId: null, observer: true },
      );

      // Snapshot belongs to the task captured above. Re-read selection and run
      // state before applying it: another client may have switched task or
      // started a managed run while provider I/O was pending.
      const current = this.#candidates().find(({ identity }) => identity === candidate.identity);
      if (!current) return false;
      const currentTask = current.task;
      const currentRun = this.taskRuns.forTask(task);
      if (currentRun) return false;

      let stateChanged = false;
      if (this.dismissedTasks.has(task) && !snapshot?.active) {
        this.dismissedTasks.delete(task);
        stateChanged = true;
      }

      const key = this.taskKey(task);
      if (snapshot?.completed && snapshot.turnId) {
        const turnChanged = this.lastSeenTurnIds.get(key) !== snapshot.turnId;
        if (turnChanged) {
          rememberBounded(this.lastSeenTurnIds, key, snapshot.turnId, 500);
          stateChanged = true;
          const answer = String(snapshot.answer ?? "").trim();
          if (answer) {
            this.rememberLastTaskMessage({
              ...task,
              chatId: current.chatId,
              taskTitle: current.taskTitle,
              turnId: snapshot.turnId,
            }, answer, { updatedAt: snapshot.completedAt });
          }
        }
      }
      if (stateChanged) await this.saveState();

      if (!this.autoObserve({
        task,
        selectedTask: currentTask,
        snapshot,
        existingRun: currentRun,
        dismissed: this.dismissedTasks.has(task),
        lastSeenTurnId: this.lastSeenTurnIds.get(key),
      })) return false;

      const run = await this.createObservedRun({
        ...task,
        chatId: current.chatId,
        taskTitle: current.taskTitle,
      }, current.chatId, snapshot, task.provider === "codex" ? snapshot.turnId : null);
      this.scheduleObservedRun(run);
      await this.saveState();
      this.logger.log(`Silently observing external ${task.provider} task ${task.threadId}`);
      return true;
    } catch (error) {
      this.logger.error("Cannot watch selected external task:", error.message);
      return false;
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}
