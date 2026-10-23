# ADR-0132 — Normal release continuation belongs to the existing owner

## Decision

`hub_release_run` owns preparation, validation, publication and finalization.
An agent does not construct an entry/driver/config package for each transition.
The existing operation, candidate checkpoint, Git sequencer and authenticated
review receipts remain the authorities. There is no new release coordinator.

The normal source consumer is `node release.mjs run|continue|get` with the
initiating provider/thread/stream and a JSON file of the same public business
arguments. Both it and Hub startup construct the existing ReleaseOperation graph
through one shared composition function. The local default runtime retains the
preparation authority/original readports and does not start the full Hub or use
the running desktop transport. The public authenticated continuation forwards
`reviewed_main` before terminal refusal for the existing stale-main recovery;
there is no raw-state repair, alternate publisher or per-attempt operator package.

Before release-side changes the owner checks the selected plan, publication and
the supplied exact main/origin approval. It then synchronizes accepted local
main into managed dev through its existing guarded Git owner. This is enabled
for release integration only; ordinary Task integration cannot adopt a divergent
main implicitly. The primary HEAD/index/worktree is never a composition target.
A conflict retains the existing owner refusal and restored dev evidence.

When a normal operation has no matching prepared candidate, the same candidate
owner prepares it before capturing its immutable generation. A frozen generation
reopens its own checkpoint and never replays preparation. Existing candidate
bindings, dirty-byte protection and source/selection validation remain required.

An approved repository may carry `nativeResolutionReview` as either the existing
single authenticated review or `{bundlePath,bundleSha256,reviews}`. The latter
is a bounded transport of already reviewed Git objects. Before import the owner
authenticates every review against the exact selected identity. Before checkout
it recomputes ordered parents, automatic tree, complete resolved tree and diff.
The existing sequencer records its intent before applying each accepted commit,
and reopens Git after a lost response. One ordinary call can consume all accepted
prefixes. Unreviewed conflicts remain in the issued owned checkout; existing
manual conflict resolution remains available. No private journal is adopted.

Definite preparation refusals leave terminal failed step receipts and a waiting
release operation. Normal `hub_release_continue` repeats only that refused
stage, preserving authorization and completed stages. Explicit unknown candidate
or acceptance effects retain unknown receipts without an automatic resume state.
External publication still requires its existing authoritative readback.

Legacy preparation1af1 is a one-time migration through ADR-0131 isolation, not a
prerequisite for future releases. Its original UNKNOWN is retained. Accepted
mechanism/source evidence and native resolution reviews are not repeated merely
because an agent turn changed. Changed code still receives affected review;
fresh guards execute inside the owning code before effects.

After the initial isolated transfer, ordinary `hub_release_prepare_resume`
regenerates the same leased isolation plan and reuses its stored custody. It
accepts reviewed native resolution input without repeating the initial observer.
The existing local consumer's `--resume-preparation` mode calls that same public
method with the original ID/hash/revision. Initial UNKNOWN without transferred
isolation still refuses; this is not generic replay or claim-custody recovery.


## Internal release data and definite compose recovery

Correct internal preparation envelopes, source inventories, parsed owner journals,
review bundles, selected histories and exact receipts are not rejected by an
arbitrary size, record-count or Git execution deadline. File evidence is hashed
in chunks; native bundles are copied privately and reverified before import.
Complete remote ancestry is streamed and must still be closed and exact.
Lease loss/abort, operation identity, format, hash, membership, CAS and no-overwrite
checks remain mandatory. Event-delivery batch sizes only yield/reschedule work;
they do not reject or truncate release evidence. External wire/projection and
closed historical migration bounds are not changed by this ordinary path.

A terminal failed compose with its exact failed step receipt may use the existing
reviewed_main continuation after the cause is fixed, not only a stale-main error.
The same original still requires fresh authority/selection/candidate checks,
unchanged authorization, no next immutable generation and authoritative terminal
not-applied publication receipts/readbacks. Unknown/partial effects remain
ineligible. No receipt is rewritten and no new recovery owner is introduced.

Runtime allocation validates every available declared Android metadata body.
Multiple retained manifests may reference one identical SHA-256/size content;
that content needs at least one verified physical copy. A missing duplicate is
not required for allocation, while tampered bytes or missing unique content refuse.
This does not restore a missing file or certify completeness/installation of any
retained runtime body. No runtime files, pointers or manifests are changed.
