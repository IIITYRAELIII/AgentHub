import { spawn } from "node:child_process";
import path from "node:path";
import { readReleaseToolPackage } from "./release-tool-package.mjs";

export async function launchReleaseTool(args, { toolPackage = null, spawnImpl = spawn } = {}) {
  const tool = toolPackage ?? await readReleaseToolPackage();
  await tool.assertUnchanged();
  const child = spawnImpl(process.execPath, [path.join(tool.root, "bin/release.mjs"), ...args], {
    stdio: "inherit", windowsHide: true,
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = outcome.code ?? 1;
  return outcome;
}
