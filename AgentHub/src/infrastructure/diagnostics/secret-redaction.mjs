export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/giu, "$1=[redacted]")
    .replace(/([?#&]access=)[^&#\s"'<>]+/giu, "$1[redacted]")
    .replace(/\b(access)\s*[:=]\s*["']?[^"'\s,;]+/giu, "$1=[redacted]");
}
