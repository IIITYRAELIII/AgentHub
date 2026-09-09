import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--leak-stderr")) {
  const auth = await readFile(path.join(process.env.CODEX_HOME, "auth.json"), "utf8");
  process.stderr.write(`${auth}\n`);
  process.stderr.write("PROMPT_SECRET_MUST_NOT_PERSIST_4A71\n");
  process.stderr.write("CAPABILITY_SECRET_MUST_NOT_PERSIST_27C0\n");
  process.stderr.write("RESPONSE_SECRET_MUST_NOT_PERSIST_681E\n");
}

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
const activeTurns = new Set();
const pendingElicitations = new Map();
const delayedTurnMs = Number(process.argv.find((argument) => argument.startsWith("--delay-turn-ms="))?.split("=")[1]) || 0;

function complete(turnId, status = "completed") {
  activeTurns.delete(turnId);
  write({ method: "turn/completed", params: { turn: { id: turnId, status, items: [] } } });
}

function start(turnId, threadId) {
  activeTurns.add(turnId);
  write({
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } },
  });
}

async function handle(message) {
  if (message.id == null) return;
  if (!message.method && pendingElicitations.has(message.id)) {
    const pending = pendingElicitations.get(message.id);
    pendingElicitations.delete(message.id);
    if (message.result?.action !== "accept" || message.result?.content?.approved !== true) {
      complete(pending.turnId, "failed");
      return;
    }
    await callCanaryRead(pending.contextToken);
    complete(pending.turnId);
    return;
  }
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
    setImmediate(() => start(id, params.threadId));
    if (/at least 10000 words/u.test(prompt)) {
      interruptedTurns.add(id);
      return;
    }
    if (/hub_canary_read/u.test(prompt)) {
      const application = params.additionalContext?.["agent-hub"];
      const instructions = application?.kind === "application" && !process.argv.includes("--ignore-application-context")
        ? application.value : "";
      const contextToken = instructions.match(/context_token\s+([0-9A-Za-z_-]+)/u)?.[1] ?? "";
      if (!contextToken) {
        setImmediate(() => complete(id, "failed"));
        return;
      }
      const elicitationId = `canary-elicitation-${id}`;
      pendingElicitations.set(elicitationId, { contextToken, turnId: id });
      write({
        id: elicitationId,
        method: "mcpServer/elicitation/request",
        params: {
          serverName: process.argv.includes("--wrong-elicitation-server") ? "other" : "agent_hub",
          threadId: params.threadId,
          turnId: id,
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
          },
        },
      });
      return;
    }
    const status = process.argv.includes("--fail-ordinary") && turnSequence === 1 ? "failed" : "completed";
    if (delayedTurnMs > 0) setTimeout(() => complete(id, status), delayedTurnMs);
    else setImmediate(() => complete(id, status));
    return;
  }
  if (message.method === "turn/interrupt") {
    if (!activeTurns.has(params.turnId)) {
      write({ id: message.id, error: { code: -32600, message: "no active turn to interrupt" } });
      return;
    }
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
