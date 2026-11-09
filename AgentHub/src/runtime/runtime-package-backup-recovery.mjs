import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MaintenanceOperationStore } from "../infrastructure/persistence/maintenance-operation-store.mjs";
import { packageBindingDigest, packageDirectory, packageFile, assertPackageFiles } from "../infrastructure/filesystem/runtime-package-target.mjs";
import { verifyRuntimeManifest } from "../infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { inspectRuntimeBackupScope, assertRuntimeBackupScope } from "../infrastructure/persistence/runtime-maintenance-backup.mjs";
import { assertOldPackageCurrent, packageHandoffBinding } from "./runtime-package-handoff.mjs";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/u;
const legacyOwners = {
  "src/runtime/runtime-package-handoff.mjs": "5355d7ff03a34bfbab90a7c302b45b26112e854bf44f1467f45a1bac18c5186a",
  "src/infrastructure/persistence/runtime-maintenance-backup.mjs": "c01a3a7bf0b2a0dff909e617f6f1731635c588e11b3f782fd53b130df2698b10",
};

// Migration only for the recorded protocol-v1, revision7 refusal. A generic
// UNKNOWN, an error string, or absence of running processes grants no retry.
export async function assertPackageBackupRecovery(current) {
  const binding = packageHandoffBinding(current), m = current.metadata;
  const native = m.packageNative;
  if (current.streamId !== "agent-hub-runtime" || current.threadId !== "agent-hub-runtime"
    || current.status !== "reconciling" || current.phase !== "package-reconciling" || current.outcome !== "unknown"
    || m.packageFailurePhase !== "package-backup" || !native
    || ["packageBackup", "packageLaunchAdmission", "packageLaunchSha256", "packageCurrentRecovery", "packageRecovery"]
      .some(key => m[key] != null)
    || native.oldNodePid !== binding.old.pid || native.oldHostPid !== binding.old.hostPid
    || ["hostPid", "launcherPid", "oldNodePid", "oldHostPid"].some(key => !Number.isSafeInteger(native[key]) || native[key] <= 0)
    || ["hostStarted", "oldNodeStarted", "oldHostStarted"].some(key => !/^\d+$/u.test(native[key] ?? ""))) {
    throw new Error("Original package has no qualified pre-backup recovery authority");
  }
  const relative = path.relative(binding.runtimeRoot, binding.scratchRoot);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Original package did not refuse an internal backup destination");
  }
  const typed = m.packageBackupDestinationFailure;
  if (typed?.schema === 1 && typed.bindingSha256 === m.packageHandoff.sha256
    && typed.fromRevision === current.revision - 1 && typed.reason === "inside-runtime") return binding;
  if (current.revision !== 7 || m.packageAttempt != null || m.packageBootstrap != null
    || m.packageFailureMessage !== "Maintenance backup destination must be outside runtime root"
    || m.packageFailureCode != null || m.packageBackupRecovery != null) {
    throw new Error("Original package lacks typed or exact legacy pre-backup proof");
  }
  const release = path.join(binding.runtimeRoot, "releases", binding.old.releaseId);
  for (const [file, sha256] of Object.entries(legacyOwners)) {
    if ((await packageFile(path.join(release, file))).sha256 !== sha256) {
      throw new Error("Legacy package recovery owner differs from the recorded refusal");
    }
  }
  return binding;
}

export async function packageBackupRecoveryRequest(runtimeRoot, operationId, expectedRevision,
  expectedBindingSha256, helperRoot) {
  const root = await realpath(runtimeRoot);
  const store = new MaintenanceOperationStore({ dataDir: path.join(root, "data") });
  const original = store.getReadonly(operationId);
  const binding = await assertPackageBackupRecovery(original);
  if (binding.runtimeRoot !== root || original.revision !== Number(expectedRevision)
    || original.metadata.packageHandoff.sha256 !== expectedBindingSha256 || !SHA.test(expectedBindingSha256)) {
    throw new Error("Package backup recovery revision or binding changed");
  }
  const helper = await packageDirectory(helperRoot);
  const dataScope = await inspectRuntimeBackupScope({ runtimeRoot: root });
  const dataFiles = [];
  for (const entry of dataScope.files) {
    // Only this canonical SQLite is changed by the recovery intent below.
    // Its original business row is retained whole, including UNKNOWN/history.
    if (entry.source !== path.join(root, "data", "runtime.sqlite")) dataFiles.push(await packageFile(entry.source));
  }
  return { schema: 1, operationId, runtimeRoot: root, expectedRevision: original.revision,
    expectedBindingSha256, expectedOriginalSha256: packageBindingDigest(original),
    disposition: "failed-retained-stopped-current", native: original.metadata.packageNative,
    closedFence: await packageFile(path.join(root, ".agent-hub-release-acceptance.closed")),
    acceptance: await packageFile(path.join(root, ".agent-hub-release-acceptance.json")),
    dataScope, dataFiles,
    helper: { ...helper, manifest: await packageFile(path.join(helper.directory, "runtime-manifest.json")) } };
}

