function balancedElementEnd(source, tagName, openingStart) {
  const token = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, "giu");
  token.lastIndex = openingStart;
  let depth = 0;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return token.lastIndex;
    } else {
      depth += 1;
    }
  }
  return -1;
}

function hasAttribute(opening, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\s${escaped}(?:\\s|=|>)`, "iu").test(String(opening ?? ""));
}

function attribute(opening, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return String(opening ?? "").match(
    new RegExp(`\\b${escaped}="([^"]*)"`, "iu"),
  )?.[1] ?? "";
}

function nestedElementRanges(source, tagName, requiredAttribute) {
  const text = String(source ?? "");
  const tag = String(tagName).replace(/[^a-z0-9]/giu, "");
  const token = new RegExp(`<\\/?${tag}\\b[^>]*>`, "giu");
  const stack = [];
  const ranges = [];
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (!match[0].startsWith("</")) {
      stack.push({ start: match.index, opening: match[0] });
      continue;
    }
    const started = stack.pop();
    if (!started || !hasAttribute(started.opening, requiredAttribute)) continue;
    ranges.push({
      start: started.start,
      end: token.lastIndex,
      opening: started.opening,
      html: text.slice(started.start, token.lastIndex),
    });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function containingRange(ranges, child) {
  return (Array.isArray(ranges) ? ranges : [])
    .filter((range) => range.start <= child.start && range.end >= child.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0] ?? null;
}

function htmlText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedText(value, limit = 256) {
  return String(value ?? "").trim().slice(0, limit);
}

function finiteMetric(value) {
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function dayMs(value) {
  const [day, month, year] = String(value ?? "").split(".").map(Number);
  const result = Date.UTC(year, month - 1, day);
  return Number.isFinite(result) ? result : 0;
}

function groupBucketKey(value) {
  return [value.date, value.workspaceId, value.streamId, value.provider].join("\u001f");
}

function addMetric(target, value, knownKey, totalKey, unknownKey) {
  if (value === null) {
    target[unknownKey] += 1;
    return;
  }
  target[knownKey] += 1;
  target[totalKey] += value;
}

function decodedAttribute(value) {
  return String(value ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stringListAttribute(value) {
  try {
    const parsed = JSON.parse(decodedAttribute(value));
    return Array.isArray(parsed)
      ? parsed.map((item) => boundedText(item, 256)).filter(Boolean).slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

const RESOURCE_BUCKET_FIELDS = [
  "date",
  "dayMs",
  "workspaceId",
  "workspaceName",
  "workspaceKind",
  "streamId",
  "streamDisplayName",
  "streamOrdinal",
  "provider",
  "turnCount",
  "credits",
  "knownCredits",
  "unknownCredits",
  "durationSeconds",
  "knownDurations",
  "unknownDurations",
  "latestAt",
  "workspaceUsageHtml",
];
const PROFILE_COHORT_LIMIT = 2_048;
const PROFILE_SUM_FIELDS = [
  "turnCount",
  "credits",
  "knownCredits",
  "unknownCredits",
  "durationSeconds",
  "knownDurations",
  "unknownDurations",
  "fileTouches",
  "knownFileTouches",
  "unknownFileTouches",
  "changedLines",
  "knownChangedLines",
  "unknownChangedLines",
  "subagentTurns",
  "knownSubagentTurns",
  "unknownSubagentTurns",
  "mcpCallCount",
  "mcpFailures",
  "knownToolMetricTurns",
  "unknownToolMetricTurns",
];

export function resourceVirtualJournalSummary(value) {
  if (!value || Number(value.version) !== 1 || !Array.isArray(value.buckets)) {
    return { version: 1, buckets: [] };
  }
  return {
    version: 1,
    buckets: value.buckets.map((bucket) => Object.fromEntries(
      RESOURCE_BUCKET_FIELDS.map((field) => [field, bucket?.[field]]),
    )),
  };
}

export function profileCohortVirtualJournalSummary(value, {
  requiredWorkspaceId = "",
  requiredStreamId = "",
} = {}) {
  if (!value || Number(value.version) !== 1 || !Array.isArray(value.buckets)) {
    return { version: 1, buckets: [] };
  }
  const streams = new Map();
  for (const bucket of value.buckets) {
    const workspaceId = boundedText(bucket?.workspaceId, 256);
    const streamId = boundedText(bucket?.streamId, 256);
    if (!workspaceId || !streamId) continue;
    const provider = boundedText(bucket?.provider, 32);
    const key = `${workspaceId}\u001f${streamId}\u001f${provider}`;
    const aggregate = streams.get(key) ?? {
      date: boundedText(bucket?.date, 32),
      dayMs: Math.max(0, Number(bucket?.dayMs) || 0),
      workspaceId,
      workspaceName: boundedText(bucket?.workspaceName, 256),
      workspaceKind: boundedText(bucket?.workspaceKind, 32),
      streamId,
      streamDisplayName: boundedText(bucket?.streamDisplayName, 256),
      streamOrdinal: Math.max(1, Number(bucket?.streamOrdinal) || 1),
      provider,
      latestAt: 0,
      skillNames: new Set(),
      mcpTools: new Set(),
    };
    for (const field of PROFILE_SUM_FIELDS) {
      aggregate[field] = Math.max(0, Number(aggregate[field]) || 0)
        + Math.max(0, Number(bucket?.[field]) || 0);
    }
    for (const name of Array.isArray(bucket?.skillNames) ? bucket.skillNames : []) {
      const normalized = boundedText(name, 256);
      if (normalized && aggregate.skillNames.size < 100) aggregate.skillNames.add(normalized);
    }
    for (const name of Array.isArray(bucket?.mcpTools) ? bucket.mcpTools : []) {
      const normalized = boundedText(name, 256);
      if (normalized && aggregate.mcpTools.size < 100) aggregate.mcpTools.add(normalized);
    }
    const latestAt = Math.max(0, Number(bucket?.latestAt) || 0);
    if (latestAt >= aggregate.latestAt) {
      aggregate.latestAt = latestAt;
      aggregate.date = boundedText(bucket?.date, 32) || aggregate.date;
      aggregate.dayMs = Math.max(0, Number(bucket?.dayMs) || aggregate.dayMs);
    }
    streams.set(key, aggregate);
  }
  const requiredWorkspace = boundedText(requiredWorkspaceId, 256);
  const requiredStream = boundedText(requiredStreamId, 256);
  const requiredKeyPrefix = requiredWorkspace
    ? `${requiredWorkspace}\u001f${requiredStream ? `${requiredStream}\u001f` : ""}`
    : "";
  const ordered = [...streams.entries()].sort(([, left], [, right]) => (
    right.latestAt - left.latestAt
    || right.credits - left.credits
    || left.workspaceId.localeCompare(right.workspaceId)
    || left.streamId.localeCompare(right.streamId)
  ));
  const selected = ordered.slice(0, PROFILE_COHORT_LIMIT);
  const required = requiredKeyPrefix
    ? ordered.filter(([key]) => key.startsWith(requiredKeyPrefix))
    : [];
  const requiredByKey = new Map(required);
  const included = new Set();
  const merged = selected.map(([key, bucket]) => {
    const exact = requiredByKey.get(key);
    if (exact) included.add(key);
    return [key, exact ?? bucket];
  });
  for (const entry of required) {
    if (!included.has(entry[0])) merged.push(entry);
  }
  return {
    version: 1,
    buckets: merged.map(([, bucket]) => ({
      ...bucket,
      skillNames: [...bucket.skillNames].sort((left, right) => left.localeCompare(right)),
      mcpTools: [...bucket.mcpTools].sort((left, right) => left.localeCompare(right)),
    })),
    truncated: streams.size > PROFILE_COHORT_LIMIT,
  };
}

export function virtualJournalDaySections(html) {
  const source = String(html ?? "");
  const opening = /<details\b[^>]*data-work-log-day-section[^>]*>/giu;
  const sections = [];
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const end = balancedElementEnd(source, "details", match.index);
    if (end < 0) continue;
    const section = source.slice(match.index, end);
    const summary = section.match(
      /<summary\b[^>]*data-work-log-day\b[^>]*>[\s\S]*?<\/summary>/iu,
    )?.[0] ?? "";
    const date = summary.match(/<strong>(\d{2}\.\d{2}\.\d{4})<\/strong>/iu)?.[1] ?? "";
    if (date) sections.push({ date, html: section, summary });
    opening.lastIndex = end;
  }
  return sections;
}

export function compactVirtualJournalHtml(html) {
  const source = String(html ?? "");
  const rateLimits = source.match(
    /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
  )?.[0] ?? "";
  const accountPanel = source.match(
    /<!-- work-log-account-panel:start -->[\s\S]*?<!-- work-log-account-panel:end -->/iu,
  )?.[0] ?? "";
  const days = virtualJournalDaySections(source).map((section) => (
    `<details data-work-log-day-section data-lazy-day="${section.date}">`
      + section.summary
      + '<div data-lazy-day-content></div></details>'
  ));
  return [rateLimits, accountPanel, ...days].filter(Boolean).join("\n");
}

export function buildVirtualJournalProjection(sections) {
  const buckets = new Map();
  const entries = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const shallow = String(section?.html ?? "");
    const workspaces = nestedElementRanges(shallow, "details", "data-work-log-workspace");
    const streams = nestedElementRanges(shallow, "details", "data-work-log-stream");
    const rows = nestedElementRanges(shallow, "div", "data-work-log-row");
    const turnEntries = nestedElementRanges(shallow, "div", "data-work-log-turn-entry");
    const assignedWorkspaceUsage = new Set();
    for (const row of rows) {
      const workspace = containingRange(workspaces, row);
      const stream = containingRange(streams, row);
      const provider = boundedText(attribute(row.opening, "data-work-log-provider"), 32);
      const threadId = boundedText(attribute(row.opening, "data-work-log-thread-id"), 256);
      const workspaceId = boundedText(
        attribute(row.opening, "data-work-log-workspace-id")
          || attribute(workspace?.opening, "data-work-log-workspace-id")
          || `legacy:${provider}:${threadId}`,
        256,
      );
      const streamId = boundedText(
        attribute(row.opening, "data-work-log-stream-id")
          || attribute(stream?.opening, "data-work-log-stream-id")
          || `legacy:${provider}:${threadId}`,
        256,
      );
      const workspaceName = boundedText(htmlText(workspace?.html.match(
        /^<details\b[^>]*>\s*<summary\b[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/iu,
      )?.[1]) || "Other", 160);
      const streamDisplayName = boundedText(htmlText(stream?.html.match(
        /<span\b[^>]*data-work-log-stream-title[^>]*>([\s\S]*?)<\/span>/iu,
      )?.[1]) || htmlText(row.html.match(
        /<div\b[^>]*data-work-log-task-content[^>]*>([\s\S]*?)<\/div>/iu,
      )?.[1]) || "Поток", 160);
      const workspaceKind = boundedText(
        attribute(workspace?.opening, "data-work-log-workspace-kind") || "legacy",
        32,
      );
      const streamOrdinal = Math.max(
        1,
        Number(attribute(stream?.opening, "data-work-log-stream-ordinal")) || 1,
      );
      const rowTurns = turnEntries.filter((entry) => (
        entry.start >= row.start && entry.end <= row.end
      ));
      for (const entry of rowTurns) {
        const entryProvider = boundedText(
          attribute(entry.opening, "data-work-log-turn-provider") || provider,
          32,
        );
        const key = groupBucketKey({
          date: section.date,
          workspaceId,
          streamId,
          provider: entryProvider,
        });
        const bucket = buckets.get(key) ?? {
          date: section.date,
          dayMs: dayMs(section.date),
          workspaceId,
          workspaceName,
          workspaceKind,
          streamId,
          streamDisplayName,
          streamOrdinal,
          provider: entryProvider,
          turnCount: 0,
          credits: 0,
          knownCredits: 0,
          unknownCredits: 0,
          durationSeconds: 0,
          knownDurations: 0,
          unknownDurations: 0,
          latestAt: 0,
          workspaceUsageHtml: "",
          fileTouches: 0,
          knownFileTouches: 0,
          unknownFileTouches: 0,
          changedLines: 0,
          knownChangedLines: 0,
          unknownChangedLines: 0,
          subagentTurns: 0,
          knownSubagentTurns: 0,
          unknownSubagentTurns: 0,
          skillNames: new Set(),
          mcpCallCount: 0,
          mcpTools: new Set(),
          mcpFailures: 0,
          knownToolMetricTurns: 0,
          unknownToolMetricTurns: 0,
        };
        const workspaceUsageKey = `${section.date}\u001f${workspaceId}`;
        if (!assignedWorkspaceUsage.has(workspaceUsageKey)) {
          const usageHtml = nestedElementRanges(
            workspace?.html,
            "details",
            "data-work-log-workspace-usage-details",
          )[0]?.html ?? "";
          if (usageHtml) {
            bucket.workspaceUsageHtml = usageHtml.slice(0, 12_000);
            assignedWorkspaceUsage.add(workspaceUsageKey);
          }
        }
        bucket.turnCount += 1;
        addMetric(
          bucket,
          finiteMetric(attribute(entry.opening, "data-work-log-turn-credits")),
          "knownCredits",
          "credits",
          "unknownCredits",
        );
        addMetric(
          bucket,
          finiteMetric(attribute(entry.opening, "data-work-log-turn-duration-seconds")),
          "knownDurations",
          "durationSeconds",
          "unknownDurations",
        );
        bucket.latestAt = Math.max(
          bucket.latestAt,
          Date.parse(attribute(entry.opening, "data-work-log-turn-completed-at")) || 0,
        );
        addMetric(
          bucket,
          finiteMetric(attribute(entry.opening, "data-work-log-turn-file-count")),
          "knownFileTouches",
          "fileTouches",
          "unknownFileTouches",
        );
        addMetric(
          bucket,
          finiteMetric(attribute(entry.opening, "data-work-log-turn-change-lines")),
          "knownChangedLines",
          "changedLines",
          "unknownChangedLines",
        );
        const subagent = attribute(entry.opening, "data-work-log-turn-subagent");
        if (subagent === "0" || subagent === "1") {
          bucket.knownSubagentTurns += 1;
          if (subagent === "1") bucket.subagentTurns += 1;
        } else {
          bucket.unknownSubagentTurns += 1;
        }
        const skills = attribute(entry.opening, "data-work-log-turn-skills");
        const mcpCalls = attribute(entry.opening, "data-work-log-turn-mcp-calls");
        if (skills && mcpCalls !== "") {
          for (const name of stringListAttribute(skills)) bucket.skillNames.add(name);
          for (const tool of stringListAttribute(
            attribute(entry.opening, "data-work-log-turn-mcp-tools"),
          )) bucket.mcpTools.add(tool);
          bucket.mcpCallCount += Math.max(0, Number(mcpCalls) || 0);
          bucket.mcpFailures += Math.max(
            0,
            Number(attribute(entry.opening, "data-work-log-turn-mcp-failures")) || 0,
          );
          bucket.knownToolMetricTurns += 1;
        } else {
          bucket.unknownToolMetricTurns += 1;
        }
        buckets.set(key, bucket);
      }
      for (const entry of rowTurns.filter((candidate) => (
        ["", "0"].includes(attribute(candidate.opening, "data-work-log-turn-depth"))
      ))) {
        const turnId = boundedText(attribute(entry.opening, "data-work-log-turn-id"), 256);
        const entryProvider = boundedText(
          attribute(entry.opening, "data-work-log-turn-provider") || provider,
          32,
        );
        const entryThreadId = boundedText(
          attribute(entry.opening, "data-work-log-turn-thread-id") || threadId,
          256,
        );
        const turnRef = boundedText(entry.html.match(
          /\bdata-lazy-turn-id="([^"]+)"/iu,
        )?.[1], 1024);
        if (!turnRef || !entryProvider || !entryThreadId || !turnId) continue;
        entries.push({
          turnRef,
          date: section.date,
          dayMs: dayMs(section.date),
          workspaceId,
          streamId,
          provider: entryProvider,
          threadId: entryThreadId,
          turnId,
          completedAtMs: Date.parse(attribute(entry.opening, "data-work-log-turn-completed-at"))
            || dayMs(section.date),
          html: entry.html,
        });
      }
    }
  }
  return {
    summary: {
      version: 1,
      buckets: [...buckets.values()].map((bucket) => ({
        ...bucket,
        skillNames: [...bucket.skillNames].sort((left, right) => left.localeCompare(right)),
        mcpTools: [...bucket.mcpTools].sort((left, right) => left.localeCompare(right)),
      })).sort((left, right) => (
        right.dayMs - left.dayMs
        || right.credits - left.credits
        || left.workspaceName.localeCompare(right.workspaceName, "ru")
        || left.streamDisplayName.localeCompare(right.streamDisplayName, "ru")
      )),
    },
    entries,
  };
}
