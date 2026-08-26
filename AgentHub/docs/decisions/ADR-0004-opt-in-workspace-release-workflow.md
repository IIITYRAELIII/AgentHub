# ADR-0004 — Opt-in Workspace release workflow

## Status

Accepted.

## Decision

Release change registration and the release-oriented developer policy are one
Workspace capability controlled by `settings.releaseWorkflowEnabled`. The
default is disabled. Existing data migrates to enabled only when the Workspace
rules begin with the exact legacy release-policy block; that block is removed
from editable rules and thereafter composed from code.

Disabling the capability with active registrations requires explicit user
confirmation. The setting update and discard of active legacy entries and
ChangeSets are one SQLite transaction. Released history is retained.

## Consequences

Ordinary Workspaces no longer acquire release entries or release-only agent
constraints. A release-enabled Workspace cannot drift into a state where the
policy is active but registration is not, or vice versa. Existing accidental
entries in regular Workspaces remain visible until the user confirms their
discard; they do not cause new registration.
