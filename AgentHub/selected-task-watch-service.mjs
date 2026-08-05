import {
  shouldAutoObserveTask,
  taskRunKey,
} from "./task-runs.mjs";

function rememberBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
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
    chatId,
    activeTaskTitle,
    rememberLastTaskMessage,
    createObservedRun,
    scheduleObservedRun,
    saveState,
    autoObserve = shouldAutoObserveTask,
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
    this.chatId = chatId;
    this.activeTaskTitle = activeTaskTitle;
    this.rememberLastTaskMessage = rememberLastTaskMessage;
    this.createObservedRun = createObservedRun;
    this.scheduleObservedRun = scheduleObservedRun;
    this.saveState = saveState;
    this.autoObserve = autoObserve;
    this.taskKey = taskKey;
    this.logger = logger;
    this.inFlight = false;
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
      const task = this.selectedTask();
      const targetChatId = this.chatId();
      if (!targetChatId || !task.threadId || this.taskRuns.forTask(task)) return false;

      const snapshot = await this.providers.call(
        task.provider,
        "readRunSnapshot",
        { ...task, turnId: null, observer: true },
      );

      // Snapshot belongs to the task captured above. Re-read selection and run
      // state before applying it: another client may have switched task or
      // started a managed run while provider I/O was pending.
      const currentTask = this.selectedTask();
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
              chatId: targetChatId,
              taskTitle: this.activeTaskTitle(),
              turnId: snapshot.turnId,
            }, answer);
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
        chatId: targetChatId,
        taskTitle: this.activeTaskTitle(),
      }, targetChatId, snapshot, task.provider === "codex" ? snapshot.turnId : null);
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
