import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const PUBLISHED_NOTES_ARCHIVE = "published-native-await-archive-v1";
const sha = value => createHash("sha256").update(value).digest("hex");
const encode = value => JSON.stringify(value);
const refuse = message => { throw Object.assign(new Error(`Native Await archive: ${message}`), { code: "AWAIT_PREPARATION_UNKNOWN" }); };
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const exists = file => lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
async function physical(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) refuse("directory must be physical");
}
async function regular(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) refuse("evidence must be bounded regular files");
  return readFile(file);
}
function normalized(bytes) {
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes) || bytes.includes(0)) refuse("notes must be UTF-8 text");
  return bytes.toString("utf8").replaceAll("\r\n", "\n");
}
function packageWithoutVersion(bytes, lock) {
  const value = JSON.parse(bytes);
  if (typeof value.version !== "string" || !value.version) refuse("package version evidence absent");
  delete value.version;
  if (lock) {
    if (typeof value.packages?.[""]?.version !== "string") refuse("root lock version absent");
    delete value.packages[""].version;
  }
  return encode(value);
}
function originalIdentity(original) {
  const fields = ["operationId", "taskId", "workspaceId", "argumentsHash", "resultCommit", "originMainCommit"];
  if (!original || fields.some(key => typeof original[key] !== "string" || !original[key] || original[key].length > 300)
      || !/^[a-f0-9]{64}$/u.test(original.argumentsHash) || !/^[a-f0-9]{40}$/u.test(original.resultCommit)
      || !/^[a-f0-9]{40}$/u.test(original.originMainCommit)
      || !Number.isSafeInteger(original.taskRevision) || original.taskRevision < 1) refuse("original identity absent");
  return Object.fromEntries([...fields, "taskRevision"].map(key => [key, original[key]]));
}
async function immutable(file, bytes) {
  try { await writeFile(file, bytes, { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; if (!(await regular(file)).equals(bytes)) refuse("archive evidence changed"); }
}

// Called by the existing candidate owner under its release Git lease. No Git
// ref/index writes, cleanup or custom checkout serialization occurs here.
export async function inspectPublishedNotesArchive({ layout, original, publishedRevision, frozenTasks = [], gitAt, assertClone, readJson }) {
  const identity = originalIdentity(original);
  const selection = frozenTasks.map(task => ({ taskId: task.taskId, taskRevision: task.taskRevision,
    baseCommit: task.baseCommit, resultCommit: task.resultCommit }));
  if (!/^[a-f0-9]{40}$/u.test(publishedRevision) || selection.length !== 1
      || selection[0].taskId !== identity.taskId || selection[0].resultCommit !== identity.resultCommit) refuse("exact single original selection required");
  await physical(layout.root);
  const journal = await readJson(path.join(layout.root, "native-preparation.json"));
  const retained = journal?.publishedNotesArchive;
  if (retained) {
    if (encode(retained.original) !== encode(identity) || retained.publishedRevision !== publishedRevision) refuse("original or publication changed");
    const archiveRoot = path.join(layout.root, "await-archives", retained.archiveKey);
    if (!/^[a-f0-9]{64}$/u.test(retained.archiveKey) || !samePath(archiveRoot, retained.archiveRoot)) refuse("archive path changed");
    if (retained.kind !== PUBLISHED_NOTES_ARCHIVE || journal.requestId !== identity.operationId) refuse("archive journal owner changed");
    await physical(path.dirname(archiveRoot)); await physical(archiveRoot);
    const evidenceBytes = await regular(path.join(archiveRoot, "evidence.json"));
    if (sha(evidenceBytes) !== retained.evidenceSha256) refuse("archive evidence digest changed");
    const proof = JSON.parse(evidenceBytes);
    if (proof.kind !== PUBLISHED_NOTES_ARCHIVE || encode(proof.original) !== encode(identity)
        || encode(proof.selection) !== encode(selection) || proof.publishedRevision !== publishedRevision) refuse("archive binding changed");
    if (journal.phase === "published-notes-archiving") {
      const repository = await exists(layout.releaseRoot) ? layout.releaseRoot : path.join(archiveRoot, "repository");
      if (await exists(layout.releaseRoot) && await exists(path.join(archiveRoot, "repository"))) refuse("ambiguous archive move");
      await verifyPhysicalState({ repository, checkpointFile: await exists(layout.checkpointFile)
        ? layout.checkpointFile : path.join(archiveRoot, "checkpoint.json"), proof, gitAt });
    } else await verifyRetained({ archiveRoot, proof, gitAt });
    return { ...retained, proof, resuming: true };
  }
  if (!journal || journal.version !== 1 || journal.policy !== "main-selected-git-merge-v1"
      || journal.phase !== "completed" || journal.publishedNotesArchive) refuse("prior native preparation is unresolved");
  const marker = await assertClone(layout.releaseRoot);
  if (!samePath(marker.primaryRoot, layout.primaryRoot) || !samePath(marker.releaseRoot, layout.releaseRoot)) refuse("clone owner changed");
  const repoInfo = await lstat(layout.releaseRoot), gitInfo = await lstat(path.join(layout.releaseRoot, ".git"));
  if (!repoInfo.isDirectory() || repoInfo.isSymbolicLink() || !gitInfo.isDirectory() || gitInfo.isSymbolicLink()) refuse("standalone physical clone required");
  const checkpointBytes = await regular(layout.checkpointFile), checkpoint = JSON.parse(checkpointBytes);
  const manifestFile = path.join(layout.evidenceRoot, `${checkpoint.manifestHash}.json`);
  if (!samePath(checkpoint.manifestFile, manifestFile)) refuse("checkpoint manifest path changed");
  const manifestBytes = await regular(manifestFile), manifest = JSON.parse(manifestBytes);
  if (sha(manifestBytes) !== checkpoint.manifestHash || checkpoint.phase !== "prepared"
      || checkpoint.compositionPolicy !== "main-selected-git-merge-v1" || manifest.compositionPolicy !== checkpoint.compositionPolicy
      || journal.target !== checkpoint.preReleaseHead || journal.manifestHash !== checkpoint.manifestHash
      || manifest.workspaceId !== identity.workspaceId || !samePath(manifest.primaryRoot, layout.primaryRoot)
      || !samePath(manifest.releaseRoot, layout.releaseRoot)) refuse("prior prepared identity changed");
  const selected = new Set(frozenTasks.map(task => task.taskId));
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length || manifest.tasks.some(task => selected.has(task.taskId) || task.taskId === identity.taskId)) refuse("prior candidate overlaps current selection");
  const git = (args, rawOutput = false) => gitAt(layout.releaseRoot, ["--no-optional-locks", ...args], { rawOutput });
  const head = await git(["rev-parse", "HEAD^{commit}"]);
  if (head !== checkpoint.preReleaseHead || await git(["rev-parse", "refs/heads/PreRelease^{commit}"]) !== head
      || await git(["rev-parse", "HEAD^{tree}"]) !== journal.targetTree
      || await git(["symbolic-ref", "HEAD"]) !== "refs/heads/PreRelease") refuse("prior refs changed");
  for (const entry of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock"]) {
    if (await exists(path.join(marker.releaseGitCommonDir, entry))) refuse("unfinished Git operation");
  }
  if (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]) !== "M  CHANGELOG.md\0") refuse("not the sole staged published notes state");
  const notes = await regular(path.join(layout.releaseRoot, "CHANGELOG.md"));
  const staged = Buffer.from(await git(["show", ":CHANGELOG.md"], true));
  const publishedNotes = Buffer.from(await git(["show", `${publishedRevision}:CHANGELOG.md`], true));
  if (!staged.equals(publishedNotes) || normalized(notes) !== normalized(staged)) refuse("notes differ from OWN publication");
  const entries = String(await git(["ls-files", "--stage", "--", "CHANGELOG.md"]));
  if (!/^100644 [a-f0-9]{40} 0\tCHANGELOG\.md$/u.test(entries)) refuse("notes mode or index stage changed");
  const differences = String(await git(["diff", "--name-only", "--no-renames", "-z", head, publishedRevision])).split("\0").filter(Boolean);
  if (differences.some(file => !["CHANGELOG.md", "AgentHub/package.json", "AgentHub/package-lock.json"].includes(file))) refuse("unpublished source differs");
  for (const file of ["AgentHub/package.json", "AgentHub/package-lock.json"]) {
    for (const revision of [head, publishedRevision]) {
      if (!String(await git(["ls-tree", revision, "--", file])).startsWith("100644 blob ")) refuse("package mode changed");
    }
    const old = Buffer.from(await git(["show", `${head}:${file}`], true)), published = Buffer.from(await git(["show", `${publishedRevision}:${file}`], true));
    if (packageWithoutVersion(old, file.endsWith("package-lock.json")) !== packageWithoutVersion(published, file.endsWith("package-lock.json"))) refuse("unpublished package content differs");
  }
  const priorJournalBytes = await regular(path.join(layout.root, "native-preparation.json"));
  const indexBytes = await regular(path.join(marker.releaseGitCommonDir, "index"));
  const proof = { kind: PUBLISHED_NOTES_ARCHIVE, original: identity, selection, publishedRevision, head,
    checkpointSha256: sha(checkpointBytes), manifestSha256: sha(manifestBytes),
    priorJournalSha256: sha(priorJournalBytes), indexSha256: sha(indexBytes), notesSha256: sha(notes),
    checkpointBytesBase64: checkpointBytes.toString("base64"), manifestBytesBase64: manifestBytes.toString("base64"),
    priorJournalBytesBase64: priorJournalBytes.toString("base64"), indexBytesBase64: indexBytes.toString("base64"),
    notesBytesBase64: notes.toString("base64"), indexEntriesSha256: sha(Buffer.from(await git(["ls-files", "--stage", "-z"], true))) };
  const evidenceBytes = Buffer.from(encode(proof) + "\n"), archiveKey = sha(evidenceBytes);
  if (evidenceBytes.length > 16 * 1024 * 1024) refuse("archive proof exceeds bounded evidence size");
  return { kind: PUBLISHED_NOTES_ARCHIVE, original: identity, publishedRevision, archiveKey, archiveRoot: path.join(layout.root, "await-archives", archiveKey),
    evidenceSha256: archiveKey, proof, resuming: false };
}

