import { resolveTaskRecoveryAction, TASK_RECOVERY_ACTIONS } from "../domain/task-recovery.mjs";

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class RunRecoveryCoordinator {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "startTyping", "saveState", "safeDeliver", "sendRunMessage", "completeRun", "logError",
    ]) requiredFunction(dependencies[name], name);
    for (const [name, value] of Object.entries({
      taskRuns: dependencies.taskRuns,
      providers: dependencies.providers,
      runCoordinator: dependencies.runCoordinator,
      observer: dependencies.observer,
      progress: dependencies.progress,
    })) {
      if (!value) throw new TypeError(`${name} is required`);
    }
    this.#d = dependencies;
  }

  async recover(run) {
    const d = this.#d;
    // Retained ownership blocks replay; it is not proof of present execution.
    run.activityUnknown = true;
    let observerSnapshot = null;
    if (run.observer) {
      run.displayRequested = run.displayRequested === true;
      observerSnapshot = await d.providers.call(run.provider, "readRecoverySnapshot", run);
      const action = resolveTaskRecoveryAction({ run, observerSnapshot });
      if (action === TASK_RECOVERY_ACTIONS.OBSERVE) {
        run.activityUnknown = false;
        d.observer.update(run, observerSnapshot);
        if (run.displayRequested) await d.progress.replace(run);
        else await d.progress.clear(run);
        d.observer.schedule(run);
        if (run.displayRequested) d.startTyping();
        await d.saveState();
        return;
      }
      if (action === TASK_RECOVERY_ACTIONS.FINISH_OBSERVED) {
        await d.observer.finish(run, observerSnapshot);
        return;
      }
      if (action === TASK_RECOVERY_ACTIONS.UNKNOWN_OBSERVED) {
        const outcome = await d.observer.finishUnknown(run, observerSnapshot);
        if (outcome?.retained === true) {
          d.observer.schedule(run);
          await d.saveState();
        }
        return;
      }
    }
    return d.runCoordinator.recoverProviderRun(run, { observerSnapshot });
  }

  async finishInterrupted(run) {
    const d = this.#d;
    const providerName = d.providers.get(run.provider).name;
    await d.progress.finish(run, "Локальный процесс прервался при перезапуске бота.");
    await d.safeDeliver(
      run,
      () => d.sendRunMessage(
        run,
        `⚠️ Запуск ${providerName} был прерван. `
          + `Контекст ${run.threadId ?? "не успел получить ID"} сохранён и доступен для продолжения.`,
      ),
      "уведомление о прерывании",
    );
    await d.completeRun(run);
  }

  async recoverAll({ provider = null } = {}) {
    const d = this.#d;
    const runs = d.taskRuns.values().filter((run) => !provider || run.provider === provider);
    const providerRuns = new Map();
    for (const run of runs) {
      const grouped = providerRuns.get(run.provider) ?? [];
      grouped.push(run);
      providerRuns.set(run.provider, grouped);
    }
    for (const [providerId, grouped] of providerRuns) {
      await d.providers.call(providerId, "prepareRecovery", grouped);
    }
    for (const run of runs) {
      try {
        await this.recover(run);
      } catch (error) {
        d.logError(`Cannot recover task ${run.id}:`, error);
        await d.sendRunMessage(run, `⚠️ Не удалось восстановить поток: ${error.message}`).catch(() => {});
        // A failed provider read or reattach is not proof that the exact turn
        // terminated. Keep the managed run active so recovery can be retried
        // and so consumers of provider terminal evidence remain fail-closed.
      }
    }
  }
}
