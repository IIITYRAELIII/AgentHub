const COMPLETE_MARKER = /^([ \t]*):(?:agent|codex)-annotation\{index="([^"\r\n]*)"\}(?:[ \t]+(.*)|[ \t]*$)/u;
const MARKER_PREFIXES = [':agent-annotation{index="', ':codex-annotation{index="'];
const PARTIAL_MARKER = /^:(?:agent|codex)-annotation\{index="[^"\r\n]*(?:"\}?)?$/u;
const DECIMAL_INDEX = /^\d+$/u;
const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/u;

export const MAX_CODEX_RESPONSE_ANNOTATION_INDEX = 20;

function normalizedResponseAnnotationLocator(value) {
  if (!value || typeof value !== "object") return null;
  const target = {};
  for (const key of ["clientUserMessageId", "sourceOccurrenceId", "itemId"]) {
    const id = String(value[key] ?? "").trim();
    if (id && id.length <= 300 && !/[\u0000-\u001f]/u.test(id)) target[key] = id;
  }
  if (!Object.keys(target).length) return null;
  if (value.origin === "native-item") target.origin = "native-item";
  if (value.batchScoped === true) target.batchScoped = true;
  return target;
}

export function normalizedResponseAnnotationTarget(value) {
  const origin = value?.origin === "native-item" ? { origin: "native-item" } : {};
  if (Array.isArray(value?.byIndex) && value.byIndex.length
    && value.byIndex.length <= MAX_CODEX_RESPONSE_ANNOTATION_INDEX) {
    return { byIndex: value.byIndex.map(normalizedResponseAnnotationLocator), ...origin };
  }
  if (value?.unresolved === true) return { unresolved: true, ...origin };
  return normalizedResponseAnnotationLocator(value);
}

export function responseAnnotationTargetAtIndex(value, index) {
  const target = normalizedResponseAnnotationTarget(value);
  if (!target?.byIndex) return target;
  const locator = target.byIndex[index - 1];
  return {
    ...(locator ? { ...locator, batchScoped: true } : { unresolved: true }),
    ...(target.origin ? { origin: target.origin } : {}),
  };
}

export function preferredResponseAnnotationTarget(existing, incoming) {
  const previous = normalizedResponseAnnotationTarget(existing);
  const next = normalizedResponseAnnotationTarget(incoming);
  return next?.origin === "native-item" && previous?.origin !== "native-item"
    ? next : previous ?? next;
}

export function responseAnnotationTargetForMessages(messages) {
  const users = (Array.isArray(messages) ? messages : []).filter(message =>
    message?.role === "user" && Array.isArray(message.responseAnnotations) && message.responseAnnotations.length);
  if (users.length <= 1) {
    const locator = normalizedResponseAnnotationLocator(users[0]);
    return locator && { ...locator, batchScoped: true };
  }

  const candidates = Array.from({ length: MAX_CODEX_RESPONSE_ANNOTATION_INDEX }, () => []);
  for (const user of users) {
    const locator = normalizedResponseAnnotationLocator(user);
    for (const [offset, annotation] of user.responseAnnotations.slice(0, candidates.length).entries()) {
      if (String(annotation?.text ?? "").trim() || String(annotation?.annotation ?? "").trim()) {
        candidates[offset].push(locator);
      }
    }
  }
  // A bare marker supplies only its local index. Multiple eligible messages
  // cannot be resolved by choosing the most recent message or marker order.
  return { byIndex: candidates.map(matches => matches.length === 1 ? matches[0] : null) };
}

export function bindResponseAnnotationTarget(projection, value) {
  const target = normalizedResponseAnnotationTarget(value);
  if (!target) return projection;
  return {
    ...projection,
    responseAnnotationTarget: target,
    responseAnnotationReferences: (projection.responseAnnotationReferences ?? []).map(reference => ({
      ...reference,
      target: preferredResponseAnnotationTarget(reference.target, responseAnnotationTargetAtIndex(target, reference.index)),
    })),
  };
}

function annotationLocatorKey(target) {
  if (target?.unresolved) return "unresolved";
  for (const key of ["clientUserMessageId", "sourceOccurrenceId", "itemId"]) {
    if (target?.[key]) return `${key}\u001f${target[key]}`;
  }
  return "";
}

export function retainedResponseAnnotationTarget(references, reference) {
  const matches = references.filter(candidate => candidate.index === reference.index);
  const key = annotationLocatorKey(reference.target);
  const exact = key ? matches.find(candidate => annotationLocatorKey(candidate.target) === key) : null;
  if (exact) return exact.target;
  if (matches.length === 1 && matches[0].target?.origin === "native-item"
    && reference.target?.origin !== "native-item" && !reference.target?.batchScoped) return matches[0].target;
  // Historical callers send one unscoped reference per index. Keep an exact
  // native capture where it can only describe that one reference.
  if (matches.length === 1 && !matches[0].target?.batchScoped && !reference.target?.batchScoped
    && !reference.target?.unresolved) return matches[0].target;
  return !key && matches.length === 1 ? matches[0].target : null;
}

export function normalizedCodexResponseAnnotationReferences(references) {
  const normalized = [];
  const seen = new Map();
  const addressed = new Map();
  for (const reference of Array.isArray(references) ? references : []) {
    const index = Number(reference?.index);
    if (!Number.isSafeInteger(index) || index < 1
      || index > MAX_CODEX_RESPONSE_ANNOTATION_INDEX) continue;
    const target = normalizedResponseAnnotationTarget(reference.target);
    const key = `${index}\u001f${annotationLocatorKey(target)}`;
    const position = reference?.position;
    const range = Number.isSafeInteger(position?.start) && Number.isSafeInteger(position?.end) && position.start >= 0
      && position.end === position.start + `Цитата ${index}`.length ? { start: position.start, end: position.end } : null;
    const retained = seen.get(key);
    if (retained) {
      const preferred = preferredResponseAnnotationTarget(retained.target, target);
      if (preferred) retained.target = preferred;
      if (!retained.position && range) retained.position = range;
      continue;
    }
    const entry = { index, ...(target ? { target } : {}), ...(range ? { position: range } : {}) };
    seen.set(key, entry);
    normalized.push(entry);
    if (target) {
      const entries = addressed.get(index) ?? [];
      entries.push(entry);
      addressed.set(index, entries);
    }
  }
  // A projection of raw markup may accompany a saved address. Coalesce a
  // uniquely matching address without merging references to different batches.
  const replaced = new Set();
  for (const entry of normalized) {
    const candidates = !entry.target && addressed.get(entry.index);
    if (!candidates?.length) continue;
    const exact = entry.position && candidates.filter(candidate => candidate.position?.start === entry.position.start);
    const match = exact?.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
    if (match) {
      entry.target = match.target;
      entry.position ??= match.position;
      if (!entry.position) delete entry.position;
      replaced.add(match);
    }
  }
  return normalized.filter(entry => !replaced.has(entry));
}

export function codexAssistantResponseProjection(value, references = []) {
  const text = String(value ?? "");
  if (!text.includes(":codex") && !text.includes(":agent")) {
    return { text, responseAnnotationReferences: normalizedCodexResponseAnnotationReferences(references) };
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let fence = "";
  let inlineTicks = 0;
  const responseAnnotationReferences = [];
  const referencedIndices = new Set();
  const escapedAt = (value, offset) => {
    let slashes = 0;
    while (offset > 0 && value[--offset] === "\\") slashes++;
    return slashes % 2 === 1;
  };
  const inlinePlain = (segment, segmentOffset, outputOffset, listLine) => {
    const tail = Math.max(segment.lastIndexOf(":codex"), segment.lastIndexOf(":agent"));
    if (tail >= 0 && !escapedAt(segment, tail)) {
      const candidate = segment.slice(tail);
      if (!COMPLETE_MARKER.test(candidate)
        && (MARKER_PREFIXES.some((prefix) => prefix.startsWith(candidate)) || PARTIAL_MARKER.test(candidate))) segment = segment.slice(0, tail);
    }
    let difference = 0;
    return segment.replace(/:(?:agent|codex)-annotation\{index="([^"\r\n]*)"\}[ \t]*/gu, (marker, raw, offset) => {
      if (escapedAt(segment, offset)) return marker;
      const index = DECIMAL_INDEX.test(raw) ? Number(raw) : Number.NaN;
      const valid = Number.isSafeInteger(index) && index >= 1 && index <= MAX_CODEX_RESPONSE_ANNOTATION_INDEX;
      if (valid && referencedIndices.has(index)) { difference -= marker.length; return ""; }
      const before = !listLine && segmentOffset + offset > 0 ? newline : "";
      const after = offset + marker.length < segment.length ? (listLine ? " " : newline) : "";
      const label = valid ? `Цитата ${index}` : "Цитата";
      if (valid) {
        referencedIndices.add(index);
        const start = outputOffset + offset + difference + before.length;
        responseAnnotationReferences.push({ index, position: { start, end: start + label.length } });
      }
      const replacement = `${before}${label}${after}`;
      difference += replacement.length - marker.length;
      return replacement;
    });
  };
  const ticksByLength = new Map();
  for (const match of text.matchAll(/`+/gu)) {
    const positions = ticksByLength.get(match[0].length) ?? [];
    positions.push(match.index);
    ticksByLength.set(match[0].length, positions);
  }
  const hasClosingTicks = (start, length) => {
    const positions = ticksByLength.get(length) ?? [];
    let low = 0, high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] < start) low = middle + 1;
      else high = middle;
    }
    const end = positions[low];
    return end !== undefined && !/\r?\n[ \t]*\r?\n/u.test(text.slice(start, end));
  };
  const inlineProjection = (line, textOffset, outputOffset) => {
    const listPrefix = line.match(/^[ \t]*(?:[-+*]|\d+\.)[ \t]+/u)?.[0];
    let result = "", offset = 0;
    for (const match of line.matchAll(/`+/gu)) {
      const segment = line.slice(offset, match.index);
      result += inlineTicks ? segment : inlinePlain(segment, offset, outputOffset + result.length, Boolean(listPrefix));
      result += match[0];
      let slashes = 0;
      for (let index = match.index - 1; index >= 0 && line[index] === "\\"; index--) slashes++;
      const openingLength = match[0].length - slashes % 2;
      if (!inlineTicks && openingLength > 0
        && hasClosingTicks(textOffset + match.index + match[0].length, openingLength)) inlineTicks = openingLength;
      else if (inlineTicks === match[0].length) inlineTicks = 0;
      offset = match.index + match[0].length;
    }
    const projected = result + (inlineTicks ? line.slice(offset)
      : inlinePlain(line.slice(offset), offset, outputOffset + result.length, Boolean(listPrefix)));
    return listPrefix && projected === listPrefix && projected !== line ? "" : projected;
  };
  let nextLineOffset = 0;
  let outputOffset = 0;
  const projectLine = (line) => {
    const textOffset = nextLineOffset;
    nextLineOffset += line.length + (text[textOffset + line.length] === "\r" ? 2 : 1);
    const fenceMatch = inlineTicks ? null : FENCE_START.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence[0] && fenceMatch[1].length >= fence.length) fence = "";
      return line;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return line;
    }
    const complete = inlineTicks ? null : COMPLETE_MARKER.exec(line);
    if (complete) {
      const index = DECIMAL_INDEX.test(complete[2]) ? Number(complete[2]) : Number.NaN;
      const valid = Number.isSafeInteger(index) && index >= 1
        && index <= MAX_CODEX_RESPONSE_ANNOTATION_INDEX;
      if (valid && referencedIndices.has(index)) {
        return complete[3] ? `${complete[1]}${inlineProjection(complete[3], textOffset + line.length - complete[3].length, outputOffset + complete[1].length)}` : complete[1];
      }
      if (valid) referencedIndices.add(index);
      const label = valid ? `${complete[1]}Цитата ${index}` : `${complete[1]}Цитата`;
      if (valid) responseAnnotationReferences.push({ index, position: {
        start: outputOffset + complete[1].length, end: outputOffset + label.length,
      } });
      return complete[3] ? `${label}${newline}${complete[1]}${inlineProjection(complete[3], textOffset + line.length - complete[3].length, outputOffset + label.length + newline.length + complete[1].length)}` : label;
    }
    return inlineProjection(line, textOffset, outputOffset);
  };
  const visible = text.split(/\r?\n/u).map((line) => {
    const result = projectLine(line);
    outputOffset += result.length + newline.length;
    return result;
  }).join(newline);
  // Coordinates belong to this exact projected assistant text, normalized to LF
  // and trimmed at its boundary like the existing live/history consumers.
  const leading = visible.replace(/\r\n?/gu, "\n").length - visible.replace(/\r\n?/gu, "\n").trimStart().length;
  for (const reference of responseAnnotationReferences) {
    const start = visible.slice(0, reference.position.start).replace(/\r\n?/gu, "\n").length - leading;
    reference.position = { start, end: start + `Цитата ${reference.index}`.length };
  }
  return { text: visible, responseAnnotationReferences: normalizedCodexResponseAnnotationReferences([
    ...responseAnnotationReferences, ...(Array.isArray(references) ? references : []),
  ]) };
}

/**
 * Converts the agent response-annotation locator (including the legacy Codex alias) into a readable label
 * only at the trusted provider-assistant boundary. Callers must not apply this
 * to user-authored text. Markdown code fences and inline-code literals remain
 * untouched.
 */
export function visibleCodexAssistantText(value) {
  return codexAssistantResponseProjection(value).text;
}

// Read-surface presentation only. Keep the canonical reasoning and its source
// hashes intact; both live previews and addressed trace pages use this parser.
export function assistantTraceAnnotationPresentation(group) {
  const text = String(group?.reasoning ?? "");
  const { responseAnnotationTarget: _capture, ...projection } = bindResponseAnnotationTarget(
    codexAssistantResponseProjection(text), group?.responseAnnotationTarget);
  return projection.text === text && !projection.responseAnnotationReferences.length
    ? group
    : { ...group, responseAnnotationPresentation: projection };
}
