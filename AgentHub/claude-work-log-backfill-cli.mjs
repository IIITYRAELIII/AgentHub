import os from "node:os";
import path from "node:path";

import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import {
  applyClaudeWorkLogBackfill,
  buildClaudeWorkLogBackfill,
} from "./src/providers/claude/claude-work-log.mjs";

const apply = process.argv.includes("--apply");
const config = await loadConfig();
const databaseFile = path.join(config.dataDir, "journal.sqlite");
const ledgerFile = path.join(config.dataDir, "work-log-usage.json");
const workLogFile = path.join(config.projectRoot, "WORK_LOG.md");
const migration = await buildClaudeWorkLogBackfill({
  transcriptRoot: path.join(os.homedir(), ".claude", "projects"),
  databaseFile,
  ledgerFile,
  projects: config.projects,
});

if (apply) {
  const result = await applyClaudeWorkLogBackfill({
    migration,
    databaseFile,
    ledgerFile,
    workLogFile,
    projectRoot: config.projectRoot,
    projectionProjectRoots: config.projects.map((project) => project.path),
  });
  migration.report.backupDirectory = result.backupDirectory;
}

process.stdout.write(`${JSON.stringify({
  mode: apply ? "applied" : "preview",
  databaseFile,
  ...migration.report,
}, null, 2)}\n`);
