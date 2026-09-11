const IDENTITY_FIELDS = ["provider", "threadId", "clientUserMessageId"];

function sameIdentity(value, identity) {
  return IDENTITY_FIELDS.every((field) => (
    typeof identity?.[field] === "string" && identity[field].length > 0
    && value?.[field] === identity[field]
  ));
}

// Display data never supplies identity and never rewrites the provider payload.
export function receiptUserDisplay(receipt, identity) {
  if (!sameIdentity(receipt, identity) || typeof receipt?.result?.displayText !== "string") return null;
  return {
    provider: identity.provider,
    threadId: identity.threadId,
    clientUserMessageId: identity.clientUserMessageId,
    text: receipt.result.displayText,
  };
}

// The accepted receipt already owns the authoritative interstream origin of its
// exact message. Reading it under the same identity guard as the display text
// lets the first projected frame name its source instead of waiting for the
// provider echo to carry the origin back.
export function receiptUserOrigin(receipt, identity) {
  if (!sameIdentity(receipt, identity)) return null;
  const origin = receipt?.result?.origin;
  return origin && typeof origin === "object" && !Array.isArray(origin) ? origin : null;
}

export function userDisplayText(display, identity) {
  return sameIdentity(display, identity) && typeof display?.text === "string" ? display.text : null;
}