async function verifyRetained({ archiveRoot, proof, gitAt }) {
  return verifyPhysicalState({ repository: path.join(archiveRoot, "repository"),
    checkpointFile: path.join(archiveRoot, "checkpoint.json"), proof, gitAt });
}
async function verifyPhysicalState({ repository, checkpointFile, proof, gitAt }) {
  await physical(repository); await physical(path.join(repository, ".git"));
  const git = (args, rawOutput = false) => gitAt(repository, ["--no-optional-locks", ...args], { rawOutput });
  if (await git(["rev-parse", "HEAD^{commit}"]) !== proof.head || await git(["rev-parse", "refs/heads/PreRelease^{commit}"]) !== proof.head
      || await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]) !== "M  CHANGELOG.md\0"
      || sha(Buffer.from(await git(["ls-files", "--stage", "-z"], true))) !== proof.indexEntriesSha256
      || sha(await regular(path.join(repository, "CHANGELOG.md"))) !== proof.notesSha256
      || sha(await regular(path.join(repository, ".git/index"))) !== proof.indexSha256
      || sha(await regular(checkpointFile)) !== proof.checkpointSha256) refuse("retained physical state changed");
  for (const entry of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock"]) {
    if (await exists(path.join(repository, ".git", entry))) refuse("unfinished retained Git operation");
  }
}

