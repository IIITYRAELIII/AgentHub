import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { defaultRuntimeRoot, runtimeLayout } from "../infrastructure/filesystem/runtime-layout.mjs";
import {
  readRuntimeState,
  runtimeDatabasePath,
} from "../infrastructure/persistence/runtime-state-store.mjs";

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (Buffer.byteLength(normalized, "utf8") > 240) throw new Error(`${label} is too long`);
  return normalized;
}

export function manualTestContourOwnerIdentity({
  provider,
  threadId,
  turnId,
  runtimeDataDir = runtimeLayout(defaultRuntimeRoot()).dataDir,
} = {}) {
  return {
    provider: requiredText(provider, "owner provider").toLowerCase(),
    threadId: requiredText(threadId, "owner thread id"),
    turnId: requiredText(turnId, "owner turn id"),
    runtimeDataDir: path.resolve(requiredText(runtimeDataDir, "owner runtime data directory")),
  };
}

function readTerminal(dataDir, identity) {
  let database = null;
  try {
    database = new DatabaseSync(runtimeDatabasePath(dataDir), { readOnly: true });
    database.exec("PRAGMA busy_timeout = 0;");
    for (const table of ["provider_run_terminals", "provider_turn_terminals"]) {
      try {
        const terminal = database.prepare(`
          SELECT status, committed_at
          FROM ${table}
          WHERE provider = ? AND thread_id = ? AND turn_id = ?
        `).get(identity.provider, identity.threadId, identity.turnId);
        if (terminal) return terminal;
      } catch (error) {
        if (!/no such table/iu.test(String(error?.message ?? error))) throw error;
      }
    }
    return null;
  } catch (error) {
    if (/unable to open database file|no such table|database is locked|SQLITE_BUSY/iu
      .test(String(error?.message ?? error))) return null;
    throw error;
  } finally {
    database?.close();
  }
}

export async function readManualTestContourOwnerLifecycle(identityInput, {
  readState = readRuntimeState,
  readTerminalRecord = readTerminal,
} = {}) {
  const identity = manualTestContourOwnerIdentity(identityInput);
  const [stateResult, terminalResult] = await Promise.allSettled([
    readState(identity.runtimeDataDir),
    Promise.resolve().then(() => readTerminalRecord(identity.runtimeDataDir, identity)),
  ]);
  if (terminalResult.status === "fulfilled" && terminalResult.value) {
    return {
      state: "terminal",
      status: String(terminalResult.value.status ?? "terminal"),
      committedAt: String(terminalResult.value.committed_at ?? terminalResult.value.committedAt ?? "") || null,
      identity,
    };
  }
  if (stateResult.status === "fulfilled") {
    const runs = Array.isArray(stateResult.value?.activeRuns) ? stateResult.value.activeRuns : [];
    const exact = runs.find((run) => (
      String(run?.provider ?? "").toLowerCase() === identity.provider
      && String(run?.threadId ?? "") === identity.threadId
      && String(run?.turnId ?? "") === identity.turnId
    ));
    if (exact) return { state: "active", status: String(exact.status ?? "running"), identity };
  }
  return {
    state: "unknown",
    status: null,
    identity,
    reason: stateResult.status === "rejected" || terminalResult.status === "rejected"
      ? "lifecycle-read-failed"
      : "owner-not-active-and-no-terminal-receipt",
  };
}
