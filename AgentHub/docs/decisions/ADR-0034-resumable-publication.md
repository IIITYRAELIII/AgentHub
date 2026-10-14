# ADR-0034 — One resumable publication executor

## Status

Accepted for HUB-182. The remaining-Await rebuild receipt is superseded by the
explicit candidate invalidation in ADR-0043.

## Context

The September 8 release took 4h41m in its principal turn. Evidence includes
42 unconditional retries of 14 failing files, four 15-minute suite timeouts,
discarded successful file checkpoints, late candidate smoke, and manual
coordination between Git publication, deployment, restart and Task closure.
Integration defects and incorrect ownership diagnoses also consumed time;
this decision does not claim every historical timeout has the same cause.

## Decision

Keep Task/Git ownership, frozen candidate construction, publication checkpoint,
run journal and canonical release finalization as their existing authorities.
Connect them with one executor rather than introduce another release planner.
Persist validation mode and exact candidate identity. Run smoke before the full
suite; remove unconditional file retries and preserve only proven successful
input fingerprints with bounded retention. Move the two cosmetic browser
matrices to the visual suite, retaining them in affected UI and full validation.

Publish Git under an exact lease before deployment and recheck it on every
pre-deployment continuation. Persist a completion draft before readiness and
retain the same command identity across ambiguous results. Deferred restart
remains pending. After readiness, the runtime may finish only the saved
publication and canonical finalization under the same lock.

Task closure and the finalization marker commit atomically. Primary sync, dev
sync and remaining-Await rebuild persist individual receipts. Retain bounded
completed outcomes for lost-response replay and reconcile interrupted completion
against those outcomes or the exact pending marker. Generic mutation recovery
does not gain permission to replay unknown effects.

## Consequences and migration

The first real publication attempt reproduced another historical failure:
HUB-176 had sixteen intermediate integrations; replaying its earliest revision
on newer main conflicted before reaching its later main-merge resolution.
Its accepted net delta applied cleanly and preserved later published changes.
Repeated integrations therefore admit net projection only with bounded proof
of exclusive unpublished ancestry and verified merge-wrapper trees, and without
cross-Task effective-path overlap. All other cases keep the existing effective
delta algorithm and honest conflict evidence. This does not authorize broad
Task snapshots or hide a dependency on an unselected Task.

Reopening HUB-182 after publication exposed two further assumptions: historical
paths blocked an unrelated pending Task, and the proof required already
published results to remain in unpublished ancestry. The v2 projection policy
verifies those old automatic merges against approved ancestry, proves ownership
before choosing path sets, and propagates overlap rejection to a fixed point.
Unproven contributions keep chronological replay and remain fail-closed.

Publication freeze also explicitly binds consolidated CHANGELOG bytes and the
prepared aggregate into the candidate manifest before promoting main inside the
independent clone. A durable freeze intent makes promotion resumable; the CLI
does not accept arbitrary dirty source files as a new candidate.

The first CLI execution exposed missing release-planner and release-completer
forwarding through both startup composition layers. Both services now reach the
Desktop boundary; composition behavior is covered directly. Bootstrapping an
older running installation permits an explicit local MCP context file, bound to
its exact published revision and Workspace. Only the exact missing-planner
Desktop error selects the existing live `hub_release_plan_get` tool. This
retains that tool's canonical dev preparation, not a parallel planner or stale
plan-file authority. Other control actions and errors never use this bridge.
Credentials are neither persisted in publication identity nor logged. Remove
the local context after the first update; remove the bridge when installations
without the corrected Desktop wiring are no longer supported.

The full gate caught two internal imports of the old public Desktop transport
entrypoint. The unchanged transport moves to its infrastructure owner and the
public module retains a re-export facade, preserving the protocol and callers.
Two historical composition line-count assertions are removed: numeric file-size
budgets do not establish behavior or ownership. Dependency-matrix, acyclic-graph
and state-owner checks remain. This removes false failures, not a material test
latency source.

Quick mode is explicit, not a silently weakened full gate. Unknown paths expand
deployment scope but cannot silently replace an explicit quick choice with full
validation; focused mode retains the unknown-path full-test fallback.
Expensive tests with
unknown external inputs remain uncached until their inputs can be proved.
Old cache entries are ignored; old completion journals without identity/draft
cannot auto-complete. Legacy Await-only markers retain their narrower scope and
report missing synchronization evidence. These guards can be removed when the
corresponding old persisted formats are no longer supported.

The first Git adapter supports a single frozen repository. Multi-repository
publication requires coordinated evidence before this restriction can be lifted.
No broad dev merge, Task selection, or user approval is synthesized by retry.
Source fixes still require a new immutable candidate; deployment failure is not
permission to repair production from a dirty checkout.

Freeze and completion now share a phase-aware candidate readback: prepared
state is attached to the exact clean `PreRelease`, while frozen state is
attached to exact clean `main` and requires both branch refs to retain the
checkpointed commit. Runtime replacement is verified through the authenticated
bounded health command with release/PID and stable-endpoint binding instead of
loading the full snapshot. Ambiguous finalization transport keeps its durable
command identity; only a definitive authenticated Desktop rejection may rotate
that identity and retry the same idempotent Workspace completion. When a later
publication replaces a terminal run projection, the exact prior status is
archived beside its canonical log before replacement.

## Candidate-owned plan reads before runtime replacement (2026-09-17)

The publication process may be running candidate code while the installed
Desktop runtime still implements an older release-plan projection. A successful
old response is not a transport failure, so the former missing-plan-only MCP
bootstrap cannot repair this version-skew case.

All pre-install plan guards now use one candidate composition boundary backed by
the existing `TaskReleasePlanService`, a short read-only snapshot of the
authoritative Task database, and the existing Git release-evidence reader. The
snapshot is closed before Git inspection. The same reader is used before freeze,
when the frozen publication identity is prepared, and immediately before Git
publication; every guard still compares the complete plan revision exactly.
Installed Desktop control remains the sole owner of post-install Workspace
completion and its idempotent durable command.

Read-only opening is fail-closed: it creates no storage, performs no migration or
cleanup, and rejects incompatible schema. `--bootstrap-mcp-context` is rejected
as obsolete instead of silently selecting the installed planner. Completion-only
resume keeps using the saved immutable publication identity and installed
completion owner; any resume that has not crossed the publication-effect boundary
must pass the fresh candidate plan guards again.