export async function archivePublishedNotesCheckout(options) {
  const { layout, writeJson } = options;
  let inspected = await inspectPublishedNotesArchive(options);
  const { proof, resuming, ...descriptor } = inspected;
  const base = await realpath(layout.root), archiveRoot = descriptor.archiveRoot;
  if (!samePath(base, layout.root) || !samePath(path.dirname(path.dirname(archiveRoot)), base)) refuse("archive must stay in the owning workspace");
  await mkdir(archiveRoot, { recursive: true });
  for (const directory of [path.dirname(archiveRoot), archiveRoot]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) refuse("archive directory must be physical");
  }
  await immutable(path.join(archiveRoot, "evidence.json"), Buffer.from(encode(proof) + "\n"));
  const journalFile = path.join(layout.root, "native-preparation.json");
  let journal = await options.readJson(journalFile);
  if (!resuming) {
    // Recheck every pin immediately before persisting the owning move intent.
    inspected = await inspectPublishedNotesArchive(options);
    if (inspected.evidenceSha256 !== descriptor.evidenceSha256) refuse("archive raced before intent");
    await options.validate();
    journal = { version: 1, policy: "main-selected-git-merge-v1", phase: "published-notes-archiving",
      requestId: descriptor.original.operationId, publishedNotesArchive: descriptor };
    await writeJson(journalFile, journal);
  }
  if (journal.phase === "published-notes-archiving") {
    await options.validate();
    await inspectPublishedNotesArchive(options);
    const retainedRepo = path.join(archiveRoot, "repository");
    if (await exists(layout.releaseRoot)) {
      if (await exists(retainedRepo)) refuse("both repository locations exist during archive");
      // Both resolved destinations are bounded above. Rename preserves the whole
      // standalone clone, including ignored/private bytes, refs and raw index.
      const sourceInfo = await lstat(layout.releaseRoot);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !samePath(await realpath(layout.releaseRoot), layout.releaseRoot)) refuse("source move target changed");
      await rename(layout.releaseRoot, retainedRepo);
    }
    if (await exists(layout.checkpointFile)) {
      if (await exists(path.join(archiveRoot, "checkpoint.json"))) refuse("both checkpoint locations exist");
      if (sha(await regular(layout.checkpointFile)) !== proof.checkpointSha256) refuse("checkpoint raced before archive");
      await rename(layout.checkpointFile, path.join(archiveRoot, "checkpoint.json"));
    }
    await verifyRetained({ archiveRoot, proof, gitAt: options.gitAt });
    journal.phase = "published-notes-archived";
    await writeJson(journalFile, journal);
  }
  await verifyRetained({ archiveRoot, proof, gitAt: options.gitAt });
  return { descriptor, cutover: { version: 1, kind: PUBLISHED_NOTES_ARCHIVE,
    originalOperationId: descriptor.original.operationId, archiveRoot, evidenceSha256: descriptor.evidenceSha256,
    priorHead: proof.head, priorCheckpointSha256: proof.checkpointSha256, publishedRevision: descriptor.publishedRevision } };
}
