import { mcpArgumentsHash } from "./mcp-arguments-hash.mjs";

export const TASK_BUCKETS = Object.freeze(["backlog", "workspace", "notes"]);
export const TASK_STATUSES = Object.freeze(["open", "started", "done"]);
export const TASK_WORKFLOW_STATUSES = Object.freeze([
  "new", "in_progress", "blocked", "testing", "awaiting_implementation", "done",
]);

export class TaskAbsorptionCompositionError extends Error {
  constructor(cause) {
    super(`Combined closure refused before Task mutation: ${cause.message}`, { cause });
    this.code = "TASK_ABSORPTION_COMPOSITION_FAILED";
  }
}

export class ReleaseCandidateFrozenError extends Error {
  constructor() {
    super("Release is frozen until completion. Task status was not changed; keep new work in Test and repeat acceptance after the release.");
    this.code = "RELEASE_CANDIDATE_FROZEN";
  }
}

// Raised only after a rejected lifecycle begin has rolled back its transaction.
export class TaskLifecycleBeginRejectedError extends Error {
  constructor(message) {
    super(message);
    this.code = "TASK_LIFECYCLE_BEGIN_REJECTED";
  }
}

export class TaskLifecycleNoEffectError extends Error {
  constructor(evidence) {
    super(evidence.code === "WORKFLOW_REVISION_CHANGED"
      ? "Task workflow cutover revision changed" : "Task workflow cutover status changed");
    this.code = "TASK_WORKFLOW_NO_EFFECT";
  }
}

export class TaskOperationReconciliationRefusedError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
    this.code = "TASK_RECONCILIATION_REFUSED";
  }
}

export class TaskClaimExecutorBusyError extends Error {
  constructor() {
    super("The other executor must finish its active and queued work before Task handoff");
    this.code = "TASK_CLAIM_EXECUTOR_BUSY";
  }
}

export class TaskClaimLockAdmissionError extends Error {
  constructor() {
    super("Task claim timed out before repository preparation; no Task assignment or source preparation was admitted");
    this.code = "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT";
  }
}

export class TaskClaimSourceAdmissionError extends Error {
  constructor(cause) {
    super("Task claim source discovery failed before repository preparation; correct the project root before a new claim", { cause });
    this.code = "TASK_CLAIM_SOURCE_ADMISSION_FAILED";
  }
}

export function claimAdmissionRefusalError(proof) {
  if (proof?.kind === "task-claim-source-admission-v1") return new TaskClaimSourceAdmissionError();
  return proof?.kind === "task-claim-lock-admission-v1"
    ? new TaskClaimLockAdmissionError() : new TaskClaimExecutorBusyError();
}

