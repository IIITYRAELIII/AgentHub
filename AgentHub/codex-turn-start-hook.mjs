import path from "node:path";
import process from "node:process";

import { displayUserPrompt } from "./task-history.mjs";
import { captureTaskGitBaseline } from "./task-git-diff.mjs";
import {
  enqueueRuntimeCommandThroughSpool,
  forwardRuntimeCommand,
  runtimeCommandUnavailable,
} from "./runtime-command.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./runtime-layout.mjs";
import { isMainModule } from "./main-module.mjs";

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

export function validateTurnStartHookInput(value) {
  if (!value || typeof value !== "object" || value.hook_event_name !== "UserPromptSubmit") {
    throw new Error("Expected a Codex UserPromptSubmit hook payload");
  }
  const threadId = String(value.session_id ?? "").trim();
  const turnId = String(value.turn_id ?? "").trim();
  const projectRoot = String(value.cwd ?? "").trim();
  if (!threadId || !turnId || !projectRoot) {
    throw new Error("UserPromptSubmit hook payload is missing session_id, turn_id or cwd");
  }
  return {
    threadId,
    turnId,
    projectRoot: path.resolve(projectRoot),
    prompt: displayUserPrompt(value.prompt ?? value.user_prompt ?? ""),
  };
}

export async function handleCodexTurnStartHook(value, {
  captureBaseline = captureTaskGitBaseline,
  forward = forwardRuntimeCommand,
  enqueue = enqueueRuntimeCommandThroughSpool,
  environment = process.env,
  dataDir = runtimeLayout(defaultRuntimeRoot()).dataDir,
  now = () => new Date(),
} = {}) {
  const input = validateTurnStartHookInput(value);
  const startedAt = now().toISOString();
  const basePayload = {
    provider: "codex",
    threadId: input.threadId,
    turnId: input.turnId,
    projectRoot: input.projectRoot,
    prompt: input.prompt || null,
    startedAt,
    source: "codex-user-prompt-submit-hook",
  };
  const register = async (payload) => {
    const args = [JSON.stringify(payload)];
    try {
      await forward("turn-start", args, {
        cwd: input.projectRoot,
        environment: { ...environment, CODEX_THREAD_ID: input.threadId },
        timeoutMs: 10_000,
      });
      return false;
    } catch (error) {
      if (!runtimeCommandUnavailable(error)) throw error;
      await enqueue("turn-start", args, {
        cwd: input.projectRoot,
        environment: { ...environment, CODEX_THREAD_ID: input.threadId },
      });
      return true;
    }
  };

  // Persist the exact prompt before the potentially expensive multi-repository
  // Git snapshot. Codex limits hook execution time, so snapshotting first could
  // lose the prompt entirely when a large workspace exceeded that limit.
  const initiallyQueued = await register({ ...basePayload, gitBaseline: null });
  const gitBaseline = await captureBaseline(
    input.projectRoot,
    dataDir,
    `codex-turn-${input.turnId}`,
  );
  const payload = { ...basePayload, gitBaseline };
  const baselineQueued = await register(payload);
  return { queued: initiallyQueued || baselineQueued, payload };
}

export async function main() {
  const raw = await readStdin();
  await handleCodexTurnStartHook(JSON.parse(raw));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Cannot register Codex turn start: ${error.message}`);
    process.exitCode = 1;
  });
}
