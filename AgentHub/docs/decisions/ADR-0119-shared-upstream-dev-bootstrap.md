# ADR-0119: Accepted shared upstream after an older publication

The ADR-0082 bootstrap required dev/main and published/main to share the same
merge base. It refused even when both accepted main and managed dev already
contained a newer shared upstream and the exact durable publication was an
ancestor of that upstream. This prevents ordinary Task Test before any Task
integration; it is not evidence of an unknown Git effect.

Keep that existing bootstrap owner and its exact input/receipt format. Retain
the original equal-base case, including its handling of divergent published
history. Add only the case where published/main has the exact published commit
as its unique base, and published/dev-main-base also has that exact published
commit as its unique base. Older divergent publication history is insufficient.
Use this same immutable Git proof at admission, immediately before the dev CAS,
and in recovery of the original pre-CAS journal.

The operator still explicitly accepts the exact local main. Its unique common
base with exact old dev, durable publication revision/generation, clean managed
worktree, existing dev lease, modifications-only materialization and ordered
parents remain required. The sole reviewed CHANGELOG conflict path is unchanged.
No Task result receives rolling-dev ancestry. No primary, remote, publication
state or Task status is changed by this bootstrap. This proves composition,
not approval of external code or membership of a product release.

An exact already-committed CAS is recovered under the existing journal even if
publication subsequently advances. Original-ID replay returns its historical
receipt without another CAS; a fresh request with a stale generation refuses.
There is no new writer, command, authority flag, retry loop or receipt family.

Focused behavioral checks: `node --test
tests/infrastructure/filesystem/task-accepted-main-bootstrap.test.mjs
tests/interfaces/cli/release-policy.test.mjs`. The added real-Git cases cover
the formerly refused common-upstream topology, an older divergent publication
refusal, and interrupted post-CAS materialization with publication advancement.
