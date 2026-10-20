import path from "node:path";
import { StorageRetentionService } from "../application/storage-retention-service.mjs";
import { withInterprocessLocks } from "../infrastructure/process/interprocess-lock.mjs";

export function storageRetentionEnabled({ environment = process.env, recording = false } = {}) {
  return Boolean(environment.AGENT_HUB_RELEASE_ID) && environment.AGENT_HUB_TEST_CONTOUR !== "1" && !recording;
}

export function createStorageRetentionComposition({ config, store, taskBoard, taskGitWorkspaces,
  timers, readReady, readBusy, isStopping, health, environment = process.env } = {}) {
  if (!storageRetentionEnabled({ environment, recording: Boolean(config.testContourRecording) })) return null;
  const service = new StorageRetentionService({ store, timers, isStopping,
    owners: [taskGitWorkspaces.storageRetentionOwner({ taskBoard, isStopping: () => isStopping() || readBusy() })],
    readContext: () => ({ ready: readReady(), busy: readBusy(), releaseId: environment.AGENT_HUB_RELEASE_ID, isolated: false }),
    withLease: fn => withInterprocessLocks([path.join(config.dataDir, "storage-retention")], fn, { timeoutMs: 250 }),
  });
  // Health reads only cached bounded status, never the maintenance DB or files.
  health.setDiagnosticSource("storageRetention", () => service.status());
  return service;
}
