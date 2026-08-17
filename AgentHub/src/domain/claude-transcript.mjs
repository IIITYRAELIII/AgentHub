function contentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

export function claudeTranscriptMessageText(entry) {
  return contentBlocks(entry?.message)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function isClaudeResumePrompt(value) {
  return /^continue from where you left off\.$/iu.test(String(value ?? "").trim());
}

function isClaudeResumeAcknowledgement(entry) {
  return entry?.type === "assistant"
    && entry.message?.role === "assistant"
    && /^no response requested\.$/iu.test(claudeTranscriptMessageText(entry));
}

// Claude Code injects this exchange before the real prompt whenever a headless
// session is resumed. It is transport bookkeeping, not a user-authored turn.
export function withoutClaudeResumePreludes(entries) {
  const values = Array.isArray(entries) ? entries : [];
  const hidden = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    if (entry?.type !== "user" || entry.message?.role !== "user"
      || !isClaudeResumePrompt(claudeTranscriptMessageText(entry))) continue;
    let nextUser = -1;
    for (let candidate = index + 1; candidate < values.length; candidate += 1) {
      if (values[candidate]?.type === "user" && values[candidate]?.message?.role === "user") {
        nextUser = candidate;
        break;
      }
    }
    if (nextUser < 0 || !values.slice(index + 1, nextUser).some(isClaudeResumeAcknowledgement)) {
      continue;
    }
    for (let hiddenIndex = index; hiddenIndex < nextUser; hiddenIndex += 1) {
      hidden.add(hiddenIndex);
    }
  }
  return values.filter((_entry, index) => !hidden.has(index));
}
