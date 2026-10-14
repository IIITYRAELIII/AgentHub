# ADR-0045 — Fail-fast startup and replacement wait

## Status

Accepted for HUB-224. Refines RST-001 replacement readiness, startup failure and
restart UI rules.

## Context

On 2026-09-13 a Test Contour restart replaced runtime PID 32820. The replacement
PID 33944 took the instance lock at 19:30:31Z and failed at 19:30:40.749Z with
«Target project differs from canonical Thread binding». Its bootstrap only set
`process.exitCode`; the partially created instance pipe, SQLite and timers kept
the process alive with a lock marked `ready: false`. The previous runtime waited
for readiness of that lock owner and would only give up after the 120 s
readiness timeout, while every client showed «Ожидание нового процесса /
Соединение временно недоступно» without knowing the replacement had already
failed. A later contour refresh (release `20260913193144-3366c008`, PID 35516)
failed the same way at 19:32:04Z.

The stack of both failures ended in the `ClientTaskSelectionService` constructor:
the persisted global selection (Stream `71a12aa8`, codex Thread `01a060ac`,
project `D:\VSC_Tyrael`) was a containing-project reference, while the recording
contour's canonical binding names that Thread's cwd `D:\VSC_Tyrael\Utilities`.
The mapping guard correctly refuses such a reference execution authority.

Production restart history showed the other half of the problem: HTTP of a new
process returned 10–11 s after its lock, and readiness followed 23–89 s later,
while the minutes between a restart request and cutover were spent by a still
serving previous process.

## Decision

1. A startup failure is fatal for its process. Bootstrap uses the fatal process
   handler with an explicit exit after best-effort shutdown, so a half-started
   process cannot keep holding its instance lock.
2. The replacement wait follows the exact replacement identity captured at lock
   ownership (PID and instance token). When that process is gone before
   readiness, the wait ends immediately, its lock is released and recovery of the
   previous runtime proceeds. A lock owned by a different or stale process does
   not end the wait; the readiness timeout still bounds a live, unready owner.
3. The canonical mapping owner marks the containing-project mismatch with the
   explicit code `CONTOUR_TARGET_PROJECT_MISMATCH`. The startup selection owner
   handles only that code: it clears the selected Thread of the active provider
   and logs a warning. The project, canonical binding, history, queues and
   per-client selections are unchanged; the Thread is selected again through
   the normal binding path. Every other mapping or startup error stays fatal.
4. The restart UI shows only confirmed facts: time measured from the start of
   the wait, «previous process still answers» only after a successful health
   response, and — after a failed restart — the persisted failure reason once per
   operation while it is recent and no later restart has succeeded.

## Consequences

- A failed replacement costs the time of its own failed startup instead of the
  full readiness timeout, and clients learn the reason after the previous runtime
  recovers.
- A stored recording-contour selection that the canonical binding rejects no
  longer blocks the contour; the user reselects the Thread once.
- The guard that denies containing projects execution authority is unchanged.
- Regressions cover a fatal startup with an open handle in a real child process,
  immediate detection of the captured replacement's exit, a stale foreign lock
  owner, the containing-root selection case and the restart failure projection.
