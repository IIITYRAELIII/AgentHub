import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { withInterprocessLocks } from "../process/interprocess-lock.mjs";

const MARKER_NAME = ".agent-hub-task-dependencies.json";
const FAILURE_MARKER_NAME = ".agent-hub-task-dependencies-failure.json";
const INSTALL_POLICY = "npm-ci-with-dev-and-optional-v4";
const MAX_PACKAGE_METADATA_BYTES = 1024 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_ATOMIC_TEMP_ATTEMPTS = 4;
const NPM_CI_ARGS = ["ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund"];
const PACKAGE_IDENTITY_FIELDS = ["version", "resolved", "integrity", "link"];
const ALLOWED_SERVICE_ENTRIES = new Set([
  ".bin",
  ".cache",
  ".package-lock.json",
  MARKER_NAME,
  FAILURE_MARKER_NAME,
]);
const DEPENDENCY_TREE_LIMITS = Object.freeze({
  maxPackageLockBytes: 16 * 1024 * 1024,
  maxNodeModulesNestingDepth: 16,
  maxPackageRoots: 10_000,
  maxEntriesPerDirectory: 5_000,
  maxTotalDirectoryEntries: 50_000,
});
const DEFAULT_FILE_SYSTEM = Object.freeze({ open, rename, rm });
const STABLE_FAILURE_CODES = new Set([
  "TASK_DEPENDENCY_POST_INSTALL_INVALID",
  "TASK_DEPENDENCY_TREE_LIMIT",
]);
const INVALID_MARKER = Symbol("invalid-task-dependency-marker");

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function optionalLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readBoundedFile(target, {
  maxBytes,
  label,
  fileSystem,
  expectedEntry = null,
} = {}) {
  const handle = await fileSystem.open(target, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maxBytes) throw treeLimitError(`${label} exceeds maxBytes=${maxBytes}`);
    if (expectedEntry && (before.dev !== expectedEntry.dev || before.ino !== expectedEntry.ino
      || before.size !== expectedEntry.size || before.mtimeMs !== expectedEntry.mtimeMs)) {
      throw new Error(`${label} changed before it was opened`);
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes - total;
      if (remaining === 0) {
        const probe = Buffer.alloc(1);
        const { bytesRead } = await handle.read(probe, 0, 1, total);
        if (bytesRead > 0) throw treeLimitError(`${label} exceeds maxBytes=${maxBytes}`);
        break;
      }
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== before.size) {
      throw new Error(`${label} changed while being read`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomically(target, value, { maxBytes, fileSystem }) {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (content.byteLength > maxBytes) throw treeLimitError(`Task dependency evidence exceeds maxBytes=${maxBytes}`);
  let lastCollision;
  for (let attempt = 0; attempt < MAX_ATOMIC_TEMP_ATTEMPTS; attempt += 1) {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let created = false;
    let renamed = false;
    try {
      try {
        handle = await fileSystem.open(temporary, "wx", 0o600);
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        lastCollision = error;
        continue;
      }
      await handle.writeFile(content);
      if (typeof handle.sync === "function") await handle.sync();
      await handle.close();
      handle = null;
      await fileSystem.rename(temporary, target);
      renamed = true;
      return;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created && !renamed) await fileSystem.rm(temporary, { force: true }).catch(() => {});
    }
  }
  throw lastCollision;
}

function runNpmCi(args, { cwd, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const command = windows ? process.env.ComSpec || "cmd.exe" : "npm";
    const commandArgs = windows ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`npm ci timed out after ${timeoutMs} ms in ${cwd}`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(errorText || `npm ci exited with ${code} in ${cwd}`));
    }));
  });
}

