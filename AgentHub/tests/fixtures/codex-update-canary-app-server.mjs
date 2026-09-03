import { createInterface } from "node:readline";

function mcpUrl() {
  for (const argument of process.argv.slice(2)) {
    const prefix = "mcp_servers.agent_hub.url=";
    if (!argument.startsWith(prefix)) continue;
    const value = argument.slice(prefix.length);
    try { return JSON.parse(value); } catch { return value; }
  }
  return "";
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callCanaryRead(contextToken) {
  const url = mcpUrl();
  if (!url) throw new Error("Agent Hub MCP URL is missing");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hub_canary_read", arguments: { context_token: contextToken } },
    }),
  });
  const message = await response.json();
  if (!response.ok || message.error || message.result?.isError) {
    throw new Error(message.error?.message ?? "Agent Hub MCP canary read failed");
  }
}

let turnSequence = 0;
let threadSequence = 0;
const interruptedTurns = new Set();

function complete(turnId, status = "completed") {
  write({ method: "turn/completed", params: { turn: { id: turnId, status, items: [] } } });
}

async function handle(message) {
  if (message.id == null) return;
  const params = message.params ?? {};
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "codex-update-canary-fixture" } });
    return;
  }
  if (message.method === "thread/list") {
    if (process.argv.includes("--hang-health")) return;
    write({ id: message.id, result: { data: [] } });
    return;
  }
  if (message.method === "thread/start") {
    threadSequence += 1;
    write({ id: message.id, result: { thread: { id: `canary-thread-${threadSequence}`, cwd: params.cwd } } });
    return;
  }
  if (message.method === "thread/resume") {
    write({ id: message.id, result: { thread: { id: params.threadId, cwd: process.cwd() } } });
    return;
  }
  if (message.method === "turn/start") {
    turnSequence += 1;
    const id = `canary-turn-${turnSequence}`;
    const prompt = String(params.input?.[0]?.text ?? "");
    write({ id: message.id, result: { turn: { id, status: "inProgress" } } });
    if (/at least 10000 words/u.test(prompt)) {
      interruptedTurns.add(id);
      return;
    }
    if (/hub_canary_read/u.test(prompt)) {
      const contextToken = prompt.match(/context_token\s+([0-9A-Za-z_-]+)/u)?.[1] ?? "";
      await callCanaryRead(contextToken);
    }
    const status = process.argv.includes("--fail-ordinary") && turnSequence === 1 ? "failed" : "completed";
    setImmediate(() => complete(id, status));
    return;
  }
  if (message.method === "turn/interrupt") {
    write({ id: message.id, result: {} });
    if (interruptedTurns.delete(params.turnId)) setImmediate(() => complete(params.turnId, "interrupted"));
    return;
  }
  write({ id: message.id, error: { code: -32601, message: `Unsupported ${message.method}` } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
});
