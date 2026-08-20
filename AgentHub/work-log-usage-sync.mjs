#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWorkLogUsageStore } from "./src/application/work-log-usage-store.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { JournalDatabase } from "./src/infrastructure/persistence/journal-database.mjs";
import { writeTextAtomic } from "./src/infrastructure/persistence/state-store.mjs";
import { WorkLogUsageRepository } from "./src/infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncStore } from "./src/infrastructure/persistence/work-log-usage-sync-store.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function defaultDeviceId(dataDir) {
  const source = `${os.hostname().toLowerCase()}\0${path.resolve(dataDir).toLowerCase()}`;
  return `agent-hub:${createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16)}`;
}

function usage() {
  throw new Error([
    "Usage:",
    "  node work-log-usage-sync.mjs export --out <file> [--device-id <id>]",
    "  node work-log-usage-sync.mjs import --in <file> [--project] [--device-id <id>]",
    "  node work-log-usage-sync.mjs project [--device-id <id>]",
  ].join("\n"));
}

const command = process.argv[2] ?? "";
if (!["export", "import", "project"].includes(command)) usage();

const runtime = runtimeLayout(defaultRuntimeRoot());
const workspaceRoot = path.resolve(option("--project-root", path.resolve(import.meta.dirname, "..", "..")));
const databaseFile = path.resolve(option("--database", path.join(runtime.dataDir, "journal.sqlite")));
const ledgerFile = path.resolve(option("--ledger", path.join(runtime.dataDir, "work-log-usage.json")));
const syncFile = path.resolve(option("--sync-file", path.join(runtime.dataDir, "work-log-usage-sync.json")));
const workLogFile = option("--work-log", path.join(workspaceRoot, "WORK_LOG.md"));
const deviceId = option("--device-id", defaultDeviceId(runtime.dataDir));

const syncStore = new WorkLogUsageSyncStore({ file: syncFile, deviceId });
const database = new JournalDatabase(databaseFile);
const store = createWorkLogUsageStore({
  repositoryFactory: (options) => new WorkLogUsageRepository(options),
  ledgerFile,
  databaseFile,
  journalDatabase: database,
  defaultProjectRoot: workspaceRoot,
  usageSyncStore: syncStore,
  usageSyncDeviceId: deviceId,
});

try {
  if (command === "export") {
    const out = option("--out");
    if (!out) usage();
    const snapshot = await store.usageSyncSnapshot({ deviceId });
    const target = path.resolve(out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeTextAtomic(target, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(JSON.stringify({
      exported: true,
      file: target,
      deviceId,
      events: snapshot.events.length,
    }, null, 2));
  } else if (command === "import") {
    const input = option("--in");
    if (!input) usage();
    const snapshot = JSON.parse(await readFile(path.resolve(input), "utf8"));
    const result = flag("--project")
      ? await store.importUsageSyncSnapshotAndProject({
          snapshot,
          projectRoot: workspaceRoot,
          projectionProjectRoots: [workspaceRoot],
          workLogFile,
        })
      : await syncStore.importSnapshot(snapshot);
    console.log(JSON.stringify({
      ...result,
      deviceId,
      syncFile,
    }, null, 2));
  } else {
    const projection = await store.project(workLogFile, {
      projectRoot: workspaceRoot,
      projectionProjectRoots: [workspaceRoot],
    });
    console.log(JSON.stringify({ projected: projection, deviceId, syncFile }, null, 2));
  }
} finally {
  await store.close();
  database.close();
}
