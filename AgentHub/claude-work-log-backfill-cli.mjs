import os from "node:os";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import {
  applyClaudeWorkLogBackfill,
  buildClaudeWorkLogBackfill,
} from "./claude-work-log.mjs";

const apply = process.argv.includes("--apply");
const config = await loadConfig();
const ledgerFile = path.join(config.dataDir, "work-log-usage.json");
const workLogFile = path.join(config.projectRoot, "WORK_LOG.md");
const migration = await buildClaudeWorkLogBackfill({
  transcriptRoot: path.join(os.homedir(), ".claude", "projects"),
  ledgerFile,
  projects: config.projects,
});

if (apply) {
  const result = await applyClaudeWorkLogBackfill({
    migration,
    ledgerFile,
    workLogFile,
  });
  migration.report.backupDirectory = result.backupDirectory;
}

process.stdout.write(`${JSON.stringify({
  mode: apply ? "applied" : "preview",
  ledgerFile,
  workLogFile,
  ...migration.report,
}, null, 2)}\n`);
