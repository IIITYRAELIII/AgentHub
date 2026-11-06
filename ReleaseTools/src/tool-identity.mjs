import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function toolIdentity(root = new URL("../", import.meta.url)) {
  const metadata = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("export-manifest.json", root), "utf8"));
  const files = [];
  for (const name of [...manifest.files].sort()) {
    if (typeof name !== "string" || name.startsWith("/") || name.includes("\\") || name.split("/").some(x => !x || x === "." || x === "..")) {
      throw new Error("Invalid tool export path");
    }
    const bytes = await readFile(new URL(name, root));
    files.push({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return Object.freeze({ name: metadata.name, version: metadata.version,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") });
}
