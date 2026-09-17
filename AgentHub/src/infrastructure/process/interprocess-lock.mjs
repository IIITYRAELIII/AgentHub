import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const RELEASE_RETRY_DELAYS_MS = [0, 10, 25, 50, 100, 200];
const TRANSIENT_LOCK_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const inProcessLocks = new Map();
const PROCESS_INSTANCE_ID = randomUUID();

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

function ownerFileName(token) {
  const digest = createHash("sha256").update(String(token)).digest("hex");
  return `owner-${digest}.json`;
}

function ownerPayload(value, extra = {}) {
  return `${JSON.stringify({
    token: value.token,
    pid: value.pid,
    processInstanceId: value.processInstanceId,
    createdAt: value.createdAt,
    leaseExpiresAt: value.leaseExpiresAt,
    ...extra,
  })}\n`;
}

async function readOwner(lockPath) {
  try {
    const entries = await readdir(lockPath);
    const candidates = entries.filter((entry) => entry === "owner.json" || /^owner-[a-f0-9]{64}\.json$/u.test(entry));
    if (candidates.length === 0) {
      return entries.length === 0 ? null : { unresolved: true };
    }
    if (candidates.length !== 1) return { unresolved: true };
    const fileName = candidates[0];
    const value = JSON.parse(await readFile(path.join(lockPath, fileName), "utf8"));
    const token = String(value?.token ?? "");
    const format = fileName === "owner.json" ? "legacy" : "token";
    if (!token || (format === "token" && ownerFileName(token) !== fileName)) {
      return { unresolved: true };
    }
    return {
      token,
      pid: Number(value?.pid),
      createdAt: Number(value?.createdAt),
      processInstanceId: String(value?.processInstanceId ?? ""),
      leaseExpiresAt: Number(value?.leaseExpiresAt),
      releasedAt: value?.releasedAt == null ? Number.NaN : Number(value.releasedAt),
      fileName,
      ownerPath: path.join(lockPath, fileName),
      format,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return { unresolved: true };
    if (["EPERM", "EACCES", "EBUSY"].includes(error?.code)) return { unresolved: true };
    throw error;
  }
}

function sameOwnerIdentity(expected, actual) {
  return Boolean(
    expected
    && actual
    && !actual.unresolved
    && actual.token === expected.token
    && actual.pid === expected.pid
    && actual.processInstanceId === expected.processInstanceId
    && actual.fileName === expected.fileName,
  );
}

function sameOwner(expected, actual) {
  return sameOwnerIdentity(expected, actual) && !Number.isFinite(actual.releasedAt);
}

async function renewLease(lockPath, token, _staleMs, ownership = null) {
  const expected = ownership?.owner ?? { token };
  const owner = await readOwner(lockPath);
  if (ownership?.owner) return sameOwner(expected, owner);
  return owner?.token === token && !owner?.unresolved && !Number.isFinite(owner?.releasedAt);
}

async function markReleased(ownership) {
  if (!ownership?.handle) return;
  const releasedAt = Date.now();
  const bytes = Buffer.from(ownerPayload(ownership.owner, { releasedAt }), "utf8");
  await ownership.handle.write(bytes, 0, bytes.length, 0);
  await ownership.handle.truncate(bytes.length);
  await ownership.handle.sync();
  ownership.owner.releasedAt = releasedAt;
}

async function closeOwnership(ownership) {
  if (!ownership?.handle) return;
  const handle = ownership.handle;
  ownership.handle = null;
  await handle.close();
}

async function removeOwnedEntry(lockPath, owner, {
  removeOwnerPath = (value) => rm(value, { force: false }),
  removeLockDirectory = rmdir,
  retryDelaysMs = RELEASE_RETRY_DELAYS_MS,
  wait = delay,
  throwOnFailure = false,
} = {}) {
  if (owner?.format !== "token" || !owner.ownerPath) return false;
  const removal = await retryTransientLockOperation(
    () => removeOwnerPath(owner.ownerPath),
    { retryDelaysMs, wait },
  );
  if (!removal.completed) {
    if (throwOnFailure) throw removal.error;
    return false;
  }
  if (removal.missing) return false;
  await retryTransientLockOperation(
    () => removeLockDirectory(lockPath),
    { retryDelaysMs, wait },
  );
  return true;
}

async function processIdentityState(owner, {
  isProcessAlive = defaultProcessAlive,
  processInstanceId = PROCESS_INSTANCE_ID,
  processIdentityState: inspectIdentity = null,
} = {}) {
  if (Number.isFinite(owner?.releasedAt)) return "released";
  if (typeof inspectIdentity === "function") {
    const inspected = await inspectIdentity(owner);
    if (["alive", "dead", "mismatch", "unknown"].includes(inspected)) return inspected;
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return "unknown";
  if (!isProcessAlive(owner.pid)) return "dead";
  if (owner.pid === process.pid
      && owner.processInstanceId
      && owner.processInstanceId !== processInstanceId) {
    return "mismatch";
  }
  // A live PID whose exact start identity cannot be inspected is deliberately
  // treated as live/unknown. Age or a missed heartbeat can never steal it.
  return "alive";
}

export async function readInterprocessLockStatus(target, options = {}) {
  const lockPath = `${target}.lock`;
  const owner = await readOwner(lockPath);
  if (!owner) return { target, lockPath, status: "available", owner: null };
  if (owner.unresolved) return { target, lockPath, status: "unknown", owner: null };
  const identityState = await processIdentityState(owner, options);
  return {
    target,
    lockPath,
    status: ["dead", "mismatch", "released"].includes(identityState) ? "recoverable" : "held",
    owner: {
      pid: owner.pid,
      processInstanceId: owner.processInstanceId,
      createdAt: owner.createdAt,
      identityState,
      ownerIdHash: createHash("sha256").update(`${lockPath}:${owner.token}`).digest("hex"),
    },
  };
}

async function createOwnership(lockPath, token, staleMs, processInstanceId) {
  const fileName = ownerFileName(token);
  const ownerPath = path.join(lockPath, fileName);
  const owner = {
    token,
    pid: process.pid,
    processInstanceId,
    createdAt: Date.now(),
    leaseExpiresAt: Date.now() + staleMs,
    fileName,
    ownerPath,
    format: "token",
  };
  const handle = await open(ownerPath, "wx", 0o600);
  try {
    await handle.writeFile(ownerPayload(owner), "utf8");
    await handle.sync();
    return { lockPath, token, owner, handle };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(ownerPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function retireStaleLock(lockPath, owner, options = {}) {
  if (!owner) {
    try {
      await rmdir(lockPath);
      return true;
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) return false;
      throw error;
    }
  }
  if (owner.unresolved) {
    return null;
  }
  if (owner.format === "legacy") {
    if (!["dead", "mismatch", "released"].includes(options.identityState)) return null;
    const current = await readOwner(lockPath);
    if (!sameOwnerIdentity(owner, current)) return false;
    const quarantinePath = `${lockPath}.legacy-retired-${randomUUID()}`;
    const moveLegacyLock = options.moveLegacyLock ?? rename;
    const removeLegacyLock = options.removeLegacyLock
      ?? ((value) => rm(value, { recursive: true, force: false }));
    const moved = await retryTransientLockOperation(
      () => moveLegacyLock(lockPath, quarantinePath),
      { retryDelaysMs: options.retryDelaysMs, wait: options.wait },
    );
    if (!moved.completed || moved.missing) return false;
    const quarantinedOwner = await readOwner(quarantinePath);
    const quarantinedIdentity = quarantinedOwner && !quarantinedOwner.unresolved
      ? await processIdentityState(quarantinedOwner, options)
      : "unknown";
    if (!sameOwnerIdentity(owner, quarantinedOwner)
        || !["dead", "mismatch", "released"].includes(quarantinedIdentity)) {
      const restored = await retryTransientLockOperation(
        () => rename(quarantinePath, lockPath),
        { retryDelaysMs: options.retryDelaysMs, wait: options.wait },
      );
      if (!restored.completed) {
        throw new Error(`Legacy interprocess lock changed during quarantine; operator recovery required: ${lockPath}`);
      }
      return false;
    }
    const removed = await retryTransientLockOperation(
      () => removeLegacyLock(quarantinePath),
      { retryDelaysMs: options.retryDelaysMs, wait: options.wait },
    );
    if (!removed.completed) {
      throw new Error(`Cannot remove quarantined legacy interprocess lock: ${quarantinePath}`);
    }
    return true;
  }
  if (owner.format !== "token") return null;
  return removeOwnedEntry(lockPath, owner, options);
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
  ownership = null,
  beforeOwnerRemove = null,
  removeOwnerPath,
  removeLockDirectory,
  retryDelaysMs = RELEASE_RETRY_DELAYS_MS,
  wait = delay,
} = {}) {
  const held = ownership?.token === token ? ownership : null;
  const owner = await readOwner(lockPath);
  const expected = held?.owner ?? owner;
  if (!expected || expected.unresolved || expected.token !== token || !sameOwner(expected, owner)) {
    await closeOwnership(held).catch(() => {});
    return false;
  }
  try {
    await markReleased(held);
  } finally {
    await closeOwnership(held);
  }
  await beforeOwnerRemove?.({ lockPath, owner: expected });
  return removeOwnedEntry(lockPath, expected, {
    removeOwnerPath,
    removeLockDirectory,
    retryDelaysMs,
    wait,
    throwOnFailure: true,
  });
}

async function acquire(lockPath, {
  timeoutMs = 30_000,
  retryDelayMs = 25,
  staleMs = 60_000,
  ownerlessStaleMs = Math.min(staleMs, 2_000),
  isProcessAlive = defaultProcessAlive,
  tokenFactory = randomUUID,
  processInstanceId = PROCESS_INSTANCE_ID,
  processIdentityState: inspectProcessIdentity = null,
  quarantine = retireStaleLock,
  moveLegacyLock = rename,
  removeLegacyLock = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const token = tokenFactory();
  for (;;) {
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await mkdir(lockPath);
      return await createOwnership(lockPath, token, staleMs, processInstanceId);
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
      // mkdir followed by the immutable token-addressed owner file is a
      // two-step protocol. A
      // directory without an owner is therefore protected by its mtime grace
      // period; it must not be stolen while its creator is writing that file.
      // Recovery never relies on age once a durable owner identity exists.
      const identityState = owner && !owner.unresolved
        ? await processIdentityState(owner, {
            isProcessAlive,
            processInstanceId,
            processIdentityState: inspectProcessIdentity,
          })
        : "unknown";
      const canRecover = owner
        ? ["dead", "mismatch", "released"].includes(identityState)
        : ageMs >= ownerlessStaleMs;
      if (canRecover) {
        const quarantined = await quarantine(lockPath, owner, {
          retryDelaysMs: [0],
          wait: delay,
          identityState,
          isProcessAlive,
          processInstanceId,
          processIdentityState: inspectProcessIdentity,
          moveLegacyLock,
          removeLegacyLock,
        });
        if (!quarantined) {
          if (Date.now() >= deadline) {
            throw new Error(`Cannot quarantine stale interprocess lock before deadline: ${lockPath}`);
          }
          await delay(retryDelayMs);
        }
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
  let heartbeat = null;
  const renewals = new Set();
  const leaseController = new AbortController();
  let leaseError = null;
  const loseLease = (error) => {
    if (leaseError) return;
    leaseError = error instanceof Error ? error : new Error(String(error));
    leaseController.abort(leaseError);
  };
  const assertOwned = async () => {
    if (leaseError) throw leaseError;
    const ownership = await Promise.all(acquired.map((record) => (
      renewLease(record.lockPath, record.token, 0, record)
    )));
    const lostIndex = ownership.findIndex((owned) => !owned);
    if (lostIndex >= 0) {
      loseLease(new Error(`interprocess lock durable ownership was lost: ${acquired[lostIndex].lockPath}`));
    }
    if (leaseError) throw leaseError;
  };
  try {
    for (const lockPath of lockPaths) {
      localReleases.push(await acquireInProcessLock(lockPath));
    }
    for (const lockPath of lockPaths) {
      acquired.push(await acquire(lockPath, options));
    }
    const staleMs = Math.max(500, Number(options.staleMs) || 60_000);
    const renew = typeof options.renewLease === "function" ? options.renewLease : renewLease;
    heartbeat = setInterval(() => {
      for (const record of acquired) {
        const renewal = Promise.resolve(renew(
          record.lockPath,
          record.token,
          staleMs,
          record,
        )).then((renewed) => {
          renewals.delete(renewal);
          if (!renewed) loseLease(new Error(`interprocess lock lease ownership was lost: ${record.lockPath}`));
        }, (error) => {
          renewals.delete(renewal);
          loseLease(new Error(
            `interprocess lock lease renewal failed for ${record.lockPath}: ${error.message}`,
          ));
        });
        renewals.add(renewal);
      }
    }, Math.max(100, Math.min(10_000, Math.floor(staleMs / 3))));
    heartbeat.unref?.();
    try {
      options.onAcquired?.({
        waitMs: Math.max(0, performance.now() - waitStartedAt),
        lockCount: lockPaths.length,
      });
    } catch {
      // Lock diagnostics are advisory and cannot change the protected operation.
    }
    const result = await operation({
      signal: leaseController.signal,
      assertOwned,
      ownerId: acquired.map(({ lockPath, token }) => `${lockPath}:${token}`).join("|"),
    });
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    await Promise.allSettled([...renewals]);
    await assertOwned();
    const releaseErrors = [];
    const releasing = acquired.splice(0).reverse();
    await Promise.all(releasing.map(async (record) => {
      try {
        const released = await releaseInterprocessLock(record.lockPath, record.token, {
          ...options,
          ownership: record,
        });
        if (!released) throw new Error(`interprocess lock ownership changed before release: ${record.lockPath}`);
      } catch (error) {
        releaseErrors.push({ lockPath: record.lockPath, error });
      }
    }));
    if (releaseErrors.length) {
      try { options.onReleaseError?.(releaseErrors); } catch {}
    }
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await Promise.allSettled([...renewals]);
    try {
      const releasing = acquired.splice(0).reverse();
      await Promise.all(releasing.map(async (record) => {
        try {
          const released = await releaseInterprocessLock(record.lockPath, record.token, {
            ...options,
            ownership: record,
          });
          if (!released) throw new Error(`interprocess lock ownership changed before release: ${record.lockPath}`);
        } catch (error) {
          try { options.onReleaseError?.([{ lockPath: record.lockPath, error }]); } catch {}
        }
      }));
    } finally {
      localReleases.reverse().forEach((releaseLocal) => releaseLocal());
    }
  }
}
