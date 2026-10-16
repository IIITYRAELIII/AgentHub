# ADR-0116: Preserve published checkout while recovering original Await

Status: proposed

## Problem

An ordinary native Await can remain UNKNOWN before promotion when a completed
prior candidate retains staged release notes already present in OWN publication.
It has neither a process-tree guard nor a native Test integration intent. The
existing reconciliation rejects that combination even when every old source byte
is published. Repeating Await, deleting notes or fabricating a guard loses the
original identity or evidence.

## Decision

Extend the existing reconciliation/lifecycle/preflight/release Git owners with a
bounded, original-bound migration. Require exact pending receipt/CAS and Task
state, one clean Test result, no process guard, completed native checkpoint/
manifest/journal, and exact old refs/index/physical notes. Independently pin and
recheck current origin/main without including it in source. Old source may
differ from durable OWN publication only in root CHANGELOG and package
version fields; all executable/dependency bytes must be published.

Persist an archive intent in native-preparation.json, then rename the entire old
standalone clone and checkpoint to an immutable evidence directory inside the
same managed root. Retain the original journal, manifest, raw index and notes in
hashed evidence. Recheck authority and physical pins before movement. A partial
move resumes only under the same original and proof. The archive is evidence,
not an authorized release checkout. Ordinary clone creation, native composition,
candidate promotion and Task CAS/rollback then continue the same Await and settle
the same receipt. A definite new-candidate failure cannot destroy the archive.
The original origin pin is rechecked by ordinary candidate validation after
awaited caller checks, on reuse/resume and by the lifecycle's final authority
callback before its SQLite mutation. Archive completion alone never authorizes
a later candidate promotion or Task CAS after origin drift.

No alternate writer, SQL repair, ref/index repair, reset, clean, live runtime
overlay, new public approval flag or selected-set expansion is introduced.
Current installed source migration and publication validation remain separate.

## Evidence and removal

Real Git tests cover the old dirty refusal, whole-clone/index/private preservation,
single-result composition, original/publication/selection/byte refusals and
interrupted archive continuation. A real SQLite test covers existing lifecycle/
CAS/receipt settlement, workflow/executor/reference/guard fences, failed candidate
preservation and terminal idempotence. This one-time compatibility path can be
removed once existing pending native Awaits without preparation intents finish.
Future generic dirty candidates remain rejected.
