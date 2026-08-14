import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function runModule(expression) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", expression], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_HUB_CONFIG: path.join(ROOT, "missing-bootstrap-test-config.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("server facade imports without loading runtime configuration", async () => {
  const result = await runModule(`
    const server = await import("./agent-hub-server.mjs");
    await server.shutdownAgentHub("import-only");
    process.stdout.write("imported");
  `);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "imported");
});

test("runtime configuration is loaded when startup begins", async () => {
  const result = await runModule(`
    const server = await import("./agent-hub-server.mjs");
    await server.startAgentHub();
  `);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Configuration not found/u);
});
