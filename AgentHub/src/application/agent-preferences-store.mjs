function oneOf(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function claudeModel(value, fallback) {
  const model = String(value ?? "").trim();
  return model.length > 0
    && model.length <= 256
    && /^[a-z0-9][a-z0-9._:/@\[\]-]*$/iu.test(model)
    ? model
    : fallback;
}

const DEFAULT_ACTIVITY_RECENT_MINUTES = 3 * 60;
const MAX_ACTIVITY_RECENT_MINUTES = 30 * 24 * 60;

function activityRecentMinutes(value, fallback = DEFAULT_ACTIVITY_RECENT_MINUTES) {
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes)
    ? Math.max(0, Math.min(MAX_ACTIVITY_RECENT_MINUTES, minutes))
    : fallback;
}

export class AgentPreferencesStore {
  constructor({
    selectionStore,
    taskMetadata,
    codexModels,
    claudeModels,
    reasoningEfforts,
    codexReasoningEfforts = reasoningEfforts,
    claudeReasoningEfforts = reasoningEfforts,
    collaborationModes,
    defaultCodexModel,
    defaultCodexReasoningEffort,
    defaultCodexCollaborationMode,
    defaultClaudeModel,
    defaultClaudeReasoningEffort,
    defaultClaudeCollaborationMode,
    normalizeCodexModel,
    resolveCodexThreadSettings,
  }) {
    this.selectionStore = selectionStore;
    this.taskMetadata = taskMetadata;
    this.codexModels = new Set(codexModels);
    this.claudeModels = new Set(claudeModels);
    this.codexReasoningEfforts = new Set(codexReasoningEfforts);
    this.claudeReasoningEfforts = new Set(claudeReasoningEfforts);
    this.collaborationModes = new Set(collaborationModes);
    this.normalizeCodexModel = normalizeCodexModel;
    this.resolveCodexThreadSettings = resolveCodexThreadSettings;
    this.defaults = {
      codexModel: normalizeCodexModel(defaultCodexModel),
      codexReasoningEffort: oneOf(
        defaultCodexReasoningEffort,
        this.codexReasoningEfforts,
        [...this.codexReasoningEfforts][0],
      ),
      codexCollaborationMode: oneOf(
        defaultCodexCollaborationMode,
        this.collaborationModes,
        [...this.collaborationModes][0],
      ),
      claudeModel: claudeModel(defaultClaudeModel, [...this.claudeModels][0]),
      claudeReasoningEffort: oneOf(
        defaultClaudeReasoningEffort,
        this.claudeReasoningEfforts,
        [...this.claudeReasoningEfforts][0],
      ),
      claudeCollaborationMode: oneOf(
        defaultClaudeCollaborationMode,
        this.collaborationModes,
        [...this.collaborationModes][0],
      ),
    };
    this.restore({});
  }

  get codexModel() { return this.values.codexModel; }
  get codexReasoningEffort() { return this.values.codexReasoningEffort; }
  get codexCollaborationMode() { return this.values.codexCollaborationMode; }
  get claudeModel() { return this.values.claudeModel; }
  get claudeReasoningEffort() { return this.values.claudeReasoningEffort; }
  get claudeCollaborationMode() { return this.values.claudeCollaborationMode; }
  get includeClaudeUsage() { return this.values.includeClaudeUsage; }
  get activityRecentMinutes() { return this.values.activityRecentMinutes; }
  get defaultCodexModel() { return this.defaults.codexModel; }
  get defaultCodexReasoningEffort() { return this.defaults.codexReasoningEffort; }

  setCodexModel(value) {
    if (!this.codexModels.has(value)) throw new Error("unknown Codex model");
    return this.#set("codexModel", value);
  }

  setClaudeModel(value) {
    const model = claudeModel(value, "");
    if (!model) {
      throw new Error("unknown Claude model");
    }
    return this.#set("claudeModel", model);
  }

  setCodexReasoning(value) {
    if (!this.codexReasoningEfforts.has(value)) throw new Error("unknown Codex reasoning effort");
    return this.#set("codexReasoningEffort", value);
  }

  setClaudeReasoning(value) {
    if (!this.claudeReasoningEfforts.has(value)) throw new Error("unknown Claude reasoning effort");
    return this.#set("claudeReasoningEffort", value);
  }

  setCodexMode(value) {
    if (!this.collaborationModes.has(value)) throw new Error("unknown Codex collaboration mode");
    return this.#set("codexCollaborationMode", value);
  }

  setClaudeMode(value) {
    if (!this.collaborationModes.has(value)) throw new Error("unknown Claude collaboration mode");
    return this.#set("claudeCollaborationMode", value);
  }

