import { effectiveReleaseTaskIds } from "../domain/release-operation.mjs";
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
  if (operation.reviewedMain) return operation.reviewedMain.approvedRepositories.map(repository => {
    const input = operation.authorization.approvedTargets.find(target => target.repositoryRoot === repository.projectRoot
      && target.nativeResolutionReview)?.nativeResolutionReview;
    return { ...repository, ...(input ? { nativeResolutionReview: input } : {}) };
  });
  return operation.authorization.approvedTargets.flatMap((target) => (
    target.repositoryRoot && target.approvedLocalMainCommit && target.approvedOriginMainCommit
      ? [{
          projectRoot: target.repositoryRoot,
          approvedLocalMainCommit: target.approvedLocalMainCommit,
          approvedOriginMainCommit: target.approvedOriginMainCommit,
          ...(target.nativeResolutionReview ? { nativeResolutionReview: target.nativeResolutionReview } : {}),
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
      taskIds: effectiveReleaseTaskIds(operation),
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
      sourceFingerprint: `${prepared.planRevision}:${operation.authorization.fingerprint}${operation.reviewedMain ? `:${operation.reviewedMain.identitySha256}` : ""}`,
    };
  }

  withTaskSelection({ operation, taskIds, commit }) {
    return this.releasePreflight.withAwaitTransition(operation.workspaceId, async () => {
      const capture = async () => {
        const results = await this.releasePreflight.operationSelection({ workspaceId: operation.workspaceId, taskIds });
        if (JSON.stringify([...new Set(results.map(item => item.taskId))].sort()) !== JSON.stringify(taskIds)) {
          throw new Error("Explicit Task membership contains unaccepted, unknown or foreign Tasks");
        }
        return results;
      };
      const results = await capture();
      return commit(results, async () => {
        if (selectionIdentity(await capture()) !== selectionIdentity(results)) throw new Error("Accepted Task selection changed before amendment CAS");
      });
    });
  }

  withReviewedMainRecovery(input) {
    requiredMethod(this.releasePreflight, "withReviewedMainRecovery");
    return this.releasePreflight.withReviewedMainRecovery(input);
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
        taskIds: effectiveReleaseTaskIds(operation),
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
