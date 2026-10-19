import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  buildClaudeArgs,
  buildClaudePrompt,
  resolveClaudeSessionCwd,
} from "./claude.mjs";
import { markProviderTurnRequested } from "../../domain/task-runs.mjs";
import { prepareClaudeRecordingLaunch } from "../prepare-claude-recording-launch.mjs";

export class ClaudeTurnLauncher {
  #d;

  constructor(dependencies) {
    this.#d = dependencies;
  }

  async start(run, input, temporaryFiles, { forceSpeechButton = false } = {}) {
    const d = this.#d;
    const namedTitle = await d.ensureThreadNamed?.({ provider: "claude", threadId: run.threadId });
    if (namedTitle) run.taskTitle = namedTitle;
    const turnId = randomUUID();
    if (d.recordingContourRoot) {
      // The command and Stream/Thread remain canonical. Only execution paths
      // cross to the isolated view; no original temporary file is registered
      // for deletion by this run's completion path.
      run.turnId = turnId;
      const launch = await prepareClaudeRecordingLaunch({ root: d.recordingContourRoot, run, input, temporaryFiles });
      d.taskRuns.reindex(run, { turnId: null });
      if (launch.temporaryFiles.length) d.turnTemporaryFiles.set(turnId, launch.temporaryFiles);
      run.claudeTemporaryFiles = [...launch.temporaryFiles];
      run.claudeForceSpeechButton = forceSpeechButton === true;
      run.sessionCwd = launch.cwd;
      markProviderTurnRequested(run, { provider: "claude" });
      await d.persistHistory(run);
      const { temporaryFiles: ignored, ...invocation } = launch;
      await d.runController.start(run, invocation);
      return;
    }
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
    const prompt = buildClaudePrompt(input);
    const args = buildClaudeArgs({
      prompt,
      streamInput: true,
      sessionId: run.threadId,
      // Missing local transcripts recreate the same logical task UUID instead
      // of retrying --resume forever or replacing the task identity.
      resumeSession: Boolean(snapshot?.sessionId),
      model: run.modelId,
      effort: run.reasoningId,
      permissionMode: planMode ? "plan" : d.permissionMode,
      autoApprove: planMode ? false : d.autoApprove(),
      additionalDirectories,
      mcpConfig: d.mcpConfig?.(),
      appendSystemPrompt: await d.developerContext?.({ threadId: run.threadId, streamId: run.streamId }),
    });
    // Отсчёт задержки связи с моделью начинается здесь: дальше остаётся только
    // запуск процесса Claude CLI и его собственный обмен с API.
    markProviderTurnRequested(run, { provider: "claude" });
    await d.persistHistory(run);
    const invocation = d.resolveInvocation();
    await d.runController.start(run, {
      command: invocation.command,
      args: [...invocation.prefixArgs, ...args],
      cwd: sessionCwd,
      env: { ...process.env },
      input: prompt,
    });
  }
}
