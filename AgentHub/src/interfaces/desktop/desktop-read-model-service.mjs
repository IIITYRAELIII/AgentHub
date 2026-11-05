export class DesktopReadModelService {
  constructor({
    snapshot,
    resolveReadTask,
    readStateStore,
    trustedDeviceUserId,
    hasAllowedUsers = () => false,
    androidEnabled = () => false,
    lastTaskMessage,
    hasUnread,
    commandTrace = null,
  } = {}) {
    if (typeof snapshot !== "function") throw new TypeError("snapshot is required");
    if (typeof resolveReadTask !== "function") throw new TypeError("resolveReadTask is required");
    if (!readStateStore || typeof readStateStore.markRead !== "function") {
      throw new TypeError("readStateStore is required");
    }
    if (typeof trustedDeviceUserId !== "function") {
      throw new TypeError("trustedDeviceUserId is required");
    }
    if (typeof lastTaskMessage !== "function") {
      throw new TypeError("lastTaskMessage is required");
    }
    if (typeof hasUnread !== "function") throw new TypeError("hasUnread is required");
    Object.assign(this, {
      snapshotImpl: snapshot,
      resolveReadTask,
      readStateStore,
      trustedDeviceUserId,
      hasAllowedUsers,
      androidEnabled,
      lastTaskMessage,
      hasUnread,
      commandTrace,
    });
  }

  accountId(context = null) {
    const requested = String(context?.userId ?? "").trim();
    if (requested) return this.trustedDeviceUserId(context);
    if (this.hasAllowedUsers() || this.androidEnabled()) {
      return this.trustedDeviceUserId(null);
    }
    return "local";
  }

  async snapshot(params = {}, context = null) {
    const accountId = this.accountId(context);
    return this.snapshotImpl({
      ...(params ?? {}),
      // Read state belongs to the authenticated/local Hub account. Request
      // parameters cannot switch the account whose unread markers are read.
      accountId,
      // Apply canonical read/run state before collection hashes are calculated.
      projectTask: (task) => this.projectTask(task, accountId),
    });
  }

  latestFinal(entry) {
    const lastMessage = this.lastTaskMessage(entry);
    const provider = String(entry?.provider ?? lastMessage?.provider ?? "").trim().toLowerCase();
    const threadId = String(entry?.threadId ?? lastMessage?.threadId ?? "").trim();
    const turnId = String(lastMessage?.turnId ?? "").trim();
    const completedAt = String(lastMessage?.updatedAt ?? "").trim();
    if (!provider || !threadId || !turnId || !completedAt) return null;
    const terminalRevision = Number(lastMessage?.terminalRevision);
    const revision = Number.isSafeInteger(terminalRevision) && terminalRevision > 0
      ? terminalRevision
      : 1;
    return {
      provider,
      threadId,
      turnId,
      revision,
      completedAt,
      ...(terminalRevision > 0 ? {} : { migrationGuard: "legacy-terminal-revision" }),
    };
  }

  projectTask(task, accountId = "") {
    const latestFinal = this.latestFinal(task);
    const run = task?.run;
    const operation = this.projectedOperation(run, task?.context);
    const terminalAbsorbsRun = Boolean(
      latestFinal?.turnId
      && String(run?.turnId ?? "").trim() === latestFinal.turnId,
    );
    const userRunning = task?.running === true
      && operation.kind === "user-turn"
      && !terminalAbsorbsRun;
    const cursor = latestFinal && typeof this.readStateStore.get === "function"
      ? this.readStateStore.get({ accountId, provider: latestFinal.provider, threadId: latestFinal.threadId })
      : null;
    const unread = latestFinal ? this.hasUnread({
      accountId,
      provider: latestFinal.provider,
      threadId: latestFinal.threadId,
      answerAt: latestFinal.completedAt,
      answerTurnId: latestFinal.turnId,
      answerRevision: latestFinal.revision,
      migrationGuard: latestFinal.migrationGuard,
    }, cursor) : false;
    return {
      ...task,
      running: userRunning,
      activityUnknown: task?.activityUnknown === true || (task?.running === true && operation.kind === "unknown"),
      lastAnswerRevision: latestFinal?.revision ?? null,
      latestFinal,
      readCursor: cursor ? { answerAtMs: cursor.answerAtMs, answerTurnId: cursor.answerTurnId,
        answerRevision: cursor.answerRevision } : null,
      unread,
      run: userRunning ? {
        ...run,
        operationKind: operation.kind,
        ...(operation.migrationGuard ? { operationKindMigrationGuard: operation.migrationGuard } : {}),
        projectionState: "active",
      } : null,
    };
  }

  projectedOperation(run, context) {
    const explicit = String(run?.operationKind ?? "").trim().toLowerCase();
    if (explicit) {
      return { kind: explicit };
    }
    if (!run) return { kind: "unknown" };
    const clientId = String(run.clientUserMessageId ?? "").trim();
    if (context?.compaction?.status === "running"
      && String(context.compaction.turnId ?? "") === String(run.turnId ?? "")) {
      return { kind: "compaction", migrationGuard: "legacy-compaction-observer" };
    }
    const hasUserEvidence = Boolean(
      clientId
      || String(run.prompt ?? "").trim()
      || (Array.isArray(run.userMessages) && run.userMessages.length),
    );
    if (hasUserEvidence) return { kind: "user-turn", migrationGuard: "legacy-managed-run-shape" };
    if (run.observer === true && context?.usagePending === true) {
      return { kind: "measurement", migrationGuard: "legacy-usage-observer" };
    }
    return { kind: "unknown" };
  }

  async markTaskRead(params, context = null) {
    const requested = params?.final ?? params;
    const accountId = this.accountId(context);
    const commandId = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(params?.clientTraceId ?? "")
      ? params.clientTraceId : "";
    // Resolve the exact catalog/selection identity and its saved final through
    // the same read owner. Board, telemetry, live payloads and server snapshots
    // are unrelated to this cursor write and must not gate its receipt.
    const resolve = () => this.resolveReadTask({
      provider: requested?.provider,
      threadId: requested?.threadId,
      streamId: params?.streamId,
    });
    const task = this.commandTrace?.measureBestEffort
      ? await this.commandTrace.measureBestEffort({ commandId, stage: "read-final-resolve", transport: "server" }, resolve)
      : await resolve();
    const current = task ? this.latestFinal(task) : null;
    const recordDecision = (decision) => this.commandTrace?.recordBestEffort?.({
      commandId, stage: "read-final-decision", transport: "server", outcome: "succeeded",
      metadata: { decision, ...(current ? { provider: current.provider, threadId: current.threadId,
        turnId: current.turnId, terminalRevision: current.revision } : {}) },
    });
    if (!current) { recordDecision("no-final"); return { marked: false, reason: "no-final" }; }
    const exact = String(requested?.provider ?? "").trim().toLowerCase() === current.provider
      && String(requested?.threadId ?? "").trim() === current.threadId
      && String(requested?.turnId ?? "").trim() === current.turnId
      && Number(requested?.revision) === current.revision;
    if (!exact) { recordDecision("stale-final"); return { marked: false, reason: "stale-final", latestFinal: current }; }
    recordDecision("exact");
    const cursor = await this.readStateStore.markRead({
      accountId,
      provider: current.provider,
      threadId: current.threadId,
      answerAt: current.completedAt,
      answerTurnId: current.turnId,
      answerRevision: current.revision,
    }, { commandId, commandTrace: this.commandTrace });
    this.commandTrace?.recordBestEffort?.({ commandId, stage: "read-cursor-confirmed", transport: "server",
      outcome: "succeeded", metadata: { provider: current.provider, threadId: current.threadId,
        turnId: current.turnId, terminalRevision: current.revision, streamId: task?.streamId ?? null } });
    const projected = this.projectTask(task, accountId);
    this.commandTrace?.recordBestEffort?.({ commandId, stage: "read-cursor-projected", transport: "server",
      outcome: "succeeded", metadata: { provider: projected.latestFinal?.provider,
        threadId: projected.latestFinal?.threadId, turnId: projected.latestFinal?.turnId,
        terminalRevision: projected.latestFinal?.revision, unread: projected.unread } });
    return { marked: true, final: current, cursor };
  }
}
