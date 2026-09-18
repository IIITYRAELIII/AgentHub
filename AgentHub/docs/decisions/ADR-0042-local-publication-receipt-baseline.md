# ADR-0042 — Adopt a legacy local publisher receipt as repository evidence

## Status

Accepted for the HUB-216 release migration.

## Context

Repository-scoped release preflight must not infer a repository identity from an
unscoped publication revision. The last installed Agent Hub release was emitted
by the former writer: its publication state is unscoped, while the durable
successful publisher receipt separately contains the exact Workspace,
repository, frozen release and deployed runtime identities. This repository has
no GitHub release or tag, so the external-publisher adapter cannot establish the
missing repository scope.

## Decision

Provide an operator-only `local-publication-receipt` preview/enable adapter. Its
authority is the exact conjunction of the raw legacy publication-state file,
the terminal successful publication-run receipt, the active installed runtime
record and that release's runtime manifest. The operator pins both raw SHA-256
digests, publication revision/generation/time, Workspace and run identities,
runtime release identity, canonical origin identity, exact observed
`origin/main`, and a unique request ID.

The adapter accepts only a complete unscoped legacy Agent Hub state whose full
legacy content equals the receipt's saved publication state. The receipt must
bind the same project root and Workspace, revision, PreRelease head, plan,
manifest and finalization command. The active record and runtime manifest must
bind the installed release and the exact publisher checkout. Local main must
still equal the published revision, which must be contained in the pinned
remote-tracking `origin/main`. Verification never fetches or moves a Git ref.

Preview has no write effect. Enable obtains the canonical publication lock,
rereads every input and ref, and appends a repository-scoped record through the
publication-state owner. It preserves all legacy top-level fields and evidence
for other repositories. The new record names both raw evidence hashes, the
publisher/finalization identities, canonical origin, exact origin observation
and operator request. An exact retry is idempotent; any different existing
record, changed bytes, identity, deployment or ref fails before a write.

## Consequences

The migration does not reinterpret the unscoped revision, authorize a newer
origin commit, bypass preflight or claim that Git ancestry proves deployment.
It is usable only while the historical durable publisher and deployed-runtime
evidence remain mutually exact. Future publisher writes are repository-scoped,
so this adapter is a bounded compatibility surface rather than a second release
workflow.
