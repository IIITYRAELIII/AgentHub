# ADR-0048: Prepare accepted Tasks before release

Status: Accepted for HUB-235; installed with its eventual release. Its ordering
of acceptance before composition is superseded by ADR-0055, which commits Await
only after a successful PreRelease composition. The rest of this decision, and
the history below, remain as recorded.

## Decision

The ordinary Await transition durably accepts the exact Test-owned result, then
prepares PreRelease from current accepted membership. Composition runs after
releasing the Task lock and inside the existing Workspace Await lock. Its failure
is a candidate block with a reason, not a reversal of acceptance. It does not run
the release pipeline or refresh Test Contour.

The Git owner reuses a repeated Test result only after proving unchanged worktree
state and the same result still integrated in dev. New edits follow the ordinary
Test snapshot and integration path.

Automatic composition cannot alter a freezing or frozen candidate, including
after push. The freeze lasts through confirmed release completion. New acceptance
requests leave their Tasks in Test and must be repeated after completion; no
automatic deferred acceptance is introduced. Composition failure
restores the exact old checkout and checkpoint. Fallback project directories are
normalized to repository identities; withdrawing the last Await prepares the
empty set rather than leaving its old code in the candidate.

## Accepted return and dependency policy

Returning an unpublished Test/Await result to work removes it from dev and from
the accepted composition while preserving its Task branch. A dependent Task B
waits for prerequisite A's publication; the rule must not prevent correcting A.
Simple revert alone is insufficient because ancestry would falsely prove that
withdrawn code remained integrated. Withdrawal and later Test must agree on the
effective dev state, with durable operation evidence across Git and SQLite.

The implementation reconstructs dev from local main and attributable remaining
Task merge sides. It refuses to discard unknown integrations or unseparable manual
resolutions. ADR-0049 supersedes automatic dependent returns: the current attempt
reports the dependency and fails without changing another Task. The agent handles
the dependent Task first. A recorded Git-owned release wait uses repository-scoped
publication ancestry and permits an explicit user override through claim. The Task branch and dirty files remain intact. A durable
withdrawal intent binds the atomic dev/wait-ref exchange to the existing SQLite
lifecycle outcome; proven rejection restores dev and unknown outcome keeps the
intent fenced for exact original-operation reconciliation. No inverse commit is
mistaken for active code through an ancestry-only check.

Task sparse checkout excludes CHANGELOG.md at every depth. Clean tracked copies
leave Task worktrees; dirty or recreated changelogs cause a non-destructive error
before snapshotting. The shared changelog is edited only during release preparation.

## Evidence and limitations

Behavioral tests cover real Git composition, candidate freeze/publication,
restoration on failure, release-workflow opt-out, repeat Test, MCP/CLI status
receipts and candidate failure after acceptance. An interrupted status-to-candidate
handoff is recorded as pending; existing reconciliation proves only the committed
Task outcome, and candidate readback or explicit retry supplies preparation.
No separate background recovery loop or full publication pipeline is introduced.
Post-publication finalization remains a separate checklist step.

Review correction, 2026-09-15: a foreign withdrawal intent produces a known
refusal for the current Task. Unknown is reserved for the exact current
operation/task intent, checked while the repository lock is still held.
Legacy cone worktrees may finish an existing valid dev merge before migrating
their sparse patterns; migration resumes on the next preparation after the merge.
