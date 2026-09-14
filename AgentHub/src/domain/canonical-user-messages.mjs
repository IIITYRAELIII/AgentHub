function clientUserMessageId(message) {
  return String(message?.clientUserMessageId ?? "").trim();
}

function sourceOccurrenceId(message) {
  const value = String(message?.sourceOccurrenceId ?? "").trim();
  return /^(?:codex-rollout|codex-app-server):[0-9a-f]{64}$/u.test(value) ? value : "";
}

export const USER_MESSAGE_SNAPSHOT_AUTHORITY = Object.freeze({
  INCREMENTAL: "incremental",
  COMPLETE: "complete",
});

export function userMessageSnapshotAuthority(source) {
  return source?.userMessageSnapshotAuthority === USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE
    ? USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE
    : USER_MESSAGE_SNAPSHOT_AUTHORITY.INCREMENTAL;
}

export function mergedUserMessageSnapshotAuthority(currentMessages, currentSource, observedSource) {
  if (userMessageSnapshotAuthority(observedSource) !== USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE) {
    return USER_MESSAGE_SNAPSHOT_AUTHORITY.INCREMENTAL;
  }
  const hasUnownedCurrent = (Array.isArray(currentMessages) ? currentMessages : [])
    .some((message) => !clientUserMessageId(message));
  return !hasUnownedCurrent
    || userMessageSnapshotAuthority(currentSource) === USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE
    ? USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE
    : USER_MESSAGE_SNAPSHOT_AUTHORITY.INCREMENTAL;
}

function mergedArray(current, observed, identity) {
  const values = [];
  const known = new Set();
  for (const value of [
    ...(Array.isArray(current) ? current : []),
    ...(Array.isArray(observed) ? observed : []),
  ]) {
    const key = identity(value);
    if (key && known.has(key)) continue;
    if (key) known.add(key);
    values.push(structuredClone(value));
  }
  return values;
}

function mergeOwnedMessage(current, observed) {
  const merged = {
    ...structuredClone(observed),
    ...structuredClone(current),
  };
  if (String(observed?.itemId ?? "").trim()) {
    merged.itemId = observed.itemId;
  }
  const attachments = mergedArray(
    current?.attachments,
    observed?.attachments,
    (attachment) => String(attachment?.id ?? "").trim().toLowerCase(),
  );
  if (attachments.length) merged.attachments = attachments;
  for (const field of ["responseAnnotations", "responseAnnotationReferences"]) {
    const owned = Array.isArray(current?.[field]) ? current[field] : [];
    const provider = Array.isArray(observed?.[field]) ? observed[field] : [];
    if (owned.length || provider.length) {
      merged[field] = structuredClone(owned.length ? owned : provider);
    }
  }
  if (!String(current?.responseAnnotationRequest ?? "").trim()
    && String(observed?.responseAnnotationRequest ?? "").trim()) {
    merged.responseAnnotationRequest = observed.responseAnnotationRequest;
  }
  return merged;
}

export function hasCanonicalUserMessages(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => (
    message?.role !== "agent" && Boolean(clientUserMessageId(message))
  ));
}

export function canonicalizeUserMessages(messages, options = {}) {
  const values = Array.isArray(messages) ? messages : [];
  return mergeCanonicalUserMessages([], values, options);
}

/*
 * Agent Hub owns every message carrying clientUserMessageId. Provider-owned
 * messages retain each observed occurrence. A provider observation may enrich
 * an exact identity, but it
 * cannot overwrite Hub-owned payload/origin. Already retained provider-owned
 * messages keep every occurrence. Provider item IDs are not assumed globally
 * unique and are never used as an occurrence identity. Provider-only and mixed
 * turns therefore preserve order and every unkeyed occurrence without comparing
 * content, time, position, or provider-generated ID shapes. COMPLETE authority
 * means the source explicitly proves it contains the whole provider-owned user
 * projection for this turn; it replaces that projection wholesale. Merely
 * observing a non-empty source never proves completeness.
 */
