import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
const pendingCommands = new Map();
let previousCommand = null;
const commandCase = process.argv.find(arg => arg.startsWith("--command-case="))?.split("=")[1] ?? "normal";
const toolLedger = process.argv.find(arg => arg.startsWith("--tool-ledger="))?.slice("--tool-ledger=".length);
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
  if (!message.method && pendingCommands.has(message.id)) {
    const pending = pendingCommands.get(message.id);
    pendingCommands.delete(message.id);
    if (JSON.stringify(message.result) !== JSON.stringify({ decision: "accept" })) {
      complete(pending.turnId, "failed"); return;
    }
    if (toolLedger) await appendFile(toolLedger, `${pending.itemId}\n`);
    const { stdout } = await promisify(execFile)(process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(pending.nonce)})`], { windowsHide: true });
    write({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId,
      item: { id: commandCase === "wrong-completion" ? "other-item" : pending.itemId,
        type: "commandExecution", exitCode: 0, aggregatedOutput: stdout } } });
    complete(pending.turnId);
    return;
  }
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
    const safeToolNonce = prompt.match(/HUB_CANARY_TOOL_[a-f0-9]{24}/u)?.[0];
    if (safeToolNonce) {
      const ack = () => { write({ id: message.id, result: { turn: { id, status: "inProgress" } } }); start(id, params.threadId); };
      if (process.argv.includes("--no-safe-tool")) { ack(); complete(id); return; }
      const itemId = `tool-${id}`, requestId = `approval-${id}`;
      const shell = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const command = `"${shell}" ${commandCase === "profile" ? "-NoProfile " : ""}-Command "Write-Output ${safeToolNonce}"`;
      if (commandCase.startsWith("direct-")) {
        const directShell = commandCase.startsWith("direct-pwsh")
          ? path.win32.join(path.win32.normalize(process.env.ProgramFiles), "PowerShell/7/pwsh.exe") : shell;
        const directCommand = `"${directShell}" -NoProfile -Command 'Write-Output ${safeToolNonce}'`;
        if (!commandCase.endsWith("before-ack")) ack();
        if (!commandCase.endsWith("missing-start")) write({ method: "item/started", params: {
          threadId: params.threadId, turnId: id, item: { id: itemId, type: "commandExecution", command: directCommand, cwd: process.cwd() },
        } });
        const { stdout } = await promisify(execFile)(directShell,
          ["-NoProfile", "-Command", `Write-Output ${safeToolNonce}`], { windowsHide: true });
        if (toolLedger) {
          await appendFile(`${toolLedger}.detail.json`, JSON.stringify({ shell: directShell, exitCode: 0,
            stdoutMatches: stdout.trim() === safeToolNonce, effectCount: 1 }));
          await appendFile(toolLedger, `${itemId}\n`);
        }
        const detail = { threadId: params.threadId, turnId: id, item: { id: itemId, type: "commandExecution",
          command: directCommand, cwd: process.cwd(), environmentId: "local", exitCode: 0, aggregatedOutput: stdout } };
        if (commandCase.endsWith("foreign-thread")) detail.threadId = "foreign-thread";
        if (commandCase.endsWith("foreign-turn")) detail.turnId = "foreign-turn";
        if (commandCase.endsWith("cwd")) detail.item.cwd = path.dirname(process.cwd());
        if (commandCase.endsWith("command")) detail.item.command += "; Write-Output other";
        if (commandCase.endsWith("item")) detail.item.id = "not-observed";
        if (commandCase.endsWith("output")) detail.item.aggregatedOutput = "other";
        if (commandCase.endsWith("exit")) detail.item.exitCode = 1;
        if (commandCase.endsWith("shell")) detail.item.command = directCommand.replace("pwsh.exe", "other.exe");
        if (commandCase.endsWith("environment")) detail.item.environmentId = "remote";
        write({ method: "item/completed", params: detail });
        complete(id);
        if (commandCase.endsWith("before-ack")) setImmediate(ack);
        return;
      }
      const approval = { threadId: params.threadId, turnId: id, itemId, command, cwd: process.cwd(),
        kind: "command", environmentId: "local", availableDecisions: ["accept", "acceptForSession", "cancel"] };
      if (commandCase === "thread") approval.threadId = "foreign-thread";
      if (commandCase === "turn") approval.turnId = "foreign-turn";
      if (commandCase === "cwd") approval.cwd = path.dirname(process.cwd());
      if (commandCase === "command") approval.command += "; Write-Output other";
      if (commandCase === "nonce") approval.command = command.replace(safeToolNonce, "HUB_CANARY_TOOL_000000000000000000000000");
      if (commandCase === "shell") approval.command = command.replace("powershell.exe", "other.exe");
      if (commandCase === "item") approval.itemId = "not-observed";
      if (commandCase === "decisions") approval.availableDecisions = ["acceptForSession", "cancel"];
      if (commandCase === "stdin") approval.kind = "writeStdin";
      if (commandCase === "approval-id") approval.approvalId = "subcommand";
      if (commandCase === "environment") approval.environmentId = "remote";
      if (commandCase === "network") approval.networkApprovalContext = { host: "example.invalid" };
      if (commandCase === "missing-decisions") delete approval.availableDecisions;
      previousCommand = approval;
      pendingCommands.set(requestId, { threadId: params.threadId, turnId: id, itemId, nonce: safeToolNonce });
      if (commandCase !== "before-ack") ack();
      write({ method: "item/started", params: { threadId: params.threadId, turnId: id,
        item: { id: itemId, type: "commandExecution", command, cwd: process.cwd() } } });
      write({ id: requestId, method: "item/commandExecution/requestApproval", params: approval });
      if (commandCase === "duplicate") write({ id: `${requestId}-duplicate`, method: "item/commandExecution/requestApproval", params: approval });
      if (commandCase === "before-ack") setImmediate(ack);
      return;
    }
    write({ id: message.id, result: { turn: { id, status: "inProgress" } } });
    setImmediate(() => start(id, params.threadId));
    if (commandCase === "late" && previousCommand) {
      write({ id: "late-approval", method: "item/commandExecution/requestApproval", params: previousCommand });
      return;
    }
    if (/at least 10000 words/u.test(prompt)) {
      interruptedTurns.add(id);
      return;
    }
    if (/hub_canary_read/u.test(prompt)) {
      const instructions = !process.argv.includes("--ignore-application-context")
        ? Object.entries(params.additionalContext ?? {})
          .filter(([key, entry]) => key.startsWith("agent-hub") && entry.kind === "application")
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, entry]) => entry.value.slice(entry.value.indexOf("\n\n") + 2)).join("")
        : "";
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
