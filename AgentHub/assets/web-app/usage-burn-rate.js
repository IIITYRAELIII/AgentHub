(() => {
  "use strict";

  const DEFAULT_EMA_HALF_LIFE_MINUTES = 60;
  const MINUTE_MS = 60_000;
  const DAY_MINUTES = 24 * 60;

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function timeOf(value) {
    const time = Date.parse(value ?? "");
    return Number.isFinite(time) ? time : Number.NaN;
  }

  function bucketMinutes(payload, points, index) {
    const configured = finiteNumber(payload?.bucketMs, 0) / MINUTE_MS;
    if (configured > 0) return configured;
    const next = points[index + 1]?.time;
    const current = points[index]?.time;
    if (Number.isFinite(next) && Number.isFinite(current) && next > current) {
      return (next - current) / MINUTE_MS;
    }
    const previous = points[index - 1]?.time;
    if (Number.isFinite(previous) && Number.isFinite(current) && current > previous) {
      return (current - previous) / MINUTE_MS;
    }
    return 1;
  }

  function localDayBounds(time) {
    const start = new Date(time);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }

  function isWholeCurrentDayPayload(payload) {
    const from = timeOf(payload?.from);
    const to = timeOf(payload?.to);
    const axisTo = timeOf(payload?.axisTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(axisTo)) return false;
    const { startMs, endMs } = localDayBounds(to);
    return Math.abs(from - startMs) < 1_000 && Math.abs(axisTo - endMs) < 1_000;
  }

  function alphaFor(spanMinutes, halfLifeMinutes) {
    const span = Math.max(0, finiteNumber(spanMinutes, 0));
    const halfLife = Math.max(0.0001, finiteNumber(halfLifeMinutes, DEFAULT_EMA_HALF_LIFE_MINUTES));
    return 1 - Math.pow(0.5, span / halfLife);
  }

  function normalizePoints(payload) {
    return (Array.isArray(payload?.points) ? payload.points : [])
      .map((point, index) => ({
        source: point,
        index,
        time: timeOf(point?.at),
      }))
      .filter((point) => Number.isFinite(point.time))
      .sort((left, right) => left.time - right.time || left.index - right.index);
  }

  function buildUsageBurnRate(payload, {
    halfLifeMinutes = DEFAULT_EMA_HALF_LIFE_MINUTES,
  } = {}) {
    const normalized = normalizePoints(payload);
    let previousTime = null;
    let emaRate = null;
    const points = normalized.map((point, index) => {
      const minutes = bucketMinutes(payload, normalized, index);
      const credits = Math.max(0, finiteNumber(point.source?.credits, 0));
      const rawRate = minutes > 0 ? credits / minutes : 0;
      const spanMinutes = previousTime == null
        ? minutes
        : Math.max(minutes, (point.time - previousTime) / MINUTE_MS);
      const alpha = alphaFor(spanMinutes, halfLifeMinutes);
      emaRate = emaRate == null ? rawRate : (alpha * rawRate) + ((1 - alpha) * emaRate);
      previousTime = point.time;
      return {
        at: new Date(point.time).toISOString(),
        time: point.time,
        credits,
        bucketMinutes: minutes,
        rawRate,
        emaRate,
        timedCredits: Math.max(0, finiteNumber(point.source?.timedCredits, 0)),
        durationSeconds: Math.max(0, finiteNumber(
          point.source?.taskDurationSeconds ?? point.source?.durationSeconds,
          0,
        )),
      };
    });

    const totalCredits = Math.max(0, finiteNumber(payload?.totalCredits, 0));
    const totalTimedCredits = Math.max(0, finiteNumber(
      payload?.totalTimedCredits ?? payload?.timedCredits,
      0,
    ));
    const totalDurationSeconds = Math.max(0, finiteNumber(
      payload?.totalDurationSeconds ?? payload?.taskDurationSeconds,
      0,
    ));
    const to = timeOf(payload?.to);
    const forecastAvailable = isWholeCurrentDayPayload(payload);
    const latestEmaRate = Math.max(0, finiteNumber(points.at(-1)?.emaRate, 0));
    let elapsedDayMinutes = null;
    let remainingDayMinutes = null;
    let calendarDayRate = null;
    let forecastDay = null;
    let forecastDayAverage = null;

    if (forecastAvailable) {
      const { startMs, endMs } = localDayBounds(to);
      elapsedDayMinutes = Math.max(1 / 60, (to - startMs) / MINUTE_MS);
      remainingDayMinutes = Math.max(0, (endMs - to) / MINUTE_MS);
      calendarDayRate = totalCredits / elapsedDayMinutes;
      forecastDay = totalCredits + latestEmaRate * remainingDayMinutes;
      forecastDayAverage = calendarDayRate * DAY_MINUTES;
    }

    return {
      halfLifeMinutes,
      forecastAvailable,
      points,
      totalCredits,
      totalTimedCredits,
      totalDurationSeconds,
      emaRate: latestEmaRate,
      calendarDayRate,
      workRate: totalDurationSeconds > 0 ? totalTimedCredits / totalDurationSeconds * 60 : null,
      elapsedDayMinutes,
      remainingDayMinutes,
      forecastDay,
      forecastDayAverage,
    };
  }

  globalThis.AgentHubUsageBurnRate = Object.freeze({
    DEFAULT_EMA_HALF_LIFE_MINUTES,
    buildUsageBurnRate,
  });
})();
