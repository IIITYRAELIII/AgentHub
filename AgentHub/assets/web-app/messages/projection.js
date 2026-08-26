(function initializeMessageProjection(global) {
  "use strict";

  const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
  const INTERNAL_OPERATION_KINDS = new Set(["probe", "compaction", "measurement", "maintenance"]);
  const STATE_RANK = new Map([
    ["optimistic", 0],
    ["queued", 1],
    ["unknown", 2],
    ["active", 3],
    ["completed", 4],
    ["failed", 4],
    ["cancelled", 4],
  ]);

  function text(value) {
    return String(value ?? "").trim();
  }

  function providerTurnIdentity(value) {
    const provider = text(value?.provider).toLowerCase();
    const threadId = text(value?.threadId);
    const turnId = text(value?.turnId);
    return provider && threadId && turnId ? `${provider}\0${threadId}\0${turnId}` : "";
  }

  function submissionAliases(value) {
    if (text(value?.role) !== "user") return [];
    return [...new Set([
      text(value?.clientUserMessageId),
      text(value?.submissionId),
    ].filter(Boolean))].map((identity) => `submission\0${identity}`);
  }

  function providerEntityIdentity(value) {
    const turn = providerTurnIdentity(value);
    const role = text(value?.role);
    if (!turn || !role) return "";
    const itemId = text(value?.itemId);
    return itemId
      ? `provider-item\0${turn}\0${itemId}\0${role}`
      : `provider-turn\0${turn}\0${role}`;
  }

  function canonicalEntityIdentity(value) {
    const submission = submissionAliases(value)[0];
    if (submission) return submission;
    const provider = providerEntityIdentity(value);
    if (provider) return provider;
    const role = text(value?.role);
    const id = text(value?.id ?? value?.itemId);
    return role === "system" && id ? `system\0${id}` : "";
  }

  function entityAliases(value) {
    const aliases = submissionAliases(value);
    const turn = providerTurnIdentity(value);
    const role = text(value?.role);
    if (turn && ["agent", "assistant"].includes(role) && value?.kind !== "subagent") {
      aliases.push(`provider-turn\0${turn}\0agent-card`);
    }
    return aliases;
  }

  function legacyOperationKindMigrationGuard(value) {
    // Removal condition: every persisted pre-UI-001 message and live snapshot
    // carries operationKind. This guard never defines entity identity.
    if (value?.contextProbe === true) return "probe";
    const clientId = text(value?.clientUserMessageId ?? value?.submissionId);
    if (clientId.startsWith("agent-hub-context-probe:")) return "probe";
    if (value?.maintenance === true || value?.kind === "maintenance") return "maintenance";
    if (["user", "agent", "assistant"].includes(text(value?.role))) return "user-turn";
    return "unknown";
  }

  function operationKind(value) {
    const explicit = text(value?.operationKind).toLowerCase();
    if (["user-turn", "probe", "compaction", "measurement", "maintenance"].includes(explicit)) {
      return explicit;
    }
    return legacyOperationKindMigrationGuard(value);
  }

  function projectionState(value) {
    const explicit = text(value?.projectionState ?? value?.status).toLowerCase();
    if (STATE_RANK.has(explicit)) return explicit;
    if (Number(value?.terminalRevision) > 0) return "completed";
    if (["final", "final_answer", "finalanswer"].includes(text(value?.phase ?? value?.responsePhase).toLowerCase())) {
      return "completed";
    }
    if (value?.activityUnknown === true) return "unknown";
    if (value?.running === true && operationKind(value) === "user-turn") return "active";
    return value?.projectionAuthority === "optimistic" ? "optimistic" : "unknown";
  }

  function terminalRevision(value) {
    const revision = Number(value?.terminalRevision);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
  }

  function isTerminal(value) {
    return TERMINAL_STATES.has(projectionState(value));
  }

  function authorityRank(value) {
    const authority = text(value?.projectionAuthority).toLowerCase();
    return authority === "canonical" ? 3 : authority === "terminal" ? 2 : authority === "live" ? 1 : 0;
  }

  function preserveIdentityAliases(current, incoming) {
    return {
      ...current,
      ...(!text(current?.clientUserMessageId) && text(incoming?.clientUserMessageId)
        ? { clientUserMessageId: incoming.clientUserMessageId }
        : {}),
      ...(!text(current?.submissionId) && text(incoming?.submissionId)
        ? { submissionId: incoming.submissionId }
        : {}),
    };
  }

  function reduceProjectionEntity(current, incoming) {
    if (!current) return { ...incoming };
    const currentTerminal = isTerminal(current);
    const incomingTerminal = isTerminal(incoming);
    if (currentTerminal && !incomingTerminal) return preserveIdentityAliases(current, incoming);
    if (currentTerminal && incomingTerminal) {
      const currentRevision = terminalRevision(current);
      const incomingRevision = terminalRevision(incoming);
      if (currentRevision > 0 && incomingRevision === 0) {
        return preserveIdentityAliases(current, incoming);
      }
      if (currentRevision && incomingRevision && incomingRevision < currentRevision) {
        return preserveIdentityAliases(current, incoming);
      }
      if (incomingRevision === currentRevision && authorityRank(incoming) < authorityRank(current)) {
        return preserveIdentityAliases(current, incoming);
      }
    }
    if (!currentTerminal && !incomingTerminal) {
      const currentRank = STATE_RANK.get(projectionState(current)) ?? 0;
      const incomingRank = STATE_RANK.get(projectionState(incoming)) ?? 0;
      if (incomingRank < currentRank && authorityRank(incoming) <= authorityRank(current)) {
        return preserveIdentityAliases(current, incoming);
      }
    }
    return { ...current, ...incoming };
  }

  function visibleProjectionEntity(value) {
    const kind = operationKind(value);
    if (!INTERNAL_OPERATION_KINDS.has(kind)) return true;
    return text(value?.role) === "system" && projectionState(value) !== "active";
  }

  function projectCanonicalMessages(messages) {
    const records = new Map();
    const aliases = new Map();
    const order = [];
    for (const incoming of Array.isArray(messages) ? messages : []) {
      const incomingAliases = entityAliases(incoming);
      const linkedKeys = [...new Set(incomingAliases.map((alias) => aliases.get(alias)).filter(Boolean))];
      let key = linkedKeys[0] || canonicalEntityIdentity(incoming);
      if (!key) continue;
      if (!records.has(key)) order.push(key);
      for (const linkedKey of linkedKeys.slice(1)) {
        records.set(key, reduceProjectionEntity(records.get(key), records.get(linkedKey)));
        records.delete(linkedKey);
        const position = order.indexOf(linkedKey);
        if (position >= 0) order.splice(position, 1);
      }
      records.set(key, reduceProjectionEntity(records.get(key), incoming));
      for (const alias of incomingAliases) aliases.set(alias, key);
    }
    return order.map((key) => records.get(key)).filter(visibleProjectionEntity);
  }

  function isUserRunningProjection(value) {
    return operationKind(value) === "user-turn" && projectionState(value) === "active" && !isTerminal(value);
  }

  global.AgentHubMessageProjection = Object.freeze({
    canonicalEntityIdentity,
    isUserRunningProjection,
    legacyOperationKindMigrationGuard,
    operationKind,
    projectCanonicalMessages,
    projectionState,
    providerTurnIdentity,
    reduceProjectionEntity,
    submissionAliases,
  });
})(globalThis);
