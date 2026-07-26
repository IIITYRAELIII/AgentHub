import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function main() {
  const runtimeRoot = import.meta.dirname;
  const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  if (!/^[A-Za-z0-9._-]+$/.test(String(pointer.current ?? ""))) {
    throw new Error("Agent Hub has no valid current runtime release");
  }
  const modulePath = path.join(runtimeRoot, "releases", pointer.current, "codex-stop-hook.mjs");
  const hook = await import(pathToFileURL(modulePath).href);
  await hook.main();
}

main().catch((error) => {
  console.error(`Cannot launch Codex Stop hook: ${error.message}`);
  process.exitCode = 1;
});
