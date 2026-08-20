#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createWorkLogUsageStore } from "./src/application/work-log-usage-store.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { JournalDatabase } from "./src/infrastructure/persistence/journal-database.mjs";
import { writeTextAtomic } from "./src/infrastructure/persistence/state-store.mjs";
import { UsageSyncRemoteClient } from "./src/infrastructure/http/usage-sync-remote-client.mjs";
import { UsageSyncIdentityStore } from "./src/infrastructure/persistence/usage-sync-identity-store.mjs";
import { UsageSyncRemoteConfigStore } from "./src/infrastructure/persistence/usage-sync-remote-config-store.mjs";
import { WorkLogUsageRepository } from "./src/infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncStore } from "./src/infrastructure/persistence/work-log-usage-sync-store.mjs";
import { defaultUsageSyncServerUrl } from "./src/domain/default-usage-sync-server.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function usage() {
  throw new Error([
    "Usage:",
    "  node work-log-usage-sync.mjs identity [--set-label <label>]",
    "  node work-log-usage-sync.mjs enroll --server <url> --code <code>",
    "  node work-log-usage-sync.mjs invite [--ttl-seconds <seconds>]",
    "  node work-log-usage-sync.mjs push [--server <url>]",
    "  node work-log-usage-sync.mjs pull [--server <url>] [--project]",
    "  node work-log-usage-sync.mjs sync [--server <url>] [--project]",
    "  node work-log-usage-sync.mjs export --out <file> [--device-id <id>]",
    "  node work-log-usage-sync.mjs import --in <file> [--project] [--device-id <id>]",
    "  node work-log-usage-sync.mjs project [--device-id <id>]",
    "  node work-log-usage-sync.mjs remote-status",
  ].join("\n"));
}

const command = process.argv[2] ?? "";
if (![
  "identity",
  "enroll",
  "invite",
  "push",
  "pull",
  "sync",
  "export",
  "import",
  "project",
  "remote-status",
].includes(command)) usage();

const runtime = runtimeLayout(defaultRuntimeRoot());
const workspaceRoot = path.resolve(option("--project-root", path.resolve(import.meta.dirname, "..", "..")));
const databaseFile = path.resolve(option("--database", path.join(runtime.dataDir, "journal.sqlite")));
const ledgerFile = path.resolve(option("--ledger", path.join(runtime.dataDir, "work-log-usage.json")));
const syncFile = path.resolve(option("--sync-file", path.join(runtime.dataDir, "work-log-usage-sync.json")));
const identityFile = path.resolve(
  option("--identity-file", path.join(runtime.dataDir, "usage-sync-identity.json")),
);
const remoteConfigFile = path.resolve(
  option("--remote-config", path.join(runtime.dataDir, "usage-sync-remote.json")),
);
const workLogFile = option("--work-log", path.join(workspaceRoot, "WORK_LOG.md"));

const identityStore = new UsageSyncIdentityStore({
  file: identityFile,
  dataDir: runtime.dataDir,
});
await identityStore.load();
const explicitDeviceId = option("--device-id", "");
if (["enroll", "invite", "push", "pull", "sync"].includes(command) && explicitDeviceId) {
  throw new Error("Remote usage-sync commands use the durable local identity; --device-id is not supported");
}
const deviceId = explicitDeviceId || identityStore.deviceId;

if (command === "identity") {
  const label = option("--set-label", "");
  if (process.argv.includes("--set-label")) await identityStore.setLabel(label);
  console.log(JSON.stringify({ ...identityStore.toPublic(), file: identityFile }, null, 2));
  process.exit(0);
}

const remoteConfigStore = new UsageSyncRemoteConfigStore({
  file: remoteConfigFile,
  defaultServerUrl: defaultUsageSyncServerUrl(),
});
const remoteConfig = await remoteConfigStore.load();

if (command === "remote-status") {
  console.log(JSON.stringify({
    ...remoteConfig,
    file: remoteConfigFile,
    localDeviceId: identityStore.deviceId,
  }, null, 2));
  process.exit(0);
}

