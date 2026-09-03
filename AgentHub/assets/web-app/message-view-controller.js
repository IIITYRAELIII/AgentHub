(() => {
  "use strict";

  const MAX_RESPONSE_ANNOTATION_INDEX = 20;
  const DEFERRED_USER_MESSAGE_THRESHOLD = 4_000;
  const DEFERRED_USER_MESSAGE_PREVIEW_CHARS = 1_600;

  function normalizedResponseAnnotationReferences(references) {
    const normalized = [];
    const seen = new Set();
    for (const reference of Array.isArray(references) ? references : []) {
      const index = Number(reference?.index);
      if (!Number.isSafeInteger(index) || index < 1
        || index > MAX_RESPONSE_ANNOTATION_INDEX || seen.has(index)) continue;
      seen.add(index);
      normalized.push({ index });
    }
    return normalized;
  }

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
        responseAnnotationReferences: message?.role === "agent"
          && Array.isArray(message?.responseAnnotationReferences)
          ? message.responseAnnotationReferences
          : [],
        responseCitationPresentations: message?.role === "agent"
          && Array.isArray(message?.responseCitationPresentations)
          ? message.responseCitationPresentations
          : [],
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

  function responseCitationPresentations(messages, messageIndex) {
    const values = Array.isArray(messages) ? messages : [];
    const message = values[messageIndex];
    const references = message?.role === "agent" && Array.isArray(message.responseAnnotationReferences)
      ? normalizedResponseAnnotationReferences(message.responseAnnotationReferences)
      : [];
    if (!references.length) return [];
    let targetIndex = -1;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      if (values[index]?.role === "user" && Array.isArray(values[index].responseAnnotations)
        && values[index].responseAnnotations.length) {
        targetIndex = index;
        break;
      }
    }
    const target = values[targetIndex];
    return references.flatMap((reference) => {
      const index = Number(reference?.index);
      const annotation = target?.responseAnnotations?.[index - 1];
      const interactive = Boolean(target && annotation);
      const quote = String(annotation?.annotation ?? "").trim();
      const source = globalThis.AgentHubMessageDisclosure?.normalizedResponseAnnotationSource?.(
        annotation?.source,
      );
      return [{
        index,
        label: `Цитата ${index}`,
        quote: interactive ? quote : "",
        annotation: quote,
        targetMessageKey: interactive ? messageKey(target, targetIndex) : "",
        ...(interactive && source ? { source } : {}),
        interactive,
      }];
    });
  }

  function responseCitationControl(citation) {
    const index = Number(citation?.index);
    const targetMessageKey = String(citation?.targetMessageKey ?? "").trim();
    const interactive = citation?.interactive === true
      && Number.isSafeInteger(index) && index >= 1
      && index <= MAX_RESPONSE_ANNOTATION_INDEX && Boolean(targetMessageKey);
    return {
      tagName: interactive ? "button" : "span",
      className: `msg-response-citation${interactive ? "" : " is-fallback"}`,
      interactive,
      label: String(citation?.label ?? (Number.isSafeInteger(index) ? `Цитата ${index}` : "Цитата")),
      quote: interactive ? String(citation?.quote ?? "").trim() : "",
      ...(interactive ? { index, targetMessageKey } : {}),
    };
  }

  function responseAnnotationCardControl(annotation) {
    const source = globalThis.AgentHubMessageDisclosure?.normalizedResponseAnnotationSource?.(
      annotation?.source,
    );
    return {
      tagName: source ? "button" : "div",
      interactive: Boolean(source),
      ...(source ? { source } : {}),
    };
  }

  function withoutResponseCitationFallbacks(value, references) {
    let lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
    for (const reference of normalizedResponseAnnotationReferences(references)) {
      const index = Number(reference?.index);
      const label = `Цитата ${index}`;
      const position = lines.findIndex((line) => line.trim() === label);
      if (position >= 0) lines.splice(position, 1);
    }
    while (lines[0] === "") lines = lines.slice(1);
    return lines.join("\n");
  }

  function messageTimestampLabel(value, nowValue = Date.now()) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const now = new Date(nowValue);
    const today = Number.isFinite(now.getTime())
      && date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    if (today) return time;
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}.${date.getFullYear()} ${time}`;
  }

  function timestampMs(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
    return Date.parse(String(value ?? ""));
  }

  function turnDurationLabel(startedAt, completedAt) {
    const startedAtMs = timestampMs(startedAt);
    const completedAtMs = timestampMs(completedAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs) {
      return "";
    }
    const totalMinutes = Math.floor((completedAtMs - startedAtMs) / 60_000);
    if (totalMinutes < 1) return "<1 мин";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `${minutes} мин`;
    return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  }

  function composerFollowUpMode(task, { steerWhileRunning = false } = {}) {
    return steerWhileRunning ? "steer" : "queue";
  }

  function messageCopyRequest(message) {
    if (!["user", "agent", "assistant"].includes(String(message?.role ?? ""))) return null;
    const text = String(message?.text ?? "");
    if (!text.trim()) return null;
    return { text, successMessage: "Сообщение скопировано" };
  }

  function codeBlockCopyRequest(value) {
    const source = String(value ?? "");
    const fenced = source.match(/^\s*```[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n\s*```\s*)?$/u);
    const text = fenced ? fenced[1] : source;
    if (!text) return null;
    return { text, successMessage: "Блок скопирован" };
  }

  function deferredQueueCounts(entries) {
    const counts = { pending: 0, starting: 0, queued: 0, paused: 0 };
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.state === "pending") counts.pending += 1;
      else if (entry?.state === "paused") counts.paused += 1;
      else if (entry?.conflictKind === "message-intake") counts.starting += 1;
      else counts.queued += 1;
    }
    return counts;
  }

  function standaloneInlineCode(value) {
    const match = String(value ?? "").match(/^\s*`([^`\r\n]+)`\s*$/u);
    return match ? match[1] : null;
  }

  function inlineMarkdownTokens(value) {
    const text = String(value ?? "");
    const pattern = /(:codex-file-citation\{[^}\n]+\}|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(<[^>\n]+>\)|\[[^\]\n]+\]\([^)\n]+\))/gu;
    return [...text.matchAll(pattern)].map((match) => ({
      index: match.index,
      token: match[0],
    }));
  }

  function messageDisclosurePresentation(expanded) {
    return expanded
      ? { label: "Свернуть", icon: "caret-up" }
      : { label: "Показать ещё", icon: "caret-down" };
  }

  function deferredUserMessagePreview(message) {
    const text = String(message?.text ?? "");
    if (message?.role !== "user"
      || text.length < DEFERRED_USER_MESSAGE_THRESHOLD
      || (Array.isArray(message?.responseAnnotations) && message.responseAnnotations.length)) return null;
    const head = text.slice(0, DEFERRED_USER_MESSAGE_PREVIEW_CHARS);
    const newline = head.lastIndexOf("\n");
    const space = head.lastIndexOf(" ");
    const boundary = Math.max(newline, space);
    const preview = head.slice(
      0,
      boundary >= Math.floor(DEFERRED_USER_MESSAGE_PREVIEW_CHARS * 0.75) ? boundary : head.length,
    ).trimEnd();
    return `${preview}\n…`;
  }

  function createDeferredDisclosureController(details, content, renderContent) {
    if (!details || typeof details.addEventListener !== "function") {
      throw new TypeError("details must support addEventListener");
    }
    if (!content || typeof content.replaceChildren !== "function") {
      throw new TypeError("content must support replaceChildren");
    }
    if (typeof renderContent !== "function") throw new TypeError("renderContent must be a function");
    let render = renderContent;
    let materialized = false;

    const sync = () => {
      if (details.open === true) {
        if (!materialized) {
          render(content);
          materialized = true;
        }
        return;
      }
      if (!materialized) return;
      content.replaceChildren();
      materialized = false;
    };
    const update = (nextRender) => {
      if (typeof nextRender !== "function") throw new TypeError("renderContent must be a function");
      render = nextRender;
      if (materialized) {
        content.replaceChildren();
        materialized = false;
      }
      sync();
    };

    details.addEventListener("toggle", sync);
    sync();
    return Object.freeze({
      get materialized() {
        return materialized;
      },
      sync,
      update,
    });
  }

  function extractTechnicalTails(value) {
    const tokenPattern = /(runtime|коммит)\s*(?:[:—–-]\s*)?(?:`([^`\r\n]+)`|(\d{12,}-[\p{L}\p{N}_-]+|[0-9a-f]{7,40}))/giu;
    const rows = [];
    const kept = [];
    const segments = String(value ?? "").match(/[^.!?\n]+[.!?]*|[.!?]+|\n/gu) ?? [];
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

  function messageTechnicalContent(role, value) {
    const text = String(value ?? "");
    if (!["agent", "assistant"].includes(String(role ?? ""))) return { text, rows: [] };
    return extractTechnicalTails(text);
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

  function messageOwnsDeferredQueue(message) {
    if (message?.role !== "user" || message?.providerAccepted === true) return false;
    const projectionState = String(message?.projectionState ?? "").trim();
    if (["active", "completed", "failed", "cancelled"].includes(projectionState)) return false;
    if (projectionState === "optimistic") return false;
    if (["queued", "unknown"].includes(projectionState)) return true;
    return [
      "preparing",
      "sending",
      "steering",
      "queued",
      "deferred",
      "unconfirmed",
      "rejected",
    ].includes(String(message?.deliveryState ?? "").trim());
  }

  function conversationSurfaceMessages(messages) {
    return (Array.isArray(messages) ? messages : []).filter((message) => (
      !messageOwnsDeferredQueue(message)
    ));
  }

  function messageTailWindow(messages, limit = 80) {
    const values = Array.isArray(messages) ? messages : [];
    const maximum = Math.max(1, Number(limit) || 80);
    return values.length > maximum ? values.slice(-maximum) : values;
  }

  function messageTailPagination(messageCount, visibleLimit = 40, pageSize = 40) {
    const loadedCount = Number.isSafeInteger(Number(messageCount))
      ? Math.max(0, Number(messageCount))
      : 0;
    const requestedLimit = Math.max(1, Number(visibleLimit) || 40);
    const requestedPageSize = Math.max(1, Number(pageSize) || 40);
    const visibleCount = Math.min(loadedCount, requestedLimit);
    const hiddenCount = Math.max(0, loadedCount - visibleCount);
    return {
      loadedCount,
      visibleCount,
      hiddenCount,
      nextCount: Math.min(hiddenCount, requestedPageSize),
    };
  }

  function resolvedMessageCount(loadedCount, totalCount) {
    const loaded = Number.isSafeInteger(Number(loadedCount))
      ? Math.max(0, Number(loadedCount))
      : 0;
    const total = Number.isSafeInteger(Number(totalCount))
      ? Math.max(0, Number(totalCount))
      : 0;
    return Math.max(loaded, total);
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
    codeBlockCopyRequest,
    composerFollowUpMode,
    conversationSurfaceMessages,
    createDeferredDisclosureController,
    deferredUserMessagePreview,
    deferredQueueCounts,
    extractTechnicalTails,
    messageTechnicalContent,
    messageCopyRequest,
    messageDisclosurePresentation,
    messageContentSignature,
    messageKey,
    messageOwnsDeferredQueue,
    messageTailPagination,
    messageTimestampLabel,
    normalizedResponseAnnotationReferences,
    responseAnnotationCardControl,
    responseCitationControl,
    responseCitationPresentations,
    messageTailWindow,
    inlineMarkdownTokens,
    normalizeSystemEventText,
    prependedMessageCount,
    reconcilePrependedKeyedChildren,
    resolvedMessageCount,
    reconcileKeyedChildren,
    standaloneInlineCode,
    turnDurationLabel,
    withoutResponseCitationFallbacks,
  });
})();
