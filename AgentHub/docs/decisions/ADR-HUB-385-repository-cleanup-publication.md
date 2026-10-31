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

The user's cleanup consent applies only to proven obsolete technical artifacts.
Every real effect needs an exact independently reviewed preview and the same
artifact owner's fresh admission. Active generations, current/previous/running
runtime and source, Contour, original receipts, useful WIP and unknown copies
remain protected. Counts of bytes in a directory are not retirement evidence.

The installed owner may differ from this Task source. Any operational consumer
must bind a compatible reviewed current afterimage; source approval alone is not
installation, cleanup completion or publication.
