import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

// An explicit independently installed tool pin, not an application dependency
// bundled into runtime releases. No discovery, download or fallback owner.
export async function readReleaseToolPackage({
  root = process.env.AGENT_HUB_RELEASE_TOOLS_ROOT,
  expectedSha256 = process.env.AGENT_HUB_RELEASE_TOOLS_SHA256,
} = {}) {
  if (!root || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) {
    throw new Error("External release tool requires AGENT_HUB_RELEASE_TOOLS_ROOT and its SHA256 pin");
  }
  const physical = await realpath(root);
  const manifest = JSON.parse(await readFile(path.join(physical, "export-manifest.json"), "utf8"));
  if (manifest.apiVersion !== 1 || !Array.isArray(manifest.files)
    || new Set(manifest.files).size !== manifest.files.length) throw new Error("Unsupported release tool API manifest");
  const files = [];
  for (const relative of [...manifest.files].sort()) {
    if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\")
      || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid tool package path");
    const file = path.join(physical, relative);
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || await realpath(file) !== file) throw new Error("Tool file is not plain");
    const bytes = await readFile(file);
    const after = await lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Release tool changed while reading");
    }
    files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
  }
  if (sha(JSON.stringify(files)) !== expectedSha256) throw new Error("Release tool differs from its pinned version");
  const metadata = JSON.parse(await readFile(path.join(physical, "package.json"), "utf8"));
  return Object.freeze({ root: physical, name: metadata.name, version: metadata.version, sha256: expectedSha256,
    async module(relative) {
      if (!manifest.files.includes(relative)) throw new Error("Tool module is outside its pinned export");
      const url = pathToFileURL(path.join(physical, relative));
      url.searchParams.set("toolPin", expectedSha256);
      return import(url.href);
    },
    async assertUnchanged() { await readReleaseToolPackage({ root: physical, expectedSha256 }); },
  });
}
