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
  const used = Math.max(0, Number(context?.usedTokens) || 0);
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
    waitForTurnCompletion,
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
    if (!provider?.start || !provider?.probeContext || !provider?.rotate || !provider?.rotateCompacted) {
      throw new TypeError("Codex context maintenance provider is required");
    }
    Object.assign(this, {
      registry,
      provider,
      // Обслуживание контекста устроено по-разному у провайдеров: Codex ходит
      // в App Server и замеряет результат отдельным скрытым ходом, Claude
      // принимает свёртку обычным ходом CLI и сам сообщает точный контекст.
      providers: { codex: provider, ...(providers ?? {}) },
      latestContextUsage,
      waitForContextUpdate,
      waitForTurnCompletion,
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
    if (run?.provider !== "codex" || run?.status !== "finishing") {
      return false;
    }
    const completedTurnCompaction = this.#completedTurnCompaction(run);
    if (this.autoRotateEnabled() && completedTurnCompaction) {
      if (["running", "failed"].includes(
        completedTurnCompaction.measurementStatus,
      )) return false;
      return Boolean(this.registry.begin(run, "automatic-post-turn-rotation"));
    }
    if (!this.autoCompactEnabled()) return false;
    return Boolean(this.registry.begin(run, "automatic-post-turn"));
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
      if (await this.provider.waitForContextProbeIdle?.(run, run.turnId, {
        timeoutMs: 5_000,
      }) === false) {
        return { compacted: false, deferred: true, reason: "turn-still-active" };
      }
      if (reservation.reason === "automatic-post-turn-rotation") {
        const compaction = this.#completedTurnCompaction(run);
        if (!compaction) throw new Error("Завершённая свёртка текущего хода больше недоступна");
        compactionId = compaction.id;
        const measuredAfterPercent = Number(compaction.afterPercent);
        const afterPercent = compaction.measurementStatus === "completed"
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
        this.registry.update?.(reservation, { reason: "automatic-rotation" });
        const rotated = await this.provider.rotateCompacted(run, {
          compactionId: compaction.id,
          settlement: compaction,
          includeTurnId: run.turnId,
        });
        this.provider.compactions.annotate?.(run.threadId, compaction.id, { rotated: true });
        compactionId = null;
        queueTarget = await this.#bindRotation(run, rotated);
        await this.#exactContextAfterRotation(queueTarget);
        return {
          compacted: true,
          rotated: true,
          deferredRotation: true,
          afterPercent,
          ...rotated,
        };
      }
      const before = this.latestContextUsage(run.threadId, run.provider);
      const beforePercent = contextUsagePercent(before);
      if (beforePercent === null || beforePercent <= Number(this.autoCompactThreshold())) {
        return { compacted: false, beforePercent };
      }
      const started = await this.provider.start(run, {
        captureRawItem: true,
        origin: "automatic",
        beforePercent,
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
      const after = await this.#exactContextAfterCompaction(run, before, started.compactionId);
      const afterPercent = contextUsagePercent(after);
      this.provider.compactions.annotate?.(run.threadId, started.compactionId, {
        afterPercent,
        measurementStatus: afterPercent === null ? "failed" : "completed",
      });
      if (!this.autoRotateEnabled() || afterPercent === null
        || afterPercent <= Number(this.autoRotateThreshold())) {
        this.provider.discardCompactionTransfer(run.threadId, started.compactionId);
        compactionId = null;
        return { compacted: true, rotated: false, beforePercent, afterPercent };
      }
      this.registry.update?.(reservation, { reason: "automatic-rotation" });
      const rotated = await this.provider.rotateCompacted(run, {
        compactionId: started.compactionId,
        settlement: settled,
      });
      this.provider.compactions.annotate?.(run.threadId, started.compactionId, { rotated: true });
      compactionId = null;
      queueTarget = await this.#bindRotation(run, rotated);
      await this.#exactContextAfterRotation(queueTarget);
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
          // точный замер: скрытый ход только потратил бы лимит впустую.
          if (provider.measuresContextItself === true) return;
          const after = await this.#exactContextAfterCompaction(
            target,
            before,
            started.compactionId,
            provider,
          );
          const afterPercent = contextUsagePercent(after);
          provider.compactions.annotate?.(target.threadId, started.compactionId, {
            afterPercent,
            measurementStatus: afterPercent === null ? "failed" : "completed",
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
      queueTarget = await this.#bindRotation(target, rotated);
      await this.#exactContextAfterRotation(queueTarget);
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
    const projectRoot = binding.projectRoot || source.projectRoot;
    this.workspaceCatalog.bindThread({
      provider: "codex",
      threadId,
      streamId: stream.id,
      projectRoot,
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

  async #exactContextAfterCompaction(target, before, compactionId, provider = this.provider) {
    provider.compactions.annotate?.(target.threadId, compactionId, {
      measurementStatus: "running",
    });
    const preliminary = await this.waitForContextUpdate(target.threadId, {
      after: before?.updatedAt ?? 0,
      timeoutMs: 5_000,
    });
    if (preliminary && preliminary.provisional !== true) return preliminary;
    const probeStartedAt = Date.now() - 1;
    try {
      const probe = await provider.probeContext(target, { compactionId });
      const [measured, completion] = await Promise.all([
        this.waitForContextUpdate(target.threadId, {
          after: probeStartedAt,
          turnId: probe?.turnId,
          timeoutMs: 60_000,
        }),
        this.waitForTurnCompletion(probe?.turnId, { timeoutMs: 60_000 }),
      ]);
      if (!completion) throw new Error("Скрытый замер контекста не завершился вовремя");
      if (completion.status !== "completed") {
        throw new Error(`Скрытый замер контекста завершился со статусом ${completion.status}`);
      }
      if (await provider.waitForContextProbeIdle?.(target, probe?.turnId) === false) {
        throw new Error("Скрытый замер контекста завершён, но его ход всё ещё активен");
      }
      return measured?.provisional === true || Number(measured?.usedTokens) <= 0
        ? null
        : measured;
    } catch (error) {
      this.logger.warn?.(`Cannot measure compacted context for ${target.threadId}: ${error.message}`);
      return null;
    }
  }

  #completedTurnCompaction(run) {
    const compaction = this.provider.compactions?.get?.(normalized(run?.threadId));
    if (
      compaction?.origin !== "automatic"
      || compaction.status !== "completed"
      || compaction.rotated === true
      || normalized(compaction.turnId) !== normalized(run?.turnId)
    ) return null;
    return compaction;
  }

  async #exactContextAfterRotation(target) {
    const probeStartedAt = Date.now() - 1;
    try {
      const probe = await this.provider.probeContext(target);
      const [measured, completion] = await Promise.all([
        this.waitForContextUpdate(target.threadId, {
          after: probeStartedAt,
          turnId: probe?.turnId,
          timeoutMs: 60_000,
        }),
        this.waitForTurnCompletion(probe?.turnId, { timeoutMs: 60_000 }),
      ]);
      if (!completion) throw new Error("Скрытый замер нового Thread не завершился вовремя");
      if (completion.status !== "completed") {
        throw new Error(`Скрытый замер нового Thread завершился со статусом ${completion.status}`);
      }
      if (await this.provider.waitForContextProbeIdle?.(target, probe?.turnId) === false) {
        throw new Error("Скрытый замер нового Thread завершён, но его ход всё ещё активен");
      }
      return measured?.provisional === true || Number(measured?.usedTokens) <= 0
        ? null
        : measured;
    } catch (error) {
      this.logger.warn?.(`Cannot measure rotated context for ${target.threadId}: ${error.message}`);
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
