const DEFAULT_EAGER_DAY_COUNT = 5;

function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function extractWorkLogHtml(markdown) {
  const source = String(markdown ?? "");
  const firstDay = source.search(/<details\b[^>]*data-work-log-day-section/iu);
  if (firstDay >= 0) {
    const rateLimits = source.match(
      /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
    )?.[0] ?? "";
    return [rateLimits, source.slice(firstDay).trim()].filter(Boolean).join("\n");
  }
  const text = source
    .replace(/^\uFEFF/u, "")
    .replace(/^#\s+.*(?:\r?\n|$)/u, "")
    .trim();
  return text
    ? `<pre data-mini-app-fallback>${escapeHtmlText(text)}</pre>`
    : '<p data-mini-app-empty>Журнал пока пуст.</p>';
}

function balancedElementEnd(source, tagName, openingStart) {
  const token = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, "giu");
  token.lastIndex = openingStart;
  let depth = 0;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return token.lastIndex;
    } else {
      depth += 1;
    }
  }
  return -1;
}

function daySections(html) {
  const source = String(html ?? "");
  const opening = /<details\b[^>]*data-work-log-day-section[^>]*>/giu;
  const sections = [];
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const end = balancedElementEnd(source, "details", match.index);
    if (end < 0) continue;
    const section = source.slice(match.index, end);
    const summary = section.match(
      /<summary\b[^>]*data-work-log-day\b[^>]*>[\s\S]*?<\/summary>/iu,
    )?.[0] ?? "";
    const date = summary.match(/<strong>(\d{2}\.\d{2}\.\d{4})<\/strong>/iu)?.[1] ?? "";
    if (date) sections.push({ date, html: section, summary });
    opening.lastIndex = end;
  }
  return sections;
}

function dateValue(value) {
  const [day, month, year] = String(value).split(".").map(Number);
  return Date.UTC(year, month - 1, day);
}

function lazyDayShell({ date, summary }) {
  return `<details data-work-log-day-section data-lazy-day="${date}">`
    + summary
    + '<div data-lazy-day-content></div>'
    + "</details>";
}

function turnReferenceBefore(source, detailsStart) {
  const prefix = source.slice(Math.max(0, detailsStart - 1_200), detailsStart);
  const opening = [...prefix.matchAll(
    /<div\b[^>]*data-work-log-turn-entry\b[^>]*>/giu,
  )].at(-1)?.[0] ?? "";
  const attribute = (name) => opening.match(
    new RegExp(`\\b${name}="([^"]+)"`, "iu"),
  )?.[1] ?? "";
  const turnId = attribute("data-work-log-turn-id");
  if (!turnId) return "";
  const provider = attribute("data-work-log-turn-provider");
  const threadId = attribute("data-work-log-turn-thread-id");
  return provider && threadId
    ? Buffer.from(JSON.stringify([provider, threadId, turnId]), "utf8").toString("base64url")
    : turnId;
}

function shallowDaySection(section) {
  const source = String(section ?? "");
  const opening = /<details\b[^>]*data-work-log-turn-details[^>]*>/giu;
  const ranges = [];
  const turns = {};
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const end = balancedElementEnd(source, "details", match.index);
    if (end < 0) continue;
    const details = source.slice(match.index, end);
    const summary = details.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/iu)?.[0] ?? "";
    const expandedStart = details.search(/<div\b[^>]*data-work-log-turn-expanded[^>]*>/iu);
    const expandedEnd = expandedStart >= 0
      ? balancedElementEnd(details, "div", expandedStart)
      : -1;
    const turnRef = turnReferenceBefore(source, match.index);
    if (!summary || !turnRef || expandedEnd < 0) continue;
    turns[turnRef] = details.slice(expandedStart, expandedEnd);
    const detailsOpening = match[0].replace(
      /data-work-log-turn-details/iu,
      `data-work-log-turn-details data-lazy-turn-id="${turnRef}"`,
    );
    ranges.push({
      start: match.index,
      end,
      replacement: `${detailsOpening}${summary}<div data-lazy-turn-content></div></details>`,
    });
    opening.lastIndex = end;
  }
  if (!ranges.length) return { html: source, turns };
  const chunks = [];
  let offset = 0;
  for (const range of ranges) {
    chunks.push(source.slice(offset, range.start), range.replacement);
    offset = range.end;
  }
  chunks.push(source.slice(offset));
  return { html: chunks.join(""), turns };
}

/* Сводка лимитов лежит первым блоком журнала, но журнал грузится лениво и
   первая порция весит около мегабайта. Шапке нужен только этот блок, поэтому
   он достаётся отдельно и почти бесплатно. */
export function extractRateLimitsHtml(markdown) {
  const block = String(markdown ?? "").match(
    /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
  )?.[0] ?? "";
  const sampledAt = block.match(/data-sampled-at="([^"]*)"/iu)?.[1] ?? "";
  return { html: block, sampledAt };
}

export function buildLazyJournalPayload(markdown, {
  eagerDayCount = DEFAULT_EAGER_DAY_COUNT,
} = {}) {
  const fullHtml = extractWorkLogHtml(markdown);
  const sections = daySections(fullHtml);
  if (!sections.length) return { html: fullHtml, days: {}, turns: {} };

  const eagerDates = new Set(
    [...sections]
      .sort((left, right) => dateValue(right.date) - dateValue(left.date))
      .slice(0, Math.max(0, Number(eagerDayCount) || 0))
      .map((section) => section.date),
  );
  const rateLimits = fullHtml.match(
    /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu,
  )?.[0] ?? "";
  const initialSections = [];
  const days = {};
  const turns = {};
  for (const section of sections) {
    if (eagerDates.has(section.date)) {
      initialSections.push(section.html);
      continue;
    }
    const shallow = shallowDaySection(section.html);
    initialSections.push(lazyDayShell(section));
    days[section.date] = shallow.html;
    Object.assign(turns, shallow.turns);
  }
  return {
    html: [rateLimits, ...initialSections].filter(Boolean).join("\n"),
    days,
    turns,
  };
}
