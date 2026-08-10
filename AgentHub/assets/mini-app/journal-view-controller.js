(() => {
  "use strict";

  const GROUPINGS = Object.freeze(["task", "date", "week", "month"]);
  const GROUPING_SET = new Set(GROUPINGS);
  const LABELS = Object.freeze({
    task: "Воркспейсы",
    date: "День",
    week: "Неделя",
    month: "Месяц",
  });
  const PRIMARY_COLUMNS = Object.freeze({
    task: "Workspace",
    date: "День",
    week: "Неделя",
    month: "Месяц",
  });

  function normalizeGrouping(value, fallback = "task") {
    if (GROUPING_SET.has(String(value ?? ""))) return String(value);
    return GROUPING_SET.has(String(fallback ?? "")) ? String(fallback) : "task";
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

  function streamCount(workspaces) {
    return Array.isArray(workspaces)
      ? workspaces.reduce((count, workspace) => (
        count + (Array.isArray(workspace?.streams) ? workspace.streams.length : 0)
      ), 0)
      : 0;
  }

  window.AgentHubJournalView = Object.freeze({
    GROUPINGS,
    groupingLabel: (value) => LABELS[normalizeGrouping(value)],
    normalizeGrouping,
    periodIdentity,
    primaryColumn: (value) => PRIMARY_COLUMNS[normalizeGrouping(value)],
    profileCohort,
    requiresCompleteHistory,
    summarizeGroups,
    streamCount,
  });
})();
