import { createHash } from "node:crypto";

import {
  consistentInterstreamRecordIdentity,
  normalizeInterstreamClientUserMessageId,
} from "../domain/interstream-message.mjs";

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

function responseAttachments(value) {
  return Array.isArray(value) ? value.map((item) => structuredClone(item)) : [];
}

function attachmentKey(value) {
  return String(value?.id ?? value?.path ?? value?.url ?? "").trim()
    || JSON.stringify(value ?? null);
}

function sameAttachments(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => (
    attachmentKey(item) === attachmentKey(right[index])
    && (item?.missing === true) === (right[index]?.missing === true)
  ));
}

function generatedOutputAttachments(value) {
  return value.filter((item) => /^codex-generated-/u.test(String(item?.id ?? "")));
}

function richerAttachments(current, candidate) {
  if (!candidate.length) return current;
  if (candidate.length > current.length) return candidate;
  if (candidate.length < current.length) return current;
  const sameIdentity = candidate.every((item, index) => (
    attachmentKey(item) === attachmentKey(current[index])
  ));
  if (!sameIdentity) return current;
  const currentMissing = current.filter((item) => item?.missing === true).length;
  const candidateMissing = candidate.filter((item) => item?.missing === true).length;
  return candidateMissing < currentMissing ? candidate : current;
}

