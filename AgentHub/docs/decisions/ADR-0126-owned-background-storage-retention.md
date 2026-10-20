# ADR-0126: Versioned cleanup through artifact owners

Status: proposed; source review and normal delivery remain required.

## Context

The user requires old Hub copies to be removed and their accumulation prevented
for every updated installation. Task text is not the dominant payload: native
Git transports/clones, dependency trees, unfinished work and migration artifacts
have distinct owners. Age, a directory name, and clean Git status do not prove
that a directory is disposable. In particular native worktree removal can erase
ignored WIP without requiring force.

## Decision

Schedule versioned storage maintenance from normal installed runtime timers after
readiness, on every start (including the first explicit start after an update),
then every six hours. Installation itself does not start/restart the Hub. Dev,
Test Contour, recording and acceptance-isolation runtimes construct no production
cleanup owner. Active user work defers background admission.

Reuse maintenance_operations for bounded cursors and original artifact intents;
do not introduce a daemon, an external automation, a second cleanup ledger or a
user turn. The runtime-scoped storage operation is not a dispatch reservation or
a restart marker. Each owner supplies discovery, preview, guarded effect and
reconciliation. Persist the discoverable child intent before admitting an effect.
An ambiguous outcome remains attached to that SAME child; one such resource does
not starve every other owner. Stop new admission on shutdown and drain the actual
in-flight owner before closing stores/releasing the instance lock. A failed drain
does not grant replacement admission.

Policy v1 retires only redundant task-native-merge source.bundle transports from
completed, durably published Tasks. The Task Git owner supplies its existing
lease/process guard and fresh publication preview. Preserve the independent full
repository, its refs/objects, merge.json, resolution evidence, Task history and
all worktrees. Save advertised bundle heads in the existing maintenance intent.
Verify all advertised object roots are connected in the independent repository;
reject alternates, shallow captures, dirty work, incomplete merges and drift.

Delete the exact single-link transport using a retained Windows handle, with
physical ancestors held without delete sharing, no reparse traversal, no named
streams, exact volume/index/size and SHA-256. Resolve configured compatibility
aliases before that boundary. Unsupported platforms defer; there is no pathname
unlink fallback. Recheck link count after hashing; this remains last-observed
admission, not an atomic link-count/delete CAS.

New native merges pack only selected base/result ancestry through private refs
in a fresh bare pool. They no longer include all unrelated source refs. The pool
temporarily borrows objects; the resulting bundle and consuming clone are full
and independent. Source refs/configuration are not copied or modified.

## Boundaries and remaining work

Each pass admits at most three units and checks a 20-second cooperative budget
between units. It does not abandon an active filesystem effect at a timeout or
claim the whole pass has a hard 20-second deadline. Metadata, head lists and file
size have separate bounds. Logical bytes are separate from observed filesystem
free-space deltas; concurrent writers make the latter observations, not exact
per-operation allocation attribution.

This first policy does not automatically delete legacy migration archives,
unpublished/unknown integration captures, release repositories/generations,
current/running/rollback/prepared runtime versions, attachments, receipts, audit
evidence or dependency/WIP directories. They retain their existing owners and
must receive separate eligibility/effect adapters before the policy expands.
Task cleanup now explicitly refuses ignored local data, including reproducible
dependencies until their own owner proves retirement; --force is not that proof.

Unknown admitted transports that remain present are retained for authoritative
owner reconciliation. An absence observed with the same capture/publication
binding reconciles the original intent; no second delete is submitted. This is
safe crash handling, not a claim that every retained legacy artifact is already
reclaimable. Physical relocation/C-original pruning is a separate accepted
operation and cannot be credited to this source-only policy.
