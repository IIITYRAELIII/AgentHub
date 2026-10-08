import { createHash } from "node:crypto";

export function selectedCompositionRequiredError(reason) {
  const error = new Error(`Selected composition durable proof required: ${reason}`);
  error.code = "TASK_SELECTED_PROJECTION_REQUIRED";
  return error;
}

export function normalizedSelectedComposition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw selectedCompositionRequiredError("descriptor missing");
  }
  const proof = JSON.parse(JSON.stringify(value));
  const commitFields = ["taskBaseCommit", "taskCommit", "devCommit", "proofCommit",
    "publishedCommit", "remoteCommit", "proofTree", "releaseParent", "selectedReleaseTree"];
  if (proof.kind !== "selected-task-composition-v1" || !proof.taskId
      || commitFields.some((key) => !/^[0-9a-f]{40}$/u.test(proof[key] ?? ""))
      || !/^[0-9a-f]{64}$/u.test(proof.proofHash ?? "")
      || !/^[0-9a-f]{64}$/u.test(proof.previewHash ?? "")
      || createHash("sha256").update(JSON.stringify({ ...proof, previewHash: undefined }))
        .digest("hex") !== proof.previewHash) {
    throw selectedCompositionRequiredError("descriptor identity/hash changed");
  }
  return proof;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

export function selectedCompositionFields(task) {
  if (task?.selectedComposition == null && !task?.selectedCompositionRequired) return {};
  const proof = normalizedSelectedComposition(task?.selectedComposition);
  if (proof.taskId !== task.taskId || proof.taskCommit !== task.resultCommit) {
    throw selectedCompositionRequiredError("Task/result differs from durable selected Test");
  }
  return { selectedCompositionRequired: true, selectedComposition: proof };
}

export function selectedCompositionIdentity(task) {
  const fields = selectedCompositionFields(task);
  return fields.selectedComposition
    ? createHash("sha256").update(JSON.stringify(canonical(fields.selectedComposition))).digest("hex")
    : "";
}
