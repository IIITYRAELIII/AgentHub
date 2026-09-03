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
    return normalizeGrouping(value) !== "date";
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
  });
})();
