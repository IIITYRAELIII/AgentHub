# ADR-0073: Exact Codex terminal and retired probe identity

Status: accepted for HUB-272. Date: 2026-09-29.

## Context

A Codex rollout can contain `task_started` with no user prompt and no terminal
while automatic compaction is still running or its connection is lost. After a
15-second display grace the promptless turn is omitted from active display.
That omission, an App Server `interrupted` projection and an old file timestamp
were each previously usable as completion/abort evidence. This could release
the original admission lane and persist an empty final without a provider
terminal. Separately, a retired context measurement generated its own provider
turn with a reserved `agent-hub-context-probe:<UUID>` `client_id`. Its exact old
turn could later be projected as a fresh user message from a newer observation
timestamp.

## Decision

Only the exact provider terminal lifecycle (`task_complete` or `turn_aborted`,
or the corresponding already durable exact terminal) may settle the Codex
turn. Promptless display filtering remains presentation-only. Observer and
restart recovery retain the original run and FIFO admission owner while its
terminal is unknown; they recheck the same turn and never redispatch it. A
later exact terminal follows the existing single completion/outbox owner.
When the exact terminal lies before the normal 16 MiB activity tail, recovery
uses a worker-side scan capped at 256 MiB for the requested turn, with bounded
per-process positive/negative cache and append-only continuation. A restart or
cache eviction can require another scan; normal polling of a retained entry does
not. Its exact final remains pinned against newer final-message eviction.
Beyond that cap the status remains unknown until another authoritative exact
terminal/audit route supplies evidence; the cap never licenses inferred abort.

A later exact rollout terminal may contradict an already persisted completion.
The canonical terminal commit owner then uses revision CAS and its projection
outbox to correct durable history and command status without redispatching the
input or creating another external notification. The prior Telegram intent is
superseded: an unsent intent is retired, while an uncertain external attempt
remains recorded as superseded-uncertain and may only accept a late receipt, not
another send. A queued file checks the exact latest terminal revision before
Telegram delivery and retires a superseded attempt after restart; an already
issued external effect cannot be recalled. The corrected terminal's projection
does not re-enter ordinary notification commit even if its notification flag is
still pending. Absence of a terminal is not
positive proof that an older committed terminal was inferred: such legacy
records remain unresolved until their source is established, rather than being
silently rewritten to success, abort or failure.

The one legacy compatibility exception is a provider-sourced generated probe
`client_id` matching the retired UUID format. Historical accounting retains
the original provider start/end time and marks that exact turn as measurement;
Desktop history omits it and clears only a saved last-message overlay for the
same turn. The prompt, response marker, text equality, elapsed time and a
different turn's client identity cannot classify or suppress content. Conflicting
user identities fail closed. Current context maintenance never creates a probe.

## Consequences and removal

An unconfirmed Codex turn may continue to occupy its queue lane until its
rollout yields terminal evidence or a supported owner resolves it. That is
preferable to inventing success or allowing a duplicate provider effect.
The legacy probe compatibility guard may be removed only after the retained
provider histories, terminal projections and last-message records have been
reprojected with authoritative identity and no old generated probe remains.
There is no recurring text scan or second lifecycle owner.
