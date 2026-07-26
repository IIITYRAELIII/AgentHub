import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function main() {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = JSON.parse(chunks.join(""));
  const runtimeRoot = import.meta.dirname;
  const pointer = JSON.parse(await readFile(path.join(runtimeRoot, "current.json"), "utf8"));
  if (!/^[A-Za-z0-9._-]+$/.test(String(pointer.current ?? ""))) {
    throw new Error("Agent Hub has no valid current runtime release");
  }
  const moduleName = value.hook_event_name === "UserPromptSubmit"
    ? "codex-turn-start-hook.mjs"
    : value.hook_event_name === "Stop"
      ? "codex-stop-hook.mjs"
      : null;
  if (!moduleName) throw new Error(`Unsupported Codex hook event: ${value.hook_event_name}`);
  const modulePath = path.join(runtimeRoot, "releases", pointer.current, moduleName);
  const hook = await import(pathToFileURL(modulePath).href);
  if (value.hook_event_name === "UserPromptSubmit") {
    await hook.handleCodexTurnStartHook(value);
  } else {
    await hook.handleCodexStopHook(value);
  }
}

main().catch((error) => {
  console.error(`Cannot launch Codex lifecycle hook: ${error.message}`);
  process.exitCode = 1;
});