  setIncludeClaudeUsage(value) {
    return this.#set("includeClaudeUsage", value === true);
  }

  setActivityRecentMinutes(value) {
    return this.#set("activityRecentMinutes", activityRecentMinutes(value));
  }

  #set(name, value) {
    if (this.values[name] === value) return { changed: false };
    this.values[name] = value;
    return { changed: true };
  }

  current(provider = this.selectionStore.activeProvider) {
    return provider === "codex"
      ? {
          model: this.codexModel,
          reasoningEffort: this.codexReasoningEffort,
          collaborationMode: this.codexCollaborationMode,
        }
      : {
          model: this.claudeModel,
          reasoningEffort: this.claudeReasoningEffort,
          collaborationMode: this.claudeCollaborationMode,
        };
  }

  captureCodex() {
    return {
      model: this.codexModel,
      reasoningEffort: this.codexReasoningEffort,
      collaborationMode: this.codexCollaborationMode,
    };
  }

  restoreCodex(values = {}) {
    this.values.codexModel = this.normalizeCodexModel(values.model ?? this.codexModel);
    this.values.codexReasoningEffort = oneOf(
      values.reasoningEffort,
      this.codexReasoningEfforts,
      this.codexReasoningEffort,
    );
    this.values.codexCollaborationMode = oneOf(
      values.collaborationMode,
      this.collaborationModes,
      this.codexCollaborationMode,
    );
  }

  rememberCodexTaskSettings(reference = this.#selectedCodexReference()) {
    if (!reference) return null;
    return this.taskMetadata.rememberCodexSettings(reference, {
      model: this.codexModel,
      reasoningEffort: this.codexReasoningEffort,
    });
  }

  restoreCodexTaskSettings(reference, { inheritCurrent = false } = {}) {
    const saved = this.taskMetadata.codexSettings(reference);
    const model = saved?.model
      ? this.normalizeCodexModel(saved.model)
      : inheritCurrent
        ? this.codexModel
        : this.defaultCodexModel;
    const reasoningEffort = oneOf(
      saved?.reasoningEffort,
      this.codexReasoningEfforts,
      inheritCurrent ? this.codexReasoningEffort : this.defaultCodexReasoningEffort,
    );
    this.restoreCodex({ model, reasoningEffort });
    this.taskMetadata.rememberCodexSettings(reference, { model, reasoningEffort });
    return { model, reasoningEffort };
  }

  applyCodexThreadSettings(reference, payload) {
    const resolved = this.resolveCodexThreadSettings(payload, {
      model: this.codexModel,
      reasoningEffort: this.codexReasoningEffort,
    });
    this.taskMetadata.rememberCodexSettings(reference, resolved);
    if (this.#isSelectedCodexReference(reference)) this.restoreCodex(resolved);
    return resolved;
  }

  restore(snapshot = {}) {
    this.values = {
      codexModel: typeof snapshot.codexModel === "string"
        ? this.normalizeCodexModel(snapshot.codexModel)
        : this.defaults.codexModel,
      codexReasoningEffort: oneOf(
        snapshot.codexReasoningEffort,
        this.codexReasoningEfforts,
        this.defaults.codexReasoningEffort,
      ),
      codexCollaborationMode: oneOf(
        snapshot.codexCollaborationMode,
        this.collaborationModes,
        this.defaults.codexCollaborationMode,
      ),
      claudeModel: claudeModel(snapshot.claudeModel, this.defaults.claudeModel),
      claudeReasoningEffort: oneOf(
        snapshot.claudeReasoningEffort,
        this.claudeReasoningEfforts,
        this.defaults.claudeReasoningEffort,
      ),
      claudeCollaborationMode: oneOf(
        snapshot.claudeCollaborationMode,
        this.collaborationModes,
        this.defaults.claudeCollaborationMode,
      ),
      includeClaudeUsage: typeof snapshot.includeClaudeUsage === "boolean"
        ? snapshot.includeClaudeUsage
        : true,
      activityRecentMinutes: activityRecentMinutes(snapshot.activityRecentMinutes),
    };
    return this.snapshot();
  }

  snapshot() {
    return { ...this.values };
  }

  #selectedCodexReference() {
    if (this.selectionStore.activeProvider !== "codex" || !this.selectionStore.threadId) return null;
    return { provider: "codex", threadId: this.selectionStore.threadId };
  }

  #isSelectedCodexReference(reference) {
    const threadId = typeof reference === "string" ? reference : reference?.threadId;
    return this.selectionStore.activeProvider === "codex"
      && String(threadId ?? "") === String(this.selectionStore.threadId ?? "");
  }
}
