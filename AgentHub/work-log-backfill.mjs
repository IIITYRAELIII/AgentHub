#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyWorkLogRolloutBackfill,
  buildWorkLogRolloutBackfill,
} from "./work-log-rollout-backfill.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./runtime-layout.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(sourceRoot, "..", "..");
const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const runtime = runtimeLayout(defaultRuntimeRoot());
const through = option("--through");
const projectRoot = option("--project-root", workspaceRoot);
const databaseFile = option("--database", path.join(runtime.dataDir, "journal.sqlite"));
const ledgerFile = option("--ledger", path.join(runtime.dataDir, "work-log-usage.json"));
const workLogFile = option("--work-log", path.join(projectRoot, "WORK_LOG.md"));
const sessionIndexFile = option("--session-index", path.join(codexHome, "session_index.jsonl"));
const rolloutRoots = [
  option("--sessions", path.join(codexHome, "sessions")),
  option("--archived-sessions", path.join(codexHome, "archived_sessions")),
];

const migration = await buildWorkLogRolloutBackfill({
  rolloutRoots,
  sessionIndexFile,
  databaseFile,
  ledgerFile,
  projectRoot,
  through,
});
console.log(JSON.stringify(migration.report, null, 2));

if (process.argv.includes("--apply")) {
  const result = await applyWorkLogRolloutBackfill({
    migration,
    databaseFile,
    ledgerFile,
    workLogFile,
    projectRoot,
    projectionProjectRoots: [projectRoot],
  });
  console.log(`Backup: ${result.backupDirectory}`);
  console.log(`Database: ${databaseFile}`);
} else {
  console.log("Dry run only. Add --apply to update journal.sqlite.");
}
