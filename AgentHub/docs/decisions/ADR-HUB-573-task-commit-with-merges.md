# ADR-HUB-573 — Accept the final Task commit

Status: accepted.

Test and Await use the same exact Task result commit, including Git merges
already made inside the Task branch. Absorbing multiple branches can use
ordinary Git and one Test after the final commit. Selection of the Task result,
main-based ancestry, release-owned metadata and the actual integration result
remain bound to their owning operations. Earlier receipts are retained for
historical operation recovery.
