# ADR-0346 — Load-aware test admission

Status: accepted user direction, 2026-10-24; review/application evidence separate.

The user requested a 40% CPU/RAM budget instead of a fixed maximum of two files.
The previous scheduler also treated a cache declaration as permission to run in
parallel. Opaque inputs prevent cache reuse, but do not demonstrate a shared
mutable resource or require exclusive execution.

Extend the existing checkpoint scheduler with resource admission. Independent
groups share one queue and one checkpoint writer; shared-resource conflicts
remain local to their actual identity. Each file has an isolated process and
temporary home/state environment. Source checkout and dependencies are inputs;
tests must use owned temporary Git repositories, databases, ephemeral ports and
per-launch browser profiles. Existing reviewed shared-resource tags survive
independently from cache validation. Cache fingerprints include the scheduler
and native accounting implementation, in addition to runner/test inputs.

CPU is elapsed CPU time divided by elapsed wall time and all logical CPUs.
RAM is summed process working sets/RSS against total physical RAM, not Node
heap; shared pages can be counted more than once, conservatively. Other apps'
CPU and available RAM reduce admission headroom. Windows uses an unnamed nested
accounting job: exited descendant CPU remains counted. No CPU, memory, process,
UI or kill-on-close limits are installed. The dedicated runner is associated
before test processes start; the accounting helper is included. Closing the
observer never kills running work. Linux uses process-family /proc accounting
including reaped-child CPU; BSD ps uses cumulative child times. Those adapters
require fixtures to join/clean their children: daemonized/reparented processes
are not a supported fixture isolation model. Windows is the native measured
platform for this change; POSIX parsing has focused coverage, native portability
evidence must remain explicit.

Sampled admission reserves one core and estimated resident memory for each new
unsampled file, then updates from actual tree load. There is no arbitrary worker
count. On a small host one CPU-bound file is indivisible. Samples may exceed the
target while it runs, or after a workload changes; no hard OS cap is claimed.
Running valid tests are not terminated, suspended or automatically retried.
An accounting failure drains existing work, persists successes and reports
unstarted files without fabricating test failure/success.

Migration: do not retarget a frozen/admitted release run. Apply reviewed runner
bytes in a subsequent normal composition, and verify that ordinary entry point.
Keep complete file discovery, required groups, failure aggregation, original
test identities, publication capability stripping and content-proven checkpoint
retention. No additional release suite or publishing authority is introduced.

Windows `USERPROFILE` retains OS identity: redirecting it to a synthetic temp
directory breaks Edge KnownFolder resolution, even with a private browser user
data directory. The per-file HOME, APPDATA/LOCALAPPDATA, XDG state and TEMP roots
remain disposable. This is fixture isolation, not a security sandbox; tests
must use their explicit owned paths instead of mutating an OS user profile.

Windows accounting reference:
[Microsoft job accounting](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects#resource-accounting-for-jobs).
