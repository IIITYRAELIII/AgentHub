function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && String(item.text ?? "").trim())
    .map((item) => String(item.text).trim())
    .join("\n")
    .trim();
}

export function displayUserPrompt(value) {
  let text = String(value ?? "").trim();
  const telegramReplyMarker = "\nТекст пользователя:\n";
  const telegramReplyAt = text.lastIndexOf(telegramReplyMarker);
  if (telegramReplyAt >= 0) text = text.slice(telegramReplyAt + telegramReplyMarker.length).trim();
  text = text
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
  return text;
}

export function codexThreadHistory(turns) {
  return (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const user = items.find((item) => item?.type === "userMessage");
    const prompt = displayUserPrompt(textContent(user?.content));
    if (!prompt) return [];
    const answer = items
      .filter((item) => item?.type === "agentMessage" && String(item.text ?? "").trim())
      .map((item) => String(item.text).trim())
      .join("\n\n")
      .trim();
    return [{
      id: String(turn?.id ?? ""),
      prompt,
      answer,
      status: String(turn?.status ?? ""),
      active: turn?.status === "inProgress",
      completed: turn?.status === "completed",
    }];
  });
}

function claudeEntries(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function claudeAssistantText(entries) {
  return entries
    .filter((entry) => entry?.type === "assistant" && entry.message?.role === "assistant")
    .flatMap((entry) => Array.isArray(entry.message?.content)
      ? entry.message.content
      : [{ type: "text", text: entry.message?.content }])
    .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
    .map((block) => String(block.text).trim())
    .join("\n\n")
    .trim();
}

function claudeUserPrompt(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return "";
  return displayUserPrompt(textContent(entry.message?.content));
}

export function claudeTranscriptHistory(text) {
  const entries = claudeEntries(text);
  const userIndexes = entries
    .map((entry, index) => (claudeUserPrompt(entry) ? index : -1))
    .filter((index) => index >= 0);
  return userIndexes.map((entryIndex, historyIndex) => {
    const nextUserIndex = userIndexes[historyIndex + 1] ?? entries.length;
    const turnEntries = entries.slice(entryIndex + 1, nextUserIndex);
    const completed = turnEntries.some((entry) => entry?.type === "last-prompt")
      || turnEntries.some((entry) => (
        entry?.type === "assistant" && entry.message?.stop_reason === "end_turn"
      ));
    return {
      id: String(entries[entryIndex]?.uuid ?? entryIndex),
      prompt: claudeUserPrompt(entries[entryIndex]),
      answer: claudeAssistantText(turnEntries),
      status: completed ? "completed" : "inProgress",
      active: !completed,
      completed,
    };
  });
}

export function visibleTaskHistory(history, count = 1, { completedOnly = false } = {}) {
  const values = (Array.isArray(history) ? history : [])
    .filter((item) => !completedOnly || item.completed);
  const safeCount = Math.max(1, Math.min(Number(count) || 1, values.length || 1));
  return {
    items: values.slice(-safeCount),
    shown: Math.min(safeCount, values.length),
    total: values.length,
    hasMore: values.length > safeCount,
    nextCount: Math.min(values.length, Math.max(safeCount + 1, safeCount * 2)),
  };
}
