import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { planTurnDurationRecovery } from "./src/domain/turn-duration-recovery.mjs";

export async function recoverDurationFromDatabase({ databaseFile, threadId, turnId, predecessorTurnId,
  apply = false, workLogUsageStore = null }) {
  if (apply && !workLogUsageStore) throw new Error("Apply requires the configured work-log usage owner");
  const identity = { provider: "codex", threadId, turnId };
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  let record;
  let predecessor;
  let telemetry;
  let projectRoots;
  try {
    database.exec("PRAGMA query_only=ON; BEGIN");
    const read = database.prepare("SELECT record_json FROM journal_records WHERE provider=? AND thread_id=? AND turn_id=?");
    record = JSON.parse(read.get("codex", threadId, turnId)?.record_json ?? "null");
    predecessor = JSON.parse(read.get("codex", threadId, predecessorTurnId)?.record_json ?? "null");
    telemetry = database.prepare(`SELECT provider, thread_id AS threadId, turn_id AS turnId, run_id AS runId,
      requested_at_ms AS requestedAtMs, accepted_at_ms AS acceptedAtMs,
      turn_started_at_ms AS turnStartedAtMs, completed_at_ms AS completedAtMs
      FROM provider_turn_telemetry WHERE provider=? AND thread_id=? AND turn_id=?`).get("codex", threadId, turnId);
    const source = database.prepare("SELECT value FROM journal_store_meta WHERE key='journal_projection_source'").get()?.value;
    projectRoots = source ? JSON.parse(source).projectRoots : undefined;
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const recovery = planTurnDurationRecovery(record, { predecessor, telemetry });
  if (!recovery || !apply) return { eligible: Boolean(recovery), applied: false, recovery };
  const result = await workLogUsageStore.recoverTurnDuration(identity, { predecessorTurnId, telemetry }, { apply: true });
  if (result.eligible) {
    const projection = await workLogUsageStore.project(null, { projectionProjectRoots: projectRoots });
    result.projectionPending = projection.projected !== true && projection.reason !== "unchanged";
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [databaseFile, threadId, turnId, predecessorTurnId, extra] = process.argv.slice(2);
  if (!databaseFile || !threadId || !turnId || !predecessorTurnId || extra) {
    throw new Error("Preview: node turn-duration-recovery.mjs <database> <thread> <turn> <predecessor-turn>. Apply uses the configured work-log usage owner API.");
  }
  console.log(JSON.stringify(await recoverDurationFromDatabase({ databaseFile, threadId, turnId, predecessorTurnId }), null, 2));
}
