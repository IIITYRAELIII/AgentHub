// Read-only historical publication facts used by Task Git. No worker or writer.
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { selectedCompositionIdentity } from "../../domain/task-selected-composition.mjs";
import { normalizedOwnGitPublication } from "../../domain/release-base-provenance.mjs";
import { runtimeDatabasePath } from "./runtime-state-store.mjs";
import { releaseIdentitySha256, completedReleaseGenerationEvidence, restoreReleaseOperation, releaseApprovedTargets } from "../../domain/legacy-task-publication-proof.mjs";

// A point read of the explicitly named failed original, never latest release or
// publication eligibility. Closing its service card does not settle its effects.
export function readAbandonedReleaseServiceGeneration({ dataDir, workspaceId, input, checklist } = {}) {
  if (!input?.operationId || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1 || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw new Error("Abandoned release requires exact original revision and generation");
  }
  const file = runtimeDatabasePath(dataDir);
  if (!existsSync(file)) throw new Error("Abandoned release history is absent");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("BEGIN");
    if (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_operations','release_candidate_generations')").get().count !== 2) {
      throw new Error("Abandoned release history is absent");
    }
    const row = database.prepare("SELECT operation_json FROM release_operations WHERE operation_id=? AND workspace_id=? AND state='failed'")
      .get(input.operationId, workspaceId);
    const operation = row && JSON.parse(row.operation_json);
    if (!operation || operation.operationId !== input.operationId || operation.workspaceId !== workspaceId || !operation.streamId
        || operation.revision !== input.expectedRevision || operation.currentGeneration !== input.expectedGeneration
        || operation.state !== "failed" || operation.owner != null || !operation.completedAt) {
      throw new Error("Abandoned release original is not the exact idle FAILED boundary");
    }
    const { fingerprint, ...authorization } = operation.authorization;
    if (releaseIdentitySha256(authorization) !== fingerprint) throw new Error("Abandoned release authorization changed");
    const record = database.prepare("SELECT generation_json,identity_sha256 FROM release_candidate_generations WHERE operation_id=? AND generation=?")
      .get(operation.operationId, operation.currentGeneration);
    const generation = record && JSON.parse(record.generation_json);
    const { identitySha256, ...contents } = generation ?? {};
    if (!generation || !generation.candidates?.length || generation.operationId !== operation.operationId || generation.generation !== operation.currentGeneration
        || identitySha256 !== record.identity_sha256 || releaseIdentitySha256(contents) !== identitySha256) {
      throw new Error("Abandoned release immutable generation changed");
    }
    const selected = items => items.map(item => `${item.taskId}:${item.resultCommit}`).sort();
    const expected = selected(generation.selectedResults);
    if (JSON.stringify(selected(operation.selectedResults)) !== JSON.stringify(expected)
        || JSON.stringify([...(generation.authorizedTaskIds ?? authorization.taskIds)].sort())
          !== JSON.stringify(generation.selectedResults.map(item => item.taskId).sort())) {
      throw new Error("Abandoned release original selection changed");
    }
    const rootKey = value => path.resolve(String(value)).replaceAll("\\", "/").toLowerCase();
    const roots = [...new Set(generation.candidates.map(candidate => rootKey(candidate.repositoryRoot)))].sort();
    const references = (checklist ?? []).map(item => {
      const links = [...String(item.text ?? "").matchAll(/agent-hub:\/\/task\/([0-9a-f-]{36})/gu)];
      const taskId = item.linkedTaskId ?? links[0]?.[1];
      const refs = item.releaseReference?.gitReferences;
      if (!taskId || links.length > 1 || links.length && links[0][1] !== taskId || refs?.length !== 1
          || !roots.includes(rootKey(refs[0].projectRoot))) throw new Error("Abandoned release service reference is not exact");
      return { taskId, resultCommit: refs[0].resultCommit };
    });
    if (!references.length || new Set(references.map(item => item.taskId)).size !== references.length
        || JSON.stringify(selected(references)) !== JSON.stringify(expected)) {
      throw new Error("Abandoned release service checklist differs from the original selection");
    }
    return { streamId: operation.streamId, operationId: operation.operationId, revision: operation.revision, generation: operation.currentGeneration,
      state: operation.state, completedAt: operation.completedAt, lastError: operation.lastError,
      identitySha256: releaseIdentitySha256(operation), generationIdentitySha256: identitySha256,
      selectedResults: generation.selectedResults, repositoryRoots: generation.candidates.map(item => item.repositoryRoot),
      effectsDisposition: "retained_without_settlement" };
  } finally {
    try { database.exec("ROLLBACK"); } finally { database.close(); }
  }
}

