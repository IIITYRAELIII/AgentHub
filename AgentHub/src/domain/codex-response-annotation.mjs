const COMPLETE_MARKER = /^([ \t]*):codex-annotation\{index="([^"\r\n]*)"\}(?:[ \t]+(.*)|[ \t]*$)/u;
const MARKER_PREFIX = ':codex-annotation{index="';
const PARTIAL_MARKER = /^:codex-annotation\{index="[^"\r\n]*(?:"\}?)?$/u;
const DECIMAL_INDEX = /^\d+$/u;
const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/u;

export const MAX_CODEX_RESPONSE_ANNOTATION_INDEX = 20;

export function normalizedCodexResponseAnnotationReferences(references) {
  const normalized = [];
  const seen = new Set();
  for (const reference of Array.isArray(references) ? references : []) {
    const index = Number(reference?.index);
    if (!Number.isSafeInteger(index) || index < 1
      || index > MAX_CODEX_RESPONSE_ANNOTATION_INDEX || seen.has(index)) continue;
    seen.add(index);
    normalized.push({ index });
  }
  return normalized;
}

export function codexAssistantResponseProjection(value) {
  const text = String(value ?? "");
  if (!text.includes(":codex")) return { text, responseAnnotationReferences: [] };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let fence = "";
  let inlineTicks = 0;
  const responseAnnotationReferences = [];
  const referencedIndices = new Set();
  const escapedAt = (value, offset) => {
    let slashes = 0;
    while (offset > 0 && value[--offset] === "\\") slashes++;
    return slashes % 2 === 1;
  };
  const inlinePlain = (segment, segmentOffset) => {
    const tail = segment.lastIndexOf(":codex");
    if (tail >= 0 && !escapedAt(segment, tail)) {
      const candidate = segment.slice(tail);
      if (!COMPLETE_MARKER.test(candidate)
        && (MARKER_PREFIX.startsWith(candidate) || PARTIAL_MARKER.test(candidate))) segment = segment.slice(0, tail);
    }
    return segment.replace(/:codex-annotation\{index="([^"\r\n]*)"\}[ \t]*/gu, (marker, raw, offset) => {
      if (escapedAt(segment, offset)) return marker;
      const index = DECIMAL_INDEX.test(raw) ? Number(raw) : Number.NaN;
      const valid = Number.isSafeInteger(index) && index >= 1 && index <= MAX_CODEX_RESPONSE_ANNOTATION_INDEX;
      if (valid && referencedIndices.has(index)) return "";
      if (valid) { referencedIndices.add(index); responseAnnotationReferences.push({ index }); }
      const before = segmentOffset + offset > 0 ? newline : "";
      const after = offset + marker.length < segment.length ? newline : "";
      return `${before}${valid ? `Цитата ${index}` : "Цитата"}${after}`;
    });
  };
  const ticksByLength = new Map();
  for (const match of text.matchAll(/`+/gu)) {
    const positions = ticksByLength.get(match[0].length) ?? [];
    positions.push(match.index);
    ticksByLength.set(match[0].length, positions);
  }
  const hasClosingTicks = (start, length) => {
    const positions = ticksByLength.get(length) ?? [];
    let low = 0, high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] < start) low = middle + 1;
      else high = middle;
    }
    const end = positions[low];
    return end !== undefined && !/\r?\n[ \t]*\r?\n/u.test(text.slice(start, end));
  };
  const inlineProjection = (line, textOffset) => {
    let result = "", offset = 0;
    for (const match of line.matchAll(/`+/gu)) {
      const segment = line.slice(offset, match.index);
      result += inlineTicks ? segment : inlinePlain(segment, offset);
      result += match[0];
      let slashes = 0;
      for (let index = match.index - 1; index >= 0 && line[index] === "\\"; index--) slashes++;
      const openingLength = match[0].length - slashes % 2;
      if (!inlineTicks && openingLength > 0
        && hasClosingTicks(textOffset + match.index + match[0].length, openingLength)) inlineTicks = openingLength;
      else if (inlineTicks === match[0].length) inlineTicks = 0;
      offset = match.index + match[0].length;
    }
    return result + (inlineTicks ? line.slice(offset) : inlinePlain(line.slice(offset), offset));
  };
  let nextLineOffset = 0;
  const visible = text.split(/\r?\n/u).map((line) => {
    const textOffset = nextLineOffset;
    nextLineOffset += line.length + (text[textOffset + line.length] === "\r" ? 2 : 1);
    const fenceMatch = inlineTicks ? null : FENCE_START.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence[0] && fenceMatch[1].length >= fence.length) fence = "";
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    const complete = inlineTicks ? null : COMPLETE_MARKER.exec(line);
    if (complete) {
      const index = DECIMAL_INDEX.test(complete[2]) ? Number(complete[2]) : Number.NaN;
      const valid = Number.isSafeInteger(index) && index >= 1
        && index <= MAX_CODEX_RESPONSE_ANNOTATION_INDEX;
      if (valid && referencedIndices.has(index)) {
        return complete[3] ? `${complete[1]}${inlineProjection(complete[3], textOffset + line.length - complete[3].length)}` : complete[1];
      }
      if (valid) referencedIndices.add(index);
      if (valid) responseAnnotationReferences.push({ index });
      const label = valid ? `${complete[1]}Цитата ${index}` : `${complete[1]}Цитата`;
      return complete[3] ? `${label}${newline}${complete[1]}${inlineProjection(complete[3], textOffset + line.length - complete[3].length)}` : label;
    }
    return inlineProjection(line, textOffset);
  }).join(newline);
  return { text: visible, responseAnnotationReferences };
}

/**
 * Converts Codex' reserved response-annotation locator into a readable label
 * only at the trusted provider-assistant boundary. Callers must not apply this
 * to user-authored text. Markdown code fences and inline-code literals remain
 * untouched.
 */
export function visibleCodexAssistantText(value) {
  return codexAssistantResponseProjection(value).text;
}
