export const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
]);

export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_COLLABORATION_MODES = ["default", "plan"];
export const CODEX_SANDBOX_MODES = ["workspace-write", "danger-full-access"];

export const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"];

const CLAUDE_ALIAS_LABELS = {
  opus: "Opus (latest)",
  sonnet: "Sonnet (latest)",
  haiku: "Haiku (latest)",
  fable: "Fable (latest)",
};

export const CLAUDE_MODEL_LABELS = Object.freeze(new Proxy(CLAUDE_ALIAS_LABELS, {
  get(target, property, receiver) {
    if (typeof property !== "string" || Reflect.has(target, property)) {
      return Reflect.get(target, property, receiver);
    }
    return claudeModelLabel(property);
  },
}));

export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const CLAUDE_REASONING_LABELS = Object.freeze({
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
});

export function validClaudeModel(value) {
  const model = String(value ?? "").trim();
  return model.length > 0
    && model.length <= 256
    && /^[a-z0-9][a-z0-9._:/@\[\]-]*$/iu.test(model);
}

export function claudeModelLabel(value) {
  const model = String(value ?? "").trim();
  if (!model) return "";
  if (Object.hasOwn(CLAUDE_ALIAS_LABELS, model)) return CLAUDE_ALIAS_LABELS[model];

  const oneMillion = /\[1m\]$/iu.test(model);
  const normalized = model.replace(/\[1m\]$/iu, "");
  const match = /^claude-([a-z][a-z0-9]*?)-(\d+(?:-\d+)*)(?:-(\d{8}))?$/iu.exec(normalized);
  if (!match) return model;
  const family = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
  const version = match[2].replaceAll("-", ".");
  const date = match[3] ? ` · ${match[3]}` : "";
  return `${family} ${version}${date}${oneMillion ? " (1M)" : ""}`;
}

export function claudeModelOptions({ aliases = CLAUDE_MODEL_ALIASES, observed = [], selected = "" } = {}) {
  const aliasSet = new Set(aliases);
  const exact = [...new Set([...observed, selected]
    .map((value) => String(value ?? "").trim())
    .filter((value) => validClaudeModel(value) && !aliasSet.has(value)))]
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return [...exact, ...aliases]
    .filter((value, index, values) => validClaudeModel(value) && values.indexOf(value) === index)
    .map((value) => ({ value, label: claudeModelLabel(value) }));
}

export function normalizeCodexSandboxMode(value, { fallback = "workspace-write" } = {}) {
  const mode = String(value ?? fallback).trim().toLowerCase();
  if (!CODEX_SANDBOX_MODES.includes(mode)) {
    throw new Error(`codexSandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`);
  }
  return mode;
}
