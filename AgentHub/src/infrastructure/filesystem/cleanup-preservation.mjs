import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { sourceBlobs } from "./local-source-baseline.mjs";

const key = p => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const inside = (root, p) => key(p) !== key(root) && key(p).startsWith(`${key(root)}${path.sep}`);
async function bytes(file) {
  let current = path.parse(path.resolve(file)).root;
  for (const segment of path.relative(current, path.resolve(file)).split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw Error("Cleanup preservation cannot follow a reparse path");
  }
  if (!(await lstat(file)).isFile()) throw Error("Cleanup preservation requires regular files");
  return readFile(file);
}

// Read-only proof of the existing retained copies; this owner never copies or
// removes them. The original confirmed Delete remains the deletion authority.
export async function verifyCleanupPreservation({ allowedWorkspaces, workspaces, files, git }) {
  if (!Array.isArray(files)) throw Error("Exact cleanup preservation files are required");
  const represented = new Map();
  for (const item of files) {
    const allowed = allowedWorkspaces.find(w => key(w.projectRoot) === key(item.projectRoot));
    if (!allowed || typeof item.relativePath !== "string" || !item.relativePath || path.isAbsolute(item.relativePath)
        || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "") || typeof item.retainedPath !== "string") throw Error("Cleanup preservation identity differs");
    const source = path.resolve(allowed.projectRoot, item.relativePath), target = path.resolve(item.retainedPath);
    if (!inside(allowed.projectRoot, source) || key(source) === key(target)
        || allowedWorkspaces.some(w => inside(w.projectRoot, target) || key(w.projectRoot) === key(target))) throw Error("Retained cleanup file must be outside the deleted sources");
    const id = `${key(allowed.projectRoot)}\0${path.relative(allowed.projectRoot, source).replaceAll("\\", "/")}`;
    const hashes = represented.get(id) ?? new Set();
    if (hashes.has(item.sha256)) throw Error("Duplicate cleanup preservation file");
    const retained = await bytes(target);
    if (createHash("sha256").update(retained).digest("hex") !== item.sha256) throw Error("Retained cleanup file hash changed");
    hashes.add(item.sha256);
    represented.set(id, hashes);
  }
  for (const workspace of workspaces) {
    const readGit = (args, options = {}) => git(workspace.projectRoot, args, options);
    const records = async args => {
      const raw = Buffer.from(await readGit(args, { rawOutput: true })).toString("utf8");
      if (raw && !raw.endsWith("\0")) throw Error("Cleanup Git inventory is malformed");
      return raw.split("\0").filter(Boolean);
    };
    const head = new Map((await records(["ls-tree", "-r", "-z", "HEAD"])).map(record => {
      const match = /^([0-9]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/su.exec(record);
      if (!match) throw Error("Cleanup HEAD inventory is malformed");
      return [match[4], { type: match[2], oid: match[3] }];
    }));
    const changed = new Set(await records(["ls-files", "--modified", "--others", "--exclude-standard", "-z"]));
    const staged = new Map();
    for (const record of await records(["ls-files", "--stage", "-z"])) {
      const match = /^([0-9]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/su.exec(record);
      if (!match) throw Error("Cleanup index inventory is malformed");
      const [, mode, oid, stage, relative] = match;
      if (head.get(relative)?.oid === oid) continue;
      if (!/^100(?:644|755)$/u.test(mode)) throw Error("Cleanup preservation requires regular index files");
      staged.set(`${relative}\0${stage}`, { type: "blob", oid, relative });
      changed.add(relative);
    }
    const requireCopy = (relative, value) => {
      const hashes = represented.get(`${key(workspace.projectRoot)}\0${relative.replaceAll("\\", "/")}`);
      if (!hashes) throw Error("Dirty cleanup source has no exact preserved copy");
      if (!hashes.has(createHash("sha256").update(value).digest("hex"))) {
        throw Error("Cleanup source differs from its preserved file");
      }
    };
    // Index-vs-HEAD and working-vs-index are distinct byte states. Preserve
    // every unpublished stage, then the working bytes, collapsing only equal
    // content hashes. A retained working copy cannot stand in for the index.
    for (const [id, value] of await sourceBlobs(readGit, staged, [...staged.keys()])) {
      requireCopy(staged.get(id).relative, value);
    }
    for (const relative of changed) {
      const source = path.resolve(workspace.projectRoot, relative);
      if (!inside(workspace.projectRoot, source)) throw Error("Cleanup source path escapes its workspace");
      const value = await bytes(source).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (value === null) continue;
      const original = head.get(relative);
      const oid = original?.type === "blob" ? createHash(original.oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${value.length}\0`).update(value).digest("hex") : null;
      if (oid !== original?.oid) requireCopy(relative, value);
    }
  }
}
