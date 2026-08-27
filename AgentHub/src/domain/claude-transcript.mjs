import path from "node:path";

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

const CLAUDE_ATTACHMENT_PROMPT_PATTERNS = [
  /^Проанализируй также изображение по абсолютному пути:\s*(.+)$/u,
  /^Приложенный файл доступен по абсолютному пути:\s*(.+)$/u,
];

function absoluteAttachmentPath(value) {
  const text = String(value ?? "").trim();
  for (const pattern of CLAUDE_ATTACHMENT_PROMPT_PATTERNS) {
    const candidate = String(pattern.exec(text)?.[1] ?? "").trim();
    if (candidate && (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate))) return candidate;
  }
  return "";
}

export function claudeTransportPromptDetails(value) {
  const visible = [];
  const attachmentSources = [];
  for (const paragraph of String(value ?? "").trim().split(/\r?\n\s*\r?\n/u)) {
    const attachmentPath = absoluteAttachmentPath(paragraph);
    if (attachmentPath) attachmentSources.push({ type: "path", value: attachmentPath });
    else if (paragraph.trim()) visible.push(paragraph.trim());
  }
  return { text: visible.join("\n\n").trim(), attachmentSources };
}

function normalizedPrompt(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").trim();
}

function rootUserMessage(turn) {
  return (Array.isArray(turn?.messages) ? turn.messages : [])
    .find((message) => message?.role === "user") ?? null;
}

function attachmentIdentity(value) {
  const ids = [
    ...(Array.isArray(value?.attachments) ? value.attachments : [])
      .map((attachment) => String(attachment?.id ?? "").trim()),
    ...(Array.isArray(value?.attachmentSources) ? value.attachmentSources : [])
      .filter((source) => source?.type === "path")
      .map((source) => {
        const sourcePath = String(source?.value ?? "").trim();
        return path.posix.basename(path.win32.basename(sourcePath));
      }),
  ].filter(Boolean).map((id) => id.toLowerCase());
  return [...new Set(ids)].sort();
}

function sameIdentitySet(left, right) {
  return left.length > 0
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function terminalTurn(turn) {
  return turn?.completed === true || [
    "completed", "failed", "stopped", "interrupted", "aborted", "cancelled", "canceled",
  ].includes(String(turn?.status ?? "").trim().toLowerCase());
}

export function withoutClaudeManagedTranscriptDuplicates(history) {
  const values = Array.isArray(history) ? history : [];
  const managed = values.flatMap((turn, index) => {
    const user = rootUserMessage(turn);
    const clientUserMessageId = String(user?.clientUserMessageId ?? "").trim();
    if (!clientUserMessageId || !terminalTurn(turn)) return [];
    return [{
      index,
      text: normalizedPrompt(user?.text ?? turn?.prompt),
      attachments: attachmentIdentity({
        attachments: [
          ...(Array.isArray(turn?.attachments) ? turn.attachments : []),
          ...(Array.isArray(user?.attachments) ? user.attachments : []),
        ],
      }),
    }];
  });
  const removed = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const turn = values[index];
    const user = rootUserMessage(turn);
    if (!user || String(user.clientUserMessageId ?? "").trim()) continue;
    const transport = claudeTransportPromptDetails(user.text ?? turn?.prompt);
    const attachments = attachmentIdentity({
      attachmentSources: [
        ...transport.attachmentSources,
        ...(Array.isArray(user.attachmentSources) ? user.attachmentSources : []),
      ],
      attachments: [
        ...(Array.isArray(turn?.attachments) ? turn.attachments : []),
        ...(Array.isArray(user?.attachments) ? user.attachments : []),
      ],
    });
    if (!attachments.length) continue;
    const text = normalizedPrompt(transport.text || user.text || turn?.prompt);
    const matches = managed.filter((candidate) => (
      candidate.index !== index
      && candidate.text === text
      && sameIdentitySet(candidate.attachments, attachments)
    ));
    if (matches.length === 1) removed.add(index);
  }
  return values.filter((_turn, index) => !removed.has(index));
}

/* Claude Code записывает в транскрипт служебные user-записи: продолжение после
   свёртки контекста, преамбулу локальных команд и сами слэш-команды. Они
   помечены собственными флагами, поэтому распознаются структурно, а не по
   тексту. Для Hub это транспорт, а не сообщение пользователя. */
export function isClaudeSyntheticUserEntry(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return false;
  return entry.isCompactSummary === true
    || entry.isMeta === true
    || entry.isVisibleInTranscriptOnly === true
    || isClaudeInterruptEntry(entry)
    || isClaudeLocalCommandEnvelope(claudeTranscriptMessageText(entry));
}

/* Прерывание хода Claude Code записывает как user-запись с фиксированным
   текстом и без собственного флага. */
export function isClaudeInterruptEntry(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return false;
  return /^\[Request interrupted by user(?: for tool use)?\]$/u
    .test(claudeTranscriptMessageText(entry).trim());
}

/* Слэш-команда приходит как набор XML-конвертов без собственного флага. */
export function isClaudeLocalCommandEnvelope(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("<")) return false;
  return text
    .replace(/<(command-name|command-message|command-args|command-contents)>[\s\S]*?<\/\1>/giu, "")
    .replace(/<local-command-(caveat|stdout|stderr)>[\s\S]*?<\/local-command-\1>/giu, "")
    .trim() === "";
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
