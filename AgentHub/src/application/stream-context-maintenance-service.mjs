function normalized(value) {
  return String(value ?? "").trim();
}

function automaticReservationOwnsRun(reservation, run) {
  const ownerRunId = normalized(reservation?.ownerRunId);
  const ownerTurnId = normalized(reservation?.ownerTurnId);
  if (!ownerRunId && !ownerTurnId) return false;
  if (ownerRunId && ownerRunId !== normalized(run?.id ?? run?.runId)) return false;
  if (ownerTurnId && ownerTurnId !== normalized(run?.turnId)) return false;
  return true;
}

export function contextUsagePercent(context) {
  if (context?.usedTokens === null || context?.usedTokens === undefined
    || !Number.isFinite(Number(context.usedTokens)) || Number(context.usedTokens) < 0) return null;
  const used = Number(context.usedTokens);
  const window = Math.max(0, Number(context?.modelContextWindow) || 0);
  return window ? Math.round((used / window) * 100_000_000) / 1_000_000 : null;
}

export class StreamContextMaintenanceService {
  constructor({
    registry,
    provider,
    providers = null,
    latestContextUsage,
    waitForContextUpdate,
    workspaceCatalog,
    selectionStore,
    deferredInputs,
    invalidateCatalog,
    retargetClientSelections = () => 0,
    saveState,
    scheduleDeferred = () => {},
    autoCompactEnabled = () => false,
    autoCompactThreshold = () => 75,
    autoRotateEnabled = () => false,
    autoRotateThreshold = () => 20,
    logger = console,
  }) {
    if (!registry?.begin || !registry?.end) throw new TypeError("stream maintenance registry is required");
    if (!provider?.start || !provider?.rotate || !provider?.rotateCompacted) {
      throw new TypeError("Codex context maintenance provider is required");
    }
    Object.assign(this, {
      registry,
      provider,
      // Обслуживание контекста устроено по-разному у провайдеров: Codex ходит
      // в App Server и использует оценку после свёртки, Claude
      // принимает свёртку обычным ходом CLI и сам сообщает точный контекст.
      providers: { codex: provider, ...(providers ?? {}) },
      latestContextUsage,
      waitForContextUpdate,
      workspaceCatalog,
      selectionStore,
      deferredInputs,
      invalidateCatalog,
      retargetClientSelections,
      saveState,
      scheduleDeferred,
      autoCompactEnabled,
      autoCompactThreshold,
      autoRotateEnabled,
      autoRotateThreshold,
      logger,
    });
  }

  maintenanceProvider(target) {
    return this.providers[normalized(target?.provider).toLowerCase()] ?? null;
  }

  isActive(target) {
    if (this.registry.isActive(target)) return true;
    const provider = this.maintenanceProvider(target);
    return provider?.compactions?.isRunning?.(normalized(target?.threadId)) === true;
  }

  reserveAfterTurn(run) {
    if (
      run?.provider !== "codex"
      || !["finishing", "completed"].includes(run?.status)
      || run?.completionPrepared === true
    ) {
      return false;
    }
    const completedTurnCompaction = this.#completedTurnCompaction(run);
    if (this.autoRotateEnabled() && completedTurnCompaction) {
      return Boolean(this.registry.begin(run, "automatic-post-turn-rotation"));
    }
    if (!this.autoCompactEnabled()) return false;
    const beforePercent = contextUsagePercent(
      this.latestContextUsage(run.threadId, run.provider),
    );
    if (beforePercent === null || beforePercent <= Number(this.autoCompactThreshold())) {
      return false;
    }
    return Boolean(this.registry.begin(run, "automatic-post-turn"));
  }

  cancelAfterTurn(run) {
    const reservation = this.registry.entry(run);
    if (
      !["automatic-post-turn", "automatic-post-turn-rotation"].includes(reservation?.reason)
      || !automaticReservationOwnsRun(reservation, run)
    ) {
      return false;
    }
    const released = this.registry.end(reservation);
    if (released) this.#wakeQueue(run);
    return released;
  }

  cancelPreparing(target) {
    const reservation = this.registry.entry(target);
    if (!reservation) return null;
    if (!["automatic-post-turn", "automatic-post-turn-rotation"].includes(reservation.reason)
      || reservation.phase !== "preparing"
      || this.maintenanceProvider(target)?.compactions?.isRunning?.(normalized(target.threadId))) {
      return { accepted: false, message: "Обслуживание контекста уже запущено; его остановка не подтверждена" };
    }
    const released = this.registry.end(reservation);
    if (released) this.#wakeQueue(target);
    return { accepted: released, message: released
      ? "Подготовка обслуживания контекста отменена. Очередь продолжит работу."
      : "Подготовка обслуживания контекста уже завершилась" };
  }

