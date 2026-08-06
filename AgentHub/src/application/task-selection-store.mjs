const PROVIDERS = new Set(["codex", "claude"]);

function provider(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!PROVIDERS.has(normalized)) throw new Error(`unknown provider: ${value}`);
  return normalized;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export class TaskSelectionStore {
  #listeners = new Set();
  #revision = 0;
  #threadIdsByProvider;
  #activeProvider;
  #activeProjectRoot;
  #streamId;
  #threadId;
  #activeThreadTitle;

  constructor({ activeProvider = "codex", activeProjectRoot = "", streamId = null, threadIds = {}, threadId = null, activeThreadTitle = "" } = {}) {
    this.#activeProvider = provider(activeProvider);
    this.#activeProjectRoot = String(activeProjectRoot ?? "").trim();
    this.#streamId = optionalText(streamId);
    this.#threadIdsByProvider = {
      codex: optionalText(threadIds.codex),
      claude: optionalText(threadIds.claude),
    };
    this.#threadId = optionalText(threadId) ?? this.#threadIdsByProvider[this.#activeProvider];
    this.#threadIdsByProvider[this.#activeProvider] = this.#threadId;
    this.#activeThreadTitle = String(activeThreadTitle ?? "").trim();
  }

  get revision() { return this.#revision; }
  get activeProvider() { return this.#activeProvider; }
  get activeProjectRoot() { return this.#activeProjectRoot; }
  get streamId() { return this.#streamId; }
  get threadId() { return this.#threadId; }
  get activeThreadTitle() { return this.#activeThreadTitle; }

  snapshot() {
    return {
      activeProvider: this.#activeProvider,
      activeProjectRoot: this.#activeProjectRoot,
      streamId: this.#streamId,
      threadId: this.#threadId,
      activeThreadTitle: this.#activeThreadTitle,
      threadIds: { ...this.#threadIdsByProvider },
      revision: this.#revision,
    };
  }

  serialize() {
    const { revision: _revision, ...state } = this.snapshot();
    return state;
  }

  subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    if (emitCurrent) listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  #emit(previous) {
    const current = this.snapshot();
    const changed = previous.activeProvider !== current.activeProvider
      || previous.activeProjectRoot !== current.activeProjectRoot
      || previous.streamId !== current.streamId
      || previous.threadId !== current.threadId
      || previous.activeThreadTitle !== current.activeThreadTitle
      || previous.threadIds.codex !== current.threadIds.codex
      || previous.threadIds.claude !== current.threadIds.claude;
    if (!changed) return false;
    this.#revision += 1;
    const next = this.snapshot();
    for (const listener of this.#listeners) listener(next, previous);
    return true;
  }

  restore(snapshot) {
    const previous = this.snapshot();
    const selectedProvider = provider(snapshot?.activeProvider ?? this.#activeProvider);
    const threadIds = snapshot?.threadIds ?? {};
    this.#activeProvider = selectedProvider;
    this.#activeProjectRoot = String(snapshot?.activeProjectRoot ?? "").trim();
    this.#streamId = optionalText(snapshot?.streamId);
    this.#threadIdsByProvider.codex = optionalText(threadIds.codex);
    this.#threadIdsByProvider.claude = optionalText(threadIds.claude);
    this.#threadId = optionalText(snapshot?.threadId) ?? this.#threadIdsByProvider[selectedProvider];
    this.#threadIdsByProvider[selectedProvider] = this.#threadId;
    this.#activeThreadTitle = String(snapshot?.activeThreadTitle ?? "").trim();
    return this.#emit(previous);
  }

  setTitle(title) {
    const previous = this.snapshot();
    this.#activeThreadTitle = String(title ?? "").trim();
    return this.#emit(previous);
  }

  setThread(threadId, { provider: selectedProvider = this.#activeProvider, streamId, title } = {}) {
    const previous = this.snapshot();
    const targetProvider = provider(selectedProvider);
    const normalizedThreadId = optionalText(threadId);
    this.#threadIdsByProvider[targetProvider] = normalizedThreadId;
    if (targetProvider === this.#activeProvider) {
      const threadChanged = normalizedThreadId !== this.#threadId;
      this.#threadId = normalizedThreadId;
      if (streamId !== undefined) this.#streamId = optionalText(streamId);
      else if (threadChanged) this.#streamId = null;
    }
    if (title !== undefined && targetProvider === this.#activeProvider) {
      this.#activeThreadTitle = String(title ?? "").trim();
    }
    return this.#emit(previous);
  }

  selectTask({ activeProvider, activeProjectRoot, streamId = null, threadId, activeThreadTitle = "" }) {
    const previous = this.snapshot();
    const selectedProvider = provider(activeProvider);
    this.#threadIdsByProvider[this.#activeProvider] = this.#threadId;
    this.#activeProvider = selectedProvider;
    this.#activeProjectRoot = String(activeProjectRoot ?? "").trim();
    this.#streamId = optionalText(streamId);
    this.#threadId = optionalText(threadId);
    this.#threadIdsByProvider[selectedProvider] = this.#threadId;
    this.#activeThreadTitle = String(activeThreadTitle ?? "").trim();
    return this.#emit(previous);
  }

  switchProvider(target) {
    const selectedProvider = provider(target);
    const previous = this.snapshot();
    this.#threadIdsByProvider[this.#activeProvider] = this.#threadId;
    this.#activeProvider = selectedProvider;
    this.#threadId = this.#threadIdsByProvider[selectedProvider];
    this.#streamId = null;
    return this.#emit(previous);
  }

  switchProject(projectRoot, { clearThreads = true } = {}) {
    const previous = this.snapshot();
    this.#activeProjectRoot = String(projectRoot ?? "").trim();
    if (clearThreads) {
      this.#streamId = null;
      this.#threadIdsByProvider.codex = null;
      this.#threadIdsByProvider.claude = null;
      this.#threadId = null;
      this.#activeThreadTitle = "";
    }
    return this.#emit(previous);
  }

  rememberCurrentThread() {
    const previous = this.snapshot();
    this.#threadIdsByProvider[this.#activeProvider] = this.#threadId;
    return this.#emit(previous);
  }
}
