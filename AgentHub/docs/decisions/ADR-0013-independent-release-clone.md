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

Startup reconciliation reads only Agent Hub-owned checkpoints. Historical linked
holders are reported, never reused and never deleted by this migration.

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
