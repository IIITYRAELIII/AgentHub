import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { AGENT_HUB_VERSION } from "../infrastructure/filesystem/agent-hub-package.mjs";
import { protectRuntimeDirectory } from "../infrastructure/filesystem/runtime-security.mjs";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
import { HubMcpServer } from "../interfaces/mcp/hub-mcp-server.mjs";
import { mcpElicitationAcceptResponse } from "../providers/codex/codex-approvals.mjs";
import { CodexAppServerTransport } from "../providers/codex/codex-app-server-transport.mjs";
import { codexThreadSandboxSettings, codexTurnSandboxSettings } from "../providers/codex/codex-sandbox.mjs";

const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;
const MAX_PROTOCOL_EVENTS = 200;
const MAX_STDERR_CHARACTERS = 8_192;

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function turnId(result) {
  const id = String(result?.turn?.id ?? result?.turnId ?? "").trim();
  if (!id) throw new Error("Codex compatibility canary did not receive a turn id");
  return id;
}

function threadId(result) {
  const id = String(result?.thread?.id ?? result?.threadId ?? "").trim();
  if (!id) throw new Error("Codex compatibility canary did not receive a thread id");
  return id;
}

function boundedText(value, limit = MAX_STDERR_CHARACTERS) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function redactDiagnosticText(value, sensitiveValues, limit = MAX_STDERR_CHARACTERS) {
  let text = String(value ?? "");
  for (const sensitive of sensitiveValues) {
    if (sensitive) text = text.replaceAll(sensitive, "[REDACTED]");
  }
  return boundedText(text, limit);
}

function diagnosticIdentity(candidate) {
  return Object.fromEntries(["path", "version", "sha256", "publisher"]
    .filter((key) => candidate?.[key] != null)
    .map((key) => [key, String(candidate[key])]));
}

