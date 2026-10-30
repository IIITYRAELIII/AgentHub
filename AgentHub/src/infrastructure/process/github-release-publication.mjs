import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { artifactVersionIdentity } from "../../domain/agent-hub-version.mjs";
import { parseGitHubRemote } from "../persistence/github-publication-baseline.mjs";

export const PACKAGE_DISTRIBUTION = "Упаковка установочного архива";
export const PUBLISH_GITHUB_RELEASE = "Публикация GitHub Release";
const REPOSITORY = "IIITYRAELIII/AgentHub";
const ASSETS = ["AgentHub-win32-x64.zip", "AgentHub-win32-x64.zip.json", "install_release.py", "SHA256SUMS"];
const execute = promisify(execFile);
const sha = value => createHash("sha256").update(value).digest("hex");
const absent = error => { if (error.code === "ENOENT") return null; throw error; };

async function plainFile(file) {
  for (let parent = path.resolve(file); ; parent = path.dirname(parent)) {
    const info = await lstat(parent);
    if (info.isSymbolicLink()) throw new Error("Distribution input contains a reparse link");
    if (path.dirname(parent) === parent) break;
  }
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("Distribution asset is not a regular file");
  return info;
}

async function fileIdentity(file) {
  const info = await plainFile(file);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  const after = await plainFile(file);
  if (bytes !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino) {
    throw new Error("Distribution asset changed while reading");
  }
  return { bytes, sha256: hash.digest("hex") };
}

// Authentication stays inside this publisher process. Recipient discovery uses
// its separate anonymous installer transport. Authenticated redirects are refused.
export function githubReleaseTransport({ run = execute, request = fetch } = {}) {
  let tokenPromise;
  return async (method, route, { body, file, missing = false } = {}) => {
    if (route !== `/repos/${REPOSITORY}` && !route.startsWith(`/repos/${REPOSITORY}/`)) throw new Error("Foreign GitHub publication route");
    tokenPromise ??= run("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8", windowsHide: true,
    }).then(({ stdout }) => {
      const token = stdout.trim();
      if (!token) throw new Error("GitHub publisher has no authentication");
      return token;
    });
    const token = await tokenPromise;
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "AgentHub-release-owner" };
    let payload;
    if (file) {
      const info = await plainFile(file);
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(info.size);
      payload = createReadStream(file);
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      const response = await request(`https://${file ? "uploads" : "api"}.github.com${route}`, {
        method, headers, body: payload, redirect: "error", signal: AbortSignal.timeout(15 * 60 * 1000),
        ...(file ? { duplex: "half" } : {}),
      });
      if (response.status === 404 && missing) return null;
      if (!response.ok) throw new Error(`GitHub publication ${method} failed: HTTP ${response.status}`);
      return await response.json();
    } finally { if (file) payload.destroy(); }
  };
}

