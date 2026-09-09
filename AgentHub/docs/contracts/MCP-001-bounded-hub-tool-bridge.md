# MCP-001 — Bounded Agent Hub tool bridge

## Deadline ownership

The Codex MCP client owns a finite `agent_hub` tool deadline outside
`HubMcpServer`. It is longer than the server dispatch deadline, so ordinary
server timeouts keep their authoritative error, while a request stalled before
HTTP admission still terminates in bounded time. The deadline applies only to
`agent_hub`; unrelated long-running tools retain their own policy.

## Recovery and retry

A failed dynamic `functions.exec` call that contains an `agent_hub` MCP call
reloads the Codex MCP transport before a later attempt and wakes durable input
lanes. Read-only calls are safe to retry after that rebind.

Recovery presentation distinguishes transport state from aggregate replay
policy. A successful rebind may report that the transport recovered. A failed
rebind reports deferred transport recovery, wakes the durable lane once and
retains the same aggregate replay policy, but never reports the transport as
recovered.

Explicit successful/completed App Server items are terminal success before any
payload inspection. Ordinary result, output and content text never becomes a
transport failure merely because it contains words such as `timeout`, `socket`
or `reset`; only the item's structural success, failure and error markers own
that classification.

Mutations are never inferred from text and never retried with a new identity.
They require the exact `request_id` and authoritative `hub_mcp_operations`
readback:

- no operation means pre-dispatch and permits a retry with the same id;
- `succeeded` or `failed` is terminal evidence and forbids another effect;
- `pending` permits only operation-specific durable reconciliation with the same
  id; it is never a generic replay lease;
- `unknown` is an explicit terminal receipt state when authoritative readback is
  unavailable or an effect completed but its receipt could not be committed.

Receipt creation is atomic `INSERT OR IGNORE` under the exact identity. Success
stores a bounded structural result projection rather than arbitrary response
content, so a result larger than 1 MiB cannot turn an already-applied effect into
`failed`. Concurrent callers with the same identity share one in-process effect;
after restart an owned reconciliation worker first marks each receipt
`reconciling`. A transactionally persisted lifecycle outcome finalizes the
receipt from authoritative readback without repeating the effect. An incomplete
transition, prepared launch or missing outcome becomes terminal `unknown`; it is
never externally replayed.

Startup scans every pending receipt, not only receipts reached by a retry. A
mutation exception after dispatch is treated as a possibly partial effect and
therefore becomes `unknown` unless an authoritative readback disproves it.
Production composition cannot access raw Task/Workspace transactions or the
callback-based queue primitive. Its immutable asynchronous owners queue the
complete mutator inventory, including Desktop ingest/reassignment/events,
bug-report and Telegram capture, MCP receipts/attachments/startup reconciliation,
handoff metadata, provider catalog/backfill and Spark/Terra binding, settings,
journal completion, thread binding and Task lifecycle.
Bounded contention retry surrounds the real transaction, preserves the original
identity and yields to HTTP, SSE and timers instead of increasing `busy_timeout`.
The owners expose explicit read, short-mutation and internally managed-effect
allowlists only; an unclassified raw member is not bound into application code.
Checklist event delivery is an internally managed effect (ADR-0029): its
single-flight durable outbox drain invokes delivery outside SQL retry and queues
only quarantine/acknowledgment writes with the original event ID. A busy
acknowledgment cannot replay that invocation. An interrupted drain remains
recoverable through the existing idempotent event identity.
Release completion uses the same
Task owner. `hub_task_claim` enters Git through public Task admission, which
creates the durable per-Task/repository process-tree guard before the first
child process; an unproven survivor blocks claim effects and retries until the
operator proves the tree absent.

The underlying interprocess lease is represented by an immutable
token-addressed owner file held by its creator. Stale time alone never permits
replacement while the recorded PID is live. Every Git fence rereads the exact
durable token/process identity; recovery requires proven death, exact identity
mismatch, an owner-written release marker or trusted operator action. Renewal
does not rewrite the shared pathname, and release removes only its own token
file, so an old owner cannot retire a replacement swapped into the lock path.
Task lifecycle fencing is a uniformly asynchronous contract: callers await each
durable assertion before workflow, cleanup, failure or deletion persistence and
reject synchronous implementations. Proven-dead or exact-mismatch legacy
`owner.json` locks are retired only by bounded whole-directory quarantine plus
post-move identity validation; live or ambiguous legacy owners remain blocked.
Pending-triage startup recovery awaits its branded Task-owner mutation, and a
queue failure rejects startup recovery without an unhandled rejection or a
false successful outcome.

Composed `functions.exec` calls bind each mutation to the `request_id` in that
specific nested call's argument object. Missing, duplicate-property and
cross-call duplicate identities fail closed: recovery may rebind the transport,
but it performs no authoritative operation lookup and authorizes no replay.
One ambiguous mutation blocks replay of the entire failed composed call, even
when another nested mutation has a valid id and a successful null readback.

Only a successful authoritative readback that returns no operation proves
pre-dispatch. A thrown, timed-out or otherwise unavailable audit read is a
separate reconciliation-unavailable outcome and blocks replay until readback
succeeds; it is never converted to a null operation.

Logs contain tool and operation identity, status and recovery outcome, but not
the context capability or tool arguments.

For `hub_stream_message_send`, `hub_task_start` and `hub_task_reassign`, the
pending operation is bound before provider delivery to one immutable SHA-256 of
the exact stable inter-Stream origin and body assembled by message intake. A
successful operation without that bound content is invalid. Read-side legacy
origin recovery requires the successful tool, exact `mcp:<request_id>`, stored
arguments hash and stored content hash; absent pre-migration content hashes fail
closed and are not reconstructed from message text or ordering.

## Queue diagnostics

`hub_active_runs_list` and `hub_parallel_streams_list` expose bounded,
payload-free deferred-input summaries separately from live runs. The summary
includes exact Stream/provider/Thread and command identity, queue state, wait
reason, state age and a stalled marker after sixty seconds in `dispatching` or
`reconciling`. A deferred command never
becomes a synthetic live run merely to make blocked admission observable.
