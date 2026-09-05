# ADR-0020 — Main-to-managed-dev synchronization

## Status

Accepted for HUB-170 implementation.

## Context

The release Git owner updates and verifies published `main`, while the Task Git
owner historically created the managed `dev` worktree once and then treated its
head as independent. After either local publication or an external advancement
of `origin/main`, later Test integration could therefore continue from an old
base. No `origin/dev` exists, so another clone cannot repair that drift.

## Decision

`TaskGitWorkspaceService` owns one idempotent main-to-dev operation. The
operation fetches only the exact remote main ref, with tags and recursive
submodules disabled even when remote configuration requests tag expansion, and
incorporates it into the Agent Hub-managed dev worktree while holding the
existing repository dev lock. All other local, remote-tracking, protective, and
tag refs remain outside that fetch boundary.
Task preparation, Task integration, release preflight, and verified release
completion all pass through this owner. Task bases remain the exact main commit;
rolling dev-only Test commits never enter a new Task branch.

Fast-forward is used when dev has no unique commits. Diverged histories use an
explicit local merge commit and prove both input heads are ancestors of the
result. Conflicts are aborted and reported with the exact paths only after the
old dev head and clean state are restored. A dirty dev worktree, current-main
mismatch, or unproved restoration fails closed.

Task-result integration uses the same proof discipline: it snapshots the exact
clean dev head before merge and reports a conflict only after abort restores
that exact head and status. A failed abort or any partial state is an exception,
never a normal `integrated: false` conflict result.

The operation may update `refs/remotes/origin/main` and local `refs/heads/dev`.
It does not change the registered primary worktree's HEAD or index, create a
remote dev branch, push, publish, deploy, or touch release-candidate ownership.

## Consequences

Local Test history survives a publication merge, external main promotion is
observed at the next owning boundary, and release completion exposes exact dev
synchronization evidence. A real conflict requires an operator to reconcile
dev; successful publication is retained but no local integration success is
claimed.