function configuredServerUrl() {
  const server = option("--server", "");
  if (server) return server;
  if (remoteConfig.serverUrl) return remoteConfig.serverUrl;
  throw new Error("Usage sync server URL is required; pass --server once during enroll");
}

function remoteClient() {
  return new UsageSyncRemoteClient({
    serverUrl: configuredServerUrl(),
    identityStore,
  });
}

const syncStore = new WorkLogUsageSyncStore({
  databaseFile,
  legacyFile: syncFile,
  deviceId,
});
const adopted = await syncStore.adoptDeviceIds(identityStore.legacyDeviceIds);
if (adopted.migrated) {
  console.error(`Adopted ${adopted.migrated} usage sync event(s) onto device ${deviceId}`);
}
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
  if (command === "enroll") {
    const result = await remoteClient().enroll(option("--code"));
    await remoteConfigStore.rememberEnrollment({
      serverUrl: configuredServerUrl(),
      deviceId: identityStore.deviceId,
      result,
    });
    console.log(JSON.stringify({
      enrolled: true,
      ...result,
      serverUrl: configuredServerUrl(),
      config: remoteConfigFile,
    }, null, 2));
  } else if (command === "invite") {
    const result = await remoteClient().createEnrollmentCode({
      ttlSeconds: Number(option("--ttl-seconds", "900")),
    });
    console.log(JSON.stringify({
      invited: true,
      ...result,
      serverUrl: configuredServerUrl(),
    }, null, 2));
  } else if (command === "push") {
    const snapshot = await store.usageSyncSnapshot({ deviceId: identityStore.deviceId });
    const result = await remoteClient().push(snapshot);
    await remoteConfigStore.rememberPush(result);
    console.log(JSON.stringify({
      pushed: true,
      exportedEvents: snapshot.events.length,
      ...result,
      serverUrl: configuredServerUrl(),
    }, null, 2));
  } else if (command === "pull") {
    const snapshot = await remoteClient().pull();
    const result = flag("--project")
      ? await store.importUsageSyncSnapshotAndProject({
          snapshot,
          projectRoot: workspaceRoot,
          projectionProjectRoots: [workspaceRoot],
          workLogFile,
        })
      : await syncStore.importSnapshot(snapshot);
    await remoteConfigStore.rememberPull(result);
    console.log(JSON.stringify({
      pulled: true,
      remoteEvents: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
      ...result,
      serverUrl: configuredServerUrl(),
    }, null, 2));
  } else if (command === "sync") {
    const snapshot = await store.usageSyncSnapshot({ deviceId: identityStore.deviceId });
    const push = await remoteClient().push(snapshot);
    await remoteConfigStore.rememberPush(push);
    const remoteSnapshot = await remoteClient().pull();
    const pull = flag("--project")
      ? await store.importUsageSyncSnapshotAndProject({
          snapshot: remoteSnapshot,
          projectRoot: workspaceRoot,
          projectionProjectRoots: [workspaceRoot],
          workLogFile,
        })
      : await syncStore.importSnapshot(remoteSnapshot);
    await remoteConfigStore.rememberPull(pull);
    console.log(JSON.stringify({
      synced: true,
      exportedEvents: snapshot.events.length,
      remoteEvents: Array.isArray(remoteSnapshot.events) ? remoteSnapshot.events.length : 0,
      push,
      pull,
      serverUrl: configuredServerUrl(),
    }, null, 2));
  } else if (command === "export") {
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
      syncStore: syncStore.databaseFile,
    }, null, 2));
  } else {
    const projection = await store.project(workLogFile, {
      projectRoot: workspaceRoot,
      projectionProjectRoots: [workspaceRoot],
    });
    console.log(JSON.stringify({
      projected: projection,
      deviceId,
      syncStore: syncStore.databaseFile,
    }, null, 2));
  }
} finally {
  await store.close();
  await syncStore.close();
  database.close();
}
