const STATUS_HEADER_FILES = {
  codex: Array.from({ length: 7 }, (_, index) => (
    `codex-header-${String(index + 1).padStart(2, "0")}.png`
  )),
  claude: Array.from({ length: 7 }, (_, index) => (
    `claude-header-${String(index + 1).padStart(2, "0")}.png`
  )),
  both: Array.from({ length: 3 }, (_, index) => (
    `both-header-${String(index + 1).padStart(2, "0")}.png`
  )),
};

function normalizedProvider(provider) {
  return String(provider ?? "").trim().toLowerCase() === "claude" ? "claude" : "codex";
}

export function statusHeaderGroup(provider, activeProviders = []) {
  const running = new Set(activeProviders.map((value) => String(value).trim().toLowerCase()));
  return running.has("codex") && running.has("claude")
    ? "both"
    : normalizedProvider(provider);
}

export function randomStatusHeaderFileName(provider, activeProviders = [], random = Math.random) {
  const files = STATUS_HEADER_FILES[statusHeaderGroup(provider, activeProviders)];
  const value = Number(random());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
  return files[Math.floor(normalized * files.length)];
}
