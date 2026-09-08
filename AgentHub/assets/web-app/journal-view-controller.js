(() => {
  "use strict";

  const GROUPINGS = Object.freeze(["stream", "workspace", "date", "week", "month"]);
  const GROUPING_SET = new Set(GROUPINGS);
  const LABELS = Object.freeze({
    stream: "Потоки",
    workspace: "Воркспейсы",
    date: "День",
    week: "Неделя",
    month: "Месяц",
  });
  const PRIMARY_COLUMNS = Object.freeze({
    stream: "Поток",
    workspace: "Workspace",
    date: "День",
    week: "Неделя",
    month: "Месяц",
  });

  function normalizeGrouping(value, fallback = "workspace") {
    const candidate = String(value ?? "");
    if (candidate === "task") return "workspace";
    if (GROUPING_SET.has(candidate)) return candidate;
    return GROUPING_SET.has(String(fallback ?? "")) ? String(fallback) : "workspace";
  }

  function parseJournalDate(value) {
    const match = String(value ?? "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/u);
    if (!match) return null;
    const parsed = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatJournalDate(date) {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  function periodIdentity(value, mode) {
    const date = parseJournalDate(value);
    if (!date || !["week", "month"].includes(mode)) return null;
    if (mode === "month") {
      const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      return {
        key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
        sort: start.getTime(),
        label: new Intl.DateTimeFormat("ru-RU", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(start),
      };
    }
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return {
      key: start.toISOString().slice(0, 10),
      sort: start.getTime(),
      label: `${formatJournalDate(start)} — ${formatJournalDate(end)}`,
    };
  }

  function summarizeGroups(groups) {
    const values = Array.isArray(groups) ? groups : [];
    return values.reduce((summary, group) => {
      const credits = group?.credits;
      const durationSeconds = group?.durationSeconds;
      return {
        count: summary.count + 1,
        credits: summary.credits + (Number.isFinite(credits) ? credits : 0),
        knownCredits: summary.knownCredits + (Number.isFinite(credits) ? 1 : 0),
        durationSeconds: summary.durationSeconds
          + (Number.isFinite(durationSeconds) ? durationSeconds : 0),
        knownDurations: summary.knownDurations + (Number.isFinite(durationSeconds) ? 1 : 0),
        gaps: summary.gaps + Math.max(0, Number(group?.unknownCredits) || 0),
        turns: summary.turns + Math.max(0, Number(group?.turnCount) || 0),
      };
    }, {
      count: 0,
      credits: 0,
      knownCredits: 0,
      durationSeconds: 0,
      knownDurations: 0,
      gaps: 0,
      turns: 0,
    });
  }

  function profileCohort(groups, provider) {
    return (Array.isArray(groups) ? groups : []).filter((group) => group?.provider === provider);
  }

  function requiresCompleteHistory(value) {
    normalizeGrouping(value);
    return false;
  }

  function emptyMetrics() {
    return {
      turnCount: 0,
      credits: 0,
      knownCredits: 0,
      unknownCredits: 0,
      durationSeconds: 0,
      knownDurations: 0,
      unknownDurations: 0,
      latestAt: 0,
      fileTouches: 0,
      knownFileTouches: 0,
      changedLines: 0,
      knownChangedLines: 0,
      subagentTurns: 0,
      knownSubagentTurns: 0,
      skillNames: new Set(),
      mcpCallCount: 0,
      mcpTools: new Set(),
      mcpFailures: 0,
      knownToolMetricTurns: 0,
      workspaceUsageHtml: "",
    };
  }

  function addBucketMetrics(target, bucket, includeClaudeUsage) {
    target.turnCount += Math.max(0, Number(bucket?.turnCount) || 0);
    target.durationSeconds += Math.max(0, Number(bucket?.durationSeconds) || 0);
    target.knownDurations += Math.max(0, Number(bucket?.knownDurations) || 0);
    target.unknownDurations += Math.max(0, Number(bucket?.unknownDurations) || 0);
    target.latestAt = Math.max(target.latestAt, Math.max(0, Number(bucket?.latestAt) || 0));
    if (includeClaudeUsage || String(bucket?.provider ?? "").toLowerCase() !== "claude") {
      target.credits += Math.max(0, Number(bucket?.credits) || 0);
      target.knownCredits += Math.max(0, Number(bucket?.knownCredits) || 0);
      target.unknownCredits += Math.max(0, Number(bucket?.unknownCredits) || 0);
    }
    target.fileTouches += Math.max(0, Number(bucket?.fileTouches) || 0);
    target.knownFileTouches += Math.max(0, Number(bucket?.knownFileTouches) || 0);
    target.changedLines += Math.max(0, Number(bucket?.changedLines) || 0);
    target.knownChangedLines += Math.max(0, Number(bucket?.knownChangedLines) || 0);
    target.subagentTurns += Math.max(0, Number(bucket?.subagentTurns) || 0);
    target.knownSubagentTurns += Math.max(0, Number(bucket?.knownSubagentTurns) || 0);
    for (const name of Array.isArray(bucket?.skillNames) ? bucket.skillNames : []) {
      if (String(name).trim()) target.skillNames.add(String(name).trim());
    }
    target.mcpCallCount += Math.max(0, Number(bucket?.mcpCallCount) || 0);
    target.mcpFailures += Math.max(0, Number(bucket?.mcpFailures) || 0);
    target.knownToolMetricTurns += Math.max(0, Number(bucket?.knownToolMetricTurns) || 0);
    for (const tool of Array.isArray(bucket?.mcpTools) ? bucket.mcpTools : []) {
      if (String(tool).trim()) target.mcpTools.add(String(tool).trim());
    }
    if (!target.workspaceUsageHtml && String(bucket?.workspaceUsageHtml ?? "")) {
      target.workspaceUsageHtml = String(bucket.workspaceUsageHtml).slice(0, 12_000);
    }
    return target;
  }

  function finishMetrics(value) {
    return {
      ...value,
      credits: value.knownCredits ? value.credits : null,
      durationSeconds: value.knownDurations ? value.durationSeconds : null,
      fileTouches: value.knownFileTouches ? value.fileTouches : null,
      changedLines: value.knownChangedLines ? value.changedLines : null,
      subagentShare: value.knownSubagentTurns
        ? value.subagentTurns / value.knownSubagentTurns * 100
        : null,
      skillNames: [...value.skillNames].sort((left, right) => left.localeCompare(right)),
      skillCount: value.knownToolMetricTurns ? value.skillNames.size : null,
      mcpCallCount: value.knownToolMetricTurns ? value.mcpCallCount : null,
      mcpTools: [...value.mcpTools].sort((left, right) => left.localeCompare(right)),
    };
  }

  function virtualSummaryBuckets(value) {
    if (!value || Number(value.version) !== 1 || !Array.isArray(value.buckets)) return [];
    return value.buckets.filter((bucket) => (
      bucket && typeof bucket === "object"
      && String(bucket.date ?? "").trim()
      && String(bucket.workspaceId ?? "").trim()
      && String(bucket.streamId ?? "").trim()
    ));
  }

  function periodBounds(date, mode) {
    const match = String(date ?? "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/u);
    if (!match) return { fromMs: 0, toMs: 0, dateKeys: [] };
    let start = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    if (Number.isNaN(start.getTime())) return { fromMs: 0, toMs: 0, dateKeys: [] };
    if (mode === "week") {
      start = new Date(start);
      start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    } else if (mode === "month") {
      start = new Date(start.getFullYear(), start.getMonth(), 1);
    }
    const end = new Date(start);
    if (mode === "week") end.setDate(end.getDate() + 7);
    else if (mode === "month") end.setMonth(end.getMonth() + 1);
    else end.setDate(end.getDate() + 1);
    const dateKeys = [];
    for (const current = new Date(start); current < end; current.setDate(current.getDate() + 1)) {
      dateKeys.push([
        String(current.getDate()).padStart(2, "0"),
        String(current.getMonth() + 1).padStart(2, "0"),
        String(current.getFullYear()),
      ].join("."));
    }
    return { fromMs: start.getTime(), toMs: end.getTime(), dateKeys };
  }

  function virtualJournalScopes(summary, mode, {
    includeClaudeUsage = true,
    groupClaude = false,
  } = {}) {
    const grouping = normalizeGrouping(mode);
    const scopes = new Map();
    for (const bucket of virtualSummaryBuckets(summary)) {
      const date = String(bucket.date);
      const groupedClaude = groupClaude && String(bucket.provider ?? "").toLowerCase() === "claude";
      const workspaceId = groupedClaude ? "claude-work" : String(bucket.workspaceId);
      const streamId = groupedClaude ? "claude-work" : String(bucket.streamId);
      const period = ["week", "month"].includes(grouping) ? periodIdentity(date, grouping) : null;
      const scopeKey = grouping === "stream"
        ? `stream\u001f${workspaceId}\u001f${streamId}`
        : grouping === "workspace"
          ? `workspace\u001f${workspaceId}`
          : grouping === "date"
            ? `date\u001f${date}`
            : `${grouping}\u001f${period?.key ?? date}`;
      const scope = scopes.get(scopeKey) ?? {
        key: scopeKey,
        mode: grouping,
        label: grouping === "stream"
          ? String(bucket.streamDisplayName || "Поток")
          : grouping === "workspace"
            ? groupedClaude ? "Claude - Work" : String(bucket.workspaceName || "Workspace")
            : grouping === "date"
              ? date
              : period?.label || date,
        sort: grouping === "date"
          ? Date.parse(`${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}T00:00:00Z`) || 0
          : period?.sort ?? 0,
        sourceDate: date,
        provider: grouping === "stream" ? "stream" : grouping,
        ...emptyMetrics(),
        workspaces: new Map(),
      };
      addBucketMetrics(scope, bucket, includeClaudeUsage);
      const workspace = scope.workspaces.get(workspaceId) ?? {
        id: workspaceId,
        name: groupedClaude ? "Claude" : String(bucket.workspaceName || "Workspace"),
        kind: String(bucket.workspaceKind || "legacy"),
        queryWorkspaceId: groupedClaude ? "" : workspaceId,
        providers: new Set(),
        ...emptyMetrics(),
        streams: new Map(),
      };
      workspace.providers.add(String(bucket.provider ?? "").trim());
      addBucketMetrics(workspace, bucket, includeClaudeUsage);
      const stream = workspace.streams.get(streamId) ?? {
        id: streamId,
        name: groupedClaude ? "Claude - Work" : String(bucket.streamDisplayName || "Поток"),
        ordinal: Math.max(1, Number(bucket.streamOrdinal) || 1),
        queryWorkspaceId: groupedClaude ? "" : workspaceId,
        queryStreamId: groupedClaude ? "" : streamId,
        providers: new Set(),
        ...emptyMetrics(),
      };
      stream.providers.add(String(bucket.provider ?? "").trim());
      addBucketMetrics(stream, bucket, includeClaudeUsage);
      workspace.streams.set(streamId, stream);
      scope.workspaces.set(workspaceId, workspace);
      scopes.set(scopeKey, scope);
    }
    const compareByCredits = (left, right) => (
      (Number(right.credits) || 0) - (Number(left.credits) || 0)
      || right.latestAt - left.latestAt
      || left.name.localeCompare(right.name, "ru")
      || left.id.localeCompare(right.id)
    );
    const result = [...scopes.values()].map((scope) => {
      const workspaces = [...scope.workspaces.values()].map((workspace) => ({
        ...finishMetrics(workspace),
        providers: [...workspace.providers].filter(Boolean).sort(),
        streams: [...workspace.streams.values()].map((stream) => ({
          ...finishMetrics(stream),
          providers: [...stream.providers].filter(Boolean).sort(),
        })).sort(compareByCredits),
      })).sort(compareByCredits);
      const bounds = grouping === "date"
        ? periodBounds(scope.label, "date")
        : ["week", "month"].includes(grouping)
          ? periodBounds(scope.sourceDate, grouping)
          : { fromMs: 0, toMs: 0, dateKeys: [] };
      return { ...finishMetrics(scope), ...bounds, workspaces };
    });
    return result.sort((left, right) => {
      if (["date", "week", "month"].includes(grouping)) return right.sort - left.sort;
      return (Number(right.credits) || 0) - (Number(left.credits) || 0)
        || right.latestAt - left.latestAt
        || left.label.localeCompare(right.label, "ru");
    });
  }

  function virtualTurnQuery(scope, workspace, stream = null) {
    const providers = Array.isArray(stream?.providers)
      ? stream.providers
      : Array.isArray(workspace?.providers) ? workspace.providers : [];
    const workspaceId = String(stream?.queryWorkspaceId
      ?? workspace?.queryWorkspaceId
      ?? workspace?.id
      ?? "");
    const streamId = String(stream?.queryStreamId ?? stream?.id ?? "");
    return {
      workspaceId,
      streamId,
      provider: !workspaceId && !streamId && providers.length === 1 ? String(providers[0]) : "",
      fromMs: Math.max(0, Number(scope?.fromMs) || 0),
      toMs: Math.max(0, Number(scope?.toMs) || 0),
      dateKeys: Array.isArray(scope?.dateKeys) ? scope.dateKeys.map(String) : [],
    };
  }

  function groupIdentity(value, mode, groupClaude = false) {
    const provider = String(value?.provider ?? "").trim();
    const threadId = String(value?.threadId ?? "").trim();
    const workspaceId = String(value?.workspaceId ?? "").trim();
    const streamId = String(value?.streamId ?? "").trim();
    const grouping = normalizeGrouping(mode);
    if (["stream", "workspace"].includes(grouping) && groupClaude && provider === "claude") {
      return { key: "claude\u001fwork", provider: "claude", threadId: "work" };
    }
    if (grouping === "workspace" && workspaceId) {
      return { key: `workspace\u001f${workspaceId}`, provider: "workspace", threadId: workspaceId };
    }
    if (grouping === "stream" && workspaceId && streamId) {
      return {
        key: `stream\u001f${workspaceId}\u001f${streamId}`,
        provider: "stream",
        threadId: `${workspaceId}:${streamId}`,
      };
    }
    return provider && threadId
      ? { key: `${provider}\u001f${threadId}`, provider, threadId }
      : null;
  }

  function streamCount(workspaces) {
    return Array.isArray(workspaces)
      ? workspaces.reduce((count, workspace) => (
        count + (Array.isArray(workspace?.streams) ? workspace.streams.length : 0)
      ), 0)
      : 0;
  }

  function turnDisplayCredits(dataset) {
    for (const candidate of [
      dataset?.workLogTurnTotalCredits,
      dataset?.workLogTurnCredits,
    ]) {
      if (candidate === undefined || candidate === null || candidate === "") continue;
      const credits = Number(candidate);
      if (Number.isFinite(credits) && credits >= 0) return credits;
    }
    return null;
  }

  function formatDurationHours(value) {
    const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor(totalSeconds % 3_600 / 60);
    const seconds = totalSeconds % 60;
    return [
      hours ? `${hours} ч` : "",
      minutes ? `${minutes} мин` : "",
      seconds || (!hours && !minutes) ? `${seconds} с` : "",
    ].filter(Boolean).join(" ");
  }

  function turnIdentity(dataset, row = {}) {
    const turnId = String(dataset?.workLogTurnId ?? "").trim();
    if (!turnId) return "";
    const provider = String(dataset?.workLogTurnProvider ?? row?.provider ?? "").trim();
    const threadId = String(dataset?.workLogTurnThreadId ?? row?.threadId ?? "").trim();
    return `${provider}\u001f${threadId}\u001f${turnId}`;
  }

  function createQueuedJournalRefresh(request) {
    if (typeof request !== "function") throw new TypeError("request must be a function");

    let inFlight = null;
    let queued = false;
    let queuedAnnouncement = false;

    function refresh({ force = false, announce = false } = {}) {
      if (inFlight) {
        if (force) queued = true;
        if (announce) queuedAnnouncement = true;
        const current = inFlight;
        if (!force) return current;
        return current.then(() => (
          inFlight && inFlight !== current ? inFlight : undefined
        ));
      }

      inFlight = Promise.resolve().then(() => request({ force, announce })).finally(() => {
        inFlight = null;
        if (!queued) return;
        const nextAnnouncement = queuedAnnouncement;
        queued = false;
        queuedAnnouncement = false;
        void refresh({ force: true, announce: nextAnnouncement });
      });
      return inFlight;
    }

    return Object.freeze({ refresh });
  }

  async function hydrateLazyDays(entries, {
    dateFor,
    cachedHtml,
    fetchHtml,
    rememberHtml,
    materialize,
    isCurrent = () => true,
    yieldControl = () => Promise.resolve(),
    batchSize = 2,
  } = {}) {
    const values = Array.isArray(entries) ? entries : [];
    const size = Math.max(1, Math.min(4, Math.floor(Number(batchSize) || 2)));
    for (let offset = 0; offset < values.length; offset += size) {
      if (!isCurrent()) return false;
      const batch = values.slice(offset, offset + size);
      const resolved = await Promise.all(batch.map(async (entry) => {
        const date = String(dateFor(entry) ?? "").trim();
        if (!date) return { entry, html: "" };
        let html = cachedHtml(date);
        if (typeof html !== "string" || !html) {
          html = await fetchHtml(date);
          if (typeof html === "string" && html) rememberHtml(date, html);
        }
        return { entry, html };
      }));
      if (!isCurrent()) return false;
      for (const { entry, html } of resolved) {
        if (typeof html === "string" && html) materialize(entry, html);
      }
      if (offset + size < values.length) await yieldControl();
    }
    return true;
  }

  window.AgentHubJournalView = Object.freeze({
    GROUPINGS,
    formatDurationHours,
    groupIdentity,
    groupingLabel: (value) => LABELS[normalizeGrouping(value)],
    normalizeGrouping,
    periodIdentity,
    primaryColumn: (value) => PRIMARY_COLUMNS[normalizeGrouping(value)],
    profileCohort,
    requiresCompleteHistory,
    summarizeGroups,
    streamCount,
    turnIdentity,
    turnDisplayCredits,
    createQueuedJournalRefresh,
    hydrateLazyDays,
    virtualJournalScopes,
    virtualSummaryBuckets,
    virtualTurnQuery,
  });
})();
