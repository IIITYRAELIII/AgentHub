const COMPLETE_MARKER = /^([ \t]*):codex-annotation\{index="([1-9]\d*)"\}(?:[ \t]+(.*)|[ \t]*$)/u;
const MARKER_PREFIX = ':codex-annotation{index="';
const PARTIAL_MARKER = /^:codex-annotation\{index="\d*"?\}?$/u;
const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/u;

export function codexAssistantResponseProjection(value) {
  const text = String(value ?? "");
  if (!text.includes(":codex")) return { text, responseAnnotationReferences: [] };
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let fence = "";
  const responseAnnotationReferences = [];
  const visible = text.split(/\r?\n/u).map((line) => {
    const fenceMatch = FENCE_START.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence[0] && fenceMatch[1].length >= fence.length) fence = "";
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    const complete = COMPLETE_MARKER.exec(line);
    if (complete) {
      const index = Number(complete[2]);
      responseAnnotationReferences.push({ index });
      const label = `${complete[1]}Цитата ${index}`;
      return complete[3] ? `${label}${newline}${complete[1]}${complete[3]}` : label;
    }
    const candidate = line.trimStart();
    if (candidate && (MARKER_PREFIX.startsWith(candidate) || PARTIAL_MARKER.test(candidate))) {
      return line.slice(0, line.length - candidate.length);
    }
    return line;
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