export function mergeCanonicalUserMessages(currentMessages, observedMessages, {
  currentSnapshotAuthority = USER_MESSAGE_SNAPSHOT_AUTHORITY.INCREMENTAL,
  snapshotAuthority = USER_MESSAGE_SNAPSHOT_AUTHORITY.INCREMENTAL,
} = {}) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const observed = Array.isArray(observedMessages) ? observedMessages : [];
  const complete = mergedUserMessageSnapshotAuthority(
    current,
    { userMessageSnapshotAuthority: currentSnapshotAuthority },
    { userMessageSnapshotAuthority: snapshotAuthority },
  ) === USER_MESSAGE_SNAPSHOT_AUTHORITY.COMPLETE;
  const merged = [];
  const managedPositions = new Map();
  const occurrencePositions = new Map();
  const conflictingOccurrences = new Set();
  for (const message of complete
    ? current.filter((message) => Boolean(clientUserMessageId(message)))
    : current) {
    const managedId = clientUserMessageId(message);
    const existing = managedId ? managedPositions.get(managedId) : undefined;
    if (existing !== undefined) {
      merged[existing] = mergeOwnedMessage(merged[existing], message);
      continue;
    }
    const occurrenceId = sourceOccurrenceId(message);
    const repeatedOccurrence = occurrenceId ? occurrencePositions.get(occurrenceId) : undefined;
    if (repeatedOccurrence !== undefined) {
      const occurrenceManagedId = clientUserMessageId(merged[repeatedOccurrence]);
      if (!managedId || !occurrenceManagedId || occurrenceManagedId === managedId) {
        merged[repeatedOccurrence] = managedId && !occurrenceManagedId
          ? mergeOwnedMessage(message, merged[repeatedOccurrence])
          : mergeOwnedMessage(merged[repeatedOccurrence], message);
        if (managedId) managedPositions.set(managedId, repeatedOccurrence);
        continue;
      }
      conflictingOccurrences.add(occurrenceId);
      occurrencePositions.delete(occurrenceId);
    }
    const position = merged.length;
    if (managedId) managedPositions.set(managedId, position);
    if (occurrenceId && !conflictingOccurrences.has(occurrenceId)) {
      occurrencePositions.set(occurrenceId, position);
    }
    merged.push(structuredClone(message));
  }
  for (const message of observed) {
    const managedId = clientUserMessageId(message);
    const index = managedId ? managedPositions.get(managedId) : undefined;
    if (index !== undefined) {
      merged[index] = mergeOwnedMessage(merged[index], message);
      continue;
    }
    const occurrenceId = sourceOccurrenceId(message);
    const occurrenceIndex = occurrenceId && !conflictingOccurrences.has(occurrenceId)
      ? occurrencePositions.get(occurrenceId)
      : undefined;
    if (occurrenceIndex !== undefined) {
      const occurrenceManagedId = clientUserMessageId(merged[occurrenceIndex]);
      if (managedId && occurrenceManagedId && occurrenceManagedId !== managedId) {
        // Conflicting exact Hub identities may not be reconciled through
        // provider occurrence evidence. Preserve both and surface the conflict.
        conflictingOccurrences.add(occurrenceId);
        occurrencePositions.delete(occurrenceId);
      } else {
        merged[occurrenceIndex] = managedId && !occurrenceManagedId
          ? mergeOwnedMessage(message, merged[occurrenceIndex])
          : mergeOwnedMessage(merged[occurrenceIndex], message);
        if (managedId) managedPositions.set(managedId, occurrenceIndex);
        continue;
      }
    }
    if (managedId) {
      managedPositions.set(managedId, merged.length);
    }
    if (occurrenceId && !conflictingOccurrences.has(occurrenceId)) {
      occurrencePositions.set(occurrenceId, merged.length);
    }
    merged.push(structuredClone(message));
  }
  return merged;
}

export function rebaseActiveCodexUsers(existingHistory, incomingHistory) {
  const existing = new Map((existingHistory ?? []).map((turn) => [turn.id, turn]));
  return (incomingHistory ?? []).map((turn) => {
    const current = existing.get(turn.id);
    if (current?.active !== true || turn.active !== true || current.completed || turn.completed) return turn;
    const users = (value) => (value.messages ?? []).filter((message) => message.role === "user");
    const currentUsers = users(current);
    const incomingUsers = users(turn);
    // Identity-less legacy rows retain the existing projection behavior until
    // an authoritative provider read supplies identities. Text is never an alias.
    if (![...currentUsers, ...incomingUsers].every((message) => clientUserMessageId(message) || sourceOccurrenceId(message))) return turn;
    return { ...turn,
      userMessageSnapshotAuthority: mergedUserMessageSnapshotAuthority(currentUsers, current, turn),
      messages: [...mergeCanonicalUserMessages(currentUsers, incomingUsers, {
        currentSnapshotAuthority: userMessageSnapshotAuthority(current),
        snapshotAuthority: userMessageSnapshotAuthority(turn),
      }), ...(turn.messages ?? []).filter((message) => message.role !== "user")],
    };
  });
}