async function assertLocalNodeModules(packageRoot) {
  const nodeModules = path.join(packageRoot, "node_modules");
  const entry = await optionalLstat(nodeModules);
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Task dependencies must use a local directory: ${nodeModules}`);
  }
  const resolved = await realpath(nodeModules);
  if (!pathInside(packageRoot, resolved)) {
    throw new Error(`Task dependencies escaped their package root: ${nodeModules}`);
  }
  return true;
}

function packageIdentity(entry) {
  return Object.fromEntries(PACKAGE_IDENTITY_FIELDS.flatMap((field) => (
    Object.hasOwn(entry ?? {}, field) ? [[field, entry[field]]] : []
  )));
}

function samePackageIdentity(expected, actual) {
  return PACKAGE_IDENTITY_FIELDS.every((field) => (
    !Object.hasOwn(expected ?? {}, field) || expected[field] === actual?.[field]
  ));
}

function treeLimitError(message) {
  const error = new Error(message);
  error.code = "TASK_DEPENDENCY_TREE_LIMIT";
  return error;
}

function packageMayBeOmitted(rootOptionalPackages, packagePath, entry) {
  if (entry.optional === true) return true;
  return rootOptionalPackages.has(canonicalPackageName(packagePath))
    && !packagePath.slice(0, packagePath.lastIndexOf("node_modules/")).includes("node_modules/");
}

function boundedRootOptionalPackages(lock, limits) {
  const result = new Set();
  const optional = lock?.packages?.[""]?.optionalDependencies ?? {};
  for (const packageName in optional) {
    if (!Object.hasOwn(optional, packageName)) continue;
    if (result.size >= limits.maxPackageRoots) {
      throw treeLimitError(`Task dependency source exceeds maxPackageRoots=${limits.maxPackageRoots}`);
    }
    result.add(packageName);
  }
  return result;
}

function lockPackageKey(packageRoot, target) {
  const relative = path.relative(packageRoot, target).split(path.sep).join("/");
  return relative === "." ? "" : relative;
}

async function linkedPackageExpectation({
  projectRoot,
  packageRoot,
  packagePath,
  entry,
  lock,
  fileSystem,
}) {
  if (typeof entry.resolved !== "string" || entry.resolved.trim() === "") {
    throw new Error(`Task dependency link has no local resolved target: ${packagePath}`);
  }
  const resolvedValue = entry.resolved.startsWith("file:") ? entry.resolved.slice(5) : entry.resolved;
  if (path.isAbsolute(resolvedValue) || /^[a-z][a-z0-9+.-]*:/iu.test(resolvedValue)) {
    throw new Error(`Task dependency link must use a local relative target: ${packagePath}`);
  }
  const declaredTarget = path.resolve(packageRoot, resolvedValue);
  const targetEntry = await optionalLstat(declaredTarget);
  if (!targetEntry || (!targetEntry.isDirectory() && !targetEntry.isSymbolicLink())) {
    throw new Error(`Task dependency link target is not a directory: ${packagePath}`);
  }
  const resolvedTarget = await realpath(declaredTarget);
  if (!pathInside(projectRoot, resolvedTarget)) {
    throw new Error(`Task dependency link target escaped its managed project: ${packagePath}`);
  }
  if (!(await lstat(resolvedTarget)).isDirectory()) {
    throw new Error(`Task dependency link target is not a directory: ${packagePath}`);
  }
  const targetPackageJsonPath = path.join(resolvedTarget, "package.json");
  const packageJsonEntry = await lstat(targetPackageJsonPath);
  if (!packageJsonEntry.isFile() || packageJsonEntry.isSymbolicLink()) {
    throw new Error(`Task dependency link target has no local package.json: ${packagePath}`);
  }
  const packageJsonContent = await readBoundedFile(targetPackageJsonPath, {
    maxBytes: MAX_PACKAGE_METADATA_BYTES,
    label: `Task dependency link target metadata ${packagePath}`,
    fileSystem,
    expectedEntry: packageJsonEntry,
  });
  const packageJson = JSON.parse(packageJsonContent.toString("utf8"));
  const targetLockEntry = lock?.packages?.[lockPackageKey(packageRoot, declaredTarget)]
    ?? lock?.packages?.[lockPackageKey(packageRoot, resolvedTarget)]
    ?? null;
  if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
    throw new Error(`Task dependency link target has no package name: ${packagePath}`);
  }
  if (targetLockEntry?.name && targetLockEntry.name !== packageJson.name) {
    throw new Error(`Task dependency link target name disagrees with its lock entry: ${packagePath}`);
  }
  if (targetLockEntry?.version && packageJson.version && targetLockEntry.version !== packageJson.version) {
    throw new Error(`Task dependency link target version disagrees with its lock entry: ${packagePath}`);
  }
  return {
    ...entry,
    expectedPackageName: targetLockEntry?.name ?? packageJson.name,
    expectedPackageVersion: targetLockEntry?.version ?? packageJson.version ?? null,
  };
}

async function linkedPackageExpectations(options) {
  const result = new Map();
  for (const [packagePath, entry] of options.expectedPackages) {
    result.set(packagePath, entry.link === true
      ? await linkedPackageExpectation({ ...options, packagePath, entry })
      : entry);
  }
  return result;
}

function resolvedTreeLimits(overrides = {}) {
  const limits = { ...DEPENDENCY_TREE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Task dependency tree limit ${name} must be a positive integer`);
    }
  }
  return limits;
}

