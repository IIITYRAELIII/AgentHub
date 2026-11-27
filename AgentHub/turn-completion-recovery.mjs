import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { TerminalTurnCommitService } from "./src/application/terminal-turn-commit-service.mjs";
import { planTurnCompletionRecovery, terminalCompletionTime } from "./src/domain/turn-completion-time.mjs";
import { readProviderTerminalEvidence } from "./src/infrastructure/persistence/provider-turn-telemetry-store.mjs";
import { ProviderTurnTerminalStore } from "./src/infrastructure/persistence/provider-turn-terminal-store.mjs";

export async function recoverCompletionFromDatabase({
  databaseFile, runtimeDataDir, threadId, turnId, terminalRevision, expectedCompletedAt,
  apply = false, turnEndDelivery = null,
}) {
  if (typeof threadId !== "string" || !threadId.trim() || typeof turnId !== "string" || !turnId.trim()
    || !Number.isSafeInteger(terminalRevision) || terminalRevision < 1 || !terminalCompletionTime(expectedCompletedAt)) {
    throw new TypeError("Exact Codex thread, turn, terminal revision and journal completion time are required");
  }
  const identity = { provider: "codex", threadId: threadId.trim(), turnId: turnId.trim(), terminalRevision };
  if (apply === true) {
    if (!turnEndDelivery?.recoverJournalCompletion) throw new Error("Apply requires the configured turn-end delivery owner");
    return turnEndDelivery.recoverJournalCompletion(identity, { expectedCompletedAt, apply: true });
  }

  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; BEGIN");
    const terminalCommits = new TerminalTurnCommitService({
      store: new ProviderTurnTerminalStore({ dataDir: runtimeDataDir }),
      readTerminalTelemetry: (key) => readProviderTerminalEvidence(database, key),
    });
    const evidence = await terminalCommits.completionTimeEvidence(identity, { verifyTelemetry: true });
    const row = database.prepare(`
      SELECT record_json FROM journal_records WHERE provider = ? AND thread_id = ? AND turn_id = ?
    `).get(identity.provider, identity.threadId, identity.turnId);
    return planTurnCompletionRecovery(JSON.parse(row?.record_json ?? "null"), evidence, expectedCompletedAt);
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [runtimeDataDir, databaseFile, threadId, turnId, revision, expectedCompletedAt, extra] = process.argv.slice(2);
  if (!runtimeDataDir || !databaseFile || !expectedCompletedAt || extra || process.argv.includes("--apply")) {
    throw new Error("Preview: node turn-completion-recovery.mjs <runtime-data-dir> <journal-db> <thread> <turn> <revision> <expected-completed-at>. Apply requires the configured turn-end delivery owner.");
  }
  const result = await recoverCompletionFromDatabase({
    runtimeDataDir, databaseFile, threadId, turnId, terminalRevision: Number(revision), expectedCompletedAt,
  });
  console.log(JSON.stringify(result, null, 2));
}
