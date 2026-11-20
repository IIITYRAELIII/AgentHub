import { normalizedTaskGitReferences } from "./task-git-reference.mjs";

export const TASK_CHECKLIST_OPERATIONS = Object.freeze([
  "add", "edit", "remove", "toggle", "move", "link", "unlink", "extract",
]);

export const TASK_CHECKLIST_TEXT_MAX_LENGTH = 1_000;
export const TASK_CHECKLIST_ITEMS_MAX = 500;

export function normalizedTaskChecklistText(value) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text) throw new Error("Введите текст пункта чек-листа");
  if (text.length > TASK_CHECKLIST_TEXT_MAX_LENGTH) {
    throw new Error(`Пункт чек-листа длиннее ${TASK_CHECKLIST_TEXT_MAX_LENGTH} символов`);
  }
  return text;
}

export function normalizedTaskChecklistOperation(value) {
  const operation = String(value ?? "").trim().toLowerCase();
  if (!TASK_CHECKLIST_OPERATIONS.includes(operation)) {
    throw new Error("Неизвестная операция чек-листа");
  }
  return operation;
}

export function normalizedReleaseReference(value) {
  if (value?.manualDelivery != null) {
    const proof = value.manualDelivery;
    if (Object.keys(value).sort().join(",") !== "manualDelivery,taskRevision"
        || !/^[1-9]\d*$/u.test(String(value.taskRevision ?? ""))
        || !proof || typeof proof !== "object" || Array.isArray(proof)
        || Object.keys(proof).sort().join(",") !== "argumentsHash,requestId"
        || typeof proof.requestId !== "string" || !proof.requestId.trim() || proof.requestId.length > 200
        || !/^[a-f0-9]{64}$/u.test(proof.argumentsHash ?? "")) {
      throw Error("Manual release reference requires exact Task revision and original Done receipt");
    }
    return { taskRevision: String(value.taskRevision), manualDelivery: { ...proof } };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !/^[1-9]\d*$/u.test(String(value.taskRevision ?? ""))
      || !Array.isArray(value.gitReferences) || !value.gitReferences.length
      || value.gitReferences.some(ref => !ref || Object.keys(ref).sort().join(",") !== "branch,projectRoot,resultCommit"
        || typeof ref.projectRoot !== "string" || !ref.projectRoot.trim()
        || typeof ref.branch !== "string" || !ref.branch.trim()
        || typeof ref.resultCommit !== "string" || !ref.resultCommit.trim())) {
    throw new Error("Release reference requires exact Task revision and complete Git references");
  }
  const gitReferences = normalizedTaskGitReferences(value.gitReferences);
  if (gitReferences.length !== value.gitReferences.length) throw new Error("Duplicate release reference repository");
  return { taskRevision: String(value.taskRevision), gitReferences };
}

// The canonical Done outcome owns the historical publication evidence. Compare
// current source separately; a later installation need not keep its old PID.
export function manualDeliveryReferenceSourceBinding(proof) {
  if (!proof?.taskId || !Array.isArray(proof.gitReferences) || proof.gitReferences.length
      || proof.dirty !== false || !proof.workspaces?.length || !proof.manualDelivery?.length) {
    throw Error("Manual release reference has no exact owned-source delivery evidence");
  }
  const workspaces = proof.workspaces.map(w => {
    if (w.dirty || !w.projectRoot || !w.repositoryRoot || !w.branch || !/^[a-f0-9]{40}$/u.test(w.headCommit ?? "")) {
      throw Error("Manual release reference source is incomplete");
    }
    return { projectRoot: w.projectRoot, repositoryRoot: w.repositoryRoot, branch: w.branch, headCommit: w.headCommit };
  }).sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
  const deliveries = proof.manualDelivery.map(item => {
    const d = item.delivery;
    if (item.sourceKind !== "owned-managed-source-without-test-ref" || !item.repositoryRoot
        || d?.kind !== "verified-manual-task-delivery-v1" || !/^[a-f0-9]{40}$/u.test(d.revision ?? "")
        || !d.releaseId || !/^[a-f0-9]{64}$/u.test(d.manifestSha256 ?? "") || !d.resultCommits?.length) {
      throw Error("Manual release reference delivery is incomplete");
    }
    return { repositoryRoot: item.repositoryRoot, revision: d.revision, releaseId: d.releaseId,
      manifestSha256: d.manifestSha256, resultCommits: [...d.resultCommits].sort() };
  }).sort((a, b) => a.repositoryRoot.localeCompare(b.repositoryRoot));
  return { taskId: proof.taskId, workspaces, deliveries };
}
