# ADR-0015 — Test Contour refresh is a persisted operation

## Decision

Test Contour refresh and verification are serialized by an interprocess lease
owned by the contour root. Each refresh persists a monotonic operation with an
exact root, contour marker, port, `dev` head, release, owner and phase. Candidate
preparation keeps the previous runtime available; publication occurs only after
the candidate serves the same immutable identity and reports ready.

Readback names whether the requested operation is exact, refreshing, failed or
superseded. A newer operation may supersede an older completed operation, but it
cannot make the older caller validate the newer runtime. A dead owner is
recoverable: an already-ready exact candidate is finalized without restart;
otherwise the interrupted operation is recorded failed before the next refresh.

## Consequences

- Concurrent processes cannot stop or publish each other's candidate while
  either owns the contour lease.
- A port collision with another contour cannot produce false readiness.
- Same-source refreshes coalesce without an avoidable runtime interruption.
- Release preflight validates the exact operation and `dev` head it requested.
- The operation is maintenance evidence and never a user/provider turn.
