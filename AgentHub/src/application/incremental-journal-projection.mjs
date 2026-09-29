import { projectWorkLogUsage, projectWorkLogAccountUsage, normalizedLedger } from './work-log-usage-projection.mjs';
import { buildLazyJournalPayload, extractRateLimitsHtml, extractAccountPanelHtml } from './journal-projection-data.mjs';
import { virtualJournalDaySections } from '../domain/journal-virtual-projection.mjs';

// Only day fragments are incremental. The existing account owner still computes
// its rolling windows from scalar inputs; no second pricing/attribution owner.
export function accountingRecord(record, defaultProjectRoot) {
  const key = `${record.provider}\0${record.threadId}\0${record.turnId}`;
  const normalized = normalizedLedger({ version: 9, turns: { [key]: record } }, { defaultProjectRoot }).ledger.turns[key];
  if (!normalized) return null;
  // Normalize BEFORE dropping content: legacy empty compaction filtering and
  // image estimates inspect prompt/body/tool evidence. Never normalize this
  // compact projection again as if it were an original ledger record.
  const { body, prompt, diff, changedFiles, skillsUsed, mcpCalls, ...scalar } = normalized;
  return scalar;
}

export function incrementalJournalProjection(currentHtml, turns, accounting, dirtyDates, options) {
  const dates = new Set(dirtyDates);
  const rendered = projectWorkLogUsage('# Глобальный журнал работ\n', turns, {
    ...options, includeAccountPanel: false,
  });
  const changed = buildLazyJournalPayload(rendered);
  const sections = new Map(virtualJournalDaySections(currentHtml)
    .filter(section => !dates.has(section.date)).map(section => [section.date, section.html]));
  for (const section of virtualJournalDaySections(changed.html)) sections.set(section.date, section.html);
  const dateTime = value => {
    const [day, month, year] = value.split('.').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const account = extractAccountPanelHtml(projectWorkLogAccountUsage('', accounting, { ...options, normalized: true })).html;
  return {
    ...changed,
    html: [extractRateLimitsHtml(currentHtml).html, account,
      ...[...sections].sort(([a], [b]) => dateTime(b) - dateTime(a)).map(([, html]) => html),
    ].filter(Boolean).join('\n'),
    virtualDates: [...dates],
    virtualComplete: false,
  };
}
