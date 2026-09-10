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

export function userDisplayText(display, identity) {
  return sameIdentity(display, identity) && typeof display?.text === "string" ? display.text : null;
}
