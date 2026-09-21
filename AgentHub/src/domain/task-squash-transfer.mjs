import { createHash } from "node:crypto";

const COMMIT = /^[0-9a-f]{40}$/u;
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
export const LF_NORMALIZATION_ALREADY_PRESENT = "lf-normalization-already-present";

function exactBytes(value) {
  return Buffer.isBuffer(value) ? value : null;
}

export function exactCrLfToLfNormalization({ baseline, newResult, dev } = {}) {
  const baselineBytes = exactBytes(baseline);
  const resultBytes = exactBytes(newResult);
  const devBytes = exactBytes(dev);
  if (!baselineBytes || !resultBytes || !devBytes
      || baselineBytes.includes(0) || resultBytes.includes(0) || devBytes.includes(0)
      || resultBytes.includes(13) || devBytes.includes(13)) return false;
  const normalized = [];
  let replacements = 0;
  for (let index = 0; index < baselineBytes.length; index++) {
    const byte = baselineBytes[index];
    if (byte !== 13) {
      normalized.push(byte);
      continue;
    }
    if (baselineBytes[index + 1] !== 10) return false;
    normalized.push(10);
    replacements++;
    index++;
  }
  return replacements > 0 && Buffer.from(normalized).equals(resultBytes);
}

function requiredText(value, name, maximumLength = 2_000) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximumLength || text.includes("\0")) throw new Error(`invalid ${name}`);
  return text;
}

function commit(value, name) {
  const normalized = requiredText(value, name, 64).toLowerCase();
  if (!COMMIT.test(normalized)) throw new Error(`invalid ${name}`);
  return normalized;
}

function revision(value, name) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) throw new Error(`invalid ${name}`);
  return normalized;
}

function entry(value, name) {
  if (value == null) return null;
  const mode = requiredText(value.mode, `${name} mode`, 12);
  const object = commit(value.object, `${name} object`);
  return { mode, object };
}

function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function regularFileEntriesWithOneMode(entries) {
  const modes = entries.map((value) => value?.mode);
  return entries.every(Boolean)
    && modes.every((mode) => mode === modes[0])
    && ["100644", "100755"].includes(modes[0]);
}

function pathValue(value) {
  const normalized = requiredText(value, "squash transfer path", 4_000).replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")
      || normalized.includes("/../")) throw new Error("invalid squash transfer path");
  return normalized;
}

