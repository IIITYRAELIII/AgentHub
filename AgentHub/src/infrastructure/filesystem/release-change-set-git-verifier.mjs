import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const RELEASE_CHANGE_SET_GIT_VERIFIER = Object.freeze({
  name: "agent-hub-release-changeset-git-verifier",
  version: "1",
});

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_GIT_ERROR_BYTES = 64 * 1024;

function gitEnvironment() {
  const environment = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS",
  ]) {
    delete environment[name];
  }
  return environment;
}

function runGit(projectRoot, args, {
  gitExecutable = "git", hashOutput = false, timeoutMs = 20_000,
  maximumOutputBytes = MAX_GIT_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable, [
      "-c", "core.quotePath=false",
      "-C", projectRoot,
      ...args,
    ], {
      env: gitEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    const digest = hashOutput ? createHash("sha256") : null;
    let outputBytes = 0;
    let errorBytes = 0;
    let errorText = "";
    let settled = false;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Git evidence verification timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (hashOutput) {
        digest.update(buffer);
        return;
      }
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        finish(new Error("Git evidence verification output is too large"));
        return;
      }
      output.push(buffer);
    });
    child.stderr.on("data", (chunk) => {
      if (errorBytes >= MAX_GIT_ERROR_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_GIT_ERROR_BYTES - errorBytes;
      errorText += buffer.subarray(0, remaining).toString("utf8");
      errorBytes += Math.min(buffer.length, remaining);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(errorText.trim() || `git ${args[0]} exited with ${code}`));
        return;
      }
      finish(null, hashOutput
        ? { bytes: outputBytes, hash: digest.digest("hex") }
        : Buffer.concat(output));
    });
  });
}

async function gitText(projectRoot, args, options) {
  return String(await runGit(projectRoot, args, options)).trim();
}

function comparablePath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizedEvidencePath(value) {
  return String(value).replaceAll("\\", "/");
}

function literalPathspec(filePath) {
  return `:(literal)${filePath}`;
}

function treeEntry(output, expectedPath) {
  const entries = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) continue;
    const record = output.subarray(start, index);
    start = index + 1;
    if (!record.length) continue;
    const separator = record.indexOf(9);
    if (separator < 0) throw new Error("Git returned malformed tree evidence");
    const [mode, type, object] = record.subarray(0, separator).toString("ascii").split(" ");
    const filePath = record.subarray(separator + 1).toString("utf8");
    entries.push({ mode, type, object, path: filePath });
  }
  const matches = entries.filter((entry) => entry.path === expectedPath);
  if (matches.length > 1) throw new Error(`Git returned duplicate tree evidence for ${expectedPath}`);
  return matches[0] ?? null;
}

async function verifiedCommit(projectRoot, revision, label, options) {
  const resolved = await gitText(projectRoot, ["rev-parse", "--verify", `${revision}^{commit}`], options)
    .catch((error) => {
      throw new Error(`${label} revision does not exist as a commit: ${error.message}`);
    });
  if (resolved.toLowerCase() !== revision) {
    throw new Error(`${label} revision does not resolve to the claimed commit`);
  }
  return resolved.toLowerCase();
}

async function verifyBlobExists(projectRoot, blob, label, options) {
  if (blob === "absent") return;
  await runGit(projectRoot, ["cat-file", "-e", `${blob}^{blob}`], {
    ...options,
    maximumOutputBytes: 0,
  }).catch((error) => {
    throw new Error(`${label} blob does not exist: ${error.message}`);
  });
}

async function verifiedPathBlob(projectRoot, revision, filePath, claimedBlob, label, options) {
  await verifyBlobExists(projectRoot, claimedBlob, label, options);
  const output = await runGit(projectRoot, [
    "ls-tree", "-z", "--full-tree", revision, "--", literalPathspec(filePath),
  ], options);
  const entry = treeEntry(output, filePath);
  if (claimedBlob === "absent") {
    if (entry) throw new Error(`${label} path ${filePath} is not absent at ${revision}`);
    return { state: "absent" };
  }
  if (!entry) throw new Error(`${label} path ${filePath} is absent at ${revision}`);
  if (entry.type !== "blob") throw new Error(`${label} path ${filePath} is not a blob at ${revision}`);
  if (entry.object.toLowerCase() !== claimedBlob) {
    throw new Error(`${label} path ${filePath} does not resolve to the claimed blob`);
  }
  return { state: "blob", blob: claimedBlob, mode: entry.mode };
}

