# ADR-0112 — Exact final revision owns read identity

Status: proposed for independent review

## Context

The read cursor and browser receipt mirror ordered timestamps before revisions.
A repeated ACK of the same turn/revision was already idempotent and refused to
rewrite its stored time. If another projection enriched that final's completion
time, the cursor could therefore report it unread indefinitely. Clock movement
could also hide an unseen higher revision or allow a lower revision to replace
it. This is a reproduced store/service failure, not proof of the historical
browser state in the user's screenshots.

## Decision

Keep the existing per-account/provider/Thread durable cursor. For the same exact
turn, positive terminal revision precedes its completion timestamp. Equal
revision is read regardless of timestamp enrichment; higher revision is unread
until explicitly acknowledged, and lower revisions cannot replace higher reads.
The browser's existing receipt mirror uses the same order. Different turns retain
the existing completion-time ordering and exact equal-time turn tie-break.
This is not a new chronology protocol for arbitrarily skewed different turns.

The server's exact-current-final admission, account boundary and asynchronous
SQLite mutation owner are unchanged. Actual visible/canonical-history and
navigation guards stay with the existing client owner; snapshots alone do not
authorize a read. No polling, second state owner, content telemetry, schema/data
migration or provider effect is added.

## Delivery and failure semantics

The Task's agreed legacy base predates the installed read-marker helper. Its
small existing helper is carried as a new path so the affected correction is
versioned without transplanting the newer hub-client/app/index implementation.
On the actual installed/local source composition this is a narrow modification
of that already-owned helper; native add/add resolution must retain the reviewed
existing protocol and only change receipt ordering. The Task base is not silently
rewritten and rolling dev is not merged into the Task.

No stored read rows or historical terminal IDs/times are rewritten. Exact retry
remains idempotent; reopening SQLite preserves the read revision. A failed write
does not confirm a read. Rolling back code preserves the rows but can restore
the old timestamp-comparison symptom. Tests exercise production persistence and
service, real rendered markers and client/server ordering parity. Installed-after
acceptance remains a separate release step.