// Issued by the live claim owner before prepare/claim. Historical error strings
// and the current executor are never sufficient to construct this certificate.
export function claimAdmissionNoEffectEvidence(receipt, taskId = null) {
  const proof = receipt?.result?.evidence ?? receipt?.result?.operatorReconciliation?.evidence;
  if (!proof || proof.version !== 1 || receipt.toolName !== "hub_task_claim"
      || !Number.isSafeInteger(proof.taskRevision) || proof.taskRevision < 1
      || !Number.isSafeInteger(proof.createdAtMs)
      || typeof proof.taskId !== "string" || !proof.taskId || proof.taskId.length > 200
      || (taskId !== null && proof.taskId !== taskId)) return null;
  if (proof.kind === "task-claim-executor-busy-v1") {
    if (proof.code !== "TASK_CLAIM_EXECUTOR_BUSY" || !["active", "queued"].includes(proof.busyReason)
        || typeof proof.ownerStreamId !== "string" || !proof.ownerStreamId || proof.ownerStreamId.length > 200
        || proof.ownerStreamId === proof.streamId) return null;
  } else if (proof.kind === "task-claim-lock-admission-v1") {
    const admission = proof.lockAdmission;
    if (proof.code !== "TASK_CLAIM_LOCK_ADMISSION_TIMEOUT" || admission?.version !== 1
        || admission.kind !== "task-git-dev-lock-admission-v1" || admission.phase !== "before-prepare"
        || admission.operationId !== receipt.requestId || admission.taskId !== proof.taskId
        || !/^[a-f0-9]{12}$/u.test(admission.repositoryKey)
        || [admission.repositoryRoot, admission.lockPath].some(value => typeof value !== "string"
          || !value || value.length > 4000 || value.includes("\0"))
        || !admission.lockPath.replaceAll("\\", "/").endsWith(`/locks/task-git-dev-${admission.repositoryKey}.lock`)) return null;
  } else if (proof.kind === "task-claim-source-admission-v1") {
    const admission = proof.sourceAdmission;
    if (proof.code !== "TASK_CLAIM_SOURCE_ADMISSION_FAILED" || admission?.version !== 1
        || admission.kind !== "task-git-source-admission-v1" || admission.phase !== "before-prepare"
        || admission.operationId !== receipt.requestId || admission.taskId !== proof.taskId
        || typeof admission.projectRoot !== "string" || !admission.projectRoot
        || admission.projectRoot.length > 4000 || admission.projectRoot.includes("\0")) return null;
  } else return null;
  for (const key of ["requestId", "workspaceId", "streamId", "provider", "threadId", "toolName", "argumentsHash", "createdAtMs"]) {
    if (proof[key] !== receipt[key]) return null;
  }
  const args = proof.claimArguments;
  if (!args || args.task_id !== proof.taskId || args.request_id !== proof.requestId
      || Object.keys(args).some(key => !["task_id", "request_id", "dependency_mode", "dependency_override_reason"].includes(key))
      || (args.dependency_mode !== undefined && !["skip", "ensure", "verify"].includes(args.dependency_mode))
      || (args.dependency_override_reason != null && (typeof args.dependency_override_reason !== "string"
        || args.dependency_override_reason.length > 2000))
      || proof.argumentsHash !== mcpArgumentsHash(args)) return null;
  return proof;
}

// Only the existing lifecycle owner writes this outcome. Neither an error string
// nor an absent transition is a certificate; the exact admitted MCP identity is
// sealed with the observed CAS refusal before any workflow effects.
export function workflowAdmissionNoEffectEvidence(outcome, receipt) {
  const proof = outcome?.result?.noEffect;
  if (!proof || proof.version !== 1 || outcome.kind !== "workflow"
      || outcome.operationId !== receipt?.requestId || outcome.taskId !== proof.taskId
      || receipt.toolName !== "hub_task_status_update") return null;
  for (const key of ["requestId", "workspaceId", "streamId", "provider", "threadId", "toolName", "argumentsHash"]) {
    if (typeof proof[key] !== "string" || !proof[key] || proof[key].length > 200
        || proof[key].includes("\0") || proof[key] !== receipt[key]) return null;
  }
  if (!/^[a-f0-9]{64}$/u.test(proof.argumentsHash)
      || proof.createdAtMs !== receipt.createdAtMs
      || !Number.isSafeInteger(proof.createdAtMs)
      || typeof proof.taskId !== "string" || !proof.taskId || proof.taskId.length > 200
      || (proof.projectRoot !== null && (typeof proof.projectRoot !== "string" || !proof.projectRoot
        || proof.projectRoot.length > 2000 || proof.projectRoot.includes("\0")))
      || !TASK_WORKFLOW_STATUSES.includes(proof.targetWorkflowStatus)
      || !TASK_WORKFLOW_STATUSES.includes(proof.observedWorkflowStatus)
      || !Number.isSafeInteger(proof.observedRevision) || proof.observedRevision < 1
      || (proof.expectedRevision !== null && (!Number.isSafeInteger(proof.expectedRevision) || proof.expectedRevision < 1))
      || (proof.expectedWorkflowStatus !== null && !TASK_WORKFLOW_STATUSES.includes(proof.expectedWorkflowStatus))) return null;
  if (proof.argumentsHash !== mcpArgumentsHash({
    request_id: proof.requestId, task_id: proof.taskId, status: proof.targetWorkflowStatus,
    ...(proof.expectedRevision !== null ? { expected_task_revision: proof.expectedRevision } : {}),
    ...(proof.expectedWorkflowStatus !== null ? { expected_workflow_status: proof.expectedWorkflowStatus } : {}),
  })) return null;
  if (proof.code === "WORKFLOW_REVISION_CHANGED") {
    return proof.expectedRevision !== null && proof.expectedRevision !== proof.observedRevision ? proof : null;
  }
  if (proof.code === "WORKFLOW_STATUS_CHANGED") {
    return proof.expectedWorkflowStatus !== null && proof.expectedWorkflowStatus !== proof.observedWorkflowStatus ? proof : null;
  }
  return null;
}

