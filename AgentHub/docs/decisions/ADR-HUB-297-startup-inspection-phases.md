# ADR-HUB-297: Current startup SQLite inspection

The observed startup0929ee72 on release3f97 spent3482.56ms acquiring the database
lock and62664.55ms in its combined database-check phase. That phase includes the
detached DB/WAL copy, full quick_check and cleanup; the historical split is
unknown. Later file sizes do not reconstruct those durations.

Preserve the original recovery coordinator, locks, detached coherent DB/WAL
copy, mapped live SHM exclusion, full corruption check and quarantine protocol.
Reuse the saved reviewed inspection helper/worker from the earlier result.
The production default runs the synchronous check in one disposable worker and
joins its reply and exit before cleanup, lock release or readiness. Explicit
databaseFactory injection retains existing isolated fault-fixture semantics.
There is no health certificate, size/mtime/TTL skip, timeout change or live probe.

The current original startup phase recorder gains fixed child phases for
inspection directory, DB copy, WAL copy, query round trip and cleanup. It keeps
only numeric byte counts and worker open/check/close/thread measurements. These
same-ID observations survive in the existing startup log and later trace worker.
Observer failure does not change recovery outcomes. Nested durations are not
additive wall time; worker execution and round-trip latency remain distinct.

The existing MiniAppServer also binds its configured listener after instance
ownership, before SQLite recovery. During that interval it opens no journal,
serves only existing static startup assets, health and local session handshake,
and refuses data, event streams and business intake. Infrastructure configures
that same server after safety; the existing ordinary start call activates routes
only after application ports are bound. This activation also applies when an
early non-critical bind failed and ordinary start binds the configured listener
for the first time. Auth, listener identity and readiness remain unchanged.
Failed infrastructure joins both listeners before releasing
instance ownership. A failure to drain cannot release that owner.

The current web shell can therefore display the real database-check operation
while full integrity is pending, instead of connection refusal. Readiness still
awaits full required work. This does not establish a shorter historical63s
inspection, a safe health cache or earlier business availability. The targeted
actual composition test holds a real coordinator copy, loads the real web shell
in an isolated browser, verifies startup display/API refusal/readyfalse and
failure cleanup. External provider, Telegram, live Hub and production DB are not
part of that fixture.
