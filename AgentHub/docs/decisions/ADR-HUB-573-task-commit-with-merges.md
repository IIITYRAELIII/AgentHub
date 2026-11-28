# ADR-HUB-573 — Accept the final Task commit

Status: accepted.

Test and Await use the same exact Task result commit, including Git merges
already made inside the Task branch. Absorbing multiple branches can use
ordinary Git and one Test after the final commit. Selection of the Task result,
main-based ancestry, release-owned metadata and the actual integration result
remain bound to their owning operations. Earlier receipts are retained for
historical operation recovery.

Await can use the original successful Test and its native Git record for the
same Task, repository and result to recognize a package version inherited from
an earlier publication. That Git commit must be an ancestor of both the tested
result and the current publication. This source of evidence is needed while
previously tested results remain eligible across publications. It does not
authorize Task-authored version changes or set the candidate's version.