function boundedLockedPackages(lock, limits, { source = false } = {}) {
  const collected = [];
  const nodeModulesEntries = new Map();
  const scopeEntries = new Map();
  let structuralEntries = 0;
  const lockPackages = lock?.packages ?? {};
  for (const packagePath in lockPackages) {
    if (!Object.hasOwn(lockPackages, packagePath) || !packagePath.startsWith("node_modules/")) continue;
    const entry = lockPackages[packagePath];
    if (!entry || typeof entry !== "object") continue;
    if (collected.length >= limits.maxPackageRoots) {
      throw treeLimitError(`Task dependency source exceeds maxPackageRoots=${limits.maxPackageRoots}`);
    }
    const depth = packagePath.split("node_modules/").length - 1;
    if (depth > limits.maxNodeModulesNestingDepth) {
      throw treeLimitError(
        `Task dependency source exceeds maxNodeModulesNestingDepth=${limits.maxNodeModulesNestingDepth}`,
      );
    }
    if (source) {
      if (structuralEntries >= limits.maxTotalDirectoryEntries) {
        throw treeLimitError(
          `Task dependency source exceeds maxTotalDirectoryEntries=${limits.maxTotalDirectoryEntries}`,
        );
      }
      structuralEntries += 1;
    }
    const markerIndex = packagePath.lastIndexOf("node_modules/");
    const container = packagePath.slice(0, markerIndex + 12);
    const name = canonicalPackageName(packagePath);
    if (source && name.startsWith("@")) {
      const scope = name.split("/")[0];
      let entries = nodeModulesEntries.get(container);
      if (!entries) {
        entries = new Set();
        nodeModulesEntries.set(container, entries);
      }
      if (!entries.has(scope) && entries.size >= limits.maxEntriesPerDirectory) {
        throw treeLimitError(`Task dependency source exceeds maxEntriesPerDirectory=${limits.maxEntriesPerDirectory}`);
      }
      entries.add(scope);
      const scopeKey = `${container}/${scope}`;
      const scopedCount = scopeEntries.get(scopeKey) ?? 0;
      if (scopedCount >= limits.maxEntriesPerDirectory) {
        throw treeLimitError(`Task dependency source exceeds maxEntriesPerDirectory=${limits.maxEntriesPerDirectory}`);
      }
      scopeEntries.set(scopeKey, scopedCount + 1);
      if (scopedCount === 0) {
        if (structuralEntries >= limits.maxTotalDirectoryEntries) {
          throw treeLimitError(
            `Task dependency source exceeds maxTotalDirectoryEntries=${limits.maxTotalDirectoryEntries}`,
          );
        }
        structuralEntries += 1;
      }
    } else if (source) {
      let entries = nodeModulesEntries.get(container);
      if (!entries) {
        entries = new Set();
        nodeModulesEntries.set(container, entries);
      }
      if (!entries.has(name) && entries.size >= limits.maxEntriesPerDirectory) {
        throw treeLimitError(`Task dependency source exceeds maxEntriesPerDirectory=${limits.maxEntriesPerDirectory}`);
      }
      entries.add(name);
    }
    collected.push([packagePath, entry]);
  }
  collected.sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1);
  return new Map(collected);
}

