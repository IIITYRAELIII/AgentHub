import { createHash } from "node:crypto";
import { interstreamAuditContentHash } from "./interstream-message.mjs";

// A stopped executor attests through the existing authenticated inter-Stream
// MCP receipt. Checklist links and caller-supplied booleans are not authority.
export function selectedAbsorptionHandoff(value) {
  if (value == null) return null;
  if (!value || Object.keys(value).some((key) => !["requestId", "text"].includes(key))
      || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 200
      || typeof value.text !== "string" || value.text.length > 4096) {
    throw selectedCompositionRequiredError("absorption handoff identity missing");
  }
  let declaration;
  try { declaration = JSON.parse(value.text); } catch {
    throw selectedCompositionRequiredError("absorption handoff is not a structured declaration");
  }
  const fields = ["version", "kind", "workspaceId", "sourceTaskId", "sourceTaskRevision", "survivorTaskId",
    "baseCommit", "sourceCommit", "sourceTree", "survivorParentCommit", "absorptionCommit", "saved", "stopped"];
  if (!declaration || Array.isArray(declaration) || Object.keys(declaration).some((key) => !fields.includes(key))
      || declaration.version !== 1 || declaration.kind !== "task-absorption-handoff-v1"
      || declaration.saved !== true || declaration.stopped !== true
      || !Number.isSafeInteger(declaration.sourceTaskRevision) || declaration.sourceTaskRevision < 1
      || ["workspaceId", "sourceTaskId", "survivorTaskId"].some((key) => (
        typeof declaration[key] !== "string" || !declaration[key] || declaration[key].length > 300
      )) || declaration.sourceTaskId === declaration.survivorTaskId
      || ["baseCommit", "sourceCommit", "sourceTree", "survivorParentCommit", "absorptionCommit"]
        .some((key) => !/^[0-9a-f]{40}$/u.test(declaration[key] ?? ""))) {
    throw selectedCompositionRequiredError("absorption handoff declaration changed");
  }
  return { requestId: value.requestId, text: value.text, declaration };
}

export function normalizedSelectedAbsorption(value) {
  if (value == null) return null;
  const handoff = selectedAbsorptionHandoff({ requestId: value.requestId, text: value.text });
  const origin = value.origin;
  if (!origin || origin.requestId !== handoff.requestId || origin.workspaceId !== handoff.declaration.workspaceId
      || Object.keys(origin).some((key) => !["workspaceId", "streamId", "provider", "sourceThreadId", "requestId"].includes(key))
      || ["streamId", "provider", "sourceThreadId"].some((key) => (
        typeof origin[key] !== "string" || !origin[key] || origin[key].length > 300
      ))
      || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 1
      || typeof value.sourceTaskNumber !== "string" || !value.sourceTaskNumber || value.sourceTaskNumber.length > 300
      || !/^[0-9a-f]{64}$/u.test(value.sourceDescriptionSha256 ?? "")
      || !/^[0-9a-f]{64}$/u.test(value.contentHash ?? "")
      || interstreamAuditContentHash(handoff.text, { origin }) !== value.contentHash
      || Object.keys(value).some((key) => !["requestId", "text", "origin", "contentHash",
        "createdAtMs", "sourceDescriptionSha256", "sourceTaskNumber"].includes(key))) {
    throw selectedCompositionRequiredError("absorption authenticated handoff binding changed");
  }
  return JSON.parse(JSON.stringify(value));
}

export function assertSelectedAbsorptionTasks(value, source, survivor) {
  const input = normalizedSelectedAbsorption(value);
  if (!input) throw selectedCompositionRequiredError("absorption binding missing");
  const { declaration: d } = selectedAbsorptionHandoff({ requestId: input.requestId, text: input.text });
  const item = survivor?.checklist?.find((entry) => entry.linkedTaskId === d.sourceTaskId);
  if (source?.id !== d.sourceTaskId || survivor?.id !== d.survivorTaskId
      || source.revision !== d.sourceTaskRevision || source.workspaceId !== d.workspaceId
      || source.taskNumber !== input.sourceTaskNumber
      || survivor.workspaceId !== d.workspaceId || source.streamId !== input.origin.streamId
      || source.status !== "started" || survivor.status !== "started"
      || source.workflowStatus !== "in_progress" || survivor.workflowStatus !== "in_progress"
      || source.gitReferences?.length || survivor.gitReferences?.length
      || !item || item.completed || source.checklistParent?.task?.id !== survivor.id
      || source.checklistParent?.itemId !== item.id
      || !source.description || !survivor.description?.includes(source.description)
      || createHash("sha256").update(source.description).digest("hex") !== input.sourceDescriptionSha256) {
    throw selectedCompositionRequiredError("absorbed source, saved transfer or current Task state changed");
  }
  return input;
}

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
  if (proof.absorptionInput != null) normalizedSelectedAbsorption(proof.absorptionInput);
  if (proof.proofRoute === "absorbed-own-conflict-v1" && !proof.absorptionInput) {
    throw selectedCompositionRequiredError("absorbed result lost its handoff binding");
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
