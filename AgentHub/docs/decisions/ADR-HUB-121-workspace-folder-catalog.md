# ADR-HUB-121 — Checked Workspace folder catalog

## Status

Accepted implementation direction for HUB-121, retaining the full HUB-117
drag/drop acceptance. Final Design evidence and native Test are separate gates.

## Problem

Published 2.1.23 keeps empty folder names only in each browser and resolves
move/rename by name. Another client or restart can disagree; a stale drop can
address a renamed or same-name replacement folder. Deleting only local names
would neither atomically preserve all members nor prevent resurrection.

## Decision

WorkspaceCatalogStore remains the sole durable catalog owner. Its schema 16
migration assigns folder UUIDs, revisions and tombstones. Original membership
stays in Workspace settings; indexed member reads and SQL triggers fence stale
writers and update revisions. No new connection, global recovery worker or
membership store is added.

Remove binds a hash of exact identity/revision, childFolders=0 and complete
member IDs/names. All live and archived members move to root in the same
transaction as folder tombstoning and the exact terminal receipt. Existing
move/rename aliases now require identity/revision and request identity. A
Workspace's source ID is checked, and ordinary settings cannot change its
membership. Explicit stale commands reject, rather than fall back by name.

The existing authenticated control receipt owns transport admission. A narrow
domain receipt joins the SQLite effect transaction, so success/rejection can
be read after response loss and restart. Unknown effects never become a new
command or optimistic rollback. Browser recovery stores the original pointer
before dispatch, restores a persistent notice, and performs addressed reads
only. Failure to write the pre-dispatch pointer sends no command.

The shared Dialogs controller owns menu deletion, native desktop drag and the
keyboard/Mobile chooser. Native drag does not expand collapsed targets.
Dashboard consumes the canonical projection without mutation controls.

## Migration and consequences

One startup schema transaction normalizes retained membership and seeds IDs.
An explicit bounded legacy import preserves empty local folders, skips retired
names and acknowledges only a terminal receipt. Its removal condition is
documented in SYS-002. Old name-only mutation clients must reload; silent
compatibility resolution would reintroduce the stale-target defect.

Folder operations preserve Workspace/Stream/Thread/Task identity and data.
Deletion is catalog cleanup rather than Workspace deletion. Reusing a name
creates a new identity. Unrelated catalog navigation remains usable during an
uncertain result. Native installed VS Code and manual screen-reader certification
are outside the automated host-fixture evidence.
