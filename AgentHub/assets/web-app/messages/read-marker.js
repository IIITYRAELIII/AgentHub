(function installReadMarker(global) {
  "use strict";
  function finalIdentity(final) {
    const provider = String(final?.provider ?? "").trim().toLowerCase();
    const threadId = String(final?.threadId ?? "").trim();
    const turnId = String(final?.turnId ?? "").trim();
    const revision = Number(final?.revision);
    return provider && threadId && turnId && Number.isSafeInteger(revision) && revision > 0
      ? [provider, threadId, turnId, revision].join("\0") : "";
  }
  const threadIdentity = (final) => finalIdentity(final)
    ? [String(final.provider).trim().toLowerCase(), String(final.threadId).trim()].join("\0") : "";

  // This is only a projection of a server-confirmed cursor, never read authority.
  function cursorCovers(final, receipt) {
    if (!finalIdentity(final) || !receipt?.cursor
      || threadIdentity(final) !== threadIdentity(receipt.final)) return false;
    const cursor = receipt.cursor;
    const at = Date.parse(final.completedAt ?? "");
    const readAt = Number(cursor.answerAtMs);
    if (!Number.isSafeInteger(readAt) || readAt <= 0
      || !Number.isSafeInteger(cursor.answerRevision) || cursor.answerRevision < 1
      || !String(cursor.answerTurnId ?? "").trim()) return false;
    if (String(cursor.answerTurnId) === String(final.turnId)) return cursor.answerRevision >= Number(final.revision);
    if (!Number.isSafeInteger(at) || at <= 0) return false;
    if (at !== readAt) return at < readAt;
    return String(final.turnId) < String(cursor.answerTurnId);
  }

  function newerReceipt(previous, next) {
    if (!previous) return next;
    const a = previous.cursor;
    const b = next.cursor;
    if (threadIdentity(previous.final) === threadIdentity(next.final)
      && String(b.answerTurnId) === String(a.answerTurnId)) {
      return Number(b.answerRevision) > Number(a.answerRevision) ? next : previous;
    }
    if (Number(b.answerAtMs) !== Number(a.answerAtMs)) return Number(b.answerAtMs) > Number(a.answerAtMs) ? next : previous;
    if (String(b.answerTurnId) !== String(a.answerTurnId)) return String(b.answerTurnId) > String(a.answerTurnId) ? next : previous;
    return Number(b.answerRevision) > Number(a.answerRevision) ? next : previous;
  }
  global.AgentHubReadMarker = Object.freeze({ finalIdentity, threadIdentity, cursorCovers, newerReceipt });
})(window);
