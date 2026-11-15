import { effectiveReleaseTaskIds, effectiveReleaseMetadata, effectiveReleaseTaskScope } from "../domain/release-operation.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { selectedCompositionFields, selectedCompositionIdentity } from "../domain/task-selected-composition.mjs";
import { canonicalReleaseRepositoryRoot } from "./workspace-release-preflight-service.mjs";

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
  if (operation.reviewedMain) return operation.reviewedMain.approvedRepositories;
  const repositories = new Map();
  for (const target of operation.authorization.approvedTargets) {
    if (!target.repositoryRoot || !target.approvedLocalMainCommit || !target.approvedOriginMainCommit) continue;
    const key = canonicalReleaseRepositoryRoot(target.repositoryRoot);
    const existing = repositories.get(key);
    if (existing && (existing.approvedLocalMainCommit !== target.approvedLocalMainCommit
        || existing.approvedOriginMainCommit !== target.approvedOriginMainCommit)) {
      throw new Error(`conflicting repository approval for ${target.repositoryRoot}`);
    }
    if (!existing) repositories.set(key, {
      projectRoot: target.repositoryRoot,
      approvedLocalMainCommit: target.approvedLocalMainCommit,
      approvedOriginMainCommit: target.approvedOriginMainCommit,
    });
  }
  return [...repositories.values()];
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
    const changelogContent = await releaseMetadataBytes(effectiveReleaseMetadata(operation));
    const frozenVersions = operation.firstComposeRecovery?.candidates
      .filter(item => item.kind !== "uncaptured-first-generation-v1");
    const prepared = await this.releasePreflight.prepareOperationGeneration({
      workspaceId: operation.workspaceId,
      operationId: operation.operationId,
      generation,
      ...(effectiveReleaseTaskScope(operation) === "all_await" ? {} : { taskIds: effectiveReleaseTaskIds(operation) }),
      previousSelectedResults: operation.selectedResults,
      ...(frozenVersions?.length ? { frozenVersions } : {}),
      approvedRepositories: approvedRepositories(operation),
      ...(operation.authorization.releaseVersion !== undefined ? { releaseVersion: operation.authorization.releaseVersion } : {}),
      ...(changelogContent ? { changelogContent } : {}),
      ...(operation.authorization.releaseVersion !== undefined ? { releaseVersion: operation.authorization.releaseVersion } : {}),
    });
    return this.#composed(operation, prepared);
  }

  async inspectFirstCompose({ operation, generation }) {
    const result = await this.releasePreflight.firstOperationGeneration({ workspaceId: operation.workspaceId,
      operationId: operation.operationId, generation, taskIds: operation.authorization.taskIds,
      approvedRepositories: approvedRepositories(operation), inspectOnly: true,
      changelogContent: await releaseMetadataBytes(effectiveReleaseMetadata(operation)),
      releaseVersion: operation.authorization.releaseVersion });
    return result.releaseCandidates.map(item => item.binding);
  }

  async recoverFirstCompose({ operation, generation, recovery, validateBeforeCommit }) {
    const prepared = await this.releasePreflight.firstOperationGeneration({ workspaceId: operation.workspaceId,
      operationId: operation.operationId, generation, taskIds: operation.authorization.taskIds,
      approvedRepositories: approvedRepositories(operation), expectedBindings: recovery.candidates,
      changelogContent: await releaseMetadataBytes(effectiveReleaseMetadata(operation)),
      releaseVersion: operation.authorization.releaseVersion, validateBeforeCommit });
    return this.#composed(operation, prepared);
  }

  #composed(operation, prepared) {
    const selectedResults = prepared.releaseCandidates.flatMap((candidate) => (
      candidate.frozenTasks.map((task) => ({ taskId: task.taskId, resultCommit: task.resultCommit,
        ...selectedCompositionFields(task), acceptanceRevision: task.resultReleaseRevision ?? task.taskRevision }))
    ));
    return {
      repositoryBases: prepared.releaseCandidates.map((candidate) => ({
        repositoryRoot: candidate.repositoryRoot,
        baseCommit: candidate.baseCommit,
      })),
      selectedResults,
      ...(effectiveReleaseTaskScope(operation) === "all_await"
        ? { authorizedTaskIds: [...new Set(selectedResults.map(item => item.taskId))].sort() } : {}),
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
      sourceFingerprint: `${prepared.planRevision}:${operation.authorization.fingerprint}${operation.reviewedMain ? `:${operation.reviewedMain.identitySha256}` : ""}${effectiveReleaseTaskScope(operation) === "all_await" ? `:all_await:${operation.testSelectionAmendments?.at(-1)?.identitySha256 ?? "initial"}` : ""}`,
    };
  }

  withTaskSelection({ operation, taskIds, taskScope = null, commit }) {
    return this.releasePreflight.withAwaitTransition(operation.workspaceId, async () => {
      const capture = async () => {
        const results = await this.releasePreflight.operationSelection({ workspaceId: operation.workspaceId,
          ...(taskScope === "all_await" ? {} : { taskIds }) });
        if (taskIds != null && JSON.stringify([...new Set(results.map(item => item.taskId))].sort()) !== JSON.stringify(taskIds)) {
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

  withRetainedGeneration({ operation, generation, commit }) {
    return this.withTaskSelection({ operation, taskScope: effectiveReleaseTaskScope(operation),
      taskIds: effectiveReleaseTaskIds(operation), commit: async (current, validateSelection) => {
        if (selectionIdentity(current) !== selectionIdentity(generation.selectedResults)) {
          throw new Error("Retained generation accepted selection changed");
        }
        const changelogContent = await releaseMetadataBytes(effectiveReleaseMetadata(operation));
        const inspect = async () => {
          const frozen = [];
          for (const candidate of generation.candidates) {
            frozen.push(await this.releasePreflight.releaseGitWorkspaces.inspectRetainedGeneration({
              operationId: operation.operationId, generation: generation.generation,
              workspaceId: operation.workspaceId, candidate, changelogContent,
            }));
          }
          await this.validate({ operation, generation });
          await validateSelection();
          return frozen;
        };
        const frozen = await inspect();
        return this.publication.withRetainedGeneration({ operation, generation, commit: (artifacts, validateArtifacts) =>
          commit([{ frozen, artifacts }], async () => {
            if (selectionIdentity(current) !== selectionIdentity(generation.selectedResults)
                || JSON.stringify(await inspect()) !== JSON.stringify(frozen)) throw new Error("Retained frozen authority changed");
            await releaseMetadataBytes(effectiveReleaseMetadata(operation));
            await validateArtifacts();
          }) });
      } });
  }

  validate({ operation, generation }) {
    return this.releasePreflight.validateOperationGeneration({
      workspaceId: operation.workspaceId,
      generation,
    });
  }

  reservePublication({ operation, generation, reserve, recompose }) {
    return this.releasePreflight.withAwaitTransition(operation.workspaceId, async () => {
      const recovery = operation.retainedGenerationRecoveries?.at(-1);
      if (recovery?.generation === generation.generation) {
        const changelogContent = await releaseMetadataBytes(effectiveReleaseMetadata(operation));
        const frozen = [];
        for (const candidate of generation.candidates) {
          frozen.push(await this.releasePreflight.releaseGitWorkspaces.inspectRetainedGeneration({
            operationId: operation.operationId, generation: generation.generation,
            workspaceId: operation.workspaceId, candidate, changelogContent,
          }));
        }
        if (JSON.stringify(frozen) !== JSON.stringify(recovery.evidence[0]?.frozen)) {
          throw new Error("Retained frozen candidate changed before publication");
        }
      }
      const current = await this.releasePreflight.operationSelection({
        workspaceId: operation.workspaceId,
        ...(effectiveReleaseTaskScope(operation) === "all_await" ? {} : { taskIds: effectiveReleaseTaskIds(operation) }),
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
