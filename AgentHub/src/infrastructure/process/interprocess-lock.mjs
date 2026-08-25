import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const RELEASE_RETRY_DELAYS_MS = [0, 10, 25, 50, 100, 200];
const TRANSIENT_LOCK_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const inProcessLocks = new Map();

async function acquireInProcessLock(lockPath) {
  let state = inProcessLocks.get(lockPath);
  if (!state) {
    state = { pending: 0, tail: Promise.resolve() };
    inProcessLocks.set(lockPath, state);
  }
  const previous = state.tail.catch(() => {});
  let releaseTurn;
  const turn = new Promise((resolve) => { releaseTurn = resolve; });
  state.tail = previous.then(() => turn);
  state.pending += 1;
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.pending -= 1;
    releaseTurn();
    if (state.pending === 0 && inProcessLocks.get(lockPath) === state) {
      inProcessLocks.delete(lockPath);
    }
  };
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readOwner(lockPath) {
  try {
    const value = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    return {
      token: String(value?.token ?? ""),
      pid: Number(value?.pid),
      createdAt: Number(value?.createdAt),
    };
  } catch {
    return null;
  }
}

async function retryTransientLockOperation(operation, {
  retryDelaysMs = RELEASE_RETRY_DELAYS_MS,
  wait = delay,
} = {}) {
  let lastError = null;
  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) await wait(retryDelayMs);
    try {
      await operation();
      return { completed: true, missing: false };
    } catch (error) {
      if (error?.code === "ENOENT") return { completed: true, missing: true };
      if (!TRANSIENT_LOCK_ERROR_CODES.has(error?.code)) throw error;
      lastError = error;
    }
  }
  return { completed: false, missing: false, error: lastError };
}

export async function releaseInterprocessLock(lockPath, token, {
  renamePath = rename,
  removePath = rm,
  writeOwner = writeFile,
  retryDelaysMs = RELEASE_RETRY_DELAYS_MS,
  wait = delay,
} = {}) {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return false;

  const safeToken = String(token || "unknown").replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  const retiredPath = `${lockPath}.released-${Date.now()}-${safeToken}`;
  const retirement = await retryTransientLockOperation(
    () => renamePath(lockPath, retiredPath),
    { retryDelaysMs, wait },
  );
  if (retirement.completed) {
    if (!retirement.missing) {
      await removePath(retiredPath, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }

  const currentOwner = await readOwner(lockPath);
  if (currentOwner?.token !== token) return false;
  const recoverableOwner = `${JSON.stringify({
    token,
    pid: 0,
    createdAt: 0,
    releasedAt: Date.now(),
  })}\n`;
  const fallback = await retryTransientLockOperation(
    () => writeOwner(path.join(lockPath, "owner.json"), recoverableOwner, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    }),
    { retryDelaysMs, wait },
  );
  if (!fallback.completed) throw fallback.error;
  return true;
}

async function quarantineStaleLock(lockPath, token) {
  const safeToken = String(token || "unknown").replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  const quarantined = `${lockPath}.stale-${Date.now()}-${safeToken}`;
  try {
    await rename(lockPath, quarantined);
  } catch (error) {
    if (["ENOENT", "EEXIST", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) return false;
    throw error;
  }
  await rm(quarantined, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function acquire(lockPath, {
  timeoutMs = 30_000,
  retryDelayMs = 25,
  staleMs = 60_000,
  ownerlessStaleMs = Math.min(staleMs, 2_000),
  isProcessAlive = defaultProcessAlive,
  tokenFactory = randomUUID,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const token = tokenFactory();
  for (;;) {
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
        token,
        pid: process.pid,
        createdAt: Date.now(),
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return token;
    } catch (error) {
      const contention = ["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]
        .includes(error?.code);
      if (!contention) throw error;
      if (error?.code !== "EEXIST") {
        if (Date.now() >= deadline) throw error;
        await delay(retryDelayMs);
        continue;
      }
      const owner = await readOwner(lockPath);
      const info = owner ? null : await stat(lockPath).catch(() => null);
      const ageMs = owner
        ? Date.now() - Number(owner.createdAt ?? 0)
        : Date.now() - Number(info?.mtimeMs ?? Date.now());
      const hasOwnerPid = Number.isSafeInteger(owner?.pid) && owner.pid > 0;
      // mkdir followed by owner.json is necessarily a two-step protocol.  A
      // directory without an owner is therefore protected by its mtime grace
      // period; it must not be stolen while its creator is writing owner.json.
      // The grace is intentionally shorter than the dead-owner threshold:
      // recursive removal on Windows can remove owner.json and then leave the
      // empty directory behind after a transient filesystem error.
      const canRecover = hasOwnerPid
        ? !isProcessAlive(owner.pid)
        : ageMs >= ownerlessStaleMs;
      if (canRecover) {
        await quarantineStaleLock(lockPath, owner?.token);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for interprocess lock: ${lockPath}`);
      }
      await delay(retryDelayMs);
    }
  }
}

export async function withInterprocessLocks(paths, operation, options = {}) {
  const waitStartedAt = performance.now();
  const lockPaths = [...new Set(paths.filter(Boolean).map((value) => `${value}.lock`))].sort();
  const localReleases = [];
  const acquired = [];
  try {
    for (const lockPath of lockPaths) {
      localReleases.push(await acquireInProcessLock(lockPath));
    }
    for (const lockPath of lockPaths) {
      acquired.push({ lockPath, token: await acquire(lockPath, options) });
    }
    try {
      options.onAcquired?.({
        waitMs: Math.max(0, performance.now() - waitStartedAt),
        lockCount: lockPaths.length,
      });
    } catch {
      // Lock diagnostics are advisory and cannot change the protected operation.
    }
    return await operation();
  } finally {
    try {
      await Promise.all(acquired.reverse().map(
        ({ lockPath, token }) => releaseInterprocessLock(lockPath, token),
      ));
    } finally {
      localReleases.reverse().forEach((releaseLocal) => releaseLocal());
    }
  }
}
