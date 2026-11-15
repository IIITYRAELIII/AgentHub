import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
export const nativePhysicalIdentity = s => ({ dev: String(s.dev), ino: String(s.ino), birthtimeNs: String(s.birthtimeNs) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const objectFile = file => /^\.git\/objects\/(?:[a-f0-9]{2}\/[a-f0-9]{38}|pack\/pack-[a-f0-9]{40}\.(?:pack|idx|rev|bitmap))$/u.test(file);
async function plain(file, directory) {
  const info = await lstat(file, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("Native capture contains a non-plain entry");
  return info;
}
export async function inventoryNativeCapture(repository, { allowSharedObjects = false } = {}) {
  const root = nativePhysicalIdentity(await plain(repository, true)), files = [], directories = [], stack = [""];
  while (stack.length) {
    const relative = stack.pop(), full = path.join(repository, ...relative.split("/"));
    directories.push({ path: relative, identity: nativePhysicalIdentity(await plain(full, true)) });
    for (const entry of await readdir(full, { withFileTypes: true })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Native capture reparse retained");
      if (entry.isDirectory()) { stack.push(name); continue; }
      const file = path.join(repository, ...name.split("/")), before = await plain(file, false), obj = objectFile(name);
      if (before.nlink !== 1n && (!obj || !allowSharedObjects)) throw new Error("Native capture foreign hardlink retained");
      const hash = createHash("sha256"), blob = createHash("sha1").update("blob " + before.size + "\0"), h = await open(file, "r");
      try {
        if (!same(nativePhysicalIdentity(await h.stat({ bigint: true })), nativePhysicalIdentity(before))) throw new Error("Native capture file replaced");
        for await (const bytes of h.createReadStream({ autoClose: false })) { hash.update(bytes); blob.update(bytes); }
        const after = await plain(file, false);
        if (!same(nativePhysicalIdentity(after), nativePhysicalIdentity(before)) || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink) throw new Error("Native capture file changed");
      } finally { await h.close(); }
      files.push({ path: name, identity: { ...nativePhysicalIdentity(before), bytes: String(before.size), sha256: hash.digest("hex") },
        rawBlobOid: blob.digest("hex"), objectFile: obj, sharedObject: obj && before.nlink > 1n && allowSharedObjects,
        ...(obj ? {} : { writeTimeNs: String(before.mtimeNs), changeTimeNs: String(before.ctimeNs) }) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path)); directories.sort((a, b) => a.path.localeCompare(b.path));
  if (!same(root, nativePhysicalIdentity(await plain(repository, true)))) throw new Error("Native capture root changed");
  return { repository: path.resolve(repository), root, files, directories };
}
