import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const target = path.resolve(import.meta.dirname, "..", "AgentHub", "send-message.mjs");
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