// Address only the original operations indexed by the selected Tasks. No global
// latest-publication substitution, filesystem scan, migration or store writes.
export function readPublishedReleaseServiceGeneration({ dataDir, workspaceId, repositoryRoot, selectedTasks } = {}) {
  const file = runtimeDatabasePath(dataDir);
  if (!selectedTasks?.length || !existsSync(file)) return null;
  const rootKey = value => path.resolve(String(value)).replaceAll("\\", "/").toLowerCase();
  const selected = items => items.map(item => `${item.taskId ?? item.id}:${item.resultCommit}`).sort();
  const expected = selected(selectedTasks);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("BEGIN");
    if (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_operations','release_operation_tasks','release_candidate_generations','release_step_receipts')").get().count !== 4) return null;
    const rows = database.prepare(`SELECT DISTINCT o.operation_json, g.generation_json, g.identity_sha256
      FROM release_operations o JOIN release_operation_tasks t ON t.operation_id=o.operation_id
      JOIN release_candidate_generations g ON g.operation_id=o.operation_id
        AND g.generation=json_extract(o.operation_json, '$.currentGeneration')
      WHERE o.workspace_id=? AND o.state='done' AND t.task_id IN (${selectedTasks.map(() => "?").join(",")})`)
      .all(workspaceId, ...selectedTasks.map(item => item.id));
    const matches = [];
    for (const row of rows) {
      const operation = JSON.parse(row.operation_json), generation = JSON.parse(row.generation_json);
      if (operation.workspaceId !== workspaceId || JSON.stringify(selected(generation.selectedResults)) !== JSON.stringify(expected)) continue;
      const { fingerprint, ...authorization } = operation.authorization;
      if (releaseIdentitySha256(authorization) !== fingerprint
          || generation.identitySha256 !== row.identity_sha256) throw new Error("Published release original identity changed");
      const latest = name => {
        const receipt = database.prepare(`SELECT receipt_json FROM release_step_receipts
          WHERE operation_id=? AND generation=? AND step_id=? ORDER BY attempt DESC LIMIT 1`)
          .get(operation.operationId, generation.generation, name);
        return receipt ? JSON.parse(receipt.receipt_json) : null;
      };
      const proof = completedReleaseGenerationEvidence({ operation, generation,
        validation: latest("validate"), finalization: latest("finalize") });
      if (!proof) throw new Error("Published release completed-generation evidence changed");
      if (JSON.stringify([...(generation.authorizedTaskIds ?? authorization.taskIds)].sort())
          !== JSON.stringify(generation.selectedResults.map(item => item.taskId).sort())) {
        throw new Error("Published release authorized selection changed");
      }
      const candidates = generation.candidates.filter(item => rootKey(item.repositoryRoot) === rootKey(repositoryRoot));
      if (candidates.length !== 1) continue;
      const candidate = candidates[0];
      const targets = releaseApprovedTargets(restoreReleaseOperation(operation)).filter(target =>
        target.kind === "agent-hub-publication" && rootKey(target.repositoryRoot) === rootKey(repositoryRoot));
      if (targets.length !== 1) continue;
      const published = latest(`publish:${targets[0].targetId}`);
      if (!published || published.status !== "applied" || published.operationId !== operation.operationId
          || published.generation !== generation.generation
          || published.inputSha256 !== releaseIdentitySha256(published.input)
          || published.input?.candidate !== generation.identitySha256
          || releaseIdentitySha256(published.input.target) !== releaseIdentitySha256(targets[0])
          || !["applied", "already_applied"].includes(published.effect?.status)
          || published.effect?.revision !== candidate.commit
          || releaseIdentitySha256(published.effect) !== releaseIdentitySha256(operation.publicationEffects.targets[targets[0].targetId])) {
        throw new Error("Published release target receipt changed");
      }
      matches.push({ ...proof, candidate, approvedTarget: targets[0] });
    }
    if (matches.length > 1) throw new Error("Published release service selection is ambiguous");
    return matches[0] ?? null;
  } finally {
    try { database.exec("ROLLBACK"); } finally { database.close(); }
  }
}

