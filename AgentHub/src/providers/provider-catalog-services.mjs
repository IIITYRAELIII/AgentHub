// Projects provider-native task records into the shared Agent Hub catalog.
function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class CodexCatalogProjectionService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "backfillPricing", "readTitleHistories", "findProject", "rememberRolloutPath",
      "readActivity", "runForTask", "selectActiveTurnId", "capturedOwner", "runtimeActive",
      "agentHubPid", "resolveOwner", "catalogEntry", "modelLabel", "threadResponseTitle",
      "confirmationKey", "expectedTitle", "clearExpectedTitle", "preferredTitle", "pinnedTitle",
      "setThreadName", "reconcilePinnedTitle", "savePinnedTitles", "saveState",
    ]) requiredFunction(dependencies[name], name);
    this.#d = dependencies;
  }

  async project(threads) {
    const d = this.#d;
    const entries = [];
    let pinnedTitlesChanged = false;
    let titleConfirmationsChanged = false;
    await d.backfillPricing(threads);
    const titleHistories = await d.readTitleHistories();
    const batchSize = 16;
    for (let start = 0; start < threads.length; start += batchSize) {
      const values = await Promise.all(threads.slice(start, start + batchSize).map(async (thread) => {
        const project = d.findProject(thread.cwd);
        if (!project) return null;
        if (thread.path) d.rememberRolloutPath(String(thread.id), thread.path);
        const activity = await d.readActivity(thread.path);
        let rolloutRunning = activity.running;
        const existingRun = d.runForTask({ provider: "codex", projectRoot: project.path, threadId: thread.id });
        const activeTurnId = existingRun?.turnId ?? d.selectActiveTurnId(activity);
        const capturedOwner = d.capturedOwner(thread.id, activeTurnId);
        if (rolloutRunning && activity.running && existingRun?.observer !== false) {
          rolloutRunning = await d.runtimeActive(activity, {
            turnId: activeTurnId, rolloutPath: thread.path,
            agentHubPid: d.agentHubPid(), capturedOwner,
          });
        }
        const executionOwner = !rolloutRunning
          ? null
          : existingRun?.observer === false
            ? d.hubOwner
            : await d.resolveOwner(activity, {
              turnId: activeTurnId, rolloutPath: thread.path,
              agentHubPid: d.agentHubPid(), capturedOwner,
            });
        const activeStartedAtValues = activity.activeTurnIds
          .map((turnId) => Number(activity.startedAtMsByTurnId?.[turnId]))
          .filter(Number.isFinite);
        const entry = d.catalogEntry(thread, project, {
          rolloutRunning,
          ignoredTurnIds: activity.internalTurnIds ?? [],
          executionOwner: rolloutRunning ? executionOwner : null,
          model: activity.model ? d.modelLabel(activity.model) : existingRun?.model ?? null,
          lastActivityAtMs: activity.lastActivityAtMs,
          startedAtMs: activeStartedAtValues.length ? Math.min(...activeStartedAtValues) : null,
        });
        const titleHistory = titleHistories.get(thread.id) ?? { currentTitle: "", recoverableTitle: "" };
        const appServerTitle = d.threadResponseTitle(thread);
        const expectedTitle = d.expectedTitle(entry.provider, entry.threadId);
        if (expectedTitle && titleHistory.currentTitle === expectedTitle) {
          d.clearExpectedTitle(d.confirmationKey(entry));
          titleConfirmationsChanged = true;
        }
        const discoveredTitle = d.preferredTitle(
          appServerTitle,
          titleHistory,
          d.pinnedTitle(entry.provider, entry.threadId),
          d.expectedTitle(entry.provider, entry.threadId),
        );
        if (
          thread.discoverySource !== "local-rollout"
          && discoveredTitle
          && appServerTitle !== discoveredTitle
        ) {
          await d.setThreadName(entry.threadId, discoveredTitle);
        }
        const resolvedTitle = d.reconcilePinnedTitle(entry.provider, entry.threadId, discoveredTitle);
        pinnedTitlesChanged = resolvedTitle.changed || pinnedTitlesChanged;
        entry.title = resolvedTitle.title || entry.title;
        entry.titleAuthoritative = true;
        return entry;
      }));
      entries.push(...values.filter(Boolean));
    }
    if (pinnedTitlesChanged) await d.savePinnedTitles();
    if (titleConfirmationsChanged) await d.saveState();
    return entries;
  }
}

export class ClaudeCatalogProjectionService {
  #d;

  constructor(dependencies = {}) {
    for (const name of ["audit", "findProject", "applyManagedCancellation", "catalogEntry"]) {
      requiredFunction(dependencies[name], name);
    }
    this.#d = dependencies;
  }

  async project(snapshots) {
    await this.#d.audit(snapshots).catch((error) => this.#d.logError?.(
      "Cannot audit Claude journal transcripts:", error.message,
    ));
    const entries = [];
    for (const snapshot of snapshots) {
      const project = snapshot.cwd ? this.#d.findProject(snapshot.cwd) : null;
      if (project && snapshot.sessionId) entries.push({
        ...this.#d.catalogEntry(this.#d.applyManagedCancellation(snapshot), project),
        titleAuthoritative: true,
      });
    }
    return entries;
  }
}
