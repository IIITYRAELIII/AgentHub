import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const PLAN_ACTION = "read-workspace-release-plan";
const MISSING_PLAN = "Task release plan is unavailable";

function contextConfiguration(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid bootstrap MCP context configuration"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.context_token !== "string" || !value.context_token.trim()
      || typeof value.workspaceId !== "string" || !value.workspaceId.trim()
      || !/^[a-f0-9]{40,64}$/u.test(value.runtimeRevision ?? "")
      || typeof value.url !== "string"
      || !/^http:\/\/127\.0\.0\.1(?::\d+)?\/mcp\/[A-Za-z0-9_-]+$/u.test(value.url)) {
    throw new Error("Invalid bootstrap MCP context configuration");
  }
  try {
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1"
        || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error("Invalid bootstrap MCP endpoint"); }
  return value;
}

// Explicit compatibility bridge to the existing canonical plan tool only.
// That tool also verifies/prepares dev integration; this is not a new Git owner.
export function createBootstrapReleasePlanControl({
  contextFile = null, control, readState, read = readFile, fetchImpl = fetch,
} = {}) {
  if (typeof control !== "function") throw new TypeError("Desktop control is required");
  if (!contextFile) return control;
  if (typeof readState !== "function") throw new TypeError("Publication state reader is required");
  return async (action, parameters, options) => {
    try { return await control(action, parameters, options); }
    catch (error) {
      if (action !== PLAN_ACTION || error?.message !== MISSING_PLAN) throw error;
    }
    let raw;
    try { raw = await read(contextFile, "utf8"); }
    catch { throw new Error("Cannot read bootstrap MCP context configuration"); }
    const configuration = contextConfiguration(raw);
    if (parameters?.workspaceId !== configuration.workspaceId) throw new Error("Bootstrap MCP Workspace mismatch");
    const assertRuntime = async () => {
      if ((await readState())?.revision !== configuration.runtimeRevision) {
        throw new Error("Bootstrap MCP runtime revision changed");
      }
    };
    await assertRuntime();
    const id = randomUUID();
    let envelope;
    try {
      const response = await fetchImpl(configuration.url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id, method: "tools/call",
          params: { name: "hub_release_plan_get", arguments: {
            context_token: configuration.context_token, workspace_id: configuration.workspaceId,
          } },
        }),
      });
      if (!response.ok) throw new Error();
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new Error();
      envelope = JSON.parse(body);
    } catch { throw new Error("Bootstrap MCP plan request failed"); }
    if (envelope?.jsonrpc !== "2.0" || envelope.id !== id || envelope.error
        || envelope.result?.isError !== false) throw new Error("Bootstrap MCP plan response failed");
    const plan = envelope.result.structuredContent;
    if (!plan || plan.workspaceId !== configuration.workspaceId
        || typeof plan.revision !== "string" || !plan.revision
        || !Array.isArray(plan.candidates)) throw new Error("Bootstrap MCP plan identity mismatch");
    await assertRuntime();
    return plan;
  };
}
