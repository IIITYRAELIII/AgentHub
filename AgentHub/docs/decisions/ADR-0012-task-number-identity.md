# ADR-0012 — Task number is the human and branch identity

## Decision

Each Workspace may define `settings.taskPrefix`. The first mutation that places
an unnumbered Task in such a Workspace allocates one durable sequential number
for that prefix. Moving the Task later does not change the number. A manual edit
does not change the number; the Task card renders it as a compact read-only
identifier beside the title.

New managed Task branches use the exact Task number. The internal UUID remains
the database key, URI target, worktree owner and idempotency identity. Existing
legacy branches are accepted only as a migration guard and are renamed on the
next managed preparation.

Task links use the number as visible text, the UUID only in the
`agent-hub://task/...` target, and the current title as the tooltip.

## Consequences

- Humans refer to stable short identifiers without exposing UUIDs.
- Prefix sequences remain monotonic and assigned numbers stay stable.
- Workspace moves preserve Task identity.
- Branch names stay aligned with the number without making mutable branch refs
  the release authority; the immutable result commit remains authoritative.
