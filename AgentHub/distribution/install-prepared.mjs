import { readFile, mkdir, cp, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installPreparedRuntime, activateRuntime, runtimeStatus } from "./runtime/src/runtime/runtime-manager.mjs";
import { verifyRuntimeManifest } from "./runtime/src/infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { protectRuntimeDirectory, protectRuntimeConfig } from "./runtime/src/infrastructure/filesystem/runtime-security.mjs";
import { withPublicationLock } from "./runtime/src/infrastructure/process/publication-lock.mjs";
import { assertAgentHubUpgrade } from "./runtime/src/domain/agent-hub-version.mjs";
import { runtimeManifestMatchesPackage } from "./runtime/src/domain/runtime-package-identity.mjs";

// Packaged entry: it delegates pointer/stable-launcher/rollback to the existing
// runtime owner. It never builds, starts, stops or restarts a process.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This ready package supports Windows x64 only");
const [command, root] = process.argv.slice(2);
if (!["install", "rollback"].includes(command) || !root || process.argv.length !== 4) {
  throw new Error("Usage: node install-prepared.mjs install|rollback <explicit-runtime-root>");
}
const runtimeRoot = path.resolve(root);
if (runtimeRoot === path.parse(runtimeRoot).root
    || runtimeRoot === packageRoot || runtimeRoot.startsWith(packageRoot+path.sep)
    || packageRoot.startsWith(runtimeRoot+path.sep)) throw new Error("Runtime and package scratch roots must be separate");
const descriptor = JSON.parse(await readFile(path.join(packageRoot, "package-manifest.json"), "utf8"));
if (descriptor.schema !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(descriptor.releaseId)) {
  throw new Error("Unsupported distribution descriptor");
}
async function requireStopped() {
  const status = await runtimeStatus({ runtimeRoot, requireProcessEvidence: true });
  if (status.running) throw new Error("Runtime is running; use the existing owner's stopped-writer window");
}
async function requireRegularAncestors(target) {
  for (let current = path.resolve(target);;) {
    const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error("Unsafe runtime directory");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
await requireRegularAncestors(runtimeRoot);
await requireStopped();
await mkdir(runtimeRoot, { recursive: true });
await protectRuntimeDirectory(runtimeRoot);
await withPublicationLock(async () => {
  await requireStopped();
  const releases = path.join(runtimeRoot, "releases");
  await requireRegularAncestors(releases);
  await mkdir(releases, { recursive: true });
  await protectRuntimeDirectory(releases);
  let releaseId = descriptor.releaseId;
  if (command === "rollback") {
    const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pointer.previous ?? "")) throw new Error("No valid previous release");
    releaseId = pointer.previous;
  }
  const releaseRoot = path.join(releases, releaseId);
  await requireRegularAncestors(releaseRoot);
  let requireUpgrade = async () => {};
  if (command === "install") {
    const source = path.join(packageRoot, "runtime");
    await verifyRuntimeManifest(source, releaseId);
    const candidateBytes = await readFile(path.join(source, "runtime-manifest.json"));
    const candidateManifest = JSON.parse(candidateBytes);
    requireUpgrade = async () => {
      const pointer = await readFile(path.join(runtimeRoot, "current.json"), "utf8")
        .then(JSON.parse, error => { if (error.code === "ENOENT") return null; throw error; });
      if (!pointer) return assertAgentHubUpgrade(null, candidateManifest);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pointer.current ?? "")) throw new Error("Unknown current runtime identity");
      const currentRoot = path.join(releases, pointer.current);
      await requireRegularAncestors(currentRoot);
      await verifyRuntimeManifest(currentRoot, pointer.current);
      const currentBytes = await readFile(path.join(currentRoot, "runtime-manifest.json"));
      assertAgentHubUpgrade(JSON.parse(currentBytes), candidateManifest, {
        sameArtifact: runtimeManifestMatchesPackage(currentBytes, candidateBytes),
      });
    };
    await requireUpgrade();
    const exists = await lstat(releaseRoot).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!exists) {
      const staging = path.join(releases, `.distribution-${randomUUID()}`);
      try {
        await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
        await verifyRuntimeManifest(staging, releaseId);
        await requireStopped();
        await rename(staging, releaseRoot);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } else {
      const [actual, expected] = await Promise.all([readFile(path.join(releaseRoot, "runtime-manifest.json")),
        readFile(path.join(source, "runtime-manifest.json"))]);
      if (!runtimeManifestMatchesPackage(actual, expected)) throw new Error("Release ID already exists with different bytes");
      await verifyRuntimeManifest(releaseRoot, releaseId);
    }
  }
  await requireStopped();
  const config = path.join(runtimeRoot, "config.json");
  const configInfo = await lstat(config).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (configInfo && (!configInfo.isFile() || configInfo.isSymbolicLink())) throw new Error("Unsafe private config");
  if (!configInfo) {
    if (command === "rollback") throw new Error("Rollback requires the existing private configuration");
    await cp(path.join(packageRoot, "config.example.json"), config, { errorOnExist: true, force: false });
    await protectRuntimeConfig(config);
  }
  const installed = await installPreparedRuntime({ runtimeRoot, releaseRoot, releaseId,
    beforeStableLauncherCommit: async () => { await requireStopped(); await requireUpgrade(); },
    beforePointerCommit: async () => { await requireStopped(); await requireUpgrade(); } });
  await activateRuntime({ sourceRoot: releaseRoot, runtimeRoot, retireLegacyConfig: false, retireWorkspaceRuntime: false });
  console.log(JSON.stringify({ installed: installed.releaseId, restarted: false,
    next: "Configure your project/provider, then start the installed RuntimeHost explicitly." }));
}, { lockTarget: path.join(runtimeRoot, "publication"), timeoutMs: 10_000 });
