// Small external-port control, separate from the real Hub E2E below it.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const [preload, root, installedMain] = process.argv.slice(2);
process.env.AGENT_HUB_RUNTIME_ROOT = root;
process.argv[1] = installedMain;
await import(pathToFileURL(preload));
for (const method of ["spawn", "spawnSync", "execFileSync"]) assert.throws(() => childProcess[method]("claude", ["auth", "status", "--json"]), { code: "EACCES" });
await assert.rejects(promisify(childProcess.execFile)("codex", ["--version"]), { code: "EACCES" });
const result = await promisify(childProcess.execFile)(process.execPath, ["--version"]);
assert.match(result.stdout, /^v\d+\./u); assert.equal(result.stderr, "");
console.log(JSON.stringify({ refusedBeforeSpawn: 4, legitimateNodeCapture: true }));
