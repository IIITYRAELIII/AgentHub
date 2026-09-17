# ADR-0063 — Release manager, release checklist and verified cleanup

Date: 2026-09-16

## Decision

The release role is named **Релиз-менеджер** / **Release Manager** across the
current UI, instructions, API messages, identifiers and documentation. Its
setting is `releaseManager`. The catalog migrates the prior boolean once without
losing enabled/disabled state, overriding an explicit new value, or assigning
authority by a Stream name at runtime. Exact old names remain only as migration
inputs. Historical generated rule strings retain their original bytes so that
prefix migration preserves authored suffixes, disabled roles and idempotence.

At release start the role creates or reuses one `Релиз [версия]` service Task.
All Tasks already in PreRelease become native linked checklist entries with
retained titles and summaries. The publication mechanism supplies the version;
the role renames the same pending-version Task when that version is frozen.
Retry keeps that Task, checklist and release identity.

The role stops the included executors, checks accepted branch heads and clean
worktrees, and forbids editing or resuming included Tasks and source checkouts
during publication. Release corrections follow the existing return/validation
lifecycle rather than silently changing frozen sources. These are issued agent
instructions, not filesystem access-control changes. Current runtime candidate
freeze and its Await transition fence remain authoritative; this patch does not
claim that arbitrary editors or every Task metadata operation are technically
blocked by those instructions.

After verified publication, canonical completion marks only included Tasks Done
and closes them. Their cards, descriptions, checklists, attachments and history
remain. The release Task also remains. Only managed Task branches and worktrees
are removed by confirmed cleanup. Cleanup or local synchronization failure does
not erase publication evidence, and retries do not repeat successful publication
stages. The next acceptance into Await prepares the next candidate when needed.

## Cleanup defect and boundary

Previously cleanup proved ancestry of the saved result only. A clean Task branch
could have advanced beyond that published result and still be force-deleted,
including when its worktree was already absent. Two real-Git reproductions cover
those cases.

Cleanup now includes the current branch/worktree heads in publication proof and
confirmation, rechecks repository state under its existing lease, removes a
Complete worktree without force, and deletes the branch ref with its observed
old commit. A late dirty file stops worktree deletion. A late branch commit
survives through the retained branch when the ref compare-and-swap fails. Delete
remains the separate explicitly confirmed destructive action for unpublished
work; release instructions never use it to delete Task records.

## Validation and compatibility

Real SQLite reopen tests cover both generations of settings migration, explicit
false, explicit new values and repeat startup. Export checks bind all 32 prior
rule strings to their exact historical values. Behavioral tests cover issued
policy, authorization, browser toggles/help, real-Git cleanup, late files and
late branch moves. Existing finalization tests retain exact completion identity,
separate synchronization outcomes and retry reuse. Production installation and
publication are outside this change.
