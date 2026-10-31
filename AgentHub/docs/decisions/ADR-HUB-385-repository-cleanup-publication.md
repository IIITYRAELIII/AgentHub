# ADR-HUB-385: Repository-bound cleanup publication evidence

## Context

The canonical publication record retains multiple repository entries. Task Git
cleanup used the top-level revision for every repository and required it to equal
the current origin/main. This falsely pins published technical transports after
repository separation or a later unrelated origin advance. A real two-repository
regression reproduces the refusal before this change.

## Decision

Reuse publicationStateRepositories and the existing cleanup preview. A matching
canonical repository entry supplies the durable published commit. Only legacy
records without repository entries retain the previous top-level representation.
Require the durable generation and prove that the observed origin/main equals
or descends from that published commit. Verify each exact result and current
branch/worktree against the durable commit, not the later origin tip.

This changes no artifact discovery, Task status, cleanup token, lease, process
guard, publication writer or deletion primitive. Existing confirmation and fresh
preview/CAS checks remain. Ignored and dirty work, later unpublished commits,
unknown custody, missing repository evidence and divergent origin stay pinned.
No recursive directory sweep or generic disk-cleaner authority is introduced.

## Operational boundary

The existing StorageRetentionService also accepts an explicit bounded list of
owner previews via runApproved. It reuses the same owner registry and durable
parent/children, checks the fresh preview before effect, and leaves background
discovery/cursors and unrelated pending originals alone. Automatic runOnce and
readiness/busy/isolation/stopping checks are unchanged. An existing admitted
UNKNOWN can only reconcile its exact original binding, never an altered approval.

The user's cleanup consent applies only to proven obsolete technical artifacts.
Every real effect needs an exact independently reviewed preview and the same
artifact owner's fresh admission. Active generations, current/previous/running
runtime and source, Contour, original receipts, useful WIP and unknown copies
remain protected. Counts of bytes in a directory are not retirement evidence.

The installed owner may differ from this Task source. Any operational consumer
must bind a compatible reviewed current afterimage; source approval alone is not
installation, cleanup completion or publication.

## Canonical intent contention

The actual foreground consumer twice reached SQLITE_BUSY while creating its
first maintenance child, before artifact admission/effect. The existing
zero-busy-timeout store cannot synchronously wait for another WAL writer.
The scheduler now awaits the existing AsyncSqliteMutationQueue only around
individual canonical SQL mutations. Child identity is allocated once before
that bounded queue; transition CAS and settlement keep the same original.
The queue never contains artifact preview, prune or reconciliation, so a SQL
retry cannot repeat filesystem work. Every write attempt checks the existing
lease, and actual ready/release/stop state is checked again after queued
admission before calling the artifact owner. A stopped or drifted admission
retains its existing pending original for ordinary owner reconciliation.

Real SQLite writer-reservation controls cover admission, settlement after one
effect, release drift and lost lease. The competing writer in the original
installation failures is not identified by these controls. No timeout increase,
SQL fence change, database owner replacement or live runtime restart is implied.
