// Pure shared redaction. It owns no transport, storage or logging concern, so
// both diagnostics and domain normalization can depend on it without an
// infrastructure edge.
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|]*/gu;
const UNC_PATH = /\\\\[^\s"'<>|]+/gu;
// Only real filesystem roots, so ordinary prose such as "and/or" survives.
const POSIX_PATH = /(?<![\w.~])\/(?:home|Users|root|var|tmp|opt|srv|mnt|media|private|etc|proc)\/[^\s"'<>|]*/gu;

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*["']?[^"'\s,;]+/giu, "$1=[redacted]")
    .replace(/([?#&]access=)[^&#\s"'<>]+/giu, "$1[redacted]")
    .replace(/\b(access)\s*[:=]\s*["']?[^"'\s,;]+/giu, "$1=[redacted]");
}

// Absolute paths expose the operator's account and layout, so user-visible
// provider text keeps only the fact that a path was mentioned.
export function redactPrivatePaths(value) {
  return String(value ?? "")
    .replace(UNC_PATH, "[path]")
    .replace(WINDOWS_PATH, "[path]")
    .replace(POSIX_PATH, "[path]");
}

export function redactSensitiveText(value) {
  return redactPrivatePaths(redactSecrets(value));
}
