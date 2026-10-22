// Isolated installation regression fixture. Uses the actual preparation/host
// builder with synthetic app bytes; it is not a product or provider acceptance.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareRuntime } from "../src/runtime/runtime-manager.mjs";
import { relativeModuleSpecifiers } from "../src/infrastructure/filesystem/module-import-specifiers.mjs";

const [area, releaseId, text, sourceCommit, publicVersion = "2026.10.19"] = process.argv.slice(2);
if (!area || !releaseId || !text || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? "")) throw new Error("Fixture arguments required");
const actual = path.resolve(import.meta.dirname, "..");
const source = path.join(path.resolve(area), "source");
const copied = new Set();
async function copyModule(relative) {
  relative = path.posix.normalize(relative);
  if (relative.startsWith("../") || copied.has(relative)) return;
  copied.add(relative);
  const body = await readFile(path.join(actual, relative), "utf8");
  const target = path.join(source, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");
  for (const specifier of relativeModuleSpecifiers(body)) {
    await copyModule(path.posix.join(path.posix.dirname(relative), specifier));
  }
}
await copyModule("src/runtime/runtime-manager.mjs");
await copyModule("src/infrastructure/process/publication-lock.mjs");
await cp(path.join(actual, "RuntimeHost"), path.join(source, "RuntimeHost"), { recursive: true });
await mkdir(path.join(source, "VSCodeExtension", "media"), { recursive: true });
await cp(path.join(actual, "VSCodeExtension", "media", "agent-hub-mark.png"), path.join(source, "VSCodeExtension", "media", "agent-hub-mark.png"));
await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "agent-hub", version: publicVersion, type: "module" }));
await writeFile(path.join(source, "agent-hub-main.mjs"), `console.log(${JSON.stringify(text)});\n`);
await writeFile(path.join(source, "codex-stop-hook-launcher.mjs"), "// Synthetic fixture; no provider hook.\n");
const prepared = await prepareRuntime({ sourceRoot: source, runtimeRoot: path.join(path.resolve(area), "build"), releaseId,
  publicationRevision: sourceCommit });
console.log(JSON.stringify({ releaseRoot: prepared.releaseRoot, fixture: true }));
