import { randomUUID } from "node:crypto";

export const CODEX_CONTEXT_PROBE_RESPONSE = "AGENT_HUB_CONTEXT_PROBE_OK_V1";
export const CODEX_CONTEXT_PROBE_PROMPT = `Ответь строго: ${CODEX_CONTEXT_PROBE_RESPONSE}`;
export const CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX = "agent-hub-context-probe:";
export const CODEX_CONTEXT_PROBE_RESPONSE_PREFIX = "AGENT_HUB_CONTEXT_PROBE";

export function codexContextProbeClientId() {
  return `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}${randomUUID()}`;
}

export function isCodexContextProbeClientId(value) {
  return String(value ?? "").trim().startsWith(CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX);
}

export function isCodexContextProbeText(value) {
  const text = String(value ?? "").trim();
  return text === CODEX_CONTEXT_PROBE_PROMPT || isCodexContextProbeResponseText(text);
}

export function isCodexContextProbeResponseText(value) {
  return String(value ?? "").trim().startsWith(CODEX_CONTEXT_PROBE_RESPONSE_PREFIX);
}

export function isCodexContextProbeTurn(turn, { allowTextFallback = true } = {}) {
  const operationKind = String(turn?.operationKind ?? "").trim().toLowerCase();
  if (operationKind === "probe") return true;
  if (operationKind) return false;
  if (turn?.contextProbe === true) return true;
  const userMessages = Array.isArray(turn?.userMessages) ? turn.userMessages : [];
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const clientIds = [
    turn?.clientUserMessageId ?? turn?.clientId,
    ...userMessages.map((message) => message?.clientUserMessageId ?? message?.clientId),
    ...items
      .filter((item) => item?.type === "userMessage")
      .map((item) => item?.clientUserMessageId ?? item?.clientId),
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  if (clientIds.some(isCodexContextProbeClientId)) return true;
  if (turn?.contextProbe === false) return false;
  // A normal client id is an explicit user-operation identity. Reserved text
  // remains valid user content and may only classify identity-less legacy data.
  if (clientIds.length) return false;
  if (!allowTextFallback) return false;
  if (isCodexContextProbeText(turn?.prompt)) return true;
  if (isCodexContextProbeResponseText(
    turn?.finalAnswer ?? turn?.answer ?? turn?.responseText,
  )) return true;
  if (userMessages.some((message) => (
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
