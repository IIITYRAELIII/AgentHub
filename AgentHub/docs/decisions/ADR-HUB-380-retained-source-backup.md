# ADR-HUB-380: durable-state backup with retained source/WIP

The public updater previously recursed through the entire data tree only after
old cohort retirement. Managed WIP can legitimately contain dependency junctions;
its refusal could strand the stopped runtime before installation. The installer
does not mutate these source/data trees. A private one-time declared-scope recipe
is evidence for the boundary, not a product API or a process authority to import.

Keep the existing maintenance backup owner and native stopped-Job/root-gate
authority. Its one scope policy selects config, every top-level regular data file,
and these durable directories recursively: `.mini-app-control-result-outbox`,
`background-jobs`, `delivery-outbox`, `failed-updates`, `claude-runs`, `locks`,
`task-diff-indexes`, `task-custody`. In a 32-hex custody epoch, `repository` and
`retained-wip` are retained without descent; intent/snapshot and other metadata
remain selected. Retained root identity is not Git/history/custody acceptance.

All other direct ordinary data directories remain in place and appear in the
result with path, physical device/inode and an explicit not-backed-up reason.
The known source/payload namespace list only labels this evidence; it does not
silently admit arbitrary symlinks. Unclassified ordinary directories are retained
as `unclassified-not-backed-up`, not called copied, verified or recoverable from
the snapshot. A linked/special root or selected descendant fails. Links inside
retained trees are never followed, deleted or copied. This is neither full-data
backup nor arbitrary external-data-root support, recursive ACL sanitation or a
promise to restore source trees from SQLite.

The same read-only inventory detects unsupported selected state during public
modern/legacy intake and again before modern stopping, followed immediately by
the normal blocking-work check/stopping fence. No SQLite connection/reservation
is opened by preflight. The stopped owner inventories afresh, preserves physical
root/selected/retained identities and refuses drift, but does not claim an atomic
filesystem snapshot against arbitrary foreign races. All selected SQLite files
are recognized by header, all writer reservations are held simultaneously, and
backup API/integrity/regular-file hashes and reverse cleanup retain their owning
semantics. No WAL copy, restore, UNKNOWN replay, second installer or start follows.

The first update still executes the OLD installed continuation. Shipping this
only inside the incoming package cannot repair that transition. A separately
reviewed narrow current-source compatibility result and legitimate immutable
current-owner delivery are necessary operational inputs, not Task admission of
an aggregate context. Release and production execution remain with their owners.
The historical urllib metadata-body timeout is independent; no transport change
or full test suite is part of this correction.