function canonicalPackageName(packagePath) {
  const segments = packagePath.slice(packagePath.lastIndexOf("node_modules/") + 13).split("/");
  return segments[0].startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
}

async function physicalPackageRoots({ projectRoot, packageRoot, limits }) {
  const roots = new Map();
  const pending = [{ directory: path.join(packageRoot, "node_modules"), prefix: "node_modules", depth: 1 }];
  const visited = new Set();
  let totalDirectoryEntries = 0;
  const sortedEntries = async (directory) => {
    const entries = [];
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        if (entries.length >= limits.maxEntriesPerDirectory) {
          throw treeLimitError(`Task dependency tree exceeds maxEntriesPerDirectory=${limits.maxEntriesPerDirectory}`);
        }
        if (totalDirectoryEntries >= limits.maxTotalDirectoryEntries) {
          throw treeLimitError(
            `Task dependency tree exceeds maxTotalDirectoryEntries=${limits.maxTotalDirectoryEntries}`,
          );
        }
        entries.push(entry);
        totalDirectoryEntries += 1;
      }
    } finally {
      await handle.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
    return entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  };
  const localDirectory = async (directory, { allowLink = false } = {}) => {
    const entry = await optionalLstat(directory);
    if (!entry) return false;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return null;
    if (entry.isSymbolicLink() && !allowLink) {
      throw new Error(`Task dependencies must use a local directory: ${directory}`);
    }
    const resolved = await realpath(directory);
    if (!pathInside(projectRoot, resolved)) {
      throw new Error(`Task dependency path escaped its managed project: ${directory}`);
    }
    return resolved;
  };
  const queueNestedNodeModules = async (packageDirectory, packagePath, depth) => {
    const nestedDirectory = path.join(packageDirectory, "node_modules");
    if (depth >= limits.maxNodeModulesNestingDepth) {
      if (await optionalLstat(nestedDirectory)) {
        throw treeLimitError(
          `Task dependency tree exceeds maxNodeModulesNestingDepth=${limits.maxNodeModulesNestingDepth}`,
        );
      }
      return;
    }
    pending.push({
      directory: nestedDirectory,
      prefix: `${packagePath}/node_modules`,
      depth: depth + 1,
    });
  };

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current.depth > limits.maxNodeModulesNestingDepth) {
      throw treeLimitError(
        `Task dependency tree exceeds maxNodeModulesNestingDepth=${limits.maxNodeModulesNestingDepth}`,
      );
    }
    const resolvedNodeModules = await localDirectory(current.directory);
    if (resolvedNodeModules === false) continue;
    if (!resolvedNodeModules) return null;
    const visitKey = process.platform === "win32" ? resolvedNodeModules.toLowerCase() : resolvedNodeModules;
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);
    for (const entry of await sortedEntries(current.directory)) {
      if (entry.name.startsWith(".")) {
        if (!ALLOWED_SERVICE_ENTRIES.has(entry.name)) return null;
        continue;
      }
      if (entry.name.startsWith("@")) {
        const scopeDirectory = path.join(current.directory, entry.name);
        if (!await localDirectory(scopeDirectory)) return null;
        for (const scopedEntry of await sortedEntries(scopeDirectory)) {
          if (scopedEntry.name.startsWith(".")) return null;
          const packagePath = `${current.prefix}/${entry.name}/${scopedEntry.name}`;
          const packageDirectory = path.join(scopeDirectory, scopedEntry.name);
          if (!await localDirectory(packageDirectory, { allowLink: true })) return null;
          if (roots.size >= limits.maxPackageRoots) {
            throw treeLimitError(`Task dependency tree exceeds maxPackageRoots=${limits.maxPackageRoots}`);
          }
          roots.set(packagePath, packageDirectory);
          await queueNestedNodeModules(packageDirectory, packagePath, current.depth);
        }
        continue;
      }
      const packagePath = `${current.prefix}/${entry.name}`;
      const packageDirectory = path.join(current.directory, entry.name);
      if (!await localDirectory(packageDirectory, { allowLink: true })) return null;
      if (roots.size >= limits.maxPackageRoots) {
        throw treeLimitError(`Task dependency tree exceeds maxPackageRoots=${limits.maxPackageRoots}`);
      }
      roots.set(packagePath, packageDirectory);
      await queueNestedNodeModules(packageDirectory, packagePath, current.depth);
    }
  }
  return roots;
}

