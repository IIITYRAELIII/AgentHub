# ADR-HUB-385 — Lease-scoped verified runtime native producer

The original runtime-body helper started PowerShell and compiled the unchanged
C# source for every 64-file batch. The measured fixture30 native execution and
source-guard spans are separate; avoiding compilation does not remove a guard or
establish production-wide savings.

The existing physical installation and storage-retention lease callbacks own a
lazy in-memory producer scope. Consecutive calls for one target/binding reuse one
PowerShell process and the same exact C# source bytes. The producer verifies their
SHA-256 before compilation, and Node rechecks source identity and bytes before
each call. No DLL, source checkout or new durable state/cache is created.

The native method and its limits are unchanged. Every invocation opens, checks
and disposes its own target handles. Only after its C# finally has run does the
producer emit a nonce/sequence-bound reply. Those transport fields grant no
original, selection or deletion authority. Each request still carries its fresh
complete binding, partial authority and branded generated-cache proof.

There is at most one live producer in a scope. Switching independently admitted
resources first joins the prior producer. Failed target/bindings remain blocked
for that scope, including after a resource switch; the caller's existing owner
alone may reconcile its original under a new owned invocation. Missing, invalid,
oversized or erroneous replies drain and join the child, never kill it or restart
the same uncertain effect. Unscoped callers get a joined single-call scope.
Nested installation custody shares the outer active maintenance scope; after
its callback finishes, no producer outlives the real lease.

Foreground callers must acquire their finite outer series through
`withStorageRetentionLease(dataDir, async storageLease => ...)` from the existing
storage composition, then pass `withLease: fn => fn(storageLease)` to their
service. This public composition helper opens the real storage lock and the
producer scope together and joins the child before lock release, including a
cooperative stop or exception. The background composition uses the same helper.
An old external caller opening `withInterprocessLocks` directly bypasses this
lifetime and still compiles once per nested installation callback; unchanged
already-approved operators are not silently upgraded. Each separate background
pass also ends its producer with its own lease. Neither API preserves a process
between distinct lease admissions. Actual foreground callers need their own
reviewed import/call-site change and fresh operational binding before adoption.

The owning regression uses real SQLite, RuntimeReleaseRetention and three normal
runApproved passes under that one real storage lease, completing the SAME
canonical original in 64/64/2 files with one producer. A second case introduces a
late prepared-source pin: the fresh next unit refuses, keeps the original and
remaining files, and a thrown foreground boundary joins before lease reacquires.

Maintained real Windows cases measure three 64/64/2 batches and producer starts,
rename the target between replies to prove handles were released, retain foreign
late data, prohibit failed-binding replay even after another resource, and lose
one actual reply without C# injection or process killing. Existing manifest,
hash, ADS, hardlink/reparse, writer, byte/file bounds and original-partial controls
exercise the same bridge. Raw parent/candidate timings are observations, not a
hard deadline or total cleanup speedup claim.
