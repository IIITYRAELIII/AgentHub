import { readReleaseToolPackage } from "./release-tool-package.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runtimeLayout, runtimeReleaseDirectory } from "../filesystem/runtime-layout.mjs";
import { verifyRuntimeManifest } from "../filesystem/runtime-manifest-verifier.mjs";
import { artifactVersionIdentity } from "../../domain/agent-hub-version.mjs";

export const PREPARE_PUBLICATION_ARTIFACTS = "Подготовка артефактов публикации";
export const INSTALL_PREPARED_RUNTIME = "Установка runtime-релиза";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const absent = (error) => { if (error.code === "ENOENT") return null; throw error; };
const python = process.platform === "win32" ? "python.exe" : "python3";
const executeFile = promisify(execFile);
function validArtifactVersion(value) {
  try {
    const identity = artifactVersionIdentity(value);
    return identity.versionScheme === "semver-build-v1" || /^\d+\.\d+\.\d+\.[1-9]\d*$/u.test(value);
  } catch { return false; }
}

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

export function validateFrozenRuntimePublication(runtimePublication = null) {
  const preparedInput = runtimePublication === null ? null : structuredClone(runtimePublication);
  if (preparedInput !== null && (typeof preparedInput !== "object" || Array.isArray(preparedInput)
    || Object.keys(preparedInput).sort().join(",") !== "generation,operationId,sourceCommit,version"
    || typeof preparedInput.operationId !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(preparedInput.operationId)
    || !Number.isSafeInteger(preparedInput.generation) || preparedInput.generation < 1
    || typeof preparedInput.sourceCommit !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(preparedInput.sourceCommit)
    || typeof preparedInput.version !== "string"
    || !validArtifactVersion(preparedInput.version))) {
    throw new Error("Invalid frozen runtime publication input");
  }
  return preparedInput;
}

export function createPublicationArtifactSteps(options = {}) {
  validateFrozenRuntimePublication(options.runtimePublication ?? null);
  let pending;
  const resolve = () => pending ??= (async () => {
    const tool = await readReleaseToolPackage();
    const api = (await tool.module("src/publication-artifacts.mjs")).createArtifactPublicationTools({
      runtimeLayout, runtimeReleaseDirectory, verifyRuntimeManifest, artifactVersionIdentity,
      artifactFiles, readArtifact, buildArtifact, validateRuntimePublication: validateFrozenRuntimePublication,
    });
    return api.createPublicationArtifactSteps({
      loadWorker: file => import(pathToFileURL(path.join(options.sourceRoot, "cloudflare-worker", file)).href),
      ...options,
    });
  })();
  return {
    steps: async (...args) => (await resolve()).steps(...args),
    verify: async (...args) => (await resolve()).verify(...args),
    preparedRuntimeReceipt: async (...args) => (await resolve()).preparedRuntimeReceipt(...args),
  };
}
