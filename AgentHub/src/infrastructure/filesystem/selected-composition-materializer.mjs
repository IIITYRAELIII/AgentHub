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

// Only Git's built-in, bounded EOL serialization is supported. These reads
// never invoke clean/smudge, ident or encoding transformations.
export async function readSelectedCheckoutAuthority(git, paths) {
  // The Git caller owns one process-tree guard; its children are sequential.
  const rawConfig = await git(["config", "--null", "--get-regexp", "^core\\.(autocrlf|eol|safecrlf)$"],
    { acceptableExitCodes: [1] });
  const rawAttrs = paths.length ? await git(["check-attr", "-z", "text", "eol", "filter",
    "working-tree-encoding", "ident", "--", ...paths]) : "";
  const config = { autocrlf: null, eol: null, safecrlf: null };
  for (const entry of String(rawConfig).split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n");
    const key = entry.slice(0, split).replace(/^core\./u, "");
    if (split < 0 || !Object.hasOwn(config, key)) throw new Error("Selected checkout config is malformed");
    config[key] = entry.slice(split + 1);
  }
  const fields = String(rawAttrs).split("\0");
  if (fields.at(-1) === "") fields.pop();
  const attributes = paths.map((name) => ({ path: name }));
  if (fields.length !== paths.length * 15) throw new Error("Selected checkout attributes are incomplete");
  for (let i = 0; i < fields.length; i += 3) {
    const row = attributes.find((entry) => entry.path === fields[i]);
    if (!row || Object.hasOwn(row, fields[i + 1])) throw new Error("Selected checkout attributes are ambiguous");
    row[fields[i + 1]] = fields[i + 2];
  }
  return { version: 1, platform: process.platform, config, attributes };
}

function checkoutBytes(bytes, authority, name) {
  const attrs = authority.attributes.find((row) => row.path === name);
  const { autocrlf, eol, safecrlf } = authority.config;
  if (!attrs || ![null, "true", "false", "input"].includes(autocrlf)
      || ![null, "native", "lf", "crlf"].includes(eol)
      || ![null, "true", "false", "warn"].includes(safecrlf)
      || !["set", "unset", "unspecified", "auto"].includes(attrs.text)
      || !["unspecified", "lf", "crlf"].includes(attrs.eol)
      || ["filter", "ident", "working-tree-encoding"].some((key) =>
        !["unspecified", "unset"].includes(attrs[key]))) {
    throw new Error(`Selected checkout has unsupported transformation: ${name}`);
  }
  if (attrs.text === "unset") return bytes;
  const explicit = attrs.text === "set" || attrs.eol !== "unspecified";
  if (!explicit && attrs.text !== "auto" && !["true", "input"].includes(autocrlf)) return bytes;
  if (!explicit && bytes.subarray(0, 8000).includes(0)) return bytes;
  // Git's auto mode preserves existing CR-containing blobs; forced text with
  // such a blob would require a normalization decision outside this protocol.
  if (bytes.includes(13)) {
    if (!explicit) return bytes;
    throw new Error(`Selected checkout requires unsupported raw text normalization: ${name}`);
  }
  if (bytes.includes(0) || bytes.some((value) => (value < 32 && value !== 9 && value !== 10) || value === 127)) {
    throw new Error(`Selected checkout text classification is unsupported: ${name}`);
  }
  const outputEol = attrs.eol !== "unspecified" ? attrs.eol
    : autocrlf === "true" ? "crlf" : autocrlf === "input" ? "lf"
      : eol && eol !== "native" ? eol : authority.platform === "win32" ? "crlf" : "lf";
  return outputEol === "crlf" ? Buffer.from(bytes.toString("latin1").replace(/\n/gu, "\r\n"), "latin1") : bytes;
}

function checkedBlob(bytes, id, name) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES || !SHA.test(id)
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== id) {
    throw new Error(`Selected composition pinned blob changed or exceeds its bound: ${name}`);
  }
  return bytes;
}

async function assertCheckout(record, readCheckout) {
  if (typeof readCheckout !== "function"
      || JSON.stringify(await readCheckout(record.files.map((file) => file.path))) !== JSON.stringify(record.checkout)) {
    throw new Error("Selected composition checkout authority changed");
  }
}