async function installedPackageMetadata({ projectRoot, packageDirectory, packagePath, expected, fileSystem }) {
  try {
    const packageJsonPath = path.join(packageDirectory, "package.json");
    const resolvedPackageJson = await realpath(packageJsonPath);
    if (!pathInside(projectRoot, resolvedPackageJson)) {
      throw new Error(`Task dependency metadata escaped its managed project: ${packageJsonPath}`);
    }
    const packageJsonEntry = await lstat(resolvedPackageJson);
    if (!packageJsonEntry.isFile() || packageJsonEntry.isSymbolicLink()) return { present: true, valid: false };
    const packageJsonContent = await readBoundedFile(resolvedPackageJson, {
      maxBytes: MAX_PACKAGE_METADATA_BYTES,
      label: `Task dependency metadata ${packagePath}`,
      fileSystem,
      expectedEntry: packageJsonEntry,
    });
    const packageJson = JSON.parse(packageJsonContent.toString("utf8"));
    const expectedName = expected.expectedPackageName ?? expected.name ?? canonicalPackageName(packagePath);
    const expectedVersion = expected.expectedPackageVersion ?? expected.version;
    if (packageJson.name !== expectedName
      || (expectedVersion != null && packageJson.version !== expectedVersion)) {
      return { present: true, valid: false };
    }
    return { present: true, valid: true, name: packageJson.name, version: packageJson.version ?? null };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return { present: true, valid: false };
    throw error;
  }
}

