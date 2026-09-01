const DEFAULT_ADMISSION_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_ATTEMPTS = 2;

function nonEmptyText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function identifierValue(value) {
  if (typeof value === "string" || typeof value === "number") return nonEmptyText(value);
  if (!value || typeof value !== "object") return null;
  return nonEmptyText(value.default ?? value.const);
}

function findNamedValue(value, names, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (names.has(key)) {
      const found = identifierValue(nested);
      if (found) return found;
    }
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findNamedValue(item, names, seen, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = findNamedValue(nested, names, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

export function mcpOperationIdentity(params = {}) {
  return {
    requestId: findNamedValue(params, new Set(["request_id", "requestId"])),
    toolName: findNamedValue(params, new Set(["tool_name", "toolName"])),
  };
}

export class McpAdmissionCoordinator {
  #pending = new Map();

  constructor({
    timeoutMs = DEFAULT_ADMISSION_TIMEOUT_MS,
    maxResponseAttempts = DEFAULT_MAX_RESPONSE_ATTEMPTS,
    schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    clear = (timer) => clearTimeout(timer),
    logger = console,
  } = {}) {
    this.timeoutMs = Math.max(1, Math.trunc(Number(timeoutMs) || DEFAULT_ADMISSION_TIMEOUT_MS));
    this.maxResponseAttempts = Math.max(
      1,
      Math.trunc(Number(maxResponseAttempts) || DEFAULT_MAX_RESPONSE_ATTEMPTS),
    );
    this.schedule = schedule;
    this.clear = clear;
    this.logger = logger;
  }

  begin({
    rpcId,
    params = {},
    response,
    respond,
    runId = null,
    threadId = null,
    turnId = null,
    source = "auto",
    isActive = () => true,
  } = {}) {
    if (rpcId === undefined || rpcId === null) throw new TypeError("MCP elicitation rpcId is required");
    if (typeof respond !== "function") throw new TypeError("MCP elicitation respond is required");
    const key = String(rpcId);
    const previous = this.#pending.get(key);
    if (previous) this.#clearRecord(previous);
    const identity = mcpOperationIdentity(params);
    const record = {
      key,
      rpcId,
      response,
      respond,
      source,
      runId: nonEmptyText(runId),
      threadId: nonEmptyText(threadId ?? params.threadId),
      turnId: nonEmptyText(turnId ?? params.turnId),
      serverName: nonEmptyText(params.serverName),
      operationRequestId: identity.requestId,
      toolName: identity.toolName,
      isActive,
      attempts: 0,
      timer: null,
    };
    if (!record.operationRequestId && (!record.threadId || !record.turnId)) {
      this.#trace("elicitation-uncorrelated", record);
      this.#send(record, "single-untracked-response");
      return this.#snapshot(record);
    }
    this.#pending.set(key, record);
    this.#trace("elicitation-received", record);
    this.#send(record, "initial");
    this.#schedule(record);
    return this.#snapshot(record);
  }

  admit({ serverName = null, requestId = null, toolName = null, rpcRequestId = null } = {}) {
    const operationRequestId = nonEmptyText(requestId);
    const normalizedServer = nonEmptyText(serverName);
    if (!operationRequestId) return false;
    let admitted = false;
    for (const record of this.#pending.values()) {
      if (record.operationRequestId !== operationRequestId) continue;
      if (record.serverName && normalizedServer && record.serverName !== normalizedServer) continue;
      this.#trace("operation-admitted", record, {
        admittedToolName: nonEmptyText(toolName),
        rpcRequestId: nonEmptyText(rpcRequestId),
      });
      this.#clearRecord(record);
      this.#pending.delete(record.key);
      admitted = true;
    }
    return admitted;
  }

  progress({ threadId = null, turnId = null, method = null } = {}) {
    const normalizedThread = nonEmptyText(threadId);
    const normalizedTurn = nonEmptyText(turnId);
    if (!normalizedThread || !normalizedTurn) return false;
    let progressed = false;
    for (const record of this.#pending.values()) {
      if (record.threadId !== normalizedThread || record.turnId !== normalizedTurn) continue;
      this.#trace("provider-continuation-observed", record, { method: nonEmptyText(method) });
      this.#clearRecord(record);
      this.#pending.delete(record.key);
      progressed = true;
    }
    return progressed;
  }

  observeOperation(stage, details = {}) {
    this.#trace(stage, null, details);
  }

  diagnostics() {
    return [...this.#pending.values()].map((record) => this.#snapshot(record));
  }

  #send(record, reason) {
    record.attempts += 1;
    try {
      const result = record.respond(record.rpcId, record.response);
      this.#trace("elicitation-response-dispatched", record, { reason });
      Promise.resolve(result).then(
        () => this.#trace("elicitation-response-flushed", record, { reason }),
        (error) => this.#trace(
          "elicitation-response-write-failed",
          record,
          { error: error.message, reason },
          true,
        ),
      );
    } catch (error) {
      this.#trace("elicitation-response-write-failed", record, { error: error.message, reason }, true);
    }
  }

  #schedule(record) {
    record.timer = this.schedule(() => this.#expire(record), this.timeoutMs);
    record.timer?.unref?.();
  }

  #expire(record) {
    if (this.#pending.get(record.key) !== record) return;
    if (!record.isActive()) {
      this.#trace("elicitation-cancelled-inactive", record);
      this.#pending.delete(record.key);
      return;
    }
    this.#trace("operation-admission-timeout", record, { outcome: "unknown" }, true);
    if (record.attempts >= this.maxResponseAttempts) {
      this.#trace("operation-admission-unresolved", record, { outcome: "unknown" }, true);
      this.#pending.delete(record.key);
      return;
    }
    this.#send(record, "admission-timeout-retry");
    this.#schedule(record);
  }

  #clearRecord(record) {
    if (record.timer) this.clear(record.timer);
    record.timer = null;
  }

  #snapshot(record) {
    return {
      rpcId: String(record.rpcId),
      serverName: record.serverName,
      requestId: record.operationRequestId,
      toolName: record.toolName,
      threadId: record.threadId,
      turnId: record.turnId,
      runId: record.runId,
      attempts: record.attempts,
    };
  }

  #trace(stage, record = null, details = {}, error = false) {
    const entry = {
      component: "mcp-admission",
      stage,
      ...(record ? this.#snapshot(record) : {}),
      ...details,
    };
    const write = error ? this.logger.error : this.logger.log;
    write?.call(this.logger, `[mcp-admission] ${JSON.stringify(entry)}`);
  }
}
