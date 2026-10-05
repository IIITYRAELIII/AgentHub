# ADR-0044 — Readiness-gated rotation with a compaction-bounded transfer

## Status

Accepted with the 2026-09-17 revision below. The original probe-based readiness,
measurement and title-repair mechanism is superseded and removed. The bounded
transfer and readiness-before-binding decisions remain in force. The incident
narrative below records the historical behaviour, not current requirements.

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
   A process-local index counts every matching boundary across the rollout and
   keeps its exact byte offset. Its first proof reads the full source once;
   subsequent checks of the same file generation read only appended complete
   JSONL records and a bounded tail, or the suffix from the recorded offset
   when that suffix exceeds the tail. A restart rebuilds the proof. Observed
   replacement, truncation, rewrite or incomplete final record invalidates it.
   Reuse relies on the [native Codex recorder's append-only write path](https://github.com/openai/codex/blob/a933dd77dbe101d7bd746ea3c7d1f8174eca4a05/codex-rs/rollout/src/recorder.rs), plus
   file generation, metadata and prefix/cursor anchors. These bounded checks
   do not prove the absence of an external interior rewrite that also forges
   those signals; that stronger guarantee requires a full prefix verification
   or an authoritative writer-owned index.
2. Readiness before switching. Create the unbound target, inject the exact
   transfer, then freshly read that same Thread and require `status.type=idle`.
   No model turn or synthetic user message is started. Only successful readiness
   allows catalog binding, selection, deferred-input retargeting and the rotation
   annotation.
3. Failure handling. A failed creation/injection/readiness path leaves the
   source authoritative and attempts cleanup of the unbound target. The existing
   maintenance owner releases admission and wakes the appropriate queue. Failed
   automatic rotation is not repeated for the same compaction.
4. Naming. The successful `rebirth` binding owns the managed title through the
   ordinary Workspace/Stream naming path. Measurement-specific title repair and
   historical instruction isolation are removed.
5. Presentation. Retain the first preliminary provider estimate for the same
   exact compaction and turn, with a finite timestamp at or after its boundary.
   Label it `estimated`; do not substitute later ordinary usage. Missing evidence
   remains unknown. Rotation generates no target measurement and does not treat
   current target usage as historical after-transfer usage.

## Consequences

- Context maintenance performs no synthetic generation, classification,
  suppression or terminal reclassification of measurement turns.
- Existing history and measured usage remain intact without a live migration.
  Old measurement-shaped text has no special runtime meaning.
- Automatic rotation remains bounded to one attempt per compaction. A readiness
  failure keeps selection on the source; missing context usage does not require
  another model call.

- Replacement history user messages retained by the provider in the source are
  still not transferred. No data loss has been demonstrated for that boundary,
  so this decision does not change it.
