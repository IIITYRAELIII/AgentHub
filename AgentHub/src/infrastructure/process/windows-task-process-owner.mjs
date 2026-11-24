import { access, readFile, rename, unlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { prepareWindowsLockDirectoryPublisher } from "./windows-lock-directory-publication.mjs";

let ownerIdentity;

async function absoluteExecutable(executable, env) {
  if (path.isAbsolute(executable)) return executable;
  if (path.basename(executable) !== executable) throw new Error("Owned Windows executable must be absolute or on PATH");
  const environment = { ...process.env, ...env };
  const name = Object.keys(environment).findLast(key => key.toLowerCase() === "path");
  const file = path.extname(executable) ? executable : executable + ".exe";
  for (const entry of String(environment[name] ?? "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, "");
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, file);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error("Owned Windows executable was not found on PATH");
}

export async function prepareOwnedWindowsTaskProcess({ guardId, recordBase }, executable, args, { timeoutMs, env }) {
  const publisher = await prepareWindowsLockDirectoryPublisher();
  const owner = await (ownerIdentity ??= publisher.inspectProcess(process.pid).then(identity => {
    if (!identity?.alive) throw new Error("Windows task process owner identity is unavailable");
    return identity;
  }).catch(error => { ownerIdentity = null; throw error; }));
  const target = await absoluteExecutable(executable, env);
  const binary = await publisher.ownedTaskProcessExecutable();
  return {
    executable: binary,
    args: ["--run-owned-task-job", guardId, recordBase, String(owner.processId),
      owner.birthFileTime, String(timeoutMs ?? 0), target, ...args],
  };
}

export function requestOwnedWindowsTaskProcessStop({ recordBase }) {
  try { writeFileSync(recordBase + ".stop", "", { flag: "wx" }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
}

function readJobRecord(recordBase, suffix) {
  return readFile(recordBase + suffix, "utf8").then(JSON.parse).catch(error => {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  });
}

export function ownsWindowsTaskLaunchPermit(guardId, permit) {
  return Boolean(permit && permit.version === 1 && permit.guardId === guardId && Object.keys(permit).length === 2);
}

export async function fenceOwnedWindowsTaskLaunch({ guardId, recordBase }) {
  const existing = await readJobRecord(recordBase, ".fenced");
  if (existing) return ownsWindowsTaskLaunchPermit(guardId, existing) ? existing : null;
  const permit = await readJobRecord(recordBase, ".permit");
  if (!ownsWindowsTaskLaunchPermit(guardId, permit)) return null;
  try {
    // The native resume path consumes the exact same source name. At most one
    // rename wins. Never recreate a missing permit from the guard or receipts.
    await rename(recordBase + ".permit", recordBase + ".fenced");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const fenced = await readJobRecord(recordBase, ".fenced");
  return ownsWindowsTaskLaunchPermit(guardId, fenced) ? fenced : null;
}

export async function readOwnedWindowsTaskProcessProof({ guardId, recordBase }) {
  const [admitted, finished] = await Promise.all([".admitted", ".finished"].map(suffix => readJobRecord(recordBase, suffix)));
  if (!admitted || Object.keys(admitted).length !== 6
    || !ownsWindowsTaskProcessProof(guardId, finished)
    || ["version", "guardId", "parentPid", "parentBirth", "rootPid", "rootBirth"]
      .some(key => finished[key] !== admitted[key])) return null;
  return finished;
}

export function ownsWindowsTaskProcessProof(guardId, proof) {
  const pid = value => Number.isSafeInteger(value) && value > 0;
  const birth = value => typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
  return Boolean(proof && proof.version === 1 && proof.guardId === guardId
    && pid(proof.parentPid) && pid(proof.rootPid)
    && birth(proof.parentBirth) && birth(proof.rootBirth)
    && proof.activeProcesses === 0 && Number.isSafeInteger(proof.exitCode)
    && proof.exitCode >= 0 && proof.exitCode <= 0xffffffff
    && ["completed", "cancelled", "owner-ended", "timed-out"].includes(proof.reason)
    && Object.keys(proof).length === 9);
}

export async function discardOwnedWindowsTaskProcessProof({ recordBase }) {
  await Promise.allSettled([".permit", ".started", ".fenced", ".admitted", ".finished", ".stop"].map(suffix => unlink(recordBase + suffix)));
}
