import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withInterprocessLocks } from "./interprocess-lock.mjs";

export const PUBLICATION_SESSION_ENV = "AGENT_HUB_PUBLICATION_SESSION";
export const PUBLICATION_STAGE_DELEGATION_ENV = "AGENT_HUB_PUBLICATION_STAGE_DELEGATION";
const publicationSessionStorage = new AsyncLocalStorage();

export function publicationLockTarget(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "publication");
}

function ownerFileName(token) {
  return `owner-${createHash("sha256").update(String(token)).digest("hex")}.json`;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function encodeDelegation(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeDelegation(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    throw new Error("publication stage delegation is not valid JSON");
  }
}

async function readOwnerFile(lockPath, token) {
  const ownerPath = path.join(lockPath, ownerFileName(token));
  return JSON.parse(await readFile(ownerPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") throw new Error("publication stage delegation owner is not live");
    throw error;
  }));
}

async function delegationFromOwner({ lockTarget, ownerId, session }) {
  const lockPath = `${lockTarget}.lock`;
  const prefix = `${lockPath}:`;
  if (!String(ownerId ?? "").startsWith(prefix)) return "";
  const token = String(ownerId).slice(prefix.length);
  if (!token) return "";
  const owner = await readOwnerFile(path.resolve(lockPath), token);
  if (String(owner?.token ?? "") !== token || Number(owner?.pid) !== process.pid) return "";
  return encodeDelegation({
    v: 1,
    kind: "publication-stage-delegation",
    lockTarget: path.resolve(lockTarget),
    lockPath: path.resolve(lockPath),
    token,
    session,
    ownerPid: process.pid,
    processInstanceId: String(owner.processInstanceId ?? ""),
  });
}

async function assertDelegatedPublicationStage(environment, lockTarget) {
  const source = String(environment[PUBLICATION_STAGE_DELEGATION_ENV] ?? "").trim();
  if (!source) return false;
  const delegation = decodeDelegation(source);
  const expectedTarget = path.resolve(lockTarget);
  const expectedLockPath = path.resolve(`${lockTarget}.lock`);
  if (delegation?.v !== 1 || delegation.kind !== "publication-stage-delegation") {
    throw new Error("publication stage delegation is not supported");
  }
  if (path.resolve(String(delegation.lockTarget ?? "")) !== expectedTarget
      || path.resolve(String(delegation.lockPath ?? "")) !== expectedLockPath) {
    throw new Error("publication stage delegation targets a different publication lock");
  }
  if (String(environment[PUBLICATION_SESSION_ENV] ?? "") !== String(delegation.session ?? "")) {
    throw new Error("publication stage delegation session does not match the inherited environment");
  }
  if (!String(delegation.token ?? "")) {
    throw new Error("publication stage delegation has no owner token");
  }
  const owner = await readOwnerFile(expectedLockPath, delegation.token);
  if (String(owner?.token ?? "") !== String(delegation.token)
      || Number(owner?.pid) !== Number(delegation.ownerPid)
      || String(owner?.processInstanceId ?? "") !== String(delegation.processInstanceId ?? "")
      || Number.isFinite(Number(owner?.releasedAt))) {
    throw new Error("publication stage delegation does not match the live publication owner");
  }
  if (Number(owner.pid) === process.pid) return false;
  if (!processAlive(Number(owner.pid))) {
    throw new Error("publication stage delegation owner process is not live");
  }
  return true;
}

export function clearInheritedPublicationOwnership(environment = process.env) {
  delete environment[PUBLICATION_SESSION_ENV];
  delete environment[PUBLICATION_STAGE_DELEGATION_ENV];
  return environment;
}

export function publicationLockOwned({
  environment = process.env,
  lockTarget = publicationLockTarget(environment),
} = {}) {
  const activeLease = publicationSessionStorage.getStore();
  return activeLease?.active === true && activeLease.lockTarget === path.resolve(lockTarget);
}

export async function withPublicationLock(operation, {
  environment = process.env,
  lockTarget = publicationLockTarget(environment),
  lock = withInterprocessLocks,
  timeoutMs = 4 * 60 * 60_000,
  sessionFactory = randomUUID,
} = {}) {
  const resolvedLockTarget = path.resolve(lockTarget);
  const activeLease = publicationSessionStorage.getStore();
  if (activeLease?.active === true && activeLease.lockTarget === resolvedLockTarget) return operation();
  if (await assertDelegatedPublicationStage(environment, lockTarget)) {
    const result = await operation();
    await assertDelegatedPublicationStage(environment, lockTarget);
    return result;
  }
  return lock([lockTarget], async ({ ownerId } = {}) => {
    const previous = environment[PUBLICATION_SESSION_ENV];
    const previousDelegation = environment[PUBLICATION_STAGE_DELEGATION_ENV];
    const session = sessionFactory();
    environment[PUBLICATION_SESSION_ENV] = session;
    const delegation = await delegationFromOwner({ lockTarget, ownerId, session });
    if (delegation) environment[PUBLICATION_STAGE_DELEGATION_ENV] = delegation;
    const lease = {
      active: true,
      session,
      lockTarget: resolvedLockTarget,
    };
    try {
      return await publicationSessionStorage.run(lease, operation);
    } finally {
      lease.active = false;
      if (previous === undefined) delete environment[PUBLICATION_SESSION_ENV];
      else environment[PUBLICATION_SESSION_ENV] = previous;
      if (previousDelegation === undefined) delete environment[PUBLICATION_STAGE_DELEGATION_ENV];
      else environment[PUBLICATION_STAGE_DELEGATION_ENV] = previousDelegation;
    }
  }, { timeoutMs, retryDelayMs: 250 });
}