function sortedUnique(values, label, mapper) {
  const mapped = (Array.isArray(values) ? values : []).map(mapper)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (mapped.some((value, index) => index > 0 && value.path === mapped[index - 1].path)) {
    throw new Error(`duplicate ${label} path`);
  }
  return mapped;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function identity(value, name) {
  return {
    taskId: requiredText(value?.taskId, `${name} task id`, 200),
    revision: revision(value?.revision, `${name} revision`),
    releaseRevision: revision(value?.releaseRevision, `${name} release revision`),
    resultCommit: commit(value?.resultCommit, `${name} result commit`),
    baseCommit: commit(value?.baseCommit, `${name} base commit`),
    branch: requiredText(value?.branch, `${name} branch`, 500),
  };
}

function canonicalWithoutHash(value) {
  if (Number(value?.version) !== 1 || value?.kind !== "task-squash-transfer-v1") {
    throw new Error("unsupported Task squash transfer proof");
  }
  const survivor = identity(value.survivor, "survivor");
  const source = identity(value.source, "source");
  if (survivor.taskId === source.taskId) throw new Error("Task cannot squash-transfer into itself");
  const baselineResultCommit = commit(value.baselineResultCommit, "squash baseline result commit");
  const previousResultCommit = commit(value.previousResultCommit, "squash previous result commit");
  const projectRoot = requiredText(value.projectRoot, "squash project root", 4_000);
  const devBeforeCommit = commit(value.devBeforeCommit, "squash dev before commit");
  const devAfterTree = commit(value.devAfterTree, "squash dev after tree");
  const sourceWitnesses = sortedUnique(value.sourceWitnesses, "source witness", (item) => {
    const sourceEntry = entry(item?.source, "source witness source");
    const survivorEntry = entry(item?.survivor, "source witness survivor");
    if (sourceEntry && !survivorEntry) throw new Error("squash transfer cannot delete a source result path");
    if (sourceEntry?.object !== EMPTY_BLOB && survivorEntry?.object === EMPTY_BLOB) {
      throw new Error("squash transfer cannot replace a non-empty source path with an empty blob");
    }
    const disposition = sameEntry(sourceEntry, survivorEntry) ? "preserved" : "resolved";
    if (String(item?.disposition ?? disposition) !== disposition) {
      throw new Error("squash source witness disposition does not match exact entries");
    }
    return { path: pathValue(item?.path), source: sourceEntry, survivor: survivorEntry, disposition };
  });
  if (!sourceWitnesses.length) throw new Error("squash transfer requires source path witnesses");
  const ownerWitnesses = sortedUnique(value.ownerWitnesses, "owner witness", (item) => {
    const baseline = entry(item?.baseline, "owner witness baseline");
    const beforeDev = entry(item?.beforeDev, "owner witness before dev");
    const newResult = entry(item?.newResult, "owner witness new result");
    const afterDev = entry(item?.afterDev, "owner witness after dev");
    let disposition;
    if (sameEntry(beforeDev, baseline)) {
      if (!sameEntry(afterDev, newResult)) throw new Error("squash owner delta is missing from dev");
      disposition = "applied";
    } else if (sameEntry(beforeDev, newResult)) {
      if (!sameEntry(afterDev, beforeDev)) throw new Error("squash owner delta already in dev was changed");
      disposition = "already-present";
    } else {
      disposition = "resolved";
      if (sameEntry(afterDev, beforeDev) && !sameEntry(afterDev, newResult)) {
        if (String(item?.disposition ?? "") !== LF_NORMALIZATION_ALREADY_PRESENT
            || !regularFileEntriesWithOneMode([baseline, beforeDev, newResult, afterDev])) {
          throw new Error("squash owner delta was discarded by a resolution");
        }
        disposition = LF_NORMALIZATION_ALREADY_PRESENT;
      }
    }
    if (String(item?.disposition ?? disposition) !== disposition) {
      throw new Error("squash owner witness disposition does not match exact entries");
    }
    return { path: pathValue(item?.path), baseline, beforeDev, newResult, afterDev, disposition };
  });
  if (!ownerWitnesses.length) throw new Error("squash transfer requires a non-empty owner delta");
  const authority = {
    workspaceId: requiredText(value.authority?.workspaceId, "squash authority workspace id", 200),
    streamId: requiredText(value.authority?.streamId, "squash authority stream id", 200),
    provider: requiredText(value.authority?.provider, "squash authority provider", 100),
    threadId: requiredText(value.authority?.threadId, "squash authority thread id", 500),
    proofRequestId: requiredText(value.authority?.proofRequestId, "squash authority proof request id", 500),
  };
  return {
    version: 1,
    kind: "task-squash-transfer-v1",
    survivor,
    source,
    projectRoot,
    previousResultCommit,
    baselineResultCommit,
    devBeforeCommit,
    devAfterTree,
    sourceWitnesses,
    ownerWitnesses,
    authority,
  };
}

export function taskSquashTransferHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(canonicalWithoutHash(value))), "utf8")
    .digest("hex");
}

export function normalizedTaskSquashTransfer(value) {
  const proof = canonicalWithoutHash(value);
  const transferHash = taskSquashTransferHash(proof);
  const supplied = String(value?.transferHash ?? "").trim().toLowerCase();
  if (supplied && supplied !== transferHash) throw new Error("Task squash transfer hash does not match its evidence");
  const integrationCommit = value?.integrationCommit == null
    ? null
    : commit(value.integrationCommit, "squash integration commit");
  return { ...proof, transferHash, ...(integrationCommit ? { integrationCommit } : {}) };
}

export function taskSquashTransferForTask(value, taskId) {
  const proof = normalizedTaskSquashTransfer(value);
  const id = String(taskId ?? "").trim();
  if (proof.survivor.taskId !== id && proof.source.taskId !== id) {
    throw new Error("Task squash transfer does not include the Task");
  }
  return proof;
}
