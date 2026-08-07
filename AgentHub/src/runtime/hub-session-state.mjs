export class HubSessionState {
  #autoApprove;
  #chatId = null;
  #latestDiff = "";
  #processingUpdateId = null;
  #restartRequest = null;
  #stopping = false;
  #updateOffset = 0;
  #clientTaskSelections = new Map();

  constructor({ autoApprove = false } = {}) {
    this.#autoApprove = Boolean(autoApprove);
  }

  get autoApprove() { return this.#autoApprove; }
  get chatId() { return this.#chatId; }
  get latestDiff() { return this.#latestDiff; }
  get processingUpdateId() { return this.#processingUpdateId; }
  get restartRequest() { return this.#restartRequest; }
  get stopping() { return this.#stopping; }
  get updateOffset() { return this.#updateOffset; }

  restore({ chatId = null, updateOffset = 0, restartRequest = null, clientTaskSelections = [] } = {}) {
    this.#chatId = chatId;
    this.#updateOffset = Number.isSafeInteger(updateOffset) && updateOffset >= 0 ? updateOffset : 0;
    this.#restartRequest = restartRequest;
    this.#clientTaskSelections.clear();
    for (const entry of Array.isArray(clientTaskSelections) ? clientTaskSelections.slice(-100) : []) {
      const clientId = String(entry?.[0] ?? "").trim();
      const selection = entry?.[1];
      if (!clientId || !selection || typeof selection !== "object") continue;
      this.#clientTaskSelections.set(clientId, structuredClone(selection));
    }
  }

  setAutoApprove(value) { this.#autoApprove = Boolean(value); }
  setChatId(value) { this.#chatId = value; }
  setLatestDiff(value) { this.#latestDiff = String(value ?? ""); }
  setProcessingUpdateId(value) { this.#processingUpdateId = value; }
  setRestartRequest(value) { this.#restartRequest = value; }
  setUpdateOffset(value) { this.#updateOffset = value; }

  clientTaskSelection(clientId) {
    const value = this.#clientTaskSelections.get(String(clientId ?? "").trim());
    return value ? structuredClone(value) : null;
  }

  setClientTaskSelection(clientId, selection) {
    const key = String(clientId ?? "").trim();
    if (!key) throw new Error("clientId is required for task selection");
    this.#clientTaskSelections.delete(key);
    this.#clientTaskSelections.set(key, structuredClone(selection));
    while (this.#clientTaskSelections.size > 100) {
      this.#clientTaskSelections.delete(this.#clientTaskSelections.keys().next().value);
    }
  }

  deleteClientTaskSelection(clientId) {
    return this.#clientTaskSelections.delete(String(clientId ?? "").trim());
  }

  clientTaskSelectionsSnapshot() {
    return [...this.#clientTaskSelections.entries()].map(([key, value]) => [key, structuredClone(value)]);
  }

  setRestartWaiting(value) {
    if (!this.#restartRequest) throw new Error("restart request is not active");
    this.#restartRequest.waitingForRuns = Boolean(value);
  }

  beginStopping() {
    if (this.#stopping) return false;
    this.#stopping = true;
    return true;
  }

  setStopping(value) { this.#stopping = Boolean(value); }
}