function historySnapshot(run, completion) {
  const source = run ?? {};
  const rootMessage = (Array.isArray(source.userMessages) ? source.userMessages : [])
    .find((message) => message?.role === "user") ?? null;
  const identity = consistentInterstreamRecordIdentity({
    clientUserMessageIds: [
      source.clientUserMessageId,
      completion.clientUserMessageId,
      rootMessage?.clientUserMessageId,
    ],
    origins: [
      source.messageOrigin,
      completion.messageOrigin,
      rootMessage?.origin ?? rootMessage?.messageOrigin,
    ],
  });
  const userMessages = (Array.isArray(source.userMessages) ? source.userMessages : []).map((message) => {
    const value = structuredClone(message);
    const messageIdentity = consistentInterstreamRecordIdentity({
      clientUserMessageIds: [value?.clientUserMessageId],
      origins: [value?.origin ?? value?.messageOrigin],
    });
    if (messageIdentity.conflicted || (message === rootMessage && identity.conflicted)) {
      delete value.clientUserMessageId;
      delete value.origin;
      delete value.messageOrigin;
      return value;
    }
    if (messageIdentity.clientUserMessageId) {
      value.clientUserMessageId = messageIdentity.clientUserMessageId;
    }
    return value;
  });
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
    operationKind: completion.operationKind ?? source.operationKind,
    taskTitle: completion.taskTitle,
    promptPreview: String(source.rawPrompt ?? source.promptPreview ?? completion.prompt ?? ""),
    responseText: String(completion.finalAnswer ?? source.responseText ?? ""),
    ...(responseAnnotationReferences?.length
      ? {
        responseAnnotationReferences: structuredClone(
          responseAnnotationReferences,
        ),
      }
      : {}),
    responseItemId: String(source.responseItemId ?? ""),
    clientUserMessageId: identity.conflicted
      ? null
      : normalizeInterstreamClientUserMessageId(
        identity.clientUserMessageId ?? completion.clientUserMessageId,
      ),
    ...(!identity.conflicted && identity.messageOrigin
      ? { messageOrigin: structuredClone(identity.messageOrigin) }
      : {}),
    submittedAt: source.submittedAt ?? source.userMessages?.[0]?.submittedAt ?? source.userMessages?.[0]?.time ?? source.startedAt ?? null,
    userMessages,
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

  async commit(completion, {
    run = null,
    channelIntents = {},
    expectedTerminalRevision = null,
  } = {}) {
    if (!completion?.provider || !completion?.threadId || !completion?.turnId) {
      throw new Error("terminal completion requires provider, threadId and turnId");
    }
    const finalAnswer = String(completion.finalAnswer ?? "").trim();
    const durableCompletion = structuredClone(completion);
    const completionRootMessage = (Array.isArray(durableCompletion.userMessages)
      ? durableCompletion.userMessages
      : []).find((message) => message?.role === "user") ?? null;
    const completionIdentity = consistentInterstreamRecordIdentity({
      clientUserMessageIds: [
        durableCompletion.clientUserMessageId,
        completionRootMessage?.clientUserMessageId,
      ],
      origins: [
        durableCompletion.messageOrigin,
        completionRootMessage?.origin ?? completionRootMessage?.messageOrigin,
      ],
    });
    if (completionIdentity.conflicted) {
      delete durableCompletion.clientUserMessageId;
      delete durableCompletion.messageOrigin;
      if (completionRootMessage) {
        delete completionRootMessage.clientUserMessageId;
        delete completionRootMessage.origin;
        delete completionRootMessage.messageOrigin;
      }
    } else if (completionIdentity.clientUserMessageId) {
      durableCompletion.clientUserMessageId = completionIdentity.clientUserMessageId;
    }
    const body = finalAnswer || String(completion.message?.text ?? "").trim();
    const lastMessage = completion.aggregateOnly ? null : {
      text: body,
      updatedAt: completion.completedAt,
      startedAt: completion.startedAt || null,
    };
    const commandId = normalizeInterstreamClientUserMessageId(
      run?.clientUserMessageId ?? completion.clientUserMessageId,
    ) ?? "";
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
            ...durableCompletion,
            ...(String(run?.id ?? "").trim() ? { runId: String(run.id).trim() } : {}),
          },
          history: historySnapshot(run, durableCompletion),
        },
        channels: channelIntents,
        ...Number.isSafeInteger(expectedTerminalRevision)
          ? { expectedTerminalRevision }
          : {},
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

  async enrichResponseAttachments(identity, {
    expectedCount = 1,
    resolveAttachments,
    maximumAttempts = 4,
  } = {}) {
    if (typeof resolveAttachments !== "function") {
      throw new TypeError("terminal attachment resolver is required");
    }
    const targetCount = Math.max(1, Math.floor(Number(expectedCount) || 1));
    let terminal = await this.get(identity);
    if (!terminal) return { enriched: false, terminal: null, outbox: null };

    const completionAttachments = responseAttachments(
      terminal.payload?.completion?.responseAttachments,
    );
    const historyAttachments = responseAttachments(
      terminal.payload?.history?.responseAttachments,
    );
    let recovered = richerAttachments(completionAttachments, historyAttachments);
    let authoritativeRecovery = false;
    if (recovered.length < targetCount) {
      const resolved = responseAttachments(await resolveAttachments());
      authoritativeRecovery = generatedOutputAttachments(resolved).length >= targetCount;
      recovered = authoritativeRecovery ? resolved : richerAttachments(recovered, resolved);
    } else if (generatedOutputAttachments(recovered).length < targetCount
      || generatedOutputAttachments(recovered).length !== recovered.length) {
      const resolved = responseAttachments(await resolveAttachments());
      authoritativeRecovery = generatedOutputAttachments(resolved).length >= targetCount;
      recovered = authoritativeRecovery ? resolved : richerAttachments(recovered, resolved);
    }
    if (!recovered.length) return { enriched: false, terminal, outbox: null };

    const attempts = Math.max(1, Math.min(10, Math.floor(Number(maximumAttempts) || 4)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      terminal = attempt === 0 ? terminal : await this.get(identity);
      if (!terminal) return { enriched: false, terminal: null, outbox: null };
      const currentCompletion = terminal.payload?.completion ?? {};
      const currentHistory = terminal.payload?.history ?? {};
      const currentCompletionAttachments = responseAttachments(
        currentCompletion.responseAttachments,
      );
      const currentHistoryAttachments = responseAttachments(
        currentHistory.responseAttachments,
      );
      const currentBest = richerAttachments(
        currentCompletionAttachments,
        currentHistoryAttachments,
      );
      const currentGenerated = generatedOutputAttachments(currentBest);
      const desired = authoritativeRecovery && (
        currentGenerated.length < targetCount || currentGenerated.length !== currentBest.length
      ) ? recovered : richerAttachments(currentBest, recovered);
      if (sameAttachments(currentCompletionAttachments, desired)
        && sameAttachments(currentHistoryAttachments, desired)) {
        return { enriched: false, terminal, outbox: null };
      }
      const result = await this.store.commit({
        provider: terminal.provider,
        threadId: terminal.threadId,
        turnId: terminal.turnId,
        status: terminal.status,
        finalAnswer: terminal.finalAnswer,
        usageIdentity: terminal.usageIdentity,
        lastMessage: terminal.lastMessage,
        payload: {
          ...structuredClone(terminal.payload),
          completion: {
            ...structuredClone(currentCompletion),
            responseAttachments: desired,
          },
          history: {
            ...structuredClone(currentHistory),
            responseAttachments: desired,
          },
        },
        expectedTerminalRevision: terminal.terminalRevision,
      });
      if (result.conflict) continue;
      this.terminals.set(terminalKey(identity), result.terminal);
      result.commandReconciled = await this.#reconcileTerminal(result.terminal);
      return { ...result, enriched: result.created === true };
    }
    throw new Error(`terminal attachment enrichment did not settle for ${terminalKey(identity)}`);
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

  pendingProjections(options) {
    return this.store.pendingProjections(options);
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
    const clientUserMessageId = normalizeInterstreamClientUserMessageId(
      history.clientUserMessageId ?? completion.clientUserMessageId ?? "",
    );
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
