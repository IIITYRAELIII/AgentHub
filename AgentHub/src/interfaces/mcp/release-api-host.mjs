import { randomBytes } from "node:crypto";
import { HubMcpServer } from "./hub-mcp-server.mjs";
import { openReleaseRuntime } from "../../composition/release-api-runtime.mjs";
import { mcpArgumentsHash } from "../../domain/mcp-arguments-hash.mjs";

// Supported Hub-side source-owner adapter. External tools only see public MCP;
// persistence, authority and addressed worker ownership stay inside Hub.
export async function openReleaseApiHost(identity, {
  openRuntime = openReleaseRuntime, createServer = options => new HubMcpServer(options),
} = {}) {
  const runtime = await openRuntime();
  const active = new Set(), addressed = new Map();
  let closing = false;
  let token;
  try { token = runtime.service.contextToken(identity); }
  catch (error) { await runtime.close(); throw error; }
  const allowed = new Set(["hub_release_run", "hub_release_continue", "hub_release_get",
    "hub_task_status_update", "hub_task_operation_get", "hub_task_get"]);
  const service = {
    tools: () => runtime.service.tools().filter(tool => allowed.has(tool.name)),
    call(name, args) {
      if (closing) throw new Error("Release API owner is joining its addressed work");
      if (!allowed.has(name)) throw new Error("Not a release API command");
      if (args.context_token !== token) throw new Error("Release API caller differs from its addressed identity");
      const key = name === "hub_task_status_update" ? args.task_id
        : name === "hub_release_run" ? args.request_id : name === "hub_release_continue" ? args.operation_id : null;
      if (key && name !== "hub_task_status_update") addressed.set(`${name}:${key}`,
        name === "hub_release_run" ? { requestId: key } : { operationId: key });
      const rememberTask = () => addressed.set(`${name}:${key}`, { taskId: key, taskOriginal: structuredClone(args) });
      const pending = Promise.resolve().then(() => runtime.service.submitTaskOperation(name, args)).then(result => {
        if (name === "hub_task_status_update" && result?.taskOperation?.requestId === args.request_id) rememberTask();
        return result;
      }, error => {
        if (name === "hub_task_status_update") {
          try {
            const row = runtime.service.workspaceCatalog.mcpOperation(args.request_id);
            if (row?.toolName === name && row.argumentsHash === mcpArgumentsHash(args)) rememberTask();
          } catch (readError) {
            rememberTask(); // Join only; a failed read is never permission to execute.
            throw new AggregateError([error, readError], "Original admission and readback failed");
          }
        }
        throw error;
      });
      active.add(pending);
      void pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
  };
  const server = createServer({ service, secret: randomBytes(32).toString("base64url"), logger: { log() {}, error() {} } });
  try { await server.start(); }
  catch (error) { await runtime.close(); throw error; }
  let closed;
  return {
    connection: { protocol: "agent-hub-release-mcp-v1", url: server.url, contextToken: token },
    close() {
      return closed ??= (async () => {
        closing = true;
        const errors = [];
        try {
          await Promise.allSettled([...active]);
          for (const original of addressed.values()) {
            try {
              if (original.taskOriginal) await runtime.service.joinSubmittedTaskOperation(original.taskOriginal);
              await runtime.operations.drainAddressed(original);
            } catch (error) { errors.push(error); }
          }
        } finally {
          try { await server.close(); }
          finally { await runtime.close(); }
        }
        if (errors.length) throw new AggregateError(errors, "Release API original work could not be confirmed");
      })();
    },
  };
}
