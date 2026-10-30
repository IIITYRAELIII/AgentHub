import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { RUNTIME_RESTART_SCOPE } from "../domain/maintenance-operation.mjs";
import { MaintenanceOperationStore } from "../infrastructure/persistence/maintenance-operation-store.mjs";
import { backupStoppedRuntime } from "../infrastructure/persistence/runtime-maintenance-backup.mjs";
import { verifyRuntimeManifest } from "../infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { protectRuntimeDirectory } from "../infrastructure/filesystem/runtime-security.mjs";
import { assertPackageFiles, capturePackageRuntime, packageBindingDigest, packageDigest,
  packageFile, verifyPublicPackageTarget } from "../infrastructure/filesystem/runtime-package-target.mjs";
import { waitForReplacementLock, directWindowsLauncherInvocation } from "./runtime-restart.mjs";
import { waitForRuntimeReplacement } from "./publication-readiness.mjs";

const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (operation) => ["succeeded", "failed"].includes(operation?.status);

export function packageHandoffBinding(operation) {
  const envelope = operation?.metadata?.packageHandoff;
  if (!envelope || envelope.schema !== 1 || !envelope.binding
    || packageBindingDigest(envelope.binding) !== envelope.sha256
    || envelope.binding.operationId !== operation.operationId || operation.kind !== "restart") {
    throw new Error("Restart has no exact admitted package binding");
  }
  return envelope.binding;
}

export function packageRestartInput(input) {
  const keys = ["operationId", "tag", "archive", "descriptor", "installer"];
  if (!input || Object.keys(input).some((key) => !keys.includes(key))
    || keys.some((key) => typeof input[key] !== "string" || !input[key])) {
    throw new Error("Package restart requires only its exact original and public asset paths");
  }
  return { operationId: input.operationId, tag: input.tag,
    archive: path.resolve(input.archive), descriptor: path.resolve(input.descriptor), installer: path.resolve(input.installer) };
}

export async function preparePackageRestart(input, { dataDir, environment = process.env } = {}) {
  input = packageRestartInput(input);
  if (process.platform !== "win32" || !environment.AGENT_HUB_RUNTIME_ROOT
    || !environment.AGENT_HUB_HOST_PID) throw new Error("Installed package handoff Host is unavailable");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input?.operationId ?? "")) {
    throw new Error("Package restart requires its original operationId");
  }
  const target = await verifyPublicPackageTarget(input);
  const current = await capturePackageRuntime(environment.AGENT_HUB_RUNTIME_ROOT, dataDir,
    { hostPid: Number(environment.AGENT_HUB_HOST_PID) });
  if (current.old.releaseId === target.releaseId) throw new Error("Target is already the running release");
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-package-"));
  await protectRuntimeDirectory(scratchRoot);
  const hostCopy = path.join(scratchRoot, "AgentHub.RuntimeHost.exe");
  await copyFile(current.old.launcher.file, hostCopy, constants.COPYFILE_EXCL);
  if ((await packageFile(hostCopy)).sha256 !== current.old.launcher.sha256) {
    throw new Error("Copied handoff Host differs from the admitted current Host");
  }
  const binding = { operationId: input.operationId, ...current, target, scratchRoot, hostCopy };
  return { schema: 1, binding, sha256: packageBindingDigest(binding) };
}

export async function packageCheckpoint(store, operationId, phase, metadata = {}) {
  return store.runRestartMutation(() => {
    const current = store.getReadonly(operationId);
    packageHandoffBinding(current);
    if (terminal(current)) throw new Error("Package restart is already terminal");
    return store.transition(operationId, { phase, metadata }, { expectedRevision: current.revision }).operation;
  }, { requestId: operationId });
}

export async function assertOldPackageCurrent(binding, { requireInstance = false } = {}) {
  const root = binding.runtimeRoot;
  if (await realpath(root) !== root
    || packageDigest(await readFile(path.join(root, "current.json"))) !== binding.old.currentSha256
    || packageDigest(await readFile(path.join(root, "releases", binding.old.releaseId,
      "runtime-manifest.json"))) !== binding.old.manifestSha256) {
    throw new Error("Admitted old runtime identity changed");
  }
  if (requireInstance) {
    const lock = JSON.parse(await readFile(path.join(binding.dataDir, "bot.lock"), "utf8"));
    if (lock.pid !== binding.old.pid || lock.releaseId !== binding.old.releaseId
      || packageDigest(lock.instanceToken ?? "") !== binding.old.instanceSha256) {
      throw new Error("Admitted old instance changed");
    }
  }
}

