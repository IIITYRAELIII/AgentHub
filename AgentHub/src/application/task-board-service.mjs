import { createHash } from "node:crypto";

import { attachmentDescriptor } from "../domain/attachment-files.mjs";
import { normalizedTaskBucket, normalizedTaskText, taskDisplayText } from "../domain/task-board-task.mjs";
import { EXPERIMENTS_SYSTEM_KEY } from "../domain/workspace-stream-identity.mjs";
import { workspaceTaskPrefix } from "../domain/task-number.mjs";
import { createTaskBoardMutationOwner } from "./sqlite-mutation-owner.mjs";

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
  #checklistEventRecovery = Promise.resolve();

  constructor({
    store,
    workspaceCatalog,
    classify = null,
    autoPlaceConfidence = 0.82,
    logger = console,
    recordEvent = null,
  } = {}) {
    for (const name of [
      "create", "task", "list", "move", "markStarted", "orderedColumnIds", "moveColumn",
      "notesComment", "setNotesComment", "reassignWorkspace", "claim", "claimedTaskForTurn",
      "recordTaskTurn", "adoptLegacyGitReference", "releaseTasks", "completeRelease",
    ]) requiredMethod(store, name);
    if (typeof workspaceCatalog?.hierarchy !== "function") throw new TypeError("workspaceCatalog is required");
    this.store = typeof store.runMutation === "function" ? createTaskBoardMutationOwner(store) : store;
    this.workspaceCatalog = workspaceCatalog;
    this.classify = typeof classify === "function" ? classify : null;
    const confidence = Number(autoPlaceConfidence);
    this.autoPlaceConfidence = Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.82;
    this.logger = logger;
    this.recordEvent = typeof recordEvent === "function" ? recordEvent : null;
    this.#checklistEventRecovery = Promise.resolve()
      .then(() => this.#deliverChecklistEvents())
      .catch((error) => {
        this.logger.error(`Cannot recover Task checklist events: ${error.message}`);
      });
  }

  close() {
    return this.store.close?.();
  }

  #event(type, task, payload = {}, options = {}) {
    if (!task?.workspaceId || !this.recordEvent) return;
    try {
      const pending = this.recordEvent({
        workspaceId: task.workspaceId,
        streamId: Object.hasOwn(options, "streamId") ? options.streamId : (task.streamId ?? null),
        type,
        subjectId: task.id,
        payload: { taskId: task.id, status: task.status, bucket: task.bucket, ...payload },
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      });
      pending?.catch?.((error) => this.logger.warn(`Cannot record Task event: ${error.message}`));
      return pending;
    } catch (error) {
      this.logger.error(`Cannot record Workspace event for Task ${task.id}:`, error.message);
      return undefined;
    }
  }

  #resolved(value, apply) {
    return value && typeof value.then === "function" ? Promise.resolve(value).then(apply) : apply(value);
  }

  #withEvent(value, type, payload = {}) {
    return this.#resolved(value, (task) => {
      const event = this.#event(type, task, payload);
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  task(id) {
    const task = this.store.task(id);
    if (!task) throw new Error("Задача не найдена");
    return task;
  }

  snapshot() {
    return this.store.list().map((task) => {
      const sourceDetails = { ...(task.sourceDetails ?? {}) };
      const attachments = (Array.isArray(sourceDetails.attachments) ? sourceDetails.attachments : [])
        .map(attachmentDescriptor)
        .filter(Boolean);
      delete sourceDetails.attachments;
      return {
        ...task,
        sourceDetails,
        attachments,
        text: taskDisplayText(task),
      };
    });
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
    const normalizedBucket = normalizedTaskBucket(payload.bucket ?? (payload.workspaceId ? "workspace" : "backlog"));
    const workspace = normalizedBucket === "workspace" ? this.workspaceCatalog.workspace(payload.workspaceId) : null;
    if (normalizedBucket === "workspace" && !workspace) throw new Error("Workspace не найден");
    const created = this.store.create({
      ...payload,
      text: normalizedTaskText(payload.text),
      triageStatus: this.classify && payload.source === "telegram" ? "pending" : "disabled",
      bucket: normalizedBucket,
      workspaceId: workspace?.id ?? null,
      taskPrefix: workspaceTaskPrefix(workspace?.settings),
    });
    return this.#resolved(created, (task) => {
      if (task.triageStatus === "pending") this.scheduleTriage(task.id);
      return task;
    });
  }

  attachToSourceMessage(payload = {}) {
    return this.store.attachToSourceMessage(payload);
  }

  addAttachment({ id, attachment } = {}) {
    requiredMethod(this.store, "addAttachment");
    return this.#withEvent(this.store.addAttachment(id, attachment), "task.attachment_added");
  }

  appendSourceMessage(payload = {}) {
    const result = this.store.appendSourceMessage({
      ...payload,
      text: normalizedTaskText(payload.text),
      triageStatus: this.classify && payload.source === "telegram" ? "pending" : "disabled",
    });
    return this.#resolved(result, (task) => {
      if (task.triageStatus === "pending") this.scheduleTriage(task.id);
      return task;
    });
  }

  mergeSourceMessage(payload = {}) {
    const result = this.store.mergeSourceMessage({
      ...payload,
      text: normalizedTaskText(payload.text),
      triageStatus: this.classify && payload.source === "telegram" ? "pending" : "disabled",
    });
    return this.#resolved(result, (task) => {
      if (task.triageStatus === "pending") this.scheduleTriage(task.id);
      return task;
    });
  }

  move({ id, bucket, workspaceId = null, beforeId = null } = {}) {
    const normalizedBucket = normalizedTaskBucket(bucket);
    if (normalizedBucket === "workspace" && !this.workspaceCatalog.workspace(workspaceId)) {
      throw new Error("Workspace не найден");
    }
    const previous = this.task(id);
    const workspace = normalizedBucket === "workspace" ? this.workspaceCatalog.workspace(workspaceId) : null;
    const result = this.store.move(id, {
      bucket: normalizedBucket, workspaceId, beforeId, taskPrefix: workspaceTaskPrefix(workspace?.settings),
    });
    return this.#resolved(result, (task) => {
      const eventTask = task.workspaceId ? task : { ...task, workspaceId: previous.workspaceId };
      const event = this.#event("task.moved", eventTask);
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  update({ id, title, description = "", taskNumber = undefined } = {}) {
    return this.#withEvent(
      this.store.updatePresentation(id, { title, description, taskNumber }),
      "task.updated",
    );
  }

  async #deliverChecklistEvents() {
    if (!this.recordEvent || typeof this.store.deliverChecklistEvents !== "function") {
      return { delivered: 0, diagnostics: [] };
    }
    const result = await this.store.deliverChecklistEvents((event) => this.recordEvent(event));
    for (const diagnostic of result.diagnostics ?? []) {
      this.logger.error(`Quarantined Task checklist event ${diagnostic.eventId}: ${diagnostic.reason}`);
    }
    return result;
  }

  recoverChecklistEvents() {
    return this.#deliverChecklistEvents();
  }

  async updateChecklist(payload = {}) {
    requiredMethod(this.store, "updateChecklist");
    await this.#checklistEventRecovery;
    const parent = this.task(payload.id);
    const workspace = parent.workspaceId ? this.workspaceCatalog.workspace(parent.workspaceId) : null;
    if (payload.operation === "extract" && !workspace) {
      throw new Error("Вынести пункт можно только из Task существующего Workspace");
    }
    const result = await this.store.updateChecklist({
      ...payload,
      taskPrefix: workspaceTaskPrefix(workspace?.settings),
    });
    await this.#deliverChecklistEvents();
    return result;
  }

  async applyChecklistLinkedTaskAction(payload = {}) {
    requiredMethod(this.store, "applyChecklistLinkedTaskAction");
    const parent = this.task(payload.id);
    const workspace = parent.workspaceId ? this.workspaceCatalog.workspace(parent.workspaceId) : null;
    if (!workspace || workspace.settings?.releaseWorkflowEnabled === true) {
      return { suppressed: true, reason: "release_workflow_enabled" };
    }
    return this.store.applyChecklistLinkedTaskAction(payload);
  }

  checklistRequestResult(payload = {}) {
    requiredMethod(this.store, "checklistRequestResult");
    return this.store.checklistRequestResult(payload);
  }

  reassignWorkspace(sourceWorkspaceId, targetWorkspaceId) {
    const workspace = this.workspaceCatalog.workspace(targetWorkspaceId);
    return this.store.reassignWorkspace(sourceWorkspaceId, targetWorkspaceId, {
      taskPrefix: workspaceTaskPrefix(workspace?.settings),
    });
  }

  assignWorkspaceTaskNumbers(workspaceId) {
    requiredMethod(this.store, "assignWorkspaceTaskNumbers");
    const workspace = this.workspaceCatalog.workspace(workspaceId);
    if (!workspace) throw new Error("Workspace не найден");
    return this.store.assignWorkspaceTaskNumbers(workspace.id, workspaceTaskPrefix(workspace.settings));
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
    return this.#withEvent(this.store.complete(id), "task.completed");
  }

  remove({ id } = {}) {
    return this.#resolved(this.store.remove(id), (removed) => {
      if (!removed) throw new Error("Задача не найдена");
      return true;
    });
  }

  markStarted({
    id, workspaceId, streamId, requestId = null, expectedRevision = null, attemptId = null,
  } = {}) {
    const stream = this.workspaceCatalog.stream(streamId);
    if (!stream || stream.workspaceId !== workspaceId) throw new Error("Stream не найден в выбранном Workspace");
    return this.#withEvent(
      this.store.markStarted(id, {
        workspaceId, streamId, requestId, expectedRevision, attemptId,
      }),
      "task.started",
    );
  }

  setWorkflowStatus({ id, status } = {}) {
    requiredMethod(this.store, "setWorkflowStatus");
    return this.#resolved(this.store.setWorkflowStatus(id, status), (task) => {
      const event = this.#event("task.workflow-status.updated", task, { workflowStatus: task.workflowStatus });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  claim({
    id, workspaceId, streamId, provider, threadId, turnId, operationId,
    operationKind = "claim", gitBaseline = null,
  } = {}) {
    const result = this.store.claim(id, {
      workspaceId, streamId, provider, threadId, turnId, operationId, operationKind, gitBaseline,
    });
    return this.#resolved(result, (task) => {
      const event = this.#event("task.claimed", task, { provider, threadId, turnId, operationId, operationKind });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  claimedTaskForTurn(identity = {}) {
    return this.store.claimedTaskForTurn(identity);
  }

  requestWorkflowStatus({ id, ...payload } = {}) {
    requiredMethod(this.store, "requestWorkflowStatus");
    return this.#resolved(this.store.requestWorkflowStatus(id, payload), (task) => {
      const event = this.#event("task.workflow-status.requested", task, {
        workflowStatus: payload.status,
        turnId: payload.turnId ?? null,
      });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  beginLifecycleTransition({ id, ...payload } = {}) {
    requiredMethod(this.store, "beginLifecycleTransition");
    return this.store.beginLifecycleTransition(id, payload);
  }

  lifecycleTransition(operationId) {
    requiredMethod(this.store, "lifecycleTransition");
    return this.store.lifecycleTransition(operationId);
  }

  lifecycleOutcome(operationId) {
    requiredMethod(this.store, "lifecycleOutcome");
    return this.store.lifecycleOutcome(operationId);
  }

  failLifecycleTransition(operationId, error) {
    requiredMethod(this.store, "failLifecycleTransition");
    return this.store.failLifecycleTransition(operationId, error);
  }

  commitWorkflowTransition(payload = {}) {
    requiredMethod(this.store, "commitWorkflowTransition");
    return this.#resolved(this.store.commitWorkflowTransition(payload), (task) => {
      const event = this.#event("task.workflow-status.updated", task, { workflowStatus: task.workflowStatus });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  rollbackWorkflowOutcome(operationId, error) {
    requiredMethod(this.store, "rollbackWorkflowOutcome");
    return this.#resolved(this.store.rollbackWorkflowOutcome(operationId, error), (task) => {
      const event = this.#event("task.workflow-status.rolled-back", task, { workflowStatus: task.workflowStatus });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  finalizeCleanupTransition(operationId, payload = {}) {
    requiredMethod(this.store, "finalizeCleanupTransition");
    return this.store.finalizeCleanupTransition(operationId, payload);
  }

  mutationDiagnostics() {
    return this.store.mutationDiagnostics?.() ?? {};
  }

  recordTaskTurn(payload = {}) {
    return this.#resolved(this.store.recordTaskTurn(payload), (task) => {
      if (!task) return task;
      const event = this.#event("task.turn-recorded", task, { turnId: payload.turnId });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  recordTaskGitReference(payload = {}) {
    requiredMethod(this.store, "recordTaskGitReference");
    return this.#withEvent(
      this.store.recordTaskGitReference(payload),
      "task.git-reference.recorded",
      { projectRoot: payload.projectRoot },
    );
  }

  adoptLegacyGitReference(payload = {}) {
    requiredMethod(this.store, "adoptLegacyGitReference");
    return this.#withEvent(
      this.store.adoptLegacyGitReference(payload),
      "task.git-reference.adopted",
      { projectRoot: payload.projectRoot, evidenceTurnId: payload.evidenceTurnId },
    );
  }

  releaseTasks(workspaceId) {
    return this.store.releaseTasks(workspaceId);
  }

  completeRelease(workspaceId, payload = {}) {
    return this.store.completeRelease(workspaceId, payload);
  }

  get snapshotRevision() {
    return `${Number(this.store.revision) || 0}:${Number(this.workspaceCatalog.revision) || 0}`;
  }

  prepareStart({ id, workspaceId, streamId, requestId, streamName = null, reassign = false, expectedRevision = null } = {}) {
    const workspace = this.workspaceCatalog.workspace(workspaceId);
    if (!workspace) throw new Error("Workspace не найден");
    const result = this.store.prepareStart(id, {
      workspaceId, streamId, requestId, streamName, reassign, expectedRevision,
    });
    return this.#resolved(result, (task) => {
      const destinationStreamId = task.startDestinationStreamId ?? streamId;
      const existingDestination = this.workspaceCatalog.stream(destinationStreamId);
      const event = this.#event("task.starting", task, {
        requestId,
        destinationStreamId,
      }, {
        // A newly planned Stream is not a catalog member until launch creates
        // it. Until then the durable prepare event belongs to the Workspace and
        // names the intended destination in its payload.
        streamId: existingDestination?.workspaceId === task.workspaceId ? destinationStreamId : null,
        dedupeKey: `task.starting:${createHash("sha256")
          .update(`${task.id}\0${requestId}`)
          .digest("hex")}`,
      });
      return event && typeof event.then === "function" ? event.then(() => task) : task;
    });
  }

  admitPreparedStart({ id, requestId, attemptId, expectedRevision } = {}) {
    requiredMethod(this.store, "admitPreparedStart");
    return this.store.admitPreparedStart(id, {
      requestId, attemptId, expectedRevision,
    });
  }

  fencePreparedStartCancellation({
    id, requestId, cancellationRequestId, expectedRevision,
  } = {}) {
    requiredMethod(this.store, "fencePreparedStartCancellation");
    return this.store.fencePreparedStartCancellation(id, {
      requestId, cancellationRequestId, expectedRevision,
    });
  }

  completePreparedStartCancellation({ id, requestId, expectedRevision } = {}) {
    requiredMethod(this.store, "completePreparedStartCancellation");
    return this.#withEvent(
      this.store.completePreparedStartCancellation(id, { requestId, expectedRevision }),
      "task.start-cancelled",
    );
  }

  cancelPreparedStart({
    id, requestId, reassign = false, expectedRevision = null, attemptId = null,
  } = {}) {
    return this.#withEvent(
      this.store.cancelPreparedStart(id, {
        requestId, reassign, expectedRevision, attemptId,
      }),
      "task.start-cancelled",
    );
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
    return this.#resolved(this.store.retryTriage(id), () => {
      this.scheduleTriage(id);
      return this.task(id);
    });
  }

  async recoverPendingTriage() {
    if (!this.classify) {
      requiredMethod(this.store, "disablePendingTriage");
      const disabled = await this.store.disablePendingTriage();
      return { mode: "disabled", disabled: Number(disabled) || 0, scheduled: 0 };
    }
    const pending = this.store.pendingTriage();
    for (const task of pending) this.scheduleTriage(task.id);
    return { mode: "scheduled", disabled: 0, scheduled: pending.length };
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
    const task = await this.store.markTriageRunning(id);
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
      await this.store.applyTriage(id, {
        title: result?.title,
        description: result?.description,
        correctedText: result?.correctedText || task.rawText,
        category: result?.category,
        confidence,
        reason: result?.reason,
        bucket: wantsNotes ? "notes" : suggestedWorkspace ? "workspace" : "backlog",
        workspaceId: suggestedWorkspace?.id ?? null,
        taskPrefix: workspaceTaskPrefix(suggestedWorkspace?.settings),
        autoPlace,
      });
    } catch (error) {
      await this.store.markTriageFailed(id, error);
      throw error;
    }
  }
}
