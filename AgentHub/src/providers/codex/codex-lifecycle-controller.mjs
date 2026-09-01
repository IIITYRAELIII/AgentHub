import { resolveAllowedNotificationCwd } from "../../infrastructure/telegram/notification-security.mjs";
import { authorizeCodexLifecycle } from "./codex-lifecycle-authorizer.mjs";
import {
  normalizeTaskExecutionOwner,
  TASK_EXECUTION_OWNERS,
  taskExecutionRuntimeLabel,
} from "../../domain/task-execution-owner.mjs";
import { taskRunKey } from "../../domain/task-runs.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";
import { normalizeTokenUsage } from "../../domain/token-usage.mjs";
import { turnEndKey } from "../../application/turn-end-notifications.mjs";
import { conciseTurnTitle } from "../../application/turn-title.mjs";

const LIFECYCLE_COMMANDS = new Set(["turn-start", "turn-complete"]);

export class CodexLifecycleController {
  constructor(deps) {
    this.deps = deps;
  }

  supports(command) {
    return LIFECYCLE_COMMANDS.has(command);
  }

  identify(environment = {}) {
    const codexThreadId = String(environment.CODEX_THREAD_ID ?? "").trim();
    const claudeThreadId = String(environment.CLAUDE_CODE_SESSION_ID ?? "").trim();
    if (codexThreadId && claudeThreadId) {
      throw new Error("Cannot identify the runtime caller: both Codex and Claude IDs are set");
    }
    if (codexThreadId) return { provider: "codex", threadId: codexThreadId };
    if (claudeThreadId) return { provider: "claude", threadId: claudeThreadId };
    throw new Error("Cannot identify the runtime caller");
  }

  async authorize(request) {
    const d = this.deps;
    return authorizeCodexLifecycle(request, {
      identify: (environment) => this.identify(environment),
      ensureTransport: d.ensureCodexTransport,
      readThread: d.readCodexThread,
      readActivity: d.readCodexRolloutActivity,
      readUsage: d.readCodexTurnUsage,
      findProject: d.findProject,
    });
  }

  async reconcile(request) {
    if (this.supports(request.command)) {
      return {
        resolved: true,
        result: `Codex ${request.command} will be recovered from its rollout.`,
      };
    }
    return {
      resolved: false,
      terminal: true,
      error: `Outcome of interrupted ${request.command} notification is unknown; it was not repeated`,
    };
  }