export async function armPackageRestart({ request, store, spawnImpl = spawn,
  ownershipTimeoutMs = 120_000, now = Date.now, wait = delay } = {}) {
  const binding = packageHandoffBinding(request);
  await assertOldPackageCurrent(binding, { requireInstance: true });
  await assertPackageFiles(binding.target);
  if ((await packageFile(binding.hostCopy)).sha256 !== binding.old.launcher.sha256) {
    throw new Error("Admitted handoff Host changed");
  }
  const original = store.getReadonly(request.operationId);
  packageHandoffBinding(original);
  if (original.metadata.packageNative || original.phase === "package-arming") {
    throw new Error("Original Host admission requires readback, not another launch");
  }
  await packageCheckpoint(store, request.operationId, "package-arming");
  const child = spawnImpl(binding.hostCopy, ["--package-handoff", binding.runtimeRoot,
    binding.old.releaseId, request.operationId, String(binding.old.pid), String(binding.old.hostPid)], {
    cwd: binding.scratchRoot, detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, AGENT_HUB_RESTART_OPERATION_ID: request.operationId },
  });
  let failure;
  child.once("error", (error) => { failure = error; });
   // The addressed bridge exits after native creation of the externally
   // parented continuation. Only its durable exact arm proves admission.
   child.once("exit", (code) => { if (code !== 0) failure = new Error(`Handoff Host exited (${code})`); });
  child.unref();
  const deadline = now() + ownershipTimeoutMs;
  while (now() < deadline) {
    const current = store.getReadonly(request.operationId);
    const actual = packageHandoffBinding(current);
    if (packageBindingDigest(actual) !== packageBindingDigest(binding)) throw new Error("Package intent drift");
    const native = current.metadata.packageNative;
    if (native && native.launcherPid === child.pid && native.oldNodePid === binding.old.pid
      && native.oldHostPid === binding.old.hostPid && current.phase === "package-armed") return native;
    if (failure) throw failure;
    await wait(100);
  }
  throw new Error("Handoff Host admission is unknown; original identity must be reconciled");
}

function nativeContext(binding, environment) {
  if (process.platform !== "win32" || Number(environment.AGENT_HUB_PACKAGE_HOST_PID) !== process.ppid
    || Number(environment.AGENT_HUB_PACKAGE_OLD_NODE_PID) !== binding.old.pid
    || Number(environment.AGENT_HUB_PACKAGE_OLD_HOST_PID) !== binding.old.hostPid
     || !/^\d+$/u.test(environment.AGENT_HUB_PACKAGE_LAUNCHER_PID ?? "")
     || !/^\d+$/u.test(environment.AGENT_HUB_PACKAGE_HOST_STARTED ?? "")
    || !/^\d+$/u.test(environment.AGENT_HUB_PACKAGE_OLD_NODE_STARTED ?? "")
    || !/^\d+$/u.test(environment.AGENT_HUB_PACKAGE_OLD_HOST_STARTED ?? "")) {
    throw new Error("Package continuation requires its exact native Host parent");
  }
  return { hostPid: process.ppid, launcherPid: Number(environment.AGENT_HUB_PACKAGE_LAUNCHER_PID),
    oldNodePid: binding.old.pid, oldHostPid: binding.old.hostPid,
    hostStarted: environment.AGENT_HUB_PACKAGE_HOST_STARTED,
    oldNodeStarted: environment.AGENT_HUB_PACKAGE_OLD_NODE_STARTED,
    oldHostStarted: environment.AGENT_HUB_PACKAGE_OLD_HOST_STARTED };
}

export async function verifyInstalledPackage(binding) {
  const target = binding.target;
  const pointer = JSON.parse(await readFile(path.join(binding.runtimeRoot, "current.json"), "utf8"));
  if (pointer.current !== target.releaseId) throw new Error("Installer did not retain the exact admitted target");
  const releaseRoot = path.join(binding.runtimeRoot, "releases", target.releaseId);
  await verifyRuntimeManifest(releaseRoot, target.releaseId);
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, "runtime-manifest.json"), "utf8"));
  if (manifest.publicationRevision !== target.sourceCommit || manifest.releaseVersion !== target.version) {
    throw new Error("Installed target source or artifact identity differs");
  }
  const host = await packageFile(path.join(binding.runtimeRoot, "AgentHub.RuntimeHost.exe"));
  const declared = manifest.files.find((entry) => entry.path === "AgentHub.RuntimeHost.exe");
  if (!declared || host.sha256 !== declared.sha256 || host.bytes !== declared.bytes) {
    throw new Error("Installed stable Host differs from the exact target");
  }
}

