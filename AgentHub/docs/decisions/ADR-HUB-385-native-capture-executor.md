# ADR-HUB-385 — Finite native-capture producer and leased archive proof

The real foreground native-capture owner started PowerShell/Add-Type for every
64-file invocation and read each persisted complete archive twice: first without
the archive lease and then again inside `withArchiveLease`. A real held-storage-
lease regression over three owning passes observed three target producers and
two complete archive reads per continuation. Existing inclusive timings localized
the delay to the owner but could not attribute it to individual phases.

The capture bridge now uses the accepted runtime producer's finite lease scope
and framed nonce/sequence protocol. Each protocol retains its source proof;
resource/protocol changes join the prior child before another starts. The same
real `withStorageRetentionLease` foreground callback spans normal runApproved
passes; nested installation custody retains its fresh guards. Unscoped capture
calls get a joined single-call scope. No daemon, DLL cache or target handles
survive the callback, and no failed binding restarts inside it.

For an already persisted capture archive, the owner carries only its immutable
descriptor into `withArchiveLease`. Its single full fresh read, tag/object/raw
closure proof, retirement/state binding and final current fence precede the
unchanged sealed effect under that SAME lease. Initial archival and full native
graph verification remain unchanged. All remaining-tree metadata checks,
hashes/ADS/reparse/links, caps64/256MiB/10s and original partial/UNKNOWN semantics
are preserved. No old operational caller or admitted original is silently upgraded.

The existing timing mechanism records fixed numeric phases and counts under the
original operation, candidate digest and durable batch sequence. Native timings
separate plan/prevalidation/hash-unlink/directory cleanup, including failure and
handle disposal; PowerShell reports compilation separately from Node startup,
request round trip and final child lifetime. No paths, argv or contents enter
these new events. The SAME maintenance row retains the latest bounded summary;
the existing bounded rotating log flushes failure and final child-join evidence.
Telemetry is not an authorization ledger and cannot replace an effect error.

Validation uses the actual SQLite/TaskGit/retention/native path with tiny Git
inputs and normal partial batches. It checks producer/proof counts, durable
timings across reopen and hostile source/current/file/body/child failures. Timing
observations remain separate from counts and from production-wide speedup claims.
