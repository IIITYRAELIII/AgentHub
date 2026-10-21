import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { selectedCompositionFields, selectedCompositionIdentity } from "../domain/task-selected-composition.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

async function releaseMetadataBytes(metadata) {
  if (!metadata) return undefined;
  const bytes = await readFile(metadata.sourcePath);
  const rawSha256 = createHash("sha256").update(bytes).digest("hex");
  const canonicalSha256 = createHash("sha256")
    .update(bytes.toString("utf8").replace(/\r\n/gu, "\n")).digest("hex");
  if (bytes.length !== metadata.byteLength
      || rawSha256 !== metadata.rawSha256
      || canonicalSha256 !== metadata.canonicalSha256) {
    throw new Error("release metadata artifact identity changed");
  }
  return bytes;
}
function approvedRepositories(operation) {
  return operation.authorization.approvedTargets.flatMap((target) => (
    target.repositoryRoot && target.approvedLocalMainCommit && target.approvedOriginMainCommit
      ? [{
          projectRoot: target.repositoryRoot,
          approvedLocalMainCommit: target.approvedLocalMainCommit,
          approvedOriginMainCommit: target.approvedOriginMainCommit,
        }]
      : []
  ));
}

function selectionIdentity(value) {
  return JSON.stringify((Array.isArray(value) ? value : []).map((item) => ({
    taskId: String(item.taskId),
    resultCommit: String(item.resultCommit),
    acceptanceRevision: Number(item.acceptanceRevision),
    selectedCompositionIdentity: selectedCompositionIdentity(item),
  })).sort((left, right) => left.taskId.localeCompare(right.taskId)));
}

export class WorkspaceReleaseOperationAdapter {
  constructor({ releasePreflight, publication, finalization } = {}) {
    requiredMethod(releasePreflight, "prepareOperationGeneration");
    requiredMethod(releasePreflight, "validateOperationGeneration");
    requiredMethod(releasePreflight, "operationSelection");
    requiredMethod(releasePreflight, "withAwaitTransition");
    requiredMethod(publication, "publish");
    requiredMethod(publication, "readback");
    requiredMethod(finalization, "finalize");
    this.releasePreflight = releasePreflight;
    this.publication = publication;
    this.finalization = finalization;
  }

  async compose({ operation, generation }) {
    const changelogContent = await releaseMetadataBytes(operation.authorization.releaseMetadata);
    const prepared = await this.releasePreflight.prepareOperationGeneration({
      workspaceId: operation.workspaceId,
      operationId: operation.operationId,
      generation,
      taskIds: operation.authorization.taskIds,
      previousSelectedResults: operation.selectedResults,
      approvedRepositories: approvedRepositories(operation),
      ...(changelogContent ? { changelogContent } : {}),
    });
    const selectedResults = prepared.releaseCandidates.flatMap((candidate) => (
      candidate.frozenTasks.map((task) => ({
        taskId: task.taskId,
        resultCommit: task.resultCommit,
        ...selectedCompositionFields(task),
        acceptanceRevision: task.resultReleaseRevision ?? task.taskRevision,
      }))
    ));
    return {
      repositoryBases: prepared.releaseCandidates.map((candidate) => ({
        repositoryRoot: candidate.repositoryRoot,
        baseCommit: candidate.baseCommit,
      })),
      selectedResults,
      candidates: prepared.releaseCandidates.map((candidate) => ({
        repositoryRoot: candidate.repositoryRoot,
        releaseRoot: candidate.releaseRoot,
        commit: candidate.preReleaseHead,
        tree: candidate.tree,
        manifestHash: candidate.manifestHash,
        generationRoot: candidate.generationRoot,
        planRevision: candidate.planRevision,
        baseCommit: candidate.baseCommit,
        frozenTasks: candidate.frozenTasks,
        manifest: candidate.manifest,
      })),
      sourceFingerprint: `${prepared.planRevision}:${operation.authorization.fingerprint}`,
    };
  }

  validate({ operation, generation }) {
    return this.releasePreflight.validateOperationGeneration({
      workspaceId: operation.workspaceId,
      generation,
    });
  }

  reservePublication({ operation, generation, reserve, recompose }) {
    return this.releasePreflight.withAwaitTransition(operation.workspaceId, async () => {
      const current = await this.releasePreflight.operationSelection({
        workspaceId: operation.workspaceId,
        taskIds: operation.authorization.taskIds,
      });
      return selectionIdentity(current) === selectionIdentity(generation.selectedResults)
        ? reserve()
        : recompose();
    });
  }

  publishTarget(input) {
    return this.publication.publish(input);
  }

  readTarget(input) {
    return this.publication.readback(input);
  }

  cleanupGeneration({ generation }) {
    return this.releasePreflight.discardOperationGeneration(generation);
  }

  finalize(input) {
    return this.finalization.finalize(input);
  }
}
