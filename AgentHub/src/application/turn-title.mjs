import { TURN_END_TITLE_LIMIT } from "./turn-end-notifications.mjs";

const GENERIC_RESULT = /^(?:да|нет|готово|сделано|исправлено|выполнено|проверено|принято|понял|результат|итог|итоги|обновлено)[.!?:—\s-]*$/iu;
const GENERIC_PREFIX = /^(?:готово|сделано|исправлено|выполнено|проверено|результат|итог|итоги|обновлено)[.!?:—\s-]+/iu;
const STRUCTURED_TITLE_LIMIT = 70;

function plainLine(value) {
  return String(value ?? "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/^\s*\[[ xX]\]\s*/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sentences(value) {
  return String(value ?? "")
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function usefulCandidate(value) {
  const text = plainLine(value).replace(GENERIC_PREFIX, "").trim();
  if (!text || GENERIC_RESULT.test(text)) return "";
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length >= 3 || text.length >= 20 ? text : "";
}

function truncateTitle(value, limit = TURN_END_TITLE_LIMIT) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim().replace(/[.!?;:]+$/u, "");
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.max(1, limit - 1));
  const boundary = head.lastIndexOf(" ");
  const shortened = boundary >= Math.floor(limit * 0.6) ? head.slice(0, boundary) : head;
  return `${shortened.trimEnd()}…`;
}

function structuredTitle(value) {
  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first < 0 || first + 1 >= lines.length || lines[first + 1].trim()) return "";
  const title = plainLine(lines[first]);
  if (!title || GENERIC_RESULT.test(title)) return "";
  return truncateTitle(title, STRUCTURED_TITLE_LIMIT);
}

export function conciseTurnTitle(value, status = "completed") {
  const explicit = structuredTitle(value);
  if (explicit) return explicit;

  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let fenced = false;
  const candidates = [];
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const sentence of sentences(line)) {
      const candidate = usefulCandidate(sentence);
      if (candidate) candidates.push(candidate);
    }
  }
  const fallback = status === "completed" ? "Ход завершён" : "Ход остановлен";
  return truncateTitle(candidates[0] || fallback) || fallback;
}