// This is an adapter in the existing frozen publication journal, not a CLI or
// another operation store. The runner selects it ONLY for its approved target.
export function createGitHubDistributionSteps({
  sourceRoot, repositoryRoot, executionRoot, runtimePublication, artifacts, journal,
  capture = async (command, args) => (await execute(command, ownedGitArguments(args, { executable: command }), {
    cwd: sourceRoot, encoding: "utf8", windowsHide: true, maxBuffer: Infinity,
    env: { ...process.env, PYTHONUTF8: "1" },
  })).stdout,
  api = githubReleaseTransport(),
} = {}) {
  if (!runtimePublication || !journal || !artifacts) throw new Error("Frozen distribution owner is required");
  const frozen = structuredClone(runtimePublication);
  const publicVersion = artifactVersionIdentity(frozen.version).publicVersion;
  if (!/^\d+\.\d+\.\d+$/u.test(publicVersion)) throw new Error("Stable distribution requires a stable public version");
  const root = `/repos/${REPOSITORY}`;
  const tagRoute = `${root}/git/ref/tags/${encodeURIComponent(publicVersion)}`;
  const outputRoot = path.join(executionRoot, "distribution");
  const namespace = path.join(outputRoot, frozen.version);
  const progress = async () => (await journal.read())?.progress?.githubDistribution ?? null;
  const save = async value => journal.updateProgress({ githubDistribution: value });

  async function verifyRepository() {
    const repository = await api("GET", root);
    if (repository.id !== 1428402643 || repository.owner?.id !== 95281881 || repository.private !== false) {
      throw new Error("Canonical GitHub repository identity changed");
    }
  }

  async function packageInput(identity) {
    if (identity.revision !== frozen.sourceCommit) throw new Error("Distribution source differs from the frozen generation");
    const remote = parseGitHubRemote((await capture("git", ["-C", repositoryRoot, "config", "--get", "remote.origin.url"])).trim());
    if (`${remote?.owner}/${remote?.repo}`.toLowerCase() !== REPOSITORY.toLowerCase()) {
      throw new Error("Standalone distribution requires its canonical public repository");
    }
    await verifyRepository();
    const prepared = await artifacts.preparedRuntimeReceipt(identity);
    if (Object.entries(frozen).some(([key, value]) => prepared.receipt[key] !== value)) {
      throw new Error("Distribution PREPARED receipt changed original owner identity");
    }
    const stdout = await capture(process.platform === "win32" ? "python.exe" : "python3", [
      "-X", "utf8", path.join(sourceRoot, "distribution", "build_release.py"),
      "--prepared-receipt", prepared.receiptFile, "--receipt-sha256", prepared.receiptSha256,
      "--source-commit", frozen.sourceCommit, "--version", frozen.version,
      "--license", path.join(sourceRoot, "..", "LICENSE"),
      "--notices", path.join(sourceRoot, "..", "THIRD_PARTY_NOTICES.md"), "--output-root", outputRoot,
    ]);
    const packaged = JSON.parse(stdout);
    if (packaged.phase !== "PACKAGED" || !/^[a-f0-9]{64}$/u.test(packaged.inputIdentity ?? "")
      || packaged.inputs?.repository !== REPOSITORY
      || Object.entries(frozen).some(([key, value]) => packaged.inputs?.[key] !== value)
      || packaged.inputs.publicVersion !== publicVersion
      || !Array.isArray(packaged.assets) || packaged.assets.length !== ASSETS.length
      || ASSETS.some((name, index) => packaged.assets[index]?.name !== name)) {
      throw new Error("PACKAGED result differs from the frozen distribution");
    }
    const actualNames = await readdir(path.join(namespace, "assets"));
    if (actualNames.sort().join("\0") !== [...ASSETS].sort().join("\0")) throw new Error("Foreign distribution asset");
    for (const row of packaged.assets) {
      const actual = await fileIdentity(path.join(namespace, "assets", row.name));
      if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) throw new Error("PACKAGED asset changed");
    }
    return packaged;
  }

  const marker = packaged => `<!-- agent-hub-package:${sha(JSON.stringify({ ...frozen, inputIdentity: packaged.inputIdentity }))} -->`;
  function assertRelease(release, packaged) {
    if (!Number.isSafeInteger(release?.id) || release.tag_name !== publicVersion || release.prerelease !== false
      || !String(release.body ?? "").endsWith(marker(packaged))) throw new Error("GitHub release is foreign or changed");
    if (!Array.isArray(release.assets) || release.assets.some(row => !ASSETS.includes(row.name))
      || new Set(release.assets.map(row => row.name)).size !== release.assets.length) throw new Error("Foreign/duplicate GitHub assets");
    for (const row of release.assets) {
      const expected = packaged.assets.find(item => item.name === row.name);
      if (row.state !== "uploaded" || row.size !== expected.bytes || row.digest !== `sha256:${expected.sha256}`) {
        throw new Error("GitHub asset differs from the accepted package");
      }
    }
    return release;
  }

  async function currentRelease(saved, packaged) {
    if (saved?.releaseId) return assertRelease(await api("GET", `${root}/releases/${saved.releaseId}`), packaged);
    // Drafts are visible to the publisher in the ordinary release list. Scan
    // every page; a lost create response never justifies a second POST.
    const matches = [];
    for (let page = 1; ; page += 1) {
      const list = await api("GET", `${root}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(list)) throw new Error("Invalid GitHub release list");
      matches.push(...list.filter(item => item.tag_name === publicVersion));
      if (list.length < 100) break;
    }
    if (matches.length > 1) throw new Error("Ambiguous GitHub release ownership");
    return matches.length ? assertRelease(matches[0], packaged) : null;
  }

  async function verify(identity) {
    const packaged = await packageInput(identity);
    const saved = await progress();
    if (!saved || saved.inputIdentity !== packaged.inputIdentity) throw new Error("Distribution journal identity changed");
    const release = await currentRelease(saved, packaged);
    const tag = await api("GET", tagRoute);
    if (tag?.object?.type !== "commit" || tag.object.sha !== frozen.sourceCommit
      || !release || release.draft !== false || !release.published_at || release.assets.length !== ASSETS.length) {
      throw new Error("Public GitHub distribution is not complete");
    }
    return { releaseId: release.id, releaseTag: publicVersion, sourceCommit: frozen.sourceCommit,
      inputIdentity: packaged.inputIdentity, assets: packaged.assets, publishedAt: release.published_at };
  }

  async function publish(identity) {
    const packaged = await packageInput(identity);
    let saved = await progress();
    if (saved && saved.inputIdentity !== packaged.inputIdentity) throw new Error("Original distribution input changed");
    saved ??= { inputIdentity: packaged.inputIdentity, createStarted: false, uploads: {} };
    await save(saved);
    await verifyRepository();
    let release = await currentRelease(saved, packaged);
    const tag = await api("GET", tagRoute, { missing: true });
    if (tag && (tag.object?.type !== "commit" || tag.object.sha !== frozen.sourceCommit)) throw new Error("GitHub tag already targets another source");
    if (!tag) {
      if (saved.tagStarted) throw new Error("Original tag creation remains unconfirmed");
      saved.tagStarted = true; await save(saved);
      await api("POST", `${root}/git/refs`, { body: { ref: `refs/tags/${publicVersion}`, sha: frozen.sourceCommit } });
    }
    if (!release) {
      if (saved.createStarted) throw new Error("Original release creation remains unconfirmed");
      saved.createStarted = true; await save(saved);
      release = assertRelease(await api("POST", `${root}/releases`, { body: {
        tag_name: publicVersion, target_commitish: frozen.sourceCommit, name: `Agent Hub ${publicVersion}`,
        draft: true, prerelease: false,
        body: `Windows installer package for Agent Hub ${publicVersion}.\n\nSource: ${frozen.sourceCommit}\n\nRun the versioned install_release.py with --release ${publicVersion}. Node.js and Python are required. See AgentHub/distribution/INSTALL.md for install, update and rollback.\n\n${marker(packaged)}`,
      } }), packaged);
    }
    saved.releaseId = release.id; await save(saved);
    for (const row of packaged.assets) {
      release = assertRelease(await api("GET", `${root}/releases/${release.id}`), packaged);
      if (release.assets.some(asset => asset.name === row.name)) continue;
      if (release.draft !== true || saved.uploads[row.name]) throw new Error("Original asset upload is unconfirmed; refusing replay");
      saved.uploads[row.name] = "started"; await save(saved);
      await api("POST", `${root}/releases/${release.id}/assets?name=${encodeURIComponent(row.name)}`, {
        file: path.join(namespace, "assets", row.name),
      });
    }
    release = assertRelease(await api("GET", `${root}/releases/${release.id}`), packaged);
    if (release.assets.length !== ASSETS.length) throw new Error("GitHub asset set is incomplete");
    await packageInput(identity);
    const finalTag = await api("GET", tagRoute);
    if (finalTag.object?.type !== "commit" || finalTag.object.sha !== frozen.sourceCommit) throw new Error("GitHub tag changed before publication");
    if (release.draft) await api("PATCH", `${root}/releases/${release.id}`, { body: { draft: false } });
    const result = await verify(identity);
    await save({ ...saved, status: "applied", result });
    return result;
  }

  return {
    steps: identity => [
      { label: PACKAGE_DISTRIBUTION, reusable: false, execute: () => packageInput(identity) },
      { label: PUBLISH_GITHUB_RELEASE, reusable: false, execute: () => publish(identity) },
    ],
    verify,
  };
}
