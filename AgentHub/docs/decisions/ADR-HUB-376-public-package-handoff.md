# ADR-HUB-376 — Exact public-package handoff through existing restart

Status: accepted by explicit user instruction; implementation requires normal
independent review and delivery. Contracts: RST-001, REL-001, PERF-001, SYS-001.

## Problem and decision

An ordinary restart launches current.json before the old runtime finalizes its
remaining writers. A stopped-only installer cannot be inserted into that gap.
Published 2.0.4 has neither an external graceful stop-only port nor a package
callback. New source cannot retroactively add one to an installed process.

Use one exact package request in the existing maintenance/restart operation.
Prepare and verify canonical public assets before stopping. Capable runtimes
retain existing active-work deferral and the synchronous stopping fence. The
package branch drains/closes all resources, including normally preserved
gateways, finalizes writers before releasing the instance, and exits. It does
not recover already closed in-process stores after a failed finalization.

The existing RuntimeHost supplies an externally parented continuation, original
Job/process handles and root gate. It waits for actual old-cohort exit, disposes
its process references and verifies that same Job is empty. Fresh parent replies
revalidate retirement at each effect boundary. SQLite backup API plus concurrent
writer reservations preserve committed WAL; regular config/data are copied with
before/after hashes. No live WAL file copy, database restore or UNKNOWN replay.
The verified standalone installer retains its existing stopped/upgrade/pointer
guards. One durable launch intent binds exact replacement Host, release,
instance and ready response. Ambiguous install/start remains reconciliation,
never automatic re-execution or code/data rollback.

## One-time old-public-version entry

The incoming verified package supplies the callable updater. If authenticated
old runtime-health advertises the package protocol, it submits restart-package
once. Failure/timeout never falls through to legacy bootstrap.

For public 2.0.4 without the protocol, the user finishes work, arms from an
operator outside the old Hub Job, then manually stops the exact reported old
Host/Node cohort. The updater itself never kills it. There is no old admission
fence: the user must keep the maintenance window closed to new starts/work.
Manual termination can be crash-consistent, not graceful. Same-job operators,
live/unknown writers, changed roots/pointers/assets or incomplete exit refuse.
This exception is only for installed public versions lacking the advertised
protocol. It is removable when those versions are no longer supported upgrade
sources; it is not a permanent forced-stop fallback.

## Installation and launch corrections

Cold independence uses a pinned real desktop-shell parent and suspended child
checks for any Job and full effective token context. No WMI, arbitrary parent,
silent elevation, flags-only fallback or helper daemon. Separate private Job
and caller-tree `/T` controls qualify the immediate boundary only.

Repeated directory ACL application may be skipped only on fresh exact protected
root DACL proof for the requested account/SYSTEM/Administrators, FullControl,
OI/CI and no propagation restriction, extra, inherited or deny ACE. Unknown or
drift uses the original apply/error behavior. This is not recursive sanitation
of arbitrary existing descendants. Config ACL remains separate.

An existing private prepared body can match its canonical public package only
when distributionSource binds the ENTIRE raw private manifest SHA and exact
repository/source; all remaining fields match after removing solely documented
sourceRoot/distributionSource metadata. Preserve both immutable originals. Equal
payload lists alone cannot authorize same-ID reuse.

## Scope and evidence limits

Windows x64, existing Node with node:sqlite/Python prerequisites, interactive
same-user unelevated shell and runtime-root/data layout. Custom external data
roots, another user/elevation, noninteractive shell, foreign writers or unresolved
originals refuse rather than changing authority. Retained package/backup remain
private until exact completion is read. A pre-admission incomplete transport
also remains retained/unknown; retry does not erase it or launch blindly.

Focused literal-app acceptance exercises real old public native Host, existing
control/store, native cohort retirement, SQLite backup, recipient installer and
replacement readiness. Controlled HTTPS metadata is not actual public download
acceptance; literal applications are not provider or production-data parity.
No full suite, live restart/install, publication or installed-AFTER follows from
source acceptance. Package preparation and backup size remain real work, not a
promised fixed downtime or production speed improvement.
