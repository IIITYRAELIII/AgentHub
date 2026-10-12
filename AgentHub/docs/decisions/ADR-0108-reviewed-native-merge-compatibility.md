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

Real isolated public Test and Await owners must accept a reviewed cleanup of two
automatically merged duplicate test files and retain its exact resulting tree.
Missing review, stale parents/selection and post-review changes must refuse
before dev/candidate promotion. Existing ordinary conflict recovery remains valid.
