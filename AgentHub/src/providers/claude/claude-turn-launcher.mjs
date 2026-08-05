import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  buildClaudeArgs,
  buildClaudePrompt,
  claudeThinkingTokens,
  resolveClaudeSessionCwd,
} from "./claude.mjs";

export class ClaudeTurnLauncher {
  #d;

  constructor(dependencies) {
    this.#d = dependencies;
  }

  async start(run, input, temporaryFiles, { forceSpeechButton = false } = {}) {
    const d = this.#d;
    const turnId = randomUUID();
    const additionalDirectories = (Array.isArray(input) ? input : [])
      .filter((item) => ["localImage", "localFile"].includes(item?.type) && item.path)
      .map((item) => path.dirname(item.path));
    run.turnId = turnId;
    d.taskRuns.reindex(run, { turnId: null });
    if (temporaryFiles.length) d.turnTemporaryFiles.set(turnId, temporaryFiles);
    run.claudeTemporaryFiles = [...temporaryFiles];
    run.claudeForceSpeechButton = forceSpeechButton === true;

    let snapshot = null;
    if (run.threadId) {
      snapshot = await d.taskSnapshots.read(run.threadId).catch((error) => {
        d.logWarning(`Cannot resolve Claude session directory ${run.threadId}:`, error.message);
        return null;
      });
    }
    const sessionCwd = resolveClaudeSessionCwd(
      run.projectRoot,
      run.sessionCwd ?? snapshot?.sessionRoot ?? run.projectRoot,
    );
    run.sessionCwd = sessionCwd;
    const planMode = run.collaborationMode === "plan";
    const args = buildClaudeArgs({
      prompt: buildClaudePrompt(input),
      sessionId: run.threadId,
      // Missing local transcripts recreate the same logical task UUID instead
      // of retrying --resume forever or replacing the task identity.
      resumeSession: Boolean(snapshot?.sessionId),
      model: run.modelId,
      permissionMode: planMode ? "plan" : d.permissionMode,
      autoApprove: planMode ? false : d.autoApprove(),
      additionalDirectories,
    });
    await d.persistHistory(run);
    const invocation = d.resolveInvocation();
    await d.runController.start(run, {
      command: invocation.command,
      args: [...invocation.prefixArgs, ...args],
      cwd: sessionCwd,
      env: {
        ...process.env,
        MAX_THINKING_TOKENS: String(claudeThinkingTokens(run.reasoningId)),
      },
    });
  }
}
