import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { releaseIdentitySha256 } from "../../domain/release-operation.mjs";
import { PUBLIC_RUNTIME_INSTALLATION, publicRuntimeInstallationAuthorization } from "../../domain/public-runtime-installation.mjs";
import { artifactVersionIdentity } from "../../domain/agent-hub-version.mjs";
import { runtimeManifestMatchesPackage } from "../../domain/runtime-package-identity.mjs";
import { MaintenanceOperationStore } from "../persistence/maintenance-operation-store.mjs";
import { PUBLIC_INSTALLER_HANDOFF } from "../persistence/publication-checkpoint.mjs";
import { packageBindingDigest, packageDirectory, packageFile, verifyPublicPackageTarget } from "../filesystem/runtime-package-target.mjs";
import { withRuntimeInstallationLease } from "../filesystem/runtime-installation-custody.mjs";
import { verifyRuntimeManifest } from "../filesystem/runtime-manifest-verifier.mjs";
import { loadProjects } from "../filesystem/config.mjs";
import { publicationRuntimeStatus, startInstalledPublicationRuntime } from "../../runtime/runtime-publication-start.mjs";
import { waitForRuntimeReplacement } from "../../runtime/publication-readiness.mjs";
import { clearInheritedPublicationOwnership, publicationLockOwned } from "./publication-lock.mjs";

const json = async file => JSON.parse(await readFile(file, "utf8"));

export function releaseTargetExecutionRoot(dataDir, operation, generation, target) {
  // Preserve the existing publication runner namespace, including old originals.
  const identity = createHash("sha256").update(`${operation.operationId}:${generation.generation}:${target.targetId}`).digest("hex");
  return path.join(dataDir, "release-operation-executions", identity);
}

export function publicRuntimeInstallerBinding({ operation, generation, target }) {
  if (operation.authorization?.runtimeInstallation !== PUBLIC_RUNTIME_INSTALLATION
    || target.kind !== "agent-hub-publication" || target.environment === "github-release") return null;
  publicRuntimeInstallationAuthorization(operation.authorization.approvedTargets);
  return { operationId: operation.operationId, generation: generation.generation,
    candidate: generation.identitySha256, targetId: target.targetId };
}

function candidateFor(generation, target) {
  const matches = generation.candidates.filter(candidate => path.resolve(candidate.repositoryRoot) === path.resolve(target.repositoryRoot));
  if (matches.length !== 1) throw new Error("Public installer requires its unique frozen repository");
  return matches[0];
}

function frozenInput(operation, generation, candidate) {
  const publication = candidate.manifest?.publication;
  if (generation.operationId !== operation.operationId || publication?.head !== candidate.commit
    || artifactVersionIdentity(publication?.runtimeReleaseVersion).publicVersion !== publication?.releaseVersion) {
    throw new Error("Public installer frozen generation binding changed");
  }
  return { operationId: operation.operationId, generation: generation.generation,
    sourceCommit: candidate.commit, version: publication.runtimeReleaseVersion };
}

