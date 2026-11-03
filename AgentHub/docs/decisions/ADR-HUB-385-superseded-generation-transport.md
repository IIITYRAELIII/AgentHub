# ADR-HUB-385: retire transport of an exact superseded generation

The current generation transport owner refuses older generations even after
that same original completes a successor. Actual read-only classification found
15 canonical predecessor generations on completed originals' supersedes chains,
retaining 5,960,454,425 logical bytes in source.bundle. This is measured input,
not deletion authority or reclaimed allocation.

Keep the existing release operation store and transport owner. Its reader first
validates the actual final generation using existing publication, validation,
finalization, target and identity proofs. It then follows strictly decreasing
canonical supersedes links to the requested generation, rehashing every complete
immutable generation and keeping the requested candidate/tree/manifest pins.
The explicit superseded retention proof records both old and completed identity.
It does not publish the predecessor, repair a journal or choose a latest source.

The same generation lease, whole original metadata/clone identity checks,
clean/unborrowed local Git, full advertised object roots and final fresh proof
still govern bundle retirement. Only redundant transport is eligible; complete
repositories, native subcaptures, useful WIP and durable evidence are untouched.
A missing/foreign/changed generation or chain, ambiguous/nonterminal original,
UNKNOWN validation/finalization, target drift, active lease or unanchored original
object refuses. Same maintenance children and partial/UNKNOWN recovery remain.
No new API, database, retention ledger, publication or runtime effect is added.
