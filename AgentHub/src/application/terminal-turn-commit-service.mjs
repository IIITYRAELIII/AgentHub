import { createHash } from "node:crypto";

function usageIdentity(completion) {
  const value = {
    usage: completion?.usage ?? {},
    usageReported: completion?.usageReported === true,
    estimatedCredits: Number(completion?.estimatedCredits) || 0,
    estimateKind: String(completion?.estimateKind ?? ""),
    model: String(completion?.model ?? ""),
    serviceTier: String(completion?.serviceTier ?? ""),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function terminalKey(value) {
  return [value?.provider, value?.threadId, value?.turnId]
    .map((part) => String(part ?? "").trim())
    .join("\0");
}

function historySnapshot(run, completion) {
  const source = run ?? {};
  const responseAnnotationReferences = Array.isArray(completion.responseAnnotationReferences)
    && completion.responseAnnotationReferences.length
    ? completion.responseAnnotationReferences
    : source.responseAnnotationReferences;
  return {
    id: String(source.id ?? "").trim() || null,
    streamId: source.streamId ?? completion.streamId ?? null,
    provider: completion.provider,
    projectRoot: completion.projectRoot,
    threadId: completion.threadId,
    turnId: completion.turnId,
    taskTitle: completion.taskTitle,
    promptPreview: String(source.promptPreview ?? completion.prompt ?? ""),
    responseText: String(completion.finalAnswer ?? source.responseText ?? ""),
    ...(responseAnnotationReferences?.length
      ? {
        responseAnnotationReferences: structuredClone(
          responseAnnotationReferences,
        ),
      }
      : {}),
    responseItemId: String(source.responseItemId ?? ""),
    clientUserMessageId: String(source.clientUserMessageId ?? "") || null,
    submittedAt: source.submittedAt ?? source.userMessages?.[0]?.submittedAt ?? source.userMessages?.[0]?.time ?? source.startedAt ?? null,
    userMessages: Array.isArray(source.userMessages) ? structuredClone(source.userMessages) : [],
    activities: Array.isArray(source.activities) ? structuredClone(source.activities) : [],
    activityGroups: Array.isArray(source.activityGroups) ? structuredClone(source.activityGroups) : [],
    messageAttachments: Array.isArray(source.messageAttachments)
      ? structuredClone(source.messageAttachments)
      : [],
    responseAttachments: Array.isArray(source.responseAttachments)
      ? structuredClone(source.responseAttachments)
      : Array.isArray(completion.responseAttachments)
        ? structuredClone(completion.responseAttachments)
        : [],
    progressStage: source.progressStage,
    startedAt: completion.startedAt || source.startedAt,
    providerStart: source.providerStart ? structuredClone(source.providerStart) : null,
    model: completion.model || source.model,
    modelId: source.modelId,
    serviceTier: completion.serviceTier || source.serviceTier,
    executionOwner: source.executionOwner,
  };
}

export class TerminalTurnCommitService {
  constructor({ store, messageCommands = null, commandTrace = null, logger = console }) {
    if (!store?.commit || !store?.get) throw new TypeError("terminal turn store is required");
    if (messageCommands && typeof messageCommands.transitionMessageCommand !== "function") {
      throw new TypeError("message command transition port is invalid");
    }
    this.store = store;
    this.messageCommands = messageCommands;
    this.commandTrace = commandTrace;
    this.logger = logger;
    this.terminals = new Map();
  }

  async commit(completion, { run = null, channelIntents = {} } = {}) {
    if (!completion?.provider || !completion?.threadId || !completion?.turnId) {
      throw new Error("terminal completion requires provider, threadId and turnId");
    }
    const finalAnswer = String(completion.finalAnswer ?? "").trim();
    const body = finalAnswer || String(completion.message?.text ?? "").trim();
    const lastMessage = completion.aggregateOnly ? null : {
      text: body,
      updatedAt: completion.completedAt,
      startedAt: completion.startedAt || null,
    };
    const commandId = String(run?.clientUserMessageId ?? completion.clientUserMessageId ?? "").trim();
    const trace = this.commandTrace?.startBestEffortSpan?.({
      commandId,
      stage: "terminal-commit",
      transport: String(run?.clientSource ?? "server-runtime").trim().toLowerCase() || "server-runtime",
      metadata: { provider: completion.provider, threadId: completion.threadId, turnId: completion.turnId },
    });
    let result;
    try {
      result = await this.store.commit({
        provider: completion.provider,
        threadId: completion.threadId,
        turnId: completion.turnId,
        status: completion.status,
        finalAnswer,
      usageIdentity: usageIdentity(completion),
      lastMessage,
      payload: {
        completion: {
          ...structuredClone(completion),
          ...(String(run?.id ?? "").trim() ? { runId: String(run.id).trim() } : {}),
        },
        history: historySnapshot(run, completion),
      },
      channels: channelIntents,
      });
    } catch (error) {
      trace?.finish({ outcome: "failed", metadata: { errorCode: error?.code ?? null } });
      throw error;
    }
    trace?.finish({
      outcome: "succeeded",
      metadata: { terminalRevision: result?.terminal?.terminalRevision ?? null, runId: run?.id ?? null },
    });
    this.terminals.set(terminalKey(completion), result.terminal);
    result.commandReconciled = await this.#reconcileTerminal(result.terminal);
    return result;
  }

  async get(identity) {
    const key = terminalKey(identity);
    const terminal = await this.store.get(identity);
    if (terminal) this.terminals.set(key, terminal);
    else this.terminals.delete(key);
    await this.#reconcileTerminal(terminal);
    return terminal;
  }

  isTerminal(identity) {
    return this.get(identity).then(Boolean);
  }

  async pending(options) {
    const items = await this.store.pending(options);
    for (const item of items) {
      await this.#reconcileTerminal({
        ...item,
        status: item.payload?.completion?.status,
        payload: item.payload,
      });
    }
    return items;
  }

  recoverProjecting() {
    return this.store.recoverProjecting();
  }

  claim(identity) {
    return this.store.claim(identity);
  }

  acknowledge(identity) {
    return this.store.acknowledge(identity);
  }

  retry(identity, error) {
    return this.store.retry(identity, error);
  }

  markChannelUncertain(identity, options) {
    return this.store.updateChannel(identity, "telegram", "uncertain", options);
  }

  acknowledgeChannel(identity, options) {
    return this.store.updateChannel(identity, "telegram", "acked", options);
  }

  failChannel(identity, options) {
    return this.store.updateChannel(identity, "telegram", "failed", options);
  }

  async #reconcileTerminal(terminal) {
    if (!terminal || !this.messageCommands) return false;
    const completion = terminal.payload?.completion ?? {};
    const history = terminal.payload?.history ?? {};
    const clientUserMessageId = String(
      history.clientUserMessageId ?? completion.clientUserMessageId ?? "",
    ).trim();
    if (!clientUserMessageId) return false;
    const normalizedStatus = String(terminal.status ?? completion.status ?? "completed").trim().toLowerCase();
    const commandState = normalizedStatus === "completed"
      ? "completed"
      : normalizedStatus.includes("cancel") || normalizedStatus === "aborted" ? "cancelled" : "failed";
    try {
      const outcome = await this.messageCommands.transitionMessageCommand({
        clientUserMessageId,
        expectedStates: [
          "accepted", "queued", "attention-required", "dispatching", "started", "unknown",
          "completed", "failed", "cancelled",
        ],
        state: commandState,
        authoritativeTerminal: true,
        result: {
          accepted: true,
          completed: commandState === "completed",
          failed: commandState === "failed",
          cancelled: commandState === "cancelled",
          provider: terminal.provider,
          threadId: terminal.threadId,
          turnId: terminal.turnId,
          terminalRevision: terminal.terminalRevision,
          status: terminal.status,
          runId: history.id ?? null,
        },
      });
      if (outcome?.conflict) {
        this.logger.error(`Cannot reconcile terminal message command ${clientUserMessageId}: state conflict`);
        return false;
      }
      const reconciled = outcome?.changed === true
        || outcome?.idempotent === true
        || outcome?.record == null;
      if (reconciled && typeof this.store.acknowledgeCommand === "function") {
        await this.store.acknowledgeCommand(terminal, {
          error: outcome?.record == null ? "message command not found; no admission owner" : "",
        });
      }
      return reconciled;
    } catch (error) {
      this.logger.error(`Cannot reconcile terminal message command ${clientUserMessageId}:`, error.message);
      return false;
    }
  }
}
