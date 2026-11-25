import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runtimeStatus, verifyInstalledRuntime, installPreparedRuntime } from "./src/runtime/runtime-manager.mjs";
import { MaintenanceOperationStore } from "./src/infrastructure/persistence/maintenance-operation-store.mjs";
import { loadProjects } from "./src/infrastructure/filesystem/config.mjs";
import { installReadyPackage } from "./src/runtime/ready-package-installation.mjs";
import { registerInstallerStorageEvidence, registerLegacyInstallerCustody } from "./src/infrastructure/persistence/autonomous-installer-storage.mjs";
import { RuntimeUpdateBackupRetention } from "./src/infrastructure/persistence/runtime-update-backup-retention.mjs";
import { withStorageRetentionLease } from "./src/composition/storage-retention-composition.mjs";
import { StorageRetentionService } from "./src/application/storage-retention-service.mjs";
import { callDesktopControl } from "./src/infrastructure/process/desktop-control.mjs";

// Application maintenance protocol, separate from release orchestration. The
// application remains the sole owner of its pointer, installation and database.
export async function runtimeMaintenance(action, input) {
  if (!input || typeof input.runtimeRoot !== "string" || !path.isAbsolute(input.runtimeRoot)) {
    throw new TypeError("Maintenance requires an absolute runtimeRoot");
  }
  if (action === "status") return runtimeStatus({ runtimeRoot: input.runtimeRoot, requireProcessEvidence: true });
  if (action === "verify") return verifyInstalledRuntime(input);
  if (action === "install") return installPreparedRuntime(input);
  if (action === "package-install") return installReadyPackage(input);
  if (action === "config-validate") {
    const raw = JSON.parse(await readFile(path.join(input.runtimeRoot, "config.json"), "utf8"));
    loadProjects(raw, path.resolve(raw.projectRoot || input.defaultProject));
    return { valid: true };
  }
  if (action === "maintenance-read") {
    if (typeof input.operationId !== "string" || !input.operationId) throw new TypeError("Maintenance original is required");
    return new MaintenanceOperationStore({ dataDir: path.join(input.runtimeRoot, "data") }).getReadonly(input.operationId);
  }
  if (action === "installer-storage-register") {
    const store = new MaintenanceOperationStore({ dataDir: path.join(input.runtimeRoot, "data") });
    if (input.custody?.inspectOnly) return registerLegacyInstallerCustody({ ...input, ...input.custody, store });
    return withStorageRetentionLease(store.dataDir ?? path.join(input.runtimeRoot, "data"),
      () => input.custody ? registerLegacyInstallerCustody({ ...input, ...input.custody, store }) : registerInstallerStorageEvidence({ ...input, store }));
  }
  if (action === "installer-storage-preview") {
    const store = new MaintenanceOperationStore({ dataDir: path.join(input.runtimeRoot, "data") });
    const owner = new RuntimeUpdateBackupRetention({ runtimeRoot: input.runtimeRoot, store });
    const page = await owner.list({ after: input.after ?? null, limit: 3 });
    const previews = [];
    for (const candidate of page.items) previews.push({ ownerId: owner.id, candidate, ...await owner.preview({ candidate }) });
    return { ...page, previews, status: owner.status() };
  }
  if (action === "installer-storage-cleanup") {
    const dataDir = path.join(input.runtimeRoot, "data"), store = new MaintenanceOperationStore({ dataDir });
    const owner = new RuntimeUpdateBackupRetention({ runtimeRoot: input.runtimeRoot, store });
    const service = new StorageRetentionService({ store, owners: [owner],
      readContext: async () => {
        const health = await callDesktopControl("runtime-health", {}, { runtimeRoot: input.runtimeRoot, timeoutMs: 5000 });
        const pointer = JSON.parse(await readFile(path.join(input.runtimeRoot, "current.json"), "utf8"));
        return { ready: health.live === true && health.ready === true && health.process?.releaseId === pointer.current,
          busy: health.diagnostics?.storageRetention?.busy !== false, releaseId: pointer.current, isolated: false };
      }, withLease: fn => withStorageRetentionLease(dataDir, fn) });
    return { result: await service.runApproved(input.approved), status: service.status() };
  }
  throw new Error("Unsupported application maintenance action");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const result = await runtimeMaintenance(process.argv[2], JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, name: error.name,
      ...(typeof error.code === "string" ? { code: error.code } : {}) })}\n`);
    process.exitCode = 1;
  }
}
