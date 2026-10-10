# ADR-0106 — Native Git selected branch composition

Date: 2026-10-10
Status: accepted architecture, exact implementation requires independent review
Contracts: REL-001, MCP-001

## Decision

Return to Task/dev/PreRelease branches from agreed main. Existing TaskGit and
ReleaseGit owners sequence ordinary Git merge/checkout in exclusive owned roots;
Git owns content and serialization. Hub owns selection, exact accepted identities,
Task/release CAS and durable external effects. Replace ordinary effective-dev
replay, release-task-net-projection fallback and per-file selected materialization.
No second composer or permanent cherry-pick/projection layer is introduced.

Native staging exports Git objects/refs into an owned bundle and clones that
bundle with clone protection enabled. Direct local upload-pack rejects active
mandatory core.hooksPath; disabling that protection or changing team hooks is
not an admission mechanism. Exact commit presence and all existing source,
history, merge and terminal fences remain authoritative after transport.

Real merge commits retain exact selected result parents. Conflicts keep isolated
MERGE_HEAD/index; reviewed normal resolution commits preserve automatic entries.
Changing selection recomposes from main. Dev is preview and Test-only work stays
outside selected composition. Task CHANGELOG edits remain rejected; existing
publication generation owns consolidated version/CHANGELOG.

An original native intent precedes promotion. Checkout/readback precede expected
ref CAS. SQLite terminal persistence rechecks source and dev under existing leases.
UNKNOWN retains the original and bytes; recovery never invents NO_EFFECT or a new
identity. Busy/private checkouts are preserved, including ignored collisions.
Known acceptance refusal restores the previous exact candidate/checkpoint.

## Cutover and compatibility

The existing task-await-cutover CLI gains bounded initial native Test admission
for independently reviewed source when the installed owner still lacks native
Task status. It uses the normal HubMcpService status receipt, TaskLifecycle,
native Git intent and existing reconciliation; no second launcher or ledger.
Source inspection precedes stores. Full current caller/assignment/active Thread,
managed source, Task CAS/empty refs, main/dev, publication and candidate/plan pins
are rechecked before effects and SQL terminal. The active installed manifest and
native status capability close new admissions after installation. First-run
availability/status guards do not block exact original terminal readback or
pending recovery. Recovery retains source and current ownership fences, skips
only bootstrap availability, and cannot invent a new CAS or turn UNKNOWN into
refusal. Remove new admission when all supported installations provide native
status; retain original receipt/evidence readers for their supported history.

Preserve old full10, raw checkpoint/manifest, source SHA, required selected
descriptors, receipts and frozen generations. Already main-based originals merge
directly; no alias is needed. One-time lineage is recorded in the existing
immutable manifest and retained owned ref. Mixed ancestry has no guessed fallback.
Approved absorbed parents require exact authenticated saved/stopped transfer and
sealed receipt binding, not arbitrary merge relaxation. Main context can differ
from the old published-base candidate and is reported explicitly.

Fresh absorption uses ordinary Test with the existing selected_absorption_handoff
argument, without a bundle, selected preview or per-file materializer. TaskLifecycle
authenticates the original inter-Stream receipt and transferred requirements under
both Task leases. The native Git intent binds that exact input and survivor CAS;
source HEAD/base/branch/cleanliness/process fences and durable ownership are checked
before promotion and terminal persistence, including same-original recovery.
The successful Test outcome stores a native-task-integration-v1 descriptor in the
existing required selected evidence. Plan/manifest/generation/readback retain it.
Historical validation verifies the original completed Git capture and immutable
objects, rather than the later rolling source/dev checkout. Combined closure uses
the existing preview/confirm owner after successful composition.
Later ordinary return/correction/reuse retains the original accepted absorption
descriptor from the existing Test outcome. It must be an ancestor of the new
exact result and its immutable completed capture must still verify. It does not
reopen the closed source or reuse its handoff as fresh live authority. The new
native outcome carries the unchanged original descriptor as absorptionHistory;
SQL admission and terminal CAS verify the original outcome, without a new ledger.
Fresh absorption also accepts source or survivor previously in Test/Await only
after normal return. The existing SQL owner derives bounded successful Test and
return identities from preserved refs and seals their exact outcome hashes into
the same absorption input. Subsequent fences compare those original bindings;
Git requires the preserved result to be an ancestor of its declared merge parent.
Receipts and historical selected descriptors are retained unchanged.

Legacy selected v1/v2 writers can complete only originals admitted before cutover.
New preview admission is closed. Actual capture version must agree with intent
and receipt; v2 seals/markers refuse paired header downgrade. Genuine v1 keeps
its exact pinned materializer. Remove recovery writers after every supported old
original is terminal; retain historical readers while their receipts are supported.

The existing durable ReleaseOperation run/get/continue API remains the sole
release owner. Freeze immutable generation/version/CHANGELOG, never Task work.
Publication imports the already prepared native PreRelease commit and its checked
resolution ancestry through the existing promotion owner. Original generation
identity and manifest pin its head/tree/checkpoint/manifest/selection/base; no new
merge of selected tips occurs. Stale inputs require normal Await preparation.
Only the existing metadata freeze may change version/CHANGELOG, and retry resumes
the same promotion/freeze rather than recapturing a different live candidate.
Generated instructions describe that actual API. Opaque authored rules are not
rewritten, and conflicting stored instructions require their separate handoff.
Raw Workspace policy, production installation/restart/push and publication are
outside source implementation authorization.

## Evidence required for implementation acceptance

Real isolated Git/SQLite public Test/Await, complete multi-commit correction,
native shared-file conflict and resume, selection removal/Test-only exclusion,
Git EOL and private collision preservation, lost terminal/reopen/same-ID with
source fences and zero extra CAS, genuine legacy v1/sealed v2 readback, immutable
generation promotion and full accepted composition/main-context preservation.
Existing focused commands are tests/application/native-git-public-lifecycle.test.mjs
and tests/infrastructure/filesystem/release-native-git.test.mjs under node --test.
Historical full10 proof is separate from live admission and installation evidence.
