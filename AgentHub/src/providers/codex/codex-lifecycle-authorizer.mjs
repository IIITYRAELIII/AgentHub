export async function authorizeCodexLifecycle(request, {
  identify,
  ensureTransport,
  readThread,
  readActivity,
  readUsage,
  findProject,
  now = () => new Date(),
}) {
  if (!new Set(["turn-start", "turn-complete"]).has(request.command)) return request;
  if (request.args.length !== 1) throw new Error(`${request.command} requires one JSON payload`);
  const received = JSON.parse(request.args[0]);
  const identity = identify(request.environment);
  const turnId = String(received.turnId ?? "").trim();
  if (identity.provider !== "codex"
    || received.provider !== identity.provider
    || received.threadId !== identity.threadId
    || !turnId) throw new Error("Lifecycle notification does not identify a Codex turn");
  await ensureTransport();
  const threadResult = await readThread(identity.threadId, { fresh: true, includeTurns: false });
  const rolloutPath = String(threadResult.thread?.path ?? "").trim();
  const project = findProject(threadResult.thread?.cwd);
  if (!rolloutPath || !project) throw new Error("Cannot verify the lifecycle turn against a configured Codex rollout");
  const usage = await readUsage(rolloutPath, turnId, { attempts: 1 });
  if (request.command === "turn-start") {
    const activity = await readActivity(rolloutPath);
    if (!activity.activeTurnIds.includes(turnId)) throw new Error("Lifecycle turn is not active in the Codex rollout");
  } else if (!usage.terminal) {
    throw new Error("Lifecycle turn is not terminal in the Codex rollout");
  }
  const payload = request.command === "turn-start"
    ? {
      provider: "codex", threadId: identity.threadId, turnId, projectRoot: project.path,
      prompt: usage.prompt || null, startedAt: usage.startedAt || now().toISOString(),
      gitBaseline: null, source: "verified-codex-rollout",
    }
    : {
      provider: "codex", threadId: identity.threadId, turnId, projectRoot: project.path,
      status: usage.status || "unknown", startedAt: usage.startedAt || null,
      completedAt: usage.completedAt || null, prompt: usage.prompt || null,
      changedFiles: usage.changedFiles ?? [], diff: usage.diff || "",
      skillsUsed: usage.skillsUsed ?? [], mcpCalls: usage.mcpCalls ?? [],
      toolMetricsKnown: usage.toolMetricsKnown === true, usage: usage.usage ?? null,
      usageReported: usage.reported === true, imageGenerationCount: usage.imageGenerationCount ?? 0,
      estimatedCredits: usage.estimatedCredits ?? 0, estimateKind: usage.estimateKind ?? "",
      model: usage.model ?? "", serviceTier: usage.serviceTier ?? "default",
      finalAnswer: usage.finalAnswer ?? "", source: "verified-codex-rollout",
    };
  return { ...request, cwd: project.path, args: [JSON.stringify(payload)] };
}
