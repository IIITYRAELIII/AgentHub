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

## Complete producer caller integration

ReleaseGit now calls the existing object provisioner for fresh Await. Consumer
physical identity includes its destination; the plan/native merge identity is
unchanged. New independent generation clones share only immutable object files,
never refs/config/index or alternates. Existing legacy source bundles remain their
original input; no historical receipt is relabelled or rebuilt. Input-only
verification uses the existing pool-leased invocation math lifetime and sealed
cleanup, with the same durable TaskGit process-tree owner. Both the pool writer
and repository execution remain fenced after an unproven child outcome.

Generation retirement archives every original Git object/ref and raw local file
through the existing object archive owner, retains its exact inventory/receipt,
and uses the existing sealed deleter. Remaining generation metadata/transports
retain physical archive aliases without a second byte copy. Partial sealed
retirement resumes only the retained exact plan; unknown lifetime/custody refuses.
The existing generation transport retention port also uses the guarded process
owner; no new cleanup scheduler, store, reconciling owner or GC is added.

The existing dependency owner may publish one compatible registry-only installed
payload under its exact manifest/lock/runtime/platform/ABI fingerprint. Its normal
npm runner, validation, source rereads, per-input lock and durable process guard
precede publication. Project install hooks, workspaces and local linked inputs
retain source-specific local installs. Existing local installed trees stay local.
New compatible Tasks receive immutable package/bin hardlinks and separate plain
local directories/stamps/.cache. Slot and attached file identities/content are
checked; incomplete originals never reinstall automatically. Changed inputs retain
prior aliases and unique cache/work by an atomic same-Task move, then use the new
input. Required evidence and unique work remain under existing Task cleanup.

## Additional evidence and limits

A small real ReleaseGit fixture reproduces the old fresh Await full bundle, then
checks the new no-bundle candidate, validation, independent generation/reopen and
complete retirement with unique local work. Another real TaskGit prepare caller
proves one owned npm install for two compatible Tasks and the same exact-key
unknown-installer fence across different Task locks. The dependency owner fixture
also checks separate caches, changed-input retention and partial install refusal.
Windows allocations are measured only on disposable fixtures. Package readonly
flags protect ordinary accidental writes; the same OS user's deliberate permission
changes are not a new security boundary. Mixed necessary packs remain whole.

Initial accepted native-only evidence remains scoped to its original carrier;
this caller/dependency/generation extension requires its own exact source review.
No production GB freed, live cleanup, application, publication or end-to-end speedup
is implied. Cleanup of old data and runtime adoption remain with their owners.
