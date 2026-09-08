(() => {
  "use strict";

  // This is intentionally a visual limit only.  Message text remains intact
  // in the DOM and in every transport payload.
  const USER_MESSAGE_COLLAPSE_HEIGHT_PX = 448;
  const TURN_TRACE_ACTIVITY_GROUP_ID = "trace:activities";
  const RESPONSE_ANNOTATION_SOURCE_VERSION = 1;
  const RESPONSE_ANNOTATION_MAX_OFFSET = 1_000_000;
  const RESPONSE_ANNOTATION_MAX_SPAN = 400;
  const RESPONSE_ANNOTATION_MAX_SURFACE_INDEX = 199;
  const RESPONSE_ANNOTATION_SURFACES = new Set(["message-body", "trace-reasoning", "reasoning"]);
  const RESPONSE_ANNOTATION_SOURCE_ROLES = new Set(["agent", "user"]);
  const SHA256 = /^sha256:[0-9a-f]{64}$/u;

  function cleanSourceIdentity(value, limit = 300) {
    const text = String(value ?? "").trim();
    return text && text.length <= limit && !/[\u0000-\u001f\u007f]/u.test(text) ? text : "";
  }

  function responseAnnotationSourceMessageKey({
    provider,
    threadId,
    turnId,
    itemId,
    role = "agent",
    clientUserMessageId = "",
  } = {}) {
    if (clientUserMessageId) {
      const values = [provider, threadId, clientUserMessageId].map((value) => String(value ?? "").trim());
      return role === "user" && values.every(Boolean) ? `client\u001f${values.join("\u001f")}\u001fuser` : "";
    }
    const values = [provider, threadId, turnId, itemId, role].map((value) => String(value ?? "").trim());
    return values.every(Boolean) ? `provider\u001f${values.join("\u001f")}` : "";
  }

  function responseAnnotationSourceIdentity(message, source = null) {
    const provider = cleanSourceIdentity(message?.provider, 20).toLowerCase();
    const threadId = cleanSourceIdentity(message?.threadId);
    const inputRole = String(message?.role ?? "").trim().toLowerCase();
    const role = ["agent", "assistant"].includes(inputRole) ? "agent" : inputRole === "user" ? "user" : "";
    const useClientIdentity = role === "user" && Boolean(source ? source.clientUserMessageId : message?.clientUserMessageId);
    const clientUserMessageId = useClientIdentity ? cleanSourceIdentity(message?.clientUserMessageId) : "";
    if (useClientIdentity && !clientUserMessageId) return null;
    const turnId = useClientIdentity ? "" : cleanSourceIdentity(message?.turnId);
    const itemId = useClientIdentity ? "" : cleanSourceIdentity(message?.itemId);
    const messageKey = responseAnnotationSourceMessageKey({ provider, threadId, turnId, itemId, role, clientUserMessageId });
    return messageKey ? {
      provider, threadId, turnId, itemId, role, messageKey,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    } : null;
  }

  function responseAnnotationSourceContent(message, source = null) {
    const identity = responseAnnotationSourceIdentity(message, source);
    if (!identity) return "";
    return JSON.stringify({
      version: RESPONSE_ANNOTATION_SOURCE_VERSION,
      ...identity,
      text: String(message?.text ?? ""),
      reasoning: String(message?.reasoning ?? ""),
      activityGroups: (Array.isArray(message?.activityGroups) ? message.activityGroups : []).map((group) => ({
        id: String(group?.id ?? ""),
        reasoning: String(group?.reasoning ?? ""),
      })),
    });
  }

  function normalizedResponseAnnotationSource(value) {
    if (!value || Number(value.version) !== RESPONSE_ANNOTATION_SOURCE_VERSION) return null;
    const provider = cleanSourceIdentity(value.provider, 20).toLowerCase();
    const threadId = cleanSourceIdentity(value.threadId);
    const turnId = cleanSourceIdentity(value.turnId);
    const itemId = cleanSourceIdentity(value.itemId);
    const role = String(value.role ?? "").trim().toLowerCase();
    const clientUserMessageId = cleanSourceIdentity(value.clientUserMessageId);
    if (value.clientUserMessageId && (!clientUserMessageId || role !== "user" || turnId || itemId)) return null;
    const surfaceKind = String(value.surfaceKind ?? "").trim();
    const surfaceIndex = Number(value.surfaceIndex);
    const start = Number(value.start);
    const end = Number(value.end);
    const contentHash = String(value.contentHash ?? "").trim().toLowerCase();
    const surfaceHash = String(value.surfaceHash ?? "").trim().toLowerCase();
    const selectionHash = String(value.selectionHash ?? "").trim().toLowerCase();
    const messageKey = responseAnnotationSourceMessageKey({ provider, threadId, turnId, itemId, role, clientUserMessageId });
    if (!provider || !threadId || (!clientUserMessageId && (!turnId || !itemId)) || !RESPONSE_ANNOTATION_SOURCE_ROLES.has(role)
      || String(value.messageKey ?? "") !== messageKey
      || !RESPONSE_ANNOTATION_SURFACES.has(surfaceKind)
      || !Number.isSafeInteger(surfaceIndex) || surfaceIndex < 0
      || surfaceIndex > RESPONSE_ANNOTATION_MAX_SURFACE_INDEX
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > RESPONSE_ANNOTATION_MAX_OFFSET
      || end - start > RESPONSE_ANNOTATION_MAX_SPAN
      || !SHA256.test(contentHash) || !SHA256.test(surfaceHash) || !SHA256.test(selectionHash)) return null;
    return {
      version: RESPONSE_ANNOTATION_SOURCE_VERSION,
      provider,
      threadId,
      turnId,
      itemId,
      role,
      messageKey,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      surfaceKind,
      surfaceIndex,
      start,
      end,
      contentHash,
      surfaceHash,
      selectionHash,
    };
  }

  function responseAnnotationSourceProjection(messages, source) {
    const normalized = normalizedResponseAnnotationSource(source);
    if (!normalized) return null;
    const values = Array.isArray(messages) ? messages : [];
    const matches = values.flatMap((message, index) => (
      responseAnnotationSourceIdentity(message, normalized)?.messageKey === normalized.messageKey
        ? [{ message, index }] : []
    ));
    return matches.length === 1 ? matches[0] : null;
  }

  function responseAnnotationSourceMessages(messages, liveMessage = null) {
    const values = Array.isArray(messages) ? messages.slice() : [];
    const liveIdentity = responseAnnotationSourceIdentity(liveMessage);
    if (!liveIdentity) return values;
    const hasCanonicalProjection = values.some((message) => (
      responseAnnotationSourceIdentity(message)?.messageKey === liveIdentity.messageKey
    ));
    if (!hasCanonicalProjection) values.push(liveMessage);
    return values;
  }

  function responseAnnotationSourceHashesMatch(source, hashes) {
    const normalized = normalizedResponseAnnotationSource(source);
    return Boolean(normalized
      && String(hashes?.contentHash ?? "") === normalized.contentHash
      && String(hashes?.surfaceHash ?? "") === normalized.surfaceHash
      && String(hashes?.selectionHash ?? "") === normalized.selectionHash);
  }

  async function responseAnnotationSha256(value, cryptoApi = globalThis.crypto) {
    if (!cryptoApi?.subtle || typeof TextEncoder !== "function") return "";
    const bytes = new TextEncoder().encode(String(value ?? ""));
    const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
    return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function domTextOffset(surface, container, offset) {
    if (!surface || !container || !surface.ownerDocument
      || (surface !== container && !surface.contains(container))) return null;
    try {
      const range = surface.ownerDocument.createRange();
      range.selectNodeContents(surface);
      range.setEnd(container, offset);
      return range.cloneContents().textContent.length;
    } catch {
      return null;
    }
  }

  function domRangeOffsets(surface, range) {
    const start = domTextOffset(surface, range?.startContainer, range?.startOffset);
    const end = domTextOffset(surface, range?.endContainer, range?.endOffset);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
    const text = String(surface?.textContent ?? "");
    const selected = text.slice(start, end);
    const leading = selected.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = selected.match(/\s*$/u)?.[0].length ?? 0;
    const trimmedStart = start + leading;
    const trimmedEnd = end - trailing;
    if (trimmedEnd <= trimmedStart || trimmedEnd > RESPONSE_ANNOTATION_MAX_OFFSET
      || trimmedEnd - trimmedStart > RESPONSE_ANNOTATION_MAX_SPAN) return null;
    return { start: trimmedStart, end: trimmedEnd };
  }

  function domTextNodes(surface) {
    if (!surface?.ownerDocument) return [];
    const walker = surface.ownerDocument.createTreeWalker(surface, 4);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function domRangeFromOffsets(surface, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
    const nodes = domTextNodes(surface);
    let position = 0;
    let startBoundary = null;
    let endBoundary = null;
    for (const node of nodes) {
      const next = position + node.data.length;
      if (!startBoundary && start >= position && start <= next) {
        startBoundary = { node, offset: start - position };
      }
      if (!endBoundary && end >= position && end <= next) {
        endBoundary = { node, offset: end - position };
      }
      position = next;
    }
    if (!startBoundary || !endBoundary) return null;
    const range = surface.ownerDocument.createRange();
    range.setStart(startBoundary.node, startBoundary.offset);
    range.setEnd(endBoundary.node, endBoundary.offset);
    return range;
  }

  function responseAnnotationSourceSurface(root, source) {
    const normalized = normalizedResponseAnnotationSource(source);
    if (!root || !normalized) return null;
    if (normalized.surfaceKind === "message-body") {
      return Array.from(root.querySelectorAll(".msg-body"))[normalized.surfaceIndex] ?? null;
    }
    const selector = normalized.surfaceKind === "trace-reasoning"
      ? ".turn-trace-reasoning"
      : ".msg-reasoning";
    return Array.from(root.querySelectorAll(selector))[normalized.surfaceIndex] ?? null;
  }

  function responseAnnotationSurfaceLocator(root, surface) {
    if (!root || !surface) return null;
    const candidates = [
      ["message-body", ".msg-body"],
      ["trace-reasoning", ".turn-trace-reasoning"],
      ["reasoning", ".msg-reasoning"],
    ];
    for (const [surfaceKind, selector] of candidates) {
      const surfaceIndex = Array.from(root.querySelectorAll(selector)).indexOf(surface);
      if (surfaceIndex >= 0 && surfaceIndex <= RESPONSE_ANNOTATION_MAX_SURFACE_INDEX) {
        return { surfaceKind, surfaceIndex };
      }
    }
    return null;
  }

  function highlightResponseAnnotationRange(surface, start, end) {
    const range = domRangeFromOffsets(surface, start, end);
    if (!range) return null;
    const rangeText = range.toString().trim();
    const segments = [];
    let position = 0;
    for (const node of domTextNodes(surface)) {
      const next = position + node.data.length;
      const segmentStart = Math.max(start, position);
      const segmentEnd = Math.min(end, next);
      if (segmentEnd > segmentStart) {
        segments.push({ node, start: segmentStart - position, end: segmentEnd - position });
      }
      position = next;
    }
    if (!segments.length) return null;
    const wrappers = [];
    for (const segment of segments.reverse()) {
      let selected = segment.node;
      if (segment.end < selected.data.length) selected.splitText(segment.end);
      if (segment.start > 0) selected = selected.splitText(segment.start);
      const wrapper = surface.ownerDocument.createElement("span");
      wrapper.className = "msg-source-citation-highlight";
      selected.replaceWith(wrapper);
      wrapper.append(selected);
      wrappers.unshift(wrapper);
    }
    let cleaned = false;
    return {
      rangeText,
      first: wrappers[0],
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        for (const wrapper of wrappers) {
          const parent = wrapper.parentNode;
          wrapper.replaceWith(...wrapper.childNodes);
          parent?.normalize?.();
        }
      },
    };
  }

  function hasCollapsedOverflow(scrollHeight, collapseHeight = USER_MESSAGE_COLLAPSE_HEIGHT_PX) {
    return Number(scrollHeight) > Number(collapseHeight);
  }

  function liveActivityDisclosureOpen({ open = false, wasHidden = false, visible = false } = {}) {
    return Boolean(visible && !wasHidden && open);
  }

  function liveActivityTitle({ label = "Вызовы инструментов", count = 0, stage = "" } = {}) {
    const base = `${String(label)} (${Math.max(0, Number(count) || 0)})`;
    const suffix = String(stage ?? "").trim();
    return suffix ? `${base} · ${suffix}` : base;
  }

  function liveStageParts(stage = "") {
    const value = String(stage ?? "").trim();
    const separator = value.indexOf(" · ");
    return separator >= 0
      ? { status: value.slice(0, separator).trim(), detail: value.slice(separator + 3).trim() }
      : { status: value, detail: "" };
  }

  function standaloneLiveStageDetail({ stage = "", traceGroups = [] } = {}) {
    if (Array.isArray(traceGroups) && traceGroups.length) return "";
    return liveStageParts(stage).detail;
  }

  function turnTraceContent(groups = []) {
    const reasoningBlocks = [];
    const activities = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const reasoning = String(group?.reasoning ?? "").trim();
      if (reasoning) reasoningBlocks.push(reasoning);
      if (Array.isArray(group?.activities)) activities.push(...group.activities);
    }
    return { reasoningBlocks, activities };
  }

  function turnTraceSummary({ reasoningCount = 0, activityCount = 0 } = {}) {
    const reasoning = Math.max(0, Number(reasoningCount) || 0);
    const activities = Math.max(0, Number(activityCount) || 0);
    const label = reasoning
      ? (activities ? "Рассуждения и действия" : "Рассуждения")
      : "Выполненные действия";
    return { label, count: reasoning + activities };
  }

  function quotableSelectionText({
    text = "",
    rangeCount = 0,
    startMessage = null,
    endMessage = null,
    startSurface = null,
    endSurface = null,
  } = {}) {
    const quote = String(text ?? "").trim();
    return quote
      && Number(rangeCount) > 0
      && startMessage
      && startMessage === endMessage
      && startSurface
      && endSurface
      ? quote
      : "";
  }

  function quotableSelectionScope({
    startMessage = null,
    endMessage = null,
    intersectedMessage = null,
    startSurface = null,
    endSurface = null,
    intersectedSurface = null,
  } = {}) {
    const message = startMessage ?? endMessage ?? intersectedMessage;
    if (!message
      || (startMessage && startMessage !== message)
      || (endMessage && endMessage !== message)
      || (intersectedMessage && intersectedMessage !== message)) return null;
    const surface = startSurface ?? endSurface ?? intersectedSurface;
    if (!surface) return null;
    return {
      message,
      startSurface: startSurface ?? surface,
      endSurface: endSurface ?? surface,
    };
  }

  function nativeSelectionMenuRequired({ pointerType = "", recentTouch = false } = {}) {
    const input = String(pointerType ?? "").trim().toLowerCase();
    return input === "touch" || (!input && Boolean(recentTouch));
  }

  function liveTraceDisclosureOpen({ groupId = "", openGroupIds = [] } = {}) {
    return Array.from(openGroupIds ?? []).includes(String(groupId));
  }

  window.AgentHubMessageDisclosure = Object.freeze({
    USER_MESSAGE_COLLAPSE_HEIGHT_PX,
    TURN_TRACE_ACTIVITY_GROUP_ID,
    hasCollapsedOverflow,
    liveActivityDisclosureOpen,
    liveActivityTitle,
    liveStageParts,
    standaloneLiveStageDetail,
    liveTraceDisclosureOpen,
    nativeSelectionMenuRequired,
    domRangeFromOffsets,
    domRangeOffsets,
    highlightResponseAnnotationRange,
    normalizedResponseAnnotationSource,
    quotableSelectionScope,
    quotableSelectionText,
    responseAnnotationSha256,
    responseAnnotationSourceContent,
    responseAnnotationSourceHashesMatch,
    responseAnnotationSourceIdentity,
    responseAnnotationSourceMessageKey,
    responseAnnotationSourceMessages,
    responseAnnotationSourceProjection,
    responseAnnotationSourceSurface,
    responseAnnotationSurfaceLocator,
    turnTraceContent,
    turnTraceSummary,
  });
})();
