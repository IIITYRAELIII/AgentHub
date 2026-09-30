// Only a reserved provider client identity may turn a Codex response into
// internal context-probe usage. A shared prefix or marker text is insufficient.
const CONTEXT_PROBE_CLIENT_ID = /^agent-hub-context-probe:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isCodexContextProbeClientId(value) {
  return CONTEXT_PROBE_CLIENT_ID.test(String(value ?? "").trim());
}
