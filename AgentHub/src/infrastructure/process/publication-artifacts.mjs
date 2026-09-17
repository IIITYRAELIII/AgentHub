import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runtimeLayout, runtimeReleaseDirectory } from "../filesystem/runtime-layout.mjs";
import { verifyRuntimeManifest } from "../filesystem/runtime-manifest-verifier.mjs";

export const PREPARE_PUBLICATION_ARTIFACTS = "Подготовка артефактов публикации";
export const INSTALL_PREPARED_RUNTIME = "Установка runtime-релиза";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const absent = (error) => { if (error.code === "ENOENT") return null; throw error; };
const python = process.platform === "win32" ? "python.exe" : "python3";
const executeFile = promisify(execFile);

// These manifests describe immutable build products. Publication progress and
// effect admission remain in the existing publication journal, not here.
export async function artifactFiles(root) {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push({ path: child, sha256: sha(await readFile(path.join(root, child))) });
      else throw new Error(`Unsupported publication artifact entry: ${child}`);
    }
  }
  await visit("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readArtifact(directory, identity) {
  const manifest = await json(path.join(directory, "artifact.json")).catch(absent);
  if (!manifest) return null;
  if (manifest.version !== 1 || JSON.stringify(manifest.identity) !== JSON.stringify(identity)) {
    throw new Error("Publication artifact identity changed");
  }
  const actual = await artifactFiles(path.join(directory, "payload"));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("Publication artifact bytes changed or are missing");
  return manifest;
}

