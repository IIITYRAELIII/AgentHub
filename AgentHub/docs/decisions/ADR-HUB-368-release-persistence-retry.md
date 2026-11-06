# HUB-368: retain release persistence continuations

Status: proposed for independent review.

The retained production G2/G3 observations showed SQLITE_BUSY after generation
composition and an early CLI return, with no phase/stack sufficient to identify
the competing process. A real second SQLite connection reproduces successful
validation followed by failed receipt persistence on the original service.

Use the existing asynchronous SQLite mutation queue for short stage mutations,
with fresh owner epoch and row CAS inside each attempt. Retain the returned
effect in the existing worker while exhausted contention waits at the existing
retry cadence; never repeat validation/Git/publication to retry bookkeeping.
Read an identical committed advancement/reservation/effect after a lost reply.
Keep drain alive for local owned work, including acquisition contention after
unwind, but not foreign ownership or saved external waiting. Address effective
amended Task membership. Preserve stale-epoch fencing and original plus failed
settlement causes. No G0 recovery, new writer, global lane or timeout increase.

Emit error-only metadata through the existing CommandTrace owner; both actual
Hub construction and the normal source CLI forward its lazy recorder. CLI close
flushes this trace worker. No messages, SQL values, caller arguments or paths.

Behavioral evidence: parent failure-first actual SQLite writer; successful
validation counted once across finishStep contention/exhaustion; heartbeat,
reservation, admission, advancement, stale epoch, reopen, effective membership,
committed-reply loss and original/settlement failures. Existing G1/G2 and external
waiting/foreign-owner controls remain required. An actual source CLI with real
Git/SQLite tests retained lifetime and persisted trace through controlled target
ports. This is not an installed production blocker attribution or publication.
