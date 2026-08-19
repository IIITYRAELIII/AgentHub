(() => {
  "use strict";

  function messageKey(message, index = 0) {
    const clientUserMessageId = String(message?.clientUserMessageId ?? "").trim();
    if (clientUserMessageId) return `client\u001f${clientUserMessageId}`;
    const id = String(message?.id ?? "").trim();
    if (id) return `id\u001f${id}`;
    const identity = [
      message?.provider,
      message?.threadId,
      message?.turnId,
      message?.itemId,
      message?.role,
    ].map((value) => String(value ?? "").trim());
    if (identity.some(Boolean)) return `identity\u001f${identity.join("\u001f")}`;
    return `position\u001f${index}\u001f${String(message?.role ?? "")}\u001f${String(message?.text ?? "")}`;
  }

  function messageContentSignature(message, { withDiff = false, diffText = "" } = {}) {
    const responseAnnotations = message?.role === "user" && Array.isArray(message?.responseAnnotations)
      ? message.responseAnnotations
      : [];
    const rendersResponseAnnotations = responseAnnotations.some((item) => (
      String(item?.text ?? "").trim() || String(item?.annotation ?? "").trim()
    ));
    try {
      return JSON.stringify({
        role: message?.role ?? "",
        kind: message?.kind ?? "",
        text: message?.text ?? "",
        responseAnnotations: rendersResponseAnnotations ? responseAnnotations : [],
        responseAnnotationRequest: rendersResponseAnnotations
          ? String(message?.responseAnnotationRequest ?? message?.text ?? "").trim()
          : "",
        activities: message?.activities ?? [],
        activityGroups: message?.activityGroups ?? [],
        attachments: message?.attachments ?? [],
        withDiff: withDiff === true,
        diffText: withDiff ? String(diffText ?? "") : "",
      });
    } catch {
      return `${messageKey(message)}\u001f${withDiff ? "diff" : "plain"}`;
    }
  }

  function composerFollowUpMode(task, { steerWhileRunning = false } = {}) {
    if (task?.running !== true) return null;
    return steerWhileRunning ? "steer" : "queue";
  }

  function messageCopyRequest(message) {
    if (!["user", "agent", "assistant"].includes(String(message?.role ?? ""))) return null;
    const text = String(message?.text ?? "");
    if (!text.trim()) return null;
    return { text, successMessage: "Сообщение скопировано" };
  }

  function extractTechnicalTails(value) {
    const tokenPattern = /(runtime|коммит)\s*(?:[:—–-]\s*)?(?:`([^`\r\n]+)`|(\d{12,}-[\p{L}\p{N}_-]+|[0-9a-f]{7,40}))/giu;
    const rows = [];
    const kept = [];
    const segments = String(value ?? "").match(/[^.!?\n]+[.!?]?|\n/gu) ?? [];
    for (const segment of segments) {
      const matches = Array.from(segment.matchAll(tokenPattern));
      if (!matches.length) {
        kept.push(segment);
        continue;
      }
      const note = segment.replace(tokenPattern, "")
        .replace(/^[\s,;:—–-]+/gu, "")
        .replace(/[ \t]+/gu, " ")
        .trim();
      matches.forEach((match, index) => rows.push({
        label: String(match[1]).toLocaleUpperCase("ru-RU"),
        value: String(match[2] ?? match[3] ?? "").trim(),
        note: index === matches.length - 1 ? note : "",
      }));
    }
    const text = kept.join("")
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n[ \t]+/gu, "\n")
      .replace(/[ \t]{2,}/gu, " ")
      .trim();
    return { text, rows };
  }

  function normalizeSystemEventText(value) {
    const text = String(value ?? "").trim();
    if (!/св[её]рт/iu.test(text)) return text;
    const transition = text.match(/(\d+(?:[.,]\d+)?%)\s*(?:->|>|→)\s*(\d+(?:[.,]\d+)?%)/u);
    if (!transition) return text;
    return `Свёртка контекста · ${transition[1]} → ${transition[2]}`;
  }

  function claimKeyedChildrenOwner(container, ownerKey) {
    if (!container || !container.dataset || typeof container.removeChild !== "function") {
      throw new TypeError("container must expose dataset and removeChild");
    }
    const nextOwnerKey = String(ownerKey ?? "");
    const previousOwnerKey = String(container.dataset.messageOwnerKey ?? "");
    if (previousOwnerKey === nextOwnerKey) return false;
    if (typeof container.replaceChildren === "function") container.replaceChildren();
    else while ((container.children?.length ?? 0) > 0) {
      container.removeChild(container.children[container.children.length - 1]);
    }
    container.dataset.messageOwnerKey = nextOwnerKey;
    return true;
  }

  function messageTailWindow(messages, limit = 80) {
    const values = Array.isArray(messages) ? messages : [];
    const maximum = Math.max(1, Number(limit) || 80);
    return values.length > maximum ? values.slice(-maximum) : values;
  }

  function sameRenderedMessage(left, right) {
    if (left === right) return true;
    if (messageContentSignature(left) !== messageContentSignature(right)) return false;
    return [
      "id",
      "turnId",
      "itemId",
      "deliveryState",
      "author",
      "time",
      "delivery",
      "failed",
      "provider",
      "threadId",
      "model",
      "agentThreadId",
    ].every((field) => left?.[field] === right?.[field]);
  }

  function prependedMessageCount(previous, next) {
    const before = Array.isArray(previous) ? previous : [];
    const after = Array.isArray(next) ? next : [];
    const added = after.length - before.length;
    if (added <= 0) return 0;
    for (let index = 0; index < before.length; index += 1) {
      const previousMessage = before[index];
      const nextMessage = after[added + index];
      if (messageKey(previousMessage, index) !== messageKey(nextMessage, added + index)) return 0;
      if (!sameRenderedMessage(previousMessage, nextMessage)) return 0;
    }
    return added;
  }

  function reconcilePrependedKeyedChildren(
    container,
    prefixSpecs,
    expectedExistingKeys,
    createNode,
  ) {
    if (!container || typeof container.insertBefore !== "function") {
      throw new TypeError("container must support insertBefore");
    }
    if (typeof createNode !== "function") throw new TypeError("createNode must be a function");
    const specs = Array.isArray(prefixSpecs) ? prefixSpecs : [];
    const expected = Array.isArray(expectedExistingKeys) ? expectedExistingKeys : [];
    const children = Array.from(container.children ?? []);
    if (!specs.length || children.length !== expected.length) return null;
    if (children.some((child, index) => (
      String(child?.dataset?.messageKey ?? "") !== String(expected[index] ?? "")
    ))) return null;
    const occupied = new Set(expected.map((key) => String(key ?? "")));
    for (const spec of specs) {
      const key = String(spec?.key ?? "");
      if (!key || occupied.has(key)) return null;
      occupied.add(key);
    }

    const reference = children[0] ?? null;
    const created = [];
    for (const [index, spec] of specs.entries()) {
      const node = createNode(spec, index);
      node.dataset.messageKey = String(spec.key ?? "");
      node.dataset.messageContentSignature = String(spec.signature ?? "");
      container.insertBefore(node, reference);
      created.push(node);
    }
    return created;
  }

  function reconcileKeyedChildren(container, specs, createNode, updateNode = () => {}) {
    if (!container || typeof container.insertBefore !== "function") {
      throw new TypeError("container must support insertBefore");
    }
    if (typeof createNode !== "function") throw new TypeError("createNode must be a function");
    const values = Array.isArray(specs) ? specs : [];
    const existing = new Map();
    for (const child of Array.from(container.children ?? [])) {
      const key = String(child?.dataset?.messageKey ?? "");
      if (key && !existing.has(key)) existing.set(key, child);
    }

    values.forEach((spec, index) => {
      const key = String(spec?.key ?? "");
      const signature = String(spec?.signature ?? "");
      let node = existing.get(key);
      if (!node || String(node.dataset?.messageContentSignature ?? "") !== signature) {
        node = createNode(spec, index);
      } else {
        updateNode(node, spec, index);
      }
      node.dataset.messageKey = key;
      node.dataset.messageContentSignature = signature;
      const current = container.children?.[index] ?? null;
      if (current !== node) container.insertBefore(node, current);
    });

    while ((container.children?.length ?? 0) > values.length) {
      container.removeChild(container.children[container.children.length - 1]);
    }
  }

  globalThis.AgentHubMessageView = Object.freeze({
    claimKeyedChildrenOwner,
    composerFollowUpMode,
    extractTechnicalTails,
    messageCopyRequest,
    messageContentSignature,
    messageKey,
    messageTailWindow,
    normalizeSystemEventText,
    prependedMessageCount,
    reconcilePrependedKeyedChildren,
    reconcileKeyedChildren,
  });
})();
