import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORWARDED_ENVIRONMENT = ["CODEX_HOME"];

function defaultRuntimeRoot(environment = process.env) {
  if (process.platform === "win32") {
    return path.resolve(environment.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "AgentHub");
  }
  return path.resolve(environment.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agent-hub");
}

function runtimeCommandId(runtimeRoot) {
  return createHash("sha256").update(path.resolve(runtimeRoot).toLowerCase()).digest("hex").slice(0, 24);
}

function runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot = os.tmpdir()) {
  return path.join(temporaryRoot, `agent-hub-command-${runtimeCommandId(runtimeRoot)}`);
}

function forwardedEnvironment(environment, threadId) {
  const result = Object.fromEntries(FORWARDED_ENVIRONMENT
    .filter((name) => typeof environment[name] === "string" && environment[name].length <= 32_768)
    .map((name) => [name, environment[name]]));
  result.CODEX_THREAD_ID = threadId;
  return result;
}

async function writeTextAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, "utf8");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function runtimeRequest(command, payload, input, environment = process.env) {
  return {
    id: randomUUID(),
    command,
    args: [JSON.stringify(payload)],
    cwd: input.projectRoot,
    environment: forwardedEnvironment(environment, input.threadId),
  };
}

async function enqueueThroughSpool(request, runtimeRoot, temporaryRoot = os.tmpdir()) {
  const spool = runtimeCommandSpoolDirectory(runtimeRoot, temporaryRoot);
  await mkdir(spool, { recursive: true });
  await writeTextAtomic(path.join(spool, `${request.id}.request.json`), `${JSON.stringify(request)}\n`);
}

export async function enqueueLifecycleRequest(request, runtimeRoot, {
  enqueueRequest = enqueueThroughSpool,
} = {}) {
  await enqueueRequest(request, runtimeRoot);
}

export function lifecycleRequest(value, environment = process.env) {
  if (!value || typeof value !== "object") throw new Error("Expected a Codex lifecycle hook payload");
  const threadId = String(value.session_id ?? "").trim();
  const turnId = String(value.turn_id ?? "").trim();
  const projectRoot = String(value.cwd ?? "").trim();
  if (!threadId || !turnId || !projectRoot) {
    throw new Error("Codex lifecycle hook payload is missing session_id, turn_id or cwd");
  }
  const input = { threadId, turnId, projectRoot: path.resolve(projectRoot) };
  const common = {
    provider: "codex",
    threadId,
    turnId,
    projectRoot: input.projectRoot,
  };
  if (value.hook_event_name === "UserPromptSubmit") {
    const payload = {
      ...common,
      prompt: String(value.prompt ?? value.user_prompt ?? "").trim() || null,
      startedAt: new Date().toISOString(),
      gitBaseline: null,
      source: "codex-user-prompt-submit-hook-relay",
    };
    return { input, request: runtimeRequest("turn-start", payload, input, environment) };
  }
  if (value.hook_event_name === "Stop") {
    const payload = {
      ...common,
      status: "unknown",
      completedAt: new Date().toISOString(),
      source: "codex-stop-hook-relay",
    };
    return { input, request: runtimeRequest("turn-complete", payload, input, environment) };
  }
  throw new Error(`Unsupported Codex hook event: ${value.hook_event_name}`);
}

export async function main({
  environment = process.env,
  enqueueRequest = enqueueLifecycleRequest,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const chunks = [];
  input.setEncoding("utf8");
  for await (const chunk of input) chunks.push(chunk);
  const { request } = lifecycleRequest(JSON.parse(chunks.join("")), environment);
  await enqueueRequest(request, defaultRuntimeRoot(environment));
  output.write("{}\n");
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`Cannot launch Codex lifecycle hook: ${error.message}`);
    process.exitCode = 1;
  });
}
