export class DesktopReadModelService {
  constructor({
    snapshot,
    readStateStore,
    trustedDeviceUserId,
    hasAllowedUsers = () => false,
    androidEnabled = () => false,
    lastTaskMessage,
  } = {}) {
    if (typeof snapshot !== "function") throw new TypeError("snapshot is required");
    if (!readStateStore || typeof readStateStore.markRead !== "function") {
      throw new TypeError("readStateStore is required");
    }
    if (typeof trustedDeviceUserId !== "function") {
      throw new TypeError("trustedDeviceUserId is required");
    }
    if (typeof lastTaskMessage !== "function") {
      throw new TypeError("lastTaskMessage is required");
    }
    Object.assign(this, {
      snapshotImpl: snapshot,
      readStateStore,
      trustedDeviceUserId,
      hasAllowedUsers,
      androidEnabled,
      lastTaskMessage,
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
    const snapshot = await this.snapshotImpl({
      ...(params ?? {}),
      // Read state belongs to the authenticated/local Hub account. Request
      // parameters cannot switch the account whose unread markers are read.
      accountId,
    });
    if (!Array.isArray(snapshot?.tasks)) return snapshot;
    return {
      ...snapshot,
      tasks: snapshot.tasks.map((task) => this.projectTask(task, accountId)),
    };
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
    const unread = latestFinal ? !(
      cursor
      && cursor.answerTurnId === latestFinal.turnId
      && Number(cursor.answerRevision) === latestFinal.revision
    ) : task?.unread === true;
    return {
      ...task,
      running: userRunning,
      activityUnknown: task?.activityUnknown === true || (task?.running === true && operation.kind === "unknown"),
      lastAnswerRevision: latestFinal?.revision ?? null,
      latestFinal,
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
    if (["user-turn", "probe", "compaction", "measurement", "maintenance"].includes(explicit)) {
      return { kind: explicit };
    }
    if (!run) return { kind: "unknown" };
    const clientId = String(run.clientUserMessageId ?? "").trim();
    if (run.contextProbe === true || clientId.startsWith("agent-hub-context-probe:")) {
      return { kind: "probe", migrationGuard: "legacy-context-probe" };
    }
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
    const snapshot = await this.snapshotImpl({ accountId });
    const task = (Array.isArray(snapshot?.tasks) ? snapshot.tasks : []).find((entry) => (
      String(entry?.provider ?? "").trim().toLowerCase()
        === String(requested?.provider ?? "").trim().toLowerCase()
      && String(entry?.threadId ?? "").trim() === String(requested?.threadId ?? "").trim()
    ));
    const current = this.latestFinal(task);
    if (!current) return { marked: false, reason: "no-final" };
    const exact = String(requested?.provider ?? "").trim().toLowerCase() === current.provider
      && String(requested?.threadId ?? "").trim() === current.threadId
      && String(requested?.turnId ?? "").trim() === current.turnId
      && Number(requested?.revision) === current.revision;
    if (!exact) return { marked: false, reason: "stale-final", latestFinal: current };
    const cursor = this.readStateStore.markRead({
      accountId,
      provider: current.provider,
      threadId: current.threadId,
      answerAt: current.completedAt,
      answerTurnId: current.turnId,
      answerRevision: current.revision,
    });
    return { marked: true, final: current, cursor };
  }
}
