const COMPLETE_MARKER = /^([ \t]*):codex-annotation\{index="[1-9]\d*"\}(?:[ \t]+|$)/u;
const MARKER_PREFIX = ':codex-annotation{index="';
const PARTIAL_MARKER = /^:codex-annotation\{index="\d*"?\}?$/u;
const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/u;

/**
 * Removes Codex' reserved response-annotation locator only at the trusted
 * provider-assistant boundary. Callers must not apply this to user-authored
 * text. Markdown code fences and inline-code literals remain untouched.
 */
export function visibleCodexAssistantText(value) {
  const text = String(value ?? "");
  if (!text.includes(":codex")) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let fence = "";
  return text.split(/\r?\n/u).map((line) => {
    const fenceMatch = FENCE_START.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence[0] && fenceMatch[1].length >= fence.length) fence = "";
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    const visible = line.replace(COMPLETE_MARKER, "$1");
    if (visible !== line) return visible;
    const candidate = line.trimStart();
    if (candidate && (MARKER_PREFIX.startsWith(candidate) || PARTIAL_MARKER.test(candidate))) {
      return line.slice(0, line.length - candidate.length);
    }
    return line;
  }).join(newline);
}