  async maintainAfterTurn(run) {
    const reservation = this.registry.entry(run);
    if (
      !["automatic-post-turn", "automatic-post-turn-rotation"].includes(reservation?.reason)
      || !automaticReservationOwnsRun(reservation, run)
    ) {
      return null;
    }
    let queueTarget = run;
    let compactionId = null;
    try {
      if (await this.provider.waitForTurnIdle?.(run, run.turnId, {
        timeoutMs: 5_000,
      }) === false) {
        return { compacted: false, deferred: true, reason: "turn-still-active" };
      }
      // Cancellation can release preparation while the bounded idle read is
      // pending. Only the same reservation may cross the provider boundary.
      if (!this.registry.entry(reservation)) return { compacted: false, cancelled: true };
      if (reservation.reason === "automatic-post-turn-rotation") {
        const compaction = this.#completedTurnCompaction(run);
        if (!compaction) throw new Error("Завершённая свёртка текущего хода больше недоступна");
        compactionId = compaction.id;
        const measuredAfterPercent = Number(compaction.afterPercent);
        const afterPercent = compaction.measurementStatus === "completed"
          && compaction.measurementKind === "estimated"
          && compaction.afterPercent !== null && compaction.afterPercent !== undefined
          && Number.isFinite(measuredAfterPercent)
          ? Math.max(0, Math.min(100, measuredAfterPercent))
          : null;
        if (afterPercent === null) {
          this.provider.compactions.annotate?.(run.threadId, compaction.id, {
            measurementStatus: "failed",
          });
        }
        if (afterPercent === null || afterPercent <= Number(this.autoRotateThreshold())) {
          this.provider.discardCompactionTransfer(run.threadId, compaction.id);
          compactionId = null;
          return {
            compacted: true,
            rotated: false,
            deferredRotation: true,
            afterPercent,
          };
        }
        this.registry.update?.(reservation, { reason: "automatic-rotation", phase: "starting" });
        const rotated = await this.provider.rotateCompacted(run, {
          compactionId: compaction.id,
          settlement: compaction,
          includeTurnId: run.turnId,
        });
        queueTarget = await this.#bindRotation(run, rotated, compaction.id);
        compactionId = null;
        return { compacted: true, rotated: true, deferredRotation: true, afterPercent, ...rotated };
      }
      const before = this.latestContextUsage(run.threadId, run.provider);
      const beforePercent = contextUsagePercent(before);
      if (beforePercent === null || beforePercent <= Number(this.autoCompactThreshold())) {
        return { compacted: false, beforePercent };
      }
      this.registry.update?.(reservation, { phase: "starting" });
      const started = await this.provider.start(run, {
        captureRawItem: true,
        origin: "automatic",
        beforePercent,
      });
      if (!started.accepted) return { compacted: false, reason: started.message };
      compactionId = started.compactionId;
      this.registry.update?.(reservation, { phase: "running" });
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
      this.registry.update?.(reservation, { phase: "measuring" });
      const after = await this.#estimatedContextAfterCompaction(run, started.compactionId);
      const afterPercent = contextUsagePercent(after);
      this.provider.compactions.annotate?.(run.threadId, started.compactionId, {
        afterPercent,
        measurementStatus: afterPercent === null ? "failed" : "completed",
        ...(afterPercent !== null ? { measurementKind: "estimated" } : {}),
      });
      if (!this.autoRotateEnabled() || afterPercent === null
        || afterPercent <= Number(this.autoRotateThreshold())) {
        this.provider.discardCompactionTransfer(run.threadId, started.compactionId);
        compactionId = null;
        return { compacted: true, rotated: false, beforePercent, afterPercent };
      }
      this.registry.update?.(reservation, { reason: "automatic-rotation", phase: "starting" });
      const rotated = await this.provider.rotateCompacted(run, {
        compactionId: started.compactionId,
        settlement: settled,
      });
      queueTarget = await this.#bindRotation(run, rotated, started.compactionId);
      compactionId = null;
      return { compacted: true, rotated: true, beforePercent, afterPercent, ...rotated };
    } catch (error) {
      this.logger.error(`Automatic context maintenance failed for ${run?.threadId ?? "unknown"}:`, error.message);
      const compacted = this.provider.compactions.get(run.threadId)?.status === "completed";
      if (compactionId && this.registry.entry(reservation)?.reason === "automatic-rotation") {
        this.provider.compactions.annotate?.(run.threadId, compactionId, {
          rotationStatus: "failed", rotationMessage: error.message,
        });
      }
      return { compacted, rotated: false, error: error.message };
    } finally {
      if (compactionId) this.provider.discardCompactionTransfer(run.threadId, compactionId);
      if (this.registry.end(reservation)) this.#wakeQueue(queueTarget);
    }
  }

