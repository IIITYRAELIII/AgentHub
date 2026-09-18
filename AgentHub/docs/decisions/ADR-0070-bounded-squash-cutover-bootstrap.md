# ADR-0070 — Bounded squash cutover bootstrap

## Status

Accepted.

## Context

The ordinary exact squash owner deliberately requires two Tasks in Test. A
reviewed clean replacement can nevertheless be needed while the survivor is in
Progress but still retains its prior accepted Test result, before the newer
owner is installed. Pretending that survivor is already Test would bypass the
state owner; direct SQLite or ref edits would bypass receipts, locks and
reconciliation.

## Decision

Extend only the existing local one-shot cutover entrypoint. It admits an exact
Progress survivor plus Test source, reuses the ordinary squash proof and all
canonical Task, repository and Await locks, and binds a second immutable proof
covering the pinned reviewed checkout, artifact hashes, main/dev identity and
preserved survivor tree. Preview and execution keep distinct MCP request IDs.

The Git owner preserves the current tracked and ordinary untracked survivor
tree before staging the reviewed result. Unknown late bytes are never cleaned.
The existing lifecycle outcome is the sole durable record and changes both Task
states only after exact Git readback. Existing unknown-operation reconciliation
resumes the same proof at its recognized Git cutpoints. The public Test-to-Test
squash contract is unchanged, and subsequent Await/candidate acceptance remains
mandatory.

## Consequences

Bootstrap is narrowly usable for a pinned reviewed result without introducing
a general manual-proof API or second registry. More identities must be supplied
and retained in the original receipt, and any mismatch fails closed. The local
entrypoint can be retired when supported installations no longer need this
admission bridge.
