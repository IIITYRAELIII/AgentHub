# Agent Hub repository guidance

## Architecture and reliability

- Fix lifecycle, delivery, queue, persistence, and ownership defects at the
  boundary that owns the violated invariant. Do not hide backend inconsistency
  in the UI, introduce a second state owner, or add another reconciliation path
  around the canonical one.
- Define the authoritative identity and state transition before editing code.
  Persist an intake receipt or terminal identity before releasing admission or
  performing an externally visible side effect; slow bookkeeping must not keep
  an otherwise completed turn active.
- Retries and reconnects must reuse the original idempotency identity. Never
  generate a fresh command or message identity for the same submission, and
  never deduplicate messages by text, timestamp proximity, or display order.
- Treat timeouts as operation bounds, not evidence of rejection, acceptance, or
  terminal state. An ambiguous result remains explicitly unknown until it is
  reconciled against an authoritative receipt or provider state.
- Optimistic UI state is a projection only. Durable receipts, queue records,
  provider lifecycle events, and persisted history are authoritative; rejected
  or unconfirmed input must not be sent later without an explicit user action.
- Queue and lifecycle mutations must be idempotent, independently addressable,
  and serialized only by their real invariant scope. Do not use a global lane,
  lock, or restart as a substitute for correct task-level ownership.
- Compatibility fallbacks require a documented migration boundary, explicit
  removal condition, and behavioral coverage. Permanent fallback chains,
  duplicated source-of-truth logic, arbitrary sleeps, and retry loops that only
  make a race less likely are not acceptable fixes.
- Before accepting a reliability or performance fix, reproduce the failure at
  the owning contract, state the broken invariant and root cause, add focused
  behavioral regression coverage, and verify the affected cross-surface path.
  Measure latency on the real critical path; do not trade correctness for a
  faster-looking UI.

## Testing

- Do not add or extend tests that read production source files and assert literal
  implementation text, formatting, CSS declarations, or regular-expression
  snapshots. Existing source-text assertions are legacy coverage, not a pattern
  for new tests.
- Test observable behavior through pure unit tests, public contracts, DOM-level
  tests, or integration/end-to-end tests. Extract a focused testable unit when
  behavior is otherwise trapped inside a large client file.
- A source-text assertion is allowed only for a static packaging or build
  invariant that cannot be exercised through an executable contract. Keep that
  exception narrow and document why a behavioral test is unavailable.
- If the current test harness cannot cover a UI change behaviorally, report the
  coverage gap instead of adding an implementation snapshot.
