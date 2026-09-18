# ADR-0045 — Bounded release validation concurrency

## Status

Accepted for HUB-227. Complements ADR-0034 resumable publication and ADR-0043
explicit release preparation.

## Context

The 2026-09-13 release spent 33 minutes 21 seconds between the start of full
tests and the following Mobile stage. The Windows process-per-file runner kept
every file in one category-wide singleton even when its tests created distinct
temporary repositories, locks, ports and browser profiles. At the same time,
unbounded test concurrency would compete with the running Hub for CPU and RAM.

The same release's Worker verification first observed a different assembled
index and then passed on the exact published bytes without another deploy. The
manual gap between the failed verification and supported resume was avoidable,
but repeating deploy would have created a second external effect. Safe runtime
restart also needed an explicit signal telling the release agent to yield its
current turn at the existing deferred-restart boundary.

## Decision

The existing runner admits at most two test-file processes concurrently and
only when at least four logical CPUs and 4 GiB of free memory are available.
Parallel eligibility is an explicit v2 declaration of disposable filesystem,
lock, Git, port and browser-profile ownership. Undeclared files are exclusive;
files naming the same shared resource serialize. Every child gets a unique
temporary environment root. The selected set, test bodies, failure aggregation
and fingerprint checkpoint owner remain unchanged. Cache misses expose stable
reason codes without values or file contents.

Worker verification retries only the recognized assembled-index byte/hash
mismatch, for at most six attempts and 60 seconds, with the exact same candidate
and verification checkpoint. It never invokes deploy. Other failures return
immediately, and persistent mismatch is terminal. A deferred safe restart adds
a machine-readable `yield_current_turn` result so the active release agent stops
work while the existing restart safety owner retains authority.

## Consequences

Independent expensive fixtures can overlap without turning all Git, SQLite or
browser tests into permanent category singletons. Hosts without measured CPU or
memory headroom remain sequential. A false isolation declaration can create
interference, so declarations are validated, fingerprinted and reviewed with
the test itself. Worker eventual consistency no longer requires an operator
resume when exact bytes converge inside the bound; persistent drift and every
non-byte failure still stop the release without a redeploy.
