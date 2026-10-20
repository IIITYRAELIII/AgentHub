# ADR-0125 — Reconcile an inactive managed Codex run after restart

## Context

After a lost App Server process, an accepted turn can retain `task_started`
without a rollout terminal. A fresh provider history can mark that exact turn
interrupted while the current server rejects its exact interrupt as inactive.
Previously startup only observed this run forever, reserving admission and its
already accepted queued input. The ordinary Stop owner could reconcile it.

## Decision

Startup may request a **new recovery interruption**, never infer a historical
successful completion. This applies only to a managed run with a retained exact
turn and client command identity, a fresh idle provider Thread and that exact
turn marked interrupted/aborted. It executes outside the Thread read lane.

The existing cancellation owner performs at most one attempt per run per
runtime. It requires fresh provider activity and uncached successful native
process absence, then addresses `turn/interrupt` to the original Thread/turn.
An accepted interrupt waits for the normal exact terminal. Only a definite
no-active-turn rejection permits reconciliation; transport errors, missing
Threads and unknown process evidence retain admission. A second fresh activity
check after the exact snapshot and unchanged run/Thread/turn ownership fence
are required before the canonical interrupted terminal commit. Provider reads
and native probes retain their existing deadlines; no polling loop is added.

The same terminal owner commits the retained partial answer and interrupted
status before normal admission release and queue wake-up. The queued command
keeps its original ID and is dispatched by its existing owner. The old prompt
is never relaunched. External observers, missing exact identities, promptless
unconfirmed starts and active/unknown providers remain unchanged. A read or
terminal persistence failure cannot release admission, including ordinary Stop.
The cancellation owner has no direct admission-release capability: only the
canonical completion/finalizer removes the registered run after durable terminal
settlement. `finishing`/`completed` memory state and a fulfilled completion no-op
are not proof of that settlement. A concurrent Stop or recovery therefore reports
pending while the completion owner still retains the original run.

## Evidence and limits

The S4/S7 originals were restored through ordinary authenticated Stop and their
original queued commands were provider-accepted once. This operational recovery
preceded this source correction and does not claim the correction was installed.
Focused cases cover inactive originals, active/unknown authority, transport and
storage failures, exact identity movement, concurrent recovery, fresh native
proof and the non-reentrant Thread lane. A later exact provider terminal keeps
the existing revision-CAS correction authority.
