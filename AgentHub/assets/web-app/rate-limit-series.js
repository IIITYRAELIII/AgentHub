(() => {
  "use strict";

  const DEFAULT_SAMPLE_INTERVAL_MS = 5 * 60_000;
  const DEFAULT_MAXIMUM_POINTS = 10_000;
  const RESET_WINDOW_SHIFT_TOLERANCE_MS = 30 * 60_000;
  const RESET_USED_DROP_THRESHOLD = 10;

  function normalizedPoints(points) {
    const sorted = (Array.isArray(points) ? points : [])
      .map((point, index) => ({
        point,
        index,
        time: Date.parse(point?.at ?? ""),
        used: Number(point?.usedPercent),
      }))
      .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.used))
      .sort((left, right) => left.time - right.time || left.index - right.index);
    const unique = [];
    for (const item of sorted) {
      if (unique.at(-1)?.time === item.time) unique[unique.length - 1] = item;
      else unique.push(item);
    }
    return unique;
  }

  function accountKey(point) {
    return String(point?.accountKey ?? "").trim();
  }

  function sameAccount(left, right) {
    const leftAccount = accountKey(left.point);
    const rightAccount = accountKey(right.point);
    return !leftAccount || !rightAccount || leftAccount === rightAccount;
  }

  function crossesReset(left, right) {
    if (!(right.time > left.time) || !sameAccount(left, right)) return false;
    if (left.used - right.used >= RESET_USED_DROP_THRESHOLD) return true;
    const leftReset = Date.parse(left.point?.resetsAt ?? "");
    const rightReset = Date.parse(right.point?.resetsAt ?? "");
    return Number.isFinite(leftReset)
      && Number.isFinite(rightReset)
      && Math.abs(rightReset - leftReset) > RESET_WINDOW_SHIFT_TOLERANCE_MS;
  }

  function canInferInterval(left, right) {
    return right.time > left.time
      && right.used >= left.used
      && sameAccount(left, right)
      && !crossesReset(left, right);
  }

  function interpolatedResetAt(left, right, ratio) {
    const leftReset = Date.parse(left.point?.resetsAt ?? "");
    const rightReset = Date.parse(right.point?.resetsAt ?? "");
    if (!Number.isFinite(leftReset) || !Number.isFinite(rightReset)) {
      return left.point?.resetsAt || right.point?.resetsAt || "";
    }
    return new Date(leftReset + ((rightReset - leftReset) * ratio)).toISOString();
  }

  function interpolatedPoint(left, right, time) {
    const ratio = (time - left.time) / (right.time - left.time);
    const usedPercent = left.used + ((right.used - left.used) * ratio);
    const leftRemaining = left.point?.remainingPercent == null
      ? Number.NaN
      : Number(left.point.remainingPercent);
    const rightRemaining = right.point?.remainingPercent == null
      ? Number.NaN
      : Number(right.point.remainingPercent);
    const remainingPercent = Number.isFinite(leftRemaining) && Number.isFinite(rightRemaining)
      ? leftRemaining + ((rightRemaining - leftRemaining) * ratio)
      : Math.max(0, 100 - usedPercent);
    return {
      ...left.point,
      at: new Date(time).toISOString(),
      usedPercent,
      remainingPercent,
      resetsAt: interpolatedResetAt(left, right, ratio),
      estimated: true,
      estimateKind: right.used === left.used ? "unchanged-gap" : "distributed-gap",
    };
  }

  function interpolationStep(points, sampleIntervalMs, maximumPoints) {
    if (points.length < 2 || points.length >= maximumPoints) return Number.POSITIVE_INFINITY;
    const span = points.at(-1).time - points[0].time;
    const syntheticSlots = Math.max(1, maximumPoints - points.length);
    const boundedStep = Math.ceil(span / syntheticSlots / sampleIntervalMs) * sampleIntervalMs;
    return Math.max(sampleIntervalMs, boundedStep);
  }

  function interpolateRateLimitGaps(points, {
    sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
    maximumPoints = DEFAULT_MAXIMUM_POINTS,
  } = {}) {
    const normalized = normalizedPoints(points);
    if (normalized.length < 2) return normalized.map((item) => item.point);
    const cadence = Math.max(1, Number(sampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS);
    const pointLimit = Math.max(normalized.length, Number(maximumPoints) || DEFAULT_MAXIMUM_POINTS);
    const step = interpolationStep(normalized, cadence, pointLimit);
    let syntheticRemaining = Math.max(0, pointLimit - normalized.length);
    const result = [normalized[0].point];
    for (let index = 1; index < normalized.length; index += 1) {
      const left = normalized[index - 1];
      const right = normalized[index];
      const gap = right.time - left.time;
      if (syntheticRemaining > 0 && gap > cadence * 1.5 && canInferInterval(left, right)) {
        for (let time = left.time + step; time < right.time && syntheticRemaining > 0; time += step) {
          result.push(interpolatedPoint(left, right, time));
          syntheticRemaining -= 1;
        }
      }
      result.push(right.point);
    }
    return result;
  }

  function rateLimitDeltasByBuckets(points, buckets) {
    const normalized = normalizedPoints(points);
    const ranges = (Array.isArray(buckets) ? buckets : []).map((bucket) => ({
      start: Number(bucket?.start),
      end: Number(bucket?.end),
    }));
    const values = ranges.map(() => null);
    if (normalized.length < 2 || !ranges.length) return values;
    let firstCandidate = 0;
    for (let index = 1; index < normalized.length; index += 1) {
      const left = normalized[index - 1];
      const right = normalized[index];
      if (!canInferInterval(left, right)) continue;
      const span = right.time - left.time;
      const delta = right.used - left.used;
      while (firstCandidate < ranges.length && ranges[firstCandidate].end <= left.time) {
        firstCandidate += 1;
      }
      for (let bucketIndex = firstCandidate; bucketIndex < ranges.length; bucketIndex += 1) {
        const bucket = ranges[bucketIndex];
        if (!Number.isFinite(bucket.start) || !Number.isFinite(bucket.end) || bucket.start >= right.time) break;
        const overlap = Math.max(0, Math.min(right.time, bucket.end) - Math.max(left.time, bucket.start));
        if (!(overlap > 0)) continue;
        values[bucketIndex] = (values[bucketIndex] ?? 0) + (delta * overlap / span);
      }
    }
    return values;
  }

  function bucketRanges(buckets) {
    return (Array.isArray(buckets) ? buckets : []).map((bucket) => ({
      start: Number(bucket?.start),
      end: Number(bucket?.end),
    }));
  }

  function intervalOverlap(left, right, range) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return 0;
    return Math.max(0, Math.min(right.time, range.end) - Math.max(left.time, range.start));
  }

  function nearbyObservedPrice(observedValues, accountingValues, ranges, blocked, gap) {
    const usable = ranges.map((range, index) => ({
      index,
      range,
      credits: Math.max(0, Number(accountingValues[index]) || 0),
      limitPoints: observedValues[index] == null ? null : Number(observedValues[index]),
    })).filter((item) => (
      !blocked[item.index]
      && item.credits > 0
      && Number.isFinite(item.limitPoints)
      && item.limitPoints >= 0
    ));
    const before = usable
      .filter((item) => item.range.end <= gap.left.time)
      .sort((left, right) => right.range.end - left.range.end)
      .slice(0, 3);
    const after = usable
      .filter((item) => item.range.start >= gap.right.time)
      .sort((left, right) => left.range.start - right.range.start)
      .slice(0, 3);
    const neighbors = [...before, ...after];
    const sample = neighbors.length ? neighbors : usable;
    const credits = sample.reduce((sum, item) => sum + item.credits, 0);
    const limitPoints = sample.reduce((sum, item) => sum + item.limitPoints, 0);
    return credits > 0 && limitPoints > 0 ? limitPoints / (credits / 1_000) : null;
  }

  function accountingSegments(ranges, accountingValues, reconstructionBuckets) {
    const reconstructed = (Array.isArray(reconstructionBuckets) ? reconstructionBuckets : [])
      .map((bucket) => ({
        start: Number(bucket?.start),
        end: Number(bucket?.end),
        credits: Math.max(0, Number(bucket?.credits) || 0),
      }))
      .filter((bucket) => (
        Number.isFinite(bucket.start)
        && Number.isFinite(bucket.end)
        && bucket.end > bucket.start
        && bucket.credits > 0
      ));
    return reconstructed.length
      ? reconstructed
      : ranges.map((range, index) => ({ ...range, credits: accountingValues[index] }));
  }

  function recoverRateLimitResetGaps(points, buckets, accountingValues, reconstructionBuckets = []) {
    const normalized = normalizedPoints(points);
    const ranges = bucketRanges(buckets);
    const accounting = ranges.map((_, index) => Math.max(0, Number(accountingValues?.[index]) || 0));
    const observedValues = rateLimitDeltasByBuckets(points, buckets);
    const inferredValues = ranges.map(() => 0);
    const values = [...observedValues];
    if (normalized.length < 2 || !ranges.length) {
      return { values, observedValues, inferredValues, recoveredIntervals: 0, estimatedLimitPoints: 0 };
    }
    const gaps = [];
    for (let index = 1; index < normalized.length; index += 1) {
      const left = normalized[index - 1];
      const right = normalized[index];
      if (crossesReset(left, right)) gaps.push({ left, right });
    }
    if (!gaps.length) {
      return { values, observedValues, inferredValues, recoveredIntervals: 0, estimatedLimitPoints: 0 };
    }
    const blocked = ranges.map((range) => gaps.some((gap) => intervalOverlap(gap.left, gap.right, range) > 0));
    const segments = accountingSegments(ranges, accounting, reconstructionBuckets);
    let recoveredIntervals = 0;
    for (const gap of gaps) {
      const limitPrice = nearbyObservedPrice(observedValues, accounting, ranges, blocked, gap);
      if (!(limitPrice > 0)) continue;
      let recovered = false;
      for (const segment of segments) {
        const segmentSpan = segment.end - segment.start;
        const gapStart = Math.max(gap.left.time, segment.start);
        const gapEnd = Math.min(gap.right.time, segment.end);
        if (!(segmentSpan > 0) || !(gapEnd > gapStart)) continue;
        ranges.forEach((range, bucketIndex) => {
          const overlap = Math.max(0, Math.min(gapEnd, range.end) - Math.max(gapStart, range.start));
          if (!(overlap > 0)) return;
          const inferred = segment.credits * Math.min(1, overlap / segmentSpan) / 1_000 * limitPrice;
          if (!(inferred > 0)) return;
          inferredValues[bucketIndex] += inferred;
          recovered = true;
        });
      }
      if (recovered) recoveredIntervals += 1;
    }
    inferredValues.forEach((inferred, index) => {
      if (inferred > 0) values[index] = (values[index] ?? 0) + inferred;
    });
    return {
      values,
      observedValues,
      inferredValues,
      recoveredIntervals,
      estimatedLimitPoints: inferredValues.reduce((sum, value) => sum + value, 0),
    };
  }

  function limitPriceSample(accountingValues, limitValues, from, to) {
    let credits = 0;
    let limitPoints = 0;
    let count = 0;
    for (let index = from; index < to; index += 1) {
      const accounting = Number(accountingValues?.[index]);
      const rawLimit = limitValues?.[index];
      if (!(accounting > 0) || !Number.isFinite(rawLimit)) continue;
      const limit = Number(rawLimit);
      credits += accounting;
      limitPoints += Math.max(0, limit);
      count += 1;
    }
    return credits > 0 && count > 0
      ? { value: limitPoints / (credits / 1_000), credits, limitPoints, count }
      : null;
  }

  function limitPriceStatistics(accountingValues, limitValues, { splitIndex } = {}) {
    const length = Math.max(
      Array.isArray(accountingValues) ? accountingValues.length : 0,
      Array.isArray(limitValues) ? limitValues.length : 0,
    );
    const windowSize = Math.min(5, Math.max(2, Math.round(length / 10)));
    const values = Array.from({ length }, (_, index) => (
      limitPriceSample(accountingValues, limitValues, Math.max(0, index - windowSize + 1), index + 1)?.value
        ?? null
    ));
    const split = Math.min(length, Math.max(
      1,
      Number.isInteger(splitIndex) ? splitIndex : Math.ceil(length / 2),
    ));
    const overall = limitPriceSample(accountingValues, limitValues, 0, length);
    const early = limitPriceSample(accountingValues, limitValues, 0, split);
    const late = limitPriceSample(accountingValues, limitValues, split, length);
    const changePercent = early?.value > 0 && Number.isFinite(late?.value)
      ? (late.value / early.value - 1) * 100
      : null;
    const weeklyCredits = overall?.value > 0 ? 100 / overall.value * 1_000 : null;
    return { values, overall, early, late, changePercent, weeklyCredits, windowSize };
  }

  function signedComparisonDeviations(accountValues, localValues) {
    const account = Array.isArray(accountValues) ? accountValues : [];
    const local = Array.isArray(localValues) ? localValues : [];
    return Array.from({ length: Math.max(account.length, local.length) }, (_, index) => (
      Number.isFinite(account[index]) && Number.isFinite(local[index])
        ? account[index] - local[index]
        : null
    ));
  }

  function meanSignedComparisonDeviation(accountValues, localValues) {
    const values = signedComparisonDeviations(accountValues, localValues).filter(Number.isFinite);
    if (!values.length) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.abs(mean) < 1e-9 ? 0 : mean;
  }

  function smoothedRateLimitConsumption(points, {
    currentHalfLifeMs = 3 * 60 * 60_000,
    averageWindowMs = 24 * 60 * 60_000,
    ratePeriodMs = 7 * 24 * 60 * 60_000,
  } = {}) {
    const halfLife = Math.max(1, Number(currentHalfLifeMs) || 1);
    const averageWindow = Math.max(1, Number(averageWindowMs) || 1);
    const ratePeriod = Math.max(1, Number(ratePeriodMs) || 1);
    const source = (Array.isArray(points) ? points : [])
      .filter((point) => Number.isFinite(point?.atMs) && Number.isFinite(point?.usedPercent))
      .sort((left, right) => left.atMs - right.atMs);
    const timeline = [];
    let cumulativeUsed = 0;
    let continuityIndex = 0;
    let highWaterUsed = null;
    let previous = null;

    const append = (point, overrides = {}) => {
      timeline.push({
        ...point,
        ...overrides,
        cumulativeUsed,
        continuityIndex,
      });
    };

    for (const point of source) {
      const previousAccount = String(previous?.raw?.accountKey ?? "");
      const currentAccount = String(point?.raw?.accountKey ?? "");
      const accountChanged = previous
        && previousAccount
        && currentAccount
        && previousAccount !== currentAccount;
      if (!previous || accountChanged) {
        if (accountChanged) continuityIndex += 1;
        cumulativeUsed = 0;
        highWaterUsed = point.usedPercent;
        append(point);
        previous = point;
        continue;
      }

      if (point.startsAfterReset) {
        if (point.cycleStartMs > previous.atMs && point.cycleStartMs < point.atMs) {
          append(point, {
            raw: {
              ...point.raw,
              at: new Date(point.cycleStartMs).toISOString(),
              usedPercent: 0,
              remainingPercent: 100,
              estimated: true,
              estimateKind: "reset-boundary",
            },
            atMs: point.cycleStartMs,
            usedPercent: 0,
            remainingPercent: 100,
            resetBoundary: true,
          });
        }
        cumulativeUsed += Math.max(0, point.usedPercent);
        highWaterUsed = point.usedPercent;
      } else {
        cumulativeUsed += Math.max(0, point.usedPercent - highWaterUsed);
        highWaterUsed = Math.max(highWaterUsed, point.usedPercent);
      }
      append(point);
      previous = point;
    }

    let currentRate = null;
    let segmentStartIndex = 0;
    return timeline.map((point, index) => {
      const prior = timeline[index - 1];
      if (!prior || prior.continuityIndex !== point.continuityIndex) {
        currentRate = null;
        segmentStartIndex = index;
      } else {
        const spanMs = point.atMs - prior.atMs;
        const usedDelta = point.cumulativeUsed - prior.cumulativeUsed;
        if (spanMs > 0 && usedDelta >= 0) {
          const intervalRate = usedDelta / spanMs * ratePeriod;
          const weight = 1 - Math.exp(-Math.LN2 * spanMs / halfLife);
          currentRate = currentRate == null
            ? intervalRate * weight
            : currentRate + weight * (intervalRate - currentRate);
        }
      }

      const windowStartMs = point.atMs - averageWindow;
      const first = timeline[segmentStartIndex];
      let baselineAtMs = first?.atMs;
      let baselineUsed = first?.cumulativeUsed;
      if (first && windowStartMs > first.atMs) {
        for (let cursor = index; cursor > segmentStartIndex; cursor -= 1) {
          const right = timeline[cursor];
          const left = timeline[cursor - 1];
          if (left.atMs > windowStartMs) continue;
          const spanMs = right.atMs - left.atMs;
          const ratio = spanMs > 0 ? (windowStartMs - left.atMs) / spanMs : 0;
          baselineAtMs = windowStartMs;
          baselineUsed = left.cumulativeUsed
            + ((right.cumulativeUsed - left.cumulativeUsed) * ratio);
          break;
        }
      }
      const averageSpanMs = Number.isFinite(baselineAtMs) ? point.atMs - baselineAtMs : 0;
      const averageDelta = Number.isFinite(baselineUsed) ? point.cumulativeUsed - baselineUsed : 0;
      const averageRate = averageSpanMs > 0 && averageDelta >= 0
        ? averageDelta / averageSpanMs * ratePeriod
        : null;
      const historySpanMs = first ? point.atMs - first.atMs : 0;
      return {
        ...point,
        currentRate,
        currentPreliminary: historySpanMs < halfLife,
        averageRate,
        averageSpanMs,
        averagePreliminary: averageSpanMs < averageWindow,
      };
    });
  }

  function currentLimitWindowLabel(series) {
    const durationMinutes = Number(series?.point?.windowDurationMins);
    if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
      if (durationMinutes % 1440 === 0) return `${durationMinutes / 1440} д.`;
      if (durationMinutes % 60 === 0) return `${durationMinutes / 60} ч.`;
      return `${durationMinutes} мин.`;
    }
    if (series?.window === "primary") return "основное";
    if (series?.window === "secondary") return "дополнительное";
    return "";
  }

  function selectCurrentLimitSeries(payload) {
    const currentAccountKey = String(payload?.currentAccount?.key ?? "");
    const available = (Array.isArray(payload?.series) ? payload.series : [])
      .filter((series) => Array.isArray(series.points) && series.points.length)
      .map((series) => {
        const provider = String(series.name ?? "").toLowerCase();
        const codex = provider === "codex" || provider === "spark";
        if (!codex || !currentAccountKey) return { ...series, point: series.points.at(-1) };
        const point = series.points.findLast((item) => (
          String(item?.accountKey ?? "") === currentAccountKey
        )) ?? (series.accountKey === currentAccountKey ? series.points.at(-1) : null);
        return point ? { ...series, point } : null;
      })
      .filter(Boolean);
    const pickCodex = (name) => available
      .filter((series) => (
        String(series.name).toLowerCase() === name
        && (series.window === "primary" || series.window === "secondary")
      ))
      .sort((left, right) => (
        (left.window === "primary" ? 0 : 1) - (right.window === "primary" ? 0 : 1)
      ));
    const claudeWeek = available.find((series) => series.id === "claude:week");
    return [
      ...pickCodex("codex"),
      ...pickCodex("spark"),
      ...available
        .filter((series) => String(series.name).toLowerCase() === "claude")
        .sort((left, right) => {
          const order = (series) => (
            series.window === "week" ? 0 : series.window === "session" ? 1 : 2
          );
          return order(left) - order(right)
            || String(left.window).localeCompare(String(right.window), "ru");
        }),
    ].map((series) => {
      const id = String(series.id ?? "");
      const provider = String(series.name ?? "").toLowerCase();
      const label = id.startsWith("claude:model:")
        ? String(series.window || "Claude")
        : id === "claude:session"
          ? "Claude session"
          : id === "claude:week"
            ? "Claude"
            : String(series.name || series.id || "");
      const point = id.startsWith("claude:model:") && !series.point?.resetsText
        ? { ...series.point, resetsText: claudeWeek?.point?.resetsText ?? "" }
        : series.point;
      const windowLabel = provider === "codex" || provider === "spark"
        ? currentLimitWindowLabel({ ...series, point })
        : "";
      return { ...series, label, point, windowLabel };
    });
  }

  globalThis.AgentHubRateLimitSeries = Object.freeze({
    DEFAULT_SAMPLE_INTERVAL_MS,
    interpolateRateLimitGaps,
    limitPriceStatistics,
    meanSignedComparisonDeviation,
    rateLimitDeltasByBuckets,
    recoverRateLimitResetGaps,
    selectCurrentLimitSeries,
    signedComparisonDeviations,
    smoothedRateLimitConsumption,
  });
})();
