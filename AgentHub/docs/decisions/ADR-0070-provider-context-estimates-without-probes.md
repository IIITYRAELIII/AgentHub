# ADR-0070 — Provider context estimates without generated measurement turns

## Status

Accepted, 2026-09-17, by explicit user instruction. Supersedes the generated
measurement and post-rotation probe portions of ADR-0044.

## Context

A measurement prompt retained in the conversation was interpreted as a current
instruction after compaction, causing a working turn to end with the diagnostic
marker instead of a normal result. Isolating and hiding these generated turns
does not eliminate their effect on provider history.

Codex emits a preliminary context estimate at its compaction boundary. This
estimate differs from the usage of the next request, which can contain extra
instructions and messages. The user accepts that preliminary estimate for the
rotation threshold.

## Decision

- Do not generate any measurement turn, before or after rotation. Remove its
  prompt, instructions, IDs, retries, completion waiters, title repair, history
  classification and usage exclusion.
- The existing compaction owner stores the first finite preliminary estimate
  for its exact Thread and turn at or after the recorded compaction boundary.
  Persist its estimated provenance. Later ordinary request usage cannot replace
  this historical value. Missing or unrelated data stays unknown, never zero.
- Automatic rotation uses this estimate only after the working turn completes.
  A value strictly above the configured threshold requests rotation; equality
  does not. Missing evidence skips rotation without another model request.
- Rotation retains the exact compaction plus bounded post-compaction suffix.
  Create an unbound target, inject, and freshly read the same idle Thread before
  binding and retargeting. This checks provider state without generation; it is
  not a claim that an actual model response has already succeeded.
- Show approximate values as such. Do not fabricate an after-rotation percentage.
  Failed automatic rotation retains the source and a visible failure outcome.
- Retain stored history and usage. Existing unused SQLite columns need no live
  migration. Former marker text has no reserved or hidden meaning.

## Validation

Behavioral tests cover threshold equality, missing/zero/stale/wrong-turn data,
immutable estimates and snapshot restore, no generated target turn, failed
readiness and unchanged source binding, queue/client retargeting, ordinary
history/accounting, and UI estimate/failure presentation.

## Consequences

Autorotation follows the accepted estimate and can differ from a decision based
on the next actual request size. It no longer modifies the conversation merely
to measure it. A successful idle readback does not test model availability; any
later generation failure follows the normal run lifecycle.
