import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

// A bounded source inventory, never a copy, cleanup or dependency preparation.
export async function readClaimCustodyWip(root, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 16 || new Set(paths).size !== paths.length) {
    throw new Error("Exact bounded WIP paths are required");
  }
  const normalized = paths.map(p => typeof p === "string" ? path.relative(root, path.resolve(root, p)).replaceAll("\\", "/") : "");
  for (const [index, name] of normalized.entries()) {
    if (!name || name.startsWith("../") || path.isAbsolute(name) || !name.split("/").includes("WIP")
        || normalized.some((other, j) => index !== j && (name === other || name.startsWith(`${other}/`)))) {
      throw new Error("WIP custody roots overlap or escape their source");
    }
  }
  const realRoot = await realpath(root);
  const records = [];
  let bytes = 0;
  async function visit(relative, depth = 0) {
    if (depth > 32 || records.length >= 10000) throw new Error("WIP custody inventory exceeds its budget");
    const file = path.resolve(root, relative);
    const canonical = path.relative(root, file).replaceAll("\\", "/");
    if (!canonical || canonical.startsWith("../") || path.isAbsolute(canonical)
        || canonical.split("/").some(v => [".git", "node_modules"].includes(v))) throw new Error("WIP custody path escaped its source");
    const parent = await realpath(path.dirname(file));
    const realRelative = path.relative(realRoot, parent);
    if (realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) {
      throw new Error("WIP parent link escaped its managed source");
    }
    const entry = await lstat(file);
    if (entry.isSymbolicLink()) {
      records.push({ path: canonical, type: "link", target: await readlink(file) });
    } else if (entry.isDirectory()) {
      const before = (await readdir(file)).sort();
      for (const name of before) await visit(path.join(relative, name), depth + 1);
      if (JSON.stringify(before) !== JSON.stringify((await readdir(file)).sort())) throw new Error("WIP directory changed during capture");
      if (!before.length) records.push({ path: canonical, type: "directory" });
    } else if (entry.isFile()) {
      bytes += entry.size;
      if (entry.size > 64 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error("WIP custody bytes exceed their budget");
      const raw = await readFile(file);
      const after = await lstat(file);
      if (after.ino !== entry.ino || after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || raw.length !== entry.size) {
        throw new Error("WIP changed during custody capture");
      }
      records.push({ path: canonical, type: "file", bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") });
    } else throw new Error("Unsupported WIP custody entry");
  }
  for (const relative of [...paths].sort()) {
    if (typeof relative !== "string" || !relative.replaceAll("\\", "/").split("/").includes("WIP")) {
      throw new Error("Custody inventory is limited to declared WIP paths");
    }
    await visit(relative);
  }
  records.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { digest: createHash("sha256").update(JSON.stringify(records)).digest("hex"), records };
}
