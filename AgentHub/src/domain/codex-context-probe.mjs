import { randomUUID } from "node:crypto";

export const CODEX_CONTEXT_PROBE_RESPONSE = "AGENT_HUB_CONTEXT_PROBE_OK_V1";
export const CODEX_CONTEXT_PROBE_PROMPT = `Ответь строго: ${CODEX_CONTEXT_PROBE_RESPONSE}`;
export const CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX = "agent-hub-context-probe:";

export function codexContextProbeClientId() {
  return `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}${randomUUID()}`;
}

export function isCodexContextProbeClientId(value) {
  return String(value ?? "").trim().startsWith(CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX);
}

export function isCodexContextProbeText(value) {
  const text = String(value ?? "").trim();
  return text === CODEX_CONTEXT_PROBE_PROMPT || text === CODEX_CONTEXT_PROBE_RESPONSE;
}

function codexContextProbeItemText(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((item) => ["text", "input_text"].includes(String(item?.type ?? "")))
    .map((item) => String(item?.text ?? ""))
    .join("\n")
    .trim();
}

export function isCodexContextProbeTurn(turn) {
  if (isCodexContextProbeText(turn?.prompt) || isCodexContextProbeText(turn?.finalAnswer)) return true;
  return (Array.isArray(turn?.items) ? turn.items : []).some((item) => (
    item?.type === "userMessage"
    && (
      isCodexContextProbeClientId(item.clientId)
      || isCodexContextProbeText(codexContextProbeItemText(item.content))
    )
  ));
}