export class TaskDependencyPendingError extends Error {
  constructor(taskId, blockedBy) {
    super(`Task ${taskId} waits for publication of Task ${blockedBy.taskNumber || blockedBy.taskId}`);
    this.code = "TASK_AWAITING_DEPENDENCY_RELEASE";
    this.blockedBy = blockedBy;
  }
}
export const TASK_REFERENCE_INTENTS = Object.freeze(["context", "start"]);
export const TASK_REFERENCE_CONTEXT_REQUEST = "Рассматривай прикреплённые Dashboard Task как контекст к сообщению пользователя; intent=context сам по себе не определяет, начинать ли работу.";
export const TASK_REFERENCE_START_REQUEST = "Начни работу над прикреплённой Dashboard Task.";
const LEGACY_TASK_REFERENCE_CONTEXT_MIGRATION_GUARD = "Учти прикреплённые Dashboard Task как контекст; само прикрепление не является просьбой выполнять их.";
export const TASK_CATEGORIES = Object.freeze(["task", "note", "unknown"]);
export const TASK_SHORT_TITLE_MAX_LENGTH = 100;
export const TASK_TITLE_MAX_LENGTH = 160;
export const TELEGRAM_BUNDLE_TRIAGE_INSTRUCTIONS = Object.freeze([
  "Ниже пакет сообщений, собранный пользователем в Telegram.",
  "Сохраняй порядок и авторов. Пересланные реплики — контекст третьих лиц; не путай их с прямыми комментариями пользователя, отмеченными «Вы».",
]);
export const LEGACY_TELEGRAM_BUNDLE_PREFIX = `${TELEGRAM_BUNDLE_TRIAGE_INSTRUCTIONS.join("\n")}\n\n`;

export function normalizedTaskText(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Введите текст Task");
  return text;
}

export function normalizedTaskTitle(value) {
  const title = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!title) throw new Error("Введите заголовок Task");
  if (title.length > TASK_TITLE_MAX_LENGTH) {
    throw new Error(`Заголовок Task длиннее ${TASK_TITLE_MAX_LENGTH} символов`);
  }
  return title;
}

export function normalizedTaskDescription(value) {
  const description = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  return description;
}

export function normalizedTaskBucket(value) {
  const bucket = String(value ?? "").trim().toLowerCase();
  if (!TASK_BUCKETS.includes(bucket)) throw new Error("Неизвестная колонка Task");
  return bucket;
}

export function normalizedTaskCategory(value) {
  const category = String(value ?? "").trim().toLowerCase();
  return TASK_CATEGORIES.includes(category) ? category : "unknown";
}

export function normalizedTaskWorkflowStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!TASK_WORKFLOW_STATUSES.includes(status)) throw new Error("Неизвестный статус Task");
  return status;
}

