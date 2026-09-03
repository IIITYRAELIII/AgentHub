import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";

const VERSION = 1;
const HISTORY_LIMIT = 32;
const TERMINAL_STATUSES = new Set(["ready", "failed", "superseded"]);
const PHASE_ORDER = new Map([
  ["preparing", 0],
  ["prepared", 1],
  ["stopping", 2],
  ["starting", 3],
  ["publishing", 4],
  ["ready", 5],
  ["failed", 5],
  ["superseded", 6],
]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalizedSource(source = {}) {
  return {
    kind: String(source.kind ?? "dev").trim() || "dev",
    branch: String(source.branch ?? "").trim(),
    headCommit: String(source.headCommit ?? "").trim(),
    sourceRoot: path.resolve(String(source.sourceRoot ?? "").trim()),
  };
}

function normalizedTarget(target = {}) {
  const port = Number(target.port);
  const model = String(target.model ?? "").trim();
  if (!String(target.root ?? "").trim()
      || !String(target.contourId ?? "").trim()
      || !model
      || !Number.isInteger(port)
      || port <= 0) {
    throw new Error("Test Contour operation requires exact root, contourId, port and model");
  }
  return {
    root: path.resolve(String(target.root).trim()),
    contourId: String(target.contourId).trim(),
    port,
    model,
  };
}

function emptyDocument() {
  return { version: VERSION, revision: 0, current: null, history: [] };
}

function normalizeDocument(value) {
  if (!value || value.version !== VERSION) return emptyDocument();
  return {
    version: VERSION,
    revision: Math.max(0, Number(value.revision) || 0),
    current: value.current && typeof value.current === "object" ? value.current : null,
    history: Array.isArray(value.history) ? value.history.slice(0, HISTORY_LIMIT) : [],
  };
}

function publicOperation(operation) {
  if (!operation) return null;
  const { ownerToken: _ownerToken, ...visible } = operation;
  return visible;
}

function operationWithRevision(operation, revision, at) {
  return { ...operation, revision, updatedAt: at };
}

function retireCurrent(document, operation, { status, phase, reason, supersededBy = null, at }) {
  const retired = operationWithRevision({
    ...operation,
    status,
    phase,
    ...(reason ? { reason } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    completedAt: operation.completedAt ?? at,
  }, document.revision + 1, at);
  return {
    ...document,
    revision: retired.revision,
    current: null,
    history: [retired, ...document.history.filter((item) => item.operationId !== retired.operationId)]
      .slice(0, HISTORY_LIMIT),
  };
}

export function testContourOperationStateFile(root) {
  return path.join(path.resolve(root), "test-contour-operation.json");
}

export async function readTestContourOperationDocument(root) {
  try {
    return normalizeDocument(JSON.parse(await readFile(testContourOperationStateFile(root), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return emptyDocument();
    throw error;
  }
}

async function writeDocument(root, document) {
  await writeTextAtomic(
    testContourOperationStateFile(root),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  return document;
}

export async function beginTestContourOperation(root, {
  kind = "refresh",
  source,
  target,
  operationId = randomUUID(),
  ownerPid = process.pid,
  ownerToken = randomUUID(),
  now = new Date(),
  isProcessAlive = processIsAlive,
} = {}) {
  const at = nowIso(now);
  let document = await readTestContourOperationDocument(root);
  const prior = document.current;
  if (prior?.status === "running") {
    if (isProcessAlive(Number(prior.ownerPid))) {
      throw new Error(`Test Contour operation ${prior.operationId} is still owned by PID ${prior.ownerPid}`);
    }
    document = retireCurrent(document, prior, {
      status: "failed",
      phase: "failed",
      reason: "owner-crash",
      at,
    });
  } else if (prior) {
    document = retireCurrent(document, prior, {
      status: "superseded",
      phase: "superseded",
      reason: "newer-operation",
      supersededBy: operationId,
      at,
    });
  }
  const revision = document.revision + 1;
  const operation = {
    operationId: String(operationId),
    kind: String(kind),
    status: "running",
    phase: "preparing",
    revision,
    source: normalizedSource(source),
    target: normalizedTarget(target),
    releaseId: null,
    previousReleaseId: null,
    ownerPid: Number(ownerPid),
    ownerToken: String(ownerToken),
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  };
  document = { ...document, revision, current: operation };
  await writeDocument(root, document);
  return operation;
}

export async function assertTestContourOperationOwner(root, { operationId, ownerToken }) {
  const document = await readTestContourOperationDocument(root);
  const current = document.current;
  if (current?.operationId !== operationId
      || current?.ownerToken !== ownerToken
      || current?.status !== "running") {
    throw new Error(`Test Contour operation ${operationId} was superseded`);
  }
  return current;
}

export async function transitionTestContourOperation(root, {
  operationId,
  ownerToken,
  phase,
  status = "running",
  patch = {},
  now = new Date(),
} = {}) {
  const current = await assertTestContourOperationOwner(root, { operationId, ownerToken });
  const nextPhase = String(phase ?? current.phase);
  if (!PHASE_ORDER.has(nextPhase)) throw new Error(`Invalid Test Contour operation phase: ${nextPhase}`);
  if ((PHASE_ORDER.get(nextPhase) ?? 0) < (PHASE_ORDER.get(current.phase) ?? 0)) {
    throw new Error(`Test Contour operation phase cannot move backwards: ${current.phase} -> ${nextPhase}`);
  }
  if (status !== "running" && !TERMINAL_STATUSES.has(status)) {
    throw new Error(`Invalid Test Contour operation status: ${status}`);
  }
  const document = await readTestContourOperationDocument(root);
  const revision = document.revision + 1;
  const at = nowIso(now);
  const next = operationWithRevision({
    ...current,
    ...patch,
    operationId: current.operationId,
    ownerToken: current.ownerToken,
    status,
    phase: nextPhase,
    ...(status === "running" ? {} : { completedAt: at }),
  }, revision, at);
  await writeDocument(root, { ...document, revision, current: next });
  return next;
}

export async function recoverReadyTestContourOperation(root, {
  operationId,
  releaseId,
  runtime,
  now = new Date(),
} = {}) {
  const document = await readTestContourOperationDocument(root);
  const current = document.current;
  if (current?.operationId !== operationId || current?.status !== "running") return null;
  const revision = document.revision + 1;
  const at = nowIso(now);
  const ready = operationWithRevision({
    ...current,
    status: "ready",
    phase: "ready",
    releaseId: String(releaseId),
    runtime,
    recoveredAfterOwnerCrash: true,
    completedAt: at,
  }, revision, at);
  await writeDocument(root, { ...document, revision, current: ready });
  return ready;
}

export async function failStaleTestContourOperation(root, {
  operationId,
  reason = "owner-crash",
  now = new Date(),
} = {}) {
  const document = await readTestContourOperationDocument(root);
  const current = document.current;
  if (current?.operationId !== operationId || current?.status !== "running") return null;
  const revision = document.revision + 1;
  const at = nowIso(now);
  const failed = operationWithRevision({
    ...current,
    status: "failed",
    phase: "failed",
    reason,
    completedAt: at,
  }, revision, at);
  await writeDocument(root, { ...document, revision, current: failed });
  return failed;
}

export function testContourOperationReadback(document, {
  expectedOperationId = null,
  expectedHeadCommit = null,
} = {}) {
  const normalized = normalizeDocument(document);
  const expectedId = String(expectedOperationId ?? "").trim();
  const expectedHead = String(expectedHeadCommit ?? "").trim();
  const target = expectedId
    ? [normalized.current, ...normalized.history].find((item) => item?.operationId === expectedId) ?? null
    : normalized.current;
  const currentHead = String(normalized.current?.source?.headCommit ?? "").trim();
  let outcome = "not_found";
  if (!target) outcome = "not_found";
  else if (target.status === "superseded") outcome = "superseded";
  else if (expectedId && normalized.current?.operationId !== expectedId) outcome = "superseded";
  else if (expectedHead && currentHead && currentHead !== expectedHead) outcome = "superseded";
  else if (target.status === "running") outcome = "refreshing";
  else if (target.status === "ready") outcome = "exact";
  else if (target.status === "failed") outcome = "failed";
  return {
    outcome,
    revision: normalized.revision,
    operation: publicOperation(target),
    current: publicOperation(normalized.current),
  };
}

export function visibleTestContourOperation(operation) {
  return publicOperation(operation);
}