  async compact(target) {
    const provider = this.maintenanceProvider(target);
    if (!provider) throw new Error("Свёртка контекста недоступна для этого провайдера");
    const reservation = this.registry.begin(target, "manual-compaction");
    if (!reservation) throw new Error("Для этого Stream уже выполняется обслуживание контекста");
    try {
      const before = this.latestContextUsage(target.threadId, target.provider);
      const beforePercent = contextUsagePercent(before);
      const started = await provider.startManual(target, { beforePercent });
      if (!started.accepted) {
        this.registry.end(reservation);
        return started;
      }
      provider.compactions.annotate?.(target.threadId, started.compactionId, { beforePercent });
      void provider.compactions.waitForSettlement(target.threadId, started.compactionId)
        .then(async (settled) => {
          if (settled?.status !== "completed") return;
          // Провайдер, который сам сообщает контекст после свёртки, уже записал
          // результат напрямую; дополнительное ожидание не требуется.
          if (provider.measuresContextItself === true) return;
          const after = await this.#estimatedContextAfterCompaction(
            target,
            started.compactionId,
            provider,
          );
          const afterPercent = contextUsagePercent(after);
          provider.compactions.annotate?.(target.threadId, started.compactionId, {
            afterPercent,
            measurementStatus: afterPercent === null ? "failed" : "completed",
            ...(afterPercent !== null ? { measurementKind: "estimated" } : {}),
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
    const provider = this.maintenanceProvider(target);
    if (typeof provider?.rotate !== "function") {
      throw new Error("Перерождение потока недоступно для этого провайдера");
    }
    const reservation = this.registry.begin(target, "manual-rotation");
    if (!reservation) throw new Error("Для этого Stream уже выполняется обслуживание контекста");
    let queueTarget = target;
    try {
      const rotated = await provider.rotate(target);
      queueTarget = await this.#bindRotation(target, rotated, rotated?.compactionId);
      return rotated;
    } finally {
      this.registry.end(reservation);
      this.#wakeQueue(queueTarget);
    }
  }

  async #bindRotation(source, rotated, compactionId = rotated?.compactionId) {
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
    const projectRoot = binding.projectRoot || source.projectRoot;
    await this.workspaceCatalog.bindThread({
      provider: "codex",
      threadId,
      streamId: stream.id,
      projectRoot,
      source: "rebirth",
    });
    if (normalized(compactionId)) {
      this.maintenanceProvider(source)?.compactions.annotate?.(source.threadId, compactionId, {
        rotated: true,
        rotationThreadId: threadId,
        rotationCompletedAt: new Date().toISOString(),
      });
    }
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
      item.projectRoot = projectRoot;
      item.taskTitle = workspace.name;
    }
    this.retargetClientSelections({
      provider: "codex",
      sourceThreadId: source.threadId,
      threadId,
      streamId: stream.id,
      projectRoot,
      taskTitle: workspace.name,
    });
    this.invalidateCatalog();
    await this.saveState();
    return { ...source, streamId: stream.id, threadId, taskTitle: workspace.name };
  }

  async #estimatedContextAfterCompaction(target, compactionId, provider = this.provider) {
    const current = () => provider.compactions.get(target.threadId);
    let record = current();
    if (record?.id !== compactionId || record.status !== "completed") return null;
    if (record.measurementKind !== "estimated") {
      const after = record.compactedAt ?? record.completedAt;
      const boundary = Date.parse(String(after ?? ""));
      if (!Number.isFinite(boundary)) return null;
      const context = await this.waitForContextUpdate(target.threadId, {
        after: boundary - 1,
        turnId: record.turnId,
        timeoutMs: 5_000,
      });
      provider.compactions.observeContext?.(context);
      record = current();
    }
    if (record?.id !== compactionId || record.measurementKind !== "estimated"
      || record.measurementStatus !== "completed") return null;
    if (record.afterPercent === null || record.afterPercent === undefined
      || !Number.isFinite(Number(record.afterPercent))) return null;
    return { usedTokens: record.afterPercent, modelContextWindow: 100, provisional: true };
  }

  #completedTurnCompaction(run) {
    const compaction = this.provider.compactions?.get?.(normalized(run?.threadId));
    if (
      compaction?.origin !== "automatic"
      || compaction.status !== "completed"
      || compaction.rotated === true
      // Ротация этой свёртки уже закончилась неудачей: повтор снова создал бы
      // новый Thread на тот же перенос. Следующая свёртка — новая попытка.
      || ["failed", "unknown"].includes(String(compaction.rotationStatus ?? ""))
      || normalized(compaction.turnId) !== normalized(run?.turnId)
    ) return null;
    return compaction;
  }

  #wakeQueue(target) {
    const queued = this.deferredInputs.values().find((item) => (
      normalized(item.streamId) === normalized(target?.streamId)
      && this.deferredInputs.queued.has(item.id)
    ));
    if (queued) this.scheduleDeferred(queued, 0);
  }
}