// Git publication is a narrower fact than successful runtime delivery. Reuse
// existing immutable generation/receipt authority; never advance publication
// state, main, an operation, or an installed runtime from this read.
export function readOwnGitPublicationOrigin({ dataDir, repositoryRoot, localMainCommit,
  publishedRevision, originCommit, taskIds = [] } = {}) {
  if (![localMainCommit, publishedRevision, originCommit].every(value => /^[a-f0-9]{40}$/u.test(value ?? ""))
      || !taskIds.length || !existsSync(runtimeDatabasePath(dataDir))) return null;
  const rootKey = value => path.resolve(String(value)).replaceAll("\\", "/").toLowerCase();
  const db = new DatabaseSync(runtimeDatabasePath(dataDir), { readOnly: true });
  try {
    db.exec("BEGIN");
    if (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_operations','release_operation_tasks','release_candidate_generations','release_step_receipts')").get().count !== 4) return null;
    const rows = db.prepare(`SELECT o.operation_json, g.generation_json, g.identity_sha256
      FROM release_operations o JOIN release_candidate_generations g ON g.operation_id=o.operation_id
      WHERE EXISTS (SELECT 1 FROM release_operation_tasks t WHERE t.operation_id=o.operation_id
        AND t.task_id IN (${taskIds.map(() => "?").join(",")}))
      AND EXISTS (SELECT 1 FROM json_each(g.generation_json, '$.candidates') c
        WHERE json_extract(c.value, '$.commit')=?)`).all(...taskIds, originCommit);
    const matches = [];
    for (const row of rows) {
      const operation = JSON.parse(row.operation_json), generation = JSON.parse(row.generation_json);
      const { fingerprint, ...authorization } = operation.authorization;
      if (releaseIdentitySha256(authorization) !== fingerprint) throw new Error("OWN Git publication authorization changed");
      const { identitySha256, ...contents } = generation;
      if (identitySha256 !== row.identity_sha256 || releaseIdentitySha256(contents) !== identitySha256) {
        throw new Error("OWN Git publication generation changed");
      }
      if (generation.operationId !== operation.operationId) continue;
      const selected = items => items.map(item => `${item.taskId}:${item.resultCommit}`).sort();
      if (JSON.stringify([...(generation.authorizedTaskIds ?? authorization.taskIds)].sort())
          !== JSON.stringify(generation.selectedResults.map(item => item.taskId).sort())) continue;
      const candidates = generation.candidates.filter(item => rootKey(item.repositoryRoot) === rootKey(repositoryRoot)
        && item.commit === originCommit);
      if (candidates.length !== 1) continue;
      const candidate = candidates[0], manifest = candidate.manifest, provenance = manifest?.baseProvenance;
      if (manifest?.workspaceId !== operation.workspaceId || manifest.compositionPolicy !== "main-selected-git-merge-v1"
          || provenance?.publishedBaseCommit !== publishedRevision || provenance.agreedMainCommit !== localMainCommit
          || JSON.stringify(selected(manifest.tasks ?? [])) !== JSON.stringify(selected(generation.selectedResults))) continue;
      const targets = releaseApprovedTargets(restoreReleaseOperation(operation)).filter(target => target.kind === "agent-hub-publication"
        && rootKey(target.repositoryRoot) === rootKey(repositoryRoot) && target.approvedLocalMainCommit === localMainCommit
        && target.approvedOriginMainCommit === (provenance.approvedOriginMainCommit ?? publishedRevision));
      if (targets.length !== 1) continue;
      const receipts = db.prepare("SELECT receipt_json FROM release_step_receipts WHERE operation_id=? AND generation=? AND step_id IN (?, ?)")
        .all(operation.operationId, generation.generation, "validate", `publish:${targets[0].targetId}`)
        .map(record => JSON.parse(record.receipt_json));
      const exact = receipt => receipt.operationId === operation.operationId && receipt.generation === generation.generation
        && receipt.input?.candidate === identitySha256 && receipt.inputSha256 === releaseIdentitySha256(receipt.input);
      if (!receipts.some(receipt => exact(receipt) && receipt.stepId === "validate" && receipt.status === "applied")
          || !receipts.some(receipt => exact(receipt) && receipt.stepId === `publish:${targets[0].targetId}`
            && releaseIdentitySha256(receipt.input.target) === releaseIdentitySha256(targets[0]))) continue;
      matches.push(normalizedOwnGitPublication({ kind: "validated-own-git-publication-v1",
        operationId: operation.operationId, generation: generation.generation, identitySha256,
        repositoryRoot: candidate.repositoryRoot, publishedBaseCommit: publishedRevision,
        agreedMainCommit: localMainCommit, commit: candidate.commit, tree: candidate.tree }));
    }
    if (matches.length > 1) throw new Error("OWN Git publication origin is ambiguous");
    return matches[0] ?? null;
  } finally {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

// Read-only OWN publication fact: immutable original, validated generation and
// descriptor matching the actual remote, independent of later operation state.
export function readNativePublishedSelectedComposition({ dataDir, preview, remoteCommit } = {}) {
  const file = runtimeDatabasePath(dataDir);
  if (!existsSync(file) || !/^[a-f0-9]{40}$/u.test(remoteCommit ?? "")) return null;
  const database = new DatabaseSync(file, { readOnly: true });
  const rootKey = value => path.resolve(String(value)).replaceAll("\\", "/").toLowerCase();
  try {
    database.exec("BEGIN");
    if (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('release_operations','release_operation_tasks','release_candidate_generations','release_step_receipts')").get().count !== 4) return null;
    const rows = database.prepare(`
      SELECT o.operation_json, g.generation_json, g.identity_sha256
      FROM release_operations o
      JOIN release_operation_tasks t ON t.operation_id = o.operation_id
      JOIN release_candidate_generations g ON g.operation_id = o.operation_id
      WHERE t.task_id = ?
      ORDER BY o.updated_at DESC, g.generation DESC LIMIT 65
    `).all(preview.taskId);
    if (rows.length > 64) throw new Error("Published selected proof history exceeds its bound");
    const identity = selectedCompositionIdentity({ taskId: preview.taskId,
      resultCommit: preview.taskCommit, selectedComposition: preview });
    const matches = [];
    for (const row of rows) {
      const operation = JSON.parse(row.operation_json);
      const generation = JSON.parse(row.generation_json);
      if (operation.authorization?.nativeOwnerCutover?.kind !== "native-publication-owner-v1"
          || operation.authorization.nativeOwnerCutover.schemaVersion !== 1
          || operation.workspaceId !== preview.authority?.workspaceId
          || generation.operationId !== operation.operationId) continue;
      const { fingerprint, ...authorization } = operation.authorization;
      if (releaseIdentitySha256(authorization) !== fingerprint) {
        throw new Error("Published original authorization identity changed");
      }
      const { identitySha256, ...contents } = generation;
      if (identitySha256 !== row.identity_sha256 || releaseIdentitySha256(contents) !== identitySha256) {
        throw new Error("Published native generation identity changed");
      }
      if (JSON.stringify([...(generation.authorizedTaskIds ?? operation.authorization.taskIds)].sort())
          !== JSON.stringify(generation.selectedResults.map(task => task.taskId).sort())) continue;
      const selected = generation.selectedResults.find(task => task.taskId === preview.taskId);
      if (!selected || selected.resultCommit !== preview.taskCommit
          || selectedCompositionIdentity(selected) !== identity) continue;
      const candidate = generation.candidates.find(item => rootKey(item.repositoryRoot) === rootKey(preview.repositoryRoot)
        && item.commit === remoteCommit);
      const manifest = candidate?.manifest;
      const captured = manifest?.tasks?.find(task => task.taskId === preview.taskId);
      if (!candidate || manifest?.workspaceId !== operation.workspaceId
          || manifest.compositionPolicy !== "main-selected-git-merge-v1"
          || manifest.baseProvenance?.publishedBaseCommit !== preview.publishedCommit
          || !captured || captured.resultCommit !== preview.taskCommit
          || selectedCompositionIdentity(captured) !== identity) continue;
      const validated = database.prepare(`SELECT status FROM release_step_receipts
        WHERE operation_id = ? AND generation = ? AND step_id = 'validate'
        ORDER BY attempt DESC LIMIT 1`).get(operation.operationId, generation.generation);
      if (validated?.status !== "applied") continue;
      matches.push({ operationId: operation.operationId, generation: generation.generation,
        identitySha256, publishedCommit: remoteCommit, selectedCompositionIdentity: identity });
    }
    if (matches.length > 1) throw new Error("Published selected proof is ambiguous");
    return matches[0] ?? null;
  } finally {
    try { database.exec("ROLLBACK"); } finally { database.close(); }
  }
}

