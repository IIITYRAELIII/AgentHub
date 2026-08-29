# ADR-0008 — Exact-turn file attribution

## Status

Accepted. Refines the terminal evidence derivation in ADR-0005 and ADR-0007.

## Decision

Exact provider file-mutation receipts define the file scope owned by a bound
provider turn. Git remains authoritative for the baseline tree, terminal file
content, operation, blobs and patch evidence, but it evaluates only the paths
named by those receipts. The terminal result is a synthetic Git tree created by
applying the owned paths from the current worktree to the exact claim-time tree.

The shared project root and its dirty repositories are not an ownership source.
If a terminal turn has no exact file-mutation receipts, it appends no new Task
evidence. A later no-diff continuation may still freeze evidence already owned
and recorded by the Task.

## Consequences

Parallel Streams, nested repositories and separate Git worktrees cannot enter a
Task manifest merely because they changed after its claim baseline. Multiple
repositories remain supported when the exact turn reports files in each one.
Providers that cannot emit exact mutation receipts need a native receipt source
before their file-changing turns can produce releasable Task evidence; broad
workspace diff discovery is not a compatibility fallback.
