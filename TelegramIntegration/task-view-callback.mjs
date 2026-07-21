const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLBACK_PATTERN = /^task-view:(s|ha|hl):(c|l):([0-9a-f-]{36})(?::(\d+))?$/i;

const PROVIDER_CODES = {
  codex: "c",
  claude: "l",
};

const CODE_PROVIDERS = {
  c: "codex",
  l: "claude",
};

export function taskViewCallbackData({
  action = "show",
  provider,
  threadId,
  count = null,
} = {}) {
  const providerCode = PROVIDER_CODES[provider];
  const id = String(threadId ?? "").trim().toLowerCase();
  if (!providerCode || !UUID_PATTERN.test(id)) return null;

  let actionCode;
  if (action === "show") actionCode = "s";
  else if (action === "history-all") actionCode = "ha";
  else if (action === "history-last") actionCode = "hl";
  else return null;

  const suffix = actionCode === "s"
    ? ""
    : `:${Math.max(1, Math.min(Number(count) || 1, 50))}`;
  const value = `task-view:${actionCode}:${providerCode}:${id}${suffix}`;
  return Buffer.byteLength(value, "utf8") <= 64 ? value : null;
}

export function parseTaskViewCallbackData(value) {
  const match = CALLBACK_PATTERN.exec(String(value ?? ""));
  if (!match) return null;
  const [, actionCode, providerCode, threadId, rawCount] = match;
  const provider = CODE_PROVIDERS[providerCode.toLowerCase()];
  if (!provider || !UUID_PATTERN.test(threadId)) return null;
  if (actionCode.toLowerCase() === "s" && rawCount != null) return null;
  if (actionCode.toLowerCase() !== "s" && rawCount == null) return null;
  return {
    action: actionCode.toLowerCase() === "s"
      ? "show"
      : actionCode.toLowerCase() === "ha" ? "history-all" : "history-last",
    provider,
    threadId: threadId.toLowerCase(),
    count: rawCount == null ? null : Math.max(1, Math.min(Number(rawCount) || 1, 50)),
  };
}
