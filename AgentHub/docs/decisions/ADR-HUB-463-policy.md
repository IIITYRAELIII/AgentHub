# ADR-HUB-463-policy — Retain process instructions after mechanism removal

## Context

Removing the release mechanism also removed built-in workflow instructions and
renamed their controls. The user requested restoring the instructions and labels,
preserving all unaffected historical clauses exactly, and explicitly agreed the
current manual delivery sequence. This supersedes only the instruction-removal
part of ADR-HUB-463; the removed orchestration remains absent.

## Decision

Keep current task-workflow module names, settings keys, Task authority and UI
selectors. Restore "Релизный процесс" and "Релиз-менеджер" and the existing
Workspace/Stream instruction composition. Auto-review and Team Lead remain
independent; authored raw rules are never rewritten or deduplicated.

Preserve the historical 36-character title rule, dependency ensure/verify,
native Task guards, absorption/review requirements, incoming Git approval,
resource ownership, primary protection and explicit user exceptions. Add the
requested all-Task duplicate/result check before creating a Task.

Replace removed mechanism instructions with the agreed sequence: PreRelease,
version/common notes, installer build, installation FROM that installer, actual
Ready/source/affected checks, direct PreRelease corrections and new build/install
when needed, exact checked main push, main-to-dev synchronization, GitHub Release
only when Workspace rules require it, verification of the required delivery
stages, Done/Complete, then separate cleanup/backup retention.
Executors continue independently; only the checked composition is pinned.
Post-publication corrections belong to a later release and preserve published
source/assets and original outcomes. Failed and affected checks are selected
explicitly; successful unaffected checks need a concrete reason to repeat.

## Consequences and validation

No release API, worker, generation, freeze, pipeline, cache, selector or writer
returns. Existing Git/build/install/Task owners perform manual delivery. Tests
exercise actual policy outputs, SQLite context composition across settings,
rotation/reopen and unchanged raw rules, plus visible Edge controls/help. Exact
historical old-to-new clause mapping accompanies review. Task integration and
manual completion invariants remain under REL-001; generated-vs-authored rules
remain under SYS-002 and visible controls under UI-001.
