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
    for (const name of [
      "create", "task", "list", "move", "markStarted", "orderedWorkspaceIds", "moveWorkspace",
    ]) requiredMethod(store, name);
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
    if (!task) throw new Error("Задача не найдена");
    return task;
  }

  snapshot() {
    return this.store.list().map((task) => ({
      ...task,
      text: taskDisplayText(task),
    }));
  }

  workspaces() {
    const workspaces = this.workspaceCatalog.hierarchy();
    const order = this.store.orderedWorkspaceIds(workspaces.map((workspace) => workspace.id));
    const position = new Map(order.map((id, index) => [id, index]));
    return workspaces.slice().sort((left, right) => position.get(left.id) - position.get(right.id));
  }

  create(payload = {}) {
    const task = this.store.create({
      ...payload,
      text: normalizedTaskText(payload.text),
      triageStatus: this.classify && payload.source === "telegram" ? "pending" : "disabled",
    });
    if (task.triageStatus === "pending") this.scheduleTriage(task.id);
    return task;
  }

  move({ id, bucket, workspaceId = null, beforeId = null } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    if (normalizedBucket === "workspace" && !this.workspaceCatalog.workspace(workspaceId)) {
      throw new Error("Workspace не найден");
    }
    return this.store.move(id, { bucket: normalizedBucket, workspaceId, beforeId });
  }

  moveWorkspace({ workspaceId, beforeWorkspaceId = null } = {}) {
    const ids = this.workspaceCatalog.hierarchy().map((workspace) => workspace.id);
    if (!ids.includes(String(workspaceId ?? "").trim())) throw new Error("Workspace не найден");
    if (beforeWorkspaceId && !ids.includes(String(beforeWorkspaceId).trim())) throw new Error("Workspace не найден");
    return this.store.moveWorkspace(ids, { workspaceId, beforeWorkspaceId });
  }

  complete({ id } = {}) {
    return this.store.complete(id);
  }

  remove({ id } = {}) {
    if (!this.store.remove(id)) throw new Error("Задача не найдена");
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
    if (!this.classify) throw new Error("Авторазбор задач выключен");
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
