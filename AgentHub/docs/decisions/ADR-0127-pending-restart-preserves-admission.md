# ADR-0127 — Pending restart preserves ordinary admission

Status: user-authorized policy correction; independent review/delivery pending.

## Decision and authority

The user's explicit instruction is: «Не надо блокировать мои сообщения. Я сам
остановлю ходы, запаузю очередь, если решу что пора рестартить».

A persisted restart request waits for a safe opportunity. It cannot manufacture
that opportunity by blocking new messages, steering, dispatch or completion wakeup,
or by stopping runs/pausing queues. User pause and exact lifecycle/maintenance
ownership remain unchanged. This replaces the former pending-request barrier in
RST-001; previous source evidence remains historical.

Use the existing RunCoordinator pending-admission marker through preflight,
registration and provider launch/steer. The existing restart owner counts that
marker together with blocking runs/background/maintenance, then synchronously
sets the existing stopping flag before any asynchronous cutover persistence.
JavaScript cannot admit a new callback between that final check and the flag.
No new reservation, global business queue or second lifecycle owner is added.

An admission that wins this race prevents restart. Once actual stopping wins,
all input surfaces durably retain new messages under their original IDs and the
existing ledger/queue recovery owner. They cannot launch/steer the old provider.
A lost reply remains ambiguous and exact-ID retry/reopen uses the retained record.
The previously accepted restart queue explanation remains valid for this real
cutover only; storage acceptance never claims provider execution.

## Evidence and limits

Test both race orders against the real restart wiring/controller and coordinator,
durable cutover intake through SQLite close/reopen, exact retry, queued steering,
user pause and completion wakeup. Existing original-command traces retain intake
and provider boundaries; bounded restart readiness checkpoints retain original
restart ID and observed blockers. Do not infer a complete historical blocker list
or production latency reduction from source tests. S2 owns actual delivery.
