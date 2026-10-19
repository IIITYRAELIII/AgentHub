# ADR-0125: Offline runtime storage relocation

Status: proposed for independent review; execution requires exact operator packet.

## Context

Hub storage contains independent Git clones/bundles, dependencies, retained
fixtures and migration snapshots in addition to task text. Repeated one-time
cleanup does not provide a bounded retention policy. The user authorized moving
all Hub-controlled payload to another volume before implementing retention.
Immutable source manifests and registered Git paths can retain the old root.
Runtime-command IPC identity also depends on the logical root string.

## Decision

Use one explicit operation through the runtime installer, with independently
reviewed helpers and root mappings. Permit live preparation of stable files;
copy the complete SQLite/WAL cohort only after an exact controlled writer stop.
Preserve all useful or unknown work. Verify destination bytes and critical SQLite
integrity before switching names. Existing paths may become zero-payload
compatibility junctions. The first Host can keep its logical old root only after
an actual-binary isolated alias probe proves environment and IPC compatibility
and final file handles prove physical destination storage.

Use the canonical terminal store and runtime active-run set in one read-only
snapshot for the arm barrier. Stop positively owned processes through retained
native handles with creation-time guards. This is not a graceful shutdown claim.
No new runtime daemon, queue owner, recovery ledger or automatic command replay
is introduced. Retain originals until ordinary tools/UI/receipt verification,
then delete only exact transferred originals with resumable per-entry receipts.

## Consequences and removal condition

Physical storage migration can complete without changing immutable release bytes
or waiting for all future retention work. Native logical-root migration remains
open until all launchers, IPC/spool clients, source verification and Git mappings
work with the new configured root. Remove old compatibility aliases only after
that cross-surface acceptance; elapsed time is not a removal criterion. Fresh
login temp discovery and future extension installer paths also require owning
changes. Retention is a subsequent scoped change under existing cleanup owners.

Preserved contracts: original operation identities and UNKNOWN remain unchanged;
queued input is not drained; no release membership, source refs, publication or
immutable manifest is rewritten. See [operational procedure](../runtime-storage-relocation.md).
