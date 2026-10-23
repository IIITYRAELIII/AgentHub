import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTaskAwaitCutoverRuntime } from "./task-await-cutover.mjs";
import { createReleaseOperationServices } from "./src/composition/release-operation-composition.mjs";
import { createReleaseCorrectionRequester } from "./src/composition/infrastructure-composition.mjs";
import { AGENT_HUB_VERSION } from "./src/infrastructure/filesystem/agent-hub-package.mjs";

const tools = { run: "hub_release_run", continue: "hub_release_continue", get: "hub_release_get",
  accept: "hub_task_status_update" };

export function parseReleaseArguments(argv) {
  const [action, ...rest] = argv;
  if (!Object.hasOwn(tools, action)) throw new Error("Expected release action: run, continue, get or accept");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!["--provider", "--thread", "--stream", "--request-file"].includes(name)
        || Object.hasOwn(values, name) || !value || value.startsWith("--")) throw new Error("Invalid release argument");
    values[name] = value;
  }
  if (Object.keys(values).length !== 4) throw new Error("Release requires provider, thread, stream and request-file");
  return { action, provider: values["--provider"], threadId: values["--thread"], streamId: values["--stream"],
    requestFile: path.resolve(values["--request-file"]) };
}

export async function openReleaseRuntime({
  openTaskRuntime = openTaskAwaitCutoverRuntime,
  createServices = createReleaseOperationServices,
} = {}) {
  const runtime = await openTaskRuntime();
  try {
    const { service, config, taskBoard, workspaceCatalog } = runtime;
    const { operations } = createServices({
      dataDir: config.dataDir, runtimeRoot: path.dirname(config.dataDir),
      taskBoard, taskLifecycle: service.taskLifecycle, workspaceCatalog,
      releasePreflight: service.releasePreflight,
      taskGitWorkspaces: service.taskGitWorkspaces, releaseGitWorkspaces: service.releasePreflight.releaseGitWorkspaces,
      requestCorrection: createReleaseCorrectionRequester({ taskBoard, taskLifecycle: service.taskLifecycle }),
      runnerVersion: AGENT_HUB_VERSION,
    });
    service.releaseOperations = operations;
    return { ...runtime, operations };
  } catch (error) { runtime.close(); throw error; }
}

export async function executeRelease(input, {
  openRuntime = openReleaseRuntime,
  onAccepted = () => {},
} = {}) {
  if (!Object.hasOwn(tools, input.action)) throw new Error("Unsupported release action");
  const bytes = await readFile(input.requestFile);
  const request = JSON.parse(bytes.toString("utf8"));
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.hasOwn(request, "context_token")) {
    throw new Error("Release request must contain business arguments, not a caller token");
  }
  if (input.action === "accept" && (request.status !== "awaiting_implementation"
      || typeof request.task_id !== "string" || !request.task_id.trim())) {
    throw new Error("Release acceptance requires an addressed Task Await request");
  }
  const runtime = await openRuntime();
  try {
    const token = runtime.service.contextToken({ provider: input.provider, threadId: input.threadId, streamId: input.streamId });
    let result;
    try {
      result = await runtime.service.call(tools[input.action], { ...request, context_token: token });
    } catch (error) {
      if (input.action !== "get") {
        // The public MCP receipt can fail after durable release admission.
        // Wait for only addressed local work (including normal Task wakes); do not replay the call or
        // settle its unknown receipt from a successful release readback.
        await runtime.operations.drainAddressed({
          ...(input.action === "accept" ? { taskId: request.task_id }
            : input.action === "run" ? { requestId: request.request_id } : { operationId: request.operation_id }),
        });
      }
      throw error;
    }
    if (input.action === "get" || result.accepted === false) return result;
    // The durable acknowledgement is visible before waiting; a lost client
    // response is read through the same public get, never a fresh release ID.
    let replyError = null;
    try { onAccepted(result); } catch (error) { replyError = error; }
    let snapshot;
    if (input.action === "accept") {
      await runtime.operations.drainAddressed({ taskId: request.task_id });
      snapshot = result;
    } else snapshot = await runtime.operations.drain(result.operationId);
    if (replyError) throw replyError;
    return snapshot;
  } finally { runtime.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on("error", () => {
    process.exitCode = 1;
    process.stderr.write("Release reply was lost; read the same operation before continuing.\n");
  });
  executeRelease(parseReleaseArguments(process.argv.slice(2)), {
    onAccepted: result => process.stdout.write(`${JSON.stringify({ accepted: result })}\n`),
  }).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
