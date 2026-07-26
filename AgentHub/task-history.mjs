function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && String(item.text ?? "").trim())
    .map((item) => String(item.text).trim())
    .join("\n")
    .trim();
}

function responseAnnotationPrompt(value) {
  const text = String(value ?? "");
  const block = text.match(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/i);
  if (!block) return null;

  let annotations = [];
  try {
    const parsed = JSON.parse(block[1]);
    if (Array.isArray(parsed)) annotations = parsed;
  } catch {
    // A malformed annotation container falls back to the explicit request text.
  }

  const comments = annotations.flatMap((item, index) => {
    const annotation = String(item?.annotation ?? "").trim();
    return annotation ? [{ index: index + 1, annotation }] : [];
  });
  const requestTail = text.slice((block.index ?? 0) + block[0].length);
  const request = requestTail
    .replace(/^\s*##\s*My request for Codex:\s*/i, "")
    .trim();
  const selections = annotations
    .map((item) => String(item?.text ?? "").trim())
    .filter(Boolean);
  const annotationText = comments.length === 1
    ? comments[0].annotation
    : comments
      .map((item) => `Аннотация ${item.index}: ${item.annotation}`)
      .join("\n");
  const selectedText = !annotationText && !request
    ? selections.length === 1
      ? `Выделено: ${selections[0]}`
      : selections.map((selection, index) => `Выделено ${index + 1}: ${selection}`).join("\n")
    : "";
  return [annotationText, selectedText, request]
    .filter(Boolean)
    .join("\n\n")
    .trim() || "Аннотация к предыдущему ответу";
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
  const annotated = responseAnnotationPrompt(text);
  if (annotated !== null) return annotated;
  return text;
}

export function codexFinalTurnAnswer(turn) {
  const messages = (turn?.items ?? [])
    .filter((item) => item?.type === "agentMessage" && String(item.text ?? "").trim());
  const explicitFinal = messages.findLast((item) => (
    ["final", "final_answer", "finalAnswer"].includes(String(item.phase ?? ""))
  ));
  return String(explicitFinal?.text ?? messages.at(-1)?.text ?? "").trim();
}

export function codexTurnHasExplicitFinalAnswer(turn) {
  return (turn?.items ?? []).some((item) => (
    item?.type === "agentMessage"
      && String(item.text ?? "").trim()
      && ["final", "final_answer", "finalAnswer"].includes(String(item.phase ?? ""))
  ));
}

export function codexThreadHistory(turns) {
  return (Array.isArray(turns) ? turns : []).flatMap((turn) => {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const user = items.find((item) => item?.type === "userMessage");
    const prompt = displayUserPrompt(textContent(user?.content));
    if (!prompt) return [];
    const visibleAnswer = items
      .filter((item) => item?.type === "agentMessage" && String(item.text ?? "").trim())
      .map((item) => String(item.text).trim())
      .join("\n\n")
      .trim();
    const answer = turn?.status === "completed"
      ? codexFinalTurnAnswer(turn)
      : visibleAnswer;
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
    nextCount: Math.min(values.length, safeCount + 1),
  };
}

export function mergeActiveTaskHistory(history, activeTurn = {}) {
  const values = Array.isArray(history) ? history : [];
  if (activeTurn?.active !== true) return values;

  const turnId = String(activeTurn.turnId ?? activeTurn.id ?? "").trim();
  let current = turnId
    ? values.findLast((item) => String(item?.id ?? "") === turnId)
    : values.findLast((item) => item?.active === true);

  if (!current) {
    current = {
      id: turnId || "active-turn",
      prompt: String(activeTurn.prompt ?? "").trim() || "Текущее сообщение",
      answer: "",
    };
    values.push(current);
  }

  current.active = true;
  current.completed = false;
  current.status = "inProgress";
  const answer = String(activeTurn.answer ?? "").trim();
  if (answer) current.answer = answer;
  return values;
}
