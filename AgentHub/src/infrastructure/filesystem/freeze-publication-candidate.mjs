import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { inspectAgentHubReleaseVersion } from "./release-version.mjs";

const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);

async function git(root, args, environment = {}) {
  return String((await execute("git", args, {
    cwd: root, env: { ...process.env, ...environment }, windowsHide: true,
    timeout: 120_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
  })).stdout).trimEnd();
}

async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

// Called only under the ReleaseGitWorkspaceService's release and repository locks.
export async function freezePreparedPublicationCandidate({
  layout, marker, expectedPlanRevision, expectedPreparedHead, workspaceId,
  changelogContent = null, releaseDate = new Date(), validateBeforeCommit = async () => {}, onPhase = async () => {},
}) {
  const root = layout.releaseRoot;
  let checkpoint = JSON.parse(await readFile(layout.checkpointFile, "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(checkpoint.manifestHash ?? "")) throw new Error("invalid prepared manifest hash");
  const manifestBytes = await readFile(path.join(layout.evidenceRoot, `${checkpoint.manifestHash}.json`));
  if (digest(manifestBytes) !== checkpoint.manifestHash) throw new Error("prepared release manifest digest changed");
  let manifest = JSON.parse(manifestBytes.toString("utf8"));
  const priorFreeze = checkpoint.publicationFreeze;
  if (checkpoint.planRevision !== expectedPlanRevision || manifest.planRevision !== expectedPlanRevision
    || ![checkpoint.preReleaseHead, priorFreeze?.preparedHead].includes(expectedPreparedHead)
    || checkpoint.baseCommit !== manifest.baseCommit
    || !samePath(manifest.primaryRoot, marker.primaryRoot)
    || !samePath(manifest.releaseRoot, root)
    || (manifest.workspaceId && manifest.workspaceId !== workspaceId)) {
    throw new Error("prepared release head, plan or Workspace changed before freeze");
  }
  const inspect = async () => {
    const [head, branch, dirty, index] = await Promise.all([
      git(root, ["rev-parse", "HEAD^{commit}"]), git(root, ["symbolic-ref", "HEAD"]),
      git(root, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
      git(root, ["ls-files", "--unmerged"]),
    ]);
    if (index || !["refs/heads/PreRelease", "refs/heads/main"].includes(branch)) throw new Error("publication freeze requires an unconflicted prepared release branch");
    const recoverableFreezePaths = new Set([
      "CHANGELOG.md", "AgentHub/package.json", "AgentHub/package-lock.json",
    ]);
    for (const line of dirty.split(/\r?\n/u).filter(Boolean)) {
      const file = line.slice(3).replaceAll("\\", "/");
      if (file !== "CHANGELOG.md"
          && !(checkpoint.phase === "freezing" && recoverableFreezePaths.has(file))) {
        throw new Error("publication freeze permits only frozen release metadata changes");
      }
    }
    const file = path.join(root, "CHANGELOG.md");
    const info = await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("publication CHANGELOG must be a regular file");
    const content = info ? await readFile(file) : null;
    if (dirty && !content) throw new Error("publication freeze cannot remove CHANGELOG.md");
    if ((content === null) !== (changelogContent === null)
      || (content && !content.equals(Buffer.from(changelogContent)))) throw new Error("supplied publication CHANGELOG bytes changed");
    return { head, branch, dirty, content };
  };
  let state = await inspect();
  if (checkpoint.phase === "frozen") {
    const frozenVersion = String(manifest.publication?.releaseVersion ?? "");
    const versionState = frozenVersion ? await inspectAgentHubReleaseVersion({
      root: path.join(root, "AgentHub"), expectedVersion: frozenVersion,
    }) : { changed: true };
    if (!priorFreeze || state.head !== checkpoint.preReleaseHead || state.branch !== "refs/heads/main" || state.dirty
      || manifest.publication?.head !== state.head
      || (state.content === null ? null : digest(state.content)) !== priorFreeze.changelogContentHash
      || versionState.changed
      || await git(root, ["rev-parse", "refs/heads/PreRelease^{commit}"]) !== state.head) throw new Error("frozen publication candidate changed");
    return { ...checkpoint, releaseRoot: root, reused: true };
  }
  await validateBeforeCommit();
  if (checkpoint.phase !== "freezing") {
    if (checkpoint.phase !== "prepared" || state.head !== checkpoint.preReleaseHead) throw new Error("publication must freeze the exact prepared release head");
    const preparedHead = state.head;
    const oldMain = await git(root, ["rev-parse", "refs/heads/main^{commit}"]);
    const oldPreRelease = await git(root, ["rev-parse", "refs/heads/PreRelease^{commit}"]);
    if (oldPreRelease !== preparedHead) throw new Error("prepared PreRelease branch changed");
    const versionState = await inspectAgentHubReleaseVersion({
      root: path.join(root, "AgentHub"), now: releaseDate,
    });
    const indexFile = path.join(marker.releaseGitCommonDir, `publication-freeze-index-${randomUUID()}`);
    let head = preparedHead;
    let changelogBlob = null;
    try {
      const environment = { GIT_INDEX_FILE: indexFile };
      await git(root, ["read-tree", preparedHead], environment);
      if (state.content !== null) {
        changelogBlob = await git(root, ["hash-object", "-w", "--path=CHANGELOG.md", "CHANGELOG.md"]);
        await git(root, ["update-index", "--add", "--cacheinfo", `100644,${changelogBlob},CHANGELOG.md`], environment);
      }
      for (const update of versionState.writes) {
        const relative = path.relative(root, update.file).replaceAll("\\", "/");
        const temporary = path.join(marker.releaseGitCommonDir, `publication-version-${randomUUID()}`);
        try {
          await writeFile(temporary, update.content, "utf8");
          const blob = await git(root, ["hash-object", "-w", `--path=${relative}`, temporary]);
          await git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${relative}`], environment);
        } finally { await rm(temporary, { force: true }); }
      }
      const tree = await git(root, ["write-tree"], environment);
      const oldTree = await git(root, ["rev-parse", `${preparedHead}^{tree}`]);
      if (tree !== oldTree) {
        const changed = (await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", oldTree, tree]))
          .split(/\r?\n/u).filter(Boolean);
        const allowed = new Set(["CHANGELOG.md", "AgentHub/package.json", "AgentHub/package-lock.json"]);
        if (changed.some((file) => !allowed.has(file))) throw new Error("publication freeze would change source files");
        head = await git(root, ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@local.invalid",
          "commit-tree", tree, "-p", preparedHead, "-m", "release: freeze version and changelog"]);
      }
    } finally { await rm(indexFile, { force: true }); }
    const changelogContentHash = state.content === null ? null : digest(state.content);
    manifest = { ...manifest, workspaceId, publication: {
      preparedHead, head, changelogBlob, changelogContentHash, releaseVersion: versionState.version,
      sourceManifestHash: checkpoint.manifestHash,
    } };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestHash = digest(text);
    const manifestFile = path.join(layout.evidenceRoot, `${manifestHash}.json`);
    await writeFile(manifestFile, text, "utf8");
    checkpoint = { ...checkpoint, phase: "freezing", manifestHash, manifestFile, preReleaseHead: head,
      publicationFreeze: {
        preparedHead, oldMain, oldPreRelease, changelogBlob, changelogContentHash,
        releaseVersion: versionState.version,
      }, updatedAt: new Date().toISOString() };
    await save(layout.checkpointFile, checkpoint);
    await onPhase("intent");
  }
  const intent = checkpoint.publicationFreeze;
  if (!intent || manifest.publication?.head !== checkpoint.preReleaseHead
    || manifest.publication?.preparedHead !== intent.preparedHead
    || manifest.publication?.changelogContentHash !== intent.changelogContentHash
    || manifest.publication?.changelogBlob !== intent.changelogBlob
    || manifest.publication?.releaseVersion !== intent.releaseVersion) throw new Error("publication freeze intent is incomplete");
  state = await inspect();
  if (![intent.preparedHead, checkpoint.preReleaseHead].includes(state.head)) throw new Error("release branch moved during publication freeze");
  const actualBlob = state.content === null ? null : await git(root, ["hash-object", "--path=CHANGELOG.md", "CHANGELOG.md"]);
  if (actualBlob !== intent.changelogBlob
    || (state.content === null ? null : digest(state.content)) !== intent.changelogContentHash) throw new Error("publication CHANGELOG no longer matches frozen content");
  await validateBeforeCommit();
  for (const [ref, previous] of [["refs/heads/PreRelease", intent.oldPreRelease], ["refs/heads/main", intent.oldMain]]) {
    const current = await git(root, ["rev-parse", `${ref}^{commit}`]);
    if (current !== checkpoint.preReleaseHead) {
      if (current !== previous) throw new Error(`release ref changed during publication freeze: ${ref}`);
      await git(root, ["update-ref", ref, checkpoint.preReleaseHead, previous]);
    }
  }
  await git(root, ["read-tree", "--reset", "-u", checkpoint.preReleaseHead]);
  await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await onPhase("refs");
  state = await inspect();
  if (state.dirty || state.head !== checkpoint.preReleaseHead) throw new Error("publication freeze did not produce a clean exact candidate");
  checkpoint = { ...checkpoint, phase: "frozen", updatedAt: new Date().toISOString() };
  await save(layout.checkpointFile, checkpoint);
  return { ...checkpoint, releaseRoot: root, reused: false };
}
