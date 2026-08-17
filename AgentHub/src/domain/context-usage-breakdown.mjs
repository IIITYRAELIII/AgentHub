const INSTRUCTION_SECTIONS = [
  ["hub-guide", "Hub Agent Guide", "agent_hub_guide"],
  ["global", "Global pre-turn instructions", "global_pre_turn_instructions"],
  ["workspace", "Правила Workspace", "workspace_instructions"],
  ["stream", "Правила Stream", "stream_instructions"],
  ["hub-context", "Контекст Agent Hub MCP", "agent_hub_context"],
];

function normalizedText(value) {
  return String(value ?? "").trim();
}

function textTokenEstimate(value) {
  const text = normalizedText(value);
  return text ? Math.max(1, Math.ceil([...text].length / 4)) : 0;
}

function taggedSection(source, tag) {
  const match = String(source ?? "").match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "u"));
  return normalizedText(match?.[1]);
}

function textInput(item) {
  if (typeof item === "string") return item;
  if (!["text", "input_text"].includes(String(item?.type ?? ""))) return "";
  return String(item?.text ?? item?.content ?? "");
}

function category({ id, label, text = "", count = 0, tokenEstimateAvailable = true }) {
  const estimatedTokens = tokenEstimateAvailable ? textTokenEstimate(text) : null;
  if (!estimatedTokens && !count) return null;
  return {
    id,
    label,
    estimatedTokens,
    count: Math.max(0, Number(count) || 0),
    tokenEstimateAvailable,
  };
}

export function estimateCodexContextBreakdown({
  developerInstructions = "",
  input = [],
  skills = [],
} = {}) {
  const instructions = String(developerInstructions ?? "");
  const categories = [];
  let instructionShell = instructions;
  for (const [id, label, tag] of INSTRUCTION_SECTIONS) {
    const text = taggedSection(instructions, tag);
    const entry = category({ id, label, text });
    if (entry) categories.push(entry);
    instructionShell = instructionShell.replace(
      new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gu"),
      "",
    );
  }
  const shell = category({
    id: "hub-shell",
    label: "Служебные правила Hub",
    text: instructionShell,
  });
  if (shell) categories.unshift(shell);

  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  const normalizedItems = Array.isArray(items) ? items : [];
  const messageTexts = normalizedItems.map(textInput).filter((text) => normalizedText(text));
  const messages = category({
    id: "messages",
    label: "Сообщения текущего хода",
    text: messageTexts.join("\n"),
    count: messageTexts.length,
  });
  if (messages) categories.push(messages);

  const imageCount = normalizedItems.filter((item) => (
    ["image", "input_image", "localImage"].includes(String(item?.type ?? ""))
  )).length;
  const images = category({
    id: "images",
    label: "Изображения текущего хода",
    count: imageCount,
    tokenEstimateAvailable: false,
  });
  if (images) categories.push(images);

  const fileCount = normalizedItems.filter((item) => item?.type === "localFile").length;
  const files = category({
    id: "files",
    label: "Файлы текущего хода",
    count: fileCount,
    tokenEstimateAvailable: false,
  });
  if (files) categories.push(files);

  const skillCount = Array.isArray(skills) ? skills.filter(Boolean).length : 0;
  const skillEntries = category({
    id: "skills",
    label: "Skills текущего хода",
    count: skillCount,
    tokenEstimateAvailable: false,
  });
  if (skillEntries) categories.push(skillEntries);

  return {
    version: 1,
    scope: "current-turn-known-inputs",
    categories,
  };
}

export function presentContextUsageBreakdown({
  breakdown = null,
  provider = "codex",
  usedTokens = 0,
  modelContextWindow = 0,
} = {}) {
  const used = Math.max(0, Number(usedTokens) || 0);
  const windowTokens = Math.max(0, Number(modelContextWindow) || 0);
  let remainingUsed = used;
  const categories = [];
  for (const raw of Array.isArray(breakdown?.categories) ? breakdown.categories : []) {
    const hasEstimate = raw?.tokenEstimateAvailable !== false
      && Number.isFinite(Number(raw?.estimatedTokens));
    const tokens = hasEstimate
      ? Math.min(remainingUsed, Math.max(0, Number(raw.estimatedTokens) || 0))
      : null;
    if (tokens != null) remainingUsed -= tokens;
    categories.push({
      id: String(raw?.id ?? "category"),
      label: String(raw?.label ?? "Категория"),
      tokens,
      count: Math.max(0, Number(raw?.count) || 0),
      estimated: tokens != null,
    });
  }
  categories.push({
    id: "provider-remainder",
    label: "Системный контекст, инструменты и история",
    tokens: remainingUsed,
    count: 0,
    estimated: true,
  });
  categories.push({
    id: "free",
    label: "Свободно",
    tokens: Math.max(0, windowTokens - used),
    count: 0,
    estimated: false,
  });
  return {
    precision: "mixed",
    categories,
    note: `Общий объём и свободное место сообщает ${provider === "claude" ? "Claude" : "Codex"} точно. Hub оценивает только известные ему инструкции и содержимое текущего хода; системный prompt, определения tools и предыдущая история остаются объединённым остатком.`,
  };
}
