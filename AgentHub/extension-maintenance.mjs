import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readReleaseToolPackage } from "./src/infrastructure/process/release-tool-package.mjs";

// Source installer compatibility: only the independent extension installer.
// No release recipe, Hub API, database, worker or publication selection.
const action = process.argv[2];
if (!["extension-install", "extension-remove"].includes(action)) throw new Error("Unknown extension action");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const values = JSON.parse(input);
const tool = await readReleaseToolPackage();
const relative = "python/vscode_extension.py";
if (!JSON.parse(await readFile(path.join(tool.root, "export-manifest.json"), "utf8")).files.includes(relative)) {
  throw new Error("Extension installer is outside the pinned package");
}
const child = spawn(process.env.PYTHON || "python", [path.join(tool.root, relative)], {
  cwd: import.meta.dirname, windowsHide: true, stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.end(JSON.stringify({ ...values, sourceRoot: import.meta.dirname, action }));
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
if (code !== 0) process.exitCode = code ?? 1;
await tool.assertUnchanged();
