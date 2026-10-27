import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
let calls = 0;
createInterface({ input: process.stdin }).on("line", async line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  try {
    let result = {};
    if (request.method === "initialize") result = { userAgent: "hub348-controlled-fixture" };
    if (request.method === "thread/resume") result = { thread: { id: request.params.threadId, cwd: process.cwd() } };
    if (request.method === "tool/read") {
      const { stdout } = await promisify(execFile)(process.env.HUB348_FIXTURE_HELPER,
        ["/d", "/c", "echo HUB348_TOOL_AFTER_INITIALIZE"], { windowsHide: true });
      calls += 1; result = { output: stdout.trim(), calls };
    }
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: "fixture helper unavailable" } })}\n`); }
});