export async function verifySelectedCompositionFiles(record, { root, files, readBlob, readCheckout, phase = null } = {}) {
  if (record.version !== 2 || typeof root !== "string" || path.resolve(record.root) !== path.resolve(root)
      || !Array.isArray(files) || typeof readBlob !== "function"
      || JSON.stringify(record.files.map(({ path, kind, oldBlob, newBlob }) => ({ path, kind, oldBlob, newBlob })))
        !== JSON.stringify(files)) {
    throw new Error("Selected composition materialization version or Git plan is unsupported");
  }
  await assertCheckout(record, readCheckout);
  for (const file of record.files) {
    const next = checkedBlob(await readBlob(file.newBlob), file.newBlob, file.path);
    const staged = checkoutBytes(next, record.checkout, file.path);
    if (digest(next) !== file.newGitSha256 || digest(staged) !== file.newSha256) {
      throw new Error("Selected composition staged serialization changed");
    }
    await assertBytes(file.temp, file.newSha256, "staged");
    if (file.kind === "M") {
      const old = checkedBlob(await readBlob(file.oldBlob), file.oldBlob, file.path);
      const oldPhysical = file.oldSerialization === "raw" ? old
        : file.oldSerialization === "checkout" ? checkoutBytes(old, record.checkout, file.path) : null;
      if (!oldPhysical || digest(old) !== file.oldGitSha256 || digest(oldPhysical) !== file.oldSha256) {
        throw new Error("Selected composition old serialization changed");
      }
      if (phase === "before_cas") await assertBytes(filePath(record.root, file.path), file.oldSha256, "old tracked");
      if (await existing(file.backup)) await assertBytes(file.backup, file.oldSha256, "backup");
    } else if (phase === "before_cas" && await existing(filePath(record.root, file.path))) {
      throw new Error("Selected composition added path is already occupied");
    }
    if (phase === "applied") {
      const target = filePath(record.root, file.path);
      await assertParents(record.root, target);
      if (!await sameFile(target, file.temp)) throw new Error("Selected composition applied target ownership changed");
      await assertBytes(target, file.newSha256, "owned target");
      if (file.kind === "M" && !await existing(file.backup)) throw new Error("Selected composition applied backup missing");
    }
  }
  await assertCheckout(record, readCheckout);
  return record;
}

export async function prepareSelectedCompositionFiles({ root, journalRoot, files, readBlob, readCheckout }) {
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
  const checkout = await readCheckout(files.map((file) => file.path));
  const prepared = [];
  for (const [index, file] of files.entries()) {
    const target = filePath(worktree, file.path);
    await assertParents(worktree, target);
    const newGit = checkedBlob(await readBlob(file.newBlob), file.newBlob, file.path);
    const newBytes = checkoutBytes(newGit, checkout, file.path);
    if (!Buffer.isBuffer(newBytes) || newBytes.length > MAX_FILE_BYTES) {
      throw new Error(`Selected composition blob exceeds its bound: ${file.path}`);
    }
    const temp = path.join(journalRoot, `new-${index}`);
    const backup = path.join(journalRoot, `old-${index}`);
    await writeExclusive(temp, newBytes);
    const oldBytes = file.kind === "M" ? checkedBlob(await readBlob(file.oldBlob), file.oldBlob, file.path) : null;
    let oldPhysical = oldBytes;
    let oldSerialization = "raw";
    if (oldBytes && (!Buffer.isBuffer(oldBytes) || oldBytes.length > MAX_FILE_BYTES)) {
      throw new Error(`Selected composition old blob exceeds its bound: ${file.path}`);
    }
    const current = await existing(target);
    if (file.kind === "A" && current) {
      throw new Error(`Selected composition added path is already occupied: ${file.path}`);
    }
    if (file.kind === "M") {
      if (!current?.isFile() || current.isSymbolicLink() || current.size > MAX_FILE_BYTES) {
        throw new Error(`Selected composition tracked path shape changed: ${file.path}`);
      }
      oldPhysical = await readFile(target);
      const converted = checkoutBytes(oldBytes, checkout, file.path);
      if (!oldPhysical.equals(oldBytes) && !oldPhysical.equals(converted)) {
        throw new Error(`Selected composition old tracked bytes changed: ${target}`);
      }
      oldSerialization = oldPhysical.equals(oldBytes) ? "raw" : "checkout";
      await assertBytes(target, digest(oldPhysical), "old tracked");
    }
    prepared.push({ ...file, oldSerialization, oldGitSha256: oldBytes ? digest(oldBytes) : null,
      newGitSha256: digest(newGit), oldSha256: oldPhysical ? digest(oldPhysical) : null,
      newSha256: digest(newBytes), temp, backup });
  }
  const record = { version: 2, root: worktree, journalRoot: path.resolve(journalRoot), checkout, files: prepared };
  await verifySelectedCompositionFiles(record, { root: worktree, files, readBlob, readCheckout, phase: "before_cas" });
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

export async function readSelectedCompositionFiles(journalRoot, expected = null, binding = {}) {
  const record = JSON.parse(await readFile(path.join(journalRoot, "record.json"), "utf8"));
  if (record.version !== 2 || path.resolve(record.journalRoot) !== path.resolve(journalRoot)
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
  return verifySelectedCompositionFiles(record, binding);
}

export async function applySelectedCompositionFiles(record, { beforeLink = null, ...binding } = {}) {
  await verifySelectedCompositionFiles(record, binding);
  for (const file of record.files) {
    const target = filePath(record.root, file.path);
    await assertParents(record.root, target);
    await assertCheckout(record, binding.readCheckout);
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
      await assertCheckout(record, binding.readCheckout);
      await link(file.temp, target); // Atomic EEXIST refusal on a late collision.
    }
    if (!await sameFile(target, file.temp)) {
      throw new Error(`Selected composition target is occupied by foreign bytes: ${file.path}`);
    }
    await assertBytes(target, file.newSha256, "owned target");
  }
}

export async function rollbackSelectedCompositionFiles(record, binding = {}) {
  await verifySelectedCompositionFiles(record, binding);
  const foreign = [];
  for (const file of [...record.files].reverse()) {
    await assertCheckout(record, binding.readCheckout);
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
