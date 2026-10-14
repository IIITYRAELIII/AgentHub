export class TaskObserverController {
  constructor({
    canObserve,
    readSnapshot,
    pollDelay,
    onUnknown,
    onMissing,
    onTurnChanged,
    onCompleted,
    onActive,
    onError,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    this.canObserve = canObserve;
    this.readSnapshot = readSnapshot;
    this.pollDelay = pollDelay;
    this.onUnknown = onUnknown;
    this.onMissing = onMissing;
    this.onTurnChanged = onTurnChanged;
    this.onCompleted = onCompleted;
    this.onActive = onActive;
    this.onError = onError;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
  }

  schedule(run) {
    if (!this.canObserve(run) || run.observerTimer) return;
    run.observerTimer = this.setTimeoutImpl(() => {
      run.observerTimer = null;
      void this.poll(run);
    }, this.pollDelay(run));
  }

  async poll(run) {
    if (!this.canObserve(run)) return;
    try {
      const snapshot = await this.readSnapshot(run);
      // Snapshot мог читаться дольше, чем переключалась/завершалась задача.
      // Устаревший результат нельзя применять к уже удалённому run.
      if (!this.canObserve(run)) return;
      if (snapshot?.activityUnknown) {
        await this.onUnknown(run, snapshot);
        this.schedule(run);
        return;
      }
      if (!snapshot) {
        await this.onMissing(run);
        this.schedule(run);
        return;
      }
      if (snapshot.turnId && snapshot.turnId !== run.turnId) {
        await this.onTurnChanged(run, snapshot.turnId, snapshot);
      }
      if (!this.canObserve(run)) return;
      if (snapshot.completed) {
        await this.onCompleted(run, snapshot);
        return;
      }
      await this.onActive(run, snapshot);
      this.schedule(run);
    } catch (error) {
      if (!this.canObserve(run)) return;
      await this.onError(run, error);
      this.schedule(run);
    }
  }

  pause(run) {
    if (!run?.observerTimer) return;
    this.clearTimeoutImpl(run.observerTimer);
    run.observerTimer = null;
  }
}
