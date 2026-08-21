#!/usr/bin/env node
import path from "node:path";

import { createWorkLogUsageStore } from "./src/application/work-log-usage-store.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { JournalDatabase } from "./src/infrastructure/persistence/journal-database.mjs";
import { applyWorkLogAccountBackfill } from "./src/infrastructure/persistence/work-log-account-backfill.mjs";
import { WorkLogUsageRepository } from "./src/infrastructure/persistence/work-log-usage-repository.mjs";
import { readClaudeAccount } from "./src/providers/claude/claude-account.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

const runtime = runtimeLayout(defaultRuntimeRoot());
const workspaceRoot = path.resolve(option("--project-root", path.resolve(import.meta.dirname, "..", "..")));
const databaseFile = path.resolve(option("--database", path.join(runtime.dataDir, "journal.sqlite")));
const ledgerFile = path.resolve(option("--ledger", path.join(runtime.dataDir, "work-log-usage.json")));
const workLogFile = option("--work-log", path.join(workspaceRoot, "WORK_LOG.md"));
const claudeAccount = await readClaudeAccount();
const result = await applyWorkLogAccountBackfill({
  databaseFile,
  providerAccounts: claudeAccount ? [{ provider: "claude", ...claudeAccount }] : [],
});
console.log(JSON.stringify(result, null, 2));

if (process.argv.includes("--project")) {
  const database = new JournalDatabase(databaseFile);
  const store = createWorkLogUsageStore({
    repositoryFactory: (options) => new WorkLogUsageRepository(options),
    ledgerFile,
    databaseFile,
    journalDatabase: database,
    defaultProjectRoot: workspaceRoot,
  });
  try {
    await store.project(workLogFile, {
      projectRoot: workspaceRoot,
      projectionProjectRoots: [workspaceRoot],
    });
    console.log(`Projection rebuilt: ${databaseFile}`);
  } finally {
    await store.close();
    database.close();
  }
}
