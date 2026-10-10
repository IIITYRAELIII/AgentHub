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

Preserve old full10, raw checkpoint/manifest, source SHA, required selected
descriptors, receipts and frozen generations. Already main-based originals merge
directly; no alias is needed. One-time lineage is recorded in the existing
immutable manifest and retained owned ref. Mixed ancestry has no guessed fallback.
Approved absorbed parents require exact authenticated saved/stopped transfer and
sealed receipt binding, not arbitrary merge relaxation. Main context can differ
from the old published-base candidate and is reported explicitly.

Legacy selected v1/v2 writers can complete only originals admitted before cutover.
New preview admission is closed. Actual capture version must agree with intent
and receipt; v2 seals/markers refuse paired header downgrade. Genuine v1 keeps
its exact pinned materializer. Remove recovery writers after every supported old
original is terminal; retain historical readers while their receipts are supported.

The existing durable ReleaseOperation run/get/continue API remains the sole
release owner. Freeze immutable generation/version/CHANGELOG, never Task work.
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
