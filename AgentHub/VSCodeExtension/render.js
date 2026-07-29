"use strict";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sanitizeWorkLogHtml(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/\s(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/giu, "");
}

function renderWorkLog(source) {
  const normalized = String(source ?? "").replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/u);
  const headingMatch = lines[0]?.match(/^#\s+(.+?)\s*$/u);
  const heading = headingMatch?.[1] ?? "Глобальный журнал работ";
  const body = headingMatch ? lines.slice(1).join("\n") : normalized;
  return `<h1>${escapeHtml(heading)}</h1>${sanitizeWorkLogHtml(body)}`;
}

module.exports = {
  escapeHtml,
  renderWorkLog,
  sanitizeWorkLogHtml,
};