export async function readPackageBackupRecoveryRequest(requestFile) {
  const file = await packageFile(requestFile);
  if (file.bytes > 65536) throw new Error("Package backup recovery request exceeds budget");
  const request = JSON.parse(await readFile(file.file, "utf8"));
  if (Object.keys(request).sort().join(",") !== "acceptance,closedFence,dataFiles,dataScope,disposition,expectedBindingSha256,expectedOriginalSha256,expectedRevision,helper,native,operationId,runtimeRoot,schema"
    || request.schema !== 1 || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1
    || request.disposition !== "failed-retained-stopped-current"
    || !SHA.test(request.expectedBindingSha256 ?? "") || !SHA.test(request.expectedOriginalSha256 ?? "")) {
    throw new Error("Invalid addressed package backup recovery request");
  }
  const store = new MaintenanceOperationStore({ dataDir: path.join(await realpath(request.runtimeRoot), "data") });
  return { request, file, store, requestSha256: packageBindingDigest(request) };
}

export async function assertPackageBackupRecoveryFiles(request, binding) {
  if (request.runtimeRoot !== binding.runtimeRoot
    || request.closedFence.file !== path.join(binding.runtimeRoot, ".agent-hub-release-acceptance.closed")
    || packageBindingDigest(request.closedFence) !== packageBindingDigest(await packageFile(request.closedFence.file))
    || request.acceptance.file !== path.join(binding.runtimeRoot, ".agent-hub-release-acceptance.json")
    || packageBindingDigest(request.acceptance) !== packageBindingDigest(await packageFile(request.acceptance.file))
    || request.helper.manifest.file !== path.join(request.helper.directory, "runtime-manifest.json")
    || packageBindingDigest(request.helper) !== packageBindingDigest({ ...await packageDirectory(request.helper.directory),
      manifest: await packageFile(request.helper.manifest.file) })) {
    throw new Error("Package backup recovery physical custody changed");
  }
  if (request.dataScope.runtimeRoot !== binding.runtimeRoot) throw new Error("Package recovery data root changed");
  await assertRuntimeBackupScope(request.dataScope);
  const selected = request.dataScope.files.filter(entry => entry.source !== path.join(binding.runtimeRoot, "data", "runtime.sqlite"));
  if (!Array.isArray(request.dataFiles) || request.dataFiles.length !== selected.length) throw new Error("Package recovery data proof is incomplete");
  for (let index = 0; index < selected.length; index++) {
    if (request.dataFiles[index].file !== selected[index].source
      || packageBindingDigest(request.dataFiles[index]) !== packageBindingDigest(await packageFile(selected[index].source))) {
      throw new Error("Package recovery retained data changed");
    }
  }
  await assertOldPackageCurrent(binding);
  await verifyRuntimeManifest(path.join(binding.runtimeRoot, "releases", binding.old.releaseId), binding.old.releaseId);
  await assertPackageFiles(binding.target);
  const host = await packageFile(path.join(binding.runtimeRoot, "AgentHub.RuntimeHost.exe"));
  if (host.sha256 !== binding.old.launcher.sha256 || host.bytes !== binding.old.launcher.bytes) {
    throw new Error("Package recovery stable Host changed");
  }
  const helperManifest = JSON.parse(await readFile(request.helper.manifest.file, "utf8"));
  await verifyRuntimeManifest(request.helper.directory, helperManifest.releaseId);
  const module = "src/runtime/runtime-package-backup-recovery.mjs";
  if ((await packageFile(path.join(request.helper.directory, module))).sha256
    !== (await packageFile(fileURLToPath(import.meta.url))).sha256) {
    throw new Error("Package recovery helper differs from the current owner");
  }
}

