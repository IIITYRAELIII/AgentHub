# ADR-0044 — Readiness-gated rotation with a compaction-bounded transfer

## Status

Accepted for HUB-222. Supersedes the SYS-002 rule that rotation binds and names
the new Thread before its hidden context probe, and the accepted behaviour that
a failed post-rotation probe keeps the new Thread bound and retargets the queue.

## Context

Automatic rotation of Stream S2 (source `01a08236-77f3-7661-af1f-da0a39cdc3bb`,
target `01a0979c-ca96-70b1-8c4c-533513dddbd2`) produced a Thread that could not
answer. The compacted turn `01a095cf` held 4 973 response items (14 586 008
bytes). The last `compacted` record of that turn was written at
2026-09-12T21:44:38.697Z; 4 904 items (14 254 978 bytes) preceded it and were
already represented by its replacement history, and only 69 items (331 030
bytes) followed it. Rotation nevertheless injected the whole turn together with
the compaction. The catalog binding, selection and deferred-input retarget were
committed before readiness; both hidden probes were aborted, the measurement
failed at 21:54:16.870Z, the binding stayed, and six provider turns ended with
`context_window_exceeded`. Recovery required a manual clean Thread.

Separately, a rotation notice read «новый Thread 11% (источник 27%)» while the
new Thread already showed 27%. Both numbers were exact probes in one scale
(used / model window): source after compaction 70 487 / 258 400 and target
immediately after transfer 29 086 / 258 400. The target reached 27% later
through ordinary work. The notice presented historical probes as current state
and omitted the before-compaction value.

## Decision

1. Transfer boundary. Rotation injects the compaction item and only the ordered
   suffix of the compacted turn after the exact `compacted` record whose
   replacement history carries that item. Items before it are not transferred.
   An empty suffix is valid. An absent or non-unique boundary refuses the
   transfer before `thread/start`.
2. Readiness before switching. The new Thread is probed while unbound. Binding,
   selection, client selections, deferred inputs and the rotation annotation
   change only after a completed probe with an exact measurement, and the
   annotation records the probe turn identity and measurement time.
3. Failure handling. A definite failure deletes the new Thread: its probe turn
   ended unsuccessfully, or every accepted probe attempt that did not
   materialize was afterwards observed terminal in the Thread. A successful
   `turn/interrupt` response alone does not prove the turn stopped. An unknown
   outcome (an accepted probe could not be interrupted or its stop was not
   observed, the probe did not settle, remained active, or produced no exact
   measurement) stops without another attempt and leaves the new Thread
   untouched and records `rotationStatus: unknown` with the quarantined Thread
   on the source compaction record, the existing owner of rotation state. The
   source stays authoritative and its queue is woken. A compaction whose rotation
   settled as failed or unknown is not rotated again.
4. Naming. The unbound target is named from the source Thread's Workspace and
   Stream before its probe, without pinning; the `rebirth` binding after
   readiness owns the managed title.
5. Presentation. A rotation marker shows used context per named stage — before
   compaction, after compaction, immediately after transfer — only for exact
   values, states a missing target measurement as not saved, and never uses the
   Thread's current usage as a transfer measurement.

## Consequences

- A slow or failed readiness probe keeps the Stream on the source Thread; the
  user continues there instead of on a Thread that cannot answer.
- The quarantine record lives in the source compaction record held in runtime
  state. A later compaction of the same source replaces that record, as it
  already replaces the recorded rotation target; the quarantined Thread itself
  remains in the provider.
- Automatic rotation attempts are bounded to one per compaction, so a persistent
  readiness failure cannot create Threads in a loop.
- Replacement history user messages retained by the provider in the source are
  still not transferred. No data loss has been demonstrated for that boundary,
  so this decision does not change it.