// This reader consumes the existing public target result and PACKAGED namespace.
// It never invokes a packager, allocates a runtime or publishes a GitHub effect.
export async function readPublishedRuntimePackage({ operation, generation, target, dataDir, tool,
  prepared, api, verifyPublicTarget = verifyPublicPackageTarget }) {
  const candidate = candidateFor(generation, target);
  const frozen = frozenInput(operation, generation, candidate);
  const publicTarget = operation.authorization.approvedTargets.find(item => item.targetId === "agent-hub-github-release");
  const effect = operation.publicationEffects?.targets?.[publicTarget?.targetId];
  if (operation.publicationEffects?.generation !== generation.generation
    || effect?.status !== "applied" || effect.operationId !== operation.operationId
    || effect.generation !== generation.generation || effect.targetId !== publicTarget.targetId
    || effect.candidate !== generation.identitySha256 || effect.revision !== candidate.commit
    || effect.deploymentProfile !== "github-release" || !isDeepStrictEqual(effect.tool, tool)) {
    throw new Error("Public installer requires its already applied exact public target");
  }
  const root = releaseTargetExecutionRoot(dataDir, operation, generation, publicTarget);
  const [result, journal] = await Promise.all([json(path.join(root, "result.json")), json(path.join(root, "publication-status.json"))]);
  if (!isDeepStrictEqual(result, effect) || journal.identity?.revision !== candidate.commit
    || !isDeepStrictEqual(journal.progress?.githubDistribution?.result, effect.distribution)
    || journal.progress?.githubDistribution?.status !== "applied") throw new Error("Public target receipt changed");
  const namespace = path.join(root, "distribution", frozen.version);
  const packaged = await json(path.join(namespace, "result.json"));
  const publicVersion = artifactVersionIdentity(frozen.version).publicVersion;
  const assetNames = ["AgentHub-win32-x64.zip", "AgentHub-win32-x64.zip.json", "install_release.py", "SHA256SUMS"];
  if (packaged.phase !== "PACKAGED" || packaged.inputIdentity !== effect.distribution?.inputIdentity
    || Object.entries(frozen).some(([key, value]) => packaged.inputs?.[key] !== value)
    || packaged.inputs?.preparedReceiptSha256 !== prepared.receiptSha256
    || packaged.inputs?.preparedManifestSha256 !== prepared.receipt.manifestSha256
    || !isDeepStrictEqual(packaged.inputs?.tool, tool) || !isDeepStrictEqual(packaged.assets, effect.distribution?.assets)
    || packaged.inputs?.publicVersion !== publicVersion
    || !Array.isArray(packaged.assets) || packaged.assets.length !== assetNames.length
    || assetNames.some((name, index) => packaged.assets[index]?.name !== name)) throw new Error("Public package differs from its frozen PREPARED input");
  const assets = path.join(namespace, "assets");
  const input = { tag: publicVersion, archive: path.join(assets, "AgentHub-win32-x64.zip"),
    descriptor: path.join(assets, "AgentHub-win32-x64.zip.json"), installer: path.join(assets, "install_release.py") };
  const packageTarget = await verifyPublicTarget(input, { readMetadata: async tag => {
    const repository = "/repos/IIITYRAELIII/AgentHub";
    const [metadata, ref, actualRepository] = await Promise.all([api("GET", `${repository}/releases/tags/${tag}`),
      api("GET", `${repository}/git/ref/tags/${tag}`), api("GET", repository)]);
    if (actualRepository.id !== 1428402643 || actualRepository.owner?.id !== 95281881 || actualRepository.private !== false) {
      throw new Error("Public installer canonical repository changed");
    }
    if (metadata.id !== effect.distribution.releaseId || ref.object?.type !== "commit" || ref.object.sha !== candidate.commit) {
      throw new Error("Published tag or release changed before public installation");
    }
    if (metadata.assets?.length !== assetNames.length || assetNames.some(name => {
      const rows = metadata.assets.filter(row => row.name === name);
      const expected = packaged.assets.find(row => row.name === name);
      return rows.length !== 1 || rows[0].state !== "uploaded" || rows[0].digest !== `sha256:${expected.sha256}`
        || rows[0].size !== expected.bytes;
    })) throw new Error("Public package asset set changed");
    return metadata;
  } });
  const sums = await packageFile(path.join(assets, "SHA256SUMS"));
  if (sums.bytes !== packaged.assets[3].bytes || sums.sha256 !== packaged.assets[3].sha256) throw new Error("Public package checksum asset changed");
  if (packageTarget.sourceCommit !== candidate.commit || packageTarget.version !== frozen.version
    || packageTarget.releaseId !== prepared.receipt.releaseId) throw new Error("Public package source or version differs");
  return { inputIdentity: packaged.inputIdentity, target: packageTarget, prepared: structuredClone(prepared) };
}

