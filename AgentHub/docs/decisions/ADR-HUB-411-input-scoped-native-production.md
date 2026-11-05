# ADR-HUB-411: Stop redundant native history transport and object propagation

## Cause

Native prefix reuse exported the entire ancestry of its retained merge commit,
even when the new receiver already owned all selected input histories. Separately,
new owned-object consumers linked every loose object and pack in the pool,
including unrelated historical captures and raw archived files. The latter can
propagate unrelated payload into later whole-capture archives.

## Decision and authority

Keep the existing native sequencer and maintenance object-store owners. For a
new prefix bundle, discover exact receiver commit roots also present in the
retained source. Verify their complete receiver graph and physical receiver plus
source journal custody before and after streaming. Advertise these prerequisites
in the standard Git bundle header and exclude their ancestry from pack-objects.
Git bundle verification in the actual receiver precedes import. Object presence
does not grant merge, review or selected-content authority. Existing journal
intent, current verifier, source identity, process guard and leases remain.

During new object-store provisioning, reconstruct the exact imported input
closure and compare its count/digest with the existing durable import. Link only
required loose OIDs and immutable pack families whose index intersects that
closure. Read pack indexes instead of decompressing unrelated pack payloads.
Preserve whole selected packs, including any unavoidable extra objects inside
them. Reject malformed/unpaired entries; retain hardlink physical/hash checks,
independent refs/index/config, no alternates, connectivity and durable receipt.
The same original operation owns an interrupted consumer; it is not recreated.

There is no pool rewrite, GC, new archive format/ledger, global scan, arbitrary
product size cap, deletion, relaxed test/selection check or old-receipt migration.
Completed old consumers/bundles remain byte-for-byte unchanged.

## Evidence and limits

The actual native composition regression uses one 512-KiB fixture history and
compares its same-input full transport with the new retained-prefix transport,
including Windows allocated bytes, same selected content, prefix and reopen.
The bundle regression covers missing/changed receiver proof, failed original
output retention, no overwrite and actual Git prerequisite refusal. The actual
object-store regression uses a tiny shared fixture pool, proves unrelated raw
blob/pack exclusion, same required content/custody, immutable hardlinks, unchanged
pool, reopen and incomplete-pack/original-recovery refusals.

This change does not implement shared dependency installation or replace the
independent immutable release-generation repository/validation transport. Those
paths require their own compatible dependency custody and guarded process-tree
lifetime integration. No mutable donor tree or borrowed ODB is substituted here.
Fixture savings are not production GB freed or an end-to-end speedup. Existing
cleanup owns old data; release ownership controls coherent adoption and readiness.
