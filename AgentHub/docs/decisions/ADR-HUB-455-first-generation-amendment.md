# ADR-HUB-455 — Explicit whole-Await amendment before first freeze

Status: accepted by this correction's review and release workflow.

## Context

A release can fail its first compose before any immutable generation exists.
Its original whole accepted set, explicit test list and consolidated notes can
then become obsolete while ordinary Task acceptance continues. Sending those
new explicit inputs to the ordinary amendment owner previously required a
registered generation. Recovering an obsolete first freeze merely to amend a
second generation is not appropriate when the first freeze never occurred.

## Decision

Extend the existing explicit amendment, first-compose custody and SQLite CAS
owners. Generation zero is eligible only with positive idle failed-compose
receipts for the original exact input, no registered generation, selected
results or publication effects, and no running/scheduled owner. The caller must
provide explicit whole `all_await` membership and test selection, plus verified
replacement metadata whenever effective notes already exist. Original
authorization, approved targets, version/validation policy and old receipts
remain immutable.

The existing first-operation preflight holds one Workspace Await lease while
it verifies current complete prepared selection and original repository/main
approvals. Every generation checkout and archive namespace must be positively
uncaptured. Its inspection callback repeats the same prepared/source/custody
binding, accepted selection and metadata checks immediately before ordinary
amendment CAS. It does not reacquire the non-reentrant Await lease. It creates
no generation or preparation and supplies no invented target readback for a
nonexistent generation.

The existing amendment retains its exact failed receipt/input, prepared and
uncaptured-custody proof. The canonical SQLite transaction repeats the failed
boundary and original input before appending it. Existing first-compose capture
uses effective amended membership and verified notes and rereads the captured
binding under its normal generation lock. Only actual immutable capture moves
`currentGeneration` from zero to one. A later pre-capture failure retains each
earlier input boundary and can use the same ordinary recovery/amendment owners;
history is neither discarded nor retargeted.

An addressed pending/UNKNOWN public amendment may continue through the existing
first-compose continuation owner with the same request, arguments, actor and
revision/generation CAS. A lost admission acknowledgement reads the retained
amendment. UNKNOWN diagnostic history remains retained until that admission is
authoritative. Exact replay cannot schedule a fresh amendment. Captured, mixed,
partial, changed, foreign or unproved custody refuses this new-input path and
retains the original frozen recovery policy.

## Consequences and validation

No new endpoint, release identity, database writer, automatic test selector,
schema, publication or cleanup is introduced. Existing later-generation
amendments still require their registered candidate and complete positive
publication readback. Default first-compose recovery and strict ordinary
preflight remain unchanged. The prepared-notes plumbing already accepted by
ADR-HUB-453 is reused for the compact source test context; it supplies no new
dirty-file allowance.

Bounded public HTTP/external022/SQLite tests exercise the exact 13-to-16 Task,
316-to-351 selection shape, SAME receipt/actor continuity and failed-boundary
CAS. The prepared-boundary regression uses real Git preparation, first-freeze
custody, verified dirty RM notes and immutable capture. Prior Task acceptance
evidence and validation/publication are controlled fixture ports, not production
effects. Separate tests cover receipt, notes, authority and occupied-custody
refusals and preserve original/later-generation behavior.
