function normalized(value) {
  return String(value ?? "").trim();
}

export function contextUsagePercent(context) {
  const used = Math.max(0, Number(context?.usedTokens) || 0);
  const window = Math.max(0, Number(context?.modelContextWindow) || 0);
  return window ? (used / window) * 100 : null;
}

export class StreamContextMaintenanceService {
  constructor({
    registry,
    provider,
    latestContextUsage,
    waitForContextUpdate,
    workspaceCatalog,
    selectionStore,
    deferredInputs,
    invalidateCatalog,
    saveState,
    scheduleDeferred = () => {},
    autoCompactEnabled = () => false,
    autoCompactThreshold = () => 75,
    autoRotateEnabled = () => false,
    autoRotateThreshold = () => 20,
    logger = console,
  }) {
    if (!registry?.begin || !registry?.end) throw new TypeError("stream maintenance registry is required");
    if (!provider?.start || !provider?.probeContext || !provider?.rotate || !provider?.rotateCompacted) {
      throw new TypeError("Codex context maintenance provider is required");
    }
    Object.assign(this, {
      registry,
      provider,
      latestContextUsage,
      waitForContextUpdate,
      workspaceCatalog,
      selectionStore,
      deferredInputs,
      invalidateCatalog,
      saveState,
      scheduleDeferred,
      autoCompactEnabled,
      autoCompactThreshold,
      autoRotateEnabled,
      autoRotateThreshold,
      logger,
    });
  }

  isActive(target) {
    if (this.registry.isActive(target)) return true;
    return normalized(target?.provider).toLowerCase() === "codex"
      && this.provider.compactions?.isRunning?.(normalized(target?.threadId)) === true;
  }

  reserveAfterTurn(run) {
    if (run?.provider !== "codex" || run?.status !== "finishing" || !this.autoCompactEnabled()) {
      return false;
    }
    return Boolean(this.registry.begin(run, "automatic-post-turn"));
  }

  async maintainAfterTurn(run) {
    const reservation = this.registry.entry(run);
    if (reservation?.reason !== "automatic-post-turn") return null;
    let queueTarget = run;
    let compactionId = null;
    try {
      const before = this.latestContextUsage(run.threadId);
      const beforePercent = contextUsagePercent(before);
      if (beforePercent === null || beforePercent <= Number(this.autoCompactThreshold())) {
        return { compacted: false, beforePercent };
      }
      const started = await this.provider.start(run, {
        captureRawItem: true,
        origin: "automatic",
      });
      if (!started.accepted) return { compacted: false, reason: started.message };
      compactionId = started.compactionId;
      this.provider.compactions.annotate?.(run.threadId, compactionId, { beforePercent });
      const settled = await this.provider.compactions.waitForSettlement(
        run.threadId,
        started.compactionId,
      );
      if (settled?.status !== "completed") {
        throw new Error(settled?.status === "timeout"
          ? "Автосвёртка контекста не завершилась вовремя"
          : "Автосвёртка контекста не завершилась");
      }
      const after = await this.#exactContextAfterCompaction(run, before);
      const afterPercent = contextUsagePercent(after);
      this.provider.compactions.annotate?.(run.threadId, started.compactionId, { afterPercent });
      if (!this.autoRotateEnabled() || afterPercent === null
        || afterPercent <= Number(this.autoRotateThreshold())) {
        this.provider.discardCompactionTransfer(run.threadId, started.compactionId);
        compactionId = null;
        return { compacted: true, rotated: false, beforePercent, afterPercent };
      }
      const rotated = await this.provider.rotateCompacted(run, {
        compactionId: started.compactionId,
        settlement: settled,
      });
      this.provider.compactions.annotate?.(run.threadId, started.compactionId, { rotated: true });
      compactionId = null;
      queueTarget = await this.#bindRotation(run, rotated);
      return { compacted: true, rotated: true, beforePercent, afterPercent, ...rotated };
    } catch (error) {
      this.logger.error(`Automatic context maintenance failed for ${run?.threadId ?? "unknown"}:`, error.message);
      return { compacted: false, error: error.message };
    } finally {
      if (compactionId) this.provider.discardCompactionTransfer(run.threadId, compactionId);
      this.registry.end(reservation);
      this.#wakeQueue(queueTarget);
    }
  }

