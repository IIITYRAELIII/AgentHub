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
const MAX_DIAGNOSTIC_COUNT = 1_000_000;
const SAFE_IDENTIFIER_PATTERN = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|canary-(?:thread|turn)-\d+)$/iu;
const SAFE_PROTOCOL_METHODS = new Set([
  "remoteControl/status/changed",
  "thread/started",
  "thread/settings/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "account/rateLimits/updated",
  "mcpServer/startupStatus/updated",
  "mcpServer/elicitation/request",
  "serverRequest/resolved",
]);
const SAFE_TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted", "cancelled"]);
const SAFE_FAILURE_CODES = new Set([
  "CODEX_CANARY_TURN_TIMEOUT",
  "CODEX_CANARY_PROCESS_EXIT",
  "CODEX_CANARY_PROTOCOL",
]);

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function turnId(result) {
  const id = safeIdentifier(result?.turn?.id ?? result?.turnId);
  if (!id) throw new Error("Codex compatibility canary did not receive a turn id");
  return id;
}

function threadId(result) {
  const id = safeIdentifier(result?.thread?.id ?? result?.threadId);
  if (!id) throw new Error("Codex compatibility canary did not receive a thread id");
  return id;
}

function safeIdentifier(value) {
  const id = String(value ?? "").trim();
  return SAFE_IDENTIFIER_PATTERN.test(id) ? id : null;
}

function safeProtocolMethod(value) {
  const method = String(value ?? "");
  return SAFE_PROTOCOL_METHODS.has(method) ? method : "unknown";
}

function safeTurnStatus(value) {
  const status = String(value ?? "");
  return SAFE_TURN_STATUSES.has(status) ? status : null;
}

function safeExitSignal(value) {
  const signal = String(value ?? "");
  return /^[A-Z][A-Z0-9_-]{0,31}$/u.test(signal) ? signal : null;
}

function failureKind(error) {
  if (error?.code === "CODEX_CANARY_TURN_TIMEOUT") return "turn-timeout";
  if (error?.code === "CODEX_CANARY_PROCESS_EXIT") return "process-exit";
  if (error?.code === "CODEX_CANARY_PROTOCOL") return "protocol-failure";
  if (/^Codex RPC [a-z/]+ timed out after \d+ ms$/u.test(String(error?.message ?? ""))) return "rpc-timeout";
  if (/^Codex compatibility canary timed out after \d+ ms$/u.test(String(error?.message ?? ""))) return "total-timeout";
  return "scenario-failure";
}

function safeFailureCode(error) {
  if (SAFE_FAILURE_CODES.has(error?.code)) return error.code;
  return Number.isSafeInteger(error?.code) ? error.code : null;
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
  const stderr = { observed: false, chunks: 0, bytes: 0 };
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
    mcpServer = new HubMcpServer({
      secret: randomBytes(32).toString("base64url"),
      logger: { log() {}, error: () => logger.error?.("Agent Hub canary MCP request failed") },
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
        method: safeProtocolMethod(message?.method),
        threadId: safeIdentifier(message?.params?.threadId),
        turnId: safeIdentifier(message?.params?.turn?.id ?? message?.params?.turnId),
        status: safeTurnStatus(message?.params?.turn?.status),
        request: message?.id != null,
      });
      if (message?.id != null) {
        if (message.method !== "mcpServer/elicitation/request") {
          throw Object.assign(new Error("Unexpected Codex canary client request"), {
            code: "CODEX_CANARY_PROTOCOL",
          });
        }
        const params = message.params ?? {};
        if (String(params.serverName ?? "") !== "agent_hub"
          || String(params.threadId ?? "") !== canaryThreadId
          || String(params.turnId ?? "") !== mcpTurnId
          || params.mode !== "form") {
          throw Object.assign(new Error("Codex canary received an unbound MCP elicitation request"), {
            code: "CODEX_CANARY_PROTOCOL",
          });
        }
        const response = mcpElicitationAcceptResponse(params);
        if (!response) {
          throw Object.assign(new Error("Codex canary MCP elicitation is not safely auto-answerable"), {
            code: "CODEX_CANARY_PROTOCOL",
          });
        }
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
        onExit: ({ code, signal }) => {
          if (!expectedStop) {
            record("process-exit", {
              code: Number.isSafeInteger(code) ? code : null,
              signal: safeExitSignal(signal),
            });
            failProtocol(Object.assign(new Error("Codex canary App Server stopped unexpectedly"), {
              code: "CODEX_CANARY_PROCESS_EXIT",
            }));
          }
        },
        onStderr: (text) => {
          stderr.observed = true;
          stderr.chunks = Math.min(MAX_DIAGNOSTIC_COUNT, stderr.chunks + 1);
          stderr.bytes = Math.min(
            MAX_DIAGNOSTIC_COUNT,
            stderr.bytes + Buffer.byteLength(String(text ?? ""), "utf8"),
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
    const kind = failureKind(error);
    const evidence = {
      schemaVersion: 1,
      startedAt,
      failedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      phase,
      candidate: diagnosticIdentity(candidate),
      failure: { kind, code: safeFailureCode(error) },
      protocolEvents,
      stderr,
    };
    await writeFile(failureEvidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8").catch(() => {
      logger.error?.("Cannot persist Codex canary failure evidence");
    });
    const safeError = new Error(`Codex compatibility canary failed during ${phase} (${kind})`);
    safeError.code = "CODEX_CANARY_FAILED";
    safeError.canaryEvidence = evidence;
    throw safeError;
  } finally {
    await stopCanaryTransport().catch(() => null);
    await mcpServer?.close().catch(() => null);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
