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

export function isCodexContextProbeTurn(turn, { allowTextFallback = false } = {}) {
  if (turn?.contextProbe === true) return true;
  if (isCodexContextProbeClientId(turn?.clientUserMessageId ?? turn?.clientId)) return true;
  if ((Array.isArray(turn?.userMessages) ? turn.userMessages : []).some((message) => (
    isCodexContextProbeClientId(message?.clientUserMessageId ?? message?.clientId)
  ))) return true;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  if (items.some((item) => (
    item?.type === "userMessage"
    && isCodexContextProbeClientId(item.clientId)
  ))) return true;
  if (!allowTextFallback) return false;
  if (isCodexContextProbeText(turn?.prompt)) return true;
  if ((Array.isArray(turn?.userMessages) ? turn.userMessages : []).some((message) => (
    isCodexContextProbeText(message?.text)
  ))) return true;
  return items.some((item) => item?.type === "userMessage" && (
    isCodexContextProbeText(item.text)
    || (Array.isArray(item.content) ? item.content : []).some((content) => (
      ["text", "input_text"].includes(content?.type)
      && isCodexContextProbeText(content?.text)
    ))
  ));
}
