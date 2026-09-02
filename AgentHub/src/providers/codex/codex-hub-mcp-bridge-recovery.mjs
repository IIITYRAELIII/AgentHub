import { hubMcpToolMutates } from "../../application/hub-mcp-service.mjs";

const HUB_TOOL_AT = /tools\.mcp__agent_hub__([A-Za-z0-9_]+)\s*\(/uy;
const REQUEST_ID_PROPERTY = /^\s*(?:"request_id"|'request_id'|request_id)\s*:\s*(["'])([^"'\\\r\n]{1,200})\1\s*$/u;
const MAX_INSPECTED_ARGUMENT_CHARS = 256 * 1024;
const SUCCESS_STATUSES = new Set(["completed", "success", "succeeded"]);
const FAILURE_STATUSES = new Set(["aborted", "cancelled", "canceled", "error", "failed", "timed_out"]);

function collectStrings(value, output = [], seen = new Set(), depth = 0, state = { chars: 0 }) {
  if (state.chars >= MAX_INSPECTED_ARGUMENT_CHARS || depth > 8) return output;
  if (typeof value === "string") {
    const text = value.slice(0, MAX_INSPECTED_ARGUMENT_CHARS - state.chars);
    if (text) output.push(text);
    state.chars += text.length;
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(nested, output, seen, depth + 1, state);
  }
  return output;
}

function skipNonCode(text, index) {
  const quote = text[index];
  if (["\"", "'", "`"].includes(quote)) {
    for (let cursor = index + 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\") cursor += 1;
      else if (text[cursor] === quote) return cursor + 1;
    }
    return text.length;
  }
  if (text[index] === "/" && text[index + 1] === "/") {
    const newline = text.indexOf("\n", index + 2);
    return newline < 0 ? text.length : newline + 1;
  }
  if (text[index] === "/" && text[index + 1] === "*") {
    const close = text.indexOf("*/", index + 2);
    return close < 0 ? text.length : close + 2;
  }
  return index;
}

function matchingObjectEnd(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const skipped = skipNonCode(text, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function objectProperties(source) {
  const properties = [];
  let start = 1;
  let curly = 1;
  let square = 0;
  let round = 0;
  for (let index = 1; index < source.length - 1; index += 1) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const char = source[index];
    if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "," && curly === 1 && square === 0 && round === 0) {
      properties.push(source.slice(start, index));
      start = index + 1;
    }
  }
  properties.push(source.slice(start, -1));
  return properties;
}

function requestIdentity(objectSource) {
  const requestIds = objectProperties(objectSource).flatMap((property) => {
    const match = REQUEST_ID_PROPERTY.exec(property);
    return match ? [match[2]] : [];
  });
  if (requestIds.length === 1) return { requestId: requestIds[0], requestIdIssue: null };
  return {
    requestId: null,
    requestIdIssue: requestIds.length > 1 ? "duplicate-property" : "missing",
  };
}

function callsFromSource(source) {
  const calls = [];
  for (let index = 0; index < source.length;) {
    const skipped = skipNonCode(source, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    HUB_TOOL_AT.lastIndex = index;
    const match = HUB_TOOL_AT.exec(source);
    const previous = index > 0 ? source[index - 1] : "";
    if (!match || /[A-Za-z0-9_$]/u.test(previous)) {
      index += 1;
      continue;
    }
    const toolName = match[1];
    const mutating = hubMcpToolMutates(toolName);
    let argumentStart = HUB_TOOL_AT.lastIndex;
    while (/\s/u.test(source[argumentStart] ?? "")) argumentStart += 1;
    let identity = { requestId: null, requestIdIssue: mutating ? "unstructured" : null };
    if (source[argumentStart] === "{") {
      const end = matchingObjectEnd(source, argumentStart);
      if (end >= 0) identity = mutating
        ? requestIdentity(source.slice(argumentStart, end + 1))
        : { requestId: null, requestIdIssue: null };
    }
    calls.push({
      toolName,
      mutating,
      requestId: identity.requestId,
      ...(identity.requestIdIssue ? { requestIdIssue: identity.requestIdIssue } : {}),
    });
    index = HUB_TOOL_AT.lastIndex;
  }
  return calls;
}

function rejectDuplicateRequestIds(calls) {
  const counts = new Map();
  for (const call of calls) {
    if (call.mutating && call.requestId) {
      counts.set(call.requestId, Number(counts.get(call.requestId) ?? 0) + 1);
    }
  }
  return calls.map((call) => (
    call.requestId && counts.get(call.requestId) > 1
      ? { ...call, requestId: null, requestIdIssue: "duplicate-across-calls" }
      : call
  ));
}

function argumentSources(item) {
  const sources = collectStrings([item?.input, item?.arguments]);
  const expanded = [];
  for (const source of sources) {
    expanded.push(source);
    const trimmed = source.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      expanded.push(...collectStrings(JSON.parse(trimmed)));
    } catch {
      // A raw JavaScript block is inspected as source; it is never evaluated.
    }
  }
  return [...new Set(expanded)];
}

export function hubMcpCallsFromDynamicItem(item) {
  if (String(item?.type ?? "") !== "dynamicToolCall") return [];
  const outerTool = String(item?.tool ?? item?.name ?? "").trim().toLowerCase();
  if (outerTool && !["exec", "functions.exec"].includes(outerTool)) return [];
  return rejectDuplicateRequestIds(argumentSources(item).flatMap(callsFromSource));
}

export function dynamicHubMcpCallFailed(item) {
  if (!hubMcpCallsFromDynamicItem(item).length) return false;
  const status = String(item?.status ?? "").trim().toLowerCase();
  if (item?.success === true || SUCCESS_STATUSES.has(status)) return false;
  if (item?.success === false || FAILURE_STATUSES.has(status)) return true;
  return item?.error !== undefined && item?.error !== null;
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
      ...(call.requestIdIssue ? { requestIdIssue: call.requestIdIssue } : {}),
      ...(call.outcome ? { outcome: call.outcome } : {}),
      ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
      ...details,
    };
    const write = error ? this.logger.error : this.logger.log;
    write?.call(this.logger, `[codex-hub-mcp-bridge] ${JSON.stringify(entry)}`);
  }
}