export async function settlePackageBackupRecoveryStage(store, operationId, native, environment, assertRetired) {
  const retained = await readPackageBackupRecoveryRequest(environment.AGENT_HUB_PACKAGE_BACKUP_RECOVERY_REQUEST ?? "");
  const { request, file, requestSha256 } = retained;
  const current = store.getReadonly(operationId), recovery = current?.metadata?.packageBackupRecovery;
  if (!recovery || request.operationId !== operationId || recovery.phase !== "native-intent"
    || recovery.requestSha256 !== requestSha256 || file.sha256 !== environment.AGENT_HUB_PACKAGE_BACKUP_RECOVERY_SHA256
    || packageBindingDigest(file) !== packageBindingDigest(recovery.requestFile)
    || packageBindingDigest(recovery.original) !== request.expectedOriginalSha256
    || current.revision !== request.expectedRevision + 1
    || current.status !== "reconciling" || current.phase !== "package-reconciling" || current.outcome !== "unknown"
    || packageBindingDigest({ ...current.metadata, packageBackupRecovery: undefined })
      !== packageBindingDigest({ ...recovery.original.metadata, packageBackupRecovery: undefined })
    || packageBindingDigest(request.native) !== packageBindingDigest(current.metadata.packageNative)
    || native.oldNodePid !== request.native.oldNodePid || native.oldHostPid !== request.native.oldHostPid
    || native.oldNodeStarted !== request.native.oldNodeStarted || native.oldHostStarted !== request.native.oldHostStarted
    || environment.AGENT_HUB_PACKAGE_COHORT_RETIRED !== "1") {
    throw new Error("Package backup recovery native admission changed");
  }
  const binding = await assertPackageBackupRecovery(recovery.original);
  await assertRetired();
  await assertPackageBackupRecoveryFiles(request, binding);
  await assertRetired();
  await store.runRestartMutation(() => {
    const saved = store.transition(operationId, { status: "failed", outcome: "failed", phase: "retained-stopped-current", metadata: {
      packageBackupRecovery: { ...recovery, phase: "settled", native,
        disposition: request.disposition, retainedReleaseId: binding.old.releaseId,
        priorOutcome: "unknown", installInvoked: false, launchInvoked: false,
        dataScopeSha256: packageBindingDigest(request.dataScope),
        retirementProof: { kind: "closed-acceptance-backup-refusal-v1",
          originalNative: request.native, closedFenceSha256: request.closedFence.sha256,
          acceptanceSha256: request.acceptance.sha256 } },
    } }, { expectedRevision: current.revision });
    if (!saved.applied) throw new Error("Package backup recovery native CAS changed");
  }, { requestId: operationId });
  return store.getReadonly(operationId);
}

export async function recoverPackageBackup(requestFile, { executeHost = execute } = {}) {
  const { request, file, store, requestSha256 } = await readPackageBackupRecoveryRequest(requestFile);
  const original = store.getReadonly(request.operationId);
  if (original?.metadata?.packageBackupRecovery) {
    if (original.metadata.packageBackupRecovery.requestSha256 !== requestSha256) throw new Error("Original package recovery input changed");
    return { operationId: original.operationId, status: original.status, phase: original.phase, effectsReplayed: false };
  }
  const binding = await assertPackageBackupRecovery(original);
  if (original.revision !== request.expectedRevision || packageBindingDigest(original) !== request.expectedOriginalSha256
    || original.metadata.packageHandoff.sha256 !== request.expectedBindingSha256
    || packageBindingDigest(original.metadata.packageNative) !== packageBindingDigest(request.native)) {
    throw new Error("Package backup recovery original changed");
  }
  await assertPackageBackupRecoveryFiles(request, binding);
  // Preserve the entire unknown row before any native admission. This exact
  // intent cannot authorize a second Host after a lost reply or launch failure.
  const admitted = await store.runRestartMutation(() => {
    const fresh = store.getReadonly(request.operationId);
    if (fresh.metadata.packageBackupRecovery?.requestSha256 === requestSha256) return false;
    const saved = store.transition(request.operationId, { metadata: { packageBackupRecovery: {
      schema: 1, requestSha256, requestFile: file, original, disposition: request.disposition, phase: "native-intent",
    } } }, { expectedRevision: original.revision });
    if (!saved.applied) throw new Error("Package backup recovery CAS changed");
    return true;
  }, { requestId: request.operationId });
  if (admitted) {
    await executeHost(path.join(request.helper.directory, "AgentHub.RuntimeHost.exe"),
      ["--package-backup-recovery", binding.runtimeRoot, request.helper.directory, file.file],
      { windowsHide: true, cwd: request.helper.directory, maxBuffer: 1024 * 1024 });
  }
  const current = store.getReadonly(request.operationId);
  return { operationId: current.operationId, status: current.status, phase: current.phase,
    effectsReplayed: false, nativeInvocationJoined: admitted };
}
