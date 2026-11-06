const ACTIONS = Object.freeze({
  run: "hub_release_run", continue: "hub_release_continue", get: "hub_release_get",
  accept: "hub_task_status_update", "task-read": "hub_task_operation_get",
});

export class HubReplyUnknown extends Error {
  constructor(requestId, cause) {
    super(`Hub reply unavailable; preserve original ${requestId || "operation identity"} and read its receipt.`, { cause });
    this.name = "HubReplyUnknown";
    this.requestId = requestId;
  }
}

// Transport only. Authorization, business schemas, durable admission, queueing,
// Git, leases and effect state all belong to the existing Hub public service.
export class HubClient {
  #nextId = 0;
  constructor({ url, contextToken }, { fetchImpl = fetch } = {}) {
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error("Expected the existing Hub HTTP(S) MCP endpoint");
    }
    if (typeof contextToken !== "string" || !contextToken.trim()) throw new Error("Existing caller context is required");
    this.url = endpoint.href;
    this.contextToken = contextToken;
    this.fetch = fetchImpl;
  }

  async rpc(method, params = {}, requestId = null) {
    const id = ++this.#nextId;
    let message;
    try {
      const response = await this.fetch(this.url, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (!response.ok) throw new Error(`Hub HTTP ${response.status}`);
      message = await response.json();
      if (message.jsonrpc !== "2.0" || message.id !== id) throw new Error("Hub response identity differs");
    } catch (cause) { throw new HubReplyUnknown(requestId, cause); }
    if (message.error) throw new HubReplyUnknown(requestId, new Error(message.error.message));
    return message.result;
  }

  async call(action, business) {
    if (!Object.hasOwn(ACTIONS, action)) throw new Error("Expected run, continue, get, accept or task-read");
    if (!business || typeof business !== "object" || Array.isArray(business) || Object.hasOwn(business, "context_token")) {
      throw new Error("Request must contain business arguments, not caller credentials");
    }
    if (business.published_dev_sync != null && action !== "continue") throw new Error("Published dev sync is an addressed continuation only");
    if (action === "accept" && (business.status !== "awaiting_implementation"
      || typeof business.task_id !== "string" || !business.task_id.trim())) {
      throw new Error("Release acceptance requires an addressed Task Await request");
    }
    const reply = await this.rpc("tools/call", {
      name: ACTIONS[action], arguments: { ...business, context_token: this.contextToken },
    }, business.request_id ?? business.operation_request_id ?? business.operation_id);
    if (reply?.isError) throw new Error(reply.content?.find(item => item.type === "text")?.text || "Hub command refused");
    if (reply?.structuredContent !== undefined) return reply.structuredContent;
    throw new HubReplyUnknown(business.request_id ?? business.operation_id, new Error("Hub structured receipt missing"));
  }

  readTaskOriginal(business) {
    return this.call("task-read", {
      ...(business.task_id ? { task_id: business.task_id } : {}),
      operation_request_id: business.request_id,
      original_arguments: business,
    });
  }

  readReleaseOriginal(business) {
    return this.call("get", { operation_request_id: business.request_id, original_arguments: business });
  }
}

export async function executeRelease(client, action, request, {
  onAccepted = () => {}, wait = true,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 1000,
} = {}) {
  // Make the addressed identity immutable even if the caller changes its object.
  const original = structuredClone(request);
  let admitted;
  try { admitted = await client.call(action, original); }
  catch (error) {
    const readOriginal = action === "accept" ? () => client.readTaskOriginal(original)
      : ["run", "continue"].includes(action) ? () => client.readReleaseOriginal(original) : null;
    if (readOriginal && original.request_id) {
      // A failed transport does not prove rejection. Read only this original;
      // never issue a replacement, replay a mutation or settle the receipt.
      try {
        let receipt = await readOriginal();
        error.originalReceipt = receipt;
        while (wait && (receipt.taskOperation?.active === true || receipt.originalCommand?.active === true
          || receipt.execution?.localActive === true)) {
          await sleep(pollMs);
          receipt = await readOriginal();
          error.originalReceipt = receipt;
        }
        error.originalReceipt = receipt;
      } catch {}
    }
    throw error;
  }
  if (["get", "task-read"].includes(action) || admitted?.accepted === false) return admitted;
  let deliveryError;
  try { await onAccepted(admitted); } catch (error) { deliveryError = error; }
  if (!wait) { if (deliveryError) throw deliveryError; return admitted; }
  let result = admitted;
  if (action === "accept") {
    while (result?.taskOperation?.active === true && result.taskOperation.terminal !== true) {
      await sleep(pollMs);
      result = await client.readTaskOriginal(original);
    }
  } else if (admitted?.operationId) {
    for (;;) {
      result = await client.call("get", { operation_id: admitted.operationId });
      // Waiting/unknown is an owner boundary, not permission to continue.
      if (result?.execution?.localActive !== true) break;
      await sleep(pollMs);
    }
  }
  if (deliveryError) { deliveryError.originalReceipt = result; throw deliveryError; }
  return result;
}
