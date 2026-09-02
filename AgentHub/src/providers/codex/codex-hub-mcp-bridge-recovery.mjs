import { hubMcpToolMutates } from "../../application/hub-mcp-service.mjs";

const HUB_TOOL_PATTERN = /\btools\.mcp__agent_hub__([A-Za-z0-9_]+)/gu;
const REQUEST_ID_PATTERN = /(?:["']request_id["']|\brequest_id)\s*:\s*["']([^"'\\\r\n]{1,200})["']/gu;
const RECOVERABLE_FAILURE_PATTERN = /timed?\s*out|timeout|transport|connection|socket|aborted|cancelled|closed|reset|broken pipe/iu;
const MAX_INSPECTED_ARGUMENT_CHARS = 256 * 1024;

function collectStrings(value, output = [], seen = new Set(), depth = 0) {
  if (output.join("").length >= MAX_INSPECTED_ARGUMENT_CHARS || depth > 8) return output;
  if (typeof value === "string") {
    output.push(value.slice(0, MAX_INSPECTED_ARGUMENT_CHARS));
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(nested, output, seen, depth + 1);
  }
  return output;
}

function uniqueMatches(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => String(match[1] ?? "").trim()).filter(Boolean))];
}

export function hubMcpCallsFromDynamicItem(item) {
  if (String(item?.type ?? "") !== "dynamicToolCall") return [];
  const outerTool = String(item?.tool ?? item?.name ?? "").trim().toLowerCase();
  if (outerTool && !["exec", "functions.exec"].includes(outerTool)) return [];
  const source = collectStrings([item?.input, item?.arguments]).join("\n");
  const tools = uniqueMatches(source, HUB_TOOL_PATTERN);
  if (!tools.length) return [];
  const requestIds = uniqueMatches(source, REQUEST_ID_PATTERN);
  return tools.map((toolName) => ({
    toolName,
    mutating: hubMcpToolMutates(toolName),
    requestId: tools.length === 1 && requestIds.length === 1 ? requestIds[0] : null,
  }));
}

function failureText(item) {
  return collectStrings([
    item?.error,
    item?.contentItems,
    item?.output,
    item?.result,
  ]).join("\n");
}

export function dynamicHubMcpCallFailed(item) {
  if (!hubMcpCallsFromDynamicItem(item).length) return false;
  if (item?.success === false || String(item?.status ?? "").toLowerCase() === "failed") return true;
  return RECOVERABLE_FAILURE_PATTERN.test(failureText(item));
}

function operationOutcome(call, operation) {
  if (!call.mutating) return "read-retry-safe";
  if (!call.requestId) return "mutation-identity-missing";
  if (!operation) return "pre-dispatch";
  if (operation.status === "succeeded") return "authoritative-succeeded";
  if (operation.status === "failed") return "authoritative-failed";
  return "unknown-pending";
}

function recoveryStage(results) {
  const outcomes = new Set(results.map((result) => result.outcome));
  if (outcomes.has("unknown-pending")) {
    return "Agent Hub MCP transport recovered; mutation outcome is pending. Reconcile with the same request_id.";
  }
  if (outcomes.has("authoritative-succeeded") || outcomes.has("authoritative-failed")) {
    return "Agent Hub MCP transport recovered; the mutation has an authoritative audited outcome and must not be repeated.";
  }
  if (outcomes.has("pre-dispatch")) {
    return "Agent Hub MCP transport recovered; the mutation did not reach admission and may be retried with the same request_id.";
  }
  if (outcomes.has("mutation-identity-missing")) {
    return "Agent Hub MCP transport recovered; mutation retry is blocked because exact request_id is missing.";
  }
  return "Agent Hub MCP transport recovered; the read-only call may be retried safely.";
}

export class CodexHubMcpBridgeRecovery {
  #recovery = null;

  constructor({
    reloadMcp,
    readOperation,
    wakeDeferredInputs = () => {},
    setStage = () => {},
    logger = console,
  } = {}) {
    if (typeof reloadMcp !== "function") throw new TypeError("reloadMcp is required");
    if (typeof readOperation !== "function") throw new TypeError("readOperation is required");
    this.reloadMcp = reloadMcp;
    this.readOperation = readOperation;
    this.wakeDeferredInputs = wakeDeferredInputs;
    this.setStage = setStage;
    this.logger = logger;
  }

  async observe({ method, item, run = null } = {}) {
    if (method !== "item/completed" || !dynamicHubMcpCallFailed(item)) return null;
    const calls = hubMcpCallsFromDynamicItem(item);
    const results = calls.map((call) => {
      let operation = null;
      if (call.mutating && call.requestId) {
        try {
          operation = this.readOperation(call.requestId);
        } catch (error) {
          this.#trace("operation-read-failed", call, { error: error.message }, true);
        }
      }
      return {
        ...call,
        operationStatus: operation?.status ?? null,
        outcome: operationOutcome(call, operation),
      };
    });
    let reloadError = null;
    try {
      await this.#reload();
    } catch (error) {
      reloadError = error;
      this.#trace("bridge-reload-failed", results[0], {
        error: String(error?.message ?? error).slice(0, 500),
      }, true);
    }
    const stage = reloadError
      ? "Agent Hub MCP call reached its client deadline, but transport rebind failed. The queued lane was woken and recovery may be retried."
      : recoveryStage(results);
    if (run) this.setStage(run, stage);
    this.wakeDeferredInputs();
    for (const result of results) this.#trace(reloadError ? "bridge-recovery-deferred" : "bridge-recovered", result);
    return { recovered: !reloadError, stage, calls: results };
  }

  async #reload() {
    if (!this.#recovery) {
      this.#recovery = Promise.resolve(this.reloadMcp())
        .finally(() => { this.#recovery = null; });
    }
    return this.#recovery;
  }

  #trace(stage, call, details = {}, error = false) {
    const entry = {
      component: "codex-hub-mcp-bridge",
      stage,
      toolName: call.toolName,
      requestId: call.requestId,
      mutating: call.mutating,
      ...(call.outcome ? { outcome: call.outcome } : {}),
      ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
      ...details,
    };
    const write = error ? this.logger.error : this.logger.log;
    write?.call(this.logger, `[codex-hub-mcp-bridge] ${JSON.stringify(entry)}`);
  }
}
