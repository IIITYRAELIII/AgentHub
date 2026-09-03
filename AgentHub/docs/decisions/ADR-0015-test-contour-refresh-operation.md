# ADR-0015 — Test Contour refresh is a persisted operation

## Decision

Test Contour refresh and verification are serialized by an interprocess lease
owned by the contour root. Each refresh persists a monotonic operation with an
exact root, contour marker, port, model, `dev` head, release, owner and phase. Candidate
preparation keeps the previous runtime available; publication occurs only after
the candidate serves the same immutable identity and reports ready. Readiness
uses identity emitted by the serving runtime itself, including a per-launch
nonce, operation, release, model, process PID and actual listening port, plus an
independent root-local process lock.

Readback names whether the requested operation is exact, refreshing, failed or
superseded. A newer operation may supersede an older completed operation, but it
cannot make the older caller validate the newer runtime. A dead owner is
recoverable: an already-ready exact candidate is finalized without restart;
otherwise the interrupted operation is recorded failed before the next refresh.

## Consequences

- Concurrent processes cannot stop or publish each other's candidate while
  either owns the contour lease.
- A port collision with another contour cannot produce false readiness, even if
  root-local lock metadata is stale or forged.
- Same-source refreshes coalesce only when the complete requested target matches;
  another port or model produces a new candidate.
- Release preflight always requests a fresh candidate and validates an exact-ready
  readback for the returned operation, target and `dev` head.
- The operation is maintenance evidence and never a user/provider turn.
