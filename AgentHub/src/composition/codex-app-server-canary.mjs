import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { AGENT_HUB_VERSION } from "../infrastructure/filesystem/agent-hub-package.mjs";
import { protectRuntimeDirectory } from "../infrastructure/filesystem/runtime-security.mjs";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
import { HubMcpServer } from "../interfaces/mcp/hub-mcp-server.mjs";
import { CodexAppServerTransport } from "../providers/codex/codex-app-server-transport.mjs";
import { codexThreadSandboxSettings, codexTurnSandboxSettings } from "../providers/codex/codex-sandbox.mjs";

const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

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

export async function runCodexAppServerCompatibilityCanary(candidate, {
  dataDir,
  executableArgs = [],
  model = "",
  environment = process.env,
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
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
  let transport = null;
  let mcpServer = null;
  let expectedStop = false;
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

    const completed = new Map();
    const waiters = new Map();
    let rejectProtocolFailure;
    const protocolFailure = new Promise((_, reject) => { rejectProtocolFailure = reject; });
    const failProtocol = (error) => rejectProtocolFailure(
      error instanceof Error ? error : new Error(String(error)),
    );
    const onMessage = async (message) => {
      if (message?.method !== "turn/completed") return;
      const id = String(message.params?.turn?.id ?? message.params?.turnId ?? "").trim();
      if (!id) return;
      completed.set(id, message.params?.turn ?? message.params);
      waiters.get(id)?.(completed.get(id));
      waiters.delete(id);
    };
    const waitForTurn = (id) => completed.has(id)
      ? Promise.resolve(completed.get(id))
      : withTimeout(new Promise((resolve) => waiters.set(id, resolve)), rpcTimeoutMs, `Canary turn ${id} timed out`);
    const startTransport = async () => {
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
        onStderr: () => {},
        onInvalidMessage: failProtocol,
        onMessageError: failProtocol,
        rpcTimeoutMs,
      });
      await transport.start();
      const initialized = await transport.initialize({
        clientInfo: { name: "agent_hub_canary", version: AGENT_HUB_VERSION },
        capabilities: { experimentalApi: true },
      });
      if (initialized.newlyInitialized) transport.notify("initialized");
      await transport.request("thread/list", { limit: 1 }, { timeoutMs: rpcTimeoutMs });
    };
    const startTurn = async (id, text) => {
      const result = await transport.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text }],
        ...(model ? { model } : {}),
        effort: "low",
        ...codexTurnSandboxSettings("workspace-write", projectRoot),
      }, { timeoutMs: rpcTimeoutMs });
      const idOfTurn = turnId(result);
      return { id: idOfTurn, completion: waitForTurn(idOfTurn) };
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
      const createdThreadId = threadId(await transport.request("thread/start", {
        cwd: projectRoot,
        ...(model ? { model } : {}),
        ...codexThreadSandboxSettings("workspace-write"),
        serviceName: "agent_hub_codex_update_canary",
      }, { timeoutMs: rpcTimeoutMs }));

      const ordinary = await startTurn(createdThreadId, "Reply exactly CANARY_ORDINARY_OK. Do not use tools.");
      await expectSuccessfulTurn(ordinary);
      const mcp = await startTurn(
        createdThreadId,
        `Call the agent_hub MCP tool hub_canary_read exactly once with context_token ${canaryContextToken}, then reply exactly CANARY_MCP_OK.`,
      );
      await expectSuccessfulTurn(mcp);
      if (mcpReadCount !== 1) throw new Error(`Canary expected one Agent Hub MCP read, observed ${mcpReadCount}`);

      const interrupted = await startTurn(createdThreadId, "Produce a detailed response of at least 10000 words.");
      await transport.request("turn/interrupt", {
        threadId: createdThreadId,
        turnId: interrupted.id,
      }, { timeoutMs: rpcTimeoutMs });
      await interrupted.completion;
      const afterCancel = await startTurn(createdThreadId, "Reply exactly CANARY_AFTER_CANCEL_OK. Do not use tools.");
      await expectSuccessfulTurn(afterCancel);

      expectedStop = true;
      await transport.stop();
      expectedStop = false;
      await startTransport();
      await transport.request("thread/resume", {
        threadId: createdThreadId,
        ...codexThreadSandboxSettings("workspace-write"),
      }, { timeoutMs: rpcTimeoutMs });
      const afterResume = await startTurn(createdThreadId, "Reply exactly CANARY_AFTER_RESUME_OK. Do not use tools.");
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
      };
    })();
    const evidence = await withTimeout(
      Promise.race([scenario, protocolFailure]),
      totalTimeoutMs,
      `Codex compatibility canary timed out after ${totalTimeoutMs} ms`,
    );
    return { ok: true, evidence };
  } finally {
    expectedStop = true;
    await transport?.stop().catch(() => null);
    await mcpServer?.close().catch(() => null);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
