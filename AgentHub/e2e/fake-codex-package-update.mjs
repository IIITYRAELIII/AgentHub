// Controlled provider command. Actual process Job, public CLI and restart owners.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function updateFromManagedTurn(file) {
  const root = path.resolve(process.env.AGENT_HUB_RUNTIME_ROOT);
  assert.equal(path.dirname(file), path.join(root, "fixtures"));
  const input = JSON.parse(await readFile(file, "utf8"));
  assert.equal(input.runtimeRoot, root);
  assert.equal(path.dirname(input.jobProbe), path.join(root, "fixtures"));
  const child = spawn("python", input.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: input.nodeOptions } });
  const joined = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  child.stdin.end();
  // The Python download remains alive while querying actual kernel Job membership.
  const membership = await promisify(execFile)(input.jobProbe, [String(process.pid), String(child.pid)],
    { windowsHide: true });
  assert.match(membership.stdout, new RegExp(`^${process.pid} in-job$`, "mu"));
  assert.match(membership.stdout, new RegExp(`^${child.pid} in-job$`, "mu"));
  const [code, signal] = await joined;
  await writeFile(`${file}.stdout`, stdout);
  await writeFile(`${file}.stderr`, stderr);
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  const acknowledgement = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.deepEqual(acknowledgement.handoff, { action: "yield_current_turn", reason: "public_package_restart",
    operationId: input.operationId });
  const database = new DatabaseSync(path.join(root, "data/runtime.sqlite"), { readOnly: true });
  let original;
  try { original = JSON.parse(database.prepare("SELECT operation_json FROM maintenance_operations WHERE operation_id=?")
    .get(input.operationId).operation_json); }
  finally { database.close(); }
  assert.equal(original.status, "blocked");
  assert.equal(original.phase, "waiting-for-work");
  assert.equal(original.outcome, null);
  await writeFile(`${file}.result.json`, JSON.stringify({ providerPid: process.pid, providerParentPid: process.ppid,
    installerPid: child.pid, membership: membership.stdout, original, acknowledgement,
    completedAt: Date.now(), childJoined: true }, null, 2));
  // Returning ends the existing fake-provider turn through its ordinary lifecycle.
  return "Обновление сохранено. Завершаю ход для graceful restart.";
}