// Effect ports default to the existing installer, Host and ready owners. Tests
// can replace these ports, not the durable original's eligibility/state machine.
export async function continuePackageRestart({ store, operationId, assertRetired,
  install = async (binding) => execute("python", [binding.target.installer.file,
    "--archive", binding.target.archive.file, "--sha256", binding.target.archive.sha256,
    "--runtime-root", binding.runtimeRoot, "--scratch-root", binding.scratchRoot],
  { cwd: binding.scratchRoot, windowsHide: true, maxBuffer: 1024 * 1024 }),
  backup = backupStoppedRuntime, verifyInstalled = verifyInstalledPackage,
  launch = async (binding) => {
    const invocation = directWindowsLauncherInvocation({ launcher: path.join(binding.runtimeRoot,
      "AgentHub.RuntimeHost.exe"), environment: { ...process.env,
      AGENT_HUB_RESTART_OPERATION_ID: binding.operationId } });
    const child = spawn(invocation.command, invocation.args, invocation.options);
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { pid: child.pid };
  },
  ready = async (binding) => {
    const lock = await waitForReplacementLock({ lockFile: path.join(binding.dataDir, "bot.lock"),
      currentPid: binding.old.pid, expectedReleaseId: binding.target.releaseId,
      expectedOperationId: operationId, timeoutMs: 120_000 });
    if (!lock) throw new Error("Exact package replacement readiness is unknown");
    await waitForRuntimeReplacement({ runtimeRoot: binding.runtimeRoot,
      expectedReleaseId: binding.target.releaseId });
    return { pid: lock.pid, instanceSha256: packageDigest(lock.instanceToken) };
  }, validateFiles = assertPackageFiles, validateOld = assertOldPackageCurrent } = {}) {
  const current = store.getReadonly(operationId);
  const binding = packageHandoffBinding(current);
  if (current.phase !== "package-writers-closed" || terminal(current)) {
    // A lost install/start reply is read back, never submitted again here.
    return { status: "reconciliation-required", operationId, phase: current.phase };
  }
  try {
  await assertRetired();
  await validateOld(binding);
  await validateFiles(binding.target);
  await packageCheckpoint(store, operationId, "package-backup");
  const snapshot = await backup({ runtimeRoot: binding.runtimeRoot,
    destination: path.join(binding.scratchRoot, "backup"), assertStopped: assertRetired });
  await packageCheckpoint(store, operationId, "package-installing", { packageBackup: snapshot });
  await assertRetired();
  await validateOld(binding);
  await validateFiles(binding.target);
  await install(binding); // Unchanged public installer repeats stopped/upgrade checks.
  await verifyInstalled(binding);
  await packageCheckpoint(store, operationId, "package-launching", {
    expectedReleaseId: binding.target.releaseId, oldPid: binding.old.pid,
  });
  await assertRetired();
  const replacement = await launch(binding);
  const observed = await ready(binding, replacement);
  const completed = store.getReadonly(operationId);
  if (completed.status !== "succeeded" || packageBindingDigest(packageHandoffBinding(completed))
    !== packageBindingDigest(binding)) throw new Error("Replacement did not settle the original restart");
  return { status: "replaced", operationId, releaseId: binding.target.releaseId, ...observed };
  } catch (error) {
    await store.runRestartMutation(() => {
      const latest = store.getReadonly(operationId);
      if (!terminal(latest)) store.transition(operationId, {
        status: "reconciling", phase: "package-reconciling", outcome: "unknown",
        metadata: { packageFailurePhase: latest.phase },
      }, { expectedRevision: latest.revision });
    }, { requestId: operationId });
    throw error;
  }
}

