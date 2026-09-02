# ADR-0013 — Independent Agent Hub-owned release clone

## Status

Accepted. Refines ADR-0010 and REL-001 after the HUB-122 recovery incident.

## Context

The former release holder was a linked worktree of the registered primary
repository. Git permits a local branch to be checked out in only one linked
worktree, so moving `main` into that holder required detaching the user's primary
Workspace. Subsequent local work accumulated on the detached revision and made
recovery depend on forensic attribution.

## Decision

`ReleaseGitWorkspaceService` is the sole owner of release-repository lifecycle.
It creates a standalone clone under Agent Hub runtime data with a Git common
directory distinct from the registered primary Workspace. `PreRelease` is rebuilt
there from `origin/main` and the exact frozen Task result commits. The service
writes a content-addressed manifest plus a retry checkpoint and verifies that the
primary branch, HEAD and dirty-byte fingerprint were unchanged.

Release publication entrypoints require the independent-clone marker. The
registered primary Workspace is never a publication source and release
preparation never switches, detaches, resets, stashes or cleans it. Post-release
synchronization is a separate guarded fast-forward: overlap or non-fast-forward
conditions return `manual_required` without failing an already verified release.

Startup reconciliation receives every release-enabled registered Workspace root
from the runtime catalog and audits its branch ownership plus linked worktrees
before any release checkpoint exists. Checkpoints are an additional evidence
source, not discovery authority. Legacy Workspace rows without a working directory
use the runtime default project registration; thread history is never primary
authority. A detached primary or historical linked holder
is reported as `manual_required`; the audit creates, switches and removes nothing.
The audit always derives the expected managed layout for each registered root.
If its `releaseRoot` exists without the matching checkpoint and ownership marker,
or is not a valid independent clone, it is reported as an orphan requiring manual
resolution and is never adopted, repaired or removed during startup.

Injected Workspace and Architect rules identify `releaseCandidates[].releaseRoot`
as the only frozen-release checkout. The compatibility layer removes the former
Architect instruction to update local `main` or use a linked integration worktree.
The web tooltip adds the same invariant without replacing the current workflow
text supplied by later policy revisions.

## Consequences

- Branch ownership conflicts between release `main` and primary `main` are
  structurally impossible because their Git common directories differ.
- Dirty participant settings may coexist with candidate preparation and are
  byte-checked across a safe post-release fast-forward.
- A frozen runtime manifest is execution evidence, not a second release authority;
  Dashboard Tasks and the plan revision retain CAS ownership.
- Legacy holder cleanup requires a separate explicit operation after ownership is
  proven. The compatibility detector can be removed only when all supported
  installations have independent-clone checkpoints and no supported migration can
  contain a linked holder.
