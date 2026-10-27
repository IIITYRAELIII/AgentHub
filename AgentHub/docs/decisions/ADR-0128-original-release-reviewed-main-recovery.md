# ADR-0128 — Recover the original release after stale main approval

Status: proposed; exact independent source review pending.

The durable operation can fail at compose when its immutable original main
approval predates an already reviewed local migration. Ordinary continuation
correctly refuses terminals, but provided no supported way to recover this
specific original without inventing another release or rewriting authorization.

The existing RM-only `hub_release_continue` accepts an optional `reviewed_main`
envelope with exact `expectedRevision` and repository-scoped local/origin pins.
This is not an approval flag: the existing preflight owner verifies each pin,
current selected Task evidence and sealed prepared source under its Await lock.
It repeats that verification after awaited original publication readback.

Only an unowned failed compose with the concrete stale-main diagnostic is
eligible. The original next-generation failed compose receipt must match; no
immutable next generation may exist. Every original publication receipt must be
terminal failed/not-applied, and its current publication owner must independently
prove not-applied. Unknown, partial, applied, live and source-owned originals
refuse without changing state. A changed revision refuses without scheduling.

Where origin has advanced to the exact separately reviewed pin, a historical
pre-effect failure is sufficient only with the existing strict publication stage
contract/checkpoint verifier, exact exited original runner, and actual Git proof
that the old candidate is absent from complete current-origin ancestry. Retired
candidate checkouts need not be recreated. Ancestry is bounded to 100000 commits,
requires complete parent closure, disables replacements and refuses shallow or
grafted history. Missing current-history objects, checkpoint ambiguity or reached
effects retain UNKNOWN. No fetch, refs or shared configuration are written.

The same store transaction appends `operation.reviewed-main-rebound` and a hashed
`reviewedMain` record, preserving original authorization/request, prior terminal
failure, generations and receipts. Generic terminal continuation remains closed.
New compose input and source fingerprint bind the separate record; the next
generation uses verified current approvals and the same original selected set.
The failed compose receipt remains immutable; its subsequent attempt is appended.

No composition, tests, build, publication or installation runs during rebinding.
The existing worker is scheduled only after durable commit. All ordinary lease,
source, selection, validation and publication reservation guards remain required.
This recovery does not credit old tests as current or replay an old prompt.

The minimal already independently reviewed runtime-publication bridge from
`b3a3ee95ddb751a218f4cfb397744d2bb49042b9` is carried as a dependency: freeze pins
the next runtime version, the canonical allocator refuses mismatch under its
existing installation lease, and the original artifact checkpoint reuses the
exact PREPARED body before another allocation. Five production leaves carry
only that accepted delta; unrelated source/config migration is excluded. This
does not select the packaging Task into the original product or replace its
selected source/export identity. Actual package/assets publication remains with
the existing authorized owner and its separate immutable checkpoint.

Verification: focused original SQLite/service recovery, real Git publication
readback, preflight drift and authenticated MCP continuation behavioral tests.
