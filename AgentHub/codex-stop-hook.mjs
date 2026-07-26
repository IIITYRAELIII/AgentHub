import process from "node:process";

import { readCodexTurnUsage } from "./codex-turn-usage.mjs";
import {
  enqueueRuntimeCommandThroughSpool,
  forwardRuntimeCommand,
  runtimeCommandUnavailable,
} from "./runtime-command.mjs";
import { isMainModule } from "./main-module.mjs";

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

export function validateStopHookInput(value) {
  if (!value || typeof value !== "object" || value.hook_event_name !== "Stop") {
    throw new Error("Expected a Codex Stop hook payload");
  }
  const threadId = String(value.session_id ?? "").trim();
  const turnId = String(value.turn_id ?? "").trim();
  const projectRoot = String(value.cwd ?? "").trim();
  const transcriptPath = String(value.transcript_path ?? "").trim();
  if (!threadId || !turnId || !projectRoot) {
    throw new Error("Stop hook payload is missing session_id, turn_id or cwd");
  }
  return { threadId, turnId, projectRoot, transcriptPath };
}

export async function handleCodexStopHook(value, {
  readUsage = readCodexTurnUsage,
  forward = forwardRuntimeCommand,
  enqueue = enqueueRuntimeCommandThroughSpool,
  environment = process.env,
} = {}) {
  const input = validateStopHookInput(value);
  let usageResult = null;
  let usageError = "";
  if (input.transcriptPath) {
    try {
      usageResult = await readUsage(input.transcriptPath, input.turnId);
    } catch (error) {
      usageError = String(error?.message ?? error);
    }
  } else {
    usageError = "Stop hook did not provide transcript_path";
  }
  const payload = {
    provider: "codex",
    threadId: input.threadId,
    turnId: input.turnId,
    projectRoot: input.projectRoot,
    status: "completed",
    startedAt: usageResult?.startedAt || null,
    completedAt: usageResult?.completedAt || new Date().toISOString(),
    usage: usageResult?.usage ?? null,
    usageReported: usageResult?.reported === true,
    usageError,
    source: "codex-stop-hook",
  };
  const args = [JSON.stringify(payload)];
  try {
    await forward("turn-complete", args, {
      cwd: input.projectRoot,
      environment: { ...environment, CODEX_THREAD_ID: input.threadId },
      timeoutMs: 10_000,
    });
    return { queued: false, payload };
  } catch (error) {
    if (!runtimeCommandUnavailable(error)) throw error;
    await enqueue("turn-complete", args, {
      cwd: input.projectRoot,
      environment: { ...environment, CODEX_THREAD_ID: input.threadId },
    });
    return { queued: true, payload };
  }
}

export async function main() {
  const raw = await readStdin();
  const value = JSON.parse(raw);
  await handleCodexStopHook(value);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Cannot register Codex turn completion: ${error.message}`);
    process.exitCode = 1;
  });
}
