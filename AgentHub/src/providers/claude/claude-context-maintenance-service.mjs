import { claudeModelContextWindow } from "./claude.mjs";
import {
  CLAUDE_COMPACTION_PROMPT,
  claudeCompactionClientId,
  isClaudeCompactionRun,
} from "../../domain/claude-context-maintenance.mjs";

function normalizedId(value) {
  return String(value ?? "").trim();
}

function contextPercent(usedTokens, contextWindow) {
  const used = Number(usedTokens);
  const window = Math.max(0, Number(contextWindow) || 0);
  if (!window || !Number.isFinite(used) || used < 0) return null;
  return Math.round((used / window) * 100_000_000) / 1_000_000;
}

/* Обслуживание контекста Claude. Codex сворачивает контекст через RPC своего
   App Server и потом отдельно замеряет результат скрытым ходом; Claude Code
   принимает `/compact` обычным ходом CLI и сам сообщает точные счётчики до и
   после в событии границы, поэтому замерочный ход здесь не нужен. */
export class ClaudeContextMaintenanceService {
  constructor({
    compactions,
    beginRun,
    launchTurn,
    activeRun = () => null,
    completeRun = async () => {},
    saveState = async () => {},
    logger = console,
  } = {}) {
    if (!compactions?.begin || !compactions?.complete) {
      throw new TypeError("compaction tracker is required");
    }
    for (const [name, value] of Object.entries({ beginRun, launchTurn })) {
      if (typeof value !== "function") throw new TypeError(`${name} is required`);
    }
    Object.assign(this, {
      compactions,
      beginRun,
      launchTurn,
      activeRun,
      completeRun,
      saveState,
      logger,
    });
  }

  // Провайдер сам сообщает точный контекст после свёртки, скрытый замер не нужен.
  get measuresContextItself() {
    return true;
  }

  async start(target, { origin = "manual", beforePercent = null } = {}) {
    if (normalizedId(target?.provider).toLowerCase() !== "claude") {
      throw new Error("Эта свёртка контекста доступна только для Claude");
    }
    const threadId = normalizedId(target?.threadId);
    if (!threadId) throw new Error("Укажите корректный поток Claude");
    if (this.activeRun(target)) {
      return { accepted: false, message: "Поток занят: дождитесь завершения текущего хода" };
    }
    const record = this.compactions.begin(threadId, {
      origin: origin === "manual" ? "manual" : "automatic",
      streamId: normalizedId(target?.streamId) || null,
      beforePercent,
    });
    if (!record) throw new Error("Не удалось зарегистрировать свёртку контекста Claude");
    let run = null;
    try {
      run = await this.beginRun(CLAUDE_COMPACTION_PROMPT, {
        ...target,
        clientUserMessageId: claudeCompactionClientId(),
        telegramDeliveryRequested: false,
      });
      run.claudeCompaction = true;
      run.displayRequested = false;
      await this.launchTurn(run, CLAUDE_COMPACTION_PROMPT, []);
      // turnId появляется только при запуске хода, поэтому он дописывается
      // в уже открытую запись, а не создаёт новую.
      this.compactions.begin(threadId, { turnId: normalizedId(run.turnId) || null });
      await this.saveState();
      return { accepted: true, compactionId: record.id, runId: run.id };
    } catch (error) {
      this.compactions.fail(threadId, record.id);
      if (run) await this.completeRun(run).catch(() => {});
      throw error;
    }
  }

  startManual(target, options = {}) {
    return this.start(target, { ...options, origin: "manual" });
  }

  /* Наблюдение за свёрткой в потоке событий CLI. Сюда попадает и свёртка,
     запущенная Hub, и автоматическая свёртка самого Claude Code. */
  observe(run, event) {
    const threadId = normalizedId(run?.threadId);
    if (!threadId || !event) return null;
    if (event.stage === "started") return this.#begin(run, "automatic");
    if (event.stage === "settled") {
      if (event.succeeded) return null;
      const record = this.compactions.get(threadId);
      if (record?.status !== "running") return null;
      this.compactions.fail(threadId, record.id);
      return this.compactions.get(threadId);
    }
    const record = this.compactions.get(threadId)?.status === "running"
      ? this.compactions.get(threadId)
      : this.#begin(run, event.origin);
    if (!record) return null;
    const window = claudeModelContextWindow(run?.claudeObservedModel || run?.modelId);
    const beforePercent = contextPercent(event.preTokens, window);
    const afterPercent = contextPercent(event.postTokens, window);
    this.compactions.annotate(threadId, record.id, {
      ...(beforePercent === null ? {} : { beforePercent }),
      ...(afterPercent === null ? {} : { afterPercent }),
      measurementStatus: afterPercent === null ? "failed" : "completed",
    });
    return this.compactions.complete(threadId, {
      operationId: record.operationId,
      turnId: normalizedId(run?.turnId) || null,
    });
  }

  /* Ход свёртки завершился, а границы так и не было: считать её выполненной
     нельзя, иначе UI покажет успех несостоявшегося обслуживания. */
  settleRun(run) {
    if (!isClaudeCompactionRun(run)) return null;
    const threadId = normalizedId(run?.threadId);
    const record = this.compactions.get(threadId);
    if (record?.status !== "running") return null;
    this.compactions.fail(threadId, record.id);
    return this.compactions.get(threadId);
  }

  discardCompactionTransfer() {
    return false;
  }

  probeContext() {
    throw new Error("Claude сообщает контекст после свёртки сам, скрытый замер не выполняется");
  }

  rotate() {
    throw new Error("Перерождение потока доступно только для Codex");
  }

  rotateCompacted() {
    throw new Error("Перерождение потока доступно только для Codex");
  }

  #begin(run, origin) {
    return this.compactions.begin(normalizedId(run?.threadId), {
      origin: isClaudeCompactionRun(run) ? "manual" : origin,
      streamId: normalizedId(run?.streamId) || null,
      turnId: normalizedId(run?.turnId) || null,
    });
  }
}
