# Explicit recovery of legacy subagent authors

## Status

Accepted, 2026-09-09.

## Context

The corrected history adapter and exact source-occurrence merge cannot repair
old records once the source notification leaves the 16 MiB activity tail. Raising
the live tail globally would add latency and still leave an arbitrary boundary.

## Decision

Provide an explicit `task-history` maintenance option, `repairSubagentTurnIds`,
for at most 20 completed turns. The existing provider worker locates their exact
turn-start boundaries and reads bounded records, retaining only requested source
occurrences. Byte-coordinate identity and the original session generation must
match; text and provider item IDs are not recovery evidence. Client-bound or
ambiguous records remain unchanged. The existing history controller persists the
result and the existing merge guard prevents stale caches from restoring it.

Startup terminal-ledger recovery can already have removed misclassified users.
Consequently explicit recovery also reconstructs missing subagent reports from
source-native notifications in the requested exact completed turn, rather than
requiring a surviving bad row. Partial final-answer refreshes retain those
independent reports. Client projection must not merge distinct command IDs through
an absent provider item ID after terminal-ledger recovery.

## Consequences

Normal startup, polling and live refresh retain their current bounds. Explicit
repair can read more than 16 MiB but does not load the transcript into memory,
does not dispatch messages and does not modify active turns. Missing or rewritten
evidence remains unrepaired. Remove the option and this exception when all
retained pre-fix histories have been reprojected or expired.
