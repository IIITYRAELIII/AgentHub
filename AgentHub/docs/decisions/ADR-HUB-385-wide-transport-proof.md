# ADR-HUB-385: Complete wide transport-head proof

## Cause and existing boundary

The earlier operational cleanup removed only 21 verified redundant bundles.
The existing transport owners deliberately retain repositories, WIP, dependencies,
original journals and release evidence. Separate publication and metadata-budget
guards retained other bundles. A current completed capture has 534 advertised
roots and 56,478 bytes of canonical head JSON: its 579 MB redundant bundle is
refused solely because the complete list exceeds 32 KiB. Deleting arbitrary
repository files would not resolve this owner boundary safely.

## Decision

Keep small legacy array bindings unchanged. For larger complete valid lists,
encode the exact canonical JSON with gzip-json-v1, retaining count and SHA-256
inside the SAME maintenance child. Keep the original 4096-head and 32 KiB encoded
budget; bound decoded data at 4 MiB. Reject malformed, ambiguous, changed or
over-budget encodings. Fresh preview recomputes the entire original list; binding
equality, streamed bundle hash, publication, Task/release revision, native journal,
leases and sealed deletion are unchanged. No second registry or keeper refs.

Generation retention uses its existing original commit/tag anchoring check,
extracted without changing its semantics. Newly admitted wide native lists also
require original roots anchored in the retained full clone across future Git GC;
ambient/partial/borrowed/rewritten histories refuse. Small legacy native bindings
retain their prior object-kind compatibility. No Git GC, bundle rewrite, ref
mutation, repository retirement or WIP waiver is performed by this change.

## Verification and operational authority

Real Git/SQLite/Windows owner cases cover the old budget refusal, complete
compressed child proof, same-original lost-reply recovery, exact bundle deletion
and repository/ref/journal preservation. Unanchored roots and malformed proofs
remain refusals. Release-generation tests preserve annotated-tag and stale-proof
controls. Current operational afterimages must preserve every unrelated runtime
file, including caption and existing corrections; source approval is not install.
Each real foreground batch still needs an exact independently reviewed preview
and fresh same-owner guards. Measurement does not itself authorize deletion.
