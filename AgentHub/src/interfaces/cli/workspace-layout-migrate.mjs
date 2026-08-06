#!/usr/bin/env node
import path from "node:path";

import {
  applyWorkspaceLayout,
  planWorkspaceLayout,
  readWorkspaceLayoutManifest,
} from "../../infrastructure/persistence/workspace-layout-migration.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const manifestFile = option("--manifest");
if (!manifestFile) throw new Error("Usage: workspace-layout-migrate.mjs --manifest <file> [--apply] [--database <journal.sqlite>]");
const databaseFile = path.resolve(option("--database")
  ?? path.join(process.env.LOCALAPPDATA ?? process.cwd(), "AgentHub", "data", "journal.sqlite"));
const manifest = await readWorkspaceLayoutManifest(manifestFile);
const apply = process.argv.includes("--apply");
const result = apply
  ? await applyWorkspaceLayout({ databaseFile, manifest, backupDirectory: option("--backup-directory") })
  : { applied: false, reason: "dry-run", plan: planWorkspaceLayout({ databaseFile, manifest }) };

const plan = result.plan;
console.log(JSON.stringify({
  applied: result.applied,
  reason: result.reason ?? null,
  migrationKey: plan.manifest.key,
  manifestHash: plan.manifestHash,
  valid: plan.valid,
  rootThreadCount: plan.rootThreadCount,
  executingThreadCount: plan.executingThreadCount,
  explicitCount: plan.explicit.length,
  automaticExperimentsCount: plan.automatic.length,
  missing: plan.missing.map((item) => ({ provider: item.provider, threadId: item.threadId })),
  audit: result.audit ?? null,
}, null, 2));
if (!plan.valid) process.exitCode = 2;
