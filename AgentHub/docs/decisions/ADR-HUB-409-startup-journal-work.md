# ADR-HUB-409 — Reduce repeated work in startup journal recovery

Status: accepted implementation, runtime delivery pending.

The failed replacement original `a4c4b27b-f0db-4ad2-99b4-561269fa7da7`
reached the mandatory terminal-projection drain after infrastructure, provider
initialization and run recovery. Its saved worker trace measured a cold journal
projection at 32.545 s: ledger input 12.934 s, Workspace resolution 15.944 s,
facts 1.758 s and rendering 1.247 s. That projection returned a revision conflict.
Nested observations are not additional wall time. They do not establish a
historical SQLite holder, a deadlock or a guarantee about a future restart.

Cold accounting input scanned identities and fetched every record separately;
a cold full rebuild fetched those same source payloads again. The worker already
exchanged exact Workspace references in groups of 128, but the parent expanded
each group into individual catalog statements. After asynchronous callbacks a
changed journal revision was detectable, yet facts and rendering still ran
before the inevitable CAS refusal.

The existing owners now use one sequential payload scan for cold accounting,
also using those parsed source objects for a requested full rebuild. Warm calls
retain identity/revision scans and read only changed payloads. The catalog owner
resolves each bounded reference group in one fresh statement with the same
normalization, joins and display semantics as point lookup. Input order,
duplicates and missing values are retained; no binding authority is cached
between calls. Missing Threads retain the existing discovered-assignment owner.
Scalar/custom resolvers retain their existing interface.
The composed catalog capability exposes this method as a read through its
existing owner, preserving the same mutation queue and authority boundaries.

After Workspace resolution the worker checks the expected journal revision.
A known stale snapshot returns the existing conflict/deferred result before
facts and rendering. This is only early refusal: final atomic transaction CAS
and the existing bounded caller retry remain mandatory. Skipped normalization
diagnostics are absent, not a fabricated zero-record audit.

Startup and durable outbox drain order are unchanged. Every exact revision
still requires history, usage fact, journal/index readback and its individual
state-save fence before ACK. Startup awaits that drain before Ready under the
unchanged replacement deadline. No queue, receipt, timer or gate is added.

The existing CommandTrace worker retains bounded numeric read/binding/CAS
measurements. Batch projection carries its representative original command ID
when present; coalesced callers retain individual outer projection spans.
The trailing run uses its first actual requesting caller's representative ID;
the projection scope key and one-trailing-run/ACK semantics stay unchanged.
Workspace callback failure retains completed phase measurements in the same
failed trace. No payloads, paths or provider content are logged; diagnostics
cannot change operation outcomes.

Verification uses small synthetic SQLite/catalog/terminal stores and the real
worker, exact pending-outbox/readiness and changed-revision controls. Controlled
cost counts and local timings do not establish production speedup. Actual
adoption and subsequent required startup remain delivery-owner work. The prior
failed original is immutable and is never replayed here.
