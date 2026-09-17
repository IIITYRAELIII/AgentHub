# ADR-0059: Resolve PreRelease base from publication and Task adoption

Status: Accepted
Date: 2026-09-16
Contracts: REL-001

## Context

Await preparation fetched origin/main and used its current tip as the base even
when no approval was supplied. This admitted incoming content before the review
required by ADR-0057. Preflight detection was too late: acceptance had already
composed that content. The user approved retaining published or explicitly
reviewed content as the only base and retaining the existing Task isolation.

## Decision

The application reads repository-scoped publication authority and asks the Task
Git owner to verify existing adoption receipts for exact selected results. The
published commit is the default. Only a comparable, verified adopted commit may
advance it during ordinary or automatic preparation. The composer requires an
explicit exact base; origin fetch remains observation. Publication and adoption
identities are rechecked before committing the candidate and prospective Await
status, using the existing locks and rollback boundary. No new approval store,
lifecycle, or reconciliation owner is added.

An explicit Release Manager preparation may additionally use exact reviewed local
and origin main commits supplied by the caller. The existing main audit must match
both commits, report no remaining approval requirement, and pass the existing
upstream-adoption check. The candidate's immutable manifest and checkpoint retain
those two commits together with the last published baseline; all authority and
primary identities are re-read before promotion. This is composition approval,
not a publication fact: it does not update publication state, manufacture an
adoption receipt, or change the preflight requirement that the prepared base equal
reviewed origin/main. Automatic lifecycle preparation cannot select this mode.

Keep selected effective-delta and net-projection proofs. They preserve accepted
conflict resolutions without bringing unrelated Test work from dev into release.
A failed composition leaves the prior candidate and status intact; withdrawal
rebuilds only the remaining accepted set. Non-release status changes are unchanged.

## Migration and limits

Unscoped or absent publication state is not accepted as a baseline. Use the
existing explicit publication-baseline adoption tools for that repository.
Legacy prepared candidates acquire the current authorized base on the next
ordinary preparation, without modifying frozen candidates. Preflight and the
pre-push check still require review of new incoming changes before publication;
this does not freeze origin/main or authorize release.
