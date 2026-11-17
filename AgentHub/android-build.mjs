import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readReleaseToolPackage } from "./src/infrastructure/process/release-tool-package.mjs";

// Independent Android compiler entry, without whole-application release jobs.
const tool = await readReleaseToolPackage();
const relative = "src/android-build.ps1";
if (!JSON.parse(await readFile(path.join(tool.root, "export-manifest.json"), "utf8")).files.includes(relative)) {
  throw new Error("Android builder is outside the pinned package");
}
const child = spawn("pwsh", ["-NoProfile", "-File", path.join(tool.root, relative),
  "-SourceRoot", import.meta.dirname, ...process.argv.slice(2)], { windowsHide: true, stdio: "inherit" });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
if (code !== 0) process.exitCode = code ?? 1;
await tool.assertUnchanged();