async function installedStateFingerprint({
  projectRoot,
  packageRoot,
  expectedPackages,
  rootOptionalPackages,
  limits,
  fileSystem,
}) {
  let installedLock;
  try {
    const installedLockPath = path.join(packageRoot, "node_modules", ".package-lock.json");
    const installedLockEntry = await optionalLstat(installedLockPath);
    if (!installedLockEntry?.isFile() || installedLockEntry.isSymbolicLink()) return null;
    if (!pathInside(path.join(packageRoot, "node_modules"), await realpath(installedLockPath))) return null;
    const installedLockContent = await readBoundedFile(installedLockPath, {
      maxBytes: limits.maxPackageLockBytes,
      label: "Task installed lock",
      fileSystem,
      expectedEntry: installedLockEntry,
    });
    installedLock = JSON.parse(installedLockContent.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  const installedPackages = boundedLockedPackages(installedLock, limits);
  const physicalPackages = await physicalPackageRoots({ projectRoot, packageRoot, limits });
  if (!physicalPackages || physicalPackages.size !== installedPackages.size) return null;
  for (const packagePath of physicalPackages.keys()) if (!installedPackages.has(packagePath)) return null;
  for (const packagePath of installedPackages.keys()) if (!expectedPackages.has(packagePath)) return null;

  const evidence = [];
  for (const [packagePath, expected] of expectedPackages) {
    const installed = installedPackages.get(packagePath);
    const packageDirectory = physicalPackages.get(packagePath);
    const optional = packageMayBeOmitted(rootOptionalPackages, packagePath, expected);
    if (!installed) {
      if (packageDirectory || !optional) return null;
      evidence.push({ packagePath, optional: true, present: false });
      continue;
    }
    const physical = await installedPackageMetadata({
      projectRoot,
      packageDirectory,
      packagePath,
      expected,
      fileSystem,
    });
    if (!physical.valid || !samePackageIdentity(expected, installed)) return null;
    evidence.push({
      packagePath,
      optional,
      present: true,
      identity: packageIdentity(installed),
      packageName: physical.name,
      packageVersion: physical.version,
    });
  }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

async function readMarker(packageRoot, markerName, { fileSystem }) {
  const markerPath = path.join(packageRoot, "node_modules", markerName);
  const markerEntry = await optionalLstat(markerPath);
  if (!markerEntry) return null;
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
    throw new Error(`Task dependency evidence requires explicit cleanup: node_modules/${markerName}`);
  }
  try {
    const content = await readBoundedFile(markerPath, {
      maxBytes: MAX_MARKER_BYTES,
      label: `Task dependency evidence node_modules/${markerName}`,
      fileSystem,
      expectedEntry: markerEntry,
    });
    return JSON.parse(content.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "TASK_DEPENDENCY_TREE_LIMIT"
      || error instanceof SyntaxError) return INVALID_MARKER;
    throw error;
  }
}

function invalidInstalledState() {
  const error = new Error("npm ci produced dependency state that does not match its lockfile");
  error.code = "TASK_DEPENDENCY_POST_INSTALL_INVALID";
  return {
    valid: false,
    code: error.code,
    state: "lock-state-mismatch",
    error,
  };
}

async function validateInstalledState(options) {
  try {
    const fingerprint = await installedStateFingerprint(options);
    return fingerprint
      ? { valid: true, fingerprint }
      : invalidInstalledState();
  } catch (error) {
    if (error?.code !== "TASK_DEPENDENCY_TREE_LIMIT") throw error;
    return {
      valid: false,
      code: error.code,
      state: String(error.message),
      error,
    };
  }
}

function recordedFailureMatches(failure, { fingerprint, validation }) {
  return failure?.policy === INSTALL_POLICY
    && failure.lockfileSha256 === fingerprint
    && STABLE_FAILURE_CODES.has(failure.code)
    && failure.code === validation.code
    && failure.state === validation.state;
}

function isStableFailureEvidence(failure) {
  return failure && failure !== INVALID_MARKER
    && typeof failure.policy === "string"
    && typeof failure.lockfileSha256 === "string"
    && STABLE_FAILURE_CODES.has(failure.code)
    && typeof failure.state === "string";
}

async function recordPostInstallFailure({ packageRoot, fingerprint, validation, fileSystem }) {
  if (!STABLE_FAILURE_CODES.has(validation.code)) {
    throw new Error(`Unsupported Task dependency failure code: ${validation.code}`);
  }
  const failurePath = path.join(packageRoot, "node_modules", FAILURE_MARKER_NAME);
  await writeJsonAtomically(failurePath, {
    policy: INSTALL_POLICY,
    lockfileSha256: fingerprint,
    code: validation.code,
    state: validation.state,
  }, { maxBytes: MAX_MARKER_BYTES, fileSystem });
}

async function prepareNpmProject({ projectRoot, lockfile, runNpm, limits, fileSystem }) {
  const packageRoot = path.dirname(lockfile);
  if (!pathInside(projectRoot, packageRoot)) {
    throw new Error(`Task dependency lockfile is outside its project root: ${lockfile}`);
  }
  const [lockfileEntry, packageEntry] = await Promise.all([
    optionalLstat(lockfile),
    optionalLstat(path.join(packageRoot, "package.json")),
  ]);
  if (!lockfileEntry?.isFile() || lockfileEntry.isSymbolicLink()) {
    throw new Error(`Tracked npm lockfile must be a local file: ${lockfile}`);
  }
  if (!packageEntry?.isFile()) {
    throw new Error(`Tracked npm lockfile has no adjacent package.json: ${lockfile}`);
  }
  const resolvedLockfile = await realpath(lockfile);
  if (!pathInside(projectRoot, resolvedLockfile)) {
    throw new Error(`Task dependency lockfile escaped its project root: ${lockfile}`);
  }
  const lockfileContent = await readBoundedFile(resolvedLockfile, {
    maxBytes: limits.maxPackageLockBytes,
    label: "Task dependency source",
    fileSystem,
    expectedEntry: lockfileEntry,
  });
  const lock = JSON.parse(lockfileContent.toString("utf8"));
  const expectedPackages = await linkedPackageExpectations({
    projectRoot,
    packageRoot,
    lock,
    expectedPackages: boundedLockedPackages(lock, limits, { source: true }),
    fileSystem,
  });
  const rootOptionalPackages = boundedRootOptionalPackages(lock, limits);
  const fingerprint = createHash("sha256")
    .update(INSTALL_POLICY)
    .update("\0")
    .update(lockfileContent)
    .digest("hex");
  const relativeProject = path.relative(projectRoot, packageRoot).split(path.sep).join("/") || ".";
  const nodeModulesExists = await assertLocalNodeModules(packageRoot);
  let successMarker = null;
  let failureMarker = null;
  let validation = invalidInstalledState();
  if (nodeModulesExists) {
    [successMarker, failureMarker, validation] = await Promise.all([
      readMarker(packageRoot, MARKER_NAME, { fileSystem }),
      readMarker(packageRoot, FAILURE_MARKER_NAME, { fileSystem }),
      validateInstalledState({
        projectRoot,
        packageRoot,
        expectedPackages,
        rootOptionalPackages,
        limits,
        fileSystem,
      }),
    ]);
    const failurePath = path.join(packageRoot, "node_modules", FAILURE_MARKER_NAME);
    if (recordedFailureMatches(failureMarker, { fingerprint, validation })) throw validation.error;
    const changedPolicyOrLock = isStableFailureEvidence(failureMarker)
      && (failureMarker.policy !== INSTALL_POLICY || failureMarker.lockfileSha256 !== fingerprint);
    if (failureMarker) await fileSystem.rm(failurePath, { force: true });
    if (!validation.valid && validation.code === "TASK_DEPENDENCY_TREE_LIMIT" && !changedPolicyOrLock) {
      throw validation.error;
    }
    if (validation.valid
      && successMarker?.policy === INSTALL_POLICY
      && successMarker.lockfileSha256 === fingerprint
      && successMarker.installedStateSha256 === validation.fingerprint) {
      return { manager: "npm", project: relativeProject, lockfile: "package-lock.json", prepared: false, fingerprint };
    }
  }

  await runNpm([...NPM_CI_ARGS], { cwd: packageRoot });
  if (!await assertLocalNodeModules(packageRoot)) {
    await mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
  }
  validation = await validateInstalledState({
    projectRoot,
    packageRoot,
    expectedPackages,
    rootOptionalPackages,
    limits,
    fileSystem,
  });
  if (!validation.valid) {
    await recordPostInstallFailure({ packageRoot, fingerprint, validation, fileSystem });
    await fileSystem.rm(path.join(packageRoot, "node_modules", MARKER_NAME), { force: true });
    throw validation.error;
  }
  await writeJsonAtomically(path.join(packageRoot, "node_modules", MARKER_NAME), {
    policy: INSTALL_POLICY,
    lockfileSha256: fingerprint,
    installedStateSha256: validation.fingerprint,
  }, { maxBytes: MAX_MARKER_BYTES, fileSystem });
  await fileSystem.rm(path.join(packageRoot, "node_modules", FAILURE_MARKER_NAME), { force: true });
  return { manager: "npm", project: relativeProject, lockfile: "package-lock.json", prepared: true, fingerprint };
}

export async function prepareTaskWorktreeDependencies({
  projectRoot,
  lockfiles = [],
  lockPath = null,
  limits: limitOverrides = {},
  runNpm = runNpmCi,
  fileSystem: fileSystemOverrides = {},
} = {}) {
  const operation = async () => {
    const root = path.resolve(String(projectRoot ?? ""));
    const limits = resolvedTreeLimits(limitOverrides);
    const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...fileSystemOverrides };
    const normalizedLockfiles = [...new Set(lockfiles.map((lockfile) => path.resolve(lockfile)))].sort();
    const results = [];
    for (const lockfile of normalizedLockfiles) {
      results.push(await prepareNpmProject({ projectRoot: root, lockfile, runNpm, limits, fileSystem }));
    }
    return results;
  };
  return lockPath ? withInterprocessLocks([lockPath], operation) : operation();
}
