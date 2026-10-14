import { createHash } from "node:crypto";

// Immutable authority for a release candidate base. A candidate whose base
// differs from the durable published baseline must carry exactly one of these
// discriminated envelopes in its manifest and checkpoint:
// - explicit-reviewed-main-v1: the Release Manager reviewed local/origin main;
// - selected-task-adoption-v1: selected Task results adopted the base through
//   immutable upstream-adoption receipts (historical pre-cutover authority);
// - agreed-main-native-git-v1: the native ordinary path binds agreed main
//   separately from publication history, without silently changing either.
export const EXPLICIT_REVIEWED_MAIN_PROVENANCE = "explicit-reviewed-main-v1";
export const SELECTED_TASK_ADOPTION_PROVENANCE = "selected-task-adoption-v1";
export const NATIVE_MAIN_PROVENANCE = "agreed-main-native-git-v1";

const COMMIT = /^[0-9a-f]{40}$/u;
const ADOPTION_REF_PREFIX = "refs/agent-hub/upstream-adoptions/";

function text(value) {
  return String(value ?? "").trim();
}

function adoptionRefTaskPrefixes(taskId) {
  const compact = createHash("sha256").update(taskId, "utf8").digest("hex").slice(0, 16);
  return [`${ADOPTION_REF_PREFIX}${taskId}/`, `${ADOPTION_REF_PREFIX}t-${compact}/`];
}

function normalizedAdoption(value) {
  const adoption = {
    taskId: text(value?.taskId),
    resultCommit: text(value?.resultCommit),
    recordRef: text(value?.recordRef),
    recordHash: text(value?.recordHash),
    adoptedCommit: text(value?.adoptedCommit),
    acceptedLocalMainCommit: text(value?.acceptedLocalMainCommit),
  };
  if (!adoption.taskId
      || ![adoption.resultCommit, adoption.recordHash, adoption.adoptedCommit, adoption.acceptedLocalMainCommit]
        .every((commit) => COMMIT.test(commit))
      || !adoptionRefTaskPrefixes(adoption.taskId).some((prefix) => adoption.recordRef.startsWith(prefix))
      || !adoption.recordRef.endsWith(`/${adoption.resultCommit}/${adoption.adoptedCommit}`)) {
    throw new Error("release candidate has invalid selected Task adoption provenance");
  }
  return adoption;
}

export function normalizedReleaseBaseProvenance(value, expectedBaseCommit = null) {
  if (value == null) return null;
  const kind = text(value?.kind);
  if (kind === NATIVE_MAIN_PROVENANCE) {
    const normalized = { schemaVersion: Number(value?.schemaVersion), kind,
      publishedBaseCommit: text(value?.publishedBaseCommit), agreedMainCommit: text(value?.agreedMainCommit) };
    if (value.approvedLocalMainCommit != null || value.approvedOriginMainCommit != null) {
      normalized.approvedLocalMainCommit = text(value.approvedLocalMainCommit);
      normalized.approvedOriginMainCommit = text(value.approvedOriginMainCommit);
      if (normalized.approvedLocalMainCommit !== normalized.agreedMainCommit
          || !COMMIT.test(normalized.approvedOriginMainCommit)) throw new Error("Native reviewed main provenance changed");
    }
    if (normalized.schemaVersion !== 1
        || ![normalized.publishedBaseCommit, normalized.agreedMainCommit].every((commit) => COMMIT.test(commit))
        || expectedBaseCommit && normalized.agreedMainCommit !== expectedBaseCommit) {
      throw new Error("release candidate has invalid agreed main provenance");
    }
    return normalized;
  }
  if (kind === SELECTED_TASK_ADOPTION_PROVENANCE) {
    const adoptions = Array.isArray(value?.adoptions) ? value.adoptions.map(normalizedAdoption) : [];
    const normalized = {
      schemaVersion: Number(value?.schemaVersion),
      kind,
      publishedBaseCommit: text(value?.publishedBaseCommit),
      adoptedBaseCommit: text(value?.adoptedBaseCommit),
      adoptions: adoptions.sort((left, right) => left.taskId.localeCompare(right.taskId)),
    };
    const taskIds = new Set(adoptions.map((adoption) => adoption.taskId));
    if (normalized.schemaVersion !== 1
        || ![normalized.publishedBaseCommit, normalized.adoptedBaseCommit].every((commit) => COMMIT.test(commit))
        || normalized.publishedBaseCommit === normalized.adoptedBaseCommit
        || !adoptions.length || taskIds.size !== adoptions.length
        || adoptions.some((adoption) => adoption.acceptedLocalMainCommit !== adoptions[0].acceptedLocalMainCommit)
        || !adoptions.some((adoption) => adoption.adoptedCommit === normalized.adoptedBaseCommit)) {
      throw new Error("release candidate has invalid selected Task adoption provenance");
    }
    if (expectedBaseCommit && normalized.adoptedBaseCommit !== expectedBaseCommit) {
      throw new Error("release candidate selected Task adoption provenance does not match its base");
    }
    return normalized;
  }
  const normalized = {
    schemaVersion: Number(value?.schemaVersion),
    kind,
    publishedBaseCommit: text(value?.publishedBaseCommit),
    approvedLocalMainCommit: text(value?.approvedLocalMainCommit),
    approvedOriginMainCommit: text(value?.approvedOriginMainCommit),
  };
  if (normalized.schemaVersion !== 1 || normalized.kind !== EXPLICIT_REVIEWED_MAIN_PROVENANCE
      || ![normalized.publishedBaseCommit, normalized.approvedLocalMainCommit,
        normalized.approvedOriginMainCommit].every((commit) => COMMIT.test(commit))) {
    throw new Error("release candidate has invalid explicit reviewed-main provenance");
  }
  if (expectedBaseCommit && normalized.approvedOriginMainCommit !== expectedBaseCommit) {
    throw new Error("release candidate reviewed-main provenance does not match its approved base");
  }
  return normalized;
}

// The base a provenance envelope authorizes. Recovery compares it with the
// exact approved origin main that the operator expects.
export function releaseBaseProvenanceApprovedBase(provenance) {
  if (!provenance) return null;
  if (provenance.kind === NATIVE_MAIN_PROVENANCE) return provenance.agreedMainCommit;
  return provenance.kind === SELECTED_TASK_ADOPTION_PROVENANCE
    ? provenance.adoptedBaseCommit
    : provenance.approvedOriginMainCommit;
}

// Recurrence guard shared by preparation, freeze and preflight. A durable
// published baseline is the authority: an advanced base without an envelope,
// or an envelope for another baseline, is rejected before any effect. Without
// a durable baseline no advancement can be established and only the envelope
// shape is enforced.
export function assertReleaseBaseProvenance({
  publishedBaseCommit = null, baseCommit, provenance, phase = "release candidate",
} = {}) {
  const published = text(publishedBaseCommit);
  if (!published) return;
  if (text(baseCommit) !== published && !provenance) {
    throw new Error(
      `${phase} advances base ${text(baseCommit)} beyond published ${published} without immutable provenance`,
    );
  }
  if (provenance && provenance.publishedBaseCommit !== published) {
    throw new Error(`${phase} base provenance belongs to published ${provenance.publishedBaseCommit}, not ${published}`);
  }
}
