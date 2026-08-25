import { randomUUID } from "node:crypto";

import {
  frozenChangeSetManifest,
  normalizedDashboardTaskId,
  normalizedReleaseBatch,
  normalizedTurnObservation,
} from "../domain/release-change-set.mjs";
import { taskReferencePromptDetails } from "../domain/task-board-task.mjs";
import { classifyLegacyReleaseChanges } from "./legacy-release-change-classifier.mjs";

function requiredMethod(value, name) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${name} is required`);
}

function referencedTaskId(prompts) {
  for (const prompt of Array.isArray(prompts) ? prompts : []) {
    const details = taskReferencePromptDetails(prompt);
    const started = details?.references?.find((reference) => reference.intent === "start");
    if (started?.taskId) return started.taskId;
  }
  return null;
}

function architectAuthorization(stream) {
  const role = String(stream?.settings?.releaseRole ?? "").trim().toLowerCase();
  if (role === "architect") return "stream-settings";
  const name = String(stream?.name ?? stream?.displayName ?? "").trim().toLowerCase();
  return name === "architect" ? "stream-name-migration" : "";
}

export class ReleaseChangeSetService {
  constructor({
    store, legacyStore = store, inspectLegacyFile, verifyFreezeEvidence, idFactory = randomUUID,
  } = {}) {
    for (const name of [
      "resolveThread", "stream", "recordChangeSetObservation", "changeSet", "changeSets",
      "freezeChangeSet", "transitionChangeSet", "recordReleaseBatch", "releaseBatches",
      "legacyReleaseChangeCoverage",
    ]) requiredMethod(store, name);
    requiredMethod(legacyStore, "releaseChanges");
    if (typeof verifyFreezeEvidence !== "function") {
      throw new TypeError("verifyFreezeEvidence is required");
    }
    this.store = store;
    this.legacyStore = legacyStore;
    this.inspectLegacyFile = typeof inspectLegacyFile === "function"
      ? inspectLegacyFile
      : async () => ({ state: "unknown" });
    this.verifyFreezeEvidence = verifyFreezeEvidence;
    this.idFactory = idFactory;
  }

  observeTurn({ taskId = null, changeSetId = null, prompts = [], ...value } = {}) {
    const observation = normalizedTurnObservation(value);
    const resolved = this.store.resolveThread({ provider: observation.provider, threadId: observation.threadId });
    if (!resolved) return null;
    return this.store.recordChangeSetObservation({
      workspaceId: resolved.workspaceId,
      ownerStreamId: resolved.streamId,
      taskId: normalizedDashboardTaskId(taskId) ?? referencedTaskId(prompts),
      changeSetId,
      generatedChangeSetId: this.idFactory(),
      ...observation,
    });
  }

  list({ workspaceId, includeClosed = false } = {}) {
    return this.store.changeSets(workspaceId, { includeClosed });
  }

  async freeze({ workspaceId, actorStreamId, changeSetId, title = "", repositories, files } = {}) {
    const changeSet = this.#ownedChangeSet({ workspaceId, actorStreamId, changeSetId });
    const manifest = frozenChangeSetManifest({
      revision: changeSet.revision,
      repositories,
      files,
    });
    const verification = await this.verifyFreezeEvidence(manifest);
    if (!verification?.verifier?.name || !verification?.verifier?.version) {
      throw new Error("freeze verifier returned incomplete audit evidence");
    }
    return this.store.freezeChangeSet(changeSet.id, {
      actorStreamId,
      title,
      manifest,
      verification,
      architectOverride: false,
      reason: "owner explicit freeze",
    });
  }

  setStatus({ workspaceId, actorStreamId, changeSetId, status, reason = "" } = {}) {
    const changeSet = this.#ownedChangeSet({ workspaceId, actorStreamId, changeSetId });
    if (String(status).trim().toLowerCase() === "ready") {
      throw new Error("ready requires explicit freeze evidence");
    }
    return this.store.transitionChangeSet(changeSet.id, {
      actorStreamId,
      status,
      reason,
      architectOverride: false,
      authorizationSource: "owner-stream",
    });
  }

  architectOverride({ workspaceId, actorStreamId, changeSetId, status, reason } = {}) {
    const changeSet = this.#workspaceChangeSet({ workspaceId, changeSetId });
    const source = architectAuthorization(this.store.stream(actorStreamId));
    if (!source) throw new Error("Architect override requires an authorized Architect Stream");
    const normalizedReason = String(reason ?? "").trim();
    if (!normalizedReason) throw new Error("Architect override requires an audit reason");
    if (String(status).trim().toLowerCase() === "ready") {
      throw new Error("Architect ready override requires explicit freeze evidence");
    }
    return this.store.transitionChangeSet(changeSet.id, {
      actorStreamId,
      status,
      reason: normalizedReason,
      architectOverride: true,
      authorizationSource: source,
    });
  }

  createReleaseBatch(value = {}) {
    const batch = normalizedReleaseBatch({ id: value.id ?? this.idFactory(), ...value });
    return this.store.recordReleaseBatch(batch);
  }

  releaseBatches({ workspaceId, limit = 50 } = {}) {
    return this.store.releaseBatches(workspaceId, { limit });
  }

  async classifyLegacy({ workspaceId } = {}) {
    return classifyLegacyReleaseChanges(this.legacyStore.releaseChanges(workspaceId), {
      coveredLegacyIds: new Set(this.store.legacyReleaseChangeCoverage(workspaceId)),
      inspectFile: this.inspectLegacyFile,
    });
  }

  #workspaceChangeSet({ workspaceId, changeSetId }) {
    const changeSet = this.store.changeSet(changeSetId);
    if (!changeSet || changeSet.workspaceId !== String(workspaceId ?? "").trim()) {
      throw new Error("ChangeSet is outside the current Workspace");
    }
    return changeSet;
  }

  #ownedChangeSet({ workspaceId, actorStreamId, changeSetId }) {
    const changeSet = this.#workspaceChangeSet({ workspaceId, changeSetId });
    if (changeSet.ownerStreamId !== String(actorStreamId ?? "").trim()) {
      throw new Error("only the owner Stream can change this ChangeSet");
    }
    return changeSet;
  }
}