export async function canonicalReleaseChangeSetDiffHash({
  projectRoot, baseRevision, resultRevision, filePath, gitExecutable = "git",
} = {}) {
  const result = await runGit(projectRoot, [
    "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--no-color", "--diff-algorithm=myers", "--no-indent-heuristic", "--unified=3",
    "--src-prefix=a/", "--dst-prefix=b/", baseRevision, resultRevision,
    "--", literalPathspec(filePath),
  ], { gitExecutable, hashOutput: true, timeoutMs: 60_000 });
  if (!result.bytes) throw new Error(`canonical Git diff is empty for ${filePath}`);
  return result;
}

export async function verifyReleaseChangeSetGitEvidence(manifest, { gitExecutable = "git" } = {}) {
  if (!manifest?.manifestHash || !Array.isArray(manifest.repositories) || !Array.isArray(manifest.files)) {
    throw new Error("Git verifier requires a normalized frozen ChangeSet manifest");
  }
  const repositories = [];
  let gitVersion = "";
  for (const repository of manifest.repositories) {
    const configuredRoot = await realpath(repository.projectRoot).catch((error) => {
      throw new Error(`repository root does not exist: ${repository.projectRoot}: ${error.message}`);
    });
    const topLevel = await gitText(configuredRoot, ["rev-parse", "--show-toplevel"], { gitExecutable })
      .catch((error) => {
        throw new Error(`repository root is not a Git repository: ${repository.projectRoot}: ${error.message}`);
      });
    const canonicalRoot = await realpath(topLevel);
    if (comparablePath(configuredRoot) !== comparablePath(canonicalRoot)) {
      throw new Error(`repository root is not the Git top-level: ${repository.projectRoot}`);
    }
    const objectFormat = await gitText(canonicalRoot, ["rev-parse", "--show-object-format"], { gitExecutable });
    const expectedLength = objectFormat === "sha256" ? 64 : 40;
    if (repository.baseRevision.length !== expectedLength || repository.resultRevision.length !== expectedLength) {
      throw new Error(`repository revisions do not match Git object format ${objectFormat}`);
    }
    const baseRevision = await verifiedCommit(
      canonicalRoot, repository.baseRevision, "base", { gitExecutable },
    );
    const resultRevision = await verifiedCommit(
      canonicalRoot, repository.resultRevision, "result", { gitExecutable },
    );
    gitVersion ||= await gitText(canonicalRoot, ["--version"], { gitExecutable });
    repositories.push({
      projectRoot: repository.projectRoot,
      canonicalRoot: normalizedEvidencePath(canonicalRoot),
      objectFormat,
      baseRevision,
      resultRevision,
      revisionType: "commit",
    });
  }

  const repositoriesByRoot = new Map(repositories.map((repository) => [repository.projectRoot, repository]));
  const files = [];
  for (const file of manifest.files) {
    const repository = repositoriesByRoot.get(file.projectRoot);
    if (!repository) throw new Error(`verified repository is missing for ${file.projectRoot}`);
    const base = await verifiedPathBlob(
      repository.canonicalRoot, repository.baseRevision, file.path, file.baseBlob, "base", { gitExecutable },
    );
    const result = await verifiedPathBlob(
      repository.canonicalRoot, repository.resultRevision, file.path, file.resultBlob, "result", { gitExecutable },
    );
    if (base.state === "blob" && result.state === "blob" && base.blob === result.blob) {
      throw new Error(`frozen file is unchanged between revisions: ${file.path}`);
    }
    let canonicalDiff = null;
    if (file.patchHash) {
      canonicalDiff = await canonicalReleaseChangeSetDiffHash({
        projectRoot: repository.canonicalRoot,
        baseRevision: repository.baseRevision,
        resultRevision: repository.resultRevision,
        filePath: file.path,
        gitExecutable,
      });
      if (canonicalDiff.hash !== file.patchHash) {
        throw new Error(`patch hash does not match canonical Git diff for ${file.path}`);
      }
    }
    files.push({
      projectRoot: file.projectRoot,
      path: file.path,
      operation: file.operation,
      base,
      result,
      ...(canonicalDiff ? {
        canonicalDiff: {
          algorithm: "sha256",
          format: "git-diff-binary-full-index-myers-u3-no-renames-v1",
          hash: canonicalDiff.hash,
          bytes: canonicalDiff.bytes,
        },
      } : {}),
    });
  }

  return {
    schemaVersion: 1,
    verifier: { ...RELEASE_CHANGE_SET_GIT_VERIFIER, gitVersion },
    repositories,
    files,
  };
}
