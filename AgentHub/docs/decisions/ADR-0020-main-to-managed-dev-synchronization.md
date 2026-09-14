# ADR-0020 — Main-to-managed-dev synchronization

## Status

Superseded for implicit Task and preflight paths by ADR-0040. The exact
post-publication synchronization and restoration rules remain accepted.

## Context

The release Git owner updates and verifies published `main`, while the Task Git
owner historically created the managed `dev` worktree once and then treated its
head as independent. After either local publication or an external advancement
of `origin/main`, later Test integration could therefore continue from an old
base. No `origin/dev` exists, so another clone cannot repair that drift.

## Decision

`TaskGitWorkspaceService` owns one idempotent main-to-dev operation. Under
ADR-0040 it accepts only an explicitly supplied exact revision. Verified release
completion may call it after durable publication has made that revision the
accepted local main. Ordinary Task preparation, integration and preflight no
longer call it and never interpret a fetched remote-tracking ref as acceptance.

Fast-forward is used when dev has no unique commits. Diverged histories use an
explicit local merge commit and prove both input heads are ancestors of the
result. Conflicts are aborted and reported with the exact paths only after the
old dev head and clean state are restored. A dirty dev worktree, current-main
mismatch, or unproved restoration fails closed.

Task-result integration uses the same proof discipline: it snapshots the exact
clean dev head before merge and reports a conflict only after abort restores
that exact head and status. A failed abort or any partial state is an exception,
never a normal `integrated: false` conflict result.

The operation reads the supplied exact commit object and may update only local
`refs/heads/dev`. It does not fetch or update `refs/remotes/origin/main`, change
the registered primary worktree's HEAD or index, create a remote dev branch,
push, publish, deploy, or touch release-candidate ownership.

## Consequences

Local Test history survives an explicit post-publication merge and release
completion exposes exact dev synchronization evidence. A real conflict requires
an operator to reconcile dev; successful publication is retained but no local
integration success is claimed. ADR-0039 refines the narrowly reviewed
Task-result bootstrap; ADR-0040 governs when any main revision has authority.
