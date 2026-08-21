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

  function modelResponseMeasurement(providerStart, now = Date.now()) {
    const state = String(providerStart?.state ?? "");
    const startedAtMs = Date.parse(String(providerStart?.requestedAt ?? providerStart?.acceptedAt ?? ""));
    if (!Number.isFinite(startedAtMs)) return null;
    if (["requesting", "accepted-awaiting-first-event"].includes(state)) {
      return {
        waiting: true,
        latencyMs: Math.max(0, Math.round(Number(now) - startedAtMs)),
      };
    }
    const failedAtMs = Date.parse(String(providerStart?.failedAt ?? ""));
    if (state === "unconfirmed" && Number.isFinite(failedAtMs)) {
      return {
        failed: true,
        waiting: false,
        latencyMs: Math.max(0, Math.round(failedAtMs - startedAtMs)),
      };
    }
    const firstEventAtMs = Date.parse(String(providerStart?.firstEventAt ?? ""));
    if (state !== "observed" || !Number.isFinite(firstEventAtMs)) return null;
    return {
      waiting: false,
      latencyMs: Math.max(0, Math.round(firstEventAtMs - startedAtMs)),
    };
  }

  function modelResponseQuality({ latencyMs = null, waiting = false, failed = false } = {}) {
    const latency = normalizedLatency(latencyMs);
    if (latency == null) return { quality: "unknown", bars: 0, label: "Нет замера", latencyMs: null, waiting, failed };
    if (failed) return { quality: "poor", bars: 1, label: "Ошибка", latencyMs: latency, waiting, failed };
    if (latency <= 3_000) return { quality: "excellent", bars: 4, label: "Отличная", latencyMs: latency, waiting, failed };
    if (latency <= 8_000) return { quality: "good", bars: 3, label: "Хорошая", latencyMs: latency, waiting, failed };
    if (latency <= 20_000) return { quality: "weak", bars: 2, label: "Слабая", latencyMs: latency, waiting, failed };
    return { quality: "poor", bars: 1, label: "Плохая", latencyMs: latency, waiting, failed };
  }

  window.AgentHubConnectionQuality = Object.freeze({
    connectionQuality,
    connectionQualityPresentation,
    modelResponseMeasurement,
    modelResponseQuality,
    smoothLatency,
  });
})();
