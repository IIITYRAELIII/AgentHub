import { createHmac } from "node:crypto";
import { createServer } from "node:http";

import { AGENT_HUB_VERSION } from "../../infrastructure/filesystem/agent-hub-package.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CLIENT_TOOL_TIMEOUT_SECONDS = 75;
const REQUEST_TIMEOUT_ERROR_CODE = -32001;
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

function requestTimeoutMessage(timeoutMs) {
  const duration = timeoutMs % 1_000 === 0
    ? `${timeoutMs / 1_000} seconds`
    : `${timeoutMs} ms`;
  return `Agent Hub MCP request timed out after ${duration}; outcome is unknown. Reuse the same request_id when retrying a mutation.`;
}

async function withRequestTimeout(operation, timeoutMs) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error(requestTimeoutMessage(timeoutMs)), {
        code: REQUEST_TIMEOUT_ERROR_CODE,
      }));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("MCP request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

export class HubMcpServer {
  #server = null;
  #url = null;

  constructor({
    service,
    secret,
    host = "127.0.0.1",
    port = 0,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    clientToolTimeoutSeconds = DEFAULT_CLIENT_TOOL_TIMEOUT_SECONDS,
    logger = console,
    captureUnexpectedException = () => false,
    mcpAdmissionCoordinator = null,
  } = {}) {
    if (typeof service?.tools !== "function" || typeof service?.call !== "function") {
      throw new TypeError("Hub MCP service is required");
    }
    const endpointSecret = String(secret ?? "").trim();
    if (!endpointSecret) throw new TypeError("Hub MCP endpoint secret is required");
    this.service = service;
    const endpointCapability = createHmac("sha256", endpointSecret)
      .update("agent-hub-mcp-endpoint")
      .digest("base64url");
    this.endpointPath = `/mcp/${endpointCapability}`;
    this.host = host;
    this.port = Number(port) || 0;
    this.requestTimeoutMs = Math.max(1, Math.trunc(Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
    this.clientToolTimeoutSeconds = Math.max(
      Math.ceil(this.requestTimeoutMs / 1_000) + 1,
      Math.trunc(Number(clientToolTimeoutSeconds) || DEFAULT_CLIENT_TOOL_TIMEOUT_SECONDS),
    );
    this.logger = logger;
    this.captureUnexpectedException = captureUnexpectedException;
    this.mcpAdmissionCoordinator = mcpAdmissionCoordinator;
  }

  #capture(error, action) {
    try {
      this.captureUnexpectedException(error, {
        surface: "mcp",
        kind: "control",
        component: "hub-mcp-server",
        action,
      });
    } catch {}
  }

  get running() {
    return Boolean(this.#server?.listening);
  }

  get url() {
    if (!this.#url) throw new Error("Agent Hub MCP server is not running");
    return this.#url;
  }

  codexArgs() {
    return [
      "-c", `mcp_servers.agent_hub.url=${JSON.stringify(this.url)}`,
      "-c", "mcp_servers.agent_hub.enabled=true",
      "-c", `mcp_servers.agent_hub.tool_timeout_sec=${this.clientToolTimeoutSeconds}`,
    ];
  }

  claudeConfig() {
    return JSON.stringify({
      mcpServers: {
        agent_hub: { type: "http", url: this.url },
      },
    });
  }

  async start() {
    if (this.running) return this.url;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        this.#capture(error, "request");
        this.logger.error?.("Agent Hub MCP request failed:", error.message);
        if (!response.headersSent) writeJson(response, 500, jsonRpcError(null, -32603, "Internal error"));
        else response.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.port, this.host, resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Cannot resolve Agent Hub MCP address");
    this.#url = `http://${this.host}:${address.port}${this.endpointPath}`;
    this.logger.log?.(`Agent Hub MCP listening on ${this.host}:${address.port}`);
    return this.#url;
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    this.#url = null;
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    }
    await this.service.close?.();
  }

  async #handle(request, response) {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== this.endpointPath) {
      writeJson(response, 404, jsonRpcError(null, -32601, "Not found"));
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, jsonRpcError(null, -32600, "Only POST is supported"));
      return;
    }
    let message;
    try {
      message = await readJson(request);
    } catch (error) {
      writeJson(response, error.message.includes("too large") ? 413 : 400, jsonRpcError(null, -32700, error.message));
      return;
    }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      writeJson(response, 400, jsonRpcError(message?.id, -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (message.id == null) {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return;
    }
    try {
      const result = await withRequestTimeout(
        this.#dispatch(message.method, message.params ?? {}, { rpcRequestId: message.id }),
        this.requestTimeoutMs,
      );
      writeJson(response, 200, jsonRpcResult(message.id, result));
    } catch (error) {
      if (error?.code !== REQUEST_TIMEOUT_ERROR_CODE) this.#capture(error, "dispatch");
      writeJson(response, 200, jsonRpcError(message.id, Number(error?.code) || -32603, error.message));
    }
  }

  async #dispatch(method, params, { rpcRequestId = null } = {}) {
    if (method === "initialize") {
      const requested = String(params?.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent_hub", title: "Agent Hub", version: AGENT_HUB_VERSION },
        instructions: "Copy the exact non-empty context_token from the current <agent_hub_context> developer block into every Agent Hub tool call. It is not an environment variable.",
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: this.service.tools() };
    if (method === "tools/call") {
      const toolName = String(params?.name ?? "").trim();
      const toolArguments = params?.arguments ?? {};
      const requestId = String(toolArguments?.request_id ?? "").trim() || null;
      this.mcpAdmissionCoordinator?.admit({
        serverName: "agent_hub",
        requestId,
        toolName,
        rpcRequestId,
      });
      this.mcpAdmissionCoordinator?.observeOperation("tool-call-received", {
        serverName: "agent_hub",
        requestId,
        toolName,
        rpcRequestId: String(rpcRequestId ?? "") || null,
      });
      try {
        const structuredContent = await this.service.call(toolName, toolArguments);
        this.mcpAdmissionCoordinator?.observeOperation("tool-call-completed", {
          serverName: "agent_hub", requestId, toolName, rpcRequestId: String(rpcRequestId ?? "") || null,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
          isError: false,
        };
      } catch (error) {
        this.mcpAdmissionCoordinator?.observeOperation("tool-call-failed", {
          serverName: "agent_hub", requestId, toolName,
          rpcRequestId: String(rpcRequestId ?? "") || null,
          error: error.message,
        });
        return {
          content: [{ type: "text", text: error.message }],
          isError: true,
        };
      }
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}
