# ADR-0108 — Exact reviewed native merge compatibility corrections

Date: 2026-10-12
Status: implementation pending independent review
Contracts: REL-001, MCP-001

## Decision

Git can automatically merge two individually valid changes into a combined
result that needs a compatibility correction, such as duplicate test helpers.
Conflict-path equality is therefore insufficient to define the allowed reviewed
result. The existing native Git owner computes the automatic merge tree and the
complete binary diff to the proposed resolution. Exact ordered inputs, parents,
commit, tree, automatic tree and diff digest participate in review identity.

The ordinary status argument `native_resolution_review` carries the exact
independent inter-Stream ACCEPT text and original request ID. The application
verifies its authenticated existing MCP receipt, independent sender, same
Workspace, RM recipient and content hash. Git verifies the proposed objects
against that exact binding. No caller-declared file list, boolean waiver,
separate approval ledger or alternative composer is introduced.

Test and Await retain the review in their existing lifecycle/native journals.
Reopen and generation capture recompute the full Git binding and verify the same
receipt; a different selected set, stale parents, unreviewed bytes or amendment
after review is refused. Existing source/current refs, leases, selection and
exclusion, SQLite terminal fences and old immutable outcomes remain unchanged.

Ordinary conflict-only resolutions remain supported. A private final automatic
merge may be amended before delivery only with this exact review; prior ordered
steps remain fixed. Source acceptance still does not authorize publication.

## Required evidence

### Retained Test proof after its own partial native publication

Correction acceptance cannot require origin to remain at a pre-publication Test
baseline after the same native owner has published its selected candidate. The
existing release store supplies a strictly read-only current-generation witness:
exact retained descriptor in selection and manifest, authorized membership,
validated native generation identity and exact observed origin candidate. The
filesystem owner keeps every original Test seal and rejects other origin changes.
The witness grants no execution capability and rewrites no operation or receipt.
Removal follows retirement of retained legacy selected-Test receipts; new native
Test descriptors retain their existing integration proof. Regression exercises
the public filesystem owner with real Git publication and SQLite, including
foreign origin, stale generation/scope and before/after row preservation.

The same bounded witness interprets terminal failed startup-correction history
only when immutable original/recovery/correction bindings, prior PARTIAL readback
and validation, and the unpublished composed successor agree exactly. It does
not resume the terminal operation or treat old effects as successor readiness.
Foreign authority, altered history and any successor publication effects refuse.

Real isolated public Test and Await owners must accept a reviewed cleanup of two
automatically merged duplicate test files and retain its exact resulting tree.
Missing review, stale parents/selection and post-review changes must refuse
before dev/candidate promotion. Existing ordinary conflict recovery remains valid.