export async function runCodexAppServerCompatibilityCanary(candidate, {
  dataDir,
  executableArgs = [],
  model = "",
  environment = process.env,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  spawnImpl = spawn,
  stopProcess = stopProcessTree,
  protectDirectory = protectRuntimeDirectory,
  logger = console,
} = {}) {
  if (!dataDir) throw new TypeError("Codex canary dataDir is required");
  const parent = path.join(dataDir, "codex-executable-canary");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "run-"));
  const codexHome = path.join(root, "codex-home");
  const projectRoot = path.join(root, "project");
  const failureEvidenceFile = path.join(parent, "last-failure.json");
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const protocolEvents = [];
  const sensitiveValues = new Set();
  let stderrTail = "";
  let phase = "prepare";
  let canaryThreadId = null;
  let mcpTurnId = null;
  let transport = null;
  let mcpServer = null;
  let expectedStop = false;
  let stopCanaryTransport = async () => {};
  const record = (event, detail = {}) => {
    if (protocolEvents.length >= MAX_PROTOCOL_EVENTS) protocolEvents.shift();
    protocolEvents.push({ elapsedMs: Date.now() - startedAtMs, event, ...detail });
  };
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await protectDirectory(root, { environment });
    const sourceHome = String(environment.CODEX_HOME ?? "").trim()
      || path.join(String(environment.USERPROFILE ?? ""), ".codex");
    await copyFile(path.join(sourceHome, "auth.json"), path.join(codexHome, "auth.json"));

    let mcpReadCount = 0;
    const canaryContextToken = randomBytes(24).toString("base64url");
    sensitiveValues.add(canaryContextToken);
    mcpServer = new HubMcpServer({
      secret: randomBytes(32).toString("base64url"),
      logger: { log() {}, error: (...args) => logger.error?.(...args) },
      service: {
        tools: () => [{
          name: "hub_canary_read",
          description: "Read isolated Agent Hub compatibility canary health.",
          inputSchema: {
            type: "object",
            properties: { context_token: { type: "string" } },
            required: ["context_token"],
            additionalProperties: false,
          },
        }],
        call: async (name, args) => {
          if (name !== "hub_canary_read") throw new Error(`Unknown canary tool ${name}`);
          if (args?.context_token !== canaryContextToken) throw new Error("Invalid isolated canary context token");
          mcpReadCount += 1;
          return { ok: true, isolated: true, version: 1 };
        },
      },
    });
    await mcpServer.start();
    sensitiveValues.add(mcpServer.url);

    const completed = new Map();
    const waiters = new Map();
    const started = new Set();
    const startWaiters = new Map();
    let rejectProtocolFailure;
    const protocolFailure = new Promise((_, reject) => { rejectProtocolFailure = reject; });
    const failProtocol = (error) => rejectProtocolFailure(
      error instanceof Error ? error : new Error(String(error)),
    );
    const onMessage = async (message) => {
      record("message", {
        method: String(message?.method ?? "unknown"),
        threadId: String(message?.params?.threadId ?? "") || null,
        turnId: String(message?.params?.turn?.id ?? message?.params?.turnId ?? "") || null,
        status: String(message?.params?.turn?.status ?? "") || null,
        request: message?.id != null,
      });
      if (message?.id != null) {
        if (message.method !== "mcpServer/elicitation/request") {
          throw new Error(`Unexpected Codex canary client request ${message.method ?? "unknown"}`);
        }
        const params = message.params ?? {};
        if (String(params.serverName ?? "") !== "agent_hub"
          || String(params.threadId ?? "") !== canaryThreadId
          || String(params.turnId ?? "") !== mcpTurnId
          || params.mode !== "form") {
          throw new Error("Codex canary received an unbound MCP elicitation request");
        }
        const response = mcpElicitationAcceptResponse(params);
        if (!response) throw new Error("Codex canary MCP elicitation is not safely auto-answerable");
        await transport.respond(message.id, response, { expectedGeneration: transport.generation });
        record("elicitation-response-flushed", {
          method: message.method,
          threadId: canaryThreadId,
          turnId: mcpTurnId,
          action: response.action,
        });
        return;
      }
      if (message?.method === "turn/started") {
        const id = String(message.params?.turn?.id ?? message.params?.turnId ?? "").trim();
        if (id) {
          started.add(id);
          startWaiters.get(id)?.(id);
          startWaiters.delete(id);
        }
        return;
      }
      if (message?.method !== "turn/completed") return;
      const id = String(message.params?.turn?.id ?? message.params?.turnId ?? "").trim();
      if (!id) return;
      completed.set(id, message.params?.turn ?? message.params);
      waiters.get(id)?.(completed.get(id));
      waiters.delete(id);
    };
    const waitForTurn = (id, timeoutMs, turnPhase) => {
      if (completed.has(id)) return Promise.resolve(completed.get(id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          const error = new Error(`Canary ${turnPhase} turn ${id} timed out after ${timeoutMs} ms`);
          error.code = "CODEX_CANARY_TURN_TIMEOUT";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
        waiters.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    };
    const waitForTurnStart = (id, turnPhase) => {
      if (started.has(id)) return Promise.resolve(id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          startWaiters.delete(id);
          reject(new Error(`Canary ${turnPhase} turn ${id} was not started after ${rpcTimeoutMs} ms`));
        }, rpcTimeoutMs);
        timer.unref?.();
        startWaiters.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    };
    stopCanaryTransport = async () => {
      if (!transport) return;
      expectedStop = true;
      const child = transport.child;
      const closed = child && child.exitCode == null && child.signalCode == null
        ? new Promise((resolve) => child.once("close", resolve))
        : Promise.resolve();
      await transport.stop();
      await withTimeout(
        closed,
        rpcTimeoutMs,
        `Codex canary App Server did not close after ${rpcTimeoutMs} ms`,
      );
      transport = null;
    };
    const startTransport = async () => {
      phase = "app-server-start";
      record("phase", { phase });
      transport = new CodexAppServerTransport({
        spawnProcess: async (args) => spawnImpl(
          candidate.path,
          [...executableArgs, ...mcpServer.codexArgs(), ...args],
          {
            cwd: projectRoot,
            env: { ...environment, CODEX_HOME: codexHome },
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
        stopProcessTree: stopProcess,
        onMessage,
        onExit: ({ detail }) => {
          if (!expectedStop) failProtocol(new Error(`Codex canary App Server stopped unexpectedly (${detail})`));
        },
        onStderr: (text) => {
          stderrTail = redactDiagnosticText(
            `${stderrTail}${stderrTail ? "\n" : ""}${text}`,
            sensitiveValues,
          );
        },
        onInvalidMessage: failProtocol,
        onMessageError: failProtocol,
        rpcTimeoutMs,
      });
      await transport.start();
      phase = "initialize";
      record("phase", { phase });
      const initialized = await transport.initialize({
        clientInfo: { name: "agent_hub_canary", version: AGENT_HUB_VERSION },
        capabilities: { experimentalApi: true },
      });
      if (initialized.newlyInitialized) transport.notify("initialized");
      phase = "health";
      record("phase", { phase });
      await transport.request("thread/list", { limit: 1 }, { timeoutMs: rpcTimeoutMs });
    };
    const startTurn = async (
      id,
      text,
      turnPhase,
      completionTimeoutMs = turnTimeoutMs,
      requireStarted = false,
    ) => {
      phase = turnPhase;
      record("phase", { phase });
      const result = await transport.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text }],
        ...(model ? { model } : {}),
        effort: "low",
        ...codexTurnSandboxSettings("workspace-write", projectRoot),
      }, { timeoutMs: rpcTimeoutMs });
      const idOfTurn = turnId(result);
      record("turn-accepted", { phase: turnPhase, turnId: idOfTurn });
      return {
        id: idOfTurn,
        started: requireStarted ? waitForTurnStart(idOfTurn, turnPhase) : null,
        completion: waitForTurn(idOfTurn, completionTimeoutMs, turnPhase),
      };
    };
    const expectSuccessfulTurn = async (turn) => {
      const completedTurn = await turn.completion;
      if (completedTurn?.status !== "completed") {
        throw new Error(`Canary turn ${turn.id} completed with status ${completedTurn?.status ?? "unknown"}`);
      }
      return completedTurn;
    };

    const scenario = (async () => {
      await startTransport();
      phase = "thread-start";
      record("phase", { phase });
      const createdThreadId = threadId(await transport.request("thread/start", {
        cwd: projectRoot,
        ...(model ? { model } : {}),
        ...codexThreadSandboxSettings("workspace-write"),
        serviceName: "agent_hub_codex_update_canary",
      }, { timeoutMs: rpcTimeoutMs }));
      canaryThreadId = createdThreadId;

      const ordinary = await startTurn(createdThreadId, "Reply exactly CANARY_ORDINARY_OK. Do not use tools.", "ordinary");
      await expectSuccessfulTurn(ordinary);
      const mcp = await startTurn(
        createdThreadId,
        `Call the agent_hub MCP tool hub_canary_read exactly once with context_token ${canaryContextToken}, then reply exactly CANARY_MCP_OK.`,
        "mcp-read",
      );
      mcpTurnId = mcp.id;
      await expectSuccessfulTurn(mcp);
      if (mcpReadCount !== 1) throw new Error(`Canary expected one Agent Hub MCP read, observed ${mcpReadCount}`);

      const interrupted = await startTurn(
        createdThreadId,
        "Produce a detailed response of at least 10000 words.",
        "interrupt-target",
        cancelTimeoutMs,
        true,
      );
      phase = "interrupt-request";
      record("phase", { phase, turnId: interrupted.id });
      await interrupted.started;
      await transport.request("turn/interrupt", {
        threadId: createdThreadId,
        turnId: interrupted.id,
      }, { timeoutMs: rpcTimeoutMs });
      await interrupted.completion;
      const afterCancel = await startTurn(createdThreadId, "Reply exactly CANARY_AFTER_CANCEL_OK. Do not use tools.", "after-cancel");
      await expectSuccessfulTurn(afterCancel);

      expectedStop = true;
      phase = "restart-stop";
      record("phase", { phase });
      await stopCanaryTransport();
      expectedStop = false;
      await startTransport();
      phase = "thread-resume";
      record("phase", { phase });
      await transport.request("thread/resume", {
        threadId: createdThreadId,
        ...codexThreadSandboxSettings("workspace-write"),
      }, { timeoutMs: rpcTimeoutMs });
      const afterResume = await startTurn(createdThreadId, "Reply exactly CANARY_AFTER_RESUME_OK. Do not use tools.", "after-resume");
      await expectSuccessfulTurn(afterResume);
      return {
        threadId: createdThreadId,
        turnIds: {
          ordinary: ordinary.id,
          mcp: mcp.id,
          interrupted: interrupted.id,
          afterCancel: afterCancel.id,
          afterResume: afterResume.id,
        },
        mcpReadCount,
        healthRead: true,
        restartResume: true,
        protocolEvents,
      };
    })();
    const evidence = await withTimeout(
      Promise.race([scenario, protocolFailure]),
      totalTimeoutMs,
      `Codex compatibility canary timed out after ${totalTimeoutMs} ms`,
    );
    return { ok: true, evidence };
  } catch (error) {
    const evidence = {
      schemaVersion: 1,
      startedAt,
      failedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      phase,
      candidate: diagnosticIdentity(candidate),
      error: {
        code: String(error?.code ?? "") || null,
        message: redactDiagnosticText(error?.message, sensitiveValues, 2_000),
      },
      protocolEvents,
      stderrTail: redactDiagnosticText(stderrTail, sensitiveValues),
    };
    await writeFile(failureEvidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch((writeError) => {
      logger.error?.("Cannot persist Codex canary failure evidence:", writeError.message);
    });
    error.canaryEvidence = evidence;
    throw error;
  } finally {
    await stopCanaryTransport().catch(() => null);
    await mcpServer?.close().catch(() => null);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
