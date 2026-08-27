(() => {
  "use strict";

  function normalizedLatency(value) {
    if (value == null || value === "") return null;
    const latency = Number(value);
    return Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null;
  }

  function smoothLatency(previous, sample, weight = 0.35) {
    const next = normalizedLatency(sample);
    if (next == null) return normalizedLatency(previous);
    const current = normalizedLatency(previous);
    if (current == null) return next;
    const ratio = Math.min(1, Math.max(0, Number(weight) || 0));
    return Math.round(current * (1 - ratio) + next * ratio);
  }

  async function measureLatency(probe, now = () => performance.now()) {
    const startedAt = now();
    await probe();
    return normalizedLatency(now() - startedAt);
  }

  function connectionQuality({ status = "connecting", latencyMs = null } = {}) {
    const connection = String(status ?? "connecting");
    const latency = normalizedLatency(latencyMs);
    if (connection === "offline") return { quality: "offline", bars: 0, label: "Нет связи", latencyMs: null };
    if (["connecting", "restarting"].includes(connection)) {
      return { quality: "connecting", bars: 0, label: "Подключение", latencyMs: null };
    }
    if (latency == null) return { quality: "unknown", bars: 0, label: "Ожидание замера", latencyMs: null };
    if (latency <= 120) return { quality: "excellent", bars: 4, label: "Отличная", latencyMs: latency };
    if (latency <= 300) return { quality: "good", bars: 3, label: "Хорошая", latencyMs: latency };
    if (latency <= 800) return { quality: "weak", bars: 2, label: "Слабая", latencyMs: latency };
    return { quality: "poor", bars: 1, label: "Плохая", latencyMs: latency };
  }

  function connectionQualityPresentation(details = {}) {
    const result = connectionQuality(details);
    const suffix = result.latencyMs == null ? "" : ` · ${result.latencyMs} мс`;
    return { ...result, title: `Связь: ${result.label.toLowerCase()}${suffix}` };
  }

  function timestampMs(value) {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function elapsedMs(start, end) {
    return start == null || end == null ? null : Math.max(0, Math.round(end - start));
  }

  function compactionMeasurement(compaction, now) {
    const status = String(compaction?.status ?? "");
    const measurementStatus = String(compaction?.measurementStatus ?? "");
    const active = status === "running" || measurementStatus === "running";
    const startedAtMs = timestampMs(compaction?.startedAt);
    if (!active || startedAtMs == null) return null;
    return {
      active: true,
      elapsedMs: elapsedMs(startedAtMs, now),
      stage: measurementStatus === "running" ? "measuring-context" : String(compaction?.stage ?? "compacting"),
    };
  }

  function modelResponseMeasurement(providerStart, now = Date.now(), details = {}) {
    const state = String(providerStart?.state ?? "");
    const currentAtMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const compaction = compactionMeasurement(details.compaction, currentAtMs);
    const requestedAtMs = timestampMs(providerStart?.requestedAt);
    const acceptedAtMs = timestampMs(providerStart?.acceptedAt);
    const turnStartedAtMs = timestampMs(providerStart?.turnStartedAtMs) ?? acceptedAtMs;
    const startedAtMs = requestedAtMs ?? acceptedAtMs ?? timestampMs(details.compaction?.startedAt);
    if (startedAtMs == null) return null;
    const failedAtMs = timestampMs(providerStart?.failedAt);
    const completedAtMs = timestampMs(providerStart?.completedAtMs);
    const firstEventAtMs = timestampMs(providerStart?.firstEventAt);
    const firstContentAtMs = timestampMs(providerStart?.firstContentAtMs);
    const firstVisibleAtMs = timestampMs(providerStart?.firstVisibleAtMs);
    const lastEventAtMs = timestampMs(providerStart?.lastEventAtMs) ?? firstEventAtMs ?? turnStartedAtMs ?? startedAtMs;
    const lastContentAtMs = timestampMs(providerStart?.lastContentAtMs) ?? turnStartedAtMs ?? startedAtMs;
    const lastVisibleAtMs = timestampMs(providerStart?.lastVisibleAtMs) ?? turnStartedAtMs ?? startedAtMs;
    const waiting = ["requesting", "accepted-awaiting-first-event"].includes(state) && firstEventAtMs == null;
    const failed = state === "unconfirmed" && failedAtMs != null;
    const active = !failed && completedAtMs == null && (details.running === true || waiting || compaction?.active === true);
    const measurementAtMs = failedAtMs ?? completedAtMs ?? currentAtMs;
    const phase = compaction?.active
      ? "compaction"
      : String(providerStart?.phase ?? (waiting ? "starting" : active ? "working" : "completed"));
    return {
      active,
      failed,
      waiting,
      phase,
      latencyMs: elapsedMs(startedAtMs, firstEventAtMs ?? measurementAtMs),
      requestAcceptedMs: elapsedMs(startedAtMs, acceptedAtMs),
      firstEventMs: elapsedMs(turnStartedAtMs ?? startedAtMs, firstEventAtMs),
      firstContentMs: elapsedMs(turnStartedAtMs ?? startedAtMs, firstContentAtMs),
      firstVisibleMs: elapsedMs(turnStartedAtMs ?? startedAtMs, firstVisibleAtMs),
      eventSilenceMs: elapsedMs(lastEventAtMs, measurementAtMs),
      contentSilenceMs: elapsedMs(lastContentAtMs, measurementAtMs),
      visibleSilenceMs: elapsedMs(lastVisibleAtMs, measurementAtMs),
      maxEventGapMs: normalizedLatency(providerStart?.maxEventGapMs),
      maxContentGapMs: normalizedLatency(providerStart?.maxContentGapMs),
      maxVisibleGapMs: normalizedLatency(providerStart?.maxVisibleGapMs),
      compaction,
    };
  }

  function modelResponseQuality(measurement = {}) {
    const { waiting = false, failed = false } = measurement;
    if (failed) return { quality: "poor", bars: 1, label: "Ошибка", latencyMs: measurement.latencyMs, waiting, failed };
    if (measurement.phase === "waiting-user") {
      return { quality: "good", bars: 3, label: "Ожидает тебя", latencyMs: measurement.eventSilenceMs, waiting, failed };
    }
    const compactionMs = normalizedLatency(measurement.compaction?.elapsedMs);
    const latency = compactionMs ?? normalizedLatency(
      waiting
        ? measurement.latencyMs
        : measurement.active
          ? measurement.eventSilenceMs
          : measurement.maxEventGapMs ?? measurement.firstEventMs ?? measurement.latencyMs,
    );
    if (latency == null) return { quality: "unknown", bars: 0, label: "Нет замера", latencyMs: null, waiting, failed };
    const thresholds = compactionMs != null
      ? [60_000, 120_000, 300_000]
      : waiting
        ? [3_000, 8_000, 20_000]
        : [15_000, 45_000, 120_000];
    if (latency <= thresholds[0]) return { quality: "excellent", bars: 4, label: "Отличная", latencyMs: latency, waiting, failed };
    if (latency <= thresholds[1]) return { quality: "good", bars: 3, label: "Хорошая", latencyMs: latency, waiting, failed };
    if (latency <= thresholds[2]) return { quality: "weak", bars: 2, label: "Задержка", latencyMs: latency, waiting, failed };
    return { quality: "poor", bars: 1, label: "Зависание", latencyMs: latency, waiting, failed };
  }

  function exactCompletedTurnSample(providerStart, measurement) {
    if (!String(providerStart?.turnId ?? "").trim() || !measurement) return false;
    if (measurement.active || measurement.waiting || measurement.failed || measurement.phase !== "completed") return false;
    return [measurement.firstEventMs, measurement.firstContentMs, measurement.firstVisibleMs]
      .some((value) => normalizedLatency(value) != null);
  }

  function selectModelResponseSample({
    providerStart = null,
    previous = null,
    now = Date.now(),
    running = false,
    compaction = null,
  } = {}) {
    const measurement = modelResponseMeasurement(providerStart, now, { running, compaction });
    if (measurement?.active || measurement?.waiting || measurement?.failed || measurement?.compaction?.active) {
      return { measurement, providerStart, remember: false, sampleKind: "current" };
    }
    if (exactCompletedTurnSample(providerStart, measurement)) {
      return { measurement, providerStart, remember: true, sampleKind: "previous" };
    }
    if (!previous?.measurement || !String(previous?.providerStart?.turnId ?? "").trim()) return null;
    return {
      measurement: { ...previous.measurement, active: false, waiting: false, phase: "completed" },
      providerStart: previous.providerStart,
      remember: false,
      sampleKind: "previous",
    };
  }

  function modelLinkState({ measurement = null, status = "online", latencyMs = null } = {}) {
    const connection = String(status ?? "online");
    const measuredLatency = normalizedLatency(measurement?.latencyMs);
    const fallbackLatency = normalizedLatency(latencyMs);
    const latency = measuredLatency ?? fallbackLatency;
    const failed = Boolean(measurement?.failed);
    if (failed || connection === "offline") {
      return {
        bars: 0,
        label: "Нет связи",
        latencyMs: latency,
        quality: "offline",
        retry: true,
        state: "offline",
      };
    }
    if (latency == null) {
      return {
        bars: 0,
        label: "Нет замера",
        latencyMs: null,
        quality: "unknown",
        retry: false,
        state: "unknown",
      };
    }
    if (latency > 1_000) {
      return {
        bars: 2,
        label: "Плохая связь",
        latencyMs: latency,
        quality: "weak",
        retry: false,
        state: "weak",
      };
    }
    return {
      bars: 3,
      label: "Связь нормальная",
      latencyMs: latency,
      quality: "good",
      retry: false,
      state: "normal",
    };
  }

  window.AgentHubConnectionQuality = Object.freeze({
    connectionQuality,
    connectionQualityPresentation,
    modelLinkState,
    modelResponseMeasurement,
    modelResponseQuality,
    measureLatency,
    selectModelResponseSample,
    smoothLatency,
  });
})();