export async function buildArtifact(directory, identity, build) {
  const saved = await readArtifact(directory, identity);
  if (saved) return saved;
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(path.join(staging, "payload"), { recursive: true });
  try {
    const result = await build(path.join(staging, "payload"), staging);
    const manifest = { version: 1, identity, result, files: await artifactFiles(path.join(staging, "payload")) };
    await writeFile(path.join(staging, "artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(staging, directory);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function createPublicationArtifactSteps({
  sourceRoot, runtimeRoot, journal, run,
  home = os.homedir(),
  capture = async (command, args) => (await executeFile(command, args, {
    cwd: sourceRoot, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", WRANGLER_SEND_METRICS: "false" },
  })).stdout,
  prepareRuntimeImpl,
  installRuntimeImpl,
  verifyRuntimeImpl,
  loadWorker = (file) => import(pathToFileURL(path.join(sourceRoot, "cloudflare-worker", file)).href),
} = {}) {
  const artifactIdentity = (identity) => ({ revision: identity.revision, sourceRoot, runtimeRoot, protocol: 1 });
  // Keep paths short enough for Wrangler's nested Windows temporary files;
  // the complete identity is still checked in every manifest.
  const directory = (identity, component) => path.join(runtimeRoot, "publication-artifacts", sha(JSON.stringify(artifactIdentity(identity))).slice(0, 32), component);
  const payload = (identity, component) => path.join(directory(identity, component), "payload");
  const progress = async () => (await journal?.read?.())?.progress ?? journal?.progress ?? {};
  const read = async (identity, component) => {
    const artifact = await readArtifact(directory(identity, component), artifactIdentity(identity));
    const pinned = (await progress()).artifactHashes?.[component];
    if (pinned && (!artifact || sha(JSON.stringify(artifact)) !== pinned)) throw new Error(`Pinned ${component} artifact changed or is missing`);
    return artifact;
  };
  const ensure = async (identity, component, build) => {
    await read(identity, component);
    const artifact = await buildArtifact(directory(identity, component), artifactIdentity(identity), build);
    const prior = await progress();
    await journal.updateProgress({ artifactHashes: { ...prior.artifactHashes, [component]: sha(JSON.stringify(artifact)) } });
    return artifact;
  };
  const wrangler = path.join(sourceRoot, "wrangler-runner.mjs");
  const execute = (step) => run({ ...step, logFile: journal?.logFile ?? "" });
  const wranglerRun = (args, label) => execute({ label, command: process.execPath, args: [wrangler, ...args], cwd: sourceRoot });

  async function workerConfig(identity) {
    const artifact = await read(identity, "worker");
    if (!artifact) throw new Error("Prepared Worker artifact is missing");
    const root = payload(identity, "worker");
    const config = { ...artifact.result.config, main: path.join(root, "bundle", artifact.result.entry),
      assets: { ...artifact.result.config.assets, directory: path.join(root, "public") } };
    // Operational config is outside the immutable payload; it only resolves
    // the manifest's relative paths for the pinned CLI.
    const file = path.join(directory(identity, "worker"), "deploy.json");
    await writeFile(file, JSON.stringify(config), "utf8");
    return { file, tag: `hub-${sha(JSON.stringify(artifact)).slice(0, 48)}`, artifact };
  }

  async function workerInstalled(identity) {
    const { file, tag } = await workerConfig(identity);
    const latest = async () => {
      const values = JSON.parse(await capture(process.execPath, [wrangler, "deployments", "list", "--json", "--config", file]));
      if (!Array.isArray(values)) throw new Error("Worker deployment evidence is unavailable");
      return values.toSorted((a, b) => a.created_on.localeCompare(b.created_on)).at(-1);
    };
    const deployed = await latest();
    if (!deployed) return false;
    if (!Array.isArray(deployed.versions)) throw new Error("Worker deployment evidence is unavailable");
    if (deployed.versions.length !== 1 || deployed.versions[0].percentage !== 100) return false;
    const version = JSON.parse(await capture(process.execPath, [wrangler, "versions", "view", deployed.versions[0].version_id, "--json", "--config", file]));
    const confirmed = await latest();
    return JSON.stringify(confirmed) === JSON.stringify(deployed)
      && version.id === deployed.versions[0].version_id && version.annotations?.["workers/tag"] === tag;
  }

  async function runtimeArtifact(identity) {
    const artifact = await read(identity, "runtime");
    if (!artifact) throw new Error("Prepared runtime artifact is missing");
    const releaseId = artifact.result.releaseId;
    const releaseRoot = runtimeReleaseDirectory(runtimeRoot, releaseId);
    if (sha(await readFile(path.join(releaseRoot, "runtime-manifest.json"))) !== artifact.result.manifestHash) {
      throw new Error("Prepared runtime manifest changed");
    }
    await verifyRuntimeManifest(releaseRoot, releaseId);
    return { runtimeRoot, releaseRoot, releaseId };
  }

  async function extensionInstalled(identity) {
    const artifact = await read(identity, "extension");
    if (!artifact) throw new Error("Prepared extension artifact is missing");
    const sourceFiles = (await artifactFiles(path.join(payload(identity, "extension"), "VSCodeExtension")))
      .filter((entry) => !["package.json", "extension-profile.json"].includes(entry.path));
    for (const { profile, package: pkg } of artifact.result.profiles) {
      const target = path.join(home, ".vscode", "extensions", `${pkg.publisher}.${pkg.name}-${pkg.version}`);
      const installed = await json(path.join(target, "package.json")).catch(absent);
      if (!installed || JSON.stringify(installed) !== JSON.stringify(pkg)) return false;
      const files = (await artifactFiles(target)).filter((entry) => !["package.json", "extension-profile.json"].includes(entry.path));
      if (JSON.stringify(files) !== JSON.stringify(sourceFiles)) return false;
      const installedProfile = await json(path.join(target, "extension-profile.json")).catch(absent);
      if (profile === "test-contour" ? installedProfile?.profile !== profile : installedProfile !== null) return false;
    }
    return true;
  }

  async function prepare(identity, steps) {
    const has = (label) => steps.some((step) => step.label === label);
    if (has("Сборка Agent Hub Mobile")) {
      await ensure(identity, "android", async (output) => {
        await execute(steps.find((step) => step.label === "Сборка Agent Hub Mobile"));
        for (const file of ["AgentHub-Mobile.apk", "update.json"]) await cp(path.join(sourceRoot, "assets", "mobile", file), path.join(output, file));
        const manifest = await json(path.join(output, "update.json"));
        const apk = await readFile(path.join(output, "AgentHub-Mobile.apk"));
        if (manifest.sha256 !== sha(apk) || manifest.bytes !== apk.length) throw new Error("Prepared Android APK does not match its update manifest");
        return {};
      });
    }
    const mobileRoot = has("Сборка Agent Hub Mobile") ? payload(identity, "android") : path.join(sourceRoot, "assets", "mobile");
    if (has("Развёртывание Mini App Worker")) {
      await ensure(identity, "worker", async (output, staging) => {
        const { buildWorkerAssets } = await loadWorker("build-assets.mjs");
        await buildWorkerAssets({ output: path.join(output, "public"), mobileRoot });
        const config = await json(path.join(sourceRoot, "cloudflare-worker", "wrangler.jsonc"));
        const buildConfig = path.join(staging, "build.json");
        await writeFile(buildConfig, JSON.stringify({ ...config,
          main: path.resolve(sourceRoot, "cloudflare-worker", config.main),
          assets: { ...config.assets, directory: path.join(output, "public") },
        }), "utf8");
        await wranglerRun(["deploy", "--dry-run", "--config", buildConfig, "--outdir", path.join(output, "bundle")], "Сборка Mini App Worker");
        const entries = (await readdir(path.join(output, "bundle"))).filter((name) => /\.(?:js|mjs)$/.test(name));
        if (entries.length !== 1) throw new Error("Worker build must emit one executable entry");
        return { config, entry: entries[0] };
      });
    }
    if (has("Сборка runtime-релиза")) {
      await ensure(identity, "runtime", async () => {
        const releaseId = `publication-${sha(JSON.stringify(artifactIdentity(identity))).slice(0, 32)}`;
        const releaseRoot = runtimeReleaseDirectory(runtimeRoot, releaseId);
        const existing = await json(path.join(releaseRoot, "runtime-manifest.json")).catch(absent);
        if (existing) {
          if (existing.publicationRevision !== identity.revision || existing.sourceRoot !== path.resolve(sourceRoot)) {
            throw new Error("Existing prepared runtime belongs to another candidate");
          }
          await verifyRuntimeManifest(releaseRoot, releaseId);
        } else await prepareRuntimeImpl({ sourceRoot, runtimeRoot, releaseId, publicationRevision: identity.revision,
          mobileAssetsRoot: has("Сборка Agent Hub Mobile") ? mobileRoot : null });
        return { releaseId, manifestHash: sha(await readFile(path.join(releaseRoot, "runtime-manifest.json"))) };
      });
      await runtimeArtifact(identity);
    }
    if (has("Установка расширения VS Code")) {
      await ensure(identity, "extension", async (output) => {
        await cp(path.join(sourceRoot, "install.py"), path.join(output, "install.py"));
        await cp(path.join(sourceRoot, "VSCodeExtension"), path.join(output, "VSCodeExtension"), {
          recursive: true, filter: (file) => !["node_modules", "__pycache__"].includes(path.basename(file)) && !file.endsWith(".vsix"),
        });
        const config = await json(path.join(runtimeRoot, "config.json")).catch(absent);
        const profiles = ["production", ...(config?.components?.testContour === true ? ["test-contour"] : [])];
        const script = "import runpy,json,sys; m=runpy.run_path(sys.argv[1]); p=json.loads((m['ROOT']/'VSCodeExtension'/'package.json').read_text(encoding='utf-8')); print(json.dumps([{'profile': x, 'package': m['vscode_extension_package'](p,x)} for x in sys.argv[2:]],ensure_ascii=False))";
        const packages = JSON.parse(await capture(python, ["-X", "utf8", "-c", script, path.join(output, "install.py"), ...profiles]));
        for (const { package: pkg } of packages) {
          if (![pkg.publisher, pkg.name, pkg.version].every((value) => typeof value === "string" && /^[\w.-]+$/.test(value) && !value.includes(".."))) {
            throw new Error("Invalid prepared extension identity");
          }
        }
        return { profiles: packages };
      });
    }
  }

  async function runtimeInstallationDigest() {
    const layout = runtimeLayout(runtimeRoot);
    const files = [layout.currentFile, layout.launcherFile, layout.runtimeHostSourceHashFile,
      layout.runtimeHostBinaryHashFile, layout.codexHookLauncherFile];
    return sha(JSON.stringify(await Promise.all(files.map(async (file) => {
      const bytes = await readFile(file).catch(absent);
      return bytes === null ? null : sha(bytes);
    }))));
  }

  async function effect(identity, label, verify, apply, readBaseline = null) {
    if (await verify()) return { reused: true };
    const effects = journal?.progress?.artifactEffects ?? {};
    if (effects[label] && effects[label].status !== "not_applied") throw new Error(`${label}: previous effect is unconfirmed or installed output changed; refusing blind replay`);
    if (effects[label]?.status === "not_applied"
      && (!readBaseline || await readBaseline() !== effects[label].baseline)) {
      throw new Error(`${label}: installation changed after the confirmed rejection`);
    }
    if (!journal?.updateProgress) throw new Error("Artifact publication requires the durable publication journal");
    const baseline = readBaseline ? await readBaseline() : null;
    await journal.updateProgress({ artifactEffects: { ...effects, [label]: { status: "started", baseline } } });
    try {
      await apply();
    } catch (error) {
      // Only the in-process runtime installer can prove terminal no-effect:
      // it has returned, and pointer/stable files exactly match its baseline.
      // An external CLI/remote failure or a process crash retains unknown intent.
      if (readBaseline && await readBaseline() === baseline) {
        await journal.updateProgress({ artifactEffects: { ...effects, [label]: { status: "not_applied", baseline } } });
      }
      throw error;
    }
    if (!await verify()) throw new Error(`${label}: installed artifact is not confirmed`);
    return { reused: false };
  }

  return {
    async steps(steps, identity) {
      const old = await journal?.read?.();
      if (old?.identity?.revision === identity.revision && !old.identity.artifactProtocol
        && !old.progress?.publicationState && old.steps?.some((step) =>
          ["Публикация Git", "Сборка runtime-релиза", "Развёртывание Mini App Worker", "Установка расширения VS Code"].includes(step.label)
          && step.status !== "pending")) {
        throw new Error("Legacy publication already reached deployment; resume with its original executor before migrating artifact protocol");
      }
      identity.artifactProtocol = 1;
      const result = [];
      let inserted = false;
      for (const step of steps) {
        if (!inserted && ["Сборка Agent Hub Mobile", "Сборка runtime-релиза", "Развёртывание Mini App Worker", "Установка расширения VS Code"].includes(step.label)) {
          result.push({ label: PREPARE_PUBLICATION_ARTIFACTS, reusable: false, execute: () => prepare(identity, steps) });
          inserted = true;
        }
        if (step.label === "Сборка Agent Hub Mobile") continue;
        if (step.label === "Сборка runtime-релиза") {
          result.push({ ...step, label: INSTALL_PREPARED_RUNTIME, reusable: false, execute: async () => {
            const artifact = await runtimeArtifact(identity);
            await journal.updateProgress({ expectedReleaseId: artifact.releaseId });
            return effect(identity, INSTALL_PREPARED_RUNTIME, () => verifyRuntimeImpl(artifact), () => installRuntimeImpl(artifact), runtimeInstallationDigest);
          } });
        } else if (step.label === "Развёртывание Mini App Worker") {
          result.push({ ...step, reusable: false, execute: () => effect(identity, step.label,
            () => workerInstalled(identity), async () => {
              const { file, tag } = await workerConfig(identity);
              await wranglerRun(["deploy", "--no-bundle", "--config", file, "--tag", tag], step.label);
            }) });
        } else if (step.label === "Проверка Mini App Worker") {
          result.push({ ...step, verifyReuse: () => workerInstalled(identity), execute: async () => {
            const { verifyWorkerRelease } = await loadWorker("publish-worker.mjs");
            const { verifyThemeDeployment } = await loadWorker("verify-deployment.mjs");
            const { artifact } = await workerConfig(identity);
            await verifyWorkerRelease({
              verify: (options) => verifyThemeDeployment({ ...options, deployedRoot: path.join(payload(identity, "worker"), "public") }),
              readConfig: async () => artifact.result.config,
              changedFiles: identity.files,
            });
          } });
        } else if (step.label === "Установка расширения VS Code") {
          result.push({ ...step, reusable: false, execute: () => effect(identity, step.label,
            () => extensionInstalled(identity), async () => {
              const artifact = await read(identity, "extension");
              for (const { profile } of artifact.result.profiles) {
                await execute({ ...step, command: python, cwd: sourceRoot, args: ["-X", "utf8", "-c",
                  "import runpy,sys; runpy.run_path(sys.argv[1])['install_vscode_extension'](sys.argv[2])",
                  path.join(payload(identity, "extension"), "install.py"), profile] });
              }
            }) });
        } else if (step.label === "Активация runtime-релиза") {
          const verify = async () => {
            const artifact = await runtimeArtifact(identity);
            return (await json(runtimeLayout(runtimeRoot).activationFile).catch(absent))?.release === artifact.releaseId
              && await verifyRuntimeImpl(artifact);
          };
          result.push({ ...step, reusable: false, execute: () => effect(identity, step.label, verify, () => execute(step)) });
        } else result.push(step);
      }
      return result;
    },
    async verify(identity) {
      if (!identity.artifactProtocol) return; // Exact pre-ADR-0062 completion only.
      const required = [
        ["runtime", INSTALL_PREPARED_RUNTIME], ["worker", "Развёртывание Mini App Worker"], ["extension", "Установка расширения VS Code"],
      ].filter(([, label]) => identity.labels.includes(label));
      for (const [component] of required) {
        if (!(await progress()).artifactHashes?.[component] || !await read(identity, component)) throw new Error(`Prepared ${component} evidence is missing`);
      }
      if (required.some(([component]) => component === "runtime")) {
        const artifact = await runtimeArtifact(identity);
        if (!await verifyRuntimeImpl(artifact)) throw new Error("Installed runtime no longer matches the prepared artifact");
        if ((await json(runtimeLayout(runtimeRoot).activationFile).catch(absent))?.release !== artifact.releaseId) throw new Error("Prepared runtime activation is not confirmed");
      }
      if (required.some(([component]) => component === "worker") && !await workerInstalled(identity)) throw new Error("Installed Worker no longer matches the prepared artifact");
      if (required.some(([component]) => component === "extension") && !await extensionInstalled(identity)) throw new Error("Installed extension no longer matches the prepared artifact");
    },
  };
}
