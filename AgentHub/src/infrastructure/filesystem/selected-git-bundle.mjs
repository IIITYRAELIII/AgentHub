import { lstat, open } from "node:fs/promises";
import path from "node:path";

// Documented gitformat-bundle header + Git's complete pack stream. The caller
// owns the output descriptor before Git starts; no temporary bare repository,
// source ref mutation, pack buffering or recursive scratch deletion is needed.
export async function createSelectedGitBundle({ root, sourceRoot, bundle, inputs, gitAt }) {
  const commits = [...new Set(inputs)];
  if (!commits.length || commits.length > 1024 || commits.some(c => !/^[a-f0-9]{40,64}$/u.test(c))) {
    throw new TypeError("Selected Git transport requires bounded exact commit identities");
  }
  if (path.dirname(path.resolve(bundle)) !== path.resolve(root)) throw new Error("Native transport escaped its owner root");
  const parent = await lstat(root, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Native transport root is not plain");
  const format = String(await gitAt(sourceRoot, ["rev-parse", "--show-object-format"]));
  if (!["sha1", "sha256"].includes(format) || commits.some(c => c.length !== (format === "sha1" ? 40 : 64))) {
    throw new Error("Native transport object format changed");
  }
  const header = Buffer.from([...(format === "sha1" ? ["# v2 git bundle"] : ["# v3 git bundle", "@object-format=sha256"]),
    ...commits.map((commit, i) => `${commit} refs/heads/selected-${i}`), "", ""].join("\n"));
  const handle = await open(bundle, "wx+").catch(error => {
    if (error.code === "EEXIST") throw new Error("Existing uninitialized native transport requires its original owner's recovery");
    throw error;
  });
  try {
    const created = await handle.stat({ bigint: true });
    await handle.writeFile(header);
    await gitAt(sourceRoot, ["pack-objects", "--stdout", "--revs"], {
      input: `${commits.join("\n")}\n`, stdoutFd: handle.fd,
    });
    await handle.sync();
    const marker = Buffer.alloc(4);
    await handle.read(marker, 0, 4, header.length);
    const [held, named, currentParent] = await Promise.all([handle.stat({ bigint: true }),
      lstat(bundle, { bigint: true }).catch(() => null), lstat(root, { bigint: true }).catch(() => null)]);
    if (marker.toString("ascii") !== "PACK" || held.size <= BigInt(header.length + 4)
        || !held.isFile() || held.nlink !== 1n || !named?.isFile() || named.isSymbolicLink()
        || named.dev !== created.dev || named.ino !== created.ino
        || !currentParent?.isDirectory() || currentParent.isSymbolicLink()
        || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
        || currentParent.birthtimeNs !== parent.birthtimeNs) throw new Error("Native transport output custody changed");
  } finally {
    // On failure preserve the original/partial output and every replacement.
    // Closing our descriptor is the only cleanup effect here.
    await handle.close();
  }
}
