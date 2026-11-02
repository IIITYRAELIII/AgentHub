import path from "node:path";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { readRuntimeManifest, readRuntimePointer, captureRuntimeReleaseBinding, sameRuntimeBinding } from "./runtime-installation-custody.mjs";
const inside = (parent, child) => {
  const relative = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const missing = e => { if (e.code === "ENOENT") return null; throw e; };
async function objectStores(source) {
  const stores = [], seen = new Set();
  let cursor = source, git = null;
  while (true) {
    const marker = path.join(cursor, ".git"), s = await lstat(marker).catch(missing);
    if (s) {
      if (s.isSymbolicLink()) throw new Error("Prepared source Git marker redirected");
      if (s.isDirectory()) git = marker;
      else {
        const m = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readFile(marker, "utf8"));
        if (!m) throw new Error("Prepared source Git marker unknown");
        git = path.resolve(cursor, m[1]);
      }
      break;
    }
    const next = path.dirname(cursor); if (cursor === next) break; cursor = next;
  }
  if (!git) throw new Error("Prepared source Git custody unavailable");
  const common = await readFile(path.join(git, "commondir"), "utf8").catch(missing);
  if (common !== null) git = path.resolve(git, common.replace(/\r?\n$/u, ""));
  const pending = [path.join(git, "objects")];
  while (pending.length) {
    const store = pending.pop(), s = await lstat(store);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Prepared object-store path redirected");
    const resolved = await realpath(store), key = resolved.toLowerCase();
    if (seen.has(key)) continue; seen.add(key); stores.push(resolved);
    const raw = await readFile(path.join(store, "info", "alternates"), "utf8").catch(missing);
    if (raw !== null) for (const item of raw.split(/\r?\n/u).filter(Boolean)) pending.push(path.resolve(store, item));
  }
  return stores;
}
// Called under the SAME installation lease as runtime preparation/retirement.
// Only manifests and their declared source/object chains, no disk/audit scan.
export async function assertNativeCaptureNotSourcePinned(runtimeRoot, repository) {
  const pointer = await readRuntimePointer(runtimeRoot);
  if (!pointer?.current) throw new Error("Current runtime source custody unavailable");
  const retired = new Set((pointer.runtimeRetention?.retired || []).map(r => r.releaseId));
  for (const entry of await readdir(path.join(runtimeRoot, "releases"), { withFileTypes: true })) {
    if (retired.has(entry.name) && ![pointer.current, pointer.previous].includes(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.includes(".staging-")) throw new Error("Runtime preparation is unresolved");
    const releaseRoot = path.join(runtimeRoot, "releases", entry.name);
    const { manifest, sha256 } = await readRuntimeManifest(releaseRoot);
    if (!Object.hasOwn(manifest, "sourceRoot")) {
      const installed = [pointer.runtimeRetention?.current, pointer.runtimeRetention?.previous].find(b => b?.releaseId === entry.name);
      const actual = await captureRuntimeReleaseBinding(releaseRoot, entry.name);
      if (actual.manifestSha256 !== sha256 || !sameRuntimeBinding(actual, installed)) throw new Error("Prepared source-free runtime custody unavailable");
      continue;
    }
    if (!path.isAbsolute(manifest.sourceRoot || "")) throw new Error("Runtime source pin is malformed");
    if (inside(repository, manifest.sourceRoot)) throw new Error("Native capture is a runtime/prepared source");
    const s = await lstat(manifest.sourceRoot).catch(missing);
    if (!s) continue;
    const source = await realpath(manifest.sourceRoot);
    if (inside(repository, source)) throw new Error("Native capture is a runtime/prepared source");
    for (const objects of await objectStores(source)) if (inside(repository, objects)) {
      throw new Error("Native capture supplies a retained source object store");
    }
  }
}
