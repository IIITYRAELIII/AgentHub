// Provider-neutral Stream handoff. A new provider Thread cannot resume another
// provider's native context, so the next agent receives a compressed snapshot
// assembled from Agent Hub journal data instead of the previous agent's memory.

const TURN_LIMIT = 12;
const PROMPT_LIMIT = 600;
const BODY_LIMIT = 1_500;
const CHANGED_FILE_LIMIT = 40;
const PACKAGE_LIMIT = 24 * 1024;

export const STREAM_HANDOFF_REASONS = new Set(["manual", "rate-limit", "deferred-input"]);

export function streamHandoffReason(value) {
  const reason = String(value ?? "manual").trim().toLowerCase();
  return STREAM_HANDOFF_REASONS.has(reason) ? reason : "manual";
}

function compact(value, limit) {
  const text = String(value ?? "").replace(/\r\n/gu, "\n").trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function turnTimestamp(turn) {
  return Date.parse(turn?.completedAt || turn?.startedAt || "") || 0;
}

function chronologicalTurns(turns, limit) {
  return (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn && String(turn.status ?? "").trim() !== "aborted")
    .sort((left, right) => turnTimestamp(left) - turnTimestamp(right))
    .slice(-Math.max(1, limit));
}

function changedFileNames(turns) {
  const names = new Set();
  for (const turn of turns) {
    for (const file of Array.isArray(turn?.changedFiles) ? turn.changedFiles : []) {
      const name = String(file ?? "").trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

function turnSection(turn, index) {
  const when = turn.completedAt || turn.startedAt || "";
  const heading = [`[${index}]`, when, turn.provider, turn.title ? `— ${compact(turn.title, 200)}` : ""]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const prompt = compact(turn.prompt, PROMPT_LIMIT);
  const body = compact(turn.body, BODY_LIMIT);
  const failed = String(turn.status ?? "").trim() === "failed";
  return [
    heading,
    prompt ? `User: ${prompt}` : "",
    body ? `${failed ? "Agent (failed)" : "Agent"}: ${body}` : "",
  ].filter(Boolean).join("\n");
}

// Prepends the package to the first turn of the receiving Thread. Both providers
// accept either a plain string or an array of content items.
export function prependStreamHandoff(input, handoff) {
  const text = String(handoff ?? "").trim();
  if (!text) return input;
  if (typeof input === "string") return `${text}\n\n${input}`;
  if (!Array.isArray(input)) return input;
  return [{ type: "text", text }, ...input];
}

export function buildStreamHandoffPackage({
  workspaceName = "",
  workspaceId = "",
  streamName = "",
  streamId = "",
  sourceProvider = "",
  sourceThreadId = "",
  targetProvider = "",
  reason = "manual",
  requestedAt = "",
  turns = [],
} = {}) {
  const recent = chronologicalTurns(turns, TURN_LIMIT);
  const changedFiles = changedFileNames(recent);
  const source = [sourceProvider, sourceThreadId].filter(Boolean).join("/");
  const lines = [
    "<agent_hub_stream_handoff>",
    "You are continuing an existing Agent Hub Stream that was previously worked on in a",
    "different provider Thread. Agent Hub assembled the summary below from its own journal:",
    "it is a compressed snapshot, not the previous agent's native context. Treat it as a",
    "starting point and verify current state before acting on it.",
    "",
    `Workspace: ${workspaceName || "(unnamed)"}${workspaceId ? ` (${workspaceId})` : ""}`,
    `Stream: ${streamName || "(unnamed)"}${streamId ? ` (${streamId})` : ""}`,
    `Handed over: ${source || "(unknown Thread)"} -> ${targetProvider || "(unknown provider)"}`,
    `Reason: ${streamHandoffReason(reason)}${requestedAt ? `, at ${requestedAt}` : ""}`,
  ];
  if (changedFiles.length) {
    lines.push(
      "",
      "Files this Stream already changed:",
      ...changedFiles.slice(0, CHANGED_FILE_LIMIT).map((file) => `- ${file}`),
    );
    if (changedFiles.length > CHANGED_FILE_LIMIT) {
      lines.push(`- … ${changedFiles.length - CHANGED_FILE_LIMIT} more file(s)`);
    }
  }
  if (recent.length) {
    lines.push("", `Recent turns of this Stream, oldest first (${recent.length}):`, "");
    lines.push(recent.map((turn, index) => turnSection(turn, index + 1)).join("\n\n"));
  } else {
    lines.push("", "Agent Hub has no recorded turns for this Stream yet.");
  }
  lines.push(
    "",
    "Continue this Stream from its current state. The user's own message follows below.",
    "</agent_hub_stream_handoff>",
  );
  return compact(lines.join("\n"), PACKAGE_LIMIT);
}
