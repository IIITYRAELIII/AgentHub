# ADR-0082: Explicit accepted-local-main to managed-dev bootstrap

An accepted local main can advance after publication while managed dev retains
separate Test results. Ordinary Task Test must not merge that unrelated rolling
dev history into a Task merely to satisfy an ancestry guard. Publication
finalization is not available for an unpublished local main and must not be
fabricated. A deterministic pre-effect Test ancestry refusal may be terminal
only after the lifecycle's durable failed record and lease/readback proof; an
ambiguous effect remains unknown (ADR-0081).

The Task Git owner exposes one explicit operation, pinned to a stable request
ID and exact accepted main, prior dev, published revision/generation and one
common merge base for dev/main and published/main. It uses the existing dev
lease, a clean managed worktree, ordered merge
parents and a single `update-ref` CAS. The old dev is preserved as a parent, not
copied into the Task result. A pre-CAS durable record and completed receipt
provide recovery and same-request replay. An unsuccessful merge aborts and
proves restoration; a changed ref, proof, publication or primary main fails
closed. An uncertain CAS is read from that record and not dispatched again.

The optional reviewed-CHANGELOG path is limited to that sole conflict: the
operator supplies a regular file and the expected entire merged tree. The owner
stages those exact bytes, verifies `write-tree` before CAS, and persists the
resolved-tree identity in the recovery record. Any different conflict or tree
restores the old clean dev. This resolves bytes, not approval of incoming main.

Publication state and Git refs are separate authorities. A publication
generation that changes before the last owner read prevents a new effect. If
it changes across the Git CAS itself, the durable record plus exact new dev ref
and ordered parents prove the already committed effect: recovery materializes
and receipts it, returning `merged_publication_advanced` rather than unknown or
claiming that the old publication is still current. A new request fails its
generation check; replay of the original request reads its historical receipt.

The operator's accepted main identity is an explicit input, not inferred from
`origin/main`. Review of the incoming commits and authorization to run this
operation are separate from code deployment. This owner operation does not
mutate production merely by being installed.
