import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { readInterprocessLockStatus } from "../infrastructure/process/interprocess-lock.mjs";
import {
  assertIsolatedTestContourRoot,
  defaultTestContourRoot,
  readTestContourStatus,
  testContourOperationLockTarget,
  withTestContourOperationLock,
} from "./test-contour-manager.mjs";
import {
  manualTestContourOwnerIdentity,
  readManualTestContourOwnerLifecycle,
} from "./test-contour-owner-lifecycle.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const CONTROL_DIRECTORY = "manual-operation-lock";

function requiredText(value, label, maximum = 240) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (Buffer.byteLength(normalized, "utf8") > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function controlPaths(root, requestId = null, acquisitionId = null) {
  const directory = path.join(root, CONTROL_DIRECTORY);
  const requestHash = requestId
    ? createHash("sha256").update(requestId).digest("hex")
    : null;
  return {
    directory,
    activeFile: path.join(directory, "active.json"),
    requestFile: requestHash ? path.join(directory, `request-${requestHash}.json`) : null,
    releaseFile: acquisitionId ? path.join(directory, `release-${acquisitionId}.json`) : null,
  };
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function removeIfAcquisition(file, acquisitionId) {
  const current = await readJson(file);
  if (current?.acquisitionId !== acquisitionId) return false;
  await rm(file, { force: true });
  return true;
}

function publicReceipt(receipt, { includeReleaseToken = false, reused = false } = {}) {
  if (!receipt) return null;
  return {
    status: receipt.status,
    root: receipt.root,
    owner: receipt.owner,
    requestId: receipt.requestId,
    acquisitionId: receipt.acquisitionId,
    ...(includeReleaseToken ? { releaseToken: receipt.releaseToken } : {}),
    acquiredAt: receipt.acquiredAt,
    releasedAt: receipt.releasedAt ?? null,
    releaseReason: receipt.releaseReason ?? null,
    expected: receipt.expected,
    actual: receipt.actual,
    holderPid: receipt.holderPid,
    ownerLifecycle: receipt.ownerLifecycle ? {
      provider: receipt.ownerLifecycle.provider,
      threadId: receipt.ownerLifecycle.threadId,
      turnId: receipt.ownerLifecycle.turnId,
    } : null,
    reused,
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertReadyIdentity(status, expected) {
  const actual = {
    operationId: String(status?.state?.operationId ?? status?.operation?.operationId ?? "").trim(),
    headCommit: String(status?.state?.source?.headCommit ?? status?.source?.headCommit ?? "").trim(),
    releaseId: String(status?.state?.releaseId ?? "").trim(),
  };
  if (!status?.running || status?.status !== "ready" || status?.planned === true
      || status?.readback?.outcome !== "exact") {
    throw new Error("Manual Test Contour lock requires an exact ready contour");
  }
  for (const key of ["operationId", "headCommit", "releaseId"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Manual Test Contour lock expected ${key} ${expected[key]}, got ${actual[key] || "none"}`);
    }
  }
  return actual;
}

export async function readManualTestContourLockStatus({
  root = defaultTestContourRoot(),
  readLockStatus = readInterprocessLockStatus,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const paths = controlPaths(isolatedRoot);
  const [active, lock] = await Promise.all([
    readJson(paths.activeFile),
    readLockStatus(testContourOperationLockTarget(isolatedRoot)),
  ]);
  const matches = Boolean(active?.lockOwnerIdHash
    && active.lockOwnerIdHash === lock.owner?.ownerIdHash);
  if (active && matches && lock.status === "held") {
    return {
      status: "held",
      root: isolatedRoot,
      owner: active.owner,
      requestId: active.requestId,
      acquisitionId: active.acquisitionId,
      acquiredAt: active.acquiredAt,
      expected: active.expected,
      actual: active.actual,
      holderPid: active.holderPid,
      ownerLifecycle: active.ownerLifecycle ? {
        provider: active.ownerLifecycle.provider,
        threadId: active.ownerLifecycle.threadId,
        turnId: active.ownerLifecycle.turnId,
      } : null,
      lock: { status: lock.status, identityState: lock.owner?.identityState ?? "unknown" },
    };
  }
  if (active) {
    return {
      status: "stale",
      root: isolatedRoot,
      owner: active.owner,
      requestId: active.requestId,
      acquisitionId: active.acquisitionId,
      acquiredAt: active.acquiredAt,
      expected: active.expected,
      actual: active.actual,
      holderPid: active.holderPid,
      ownerLifecycle: active.ownerLifecycle ? {
        provider: active.ownerLifecycle.provider,
        threadId: active.ownerLifecycle.threadId,
        turnId: active.ownerLifecycle.turnId,
      } : null,
      lock: { status: lock.status, identityState: lock.owner?.identityState ?? "none" },
    };
  }
  if (lock.status !== "available") {
    return {
      status: "operation",
      root: isolatedRoot,
      owner: null,
      lock: {
        status: lock.status,
        pid: lock.owner?.pid ?? null,
        identityState: lock.owner?.identityState ?? "unknown",
        createdAt: lock.owner?.createdAt ?? null,
      },
    };
  }
  return { status: "available", root: isolatedRoot, owner: null, lock: { status: "available" } };
}

async function finalizeReceipt(receipt, reason) {
  const paths = controlPaths(receipt.root, receipt.requestId, receipt.acquisitionId);
  const current = await readJson(paths.requestFile);
  if (current?.acquisitionId !== receipt.acquisitionId) return current;
  const completed = {
    ...current,
    status: "released",
    releasedAt: new Date().toISOString(),
    releaseReason: reason,
  };
  await writeJsonAtomic(paths.requestFile, completed);
  await removeIfAcquisition(paths.activeFile, receipt.acquisitionId);
  await rm(paths.releaseFile, { force: true });
  return completed;
}

async function existingRequest(root, requestId) {
  return readJson(controlPaths(root, requestId).requestFile);
}

async function reconcileDeadReceipt(receipt, dependencies = {}) {
  const status = await readManualTestContourLockStatus({ root: receipt.root, ...dependencies });
  if (status.status === "held" || status.status === "operation") {
    throw new Error("Manual Test Contour lock owner is still live or its identity is uncertain");
  }
  await withTestContourOperationLock(receipt.root, async () => {}, {
    timeoutMs: dependencies.acquireTimeoutMs ?? 2_000,
    retryDelayMs: 25,
  });
  return finalizeReceipt(receipt, "owner-dead");
}

async function waitForRelease(receipt, lease, signal, {
  wait = delay,
  pollIntervalMs = 100,
  lifecyclePollIntervalMs = 500,
  readOwnerLifecycle = readManualTestContourOwnerLifecycle,
} = {}) {
  const releaseFile = controlPaths(receipt.root, receipt.requestId, receipt.acquisitionId).releaseFile;
  let nextLifecycleCheckAt = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new Error("Manual Test Contour lock cancelled");
    if (lease.signal.aborted) throw lease.signal.reason ?? new Error("Manual Test Contour lock ownership lost");
    await lease.assertOwned();
    const release = await readJson(releaseFile);
    if (release) {
      if (release.requestId !== receipt.requestId
          || release.acquisitionId !== receipt.acquisitionId
          || release.releaseToken !== receipt.releaseToken) {
        throw new Error("Manual Test Contour unlock request does not match the active acquisition");
      }
      return "requested";
    }
    if (Date.now() >= nextLifecycleCheckAt) {
      nextLifecycleCheckAt = Date.now() + lifecyclePollIntervalMs;
      const lifecycle = await Promise.resolve(readOwnerLifecycle(receipt.ownerLifecycle))
        .catch(() => ({ state: "unknown", reason: "lifecycle-read-failed" }));
      if (lifecycle?.state === "terminal") return `owner-terminal:${lifecycle.status ?? "terminal"}`;
    }
    await wait(pollIntervalMs);
  }
}

export async function holdManualTestContourLock({
  root = defaultTestContourRoot(),
  owner,
  requestId,
  ownerProvider,
  ownerThreadId,
  ownerTurnId,
  ownerRuntimeDataDir,
  expectedOperationId,
  expectedHeadCommit,
  expectedReleaseId,
  signal = null,
  onAcquired = () => {},
  readStatus = readTestContourStatus,
  readLockStatus = readInterprocessLockStatus,
  readOwnerLifecycle = readManualTestContourOwnerLifecycle,
  acquireTimeoutMs = 2_000,
  wait = delay,
  pollIntervalMs = 100,
  now = () => new Date(),
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const normalizedOwner = requiredText(owner, "owner");
  const normalizedRequestId = requiredText(requestId, "request id");
  const expected = {
    operationId: requiredText(expectedOperationId, "expected operation id"),
    headCommit: requiredText(expectedHeadCommit, "expected head commit"),
    releaseId: requiredText(expectedReleaseId, "expected release id"),
  };
  const ownerLifecycle = manualTestContourOwnerIdentity({
    provider: ownerProvider,
    threadId: ownerThreadId,
    turnId: ownerTurnId,
    ...(ownerRuntimeDataDir ? { runtimeDataDir: ownerRuntimeDataDir } : {}),
  });
  let previous = await existingRequest(isolatedRoot, normalizedRequestId);
  if (previous) {
    if (previous.owner !== normalizedOwner) throw new Error("Manual Test Contour request belongs to another owner");
    if (!sameIdentity(previous.expected, expected) || !sameIdentity(previous.ownerLifecycle, ownerLifecycle)) {
      throw new Error("Manual Test Contour request identity changed");
    }
    if (previous.status === "released") return publicReceipt(previous, { includeReleaseToken: true, reused: true });
    const status = await readManualTestContourLockStatus({ root: isolatedRoot, readLockStatus });
    if (status.status === "held" && status.acquisitionId === previous.acquisitionId) {
      const result = publicReceipt(previous, { includeReleaseToken: true, reused: true });
      onAcquired(result);
      return result;
    }
    previous = await reconcileDeadReceipt(previous, { readLockStatus, acquireTimeoutMs });
    return publicReceipt(previous, { includeReleaseToken: true, reused: true });
  }

  const current = await readManualTestContourLockStatus({ root: isolatedRoot, readLockStatus });
  if (current.status === "held") {
    throw new Error(`Test Contour is manually locked by ${current.owner} (${current.acquisitionId})`);
  }
  const initialLifecycle = await readOwnerLifecycle(ownerLifecycle);
  if (initialLifecycle?.state !== "active") {
    throw new Error(`Manual Test Contour lock requires an active owner turn; lifecycle is ${initialLifecycle?.state ?? "unknown"}`);
  }

  let receipt = null;
  try {
    await withTestContourOperationLock(isolatedRoot, async (lease) => {
      const acquiredLifecycle = await readOwnerLifecycle(ownerLifecycle);
      if (acquiredLifecycle?.state !== "active") {
        throw new Error(`Manual Test Contour owner turn ended before acquisition; lifecycle is ${acquiredLifecycle?.state ?? "unknown"}`);
      }
      const status = await readStatus({
        root: isolatedRoot,
        expectedOperationId: expected.operationId,
        expectedHeadCommit: expected.headCommit,
      });
      const actual = assertReadyIdentity(status, expected);
      const lockOwnerIdHash = createHash("sha256").update(lease.ownerId).digest("hex");
      receipt = {
        schemaVersion: 1,
        status: "held",
        root: isolatedRoot,
        owner: normalizedOwner,
        requestId: normalizedRequestId,
        acquisitionId: randomUUID(),
        releaseToken: randomUUID(),
        acquiredAt: now().toISOString(),
        releasedAt: null,
        releaseReason: null,
        expected,
        actual,
        holderPid: process.pid,
        lockOwnerIdHash,
        ownerLifecycle,
      };
      const paths = controlPaths(isolatedRoot, normalizedRequestId, receipt.acquisitionId);
      const raced = await readJson(paths.requestFile);
      if (raced) throw new Error("Manual Test Contour request was already recorded by another process");
      await writeJsonAtomic(paths.requestFile, receipt);
      await writeJsonAtomic(paths.activeFile, receipt);
      onAcquired(publicReceipt(receipt, { includeReleaseToken: true }));
      receipt.releaseReason = await waitForRelease(receipt, lease, signal, {
        wait,
        pollIntervalMs,
        readOwnerLifecycle,
      });
    }, { timeoutMs: acquireTimeoutMs, retryDelayMs: 25 });
    receipt = await finalizeReceipt(receipt, receipt.releaseReason ?? "requested");
    return publicReceipt(receipt, { includeReleaseToken: true });
  } catch (error) {
    if (receipt) await finalizeReceipt(receipt, signal?.aborted ? "cancelled" : "error").catch(() => {});
    if (/Timed out waiting for interprocess lock/u.test(error.message)) {
      previous = await existingRequest(isolatedRoot, normalizedRequestId);
      if (previous?.owner === normalizedOwner && sameIdentity(previous.expected, expected)
          && sameIdentity(previous.ownerLifecycle, ownerLifecycle)) {
        if (previous.status === "released") {
          return publicReceipt(previous, { includeReleaseToken: true, reused: true });
        }
        const status = await readManualTestContourLockStatus({ root: isolatedRoot, readLockStatus });
        if (status.status === "held" && status.acquisitionId === previous.acquisitionId) {
          const result = publicReceipt(previous, { includeReleaseToken: true, reused: true });
          onAcquired(result);
          return result;
        }
        previous = await reconcileDeadReceipt(previous, { readLockStatus, acquireTimeoutMs });
        return publicReceipt(previous, { includeReleaseToken: true, reused: true });
      }
    }
    throw error;
  }
}

export async function releaseManualTestContourLock({
  root = defaultTestContourRoot(),
  requestId,
  acquisitionId,
  releaseToken,
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  wait = delay,
  readLockStatus = readInterprocessLockStatus,
} = {}) {
  const isolatedRoot = assertIsolatedTestContourRoot(root);
  const normalizedRequestId = requiredText(requestId, "request id");
  const normalizedAcquisitionId = requiredText(acquisitionId, "acquisition id");
  const normalizedReleaseToken = requiredText(releaseToken, "release token");
  let receipt = await existingRequest(isolatedRoot, normalizedRequestId);
  if (!receipt || receipt.acquisitionId !== normalizedAcquisitionId
      || receipt.releaseToken !== normalizedReleaseToken) {
    throw new Error("Manual Test Contour unlock identity does not match an acquisition");
  }
  if (receipt.status === "released") return publicReceipt(receipt, { reused: true });
  const status = await readManualTestContourLockStatus({ root: isolatedRoot, readLockStatus });
  if (status.status !== "held") {
    receipt = await reconcileDeadReceipt(receipt, { readLockStatus, acquireTimeoutMs: timeoutMs });
    return publicReceipt(receipt, { reused: true });
  }
  if (status.acquisitionId !== normalizedAcquisitionId) {
    throw new Error("Manual Test Contour unlock is stale; another acquisition is active");
  }
  const releaseFile = controlPaths(isolatedRoot, normalizedRequestId, normalizedAcquisitionId).releaseFile;
  await writeJsonAtomic(releaseFile, {
    requestId: normalizedRequestId,
    acquisitionId: normalizedAcquisitionId,
    releaseToken: normalizedReleaseToken,
    requestedAt: new Date().toISOString(),
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    receipt = await existingRequest(isolatedRoot, normalizedRequestId);
    if (receipt?.status === "released") return publicReceipt(receipt);
    await wait(pollIntervalMs);
  }
  throw new Error("Manual Test Contour unlock outcome is unknown; retry the same exact unlock identity");
}
