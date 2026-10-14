// Recovery-only implementation for already admitted v1 original identities.
// Remove after every supported v1 original is durably terminal; never admit new work here.
import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function filePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")
      || relative.split(/[\\/]/u).some((part) => part === "." || part === ".." || !part)) {
    throw new Error("Selected composition contains an unsafe path");
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("Selected composition path escaped its managed worktree");
  }
  return resolved;
}

async function existing(pathname) {
  return lstat(pathname).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function assertParents(root, target) {
  const first = path.resolve(root);
  const parents = [];
  for (let current = path.dirname(target); current !== first; current = path.dirname(current)) {
    if (!current.startsWith(`${first}${path.sep}`)) throw new Error("Selected composition parent escaped worktree");
    parents.push(current);
  }
  for (const parent of parents.reverse()) {
    const info = await existing(parent);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Selected composition requires an existing real directory: ${parent}`);
    }
  }
}

async function sameFile(first, second) {
  const [left, right] = await Promise.all([stat(first), stat(second)]);
  if (!left.ino || !right.ino || !left.dev || !right.dev) {
    throw new Error("Selected composition cannot prove hard-link ownership on this filesystem");
  }
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertBytes(pathname, expected, label) {
  const info = await lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES
      || digest(await readFile(pathname)) !== expected) {
    throw new Error(`Selected composition ${label} bytes changed: ${pathname}`);
  }
}

async function writeExclusive(pathname, bytes) {
  const handle = await open(pathname, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function discardIncompletePreparation(journalRoot, fileCount) {
  const directory = await existing(journalRoot);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Selected composition incomplete journal is not an owned directory");
  }
  const entries = await readdir(journalRoot, { withFileTypes: true });
  for (const entry of entries) {
    const staged = /^new-(0|[1-9][0-9]*)$/u.exec(entry.name);
    const recordTemporary = /^record\.json\.tmp-[0-9a-f-]{36}$/u.test(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()
        || (!recordTemporary && (!staged || Number(staged[1]) >= fileCount))) {
      // A completed record or a post-CAS backup is never discarded here.
      throw new Error(`Selected composition incomplete journal has unexpected entry: ${entry.name}`);
    }
    await unlink(path.join(journalRoot, entry.name));
  }
  await rmdir(journalRoot);
}

// Git's diff --raw -z is shape authority. This owner intentionally supports
// only existing regular-file edits and additions under existing directories.
// It does not infer safety from a precheck or ask checkout to overwrite ignored
// local files. The exclusive hard link below is the no-overwrite boundary.
export function selectedCompositionFilePlan(raw) {
  const fields = String(raw ?? "").split("\0").filter(Boolean);
  if (fields.length % 2 || fields.length / 2 > MAX_FILES) {
    throw new Error("Selected composition file delta is malformed or exceeds its bound");
  }
  const files = [];
  const names = new Set();
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u.exec(fields[index]);
    const name = fields[index + 1];
    if (!match || !name || names.has(name)) throw new Error("Selected composition file delta is malformed");
    names.add(name);
    const [, oldMode, newMode, oldBlob, newBlob, kind] = match;
    if (newMode !== "100644" || !SHA.test(newBlob)
        || !((kind === "M" && oldMode === "100644" && SHA.test(oldBlob))
          || (kind === "A" && oldMode === "000000" && oldBlob === "0".repeat(40)))) {
      throw new Error(`Selected composition cannot materialize path shape: ${name}`);
    }
    files.push({ path: name, kind, oldBlob: kind === "M" ? oldBlob : null, newBlob });
  }
  return files;
}

export async function prepareSelectedCompositionFiles({ root, journalRoot, files, readBlob }) {
  if (!Array.isArray(files) || files.length > MAX_FILES || typeof readBlob !== "function") {
    throw new Error("Selected composition file plan is invalid");
  }
  const worktree = path.resolve(root);
  try {
    await mkdir(journalRoot, { recursive: false });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // This function is called only while the exact dev ref is still old.
    // A process crash may leave new-N or an unpublished record temp; neither
    // has touched the worktree, so discard only those exact private names.
    await discardIncompletePreparation(journalRoot, files.length);
    await mkdir(journalRoot, { recursive: false });
  }
  const prepared = [];
  for (const [index, file] of files.entries()) {
    const target = filePath(worktree, file.path);
    await assertParents(worktree, target);
    const newBytes = await readBlob(file.newBlob);
    if (!Buffer.isBuffer(newBytes) || newBytes.length > MAX_FILE_BYTES) {
      throw new Error(`Selected composition blob exceeds its bound: ${file.path}`);
    }
    const temp = path.join(journalRoot, `new-${index}`);
    const backup = path.join(journalRoot, `old-${index}`);
    await writeExclusive(temp, newBytes);
    const oldBytes = file.kind === "M" ? await readBlob(file.oldBlob) : null;
    if (oldBytes && (!Buffer.isBuffer(oldBytes) || oldBytes.length > MAX_FILE_BYTES)) {
      throw new Error(`Selected composition old blob exceeds its bound: ${file.path}`);
    }
    const current = await existing(target);
    if (file.kind === "A" && current) {
      throw new Error(`Selected composition added path is already occupied: ${file.path}`);
    }
    if (file.kind === "M") {
      if (!current?.isFile() || current.isSymbolicLink()) {
        throw new Error(`Selected composition tracked path shape changed: ${file.path}`);
      }
      await assertBytes(target, digest(oldBytes), "old tracked");
    }
    prepared.push({ ...file, oldSha256: oldBytes ? digest(oldBytes) : null,
      newSha256: digest(newBytes), temp, backup });
  }
  const record = { version: 1, root: worktree, journalRoot: path.resolve(journalRoot), files: prepared };
  const recordPath = path.join(journalRoot, "record.json");
  const temporaryRecord = path.join(journalRoot, `record.json.tmp-${randomUUID()}`);
  await writeExclusive(temporaryRecord, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
  try {
    await link(temporaryRecord, recordPath);
  } finally {
    await unlink(temporaryRecord).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return record;
}

export async function readSelectedCompositionFiles(journalRoot, expected = null) {
  const record = JSON.parse(await readFile(path.join(journalRoot, "record.json"), "utf8"));
  if (record.version !== 1 || path.resolve(record.journalRoot) !== path.resolve(journalRoot)
      || !Array.isArray(record.files) || record.files.length > MAX_FILES
      || (expected && JSON.stringify(record) !== JSON.stringify(expected))) {
    throw new Error("Selected composition materialization identity changed");
  }
  for (const [index, file] of record.files.entries()) {
    filePath(record.root, file.path);
    if (file.temp !== path.join(journalRoot, `new-${index}`)
        || file.backup !== path.join(journalRoot, `old-${index}`)
        || !/^[0-9a-f]{64}$/u.test(file.newSha256)
        || (file.kind === "M" && !/^[0-9a-f]{64}$/u.test(file.oldSha256))) {
      throw new Error("Selected composition materialization path or digest changed");
    }
    await assertBytes(file.temp, file.newSha256, "staged");
  }
  return record;
}

export async function applySelectedCompositionFiles(record, { beforeLink = null } = {}) {
  for (const file of record.files) {
    const target = filePath(record.root, file.path);
    await assertParents(record.root, target);
    await assertBytes(file.temp, file.newSha256, "staged");
    if (file.kind === "M" && !await existing(file.backup)) {
      await assertBytes(target, file.oldSha256, "old tracked");
      await rename(target, file.backup);
      // A foreign writer may have raced the old-content read. Its bytes are
      // retained in the private journal, never discarded or overwritten.
      await assertBytes(file.backup, file.oldSha256, "moved old tracked");
    }
    if (file.kind === "M") await assertBytes(file.backup, file.oldSha256, "backup");
    if (!await existing(target)) {
      if (beforeLink) await beforeLink(file, target);
      await link(file.temp, target); // Atomic EEXIST refusal on a late collision.
    }
    if (!await sameFile(target, file.temp)) {
      throw new Error(`Selected composition target is occupied by foreign bytes: ${file.path}`);
    }
    await assertBytes(target, file.newSha256, "owned target");
  }
}

export async function rollbackSelectedCompositionFiles(record) {
  const foreign = [];
  for (const file of [...record.files].reverse()) {
    const target = filePath(record.root, file.path);
    const present = await existing(target);
    if (present) {
      if (!await sameFile(target, file.temp)) {
        if (file.kind === "M" && !await existing(file.backup)) {
          await assertBytes(target, file.oldSha256, "unmodified tracked");
          continue;
        }
        // An added path was never ours, or ours was replaced. Either way its
        // present bytes belong to someone else and must stay untouched. A
        // modified path additionally needs its old backup restored, so only
        // that case makes the rollback incomplete.
        if (file.kind === "M") foreign.push(file.path);
        continue;
      }
      await assertBytes(target, file.newSha256, "owned target");
      await unlink(target);
    }
    if (file.kind === "M" && await existing(file.backup)) {
      await assertBytes(file.backup, file.oldSha256, "backup");
      await link(file.backup, target); // Never overwrite a late private target.
      await assertBytes(target, file.oldSha256, "restored tracked");
    }
  }
  if (foreign.length) {
    throw new Error(`Selected composition rollback preserves foreign target: ${foreign.join(", ")}`);
  }
}
