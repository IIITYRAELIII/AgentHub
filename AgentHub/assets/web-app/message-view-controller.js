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
    try {
      return JSON.stringify({
        role: message?.role ?? "",
        kind: message?.kind ?? "",
        text: message?.text ?? "",
        responseAnnotations: message?.responseAnnotations ?? [],
        responseAnnotationRequest: message?.responseAnnotationRequest ?? "",
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

  function composerFollowUpMode(task) {
    return task?.running === true ? "queue" : null;
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
    composerFollowUpMode,
    messageContentSignature,
    messageKey,
    reconcileKeyedChildren,
  });
})();
