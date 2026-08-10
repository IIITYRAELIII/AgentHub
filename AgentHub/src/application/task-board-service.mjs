import { normalizedTaskBucket, normalizedTaskText, taskDisplayText } from "../domain/task-board-task.mjs";
import { EXPERIMENTS_SYSTEM_KEY } from "../domain/workspace-stream-identity.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`task board ${name} is required`);
}

function pinnedLastWorkspaceId(workspaces) {
  return workspaces.find((workspace) => workspace.systemKey === EXPERIMENTS_SYSTEM_KEY)?.id ?? null;
}

function withPinnedLast(order, workspaceId) {
  if (!workspaceId || !order.includes(workspaceId)) return order;
  return [...order.filter((id) => id !== workspaceId), workspaceId];
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
      "create", "task", "list", "move", "markStarted", "orderedColumnIds", "moveColumn",
      "notesComment", "setNotesComment", "reassignWorkspace",
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
    const order = withPinnedLast(
      this.store.orderedColumnIds(workspaces.map((workspace) => workspace.id)),
      pinnedLastWorkspaceId(workspaces),
    );
    const position = new Map(order.map((id, index) => [id, index]));
    return workspaces.slice().sort((left, right) => position.get(left.id) - position.get(right.id));
  }

  layout() {
    const workspaces = this.workspaceCatalog.hierarchy();
    const workspaceIds = workspaces.map((workspace) => workspace.id);
    return {
      columnOrder: withPinnedLast(
        this.store.orderedColumnIds(workspaceIds),
        pinnedLastWorkspaceId(workspaces),
      )
        .map((id) => id === "notes" ? "notes" : `workspace:${id}`),
      notesComment: this.store.notesComment(),
    };
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

  reassignWorkspace(sourceWorkspaceId, targetWorkspaceId) {
    return this.store.reassignWorkspace(sourceWorkspaceId, targetWorkspaceId);
  }

  moveColumn({ columnId, beforeColumnId = null } = {}) {
    const workspaces = this.workspaceCatalog.hierarchy();
    const ids = workspaces.map((workspace) => workspace.id);
    const pinnedId = pinnedLastWorkspaceId(workspaces);
    const storedId = (value) => {
      const normalized = String(value ?? "").trim();
      if (normalized === "notes") return "notes";
      if (!normalized.startsWith("workspace:")) throw new Error("Колонка не найдена");
      const workspaceId = normalized.slice(10);
      if (!ids.includes(workspaceId)) throw new Error("Workspace не найден");
      return workspaceId;
    };
    const movedId = storedId(columnId);
    if (movedId === pinnedId) throw new Error("Workspace Other всегда остаётся последним");
    const targetId = beforeColumnId == null ? pinnedId : storedId(beforeColumnId);
    return this.store.moveColumn(ids, { columnId: movedId, beforeColumnId: targetId });
  }

  setNotesComment({ comment } = {}) {
    return this.store.setNotesComment(comment);
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
      const result = await this.classify({
        text: task.rawText,
        workspaces,
        inputKind: task.sourceDetails?.bundleId ? "telegram-forward-bundle" : "plain",
      });
      const confidence = Math.max(0, Math.min(1, Number(result?.confidence) || 0));
      const suggestedWorkspace = workspaces.find((workspace) => workspace.id === result?.workspaceId) ?? null;
      const wantsNotes = result?.category === "note";
      const autoPlace = confidence >= this.autoPlaceConfidence && (wantsNotes || suggestedWorkspace);
      this.store.applyTriage(id, {
        title: result?.title,
        description: result?.description,
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
