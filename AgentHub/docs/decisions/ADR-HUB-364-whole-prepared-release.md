# ADR-HUB-364 — Release captures the whole already prepared PreRelease

## Decision and explicit change

The user approved on 2026-10-29 that release always consumes the whole prepared
PreRelease, equal to every current accepted Await Task. There is no second subset
selection at release time. Returning an exclusion Await-to-Test and preparing the
new complete set belongs to the normal Task lifecycle. This supersedes the
release-side auto-prepare fallback in ADR-0132; its other boundaries remain.

The existing ReleaseOperation/adapter/preflight owns current authority, and the
existing ReleaseGit prepared-source/freeze owner captures the immutable generation.
Release does not call `#prepareAwaitSet`, `prepareCandidate`, or `mergeSelectedResults`.
Ordinary full Await composition is unchanged. Native prepared-history/content
verification still executes, including read-only Git merge-tree proof; this is
verification of the retained resolutions, not new Task merge commits or choices.
Current base/origin/publication, whole membership, exact prepared checkpoint/tree,
native selected-content/history/import closure, process/lease/CAS and authority
checks remain. The final authority check follows the last verification read.
Only version and consolidated release notes are materialized by the existing
freeze owner. No global/prefix cache, new writer/registry/launcher or timeout is added.

## Scope and historical compatibility

New `hub_release_run` persists `authorization.taskScope=all_await` and the admission
Task-ID snapshot. Omitted `task_ids` means this whole set; supplied IDs assert the
exact whole set. New generations record the current whole captured membership in
the existing `authorizedTaskIds`, with results and source fingerprints unchanged
in purpose. The existing publication reservation rechecks current whole membership
under the Await boundary. Before publication admission, drift creates/requires a
later checked generation on the same original; after admission the original
generation and effects stay immutable. Task editing/acceptance continues.

Legacy authorizations without `taskScope` retain their original fingerprint and
membership. They must already equal the whole current Await set to capture it.
To activate whole-set semantics on such an original, explicitly supply
`task_scope=all_await` to normal `hub_release_continue` with the existing request,
revision/generation CAS and not-applied target readbacks. The same amendment record
binds the full capture, optional expected IDs and exact omitted/explicit arguments;
no old authorization/amendment/receipt is enriched. Omission retains the saved
scope; replay cannot remove or replace its captured explicit input. Historical
reviewed-main records remain bound to their own prior revision/generation scope;
later membership cannot reauthorize old history. This compatibility path is needed
only until legacy active operations finish; new operations always use whole scope.
The historical reviewed-main validator/record family is unchanged. If dynamic
membership has outgrown its prior authorization/amendment boundary and a
reviewed-main rebind is needed, first record the existing exact `task_ids`
whole-set assertion amendment. This uses the same not-applied/CAS owner, not a
subset selector or new user approval. Then the normal reviewed-main record has
an independently retained membership boundary; no self-asserted current set is
allowed to replace a historical proof's membership.

## Failure and measured behavior

Missing/stale prepared bytes refuse capture and leave the same operation waiting
for normal lifecycle preparation. Foreign/dirty bytes, unknown effects and bad
authority remain real refusals, not fabricated successes. After a failed generation,
an affected correction passes normal Test/Await and prepares the new whole set;
the same release captures generation N+1. Old failure receipts/generation identities
remain immutable and changed code is validated again. Existing checkpoint validity
alone governs reuse. Public private-fixture evidence records prepare/capture spans
and actual owner invocation counts. Zero new ordinary composition is the measured
claim; no end-to-end speedup is claimed without a production AFTER.
