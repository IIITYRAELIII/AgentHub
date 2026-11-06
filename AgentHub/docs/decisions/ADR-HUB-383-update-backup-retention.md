# ADR-HUB-383 — Five confirmed update backups

Status: user-authorized implementation, subject to independent source review and
ordinary Task delivery. Contracts: RST-001, PERF-001.

## Decision

Use the existing StorageRetentionService and maintenance originals. The package
continuation seals its freshly produced copied-database companion files before
checkpointing packageBackup. This adds ownership evidence, not another updater,
registry, timer or recovery path. Older original inventories remain byte-exact;
extra unbound files refuse automatic retirement.

The new runtime-update-backup owner discovers originals through a read-only,
paged maintenance-store query. It keeps the newest eligible originals by createdAt
then operationId, after reserving slots for every protected recovery copy. Only
successfully settled package updates can be deleted. A whole exact inventory,
plain physical ancestry and native final-handle identity are required.

Each existing retention child persists proof and intent before an entry effect.
The scheduler refreshes that child's CAS after checking immutable admission fields.
A lost reply never resubmits that entry; authoritative absence can advance the same
cursor, while an existing entry stays UNKNOWN. Root deletion is last. Confirmed
completion remains a tombstone in the original child, not a rewritten update row.

Policy v4 prioritizes backup convergence before transport cleanup without dropping
older pending originals. Discovery and health distinguish retained/unverified
copies from deleted ones; the maximum is not asserted while protection or an
error prevents it. More than one bounded batch may be required.

## Scope and migration

No scan/adoption of historical offline or orphan scratch directories; no cleanup
of Git/WIP, runtime releases, packages, audits or live data. The separate current
runtime compatibility result preserves all unrelated current fixes and is not a
Task admission. A running older owner needs ordinary delivery of the reviewed
delta before it can enforce this policy. No source/version/CHANGELOG release
metadata or runtime cutover is performed by this Task.

## Evidence

Focused real Windows filesystem controls exercise six originals across distinct
scratch roots to five, repeated observation, active/UNKNOWN retention, extra and
linked entries, ancestor replacement, lost native reply and no retry of an
unconfirmed deletion. A parent composition contrast must fail the same cap
assertion. Registry migration preserves the exact admitted older pending child.
Private fixture outcomes are not production deletion or a whole-disk limit.
