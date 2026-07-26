import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const SKIPPED_DIRECTORIES = new Set(["data", "node_modules"]);

async function moduleFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...await moduleFiles(path.join(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

const root = import.meta.dirname;
const files = await moduleFiles(root);
for (const file of files) {
  const source = await readFile(file, "utf8");
  new vm.SourceTextModule(source, { identifier: file });
}
console.log(`Syntax OK: ${files.length} modules`);
