#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";

import {
  applyRateLimitRolloutBackfill,
  buildRateLimitRolloutBackfill,
} from "./rate-limit-rollout-backfill.mjs";
import { RateLimitHistoryStore } from "./rate-limit-history.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./runtime-layout.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const runtime = runtimeLayout(defaultRuntimeRoot());
const rawHistoryFile = option("--raw-history", path.join(runtime.dataDir, "rate-limits-raw.jsonl"));
const csvHistoryFile = option("--csv-history", path.join(runtime.dataDir, "rate-limits.csv"));
const databaseFile = option("--database", path.join(runtime.dataDir, "journal.sqlite"));
const rolloutRoots = [
  option("--sessions", path.join(codexHome, "sessions")),
  option("--archived-sessions", path.join(codexHome, "archived_sessions")),
];
const migration = await buildRateLimitRolloutBackfill({
  rolloutRoots,
  rawHistoryFile,
  bucketMinutes: option("--bucket-minutes", "5"),
});
console.log(JSON.stringify(migration.report, null, 2));

if (process.argv.includes("--apply")) {
  const store = new RateLimitHistoryStore({ databaseFile, rawFile: rawHistoryFile, csvFile: csvHistoryFile });
  let result;
  try {
    result = await applyRateLimitRolloutBackfill({
      migration,
      rawHistoryFile,
      csvHistoryFile,
      store,
    });
    await store.rebuildCompatibilityExports();
  } finally {
    await store.close();
  }
  console.log(`Raw history: ${rawHistoryFile} (+${result.rawRecords})`);
  console.log(`CSV history: ${csvHistoryFile} (+${result.csvRows})`);
} else {
  console.log("Dry run only. Add --apply to extend the local history.");
}
