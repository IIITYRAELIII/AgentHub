# ADR-0006 — Unrestricted Task done status

## Status

Accepted. Refines the generic workflow-status restriction in ADR-0005 without
changing immutable freeze or verified release-completion evidence.

## Decision

`hub_task_status_update` may set a Dashboard Task to `done` in every Workspace,
including a release-enabled Workspace. The status remains visible and does not
close the Task.

Verified Release Manager release completion remains a separate transaction. It
records publication and deployment evidence and closes only its exact frozen
Tasks. A manually selected `done` status does not claim or fabricate that
evidence.

## Consequences

Workflow status is no longer blocked by release policy. Users and agents may
represent the Task state directly, while immutable freeze and release evidence
continue to answer the separate question of what exact revision was published.
