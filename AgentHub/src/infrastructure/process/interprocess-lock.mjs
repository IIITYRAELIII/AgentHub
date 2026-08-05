import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

async function release(lockPath, token) {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return;
  await rm(lockPath, { recursive: true, force: true }).catch(() => {});
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
  const lockPaths = [...new Set(paths.filter(Boolean).map((value) => `${value}.lock`))].sort();
  const acquired = [];
  try {
    for (const lockPath of lockPaths) {
      acquired.push({ lockPath, token: await acquire(lockPath, options) });
    }
    return await operation();
  } finally {
    await Promise.all(acquired.reverse().map(({ lockPath, token }) => release(lockPath, token)));
  }
}
