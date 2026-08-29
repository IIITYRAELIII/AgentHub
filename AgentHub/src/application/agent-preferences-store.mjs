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
const STREAM_CARD_MIN_WIDTH = 90;
const STREAM_CARD_MAX_WIDTH = 450;
const QUICK_MESSAGE_MAX_SCOPES = 200;
const QUICK_MESSAGE_MAX_ITEMS = 20;
const QUICK_MESSAGE_MAX_LABEL = 64;
const QUICK_MESSAGE_MAX_TEXT = 4_000;

function activityRecentMinutes(value, fallback = DEFAULT_ACTIVITY_RECENT_MINUTES) {
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes)
    ? Math.max(0, Math.min(MAX_ACTIVITY_RECENT_MINUTES, minutes))
    : fallback;
}

function streamOrderMode(value) {
  return value === "manual" ? "manual" : "activity";
}

function streamCardWidthMode(value) {
  return value === "fixed" ? "fixed" : "auto";
}

function streamCardFixedWidth(value) {
  const width = Math.round(Number(value));
  return Number.isFinite(width)
    ? Math.max(STREAM_CARD_MIN_WIDTH, Math.min(STREAM_CARD_MAX_WIDTH, width))
    : STREAM_CARD_MIN_WIDTH;
}

function pinnedWorkspaceStreams(value) {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      source = {};
    }
  }
  const normalized = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return normalized;
  for (const [workspaceId, streamIds] of Object.entries(source).slice(0, 100)) {
    const id = String(workspaceId ?? "").trim();
    if (!id || !Array.isArray(streamIds)) continue;
    const pinned = [...new Set(streamIds
      .map((streamId) => String(streamId ?? "").trim())
      .filter(Boolean))]
      .slice(0, 100);
    if (pinned.length) normalized[id] = pinned;
  }
  return normalized;
}

function quickMessageEntry(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { text: value };
  const text = String(source.text ?? "").trim().slice(0, QUICK_MESSAGE_MAX_TEXT);
  if (!text) return null;
  const label = String(source.label ?? text).trim().slice(0, QUICK_MESSAGE_MAX_LABEL) || text.slice(0, QUICK_MESSAGE_MAX_LABEL);
  return {
    id: String(source.id ?? label).trim().slice(0, QUICK_MESSAGE_MAX_LABEL) || label,
    label,
    text,
  };
}

function quickMessageEntries(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  const seen = new Set();
  for (const item of value) {
    const entry = quickMessageEntry(item);
    if (!entry || seen.has(entry.text)) continue;
    entries.push(entry);
    seen.add(entry.text);
    if (entries.length >= QUICK_MESSAGE_MAX_ITEMS) break;
  }
  return entries;
}

function quickMessageScopeMap(value) {
  const normalized = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [scopeId, entries] of Object.entries(value).slice(0, QUICK_MESSAGE_MAX_SCOPES)) {
    const id = String(scopeId ?? "").trim();
    if (!id) continue;
    const normalizedEntries = quickMessageEntries(entries);
    if (normalizedEntries.length) normalized[id] = normalizedEntries;
  }
  return normalized;
}

function quickMessages(value) {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      source = {};
    }
  }
  return {
    global: quickMessageEntries(source?.global),
    streams: quickMessageScopeMap(source?.streams),
    workspaces: quickMessageScopeMap(source?.workspaces),
  };
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
  get streamOrderMode() { return this.values.streamOrderMode; }
  get streamCardWidthMode() { return this.values.streamCardWidthMode; }
  get streamCardFixedWidth() { return this.values.streamCardFixedWidth; }
  get streamCardGapEnabled() { return this.values.streamCardGapEnabled; }
  get showInlineFileRevealButtons() { return this.values.showInlineFileRevealButtons; }
  get pinnedWorkspaceStreams() { return structuredClone(this.values.pinnedWorkspaceStreams); }
  get quickMessages() { return structuredClone(this.values.quickMessages); }
  get defaultCodexModel() { return this.defaults.codexModel; }
  get defaultCodexReasoningEffort() { return this.defaults.codexReasoningEffort; }
  get defaultCodexCollaborationMode() { return this.defaults.codexCollaborationMode; }
  get defaultClaudeModel() { return this.defaults.claudeModel; }
  get defaultClaudeReasoningEffort() { return this.defaults.claudeReasoningEffort; }
  get defaultClaudeCollaborationMode() { return this.defaults.claudeCollaborationMode; }

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

  setStreamOrderMode(value) {
    return this.#set("streamOrderMode", streamOrderMode(value));
  }

  setStreamCardWidthMode(value) {
    return this.#set("streamCardWidthMode", streamCardWidthMode(value));
  }

  setStreamCardFixedWidth(value) {
    return this.#set("streamCardFixedWidth", streamCardFixedWidth(value));
  }

  setStreamCardGapEnabled(value) {
    return this.#set("streamCardGapEnabled", value === true);
  }

  setShowInlineFileRevealButtons(value) {
    return this.#set("showInlineFileRevealButtons", value === true);
  }

  setPinnedWorkspaceStreams(value) {
    return this.#set("pinnedWorkspaceStreams", pinnedWorkspaceStreams(value));
  }

  setQuickMessages(value) {
    return this.#set("quickMessages", quickMessages(value));
  }

  #set(name, value) {
    if (JSON.stringify(this.values[name]) === JSON.stringify(value)) return { changed: false };
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
      streamOrderMode: streamOrderMode(snapshot.streamOrderMode),
      streamCardWidthMode: streamCardWidthMode(snapshot.streamCardWidthMode),
      streamCardFixedWidth: streamCardFixedWidth(snapshot.streamCardFixedWidth),
      streamCardGapEnabled: snapshot.streamCardGapEnabled === true,
      showInlineFileRevealButtons: snapshot.showInlineFileRevealButtons === true,
      pinnedWorkspaceStreams: pinnedWorkspaceStreams(snapshot.pinnedWorkspaceStreams),
      quickMessages: quickMessages(snapshot.quickMessages),
    };
    return this.snapshot();
  }

  snapshot() {
    return {
      ...this.values,
      pinnedWorkspaceStreams: structuredClone(this.values.pinnedWorkspaceStreams),
      quickMessages: structuredClone(this.values.quickMessages),
    };
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