export async function packageHostMain(args, environment = process.env) {
  if (args.length === 3 && args[0] === "read") {
    const root = await realpath(args[1]);
    const store = new MaintenanceOperationStore({ dataDir: path.join(root, "data") });
    const operation = store.getReadonly(args[2]);
    const binding = packageHandoffBinding(operation);
    if (root !== binding.runtimeRoot) throw new Error("Original package root mismatch");
    const pointer = JSON.parse(await readFile(path.join(root, "current.json"), "utf8"));
    return { operationId: operation.operationId, status: operation.status, phase: operation.phase,
      outcome: operation.outcome, expectedReleaseId: binding.target.releaseId,
      currentReleaseId: pointer.current, effectsReplayed: false };
  }
  if (args.length === 2 && args[0] === "probe") {
    const root = await realpath(args[1]);
    const exists = await access(path.join(root, "data", "runtime.sqlite")).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) return { status: "no-original" };
    const store = new MaintenanceOperationStore({ dataDir: path.join(root, "data") });
    const current = store.activeForReadonly({ kind: "restart", ...RUNTIME_RESTART_SCOPE });
    if (!current?.metadata?.packageHandoff) return { status: "no-package-original" };
    const binding = packageHandoffBinding(current);
    if (current.phase !== "package-launching" || current.metadata.packageLaunchAdmission
      || environment.AGENT_HUB_RESTART_OPERATION_ID !== current.operationId
      || packageDigest(environment.AGENT_HUB_PACKAGE_LAUNCH_TOKEN ?? "") !== current.metadata.packageLaunchSha256
      || Number(environment.AGENT_HUB_PACKAGE_BOOTSTRAP_HOST_PID) !== process.ppid) {
      throw new Error("An unresolved package original fences runtime admission");
    }
    await verifyInstalledPackage(binding);
    await packageCheckpoint(store, current.operationId, "package-launching", {
      packageLaunchAdmission: { hostPid: process.ppid,
        hostStarted: environment.AGENT_HUB_PACKAGE_BOOTSTRAP_HOST_STARTED },
    });
    return { status: "admitted-original", operationId: current.operationId };
  }
  const [stage, root, operationId] = args;
  if (args.length !== 3 || !["arm", "continue"].includes(stage)) throw new Error("Unknown package Host stage");
  const store = new MaintenanceOperationStore({ dataDir: path.join(await realpath(root), "data") });
  const current = store.getReadonly(operationId), binding = packageHandoffBinding(current);
  if (binding.runtimeRoot !== await realpath(root)) throw new Error("Package Host root changed");
  const native = nativeContext(binding, environment);
  if (stage === "arm") {
    if (current.phase !== "package-arming") throw new Error("Package Host is not awaiting admission");
    await assertOldPackageCurrent(binding, { requireInstance: true });
    await packageCheckpoint(store, operationId, "package-armed", { packageNative: native });
    return { status: "armed", operationId };
  }
  if (JSON.stringify(current.metadata.packageNative) !== JSON.stringify(native)
    || environment.AGENT_HUB_PACKAGE_COHORT_RETIRED !== "1") throw new Error("Old cohort retirement is not proven");
  const assertRetired = async () => {
    // Native Host holds the launch gate and the original job handle throughout
    // this child. Only that parent can supply the retirement proof.
    if (process.ppid !== native.hostPid) throw new Error("Native handoff parent changed");
    const lock = await readFile(path.join(binding.dataDir, "bot.lock"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (lock !== null) throw new Error("A runtime instance still owns the stopped boundary");
  };
  return continuePackageRestart({ store, operationId, assertRetired, launch: async (actual) => {
    // The native parent releases its root gate only after the installer and the
    // durable ONE launch intent. No old process signal/console injection occurs.
    const launchToken = randomBytes(32).toString("hex");
    await packageCheckpoint(store, operationId, "package-launching", {
      packageLaunchSha256: packageDigest(launchToken),
    });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const acknowledgement = new Promise((resolve, reject) => {
      lines.once("line", (line) => line === "AGENT_HUB_PACKAGE_GATE_RELEASED" ? resolve() : reject(new Error("Invalid native launch acknowledgement")));
      lines.once("close", () => reject(new Error("Native launch admission is unknown")));
    });
    process.stdout.write("AGENT_HUB_PACKAGE_LAUNCH\n");
    try { await acknowledgement; } finally { lines.close(); }
    await verifyInstalledPackage(actual);
    const invocation = directWindowsLauncherInvocation({ launcher: path.join(actual.runtimeRoot,
      "AgentHub.RuntimeHost.exe"), environment: { ...process.env,
      AGENT_HUB_RESTART_OPERATION_ID: operationId, AGENT_HUB_PACKAGE_LAUNCH_TOKEN: launchToken } });
    const child = spawn(invocation.command, invocation.args, invocation.options);
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { pid: child.pid };
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packageHostMain(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
