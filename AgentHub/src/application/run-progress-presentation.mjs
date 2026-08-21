export class RunProgressPresentation {
  constructor({
    telegramLimit,
    claudeModelLabels,
    codexReasoningLabels,
    codexModelLabel,
    taskExecutionRuntimeLabel,
    formatProgressHeading,
    formatProgressHeartbeat,
    showProject,
    taskTitle,
    projectName,
    currentCodexModel,
    currentClaudeModel,
    currentCodexReasoning,
    currentClaudeReasoning,
    taskExecutionOwners,
  }) {
    this.telegramLimit = telegramLimit;
    this.claudeModelLabels = claudeModelLabels;
    this.codexReasoningLabels = codexReasoningLabels;
    this.codexModelLabel = codexModelLabel;
    this.taskExecutionRuntimeLabel = taskExecutionRuntimeLabel;
    this.formatProgressHeading = formatProgressHeading;
    this.formatProgressHeartbeat = formatProgressHeartbeat;
    this.showProject = showProject;
    this.taskTitle = taskTitle;
    this.projectName = projectName;
    this.currentCodexModel = currentCodexModel;
    this.currentClaudeModel = currentClaudeModel;
    this.currentCodexReasoning = currentCodexReasoning;
    this.currentClaudeReasoning = currentClaudeReasoning;
    this.taskExecutionOwners = taskExecutionOwners;
  }

  heading(run, done = false) {
    const fallbackModel = run?.provider === "claude"
      ? this.claudeModelLabels[this.currentClaudeModel()]
      : this.codexModelLabel(this.currentCodexModel());
    const reasoningId = run?.provider === "claude"
      ? this.currentClaudeReasoning()
      : this.currentCodexReasoning();
    const fallbackReasoning = this.codexReasoningLabels[reasoningId];
    const runtime = run?.appServer ?? (
      run?.provider === "codex"
        ? this.taskExecutionRuntimeLabel(run?.executionOwner ?? (
          run?.observer
            ? this.taskExecutionOwners.VSCODE
            : this.taskExecutionOwners.HUB
        ))
        : run?.observer
          ? "Внешний Claude CLI"
          : this.taskExecutionRuntimeLabel(this.taskExecutionOwners.HUB)
    );
    return this.formatProgressHeading({
      done,
      provider: run?.provider === "claude" ? "Claude Code" : "Codex",
      model: run?.observer ? run.model || null : run?.model ?? fallbackModel,
      reasoning: run?.observer
        ? run.reasoning || "Подключённый ход"
        : run?.reasoning ?? fallbackReasoning,
      runtime,
      task: this.taskTitle(run),
      project: this.showProject() ? this.projectName(run) : null,
    });
  }

  render(run, done = false) {
    const parts = [this.heading(run, done), run?.progressStage || "Выполняется…"];
    if (done) return parts.join("\n\n").slice(0, this.telegramLimit);
    if (Number(run?.activeTurnCount) > 1) {
      parts.push(`🔀 Активных ходов в этом потоке: ${Number(run.activeTurnCount)}`);
    }
    const heartbeat = this.formatProgressHeartbeat(run);
    if (heartbeat) parts.push(heartbeat);
    if (run?.progressReasoning?.trim()) {
      const reasoning = run.progressReasoning.trim();
      parts.push(`💭 ${reasoning.length > 900 ? `…${reasoning.slice(-900)}` : reasoning}`);
    }
    if (run?.responseText?.trim()) {
      const answer = run.responseText.trim();
      parts.push(`✍️ Ответ формируется:\n${answer.length > 2400 ? `…${answer.slice(-2400)}` : answer}`);
    }
    return parts.join("\n\n").slice(0, this.telegramLimit);
  }
}
