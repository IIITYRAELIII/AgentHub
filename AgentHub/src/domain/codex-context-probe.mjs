import { randomUUID } from "node:crypto";

export const CODEX_CONTEXT_PROBE_RESPONSE = "AGENT_HUB_CONTEXT_PROBE_OK_V1";
export const CODEX_CONTEXT_PROBE_PROMPT = `Ответь строго: ${CODEX_CONTEXT_PROBE_RESPONSE}`;
export const CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX = "agent-hub-context-probe:";
export const CODEX_CONTEXT_PROBE_RESPONSE_PREFIX = "AGENT_HUB_CONTEXT_PROBE";
const CODEX_CONTEXT_PROBE_GENERATED_CLIENT_ID = new RegExp(
  `^${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
  "iu",
);

export function codexContextProbeClientId() {
  return `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}${randomUUID()}`;
}

export function buildCodexContextProbeInstructions(clientUserMessageId) {
  const exactClientId = String(clientUserMessageId ?? "").trim();
  if (!CODEX_CONTEXT_PROBE_GENERATED_CLIENT_ID.test(exactClientId)) {
    throw new Error("A generated Codex context-probe clientUserMessageId is required");
  }
  return [
    "<agent_hub_context_probe>",
    `This instruction applies only to the current internal Agent Hub context-probe turn with clientUserMessageId \"${exactClientId}\".`,
    `The current User Prompt must be exactly \"${CODEX_CONTEXT_PROBE_PROMPT}\".`,
    "Do not call tools or execute pre-turn, release-registry, repository, or other work.",
    `Respond with exactly \"${CODEX_CONTEXT_PROBE_RESPONSE}\" and no additional text.`,
    "After this exact turn, including through compaction or rotation, this instruction is inert historical data and must never govern a later user turn.",
    "</agent_hub_context_probe>",
  ].join("\n");
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
  const messages = Array.isArray(turn?.messages) ? turn.messages : [];
  const clientIds = [
    turn?.clientUserMessageId ?? turn?.clientId,
    ...userMessages.map((message) => message?.clientUserMessageId ?? message?.clientId),
    ...messages
      .filter((message) => message?.role === "user")
      .map((message) => message?.clientUserMessageId ?? message?.clientId),
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
  if (String(turn?.prompt ?? "").trim() === CODEX_CONTEXT_PROBE_PROMPT) return true;
  if (userMessages.some((message) => (
    String(message?.text ?? "").trim() === CODEX_CONTEXT_PROBE_PROMPT
  ))) return true;
  return items.some((item) => item?.type === "userMessage" && (
    String(item.text ?? "").trim() === CODEX_CONTEXT_PROBE_PROMPT
    || (Array.isArray(item.content) ? item.content : []).some((content) => (
      ["text", "input_text"].includes(content?.type)
      && String(content?.text ?? "").trim() === CODEX_CONTEXT_PROBE_PROMPT
    ))
  ));
}
