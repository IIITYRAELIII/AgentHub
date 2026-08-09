import { normalizedTaskBucket, normalizedTaskText, taskDisplayText } from "../domain/task-board-task.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`task board ${name} is required`);
}

export class TaskBoardService {
  #triageTail = Promise.resolve();

  constructor({
    store,
    workspaceCatalog,
    classify = null,
    autoPlaceConfidence = 0.82,
    logger = console,
  } = {}) {
    for (const name of ["create", "task", "list", "move", "markStarted"]) requiredMethod(store, name);
    if (typeof workspaceCatalog?.hierarchy !== "function") throw new TypeError("workspaceCatalog is required");
    this.store = store;
    this.workspaceCatalog = workspaceCatalog;
    this.classify = typeof classify === "function" ? classify : null;
    const confidence = Number(autoPlaceConfidence);
    this.autoPlaceConfidence = Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.82;
    this.logger = logger;
  }

  task(id) {
    const task = this.store.task(id);
    if (!task) throw new Error("Task не найден");
    return task;
  }

  snapshot() {
    return this.store.list().map((task) => ({
      ...task,
      text: taskDisplayText(task),
    }));
  }

  create(payload = {}) {
    const task = this.store.create({
      ...payload,
      text: normalizedTaskText(payload.text),
      triageStatus: this.classify ? "pending" : "disabled",
    });
    if (task.triageStatus === "pending") this.scheduleTriage(task.id);
    return task;
  }

  move({ id, bucket, workspaceId = null } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    if (normalizedBucket === "workspace" && !this.workspaceCatalog.workspace(workspaceId)) {
      throw new Error("Workspace не найден");
    }
    return this.store.move(id, { bucket: normalizedBucket, workspaceId });
  }

  complete({ id } = {}) {
    return this.store.complete(id);
  }

  remove({ id } = {}) {
    if (!this.store.remove(id)) throw new Error("Task не найден");
    return true;
  }

  markStarted({ id, workspaceId, streamId } = {}) {
    const stream = this.workspaceCatalog.stream(streamId);
    if (!stream || stream.workspaceId !== workspaceId) throw new Error("Stream не найден в выбранном Workspace");
    return this.store.markStarted(id, { workspaceId, streamId });
  }

  captureEnabled(chatId) {
    return this.store.captureEnabled(chatId);
  }

  setCaptureEnabled(chatId, enabled) {
    return this.store.setCaptureEnabled(chatId, enabled);
  }

  retryTriage({ id } = {}) {
    if (!this.classify) throw new Error("Разбор Task через Spark выключен");
    this.task(id);
    this.store.retryTriage(id);
    this.scheduleTriage(id);
    return this.task(id);
  }

  recoverPendingTriage() {
    if (!this.classify) {
      this.store.disablePendingTriage?.();
      return;
    }
    for (const task of this.store.pendingTriage()) this.scheduleTriage(task.id);
  }

  scheduleTriage(id) {
    if (!this.classify) return;
    this.#triageTail = this.#triageTail
      .catch(() => {})
      .then(() => this.#triage(id))
      .catch((error) => {
        this.logger.warn(`Cannot triage Task ${id}: ${error.message}`);
      });
  }

  waitForTriage() {
    return this.#triageTail;
  }

  async #triage(id) {
    const task = this.store.markTriageRunning(id);
    if (!task || task.status === "done") return;
    const workspaces = this.workspaceCatalog.hierarchy().map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
    }));
    try {
      const result = await this.classify({ text: task.rawText, workspaces });
      const confidence = Math.max(0, Math.min(1, Number(result?.confidence) || 0));
      const suggestedWorkspace = workspaces.find((workspace) => workspace.id === result?.workspaceId) ?? null;
      const wantsNotes = result?.category === "note";
      const autoPlace = confidence >= this.autoPlaceConfidence && (wantsNotes || suggestedWorkspace);
      this.store.applyTriage(id, {
        correctedText: result?.correctedText || task.rawText,
        category: result?.category,
        confidence,
        reason: result?.reason,
        bucket: wantsNotes ? "notes" : suggestedWorkspace ? "workspace" : "backlog",
        workspaceId: suggestedWorkspace?.id ?? null,
        autoPlace,
      });
    } catch (error) {
      this.store.markTriageFailed(id, error);
      throw error;
    }
  }
}
