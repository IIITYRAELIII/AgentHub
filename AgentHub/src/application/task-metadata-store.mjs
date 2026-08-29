const TITLE_LIMIT = 80;

function normalizedTitle(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, TITLE_LIMIT);
}

function boundedSet(target, key, value, limit) {
  if (Object.hasOwn(target, key)) delete target[key];
  target[key] = value;
  while (Object.keys(target).length > limit) delete target[Object.keys(target)[0]];
}

function taskKey(reference = {}) {
  const streamId = String(reference.streamId ?? "").trim();
  if (streamId) return `stream\0${streamId}`;
  const provider = String(reference.provider ?? "").trim().toLowerCase();
  const threadId = String(reference.threadId ?? "").trim();
  return provider && threadId ? `${provider}\0${threadId}` : "";
}

function codexSettingsKey(reference) {
  if (typeof reference === "string") return reference.trim();
  const streamId = String(reference?.streamId ?? "").trim();
  if (streamId) return `stream\0${streamId}`;
  return String(reference?.threadId ?? "").trim();
}

export class TaskMetadataStore {
  constructor({
    maximumEntries = 500,
    validReasoningEfforts = [],
    taskKey: taskKeyFactory = taskKey,
  } = {}) {
    this.maximumEntries = Math.max(1, Number(maximumEntries) || 500);
    this.validReasoningEfforts = new Set(validReasoningEfforts);
    this.taskKey = taskKeyFactory;
    this.pinnedTaskTitles = {};
    this.pendingTaskTitleConfirmations = {};
    this.codexTaskSettings = {};
  }

  pinnedTitle(reference) {
    const key = this.taskKey(reference);
    return key ? normalizedTitle(this.pinnedTaskTitles[key]) : "";
  }

  pinTitle(reference, title) {
    const key = this.taskKey(reference);
    const value = normalizedTitle(title);
    if (!key || !value) return "";
    boundedSet(this.pinnedTaskTitles, key, value, this.maximumEntries);
    return value;
  }

  reconcilePinnedTitle(reference, discoveredTitle) {
    const discovered = normalizedTitle(discoveredTitle);
    const pinned = this.pinnedTitle(reference);
    const pending = this.pendingTitle(reference);
    if (pending && discovered !== pending) {
      const changed = pinned !== pending;
      if (changed) this.pinTitle(reference, pending);
      return { title: pending, changed };
    }
    if (!discovered || !pinned || discovered === pinned) {
      return { title: pinned || discovered, changed: false };
    }
    this.pinTitle(reference, discovered);
    return { title: discovered, changed: true };
  }

  pendingTitle(reference) {
    const key = this.taskKey(reference);
    return key ? normalizedTitle(this.pendingTaskTitleConfirmations[key]) : "";
  }

  expectTitle(reference, title) {
    const key = this.taskKey(reference);
    const value = normalizedTitle(title);
    if (key && value) boundedSet(
      this.pendingTaskTitleConfirmations,
      key,
      value,
      this.maximumEntries,
    );
    return value;
  }

  clearExpectedTitle(key) {
    delete this.pendingTaskTitleConfirmations[String(key ?? "")];
  }

  codexSettings(reference) {
    const key = codexSettingsKey(reference);
    const value = key ? this.codexTaskSettings[key] : null;
    return value ? { ...value } : null;
  }

  rememberCodexSettings(reference, settings) {
    const key = codexSettingsKey(reference);
    const model = String(settings?.model ?? "").trim();
    const reasoningEffort = String(settings?.reasoningEffort ?? "").trim();
    if (!key || !model || !this.validReasoningEfforts.has(reasoningEffort)) return null;
    const value = { model, reasoningEffort };
    boundedSet(this.codexTaskSettings, key, value, this.maximumEntries);
    return { ...value };
  }

  deleteCodexSettings(reference) {
    const key = codexSettingsKey(reference);
    if (key) delete this.codexTaskSettings[key];
  }

  restore(snapshot = {}) {
    this.restorePinnedTitles(snapshot.pinnedTaskTitles);
    this.#restoreTitles(
      this.pendingTaskTitleConfirmations,
      snapshot.pendingTaskTitleConfirmations,
    );
    for (const [key, settings] of Object.entries(snapshot.codexTaskSettings ?? {}).slice(
      -this.maximumEntries,
    )) {
      this.rememberCodexSettings(key, settings);
    }
  }

  restorePinnedTitles(values) {
    this.#restoreTitles(this.pinnedTaskTitles, values);
  }

  #restoreTitles(target, values) {
    if (!values || typeof values !== "object") return;
    for (const [key, rawTitle] of Object.entries(values).slice(-this.maximumEntries)) {
      const title = normalizedTitle(rawTitle);
      if (key.includes("\0") && title) boundedSet(target, key, title, this.maximumEntries);
    }
  }

  snapshot() {
    return {
      pinnedTaskTitles: { ...this.pinnedTaskTitles },
      pendingTaskTitleConfirmations: { ...this.pendingTaskTitleConfirmations },
      codexTaskSettings: Object.fromEntries(
        Object.entries(this.codexTaskSettings).map(([key, value]) => [key, { ...value }]),
      ),
    };
  }

  pinnedTitlesSnapshot() {
    return { ...this.pinnedTaskTitles };
  }
}