function inside(root, child) {
  const relative = path.relative(root, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function intentIdentity(saved) {
  const { owner, input, runtime, scratch, installer, mode, oldCurrent, config, firstProject } = saved;
  return releaseIdentitySha256({ owner, input, runtime, scratch, installer, mode, oldCurrent, config, firstProject });
}

async function configurationSelection(runtimeRoot, defaultProject) {
  const file = path.join(runtimeRoot, "config.json");
  const raw = await json(file);
  loadProjects(raw, path.resolve(raw.projectRoot || defaultProject));
  return packageFile(file);
}

async function installedManifest(runtimeRoot, input) {
  const releaseRoot = path.join(runtimeRoot, "releases", input.target.releaseId);
  await verifyRuntimeManifest(releaseRoot, input.target.releaseId);
  const [preparedRaw, installedRaw] = await Promise.all([
    readFile(path.join(input.prepared.receipt.releaseRoot, "runtime-manifest.json")),
    readFile(path.join(releaseRoot, "runtime-manifest.json")),
  ]);
  if (createHash("sha256").update(preparedRaw).digest("hex") !== input.prepared.receipt.manifestSha256
    || !runtimeManifestMatchesPackage(preparedRaw, installedRaw)) throw new Error("Public installed whole manifest differs from PREPARED");
  const manifest = JSON.parse(installedRaw);
  if (manifest.publicationRevision !== input.target.sourceCommit || manifest.releaseVersion !== input.target.version) {
    throw new Error("Public installed source or version differs");
  }
  const host = await packageFile(path.join(runtimeRoot, "AgentHub.RuntimeHost.exe"));
  const declared = manifest.files.find(entry => entry.path === "AgentHub.RuntimeHost.exe");
  if (host.sha256 !== declared?.sha256 || host.bytes !== declared?.bytes) throw new Error("Public installed Host differs");
}

export function createPublicRuntimeInstaller({ operation, generation, target, runtimeRoot, journal, tool,
  readPublishedInput, readStatus = publicationRuntimeStatus,
  readMaintenance = id => new MaintenanceOperationStore({ dataDir: path.join(runtimeRoot, "data") }).getReadonly(id),
  verifyInstalled = installedManifest, verifyReady = waitForRuntimeReplacement,
  startRuntime = startInstalledPublicationRuntime,
  withInstallationLease = withRuntimeInstallationLease, spawnImpl = spawn,
  environment = process.env, assertOutsidePublicationLock = () => {
    if (publicationLockOwned({ environment })) throw new Error("Public installer must launch after releasing the publication lock");
  }, now = () => new Date().toISOString(),
} = {}) {
  const binding = publicRuntimeInstallerBinding({ operation, generation, target });
  if (!binding) throw new Error("Public installer policy is absent from this original authorization");
  const candidate = candidateFor(generation, target);
  const frozen = frozenInput(operation, generation, candidate);
  const operationId = `release-package-${releaseIdentitySha256(binding)}`;
  const owner = { binding, frozen, tool, runtimeRoot: path.resolve(runtimeRoot), operationId };
  const pending = () => ({ kind: PUBLIC_INSTALLER_HANDOFF, status: "waiting", binding: structuredClone(binding) });
  const read = async () => {
    const saved = (await journal.read())?.progress?.publicRuntimeInstaller;
    if (saved && (!isDeepStrictEqual(saved.owner, owner) || saved.seal !== intentIdentity(saved)
      || !["restart", "stopped"].includes(saved.mode)
      || !["scratch_prepared", "prepared", "dispatch_intent", "cli_joined", "cold_start_intent", "cold_started"].includes(saved.phase)
      || saved.phase !== "scratch_prepared" && !saved.installer)) {
      throw new Error("Original public installer intent changed");
    }
    return saved ?? null;
  };
  const save = value => journal.updateProgress({ publicRuntimeInstaller: value });
  const assertInput = async (saved, { beforeLaunch = false } = {}) => {
    if (beforeLaunch && saved.config
      && !isDeepStrictEqual(await configurationSelection(runtimeRoot, candidate.repositoryRoot), saved.config)) {
      throw new Error("Existing configuration changed before public installer admission");
    }
    const actual = await readPublishedInput();
    if (!isDeepStrictEqual(actual, saved.input)) throw new Error("Original public installer package changed");
    if (!isDeepStrictEqual(await packageDirectory(runtimeRoot), saved.runtime)
      || !isDeepStrictEqual(await packageDirectory(saved.scratch.directory), saved.scratch)
      || saved.installer && !isDeepStrictEqual(await packageFile(saved.installer.file), saved.installer)) {
      throw new Error("Original public installer physical custody changed");
    }
    return actual;
  };
  async function readback() {
    const saved = await read();
    if (!saved) return { status: "partial", cursor: { reason: "public-installer-required" } };
    if (["scratch_prepared", "prepared"].includes(saved.phase)) return {
      status: "partial", cursor: { reason: saved.phase === "prepared" ? "public-installer-prepared" : "public-installer-preparing" },
    };
    const input = saved.input;
    if (saved.mode === "restart") {
      let original;
      try { original = await readMaintenance(operationId); } catch {
        return { status: "unknown", cursor: { reason: "public-installer-original-unreadable", operationId } };
      }
      if (!original) return { status: "unknown", cursor: { reason: "public-installer-original-missing", operationId } };
      const handoff = original.metadata?.packageHandoff;
      if (original.operationId !== operationId || original.kind !== "restart" || handoff?.schema !== 1
        || handoff.sha256 !== packageBindingDigest(handoff.binding)) throw new Error("Public installer maintenance original differs");
      const admitted = handoff?.binding;
      if (!admitted || admitted.operationId !== operationId || admitted.runtimeRoot !== saved.runtime.directory
        || admitted.dataDir !== path.join(saved.runtime.directory, "data") || !isDeepStrictEqual(admitted.roots?.runtime, saved.runtime)
        || admitted.old?.releaseId !== saved.oldCurrent || admitted.target?.releaseId !== input.target.releaseId
        || admitted.target?.sourceCommit !== frozen.sourceCommit || admitted.target?.version !== frozen.version
        || admitted.target?.tag !== input.target.tag || admitted.target?.repository !== input.target.repository
        || admitted.target?.packageManifestSha256 !== input.target.packageManifestSha256
        || ["archive", "descriptor", "installer"].some(key => admitted.target?.[key]?.sha256 !== input.target[key]?.sha256
          || admitted.target?.[key]?.bytes !== input.target[key]?.bytes)) throw new Error("Public installer maintenance binding changed");
      if (original.status !== "succeeded" || original.outcome !== "succeeded") return {
        status: original.status === "failed" || original.outcome === "unknown" ? "unknown" : "partial",
        cursor: { reason: "public-installer-maintenance", operationId, phase: original.phase, outcome: original.outcome,
          consumerActive: ["requested", "blocked", "running"].includes(original.status) },
      };
    } else if (saved.mode !== "stopped" || !["cold_start_intent", "cold_started"].includes(saved.phase) || saved.exitCode !== 0) {
      return { status: "unknown", cursor: { reason: "public-installer-child-unsettled", operationId } };
    }
    await assertInput(saved);
    let status;
    try { status = await readStatus({ runtimeRoot }); } catch {
      return { status: "unknown", cursor: { reason: "public-installer-runtime-unreadable", operationId } };
    }
    if (status.current !== input.target.releaseId) return {
      status: "unknown", cursor: { reason: "public-installer-current-drift", operationId },
    };
    try { await verifyInstalled(runtimeRoot, input); } catch {
      return { status: "unknown", cursor: { reason: "public-installer-installed-payload", operationId } };
    }
    try { await verifyReady({ runtimeRoot, expectedReleaseId: input.target.releaseId, timeoutMs: 1000 }); } catch {
      return { status: "partial", cursor: { reason: "public-installer-readiness", consumerActive: true, operationId } };
    }
    return { status: "ready", operationId, binding, inputIdentity: input.inputIdentity,
      releaseId: input.target.releaseId, sourceCommit: frozen.sourceCommit, version: frozen.version };
  }
  async function startColdRuntime() {
    const saved = await read();
    if (saved.mode !== "stopped" || saved.phase !== "cli_joined" || saved.exitCode !== 0) return;
    const input = await assertInput(saved);
    await verifyInstalled(runtimeRoot, input);
    await configurationSelection(runtimeRoot, candidate.repositoryRoot);
    const intent = { ...saved, phase: "cold_start_intent", startIntentAt: now() };
    await save(intent);
    await startRuntime({ runtimeRoot, expectedReleaseId: input.target.releaseId });
    await save({ ...intent, phase: "cold_started", startedAt: now() });
  }
  async function completePreparation(saved) {
    await assertInput(saved, { beforeLaunch: true });
    const installerFile = path.join(saved.scratch.directory, "install_release.py");
    let installer;
    try { installer = await packageFile(installerFile); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(saved.input.target.installer.file, installerFile, constants.COPYFILE_EXCL);
      installer = await packageFile(installerFile);
    }
    if (installer.sha256 !== saved.input.target.installer.sha256 || installer.bytes !== saved.input.target.installer.bytes) {
      throw new Error("Retained public installer copy changed");
    }
    const prepared = { ...saved, installer, phase: "prepared" };
    await save({ ...prepared, seal: intentIdentity(prepared) });
    return pending();
  }
  return {
    binding,
    readback,
    verify: async () => (await readback()).status === "ready",
    async prepare() {
      const previous = await read();
      if (previous) {
        if (previous.phase === "scratch_prepared") return completePreparation(previous);
        await assertInput(previous);
        return pending();
      }
      const input = await readPublishedInput();
      const runtime = await packageDirectory(runtimeRoot);
      const status = await readStatus({ runtimeRoot });
      if (status.running !== false && !(status.running === true && status.ready === true)) throw new Error("Old runtime readiness is unknown");
      let config = null;
      try { config = await configurationSelection(runtimeRoot, candidate.repositoryRoot); } catch (error) {
        if (error.code !== "ENOENT" || status.current !== null) throw error;
      }
      const scratchRoot = await mkdtemp(path.join(path.dirname(runtime.directory), ".agent-hub-public-installer-"));
      const scratch = await packageDirectory(scratchRoot);
      if (inside(runtime.directory, scratch.directory) || inside(scratch.directory, runtime.directory)) throw new Error("Public installer scratch must be outside runtime");
      const intent = { owner, input, runtime, scratch, installer: null,
        config, firstProject: config ? null : path.resolve(candidate.repositoryRoot),
        mode: status.running ? "restart" : "stopped", oldCurrent: status.current,
        phase: "scratch_prepared", preparedAt: now() };
      const saved = { ...intent, seal: intentIdentity(intent) };
      await save(saved);
      return completePreparation(saved);
    },
    async dispatch() {
      assertOutsidePublicationLock();
      let child, completion;
      try {
        await withInstallationLease(runtimeRoot, async lease => {
          const saved = await read();
          if (!saved) throw new Error("Public installer has no original prepared handoff");
          if (saved.phase !== "prepared") return;
          await assertInput(saved);
          const status = await readStatus({ runtimeRoot });
          if (status.current !== saved.oldCurrent || saved.mode === "restart" && (!status.running || !status.ready)
            || saved.mode === "stopped" && status.running !== false) throw new Error("Old runtime changed before public installer admission");
          await mkdir(path.join(saved.scratch.directory, "transport"), { recursive: true });
          await save({ ...saved, phase: "dispatch_intent", dispatchedAt: now() });
          await lease.assertOwned();
          await assertInput(saved, { beforeLaunch: true });
          const childEnvironment = clearInheritedPublicationOwnership({ ...environment, PYTHONUTF8: "1" });
          delete childEnvironment.AGENT_HUB_RESTART_OPERATION_ID;
          delete childEnvironment.AGENT_HUB_RESTART_LAUNCHER_PID;
          delete childEnvironment.AGENT_HUB_PACKAGE_LAUNCHER_PID;
          delete childEnvironment.AGENT_HUB_PACKAGE_LAUNCH_TOKEN;
          child = spawnImpl(process.platform === "win32" ? "python.exe" : "python3", ["-B", "-X", "utf8", saved.installer.file,
            "--release", saved.input.target.tag, "--sha256", saved.input.target.archive.sha256,
            "--runtime-root", owner.runtimeRoot, "--scratch-root", path.join(saved.scratch.directory, "transport"),
            ...(saved.mode === "restart" ? ["--prepare-update", "--operation-id", operationId] : []),
            ...(saved.firstProject ? ["--project-root", saved.firstProject] : [])], {
            cwd: saved.scratch.directory, windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
            env: childEnvironment,
          });
          completion = new Promise(resolve => {
            let launchError;
            child.once("error", error => { launchError = error.message; });
            child.once("close", exitCode => resolve({ exitCode, ...(launchError ? { error: launchError } : {}) }));
          });
        });
      } catch (error) {
        if (completion) await completion;
        throw error;
      }
      // The public installer owns its own installation lease and restart. Neither
      // the outer publication lock nor this parent's installation lease is held.
      if (completion) {
        const outcome = await completion;
        const saved = await read();
        await save({ ...saved, phase: "cli_joined", ...outcome, joinedAt: now() });
      }
      await startColdRuntime();
      return readback();
    },
  };
}
