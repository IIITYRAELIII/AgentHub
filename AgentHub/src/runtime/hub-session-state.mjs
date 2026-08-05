export class HubSessionState {
  #autoApprove;
  #chatId = null;
  #latestDiff = "";
  #processingUpdateId = null;
  #restartRequest = null;
  #stopping = false;
  #updateOffset = 0;

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

  restore({ chatId = null, updateOffset = 0, restartRequest = null } = {}) {
    this.#chatId = chatId;
    this.#updateOffset = Number.isSafeInteger(updateOffset) && updateOffset >= 0 ? updateOffset : 0;
    this.#restartRequest = restartRequest;
  }

  setAutoApprove(value) { this.#autoApprove = Boolean(value); }
  setChatId(value) { this.#chatId = value; }
  setLatestDiff(value) { this.#latestDiff = String(value ?? ""); }
  setProcessingUpdateId(value) { this.#processingUpdateId = value; }
  setRestartRequest(value) { this.#restartRequest = value; }
  setUpdateOffset(value) { this.#updateOffset = value; }

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