  async #requestContext(request, payload) {
    const d = this.deps;
    const identity = this.identify(request.environment);
    if (identity.provider !== "codex"
      || payload.provider !== identity.provider
      || payload.threadId !== identity.threadId) {
      throw new Error(`${request.command} caller identity does not match its payload`);
    }
    const requestedProjectRoot = payload.projectRoot ?? request.cwd;
    await resolveAllowedNotificationCwd(requestedProjectRoot, {
      roots: d.config.projects.map((project) => project.path),
    });
    const project = d.findProject(requestedProjectRoot);
    if (!project) {
      throw new Error(`Cannot match the ${request.command === "turn-start" ? "started" : "completed"} turn to a configured project`);
    }
    return { identity, project };
  }

  async #handleStart(request) {
    const d = this.deps;
    if (request.args.length !== 1) throw new Error("turn-start requires one JSON payload");
    const payload = JSON.parse(request.args[0]);
    const { identity, project } = await this.#requestContext(request, payload);
    const turnId = String(payload.turnId ?? "").trim();
    if (!turnId) throw new Error("turn-start payload is missing turnId");
    const startedAt = String(payload.startedAt ?? new Date().toISOString());
    const prompt = String(payload.prompt ?? "").trim();
    const key = turnEndKey({ provider: "codex", threadId: identity.threadId, turnId });
    const existing = d.codexTurnStarts.get(key);
    const record = {
      provider: "codex",
      threadId: identity.threadId,
      turnId,
      projectRoot: project.path,
      startedAt: existing?.startedAt || startedAt,
      prompt: prompt || existing?.prompt || "",
      executionOwner: Object.values(TASK_EXECUTION_OWNERS).includes(
        normalizeTaskExecutionOwner(payload.executionOwner),
      )
        ? normalizeTaskExecutionOwner(payload.executionOwner)
        : existing?.executionOwner ?? TASK_EXECUTION_OWNERS.EXTERNAL,
      gitBaseline: payload.gitBaseline && typeof payload.gitBaseline === "object"
        ? payload.gitBaseline
        : existing?.gitBaseline ?? null,
    };
    d.setBoundedMapValue(d.codexTurnStarts, key, record, 500);
    d.setHookReceipt("start", {
      receivedAt: new Date().toISOString(),
      threadId: identity.threadId,
      turnId,
      projectRoot: project.path,
      source: String(payload.source ?? "turn-start"),
      hasPrompt: Boolean(record.prompt),
      hasGitBaseline: Boolean(record.gitBaseline),
    });
    const run = d.taskRuns.forEvent({
      provider: "codex",
      threadId: identity.threadId,
      turnId,
      allowThreadFallback: true,
    });
    if (run) {
      run.turnId ||= turnId;
      run.startedAt = record.startedAt || run.startedAt;
      run.promptPreview = record.prompt || run.promptPreview;
      run.gitBaseline = record.gitBaseline ?? run.gitBaseline;
      if (run.observer === true && record.executionOwner !== TASK_EXECUTION_OWNERS.EXTERNAL) {
        run.executionOwner = record.executionOwner;
        run.appServer = taskExecutionRuntimeLabel(record.executionOwner);
      }
      d.taskRuns.reindex(run);
    }
    await d.saveState();
    return `Recorded Codex turn start ${turnId}.`;
  }

  async #handleComplete(request) {
    const d = this.deps;
    if (request.args.length !== 1) throw new Error("turn-complete requires one JSON payload");
    const payload = JSON.parse(request.args[0]);
    const { identity, project } = await this.#requestContext(request, payload);
    d.setHookReceipt("stop", {
      receivedAt: new Date().toISOString(),
      threadId: identity.threadId,
      turnId: String(payload.turnId ?? ""),
      projectRoot: project.path,
      source: String(payload.source ?? "turn-complete"),
      status: String(payload.status ?? "unknown"),
      usageReported: payload.usageReported === true,
    });
    const run = d.taskRuns.forEvent({
      provider: "codex",
      threadId: identity.threadId,
      turnId: payload.turnId,
      allowThreadFallback: true,
    });
    const deliveredIdentity = {
      provider: "codex",
      threadId: identity.threadId,
      turnId: payload.turnId,
    };
    const turnStart = d.codexTurnStarts.get(turnEndKey(deliveredIdentity));
    if (run && turnStart) {
      run.gitBaseline = turnStart.gitBaseline ?? run.gitBaseline;
      run.startedAt = turnStart.startedAt || run.startedAt;
      run.promptPreview = turnStart.prompt || run.promptPreview;
    }
    if (isCodexContextProbeTurn({
      contextProbe: run?.contextProbe,
      prompt: String(payload.prompt ?? "").trim() || turnStart?.prompt || run?.promptPreview,
      finalAnswer: payload.finalAnswer ?? run?.responseText,
      clientUserMessageId: run?.clientUserMessageId,
      userMessages: payload.userMessages ?? run?.userMessages,
    })) {
      d.codexTurnStarts.delete(turnEndKey(deliveredIdentity));
      await d.saveState();
      return `Ignored internal Codex context probe ${payload.turnId}.`;
    }
    const alreadyDelivered = d.turnEndNotifications.hasDelivered(deliveredIdentity);
    const taskTitle = await d.taskTitle({ ...identity, run });
    let turnDiff = String(payload.diff ?? "");
    if (turnStart?.gitBaseline) {
      const baselineDiff = await d.taskGitDiff(
        turnStart.gitBaseline,
        d.config.dataDir,
        `turn-complete-${payload.turnId}`,
      ) ?? "";
      turnDiff = baselineDiff || turnDiff;
    }
    const payloadChangedFiles = [...new Set(
      Array.isArray(payload.changedFiles) ? payload.changedFiles : [],
    )];
    const rolloutChangedFiles = run?.rolloutChangeTrackingKnown === true
      ? [...new Set(Array.isArray(run.rolloutChangedFiles) ? run.rolloutChangedFiles : [])]
      : [];
    const changedFiles = payloadChangedFiles.length ? payloadChangedFiles : rolloutChangedFiles;
    const executionOwner = normalizeTaskExecutionOwner(
      turnStart?.executionOwner ?? payload.executionOwner ?? run?.executionOwner,
    );
    const lifecycleOwnsTerminal = !run && executionOwner !== TASK_EXECUTION_OWNERS.HUB;
    const responseAttachments = lifecycleOwnsTerminal
      ? await d.resolveTerminalAttachments?.({
        threadId: identity.threadId,
        startedAt: payload.startedAt ?? turnStart?.startedAt,
      }, payload.turnId) ?? []
      : [];
    const completion = d.turnEndNotifications.recordCompletion({
      provider: "codex",
      threadId: identity.threadId,
      turnId: payload.turnId,
      projectRoot: project.path,
      taskTitle,
      chatId: d.defaultNotificationChatId(),
      status: payload.status,
      usage: payload.usage,
      usageReported: payload.usageReported === true,
      imageGenerationCount: payload.imageGenerationCount ?? 0,
      estimatedCredits: payload.estimatedCredits
        ?? (payload.estimatedUnits != null ? Number(payload.estimatedUnits) / 8_000 : 0),
      estimateKind: payload.estimateKind ?? "",
      model: payload.model ?? "",
      serviceTier: payload.serviceTier ?? payload.service_tier ?? "default",
      startedAt: payload.startedAt ?? turnStart?.startedAt ?? run?.startedAt,
      completedAt: payload.completedAt,
      operationKind: "user-turn",
      contextProbe: false,
      prompt: payload.prompt ?? turnStart?.prompt ?? run?.promptPreview,
      clientUserMessageId: run?.clientUserMessageId ?? payload.clientUserMessageId ?? null,
      prompts: payload.prompts,
      userMessages: payload.userMessages ?? run?.userMessages,
      finalAnswer: payload.finalAnswer ?? "",
      responseAttachments,
      changedFiles,
      diff: turnDiff || run?.latestDiff || "",
      gitBaseline: turnStart?.gitBaseline ?? run?.gitBaseline ?? null,
      skillsUsed: payload.skillsUsed ?? run?.skillsUsed ?? [],
      mcpCalls: payload.mcpCalls ?? run?.mcpCalls ?? [],
      toolMetricsKnown: payload.toolMetricsKnown === true || run?.toolMetricsKnown === true,
    });
    if (!completion && alreadyDelivered) {
      const finalAnswer = String(payload.finalAnswer ?? "").trim();
      await d.projectTurnUsageToWorkLog({
        ...deliveredIdentity,
        projectRoot: project.path,
        taskTitle,
        status: payload.status,
        usage: normalizeTokenUsage(payload.usage),
        usageReported: payload.usageReported === true,
        estimatedCredits: payload.estimatedCredits
          ?? (payload.estimatedUnits != null ? Number(payload.estimatedUnits) / 8_000 : 0),
        estimateKind: payload.estimateKind ?? "",
        model: payload.model ?? "",
        serviceTier: payload.serviceTier ?? payload.service_tier ?? "default",
        startedAt: payload.startedAt ?? turnStart?.startedAt ?? run?.startedAt,
        completedAt: payload.completedAt,
        operationKind: "user-turn",
        contextProbe: false,
        prompt: payload.prompt ?? turnStart?.prompt ?? run?.promptPreview,
        clientUserMessageId: run?.clientUserMessageId ?? payload.clientUserMessageId ?? null,
        prompts: payload.prompts,
        userMessages: payload.userMessages ?? run?.userMessages,
        changedFiles,
        diff: turnDiff || run?.latestDiff || "",
        gitBaseline: turnStart?.gitBaseline ?? run?.gitBaseline ?? null,
        skillsUsed: payload.skillsUsed ?? run?.skillsUsed ?? [],
        mcpCalls: payload.mcpCalls ?? run?.mcpCalls ?? [],
        toolMetricsKnown: payload.toolMetricsKnown === true || run?.toolMetricsKnown === true,
        message: null,
      }, {
        title: conciseTurnTitle(finalAnswer, payload.status),
        body: finalAnswer,
      });
      if (finalAnswer) {
        d.rememberLastTaskMessage({
          provider: "codex",
          threadId: identity.threadId,
          projectRoot: project.path,
          turnId: payload.turnId,
          startedAt: payload.startedAt ?? turnStart?.startedAt ?? run?.startedAt,
          operationKind: "user-turn",
          contextProbe: false,
          clientUserMessageId: run?.clientUserMessageId ?? payload.clientUserMessageId ?? null,
        }, finalAnswer, { updatedAt: payload.completedAt });
        d.setBoundedMapValue(d.lastSeenTaskTurnIds, taskRunKey({
          provider: "codex",
          threadId: identity.threadId,
          projectRoot: project.path,
        }), payload.turnId, 500);
      }
    }
    d.codexTurnStarts.delete(turnEndKey(deliveredIdentity));
    await d.saveState();
    if (completion && lifecycleOwnsTerminal) {
      await d.deliverTurnEndNotification(completion);
    }
    return completion
      ? `Recorded Codex turn completion ${payload.turnId}.`
      : "Turn was already delivered.";
  }

  async handle(request) {
    if (request.command === "turn-start") return this.#handleStart(request);
    if (request.command === "turn-complete") return this.#handleComplete(request);
    throw new Error(`Unsupported Codex lifecycle command: ${request.command}`);
  }
}