  async compact(target) {
    const reservation = this.registry.begin(target, "manual-compaction");
    if (!reservation) throw new Error("Для этого Stream уже выполняется обслуживание контекста");
    try {
      const before = this.latestContextUsage(target.threadId);
      const beforePercent = contextUsagePercent(before);
      const started = await this.provider.startManual(target);
      if (!started.accepted) {
        this.registry.end(reservation);
        return started;
      }
      this.provider.compactions.annotate?.(target.threadId, started.compactionId, { beforePercent });
      void this.provider.compactions.waitForSettlement(target.threadId, started.compactionId)
        .then(async (settled) => {
          if (settled?.status !== "completed") return;
          const after = await this.#exactContextAfterCompaction(target, before);
          this.provider.compactions.annotate?.(target.threadId, started.compactionId, {
            afterPercent: contextUsagePercent(after),
          });
        })
        .catch((error) => this.logger.warn?.(
          `Cannot record manual context compaction result for ${target.threadId}: ${error.message}`,
        ))
        .finally(() => {
          this.registry.end(reservation);
          this.#wakeQueue(target);
        });
      return started;
    } catch (error) {
      this.registry.end(reservation);
      throw error;
    }
  }

  async rotate(target) {
    const reservation = this.registry.begin(target, "manual-rotation");
    if (!reservation) throw new Error("Для этого Stream уже выполняется обслуживание контекста");
    let queueTarget = target;
    try {
      const rotated = await this.provider.rotate(target);
      queueTarget = await this.#bindRotation(target, rotated);
      return rotated;
    } finally {
      this.registry.end(reservation);
      this.#wakeQueue(queueTarget);
    }
  }

  async #bindRotation(source, rotated) {
    const binding = this.workspaceCatalog.thread({
      provider: source.provider,
      threadId: source.threadId,
    });
    const streamId = normalized(source.streamId ?? binding?.streamId);
    const stream = streamId ? this.workspaceCatalog.stream(streamId) : null;
    if (!binding || !stream || binding.streamId !== stream.id) throw new Error("Stream не найден");
    const workspace = this.workspaceCatalog.workspace(stream.workspaceId);
    if (!workspace) throw new Error("Workspace не найден");
    const threadId = normalized(rotated?.thread?.id);
    if (!threadId) throw new Error("Codex App Server не создал новый Thread");
    this.workspaceCatalog.bindThread({
      provider: "codex",
      threadId,
      streamId: stream.id,
      projectRoot: binding.projectRoot || source.projectRoot,
      source: "rebirth",
    });
    if (this.selectionStore.threadId === source.threadId) {
      this.selectionStore.setThread(threadId, {
        provider: "codex",
        streamId: stream.id,
        title: workspace.name,
      });
    }
    for (const item of this.deferredInputs.values()) {
      if (normalized(item.streamId) !== stream.id) continue;
      item.provider = "codex";
      item.threadId = threadId;
      item.projectRoot = binding.projectRoot || source.projectRoot;
      item.taskTitle = workspace.name;
    }
    this.invalidateCatalog();
    await this.saveState();
    return { ...source, streamId: stream.id, threadId, taskTitle: workspace.name };
  }

  async #exactContextAfterCompaction(target, before) {
    const preliminary = await this.waitForContextUpdate(target.threadId, {
      after: before?.updatedAt ?? 0,
      timeoutMs: 5_000,
    });
    if (preliminary && preliminary.provisional !== true) return preliminary;
    const probeStartedAt = Date.now() - 1;
    try {
      await this.provider.probeContext(target);
      const measured = await this.waitForContextUpdate(target.threadId, {
        after: probeStartedAt,
        timeoutMs: 5_000,
      });
      return measured?.provisional === true ? null : measured;
    } catch (error) {
      this.logger.warn?.(`Cannot measure compacted context for ${target.threadId}: ${error.message}`);
      return null;
    }
  }

  #wakeQueue(target) {
    const queued = this.deferredInputs.values().find((item) => (
      normalized(item.streamId) === normalized(target?.streamId)
      && this.deferredInputs.queued.has(item.id)
    ));
    if (queued) this.scheduleDeferred(queued, 0);
  }
}
