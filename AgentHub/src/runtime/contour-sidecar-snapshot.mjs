import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const QUEUE_DIRECTORIES = ["delivery-outbox", "background-jobs"];
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const identity = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unstable = (message) => Object.assign(new Error(message), { code: "COHORT_SIDECARS_CHANGED" });

// This captures inert evidence, not executable jobs. Preparation must still
// validate each owner schema and route every recovered effect to an adapter.
// Reads before and after SQLite pinning/copying establish a common disk window;
// they neither drain owners nor claim an atomic cross-store business commit.
export async function readContourQueueFiles(source) {
  const directories = [];
  let bytes = 0;
  for (const name of QUEUE_DIRECTORIES) {
    const directory = path.join(source, name);
    let before;
    try { before = await lstat(directory, { bigint: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      directories.push({ name, absent: true, files: [] });
      continue;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`Unsafe queue directory: ${name}`);
    const names = (await readdir(directory)).sort();
    if (names.length > 2_000) throw new Error(`Queue capture inventory exceeds limit: ${name}`);
    const files = [];
    for (const file of names) {
      const filePath = path.join(directory, file);
      const initial = await lstat(filePath, { bigint: true });
      if (!initial.isFile() || initial.isSymbolicLink()) throw new Error(`Unsafe queue entry: ${name}/${file}`);
      // Owners admit only .json records. Temporary and quarantined files are
      // not jobs; retain their inventory so concurrent transitions are visible.
      if (!file.endsWith(".json")) continue;
      if (initial.size > BigInt(MAX_FILE_BYTES) || bytes + Number(initial.size) > MAX_BYTES) {
        throw new Error("Queue capture byte budget exceeded");
      }
      const handle = await open(filePath, "r");
      let body;
      try {
        if (identity(await handle.stat({ bigint: true })) !== identity(initial)) throw unstable("Queue file replaced before read");
        // Allocate only the validated size. A concurrent append must not make
        // readFile allocate beyond the capture budget before we detect it.
        body = Buffer.alloc(Number(initial.size));
        let offset = 0;
        while (offset < body.length) {
          const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
          if (!bytesRead) throw unstable("Queue file truncated during read");
          offset += bytesRead;
        }
        if (identity(await handle.stat({ bigint: true })) !== identity(initial)) throw unstable("Queue file changed during read");
      } finally { await handle.close(); }
      if (identity(await lstat(filePath, { bigint: true })) !== identity(initial)) throw unstable("Queue file replaced during read");
      if (body.length !== Number(initial.size)) throw unstable("Queue file size changed during read");
      bytes += body.length;
      files.push({ name: file, identity: identity(initial), bytes: body.length, sha256: digest(body), body });
    }
    const after = await lstat(directory, { bigint: true });
    if (identity(before) !== identity(after)) throw unstable(`Queue directory changed during read: ${name}`);
    directories.push({ name, absent: false, identity: identity(before), names, files });
  }
  return { bytes, directories };
}

function comparable(snapshot) {
  return snapshot.directories.map(({ name, absent, identity, names, files }) => ({
    name, absent, identity, names,
    files: files.map(({ body: _body, ...metadata }) => metadata),
  }));
}

export async function verifyContourQueueFiles(source, before) {
  let after;
  try { after = await readContourQueueFiles(source); }
  catch (error) {
    if (error.code === "ENOENT") throw unstable("Queue entry disappeared across the SQLite cohort window");
    throw error;
  }
  if (JSON.stringify(comparable(before)) !== JSON.stringify(comparable(after))) {
    throw unstable("Queue files changed across the SQLite cohort window; discard this raw capture");
  }
}

export async function writeContourQueueFiles(root, snapshot) {
  const target = path.join(root, "queue-files");
  await mkdir(target);
  const evidence = [];
  for (const directory of snapshot.directories) {
    if (!directory.absent) await mkdir(path.join(target, directory.name));
    const files = [];
    for (const file of directory.files) {
      await writeFile(path.join(target, directory.name, file.name), file.body, { flag: "wx" });
      files.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
    }
    evidence.push({ name: directory.name, absent: directory.absent, files });
  }
  return { consistency: "unchanged-across-sqlite-cohort-window", bytes: snapshot.bytes, directories: evidence };
}
