// The retired context measurement command used a reserved client identity.
// Its text is not an identity: users may legitimately send the same words.
const LEGACY_PROBE_CLIENT_ID = /^agent-hub-context-probe:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isLegacyCodexContextProbeClientId(value) {
  return LEGACY_PROBE_CLIENT_ID.test(String(value ?? "").trim());
}

export function isLegacyCodexContextProbeTurn(turn) {
  const messages = Array.isArray(turn?.messages) ? turn.messages : [];
  const ids = [turn?.clientUserMessageId, ...messages
    .filter((message) => message?.role === "user")
    .map((message) => message.clientUserMessageId ?? message.clientId)]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return ids.length > 0 && ids.every(isLegacyCodexContextProbeClientId);
}
