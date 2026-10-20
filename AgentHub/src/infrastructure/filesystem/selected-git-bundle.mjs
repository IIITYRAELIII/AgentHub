import { lstat, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function plainScratch(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name), info = await lstat(target);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("bundle-scratch-custody-changed");
    if (info.isDirectory()) await plainScratch(target);
  }
}

// Private refs in a fresh bare pool name exact requested commits, including
// dangling accepted results. Source refs/config/hooks are never copied/mutated.
// Alternates are used ONLY while packing; the resulting bundle/clone is full.
export async function createSelectedGitBundle({ root, sourceRoot, bundle, inputs, gitAt }) {
  const commits = [...new Set(inputs)];
  if (!commits.length || commits.length > 1024 || commits.some(c => !/^[a-f0-9]{40,64}$/u.test(c))) {
    throw new TypeError("Selected Git transport requires bounded exact commit identities");
  }
  const existing = await lstat(bundle).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing) throw new Error("Existing uninitialized native transport requires its original owner's recovery");
  const base = await realpath(root);
  const pool = await mkdtemp(path.join(base, ".bundle-source-"));
  try {
    await gitAt(root, ["init", "--bare", "--template=", pool]);
    const objects = String(await gitAt(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]));
    if (!path.isAbsolute(objects) || /[\r\n]/u.test(objects)) throw new Error("Invalid native object source");
    await writeFile(path.join(pool, "objects", "info", "alternates"), `${objects.replaceAll("\\", "/")}\n`, { flag: "wx" });
    for (const [index, commit] of commits.entries()) {
      await gitAt(pool, ["update-ref", `refs/heads/selected-${index}`, commit]);
    }
    await gitAt(pool, ["bundle", "create", bundle, "--branches"]);
  } finally {
    // This small pool contains only freshly generated Git metadata. A custody
    // change preserves it, including after failure; never traverse a junction.
    if ((await lstat(pool)).isSymbolicLink() || path.dirname(await realpath(pool)) !== base) {
      throw new Error("bundle-scratch-root-changed");
    }
    await plainScratch(pool);
    await rm(pool, { recursive: true });
  }
}