function clippedTitle(value) {
  const title = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (title.length <= TASK_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export function taskPresentation(text, { title, description } = {}) {
  const normalizedText = normalizedTaskText(text);
  if (!normalizedText.includes("\n") && normalizedText.length <= TASK_SHORT_TITLE_MAX_LENGTH) {
    return { title: normalizedText, description: "" };
  }
  const lines = normalizedText.split("\n").map((line) => line.trim()).filter(Boolean);
  const fallbackTitle = lines.find((line) => (
    !/^--- Сообщение \d+ · .+ ---$/u.test(line)
    && !/^\[Изображение \d+ приложено/u.test(line)
  )) ?? lines[0] ?? normalizedText;
  const normalizedTitle = clippedTitle(title) || clippedTitle(fallbackTitle);
  const normalizedDescription = description == null
    ? normalizedText
    : String(description).replace(/\r\n?/gu, "\n").trim();
  return { title: normalizedTitle, description: normalizedDescription };
}

export function taskDisplayText(task) {
  return String(task?.correctedText ?? "").trim() || String(task?.rawText ?? "").trim();
}

export function taskDisplayTitle(task) {
  return String(task?.title ?? "").trim() || taskPresentation(taskDisplayText(task)).title;
}

export function taskDescription(task) {
  if (String(task?.title ?? "").trim()) return String(task?.description ?? "").trim();
  return taskPresentation(taskDisplayText(task)).description;
}

export function taskReferenceDescriptor(task, { intent = "context" } = {}) {
  const taskId = String(task?.id ?? "").trim();
  if (!taskId) throw new Error("Task reference does not contain an id");
  const normalizedIntent = String(intent ?? "").trim().toLowerCase();
  if (!TASK_REFERENCE_INTENTS.includes(normalizedIntent)) {
    throw new Error("Unknown Task reference intent");
  }
  const workflowStatus = TASK_WORKFLOW_STATUSES.includes(task?.workflowStatus)
    ? task.workflowStatus
    : (task?.status === "done" ? "done" : (task?.status === "started" ? "in_progress" : "new"));
  return {
    kind: "task",
    taskId,
    taskNumber: String(task?.taskNumber ?? "").trim() || null,
    title: taskDisplayTitle(task),
    workflowStatus,
    workspaceId: String(task?.workspaceId ?? "").trim() || null,
    intent: normalizedIntent,
  };
}

function taskReferenceLink(reference) {
  const title = String(reference?.title ?? "Task").replace(/\r|\n|\[|\]/gu, " ").trim() || "Task";
  const label = String(reference?.taskNumber ?? "").trim() || `Dashboard Task: ${title}`;
  const tooltip = title.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  return `[${label}](agent-hub://task/${encodeURIComponent(reference.taskId)} "${tooltip}")`;
}

export function taskReferencePromptDetails(value) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text.startsWith("# Attached Agent Hub Tasks\n")) return null;
  const requestMarker = /^# My request\s*$/mu;
  const marker = requestMarker.exec(text);
  if (!marker) return null;
  const request = text.slice(marker.index + marker[0].length).trim();
  const generated = request === TASK_REFERENCE_CONTEXT_REQUEST
    || request === LEGACY_TASK_REFERENCE_CONTEXT_MIGRATION_GUARD
    || request === TASK_REFERENCE_START_REQUEST;
  const references = text.slice("# Attached Agent Hub Tasks\n".length, marker.index)
    .split("\n")
    .flatMap((line) => {
      const match = /^- \[([^\]]+)\]\(agent-hub:\/\/task\/([^\s)]+)(?: "((?:\\.|[^"])*)")?\) · status: ([a-z_]+) · intent: (context|start)$/u
        .exec(line.trim());
      if (!match) return [];
      let taskId;
      try {
        taskId = decodeURIComponent(match[2]);
      } catch {
        return [];
      }
      const workflowStatus = TASK_WORKFLOW_STATUSES.includes(match[4]) ? match[4] : "new";
      const legacyTitle = match[1].startsWith("Dashboard Task: ") ? match[1].slice(16).trim() : "";
      const title = String(match[3] ?? legacyTitle ?? "Task").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\").trim() || "Task";
      return [{
        kind: "task",
        taskId,
        taskNumber: legacyTitle ? null : match[1].trim() || null,
        title,
        workflowStatus,
        workspaceId: null,
        intent: match[5],
      }];
    });
  return {
    request,
    displayText: generated ? "" : request,
    generated,
    references,
  };
}

export function messageWithTaskReferences(text, references = []) {
  const values = Array.isArray(references) ? references : [];
  if (!values.length) return String(text ?? "").trim();
  const startsWork = values.some((reference) => reference.intent === "start");
  const request = String(text ?? "").trim() || (startsWork
    ? TASK_REFERENCE_START_REQUEST
    : TASK_REFERENCE_CONTEXT_REQUEST);
  return [
    "# Attached Agent Hub Tasks",
    "",
    ...values.map((reference) => (
      `- ${taskReferenceLink(reference)} · status: ${reference.workflowStatus} · intent: ${reference.intent}`
    )),
    "",
    "Открой актуальное содержимое Task командой MCP `hub_task_get` по `taskId` из ссылки. "
      + "Для intent=context решение о начале работы определяется сопровождающим сообщением пользователя.",
    "",
    "# My request",
    "",
    request,
  ].join("\n");
}
